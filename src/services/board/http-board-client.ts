import { readFile } from 'node:fs/promises';
import type { JsonObject, JsonValue } from '../../types/json.js';
import {
  BOARD_WRITE_OPS,
  BoardRemoteError,
  BoardUnavailableError,
  type BoardClient,
  type BoardConflict,
  type BoardOp,
  type BoardOpResult,
} from './types.js';

export interface BoardNode {
  name: string;
  url: string;
}

export interface HttpBoardClientOptions {
  /** Nodes in failover order. */
  nodes: BoardNode[];
  /** Reads the service token. Called on every operation; never logged. */
  readToken: () => Promise<string | undefined>;
  requestTimeoutMs: number;
  busyRetries: number;
  downCacheMs: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Leader cache entries older than this are not trusted for min_epoch. */
const LEADER_CACHE_MAX_AGE_MS = 60 * 60_000;
/** Refuse absurd replies rather than buffer them. */
const MAX_REPLY_BYTES = 2 * 1024 * 1024;
const BUSY_RETRY_DELAY_MS = 250;

/**
 * Failures that happen before a request can have reached the server, so a
 * write may safely be tried on the next node. Anything else (a timeout after
 * connecting, a reset mid-response) leaves a write's outcome unknown.
 */
const CONNECT_PHASE_CODES = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function failedBeforeSending(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === 'string' && CONNECT_PHASE_CODES.has(code)) return true;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

/** Read a body up to `limit` bytes; throws (and cancels the stream) beyond it. */
async function readCapped(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('board reply too large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error('board reply too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Read a board token file: trimmed, undefined when absent or empty. */
export function tokenFileReader(path: string | undefined): () => Promise<string | undefined> {
  return async () => {
    if (!path) return undefined;
    try {
      const value = (await readFile(path, 'utf8')).trim();
      return value === '' ? undefined : value;
    } catch {
      return undefined;
    }
  };
}

function normaliseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function asConflicts(value: unknown): BoardConflict[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const row = entry as Record<string, unknown>;
    const text = (key: string): string | undefined => (typeof row[key] === 'string' ? (row[key] as string) : undefined);
    const path = text('path');
    const kind = text('kind');
    if (path === undefined || kind === undefined) return [];
    const conflict: BoardConflict = { path, kind };
    const sessionId = text('session_id');
    const agent = text('agent');
    const task = text('task');
    if (sessionId !== undefined) conflict.session_id = sessionId;
    if (agent !== undefined) conflict.agent = agent;
    if (task !== undefined) conflict.task = task;
    return [conflict];
  });
}

/**
 * Client for the network code coordination board.
 *
 * Mirrors the board service's reference Python client: try the last known
 * leader first, follow "not leader" (409) to the named leader, retry a
 * starting/fenced node (503) a few times, move on to the next node when one
 * cannot be reached, and send the highest epoch seen so a stale node refuses.
 *
 * The bearer token is sent ONLY to configured node URLs. A 409's leader is
 * resolved by NAME against the configured list (or by exact configured URL);
 * a leader_url pointing anywhere else is ignored, because following it would
 * hand the service token to whoever controls that reply.
 */
export class HttpBoardClient implements BoardClient {
  private readonly nodes: BoardNode[];
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private leader: { name: string; epoch: number; seenAt: number } | undefined;
  private downUntil = 0;
  private downReason = '';

  constructor(private readonly options: HttpBoardClientOptions) {
    this.nodes = options.nodes.map((node) => ({ name: node.name, url: normaliseUrl(node.url) }));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  private nodeNamed(name: unknown): BoardNode | undefined {
    return typeof name === 'string' ? this.nodes.find((node) => node.name === name) : undefined;
  }

  private nodeAtUrl(url: unknown): BoardNode | undefined {
    if (typeof url !== 'string') return undefined;
    const wanted = normaliseUrl(url);
    return this.nodes.find((node) => node.url === wanted);
  }

  private remember(name: string, epoch: unknown): void {
    const value = typeof epoch === 'number' && Number.isFinite(epoch) ? epoch : 0;
    const previous = this.leader && this.now() - this.leader.seenAt < LEADER_CACHE_MAX_AGE_MS ? this.leader.epoch : 0;
    this.leader = { name, epoch: Math.max(value, previous), seenAt: this.now() };
  }

  private async post(
    node: BoardNode,
    op: BoardOp,
    body: string,
    token: string,
    signal: AbortSignal | undefined,
  ): Promise<{ status: number; reply: Record<string, unknown> }> {
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs);
    const response = await this.fetchImpl(`${node.url}/api/op/${op}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body,
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await readCapped(response, MAX_REPLY_BYTES);
    let reply: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(text || '{}');
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) reply = parsed as Record<string, unknown>;
    } catch {
      reply = {};
    }
    return { status: response.status, reply };
  }

  async op(op: BoardOp, payload: JsonObject, signal?: AbortSignal): Promise<BoardOpResult> {
    if (this.nodes.length === 0) throw new BoardUnavailableError('no board nodes are configured');
    const token = await this.options.readToken();
    if (!token) throw new BoardUnavailableError('the board service token is not readable on this server');

    const now = this.now();
    if (this.downUntil > now) {
      throw new BoardUnavailableError(`no board node reachable (cached: ${this.downReason})`);
    }

    const fresh = this.leader !== undefined && now - this.leader.seenAt < LEADER_CACHE_MAX_AGE_MS;
    const minEpoch = fresh ? this.leader!.epoch : 0;
    const body = JSON.stringify({ payload, min_epoch: minEpoch });

    const queue: BoardNode[] = [];
    const cached = fresh ? this.nodeNamed(this.leader!.name) : undefined;
    if (cached) queue.push(cached);
    queue.push(...this.nodes);

    const tried = new Set<string>();
    const failures: string[] = [];
    let anyAnswer = false;

    while (queue.length > 0) {
      const node = queue.shift()!;
      if (tried.has(node.name)) continue;
      tried.add(node.name);

      for (let attempt = 0; attempt <= this.options.busyRetries; attempt += 1) {
        if (signal?.aborted) throw new BoardUnavailableError('board request was cancelled');
        let status: number;
        let reply: Record<string, unknown>;
        try {
          ({ status, reply } = await this.post(node, op, body, token, signal));
        } catch (error) {
          // Never include the error object's text verbatim: undici errors can
          // carry request details. The node name and error class suffice.
          const label = `${node.name}: ${error instanceof Error ? error.name : 'error'}`;
          if (BOARD_WRITE_OPS.has(op) && !failedBeforeSending(error)) {
            // The request may have reached the leader and been applied. Trying
            // another node could apply it twice (a message is not idempotent),
            // so stop and let the caller read the board first.
            throw new BoardUnavailableError(
              `${label}; the outcome of this ${op} is unknown - read the board before retrying`,
            );
          }
          failures.push(label);
          break;
        }
        anyAnswer = true;

        if (status === 200 && reply['ok'] === true) {
          this.remember(typeof reply['node'] === 'string' ? (reply['node'] as string) : node.name, reply['epoch']);
          const out: BoardOpResult = { result: (reply['result'] ?? null) as JsonValue };
          if (typeof reply['node'] === 'string') out.node = reply['node'] as string;
          if (typeof reply['epoch'] === 'number') out.epoch = reply['epoch'] as number;
          return out;
        }
        if (status === 422) {
          this.remember(node.name, reply['epoch']);
          const error = (typeof reply['error'] === 'object' && reply['error'] !== null ? reply['error'] : {}) as Record<
            string,
            unknown
          >;
          throw new BoardRemoteError(
            typeof error['type'] === 'string' ? (error['type'] as string) : 'CoordinationError',
            typeof error['message'] === 'string' ? (error['message'] as string) : 'the board rejected the operation',
            asConflicts(error['conflicts']),
          );
        }
        if (status === 409) {
          const leader = this.nodeNamed(reply['leader']) ?? this.nodeAtUrl(reply['leader_url']);
          if (leader && !tried.has(leader.name)) queue.unshift(leader);
          failures.push(`${node.name}: ${typeof reply['reason'] === 'string' ? (reply['reason'] as string).slice(0, 120) : 'not leader'}`);
          break;
        }
        if (status === 503 && attempt < this.options.busyRetries) {
          await this.sleep(BUSY_RETRY_DELAY_MS);
          continue;
        }
        failures.push(`${node.name}: HTTP ${status}`);
        break;
      }
    }

    const reason = failures.join('; ').slice(0, 500) || 'no nodes answered';
    if (!anyAnswer && this.options.downCacheMs > 0) {
      this.downUntil = this.now() + this.options.downCacheMs;
      this.downReason = reason;
    }
    throw new BoardUnavailableError(reason);
  }
}
