import type { InitialContextProvider, InitialContextRequest, InitialContextSection, ProviderHealth } from '../contracts.js';
import { trimToTokens } from '../text.js';
import type { MemoryProvider } from '../../services/memory/types.js';

export class MemoryContextProvider implements InitialContextProvider {
  readonly id = 'memory';
  readonly description = 'Relevant durable Mem0 memories; never the entire memory store.';
  readonly priority = 70;
  readonly defaultEnabled = true;

  private healthSnapshot?: { value: ProviderHealth; expiresAt: number };
  private healthInFlight?: Promise<ProviderHealth>;

  constructor(
    private readonly memory: MemoryProvider,
    private readonly maxTokens = 1_000,
    // Avoid probing a remote memory service twice for every live-voice turn:
    // the assembler's availability gate is followed immediately by search.
    // Search remains uncached, so memory results never go stale/confusing.
    private readonly healthCacheTtlMs = 10_000,
  ) {}

  async isAvailable(): Promise<boolean> {
    return (await this.cachedHealth()).status !== 'unavailable';
  }

  async getContext(request: InitialContextRequest): Promise<InitialContextSection | null> {
    const query = request.focus?.trim();
    // A generic environment request must not dump unrelated private memories.
    if (!query) return null;
    const project = typeof request.options.projectId === 'string' ? request.options.projectId : undefined;
    const memories = await this.memory.search({ query, project, limit: 8, signal: request.signal });
    if (memories.length === 0) return null;
    const lines = memories.map((memory) => {
      const label = [memory.topic, memory.subtopic].filter(Boolean).join(' / ');
      return `${label ? `${label}: ` : ''}${memory.text}`;
    });
    const compacted = trimToTokens(lines.join('\n'), Math.min(this.maxTokens, request.maxTokens));
    return {
      providerId: this.id,
      title: 'Relevant Memory',
      lines: compacted.split('\n').filter(Boolean),
      minLines: 1,
      generatedAt: new Date().toISOString(),
    };
  }

  async health(): Promise<ProviderHealth> {
    return this.cachedHealth();
  }

  private async cachedHealth(): Promise<ProviderHealth> {
    const now = Date.now();
    if (this.healthSnapshot !== undefined && this.healthSnapshot.expiresAt > now) {
      return this.healthSnapshot.value;
    }
    if (this.healthInFlight !== undefined) return this.healthInFlight;

    this.healthInFlight = this.memory
      .health()
      .then((value) => {
        this.healthSnapshot = {
          value,
          expiresAt: Date.now() + Math.max(0, this.healthCacheTtlMs),
        };
        return value;
      })
      .finally(() => {
        this.healthInFlight = undefined;
      });
    return this.healthInFlight;
  }
}
