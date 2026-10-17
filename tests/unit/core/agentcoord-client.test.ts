import { describe, expect, it } from 'vitest';
import { AgentcoordClient, AgentcoordRemoteError, type AgentcoordCaller } from '../../../src/services/board/agentcoord-client.js';
import { BoardUnavailableError } from '../../../src/services/board/types.js';

const NODES = [
  { name: 'eva', url: 'http://eva.test:8798' },
  { name: 'anna', url: 'http://anna.test:8798/' },
  { name: 'amber', url: 'http://amber.test:8798' },
];
const CALLER: AgentcoordCaller = { token: 'agent-credential-for-tests', session: 'ext-key-muse', engine: 'muse' };

type Reply = { status: number; body: unknown } | 'down' | 'lost';
type Seen = { url: string; headers: Record<string, string>; body: unknown };

function client(script: (url: string, n: number) => Reply, busyRetries = 2) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    const reply = script(url, seen.length);
    if (reply === 'down') throw new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
    if (reply === 'lost') throw new DOMException('The operation timed out.', 'TimeoutError');
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  const instance = new AgentcoordClient({
    nodes: NODES,
    requestTimeoutMs: 1000,
    busyRetries,
    downCacheMs: 10_000,
    fetchImpl,
    sleep: async () => undefined,
  });
  return { instance, seen, hosts: () => seen.map((s) => new URL(s.url).hostname) };
}

const ok = (node: string, epoch = 5, result: unknown = { id: 1 }) => ({
  status: 200,
  body: { ok: true, node, epoch, leader: node, result },
});
const notLeader = (leader: string | null, leaderUrl: string | null) => ({
  status: 409,
  body: { ok: false, node: 'x', epoch: 5, leader, reason: 'not leader', leader_url: leaderUrl },
});

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a failure');
}

describe('AgentcoordClient', () => {
  it('POSTs the payload as the body to /api/v1/<op> with the credential and identity headers', async () => {
    const { instance, seen } = client(() => ok('eva'));
    expect(await instance.call('file_board', { project: 'oakhaven' }, CALLER)).toEqual({ id: 1 });
    expect(seen[0]!.url).toBe('http://eva.test:8798/api/v1/file_board');
    expect(seen[0]!.body).toEqual({ project: 'oakhaven' });
    expect(seen[0]!.headers).toMatchObject({
      authorization: `Bearer ${CALLER.token}`,
      'x-session': 'ext-key-muse',
      'x-worker': 'ext-key-muse',
      'x-engine': 'muse',
      'x-min-epoch': '0',
    });
    // The identity comes from the agent credential; X-Agent is never sent.
    expect(Object.keys(seen[0]!.headers).map((key) => key.toLowerCase())).not.toContain('x-agent');
  });

  it('omits X-Engine when the identity has none, and sends the highest epoch seen', async () => {
    const { instance, seen } = client(() => ok('eva', 9));
    await instance.call('attention', {}, { token: 't', session: 's' });
    await instance.call('attention', {}, { token: 't', session: 's' });
    expect(seen[0]!.headers['x-engine']).toBeUndefined();
    expect(seen[1]!.headers['x-min-epoch']).toBe('9');
  });

  it('follows 409 not-leader to the configured leader, by name or by exact configured URL', async () => {
    const byName = client((url) => (url.includes('amber') ? ok('amber') : notLeader('amber', 'http://amber.test:8798')));
    await byName.instance.call('send', { body: 'x' }, CALLER);
    expect(byName.hosts()).toEqual(['eva.test', 'amber.test']);
    // The leader is remembered and tried first next time.
    await byName.instance.call('send', { body: 'y' }, CALLER);
    expect(byName.hosts()[2]).toBe('amber.test');

    const byUrl = client((url) => (url.includes('anna') ? ok('anna') : notLeader(null, 'http://anna.test:8798')));
    await byUrl.instance.call('file_claim', { project: 'p' }, CALLER);
    expect(byUrl.hosts()).toEqual(['eva.test', 'anna.test']);
  });

  it('never follows a leader URL that is not a configured node (the credential stays home)', async () => {
    const { instance, seen } = client((url) =>
      url.includes('eva') ? notLeader('mallory', 'http://mallory.example:8798') : notLeader(null, null),
    );
    const error = await failure(instance.call('file_claim', { project: 'p' }, CALLER));
    expect(error).toBeInstanceOf(BoardUnavailableError);
    expect(seen.every((s) => NODES.some((node) => s.url.startsWith(node.url.replace(/\/$/, ''))))).toBe(true);
    expect(seen.map((s) => s.url).join(' ')).not.toContain('mallory');
  });

  it('moves on from a stale-epoch 409', async () => {
    const { instance, hosts } = client((url) =>
      url.includes('eva') ? { status: 409, body: { ok: false, leader: null, reason: 'stale epoch 3 < client 5' } } : ok('anna'),
    );
    await instance.call('ack', { ids: [1] }, CALLER);
    expect(hosts()).toEqual(['eva.test', 'anna.test']);
  });

  it('retries a busy 503 briefly on the same node, then succeeds', async () => {
    const { instance, hosts } = client((_url, n) => (n < 3 ? { status: 503, body: { ok: false, reason: 'starting: surveying peers' } } : ok('eva')));
    await instance.call('job_take', { id: 1 }, CALLER);
    expect(hosts()).toEqual(['eva.test', 'eva.test', 'eva.test']);
  });

  it('fails over to the next node when one refuses the connection, for writes too', async () => {
    const { instance, hosts } = client((url) => (url.includes('eva') ? 'down' : ok('anna')));
    await instance.call('send', { body: 'x' }, CALLER);
    expect(hosts()).toEqual(['eva.test', 'anna.test']);
  });

  it('never retries a write whose outcome is unknown', async () => {
    const { instance, hosts } = client(() => 'lost');
    const error = await failure(instance.call('send', { body: 'x' }, CALLER));
    expect(error).toBeInstanceOf(BoardUnavailableError);
    expect(String((error as Error).message)).toContain('unknown');
    expect(hosts()).toEqual(['eva.test']);
  });

  it('does retry a read on the next node after a lost connection', async () => {
    const { instance, hosts } = client((url) => (url.includes('eva') ? 'lost' : ok('anna')));
    await instance.call('attention', {}, CALLER);
    expect(hosts()).toEqual(['eva.test', 'anna.test']);
  });

  it('surfaces the service error envelope, without retrying', async () => {
    const { instance, hosts } = client(() => ({
      status: 403,
      body: {
        ok: false,
        error: { type: 'missing_permission', message: 'agent ext/muse (muse) may only take code-simple work; this is code work', retry_safe: false },
      },
    }));
    const error = (await failure(instance.call('job_take', { id: 7 }, CALLER))) as AgentcoordRemoteError;
    expect(error).toBeInstanceOf(AgentcoordRemoteError);
    expect(error.status).toBe(403);
    expect(error.type).toBe('missing_permission');
    expect(error.message).toContain('code-simple');
    expect(hosts()).toEqual(['eva.test']);
  });

  it('does not retry a 503 that carries a database error (outcome unknown)', async () => {
    const { instance, hosts } = client(() => ({
      status: 503,
      body: { ok: false, reason: 'database error: X', error: { type: 'transient', message: 'boom', retry_safe: false, fix: 're-read state' } },
    }));
    const error = (await failure(instance.call('job_update', { id: 1, action: 'done' }, CALLER))) as AgentcoordRemoteError;
    expect(error).toBeInstanceOf(AgentcoordRemoteError);
    expect(error.fix).toBe('re-read state');
    expect(hosts()).toEqual(['eva.test']);
  });

  it('never puts the credential in an error message', async () => {
    const { instance } = client(() => 'down');
    const error = (await failure(instance.call('attention', {}, CALLER))) as Error;
    expect(error.message).not.toContain(CALLER.token);
  });

  it('refuses an oversized reply', async () => {
    const fetchImpl = (async () =>
      new Response('x'.repeat(3 * 1024 * 1024), { status: 200, headers: { 'content-length': String(3 * 1024 * 1024) } })) as typeof fetch;
    const instance = new AgentcoordClient({ nodes: NODES.slice(0, 1), requestTimeoutMs: 1000, busyRetries: 0, downCacheMs: 0, fetchImpl });
    // A read: the failure is a parse/size error, so the node is reported as failed.
    expect(await failure(instance.call('attention', {}, CALLER))).toBeInstanceOf(BoardUnavailableError);
  });

  it('refuses an op outside the fixed set (an op is part of the URL)', async () => {
    const { instance, seen } = client(() => ok('eva'));
    await expect(instance.call('credential_create' as never, {}, CALLER)).rejects.toBeInstanceOf(BoardUnavailableError);
    expect(seen).toHaveLength(0);
  });
});
