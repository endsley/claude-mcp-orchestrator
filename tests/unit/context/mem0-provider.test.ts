import { afterEach, describe, expect, it, vi } from 'vitest';
import { Mem0HttpMemoryProvider } from '../../../src/services/memory/mem0-provider.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it('reports configuration absence without exposing a credential', async () => {
    const provider = new Mem0HttpMemoryProvider({ baseUrl: 'https://mem0.invalid', userId: 'test-user' });
    await expect(provider.search({ query: 'memory' })).rejects.toMatchObject({ code: 'MEMORY_UNAVAILABLE' });
    const health = await provider.health();
    expect(health.status).toBe('unavailable');
    expect(JSON.stringify(health)).not.toContain('test-key');
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
