import { afterEach, describe, expect, it, vi } from 'vitest';
import { Mem0HttpMemoryProvider } from '../../../src/services/memory/mem0-provider.js';

/**
 * Mem0 sits on the live voice path, so both of these are latency the user
 * hears: a larger response than anyone reads, and a second round trip made
 * after the caller already stopped waiting.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function provider(backupUrl?: string): Mem0HttpMemoryProvider {
  return new Mem0HttpMemoryProvider({
    baseUrl: 'https://primary.invalid',
    ...(backupUrl !== undefined ? { backupUrl } : {}),
    apiKey: 'k',
    userId: 'u',
    timeoutMs: 2_000,
  });
}

describe('mem0 request waste', () => {
  it('does not ask Mem0 for an explanation it never reads', async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      if (init?.body !== undefined) bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;

    await provider().search({ query: 'the clinic site', limit: 3 });

    expect(bodies.length).toBeGreaterThan(0);
    expect((bodies[0] as { explain?: unknown }).explain).toBe(false);
  });

  /**
   * The backup base exists for a primary that is down. It is NOT for a
   * request the assembler has already timed out and walked away from.
   */
  it('stops rather than failing over once the caller has aborted', async () => {
    const controller = new AbortController();
    let attempts = 0;
    globalThis.fetch = vi.fn(async () => {
      attempts += 1;
      // Caller gives up while the primary is in flight.
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }) as unknown as typeof fetch;

    await expect(
      provider('https://backup.invalid').search({ query: 'x', limit: 1, signal: controller.signal }),
    ).rejects.toThrow();

    expect(attempts).toBe(1);
  });

  it('still fails over to the backup when the caller is still waiting', async () => {
    let attempts = 0;
    globalThis.fetch = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('primary down');
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;

    await provider('https://backup.invalid').search({ query: 'x', limit: 1 });

    expect(attempts).toBe(2);
  });
});
