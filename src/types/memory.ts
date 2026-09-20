import type { JsonObject } from './json.js';

export interface MemoryResult {
  id: string;
  text: string;
  /** Relevance score from the backing store, normalised to 0..1 when possible. */
  score?: number;
  /** ISO timestamp when the memory was created, if the backend reports one. */
  createdAt?: string;
  topic?: string;
  subtopic?: string;
  metadata?: JsonObject;
}

export interface MemorySearchInput {
  query: string;
  project?: string;
  limit?: number;
  /** Abort signal so the context assembler can enforce its own timeout. */
  signal?: AbortSignal;
}

export interface MemoryAddInput {
  text: string;
  project?: string;
  topic?: string;
  subtopic?: string;
  metadata?: JsonObject;
}

export interface MemoryProvider {
  readonly id: string;
  search(input: MemorySearchInput): Promise<MemoryResult[]>;
  /** Optional: a read-only provider is valid and must not be assumed writable. */
  add?(input: MemoryAddInput): Promise<void>;
  health(): Promise<ProviderHealth>;
}

export type ProviderHealthStatus = 'ok' | 'degraded' | 'unavailable' | 'disabled';

export interface ProviderHealth {
  status: ProviderHealthStatus;
  /** Human-readable reason. Must never contain secrets. */
  detail?: string;
  checkedAt: string;
  latencyMs?: number;
}
