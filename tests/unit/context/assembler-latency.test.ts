import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../../../src/context/text.js';
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

/**
 * A provider that fails is invisible to the reader whose behaviour depends on
 * it.
 *
 * assemble() has always recorded warnings, but only on the returned object --
 * and the model reads `text`. So a timed-out memory provider produced a
 * context that LOOKED complete, and the model would answer "you have no
 * memories about that" when the truth was "memory could not be reached". A
 * confident answer from silently missing context is worse than an error,
 * because nothing about it invites a retry.
 *
 * Found by asking what the system silently DROPS -- the same inversion that
 * found seventeen false positives in the permission classifier and the
 * over-redaction of credential metadata.
 */
class FailingProvider implements InitialContextProvider {
  readonly defaultEnabled = true;
  readonly priority = 50;
  constructor(readonly id: string, readonly description: string, private readonly mode: 'timeout' | 'unavailable' | 'throws') {}
  async isAvailable(): Promise<boolean> {
    return this.mode !== 'unavailable';
  }
  async getContext(): Promise<InitialContextSection | null> {
    if (this.mode === 'timeout') {
      await sleep(5_000);
      return null;
    }
    throw new Error('provider exploded');
  }
}

describe('a gap in the context is stated in the context', () => {
  function assembler(providers: InitialContextProvider[], ids: string[]): ContextAssembler {
    const registry = new ContextProviderRegistry();
    for (const provider of providers) registry.register(provider);
    return new ContextAssembler(registry, configuration(ids, { defaultTimeoutMs: 150 }));
  }

  it('names a provider that timed out, in the text the model reads', async () => {
    const good = new SlowProbeProvider('projects', 1, 1);
    const assembled = await assembler([good, new FailingProvider('memory', 'long-term memory', 'timeout')], [
      'projects',
      'memory',
    ]).assemble({});

    expect(assembled.text).toContain('PROJECTS');
    expect(assembled.text).toMatch(/CONTEXT GAPS/);
    expect(assembled.text).toMatch(/long-term memory/);
    // The structured warning is still there for programmatic callers.
    expect(assembled.warnings.some((warning) => warning.providerId === 'memory')).toBe(true);
  }, 20_000);

  it('names one that reported itself unavailable, and one that threw', async () => {
    const assembled = await assembler(
      [
        new SlowProbeProvider('projects', 1, 1),
        new FailingProvider('computers', 'machine list', 'unavailable'),
        new FailingProvider('systemStatus', 'system status', 'throws'),
      ],
      ['projects', 'computers', 'systemStatus'],
    ).assemble({});

    expect(assembled.text).toMatch(/machine list/);
    expect(assembled.text).toMatch(/system status/);
  }, 20_000);

  it('says nothing at all when every provider answered', async () => {
    // The notice must not become background noise, or it stops being read.
    const assembled = await assembler([new SlowProbeProvider('projects', 1, 1)], ['projects']).assemble({});
    expect(assembled.text).not.toMatch(/CONTEXT GAPS/);
    expect(assembled.text).toBe('PROJECTS\nlate');
  }, 20_000);

  it('counts the notice in the reported token estimate', async () => {
    // estimatedTokens is what a caller budgets against; reporting a number
    // that excludes text we actually emit would make it a lie.
    const assembled = await assembler([new FailingProvider('memory', 'long-term memory', 'timeout')], ['memory']).assemble({});
    expect(assembled.estimatedTokens).toBe(estimateTokens(assembled.text));
    expect(assembled.estimatedTokens).toBeGreaterThan(0);
  }, 20_000);
});

describe('a trimmed section is not a gap', () => {
  it('stays silent when a section was only shortened', async () => {
    // Trimmed content is PRESENT, just shorter, and the model can see what it
    // got. Calling that a gap would spend tokens telling it something it can
    // already observe, and would make the notice routine enough to ignore --
    // which is how a warning stops working.
    class Chatty implements InitialContextProvider {
      readonly id = 'projects';
      readonly defaultEnabled = true;
      readonly description = 'projects';
      readonly priority = 90;
      async isAvailable(): Promise<boolean> {
        return true;
      }
      async getContext(): Promise<InitialContextSection> {
        return {
          providerId: this.id,
          title: 'PROJECTS',
          lines: Array.from({ length: 400 }, (_, index) => `project number ${index} with a long descriptive name`),
          generatedAt: new Date().toISOString(),
        };
      }
    }
    const registry = new ContextProviderRegistry();
    registry.register(new Chatty());
    const assembled = await new ContextAssembler(
      registry,
      configuration(['projects'], { maxTokens: 120 }),
    ).assemble({});

    // It really was trimmed...
    expect(assembled.warnings.some((warning) => warning.reason === 'trimmed')).toBe(true);
    // ...and that is not reported as missing context.
    expect(assembled.text).not.toMatch(/CONTEXT GAPS/);
  }, 20_000);
});

/**
 * Asking for a provider that does not exist.
 *
 * A mistyped PROFILE throws PROFILE_NOT_FOUND and the caller learns at once. A
 * mistyped provider id in `include` was silently dropped -- so a model that
 * asked for memory context and received none could not tell "there is nothing
 * in memory" from "you spelled it wrong", and would answer as though memory
 * were empty. Two spellings of one mistake, opposite treatment, in the same
 * file.
 *
 * Reported rather than thrown, because unlike a bad profile an unknown id does
 * not make the request meaningless -- the rest of the context is still worth
 * returning.
 */
describe('a provider id the server does not have', () => {
  function assembler(ids: string[]): ContextAssembler {
    const registry = new ContextProviderRegistry();
    registry.register(new SlowProbeProvider('projects', 1, 1));
    registry.register(new SlowProbeProvider('memory', 1, 1));
    return new ContextAssembler(registry, configuration(ids));
  }

  it('names the mistake and the ids that would have worked', async () => {
    // The reader is a model that can retry, so the message has to contain
    // enough for it to retry correctly.
    const assembled = await assembler(['projects']).assemble({ include: ['memroy'] });

    expect(assembled.text).toMatch(/CONTEXT GAPS/);
    expect(assembled.text).toContain('memroy');
    expect(assembled.text).toMatch(/available ids are .*memory/);
    expect(assembled.warnings.some((warning) => warning.reason === 'unknown')).toBe(true);
  }, 20_000);

  it('still returns the context that was available', async () => {
    // Not an exception: the rest of the answer is worth having.
    const assembled = await assembler(['projects']).assemble({ include: ['memroy'] });
    expect(assembled.sections.map((section) => section.providerId)).toEqual(['projects']);
  }, 20_000);

  it('reports a mistyped exclude too', async () => {
    // Excluding something that does not exist silently does nothing, which
    // looks identical to the exclusion having worked.
    const assembled = await assembler(['projects']).assemble({ exclude: ['prjects'] });
    expect(assembled.text).toContain('prjects');
  }, 20_000);

  it('says nothing when every requested id is real', async () => {
    const assembled = await assembler(['projects']).assemble({ include: ['memory'] });
    expect(assembled.text).not.toMatch(/CONTEXT GAPS/);
    expect(assembled.sections.map((section) => section.providerId).sort()).toEqual(['memory', 'projects']);
  }, 20_000);

  it('still throws for a mistyped profile, which IS meaningless', async () => {
    // The distinction being drawn: a bad profile leaves nothing to answer
    // with, a bad include leaves the rest.
    await expect(assembler(['projects']).assemble({ profile: 'codeing' })).rejects.toMatchObject({
      code: 'PROFILE_NOT_FOUND',
    });
  }, 20_000);
});
