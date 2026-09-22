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

/**
 * Respects request.maxTokens the way the real memory provider does, so the
 * section it returns is genuinely shaped by the budget it was asked under.
 */
class BudgetSensitiveProvider implements InitialContextProvider {
  readonly defaultEnabled = true;
  readonly description = 'budget sensitive';
  readonly priority = 1;
  fetches = 0;
  constructor(readonly id: string) {}
  async isAvailable(): Promise<boolean> { return true; }
  async getContext(request: { maxTokens: number }): Promise<InitialContextSection | null> {
    this.fetches += 1;
    // One short line per ~4 tokens of budget, capped, so a bigger budget
    // really does yield more content.
    const count = Math.max(1, Math.min(8, Math.floor(request.maxTokens / 8)));
    return {
      providerId: this.id,
      title: 'BUDGET',
      lines: Array.from({ length: count }, (_, index) => `line-${index}`),
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

  /**
   * The bug this commit fixes, introduced when maxTokens left the cache key.
   * A small-budget turn caches a provider-truncated section; without the
   * serve-down rule a later large-budget turn is handed that truncated
   * section and cannot recover the dropped lines until the TTL expires.
   */
  it('does not let a small budget poison a later large one', async () => {
    const registry = new ContextProviderRegistry();
    const provider = new BudgetSensitiveProvider('counting');
    registry.register(provider as unknown as InitialContextProvider);
    const assembler = new ContextAssembler(registry, configuration());

    const small = await assembler.assemble({ focus: 'same', maxTokens: 16 });
    const large = await assembler.assemble({ focus: 'same', maxTokens: 400 });

    expect(large.text.length).toBeGreaterThan(small.text.length);
    // The large request had to re-fetch; it could not reuse the truncated one.
    expect(provider.fetches).toBe(2);
  });

  it('still reuses the cache downward, which is the safe direction', async () => {
    const registry = new ContextProviderRegistry();
    const provider = new BudgetSensitiveProvider('counting');
    registry.register(provider as unknown as InitialContextProvider);
    const assembler = new ContextAssembler(registry, configuration());

    await assembler.assemble({ focus: 'same', maxTokens: 400 });
    await assembler.assemble({ focus: 'same', maxTokens: 200 });
    await assembler.assemble({ focus: 'same', maxTokens: 64 });

    expect(provider.fetches).toBe(1);
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
