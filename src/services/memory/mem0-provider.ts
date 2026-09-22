import { normalizeLookup } from '../../context/text.js';
import { orchestratorError } from '../../types/errors.js';
import { isJsonObject, type JsonValue } from '../../types/json.js';
import type { MemoryAddInput, MemoryProvider, MemoryProviderHealth, MemoryResult, MemorySearchInput } from './types.js';

export interface Mem0HttpProviderOptions {
  baseUrl?: string;
  backupUrl?: string;
  apiKey?: string;
  userId?: string;
  timeoutMs?: number;
  allowWrites?: boolean;
}

interface Mem0SearchRow {
  id?: unknown;
  memory?: unknown;
  fact?: unknown;
  text?: unknown;
  content?: unknown;
  score?: unknown;
  metadata?: unknown;
  created_at?: unknown;
  createdAt?: unknown;
}

function textFromRow(row: Mem0SearchRow): string | undefined {
  return [row.memory, row.fact, row.text, row.content]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function recordFromRow(row: Mem0SearchRow, index: number): MemoryResult | undefined {
  const text = textFromRow(row);
  if (text === undefined) return undefined;
  const metadata = isJsonObject(row.metadata) ? row.metadata : undefined;
  const result: MemoryResult = { id: typeof row.id === 'string' ? row.id : `mem0-result-${index}`, text };
  if (typeof row.score === 'number' && Number.isFinite(row.score)) result.score = row.score;
  if (typeof metadata?.topic === 'string') result.topic = metadata.topic;
  if (typeof metadata?.subtopic === 'string') result.subtopic = metadata.subtopic;
  const createdAt = typeof row.created_at === 'string' ? row.created_at : typeof row.createdAt === 'string' ? row.createdAt : undefined;
  if (createdAt !== undefined) result.createdAt = createdAt;
  if (metadata !== undefined) result.metadata = metadata;
  return result;
}

function deduplicate(results: MemoryResult[]): MemoryResult[] {
  const byText = new Map<string, MemoryResult>();
  for (const result of results) {
    const key = normalizeLookup(result.text);
    if (!key) continue;
    const current = byText.get(key);
    if (current === undefined || (result.score ?? -Infinity) > (current.score ?? -Infinity)) byText.set(key, result);
  }
  return [...byText.values()].sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
}

/** Existing central Mem0 REST contract, without a competing local vector DB. */
export class Mem0HttpMemoryProvider implements MemoryProvider {
  readonly id = 'mem0-http';
  private readonly bases: string[];
  private readonly userId: string;
  private readonly timeoutMs: number;
  private readonly allowWrites: boolean;

  constructor(private readonly options: Mem0HttpProviderOptions) {
    this.bases = [...new Set([options.baseUrl, options.backupUrl].flatMap((value) => {
      const normalized = value?.trim().replace(/\/$/, '');
      return normalized ? [normalized] : [];
    }))];
    this.userId = options.userId?.trim() || '';
    this.timeoutMs = Math.max(100, options.timeoutMs ?? 3_000);
    this.allowWrites = options.allowWrites ?? false;
  }

  async search(input: MemorySearchInput): Promise<MemoryResult[]> {
    const query = input.query.trim();
    if (!query) return [];
    const response = await this.request('/search', {
      query,
      filters: { user_id: this.userId },
      top_k: Math.max(1, Math.min(input.limit ?? 8, 20)),
      threshold: 0.5,
      show_expired: false,
      // recordFromRow reads id, text, score, topic, subtopic, created_at and
      // metadata - never an explanation. Asking for one only enlarges every
      // search response on the voice path.
      explain: false,
    }, input.signal);
    const rows = typeof response === 'object' && response !== null && Array.isArray((response as { results?: unknown }).results)
      ? (response as { results: unknown[] }).results
      : [];
    return deduplicate(rows.flatMap((row, index) => typeof row === 'object' && row !== null && !Array.isArray(row)
      ? [recordFromRow(row as Mem0SearchRow, index)].filter((entry): entry is MemoryResult => entry !== undefined)
      : []));
  }

  async add(input: MemoryAddInput): Promise<void> {
    if (!this.allowWrites) {
      throw orchestratorError('PERMISSION_DENIED', 'Mem0 writes are disabled until a durable-memory policy explicitly enables them.');
    }
    const text = input.text.trim();
    if (!text) throw orchestratorError('INVALID_ARGUMENT', 'Memory text cannot be empty.');
    const metadata: Record<string, JsonValue> = { ...(input.metadata ?? {}), jane_source: 'claude_mcp_orchestrator' };
    if (input.topic?.trim()) metadata.topic = input.topic.trim();
    if (input.subtopic?.trim()) metadata.subtopic = input.subtopic.trim();
    await this.request('/memories', {
      messages: [{ role: 'user', content: text }],
      user_id: this.userId,
      metadata,
      infer: false,
    });
  }

  async health(): Promise<MemoryProviderHealth> {
    const checkedAt = new Date().toISOString();
    if (this.bases.length === 0 || !this.options.apiKey?.trim() || !this.userId) {
      return { status: 'unavailable', checkedAt, detail: 'Mem0 endpoint, identity, or credential is not configured.' };
    }
    // The existing central Mem0 bridge exposes /search reliably but does not
    // guarantee a standalone /health route. Probe the actual capability
    // directly, avoiding an extra slow failed request on every doctor call.
    try {
      await this.request('/search', {
        query: 'orchestrator health check',
        filters: { user_id: this.userId },
        top_k: 1,
        threshold: 1,
        show_expired: false,
        explain: false,
      });
      return { status: 'ok', checkedAt, detail: 'Mem0 search endpoint reachable.' };
    } catch {
      return { status: 'unavailable', checkedAt, detail: 'Mem0 search endpoint did not respond.' };
    }
  }

  private async request(path: string, payload?: Record<string, unknown>, externalSignal?: AbortSignal): Promise<unknown> {
    if (this.bases.length === 0 || !this.userId || !this.options.apiKey?.trim()) {
      throw orchestratorError('MEMORY_UNAVAILABLE', 'Mem0 is not configured.', { retryable: false });
    }
    let lastError: unknown;
    for (const base of this.bases) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const abort = (): void => controller.abort();
      externalSignal?.addEventListener('abort', abort, { once: true });
      try {
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (this.options.apiKey?.trim()) headers['X-API-Key'] = this.options.apiKey;
        if (payload !== undefined) headers['Content-Type'] = 'application/json';
        const response = await fetch(`${base}${path}`, {
          method: payload === undefined ? 'GET' : 'POST',
          headers,
          body: payload === undefined ? undefined : JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!response.ok) {
          const error = new Error(`Mem0 returned HTTP ${response.status}.`);
          if (response.status < 500) throw error;
          lastError = error;
          continue;
        }
        const content = await response.text();
        return content.trim() ? JSON.parse(content) : {};
      } catch (error) {
        if (error instanceof Error && /^Mem0 returned HTTP [1-4]/.test(error.message)) {
          throw orchestratorError('MEMORY_UNAVAILABLE', 'Mem0 rejected the request.', { retryable: false, cause: error });
        }
        lastError = error;
        // A local timeout SHOULD fall through to the backup base - that is
        // what the backup is for. Caller cancellation is different: the
        // assembler has already stopped waiting, so a second request spends
        // time and a round trip on a result nobody will read.
        if (externalSignal?.aborted === true) break;
      } finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener('abort', abort);
      }
    }
    throw orchestratorError('MEMORY_UNAVAILABLE', 'Mem0 is unavailable.', { retryable: true, cause: lastError });
  }
}
