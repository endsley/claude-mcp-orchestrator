import { describe, expect, it } from 'vitest';
import { HttpBoardClient } from '../../../src/services/board/http-board-client.js';
import { BoardRemoteError, BoardUnavailableError } from '../../../src/services/board/types.js';

const NODES = [
  { name: 'node-a', url: 'http://node-a.test:8797' },
  { name: 'node-b', url: 'http://node-b.test:8797/' },
  { name: 'node-c', url: 'http://node-c.test:8797' },
];
const TOKEN = 'board-service-token-for-tests';

type Reply = { status: number; body: unknown } | 'down' | 'lost';

function client(script: (url: string, body: Record<string, unknown>) => Reply, token: string | null = TOKEN) {
  const seen: Array<{ url: string; auth: string | undefined; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const headers = init?.headers as Record<string, string>;
    seen.push({ url, auth: headers['authorization'], body });
    const reply = script(url, body);
    // 'down': refused before anything was sent. 'lost': the connection died
    // after the request may have been delivered (a timeout or a reset).
    if (reply === 'down') throw new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
    if (reply === 'lost') throw new DOMException('The operation timed out.', 'TimeoutError');
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  let tokenReads = 0;
  const instance = new HttpBoardClient({
    nodes: NODES,
    readToken: async () => {
      tokenReads += 1;
      return token ?? undefined;
    },
    requestTimeoutMs: 1000,
    busyRetries: 2,
    downCacheMs: 10_000,
    fetchImpl,
    sleep: async () => undefined,
  });
  return { instance, seen, tokenReads: () => tokenReads };
}

const ok = (node: string, epoch = 3, result: unknown = { id: 1 }) => ({
  status: 200,
  body: { ok: true, result, node, epoch, leader: node },
});

describe('HttpBoardClient', () => {
  it('posts the op with the bearer token, payload and min_epoch', async () => {
    const { instance, seen } = client(() => ok('node-a'));
    const out = await instance.op('snapshot', { project: 'demo-app' });
    expect(out).toEqual({ result: { id: 1 }, node: 'node-a', epoch: 3 });
    expect(seen[0]).toEqual({
      url: 'http://node-a.test:8797/api/op/snapshot',
      auth: `Bearer ${TOKEN}`,
      body: { payload: { project: 'demo-app' }, min_epoch: 0 },
    });
  });

  it('tracks the highest epoch and sends it next time', async () => {
    const { instance, seen } = client(() => ok('node-a', 7));
    await instance.op('heartbeat', { session_id: 's' });
    await instance.op('heartbeat', { session_id: 's' });
    expect(seen[1]!.body['min_epoch']).toBe(7);
  });

  it('fails over to the next node when one is unreachable, then prefers the leader', async () => {
    const { instance, seen } = client((url) => (url.includes('node-a') ? 'down' : ok('node-b')));
    await instance.op('snapshot', {});
    expect(seen.map((s) => new URL(s.url).hostname)).toEqual(['node-a.test', 'node-b.test']);
    await instance.op('snapshot', {});
    expect(new URL(seen[2]!.url).hostname).toBe('node-b.test');
  });

  it('follows a 409 to the named leader', async () => {
    const { instance, seen } = client((url) =>
      url.includes('node-c') ? ok('node-c') : { status: 409, body: { ok: false, reason: 'not leader', leader: 'node-c' } },
    );
    await instance.op('post_task', {});
    expect(seen.map((s) => new URL(s.url).hostname)).toEqual(['node-a.test', 'node-c.test']);
  });

  it('never sends the token to a leader_url that is not a configured node', async () => {
    const { instance, seen } = client(() => ({
      status: 409,
      body: { ok: false, reason: 'not leader', leader: 'evil', leader_url: 'http://attacker.example:8797' },
    }));
    await expect(instance.op('post_task', {})).rejects.toBeInstanceOf(BoardUnavailableError);
    expect(seen.every((s) => !s.url.includes('attacker'))).toBe(true);
  });

  it('retries a 503 on the same node a bounded number of times', async () => {
    let calls = 0;
    const { instance, seen } = client((url) => {
      if (url.includes('node-a')) {
        calls += 1;
        return calls < 3 ? { status: 503, body: { reason: 'starting' } } : ok('node-a');
      }
      return 'down';
    });
    await instance.op('claim', {});
    expect(seen).toHaveLength(3);
  });

  it('returns a 422 as a remote error with conflicts', async () => {
    const { instance } = client(() => ({
      status: 422,
      body: {
        ok: false,
        error: { type: 'ClaimConflict', message: 'claimed', conflicts: [{ path: 'a.py', kind: 'file', agent: 'other-agent', session_id: 's' }] },
      },
    }));
    const error = await instance.op('claim', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BoardRemoteError);
    expect((error as BoardRemoteError).type).toBe('ClaimConflict');
    expect((error as BoardRemoteError).conflicts).toEqual([{ path: 'a.py', kind: 'file', agent: 'other-agent', session_id: 's' }]);
  });

  it('caches an all-down result briefly instead of paying every timeout again', async () => {
    const { instance, seen } = client(() => 'down');
    await expect(instance.op('snapshot', {})).rejects.toBeInstanceOf(BoardUnavailableError);
    expect(seen).toHaveLength(3);
    await expect(instance.op('snapshot', {})).rejects.toThrow(/cached/);
    expect(seen).toHaveLength(3);
  });

  it('reads the token on every call and refuses without one', async () => {
    const live = client(() => ok('node-a'));
    await live.instance.op('snapshot', {});
    await live.instance.op('snapshot', {});
    expect(live.tokenReads()).toBe(2);

    const none = client(() => ok('node-a'), null);
    await expect(none.instance.op('snapshot', {})).rejects.toThrow(/token/);
    expect(none.seen).toHaveLength(0);
  });

  it('does not fail a write over to another node once it may have been delivered', async () => {
    const { instance, seen } = client((url) => (url.includes('node-a') ? 'lost' : ok('node-b')));
    await expect(instance.op('message', { body: 'hi' })).rejects.toThrow(/outcome of this message is unknown/);
    expect(seen).toHaveLength(1);
  });

  it('does fail a read over after a lost reply', async () => {
    const { instance, seen } = client((url) => (url.includes('node-a') ? 'lost' : ok('node-b')));
    await instance.op('snapshot', {});
    expect(seen).toHaveLength(2);
  });

  it('refuses an oversized reply without buffering it all', async () => {
    const big = 'x'.repeat(3 * 1024 * 1024);
    const { instance } = client(() => ({ status: 200, body: { ok: true, result: big } }));
    await expect(instance.op('snapshot', {})).rejects.toBeInstanceOf(BoardUnavailableError);
  });

  it('does not put the token in error messages', async () => {
    const { instance } = client(() => ({ status: 500, body: { reason: TOKEN } }));
    const error = (await instance.op('snapshot', {}).catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain(TOKEN);
  });
});
