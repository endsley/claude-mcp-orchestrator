import type { JsonObject, JsonValue } from '../../types/json.js';
import { failedBeforeSending, normaliseUrl, readCapped, type BoardNode } from './http-board-client.js';
import { BoardUnavailableError } from './types.js';

/**
 * Client for the Agent Coordination service (agentcoord).
 *
 * Protocol (agent-coordination agentcoord/client.py and node.py): POST
 * `{node}/api/v1/{op}` with the payload as the JSON body and
 * `Authorization: Bearer <credential>`; identity and context travel in the
 * X-Session, X-Worker, X-Engine and X-Min-Epoch headers. Replies are
 * `{ok, node, epoch, leader, result | error | reason}`:
 *
 *  - 200 `{ok: true, result}`
 *  - 409 `reason: "not leader"` (+ `leader`, `leader_url`) or `"stale epoch ..."`
 *  - 503 `reason` without `error`: starting, fenced, lease expired (retry)
 *  - 503 with `error`: a database error mid-operation (never retried)
 *  - 400/401/403/404/422 with `error: {type, message, fix, retry_safe, ...}`
 *
 * X-Agent is deliberately NOT sent. With an agent credential the service
 * takes the identity from the credential; with any other credential (host,
 * admin, cluster) and no X-Agent it has no agent identity and refuses every
 * operation the board tools use. A misfiled host token therefore fails
 * closed instead of acting as some host agent.
 */

/** The only operations this server sends. A fixed set: an op is part of a URL. */
export const AGENTCOORD_OPS = [
  'file_board',
  'file_claim',
  'file_release',
  'file_finish',
  'heartbeat',
  'send',
  'attention',
  'ack',
  'read',
  'project_list',
  'project_show',
  'job_take',
  'job_update',
  'my_jobs',
] as const;
export type AgentcoordOp = (typeof AGENTCOORD_OPS)[number];

/**
 * Reads: safe to repeat on another node when the outcome of one attempt is
 * unknown. (attention and read only mark a delivery first-seen, which is
 * idempotent.) Every other op is a write and is never retried after a
 * request may have reached a node.
 */
export const AGENTCOORD_READ_OPS: ReadonlySet<AgentcoordOp> = new Set([
  'file_board',
  'attention',
  'read',
  'project_list',
  'project_show',
  'my_jobs',
]);

/** Who the request is for. Built by the caller from the authenticated principal. */
export interface AgentcoordCaller {
  /** The caller's own agentcoord agent credential. Never logged. */
  token: string;
  /** X-Session and X-Worker: one stable id per outside identity. */
  session: string;
  /** X-Engine, only when configured for the identity. */
  engine?: string;
}

export interface AgentcoordTransport {
  call(op: AgentcoordOp, payload: JsonObject, caller: AgentcoordCaller, signal?: AbortSignal): Promise<JsonValue>;
}

/** The service ran (or refused) the operation and said why. */
export class AgentcoordRemoteError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
    readonly fix: string | undefined,
    /** The whole error object, for callers that allowlist extra fields (conflicts). */
    readonly detail: JsonObject,
  ) {
    super(message);
    this.name = 'AgentcoordRemoteError';
  }
}

export interface AgentcoordClientOptions {
  /** Nodes in failover order. */
  nodes: BoardNode[];
  requestTimeoutMs: number;
  busyRetries: number;
  downCacheMs: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const LEADER_CACHE_MAX_AGE_MS = 60 * 60_000;
const MAX_REPLY_BYTES = 2 * 1024 * 1024;
const BUSY_RETRY_DELAY_MS = 400;

function text(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, limit) : undefined;
}

function asObject(value: unknown): JsonObject {
  return (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as JsonObject;
}

export class AgentcoordClient implements AgentcoordTransport {
  private readonly nodes: BoardNode[];
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private leader: { name: string; epoch: number; seenAt: number } | undefined;
  private downUntil = 0;
  private downReason = '';

  constructor(private readonly options: AgentcoordClientOptions) {
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
    if (!this.nodeNamed(name)) return;
    const value = typeof epoch === 'number' && Number.isFinite(epoch) ? epoch : 0;
    const previous = this.leader && this.now() - this.leader.seenAt < LEADER_CACHE_MAX_AGE_MS ? this.leader.epoch : 0;
    this.leader = { name, epoch: Math.max(value, previous), seenAt: this.now() };
  }

  private async post(
    node: BoardNode,
    op: AgentcoordOp,
    body: string,
    caller: AgentcoordCaller,
    minEpoch: number,
    signal: AbortSignal | undefined,
  ): Promise<{ status: number; reply: Record<string, unknown> }> {
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs);
    const headers: Record<string, string> = {
      authorization: `Bearer ${caller.token}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'x-session': caller.session,
      'x-worker': caller.session,
      'x-min-epoch': String(minEpoch),
    };
    if (caller.engine !== undefined) headers['x-engine'] = caller.engine;
    const response = await this.fetchImpl(`${node.url}/api/v1/${op}`, {
      method: 'POST',
      headers,
      body,
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const raw = await readCapped(response, MAX_REPLY_BYTES);
    let reply: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(raw || '{}');
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) reply = parsed as Record<string, unknown>;
    } catch {
      reply = {};
    }
    return { status: response.status, reply };
  }

  async call(op: AgentcoordOp, payload: JsonObject, caller: AgentcoordCaller, signal?: AbortSignal): Promise<JsonValue> {
    if (!(AGENTCOORD_OPS as readonly string[]).includes(op)) throw new BoardUnavailableError(`unsupported operation ${String(op)}`);
    if (this.nodes.length === 0) throw new BoardUnavailableError('no agentcoord nodes are configured');
    if (!caller.token) throw new BoardUnavailableError('no agentcoord credential');

    const now = this.now();
    if (this.downUntil > now) {
      throw new BoardUnavailableError(`no agentcoord node reachable (cached: ${this.downReason})`);
    }

    const write = !AGENTCOORD_READ_OPS.has(op);
    const fresh = this.leader !== undefined && now - this.leader.seenAt < LEADER_CACHE_MAX_AGE_MS;
    const minEpoch = fresh ? this.leader!.epoch : 0;
    const body = JSON.stringify(payload);

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
        if (signal?.aborted) throw new BoardUnavailableError('agentcoord request was cancelled');
        let status: number;
        let reply: Record<string, unknown>;
        try {
          ({ status, reply } = await this.post(node, op, body, caller, minEpoch, signal));
        } catch (error) {
          // Never echo the error text: undici errors can carry request details.
          const label = `${node.name}: ${error instanceof Error ? error.name : 'error'}`;
          if (write && !failedBeforeSending(error)) {
            // The request may have reached the leader and been applied. A
            // message or a job take is not idempotent, so stop here and let
            // the caller read state before repeating it.
            throw new BoardUnavailableError(
              `${label}; the outcome of this ${op} is unknown - read the current state before retrying`,
            );
          }
          failures.push(label);
          break;
        }
        anyAnswer = true;

        const error = typeof reply['error'] === 'object' && reply['error'] !== null ? asObject(reply['error']) : undefined;

        if (status === 200 && reply['ok'] === true) {
          this.remember(typeof reply['node'] === 'string' ? (reply['node'] as string) : node.name, reply['epoch']);
          return (reply['result'] ?? null) as JsonValue;
        }
        if (status === 409 && error === undefined) {
          const reason = text(reply['reason'], 120) ?? 'conflict';
          if (reason === 'not leader') {
            // Follow ONLY to a configured node, matched by name or exact URL.
            // A leader_url anywhere else is ignored: following it would hand
            // the caller's credential to whoever wrote that reply.
            const leader = this.nodeNamed(reply['leader']) ?? this.nodeAtUrl(reply['leader_url']);
            if (leader && !tried.has(leader.name)) queue.unshift(leader);
          }
          failures.push(`${node.name}: ${reason}`);
          break;
        }
        if (status === 503 && error === undefined) {
          if (attempt < this.options.busyRetries) {
            await this.sleep(BUSY_RETRY_DELAY_MS);
            continue;
          }
          failures.push(`${node.name}: ${text(reply['reason'], 120) ?? 'unavailable'}`);
          break;
        }
        if (error !== undefined) {
          this.remember(node.name, reply['epoch']);
          throw new AgentcoordRemoteError(
            status,
            text(error['type'], 64) ?? 'error',
            text(error['message'], 2000) ?? `agentcoord refused the ${op} (HTTP ${status})`,
            text(error['fix'], 1000),
            error,
          );
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
