import { describe, expect, it } from 'vitest';
import { ContextAssembler } from '../../../src/context/assembler.js';
import type { ContextAssemblyConfiguration } from '../../../src/context/contracts.js';
import { ContextProviderRegistry } from '../../../src/context/registry.js';
import type { InitialContextProvider, InitialContextSection } from '../../../src/types/context.js';

/** Counts how often the provider is actually asked to do work. */
class CountingProvider implements InitialContextProvider {
  readonly defaultEnabled = true;
  readonly description = 'counting';
  readonly priority = 1;
  fetches = 0;
  constructor(readonly id: string) {}
  async isAvailable(): Promise<boolean> { return true; }
  async getContext(): Promise<InitialContextSection | null> {
    this.fetches += 1;
    return {
      providerId: this.id,
      title: 'COUNTING',
      lines: ['alpha', 'beta', 'gamma'],
      generatedAt: new Date().toISOString(),
    };
  }
}

function configuration(overrides: Partial<ContextAssemblyConfiguration> = {}): ContextAssemblyConfiguration {
  return {
    defaultProfile: 'default',
    maxTokens: 500,
    defaultTimeoutMs: 1_000,
    retrievalConcurrency: 4,
    profiles: { default: { providers: ['counting'] } },
    providers: { counting: { cacheTtlMs: 60_000 } },
    ...overrides,
  };
}

describe('context payload waste', () => {
  /**
   * The cached value is the provider's RAW section; trimming to the budget
   * happens afterwards in assemble(). Keying the cache on maxTokens therefore
   * fragmented it for no reason - the same focus at a different budget re-ran
   * the provider to obtain an identical section.
   */
  it('reuses a cached section across different token budgets', async () => {
    const registry = new ContextProviderRegistry();
    const provider = new CountingProvider('counting');
    registry.register(provider);
    const assembler = new ContextAssembler(registry, configuration());

    await assembler.assemble({ focus: 'the clinic site', maxTokens: 400 });
    await assembler.assemble({ focus: 'the clinic site', maxTokens: 200 });
    await assembler.assemble({ focus: 'the clinic site', maxTokens: 350 });

    expect(provider.fetches).toBe(1);
  });

  it('still separates genuinely different focuses', async () => {
    const registry = new ContextProviderRegistry();
    const provider = new CountingProvider('counting');
    registry.register(provider);
    const assembler = new ContextAssembler(registry, configuration());

    await assembler.assemble({ focus: 'one' });
    await assembler.assemble({ focus: 'two' });

    expect(provider.fetches).toBe(2);
  });

  it('still trims to the smaller budget despite serving a cached section', async () => {
    const registry = new ContextProviderRegistry();
    registry.register(new CountingProvider('counting'));
    const assembler = new ContextAssembler(registry, configuration());

    const generous = await assembler.assemble({ focus: 'same', maxTokens: 500 });
    const tight = await assembler.assemble({ focus: 'same', maxTokens: 4 });

    // Caching the untrimmed section must not leak a too-large payload.
    expect(tight.text.length).toBeLessThan(generous.text.length);
  });
});
