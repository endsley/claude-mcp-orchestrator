import { describe, expect, it } from 'vitest';
import { boardConfigSchema } from '../../../src/config/schema.js';
import { createNullLogger } from '../../../src/logging/logger.js';
import { boardKeyPrincipal, oauthPrincipal, staticBearerPrincipal } from '../../../src/security/principal.js';
import { parseScopes } from '../../../src/security/scopes.js';
import { AgentcoordRemoteError } from '../../../src/services/board/agentcoord-client.js';
import { AgentcoordBoardService } from '../../../src/services/board/agentcoord-service.js';
import { OrchestratorError } from '../../../src/types/errors.js';
import type { JsonObject } from '../../../src/types/json.js';
import { FakeAgentcoord } from '../../fakes/fake-agentcoord.js';

const MUSE_TOKEN = 'muse-agent-credential';
const OAUTH_TOKEN = 'oauth-agent-credential';

function setup(options: { tokens?: Record<string, string | undefined>; agents?: Record<string, string>; writesPerMinute?: number } = {}) {
  const fake = new FakeAgentcoord(options.agents ?? { [MUSE_TOKEN]: 'ext/muse', [OAUTH_TOKEN]: 'ext/remote' });
  const config = boardConfigSchema.parse({
    enabled: true,
    writesPerMinute: options.writesPerMinute ?? 30,
    agentcoord: {
      nodes: [{ name: 'eva', url: 'http://eva.test:8798' }],
      projects: ['oakhaven', 'vessence'],
      identities: {
        boardKeys: { muse: { agent: 'ext/muse', tokenFile: '/secrets/muse.token', engine: 'muse' } },
        oauthClients: { mcpc_remote: { agent: 'ext/remote', tokenFile: '/secrets/remote.token' } },
      },
    },
  });
  const tokens = options.tokens ?? { '/secrets/muse.token': MUSE_TOKEN, '/secrets/remote.token': OAUTH_TOKEN };
  const reads: string[] = [];
  const service = new AgentcoordBoardService(
    fake,
    config,
    async (path) => {
      reads.push(path);
      return tokens[path];
    },
    createNullLogger(),
  );
  const muse = boardKeyPrincipal('muse', parseScopes('board'));
  return { fake, service, muse, reads };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (OrchestratorError.is(error)) return error.code;
    throw error;
  }
  return 'OK';
}

describe('AgentcoordBoardService identity', () => {
  it('uses the credential and session of the authenticated principal, and its engine', async () => {
    const { fake, service, muse } = setup();
    await service.postTask(muse, { project: 'oakhaven', task: 'fix x', claims: [{ path: 'src/a.ts', kind: 'file' }] });
    const call = fake.last('file_claim')!;
    expect(call.caller).toEqual({ token: MUSE_TOKEN, session: 'ext-key-muse', engine: 'muse' });
    // Nothing identity-shaped is ever in the payload.
    expect(call.payload).toEqual({ project: 'oakhaven', task: 'fix x', replace: true, claims: [{ path: 'src/a.ts', kind: 'file' }] });
  });

  it('maps an OAuth principal by client_id, never by its (attacker-chosen) client name', async () => {
    const { fake, service } = setup();
    const named = oauthPrincipal({ clientId: 'mcpc_remote', clientName: 'muse', scopes: parseScopes('board') });
    await service.attention(named, {});
    expect(fake.last('attention')!.caller).toEqual({ token: OAUTH_TOKEN, session: 'ext-oauth-mcpc_remote' });

    const impostor = oauthPrincipal({ clientId: 'mcpc_other', clientName: 'muse', scopes: parseScopes('board') });
    expect(await code(service.attention(impostor, {}))).toBe('PERMISSION_DENIED');
  });

  it('refuses an unmapped principal before anything is sent (fail closed)', async () => {
    const { fake, service, reads } = setup();
    for (const principal of [
      boardKeyPrincipal('helper-bot', parseScopes('board')),
      staticBearerPrincipal(),
      // A board key named like an OAuth client id cannot borrow its identity.
      boardKeyPrincipal('mcpc_remote', parseScopes('board')),
      boardKeyPrincipal('__proto__', parseScopes('board')),
      boardKeyPrincipal('constructor', parseScopes('board')),
    ]) {
      expect(await code(service.attention(principal, {})), principal.subject).toBe('PERMISSION_DENIED');
    }
    expect(fake.calls).toHaveLength(0);
    expect(reads).toHaveLength(0);
  });

  it('refuses when the identity credential is not installed, without revealing its path', async () => {
    const { fake, service, muse } = setup({ tokens: {} });
    const error = await service.attention(muse, {}).catch((e: unknown) => e as OrchestratorError);
    expect((error as OrchestratorError).code).toBe('BOARD_UNAVAILABLE');
    expect((error as OrchestratorError).message).not.toContain('/secrets');
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses a credential that resolves to a different agent, before any write', async () => {
    const { fake, service, muse } = setup({ agents: { [MUSE_TOKEN]: 'ext/someone-else' } });
    expect(await code(service.postTask(muse, { project: 'oakhaven', task: 't', claims: [{ path: 'a', kind: 'file' }] }))).toBe(
      'PERMISSION_DENIED',
    );
    expect(fake.calls.map((call) => call.op)).toEqual(['file_board']);
  });

  it('verifies a credential once, not on every call', async () => {
    const { fake, service, muse } = setup();
    await service.attention(muse, {});
    await service.attention(muse, {});
    expect(fake.calls.map((call) => call.op)).toEqual(['file_board', 'attention', 'attention']);
  });
});

describe('AgentcoordBoardService op mapping', () => {
  it('maps the seven board tools as agentcoord mcp_server.py does', async () => {
    const { fake, service, muse } = setup();
    await service.board(muse, { project: 'oakhaven' });
    expect(fake.last('file_board')!.payload).toEqual({ project: 'oakhaven' });

    await service.claim(muse, { project: 'oakhaven', claims: [{ path: 'docs/', kind: 'tree' }], job: 11, ackJobs: [3], readOnly: true });
    expect(fake.last('file_claim')!.payload).toEqual({
      project: 'oakhaven',
      claims: [{ path: 'docs', kind: 'tree' }],
      job: 11,
      ack_jobs: [3],
      read_only: true,
    });

    await service.postTask(muse, { project: 'oakhaven', task: 'all', claims: [{ path: 'x', kind: 'project' }] });
    expect(fake.last('file_claim')!.payload['claims']).toEqual([{ path: '.', kind: 'tree' }]);

    await service.release(muse, { project: 'oakhaven', claims: [{ path: 'src/a.ts', kind: 'file' }, { path: 'docs', kind: 'tree' }] });
    expect(fake.last('file_release')!.payload).toEqual({ project: 'oakhaven', paths: ['src/a.ts', 'docs'] });

    await service.heartbeat(muse, { project: 'oakhaven' });
    expect(fake.last('heartbeat')!.payload).toEqual({});

    await service.message(muse, { project: 'oakhaven', body: 'hi', to: 'katie/claude-ui' });
    expect(fake.last('send')!.payload).toEqual({ body: 'hi', kind: 'discussion', subject: '[oakhaven] code coordination', to: ['katie/claude-ui'] });
    await service.message(muse, { project: 'oakhaven', body: 'all' });
    expect(fake.last('send')!.payload).toMatchObject({ group: 'all' });
    expect(fake.last('send')!.payload['to']).toBeUndefined();

    await service.finish(muse, { project: 'oakhaven', result: 'done' });
    expect(fake.last('file_finish')!.payload).toEqual({ project: 'oakhaven', note: 'done' });
    await service.finish(muse, { allProjects: true, canceled: true });
    // Never `all`: that would release the agent's other workers too.
    expect(fake.last('file_finish')!.payload).toEqual({ project: null, note: 'canceled' });
  });

  it('maps the coord_* work tools', async () => {
    const { fake, service, muse } = setup();
    await service.attention(muse, { limit: 5 });
    expect(fake.last('attention')!.payload).toEqual({ limit: 5 });
    await service.ack(muse, { ids: [5, 6], applied: 'handled' });
    expect(fake.last('ack')!.payload).toEqual({ ids: [5, 6], applied: 'handled' });
    await service.read(muse, { id: 5 });
    expect(fake.last('read')!.payload).toEqual({ id: 5 });
    await service.projectShow(muse, { project: 'oakhaven' });
    expect(fake.last('project_show')!.payload).toEqual({ project: 'oakhaven' });
    await service.jobTake(muse, { project: 'oakhaven', id: 11, note: 'starting' });
    expect(fake.last('job_take')!.payload).toEqual({ id: 11, note: 'starting' });
    await service.jobUpdate(muse, { id: 11, action: 'done', note: 'commit abc, tests pass' });
    expect(fake.last('job_update')!.payload).toEqual({ id: 11, action: 'done', note: 'commit abc, tests pass' });
    await service.myJobs(muse);
    expect(fake.last('my_jobs')!.payload).toEqual({});
  });

  it('lists only allowlisted projects and flags vision swarms', async () => {
    const { fake, service, muse } = setup();
    const all = await service.projectList(muse, {});
    expect(fake.last('project_list')!.payload).toEqual({});
    const names = (all['projects'] as JsonObject[]).map((row) => row['name']);
    expect(names).not.toContain('secret-repo');
    const oak = (all['projects'] as JsonObject[]).find((row) => row['name'] === 'oakhaven')!;
    expect(oak['swarm']).toBe(true);
    expect(oak['agents']).toBeUndefined();
    const swarms = await service.projectList(muse, { swarmsOnly: true, includeDone: true });
    expect(fake.last('project_list')!.payload).toEqual({ include_done: true });
    expect((swarms['projects'] as JsonObject[]).every((row) => row['swarm'] === true)).toBe(true);
  });

  it('refuses projects outside the allowlist before calling the service', async () => {
    const { fake, service, muse } = setup();
    await service.attention(muse, {}); // verification call out of the way
    const before = fake.calls.length;
    expect(await code(service.board(muse, { project: 'secret-repo' }))).toBe('PROJECT_NOT_FOUND');
    expect(await code(service.projectShow(muse, { project: 'secret-repo' }))).toBe('PROJECT_NOT_FOUND');
    expect(await code(service.jobTake(muse, { project: 'secret-repo', id: 11 }))).toBe('PROJECT_NOT_FOUND');
    expect(await code(service.message(muse, { project: 'secret-repo', body: 'x' }))).toBe('PROJECT_NOT_FOUND');
    expect(fake.calls.length).toBe(before);
  });

  it('takes only a job of the named reachable project', async () => {
    const { fake, service, muse } = setup();
    expect(await code(service.jobTake(muse, { project: 'oakhaven', id: 4242 }))).toBe('INVALID_ARGUMENT');
    expect(fake.last('job_take')).toBeUndefined();
  });

  it('updates only the caller\'s own open jobs in reachable projects', async () => {
    const { fake, service, muse } = setup();
    expect(await code(service.jobUpdate(muse, { id: 99, action: 'progress', note: 'x' }))).toBe('PERMISSION_DENIED');
    expect(await code(service.jobUpdate(muse, { id: 4242, action: 'release' }))).toBe('PERMISSION_DENIED');
    expect(await code(service.jobUpdate(muse, { id: 11, action: 'done' }))).toBe('INVALID_ARGUMENT');
    expect(fake.last('job_update')).toBeUndefined();
  });

  it('rejects a malformed message recipient and an empty claim list', async () => {
    const { service, muse } = setup();
    expect(await code(service.message(muse, { project: 'oakhaven', body: 'x', to: 'not an id' }))).toBe('INVALID_ARGUMENT');
    expect(await code(service.postTask(muse, { project: 'oakhaven', task: 't', claims: [] }))).toBe('INVALID_ARGUMENT');
    expect(await code(service.claim(muse, { project: 'oakhaven', claims: [{ path: '../x', kind: 'file' }] }))).toBe('INVALID_ARGUMENT');
  });
});

describe('AgentcoordBoardService output allowlist', () => {
  it('never passes on checkouts, worker keys, message payloads, roles or decisions', async () => {
    const { service, muse } = setup();
    const outputs = [
      await service.board(muse, { project: 'oakhaven', includeHistory: true }),
      await service.postTask(muse, { project: 'oakhaven', task: 't', claims: [{ path: 'src/a.ts', kind: 'file' }] }),
      await service.attention(muse, {}),
      await service.read(muse, { id: 5 }),
      await service.projectShow(muse, { project: 'oakhaven', includeDone: true }),
      await service.myJobs(muse),
    ];
    const text = JSON.stringify(outputs);
    for (const hidden of ['/home/chieh', 'checkout', 'worker_key', 'secret', 'payload', 'internal-role', 'internal decision', 'audience', 'updated_by']) {
      expect(text, hidden).not.toContain(hidden);
    }
  });

  it('shows only this project\'s own claims, and only reachable jobs', async () => {
    const { service, muse } = setup();
    const view = await service.board(muse, { project: 'oakhaven' });
    expect(view['mine']).toEqual([expect.objectContaining({ project: 'oakhaven', path: 'src/a.ts' })]);
    expect(view['stale']).toBeUndefined();
    const jobs = await service.myJobs(muse);
    expect((jobs['jobs'] as Array<{ id: number }>).map((job) => job.id)).toEqual([11]);
    const plan = await service.projectShow(muse, { project: 'oakhaven' });
    expect((plan['jobs'] as Array<{ id: number }>).map((job) => job.id)).toEqual([11]);
    expect(plan['done_count']).toBe(1);
  });
});

describe('AgentcoordBoardService errors and limits', () => {
  it('surfaces a routing refusal from the service as PERMISSION_DENIED with its message', async () => {
    const { fake, service, muse } = setup();
    fake.replies.set(
      'job_take',
      new AgentcoordRemoteError(403, 'missing_permission', 'agent ext/muse (muse) may only take code-simple work; this is code work', undefined, {}),
    );
    const error = (await service.jobTake(muse, { project: 'oakhaven', id: 11 }).catch((e: unknown) => e)) as OrchestratorError;
    expect(error.code).toBe('PERMISSION_DENIED');
    expect(error.message).toContain('may only take code-simple work');
  });

  it('turns a claim conflict into BOARD_CLAIM_CONFLICT with allowlisted conflict rows', async () => {
    const { fake, service, muse } = setup();
    fake.replies.set(
      'file_claim',
      new AgentcoordRemoteError(422, 'conflict', 'file claim conflicts with: src/a.ts by katie/x#w', 'message the owner', {
        type: 'conflict',
        conflicts: [{ requested: 'src/a.ts', path: 'src/a.ts', kind: 'file', holder: 'katie/x#w', task: 't', checkout: '/home/chieh/x' }],
      }),
    );
    const error = (await service
      .postTask(muse, { project: 'oakhaven', task: 't', claims: [{ path: 'src/a.ts', kind: 'file' }] })
      .catch((e: unknown) => e)) as OrchestratorError;
    expect(error.code).toBe('BOARD_CLAIM_CONFLICT');
    expect(error.hint).toBe('message the owner');
    expect(JSON.stringify(error.details)).toContain('katie/x#w');
    expect(JSON.stringify(error.details)).not.toContain('/home/chieh');
  });

  it('reports a refused server credential without blaming the caller', async () => {
    const { fake, service, muse } = setup();
    fake.replies.set('attention', new AgentcoordRemoteError(401, 'unauthenticated', 'unknown or revoked token', undefined, {}));
    expect(await code(service.attention(muse, {}))).toBe('BOARD_UNAVAILABLE');
  });

  it('rate-limits writes per identity', async () => {
    const { service, muse } = setup({ writesPerMinute: 2 });
    await service.heartbeat(muse, {});
    await service.heartbeat(muse, {});
    expect(await code(service.heartbeat(muse, {}))).toBe('RATE_LIMITED');
  });
});
