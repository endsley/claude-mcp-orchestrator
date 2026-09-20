import { describe, expect, it, vi } from 'vitest';
import { MemoryContextProvider } from '../../../src/context/providers/memory-provider.js';
import type { MemoryProvider } from '../../../src/services/memory/types.js';

function provider(): MemoryProvider {
  return {
    id: 'fake-memory',
    health: vi.fn(async () => ({ status: 'ok' as const, checkedAt: new Date().toISOString() })),
    search: vi.fn(async () => []),
  };
}

describe('MemoryContextProvider', () => {
  it('shares a short availability health cache without caching memory searches', async () => {
    const memory = provider();
    const context = new MemoryContextProvider(memory, 1_000, 10_000);

    expect(await context.isAvailable()).toBe(true);
    await context.health();
    expect(memory.health).toHaveBeenCalledTimes(1);

    await context.getContext({
      requestId: 'voice-1',
      profile: 'coding',
      focus: 'mobile navigation',
      maxTokens: 200,
      signal: new AbortController().signal,
      activeContext: {},
      options: {},
    });
    expect(memory.search).toHaveBeenCalledTimes(1);
    // Health is only availability metadata: a fresh search is still executed.
    expect(memory.health).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight health request across parallel capability checks', async () => {
    let release!: () => void;
    const memory = provider();
    (memory.health as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => { release = () => resolve({ status: 'ok', checkedAt: new Date().toISOString() }); }),
    );
    const context = new MemoryContextProvider(memory, 1_000, 10_000);
    const first = context.health();
    const second = context.isAvailable();
    release();
    await expect(first).resolves.toMatchObject({ status: 'ok' });
    await expect(second).resolves.toBe(true);
    expect(memory.health).toHaveBeenCalledTimes(1);
  });
});
