import { describe, expect, it } from 'vitest';
import { ContextAssembler } from '../../../src/context/assembler.js';
import type { ContextAssemblyConfiguration } from '../../../src/context/contracts.js';
import { ContextProviderRegistry } from '../../../src/context/registry.js';
import { SystemStatusContextProvider } from '../../../src/context/providers/system-status-provider.js';
import { SystemStatusService } from '../../../src/services/system/system-status-service.js';
import type { InitialContextProvider, InitialContextRequest, InitialContextSection } from '../../../src/types/context.js';

function section(id: string, line: string): InitialContextSection {
  return { providerId: id, title: id.toUpperCase(), lines: [line], generatedAt: new Date().toISOString() };
}

class TestProvider implements InitialContextProvider {
  readonly defaultEnabled = true;
  calls = 0;
  constructor(
    readonly id: string,
    readonly description: string,
    readonly priority: number,
    private readonly callback: (request: InitialContextRequest) => Promise<InitialContextSection | null>,
  ) {}
  async isAvailable(): Promise<boolean> { return true; }
  async getContext(request: InitialContextRequest): Promise<InitialContextSection | null> {
    this.calls += 1;
    return this.callback(request);
  }
}

function configuration(providers: string[], overrides: Partial<ContextAssemblyConfiguration> = {}): ContextAssemblyConfiguration {
  return {
    defaultProfile: 'default',
    maxTokens: 100,
    defaultTimeoutMs: 1_000,
    retrievalConcurrency: 2,
    profiles: { default: { providers } },
    providers: {},
    ...overrides,
  };
}

describe('ContextProviderRegistry and ContextAssembler', () => {
  it('rejects duplicate provider IDs', () => {
    const registry = new ContextProviderRegistry();
    registry.register(new TestProvider('a', 'a', 1, async () => section('a', 'one')));
    expect(() => registry.register(new TestProvider('a', 'duplicate', 1, async () => section('a', 'two')))).toThrow(/registered twice/);
  });

  it('honors profile inclusion, per-provider disablement, include, and exclude', async () => {
    const registry = new ContextProviderRegistry();
    const a = new TestProvider('a', 'A', 1, async () => section('a', 'A'));
    const b = new TestProvider('b', 'B', 1, async () => section('b', 'B'));
    const c = new TestProvider('c', 'C', 1, async () => section('c', 'C'));
    registry.register(a); registry.register(b); registry.register(c);
    const assembler = new ContextAssembler(registry, configuration(['a', 'b'], {
      providers: { b: { enabled: false } },
      profiles: { default: { providers: ['a', 'b'] }, expanded: { providers: ['c'] } },
    }));
    const defaultContext = await assembler.assemble();
    expect(defaultContext.text).toContain('A');
    expect(defaultContext.text).not.toContain('B');
    const expanded = await assembler.assemble({ profile: 'expanded', include: ['a'], exclude: ['c'] });
    expect(expanded.text).toContain('A');
    expect(expanded.text).not.toContain('C');
    expect([a.calls, b.calls, c.calls]).toEqual([2, 0, 0]);
  });

  it('isolates failures and timeouts while retaining healthy higher-priority context', async () => {
    const registry = new ContextProviderRegistry();
    registry.register(new TestProvider('high', 'Healthy', 100, async () => section('high', 'critical active work')));
    registry.register(new TestProvider('broken', 'Broken', 10, async () => { throw new Error('provider broke'); }));
    registry.register(new TestProvider('slow', 'Slow', 20, async () => new Promise(() => undefined)));
    const assembler = new ContextAssembler(registry, configuration(['high', 'broken', 'slow'], {
      providers: { slow: { timeoutMs: 10 }, broken: { timeoutMs: 50 } },
    }));
    const result = await assembler.assemble();
    expect(result.text).toContain('critical active work');
    expect(result.warnings.map((warning) => warning.reason)).toEqual(expect.arrayContaining(['error', 'timeout']));
  });

  it('isolates malformed provider output instead of making the whole voice context invalid', async () => {
    const registry = new ContextProviderRegistry();
    registry.register(new TestProvider('good', 'Good', 100, async () => section('good', 'useful context')));
    registry.register(new TestProvider('malformed', 'Malformed', 1, async () => (
      { providerId: 'malformed', title: '', lines: ['bad'], generatedAt: new Date().toISOString() } as InitialContextSection
    )));
    const assembler = new ContextAssembler(registry, configuration(['good', 'malformed']));
    const result = await assembler.assemble();
    expect(result.text).toContain('useful context');
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerId: 'malformed', reason: 'error' }),
    ]));
  });

  it('enforces global token budget in priority order', async () => {
    const registry = new ContextProviderRegistry();
    registry.register(new TestProvider('high', 'High', 100, async () => section('high', 'keep this essential work session summary')));
    registry.register(new TestProvider('low', 'Low', 1, async () => section('low', 'x'.repeat(500))));
    const assembler = new ContextAssembler(registry, configuration(['low', 'high'], { maxTokens: 12 }));
    const result = await assembler.assemble({ maxTokens: 12 });
    expect(result.text).toContain('essential');
    expect(result.estimatedTokens).toBeLessThanOrEqual(12);
    expect(result.warnings.some((warning) => warning.reason === 'trimmed' || warning.reason === 'dropped')).toBe(true);
  });

  it('runs providers with bounded concurrency rather than starting every one at once', async () => {
    const registry = new ContextProviderRegistry();
    let running = 0;
    let peak = 0;
    for (const id of ['one', 'two', 'three', 'four']) {
      registry.register(new TestProvider(id, id, 1, async () => {
        running += 1; peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 12));
        running -= 1;
        return section(id, id);
      }));
    }
    const assembler = new ContextAssembler(registry, configuration(['one', 'two', 'three', 'four'], { retrievalConcurrency: 2 }));
    await assembler.assemble();
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('uses one request id across the provider fan-out for trace correlation', async () => {
    const registry = new ContextProviderRegistry();
    const requestIds: string[] = [];
    registry.register(new TestProvider('one', 'One', 1, async (request) => {
      requestIds.push(request.requestId);
      return section('one', 'one');
    }));
    registry.register(new TestProvider('two', 'Two', 1, async (request) => {
      requestIds.push(request.requestId);
      return section('two', 'two');
    }));
    const assembler = new ContextAssembler(registry, configuration(['one', 'two']));
    await assembler.assemble({ requestId: 'voice-request-42' });
    expect(requestIds).toEqual(['voice-request-42', 'voice-request-42']);
  });

  it('also bounds capability availability probes', async () => {
    const registry = new ContextProviderRegistry();
    let running = 0;
    let peak = 0;
    for (const id of ['one', 'two', 'three', 'four']) {
      const provider = new TestProvider(id, id, 1, async () => section(id, id));
      provider.isAvailable = async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 12));
        running -= 1;
        return true;
      };
      registry.register(provider);
    }
    const assembler = new ContextAssembler(registry, configuration(['one', 'two', 'three', 'four'], { retrievalConcurrency: 2 }));
    await assembler.capabilities();
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('adds SystemStatus through ordinary registration and profile configuration', async () => {
    const registry = new ContextProviderRegistry();
    registry.register(new SystemStatusContextProvider(new SystemStatusService('/', 1)));
    const assembler = new ContextAssembler(registry, configuration([], {
      profiles: { default: { providers: [] }, infrastructure: { providers: ['systemStatus'] } },
      providers: { systemStatus: { enabled: true, priority: 40, timeoutMs: 3_000 } },
    }));
    const result = await assembler.assemble({ profile: 'infrastructure' });
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]?.providerId).toBe('systemStatus');
  });
});

/**
 * Per-provider caching is opt-in through cacheTtlMs. It was previously parsed
 * from config and silently ignored, which meant the documented knob did
 * nothing.
 */
describe('per-provider cache TTL', () => {
  it('reuses a cached section within the TTL and marks it cached', async () => {
    const registry = new ContextProviderRegistry();
    const provider = new TestProvider('cached', 'cached', 1, async () => section('cached', 'value'));
    registry.register(provider);

    const assembler = new ContextAssembler(
      registry,
      configuration(['cached'], { providers: { cached: { cacheTtlMs: 60_000 } } }),
    );

    await assembler.assemble();
    const second = await assembler.assemble();

    expect(provider.calls).toBe(1);
    expect(second.sections[0]?.cached).toBe(true);
  });

  it('does not cache when no TTL is configured', async () => {
    const registry = new ContextProviderRegistry();
    const provider = new TestProvider('fresh', 'fresh', 1, async () => section('fresh', 'value'));
    registry.register(provider);

    const assembler = new ContextAssembler(registry, configuration(['fresh']));
    await assembler.assemble();
    await assembler.assemble();

    expect(provider.calls).toBe(2);
  });

  it('keeps separate cache entries per profile', async () => {
    const registry = new ContextProviderRegistry();
    const provider = new TestProvider('multi', 'multi', 1, async () => section('multi', 'value'));
    registry.register(provider);

    const assembler = new ContextAssembler(registry, {
      defaultProfile: 'a',
      maxTokens: 100,
      defaultTimeoutMs: 1_000,
      retrievalConcurrency: 2,
      profiles: { a: { providers: ['multi'] }, b: { providers: ['multi'] } },
      providers: { multi: { cacheTtlMs: 60_000 } },
    });

    await assembler.assemble({ profile: 'a' });
    await assembler.assemble({ profile: 'b' });
    expect(provider.calls).toBe(2);
  });
});
