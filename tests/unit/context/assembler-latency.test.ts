import { describe, expect, it } from 'vitest';
import { ContextAssembler } from '../../../src/context/assembler.js';
import type { ContextAssemblyConfiguration } from '../../../src/context/contracts.js';
import { ContextProviderRegistry } from '../../../src/context/registry.js';
import type {
  ContextApplicability,
  InitialContextProvider,
  InitialContextRequest,
  InitialContextSection,
} from '../../../src/types/context.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function section(id: string, line: string): InitialContextSection {
  return { providerId: id, title: id.toUpperCase(), lines: [line], generatedAt: new Date().toISOString() };
}

/** A provider whose availability probe is slow, like a remote health check. */
class SlowProbeProvider implements InitialContextProvider {
  readonly defaultEnabled = true;
  readonly description = 'slow probe';
  readonly priority = 1;
  probes = 0;
  fetches = 0;
  constructor(readonly id: string, private readonly probeMs: number, private readonly fetchMs: number) {}
  async isAvailable(): Promise<boolean> {
    this.probes += 1;
    await sleep(this.probeMs);
    return true;
  }
  async getContext(): Promise<InitialContextSection | null> {
    this.fetches += 1;
    await sleep(this.fetchMs);
    return section(this.id, 'late');
  }
}

/** Mirrors the memory provider: useless without a focus string. */
class FocusOnlyProvider implements InitialContextProvider {
  readonly defaultEnabled = true;
  readonly description = 'focus only';
  readonly priority = 1;
  probes = 0;
  fetches = 0;
  constructor(readonly id: string) {}
  appliesTo(request: ContextApplicability): boolean {
    return Boolean(request.focus?.trim());
  }
  async isAvailable(): Promise<boolean> {
    this.probes += 1;
    await sleep(80);
    return true;
  }
  async getContext(request: InitialContextRequest): Promise<InitialContextSection | null> {
    this.fetches += 1;
    return request.focus ? section(this.id, `about ${request.focus}`) : null;
  }
}

function configuration(providers: string[], overrides: Partial<ContextAssemblyConfiguration> = {}): ContextAssemblyConfiguration {
  return {
    defaultProfile: 'default',
    maxTokens: 500,
    defaultTimeoutMs: 1_000,
    retrievalConcurrency: 4,
    profiles: { default: { providers } },
    providers: {},
    ...overrides,
  };
}

describe('assembler latency budget', () => {
  /**
   * isAvailable() and getContext() were each given the full per-provider
   * timeout, so a provider configured for N ms could hold the assembly for 2N.
   * With memory at 10s in production that was a 20s worst case on a voice turn.
   */
  it('spends at most one timeout on a provider, not one per call', async () => {
    const registry = new ContextProviderRegistry();
    // The probe SUCCEEDS but eats most of the budget; the fetch then overruns.
    // This ordering is what discriminates: with a per-call timeout the fetch
    // got a fresh 150ms (~250ms total), with a shared budget it gets the ~50ms
    // that is left (~150ms total).
    const slow = new SlowProbeProvider('slow', 100, 400);
    registry.register(slow);
    const assembler = new ContextAssembler(registry, configuration(['slow'], {
      providers: { slow: { timeoutMs: 150 } },
    }));

    const started = Date.now();
    const result = await assembler.assemble();
    const elapsed = Date.now() - started;

    expect(slow.probes).toBe(1);
    expect(slow.fetches).toBe(1);
    // Old code: 100ms probe + a fresh 150ms fetch timeout = ~250ms.
    // New code: 100ms probe + the ~50ms remaining = ~150ms.
    expect(elapsed).toBeLessThan(200);
    expect(result.warnings.some((warning) => warning.reason === 'timeout')).toBe(true);
  });

  it('does not probe a provider that cannot answer this request', async () => {
    const registry = new ContextProviderRegistry();
    const focusOnly = new FocusOnlyProvider('focusOnly');
    registry.register(focusOnly);
    const assembler = new ContextAssembler(registry, configuration(['focusOnly']));

    await assembler.assemble({});
    expect(focusOnly.probes).toBe(0);
    expect(focusOnly.fetches).toBe(0);

    await assembler.assemble({ focus: 'the clinic site' });
    expect(focusOnly.probes).toBe(1);
    expect(focusOnly.fetches).toBe(1);
  });

  it('skipping is silent, not reported as a failure', async () => {
    const registry = new ContextProviderRegistry();
    registry.register(new FocusOnlyProvider('focusOnly'));
    const assembler = new ContextAssembler(registry, configuration(['focusOnly']));

    const result = await assembler.assemble({});
    // A provider with nothing to say is not an error the model should hear about.
    expect(result.warnings).toHaveLength(0);
  });

  it('still runs providers that declare no precondition', async () => {
    const registry = new ContextProviderRegistry();
    const plain = new SlowProbeProvider('plain', 1, 1);
    registry.register(plain);
    const assembler = new ContextAssembler(registry, configuration(['plain']));

    const result = await assembler.assemble({});
    expect(plain.probes).toBe(1);
    expect(result.text).toContain('late');
  });
});

/**
 * A provider that is slow to probe AND slow to report health -- the shape
 * list_context_capabilities hits. The memory provider is the real one: its
 * health() is a live /search whose results are discarded.
 */
class SlowHealthProvider implements InitialContextProvider {
  readonly defaultEnabled = true;
  readonly description = 'slow health';
  readonly priority = 1;
  probes = 0;
  healthChecks = 0;
  constructor(
    readonly id: string,
    private readonly probeMs: number,
    private readonly healthMs: number,
    private readonly availableResult = true,
  ) {}
  async isAvailable(): Promise<boolean> {
    this.probes += 1;
    await sleep(this.probeMs);
    return this.availableResult;
  }
  async getContext(): Promise<InitialContextSection | null> {
    return section(this.id, 'x');
  }
  async health(): Promise<{ status: 'ok'; checkedAt: string }> {
    this.healthChecks += 1;
    await sleep(this.healthMs);
    return { status: 'ok', checkedAt: new Date().toISOString() };
  }
}

describe('capabilities() spends one timeout, not two', () => {
  it('shares a single deadline between the probe and the health check', async () => {
    // Pre-fix: isAvailable got the full 150ms and then health got the full
    // 150ms again, sequentially -- 300ms for a call configured to take 150.
    const provider = new SlowHealthProvider('slow', 100, 400);
    const registry = new ContextProviderRegistry();
    registry.register(provider);
    const assembler = new ContextAssembler(registry, configuration(['slow'], { defaultTimeoutMs: 150 }));

    const started = Date.now();
    const capabilities = await assembler.capabilities();
    const elapsed = Date.now() - started;

    expect(capabilities).toHaveLength(1);
    // The probe used 100 of the 150, so health may only have the remaining 50:
    // about 150ms in total. Unfixed it is 100 + a fresh 150 = about 250ms, so
    // the bound has to sit BELOW 250 or the test passes either way. It did not,
    // at first -- 260 was above the broken cost and the mutation sweep proved
    // the test worthless.
    expect(elapsed).toBeLessThan(200);
    expect(capabilities[0]?.health?.status).toBe('unavailable');
  });

  it('does not probe health for a provider that just said it is unavailable', async () => {
    // Asking twice costs a second round trip to learn what the first one said.
    const provider = new SlowHealthProvider('down', 10, 5_000, false);
    const registry = new ContextProviderRegistry();
    registry.register(provider);
    const assembler = new ContextAssembler(registry, configuration(['down'], { defaultTimeoutMs: 2_000 }));

    const started = Date.now();
    const capabilities = await assembler.capabilities();

    expect(Date.now() - started).toBeLessThan(400);
    expect(provider.probes).toBe(1);
    expect(provider.healthChecks).toBe(0);
    expect(capabilities[0]?.available).toBe(false);
    expect(capabilities[0]?.health?.status).toBe('unavailable');
    expect(capabilities[0]?.health?.detail).toMatch(/not probed/i);
  });

  it('still reports a healthy provider as healthy', async () => {
    // The counterweight: the bound must not turn a working provider into a
    // failing one.
    const provider = new SlowHealthProvider('fast', 5, 5);
    const registry = new ContextProviderRegistry();
    registry.register(provider);
    const assembler = new ContextAssembler(registry, configuration(['fast'], { defaultTimeoutMs: 1_000 }));

    const capabilities = await assembler.capabilities();
    expect(capabilities[0]?.available).toBe(true);
    expect(capabilities[0]?.health?.status).toBe('ok');
    expect(provider.healthChecks).toBe(1);
  });
});
