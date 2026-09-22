import { afterEach, describe, expect, it, vi } from 'vitest';
import { Mem0HttpMemoryProvider } from '../../../src/services/memory/mem0-provider.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Everything a caller or a log could see from a thrown value, flattened.
 *
 * Own (including non-enumerable) properties at every level, plus the cause
 * chain, because an Error's message and stack are non-enumerable and
 * JSON.stringify skips them entirely.
 */
function renderFully(value: unknown, depth = 0): string {
  if (depth > 6 || value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return String(value);
  const parts: string[] = [];
  for (const key of Object.getOwnPropertyNames(value)) {
    parts.push(key, renderFully((value as Record<string, unknown>)[key], depth + 1));
  }
  const cause = (value as { cause?: unknown }).cause;
  if (cause !== undefined) parts.push(renderFully(cause, depth + 1));
  return parts.join(' ');
}

describe('Mem0HttpMemoryProvider', () => {
  it('deduplicates semantically identical returned memories without dumping raw rows', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [
      { id: 'a', memory: 'Use the existing Mem0 provider.', score: 0.8, metadata: { topic: 'architecture' } },
      { id: 'b', memory: 'Use  the existing Mem0 provider', score: 0.9, metadata: { topic: 'architecture' } },
      { id: 'c', fact: 'Keep external side effects behind approvals.', score: 0.7 },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new Mem0HttpMemoryProvider({ baseUrl: 'https://mem0.invalid', apiKey: 'test-key', userId: 'test-user' });
    const results = await provider.search({ query: 'memory' });
    expect(results).toHaveLength(2);
    expect(results[0]?.id).toBe('b');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports configuration absence', async () => {
    const provider = new Mem0HttpMemoryProvider({ baseUrl: 'https://mem0.invalid', userId: 'test-user' });
    await expect(provider.search({ query: 'memory' })).rejects.toMatchObject({ code: 'MEMORY_UNAVAILABLE' });
    const health = await provider.health();
    expect(health.status).toBe('unavailable');
  });

  /**
   * This test used to be part of the one above, asserting that the health
   * output did not contain 'test-key' -- on a provider constructed WITHOUT an
   * api key. It was checking for a string it had never supplied, so it could
   * not fail. The key has to be present for its absence to mean anything.
   */
  it('never echoes the api key when the request fails', async () => {
    const apiKey = 'm0-SUPERSECRETKEYVALUE';
    // Every failure shape, because they take different paths out: a network
    // throw, a 5xx, and a 401.
    for (const outcome of [
      async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.1:443');
      },
      async () => new Response('upstream exploded', { status: 503 }),
      async () => new Response('denied', { status: 401 }),
    ]) {
      vi.stubGlobal('fetch', vi.fn(outcome));
      const provider = new Mem0HttpMemoryProvider({
        baseUrl: 'https://mem0.invalid',
        apiKey,
        userId: 'test-user',
      });

      const failure = await provider.search({ query: 'memory' }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeDefined();
      // Serialise the WHOLE error: message, details, hint and a wrapped cause
      // are all rendered to the client and into the log, and a leak in any of
      // them is a leak. NOT JSON.stringify(err, Object.getOwnPropertyNames(err))
      // -- that second argument is a replacer ARRAY, which filters keys at
      // EVERY level, so a credential nested inside `details` is silently
      // dropped from the output and the assertion passes. That is how this test
      // would have missed the exact mistake it is here to catch.
      expect(renderFully(failure)).not.toContain(apiKey);
      expect(String(failure)).not.toContain(apiKey);

      const health = await provider.health();
      expect(JSON.stringify(health)).not.toContain(apiKey);
      vi.unstubAllGlobals();
    }
  });

  it('does not retry a non-retryable Mem0 client rejection against a backup endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response('denied', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new Mem0HttpMemoryProvider({
      baseUrl: 'https://primary.invalid',
      backupUrl: 'https://backup.invalid',
      apiKey: 'test-key',
      userId: 'test-user',
    });
    await expect(provider.search({ query: 'memory' })).rejects.toMatchObject({ code: 'MEMORY_UNAVAILABLE', retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses the actual search capability instead of assuming a dedicated health route', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new Mem0HttpMemoryProvider({ baseUrl: 'https://mem0.invalid', apiKey: 'test-key', userId: 'test-user' });
    const health = await provider.health();
    expect(health.status).toBe('ok');
    expect(health.detail).toMatch(/search endpoint/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
