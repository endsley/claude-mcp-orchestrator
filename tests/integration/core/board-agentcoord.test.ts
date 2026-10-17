import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApplication, type Application } from '../../../src/app.js';
import { createNullLogger } from '../../../src/logging/logger.js';
import { BoardKeyStore } from '../../../src/security/board-keys.js';
import { OAuthStore } from '../../../src/security/oauth/store.js';
import { BOARD_TOOL_NAMES } from '../../../src/security/scopes.js';
import { createHttpApp, startHttpServer, type HttpServerHandle } from '../../../src/server/http.js';
import { FakeAgentcoord } from '../../fakes/fake-agentcoord.js';

/**
 * The agentcoord board backend over the real HTTP server, in the production
 * auth mode (oauth), with a fake agentcoord transport: the REST front door
 * and MCP share auth, scope checks, validation, identity and handlers.
 */

const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const issuer = 'https://mcp.test.example';
const MUSE_CREDENTIAL = 'agentcoord-agent-credential-muse';
const REMOTE_CREDENTIAL = 'agentcoord-agent-credential-remote';

let dir: string;
let app: Application;
let handle: HttpServerHandle;
let base: string;
let fake: FakeAgentcoord;
let museKey: string;
let unmappedKey: string;
let oauth: OAuthStore;

async function rest(path: string, token: string | undefined, body?: unknown, init: RequestInit = {}): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    ...init,
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json };
}

async function rpc(token: string, method: string, params?: unknown): Promise<any> {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params !== undefined ? { params } : {}) }),
  });
  const text = await response.text();
  if (!response.ok) return { httpStatus: response.status };
  if (text.startsWith('event:') || text.includes('\ndata: ')) {
    return JSON.parse(text.split('\n').find((line) => line.startsWith('data: '))!.slice(6));
  }
  return JSON.parse(text);
}

function oauthToken(scope: string, clientId?: string): { token: string; clientId: string } {
  const client = clientId ?? oauth.registerClient({ clientName: 'Remote', redirectUris: ['https://claude.ai/api/mcp/auth_callback'] }).clientId;
  const { token } = oauth.issueToken({ kind: 'access', clientId: client, audience: `${issuer}/mcp`, scope, ttlMs: 60_000 });
  return { token, clientId: client };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'board-agentcoord-'));
  writeFileSync(join(dir, 'muse.token'), `${MUSE_CREDENTIAL}\n`, { mode: 0o600 });
  writeFileSync(join(dir, 'remote.token'), REMOTE_CREDENTIAL, { mode: 0o600 });
  writeFileSync(
    join(dir, 'orchestrator.yaml'),
    [
      'server:',
      '  host: 127.0.0.1',
      '  port: 0',
      '  auth:',
      '    mode: oauth',
      `    resourceUrl: ${issuer}`,
      '    scopesSupported: [mcp, board]',
      'database:',
      `  path: ${join(dir, 'board.sqlite')}`,
      'memory:',
      '  enabled: false',
      '  provider: none',
      'board:',
      '  enabled: true',
      '  backend: agentcoord',
      '  agentcoord:',
      '    nodes: [{ name: eva, url: "http://127.0.0.1:9" }]',
      '    projects: [oakhaven]',
      '    identities:',
      '      boardKeys:',
      `        muse: { agent: ext/muse, tokenFile: ${join(dir, 'muse.token')}, engine: muse }`,
      '',
    ].join('\n'),
  );
  fake = new FakeAgentcoord({ [MUSE_CREDENTIAL]: 'ext/muse', [REMOTE_CREDENTIAL]: 'ext/remote' });
  app = await buildApplication({
    configPath: join(dir, 'orchestrator.yaml'),
    cwd: dir,
    env: { MCP_ORCHESTRATOR_ADMIN_PASSWORD: ADMIN_PASSWORD },
    logger: createNullLogger(),
    agentcoordTransport: fake,
  });
  const keys = new BoardKeyStore(app.db);
  museKey = keys.create('muse').key;
  unmappedKey = keys.create('helper-bot').key;
  oauth = new OAuthStore(app.db);
  const { app: expressApp } = createHttpApp(app.services, {
    isReady: async () => ({ ready: true }),
    env: { MCP_ORCHESTRATOR_ADMIN_PASSWORD: ADMIN_PASSWORD },
  });
  handle = await startHttpServer(expressApp, '127.0.0.1', 0, createNullLogger());
  base = `http://127.0.0.1:${handle.port}`;
}, 60_000);

afterAll(async () => {
  await handle?.close();
  await app?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  fake.calls.length = 0;
  fake.replies.clear();
});

describe('REST front door: authentication and scope', () => {
  it('refuses a request with no token (401, with the OAuth challenge)', async () => {
    const response = await fetch(`${base}/board/v1/coord_attention`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
    expect(await response.json()).toEqual({ ok: false, error: { type: 'AUTH_REQUIRED', message: 'unauthorized' } });
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses an unknown or revoked board key (401)', async () => {
    expect((await rest('/board/v1/coord_attention', 'mcpbk_not-a-real-key-000000000000000000000', {})).status).toBe(401);
  });

  it('refuses a token whose scope grants no board tools (403)', async () => {
    const { token } = oauthToken('admin');
    const { status, json } = await rest('/board/v1/coord_attention', token, {});
    expect(status).toBe(403);
    expect(json.error.type).toBe('PERMISSION_DENIED');
    expect(fake.calls).toHaveLength(0);
  });

  it('runs a board tool for a mapped board key', async () => {
    const { status, json } = await rest('/board/v1/coord_attention', museKey, {});
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.result.messages[0]).toMatchObject({ id: 5, body: 'hello' });
    expect(fake.last('attention')!.caller).toEqual({ token: MUSE_CREDENTIAL, session: 'ext-key-muse', engine: 'muse' });
  });

  it('refuses a board key with no agentcoord identity (fail closed, 403)', async () => {
    const { status, json } = await rest('/board/v1/coord_attention', unmappedKey, {});
    expect(status).toBe(403);
    expect(json.error.type).toBe('PERMISSION_DENIED');
    expect(json.error.message).toContain('helper-bot');
    expect(fake.calls).toHaveLength(0);
  });

  it('a board-scoped OAuth token works once its client_id is mapped, and not before', async () => {
    const { token, clientId } = oauthToken('board');
    expect((await rest('/board/v1/coord_my_jobs', token, {})).status).toBe(403);
    app.services.config.board.agentcoord.identities.oauthClients[clientId] = { agent: 'ext/remote', tokenFile: join(dir, 'remote.token') };
    try {
      const { status } = await rest('/board/v1/coord_my_jobs', token, {});
      expect(status).toBe(200);
      expect(fake.last('my_jobs')!.caller).toEqual({ token: REMOTE_CREDENTIAL, session: `ext-oauth-${clientId}` });
    } finally {
      delete app.services.config.board.agentcoord.identities.oauthClients[clientId];
    }
  });

  it('a full-scope OAuth token reaches the tool but is still refused without an identity', async () => {
    const { token } = oauthToken('mcp');
    const { status, json } = await rest('/board/v1/coord_attention', token, {});
    expect(status).toBe(403);
    expect(json.error.message).toContain('OAuth client');
  });

  it('404s an unknown tool, and does not expose non-board tools', async () => {
    expect((await rest('/board/v1/start_work_session', museKey, { instruction: 'x' })).status).toBe(404);
    expect((await rest('/board/v1/nope', museKey, {})).status).toBe(404);
  });

  it('accepts POST only', async () => {
    const response = await fetch(`${base}/board/v1/coord_attention`, { headers: { authorization: `Bearer ${museKey}` } });
    expect(response.status).toBe(405);
  });
});

describe('REST front door: validation and envelope', () => {
  it('validates the body with the tool schema (400, nothing sent)', async () => {
    const missing = await rest('/board/v1/post_code_task', museKey, { project: 'oakhaven' });
    expect(missing.status).toBe(400);
    expect(missing.json.error.type).toBe('INVALID_ARGUMENT');
    expect(missing.json.error.message).toContain('task');
    const badProject = await rest('/board/v1/code_coordination_board', museKey, { project: '../etc' });
    expect(badProject.status).toBe(400);
    const badAction = await rest('/board/v1/coord_job_update', museKey, { id: 11, action: 'drop' });
    expect(badAction.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });

  it('wants a JSON object body', async () => {
    expect((await rest('/board/v1/coord_ack', museKey, [1, 2])).status).toBe(400);
    expect((await rest('/board/v1/coord_ack', museKey, 'ids=1', { headers: { 'content-type': 'text/plain', authorization: `Bearer ${museKey}` } })).status).toBe(400);
  });

  it('refuses an oversized body', async () => {
    const { status } = await rest('/board/v1/message_code_agents', museKey, { project: 'oakhaven', body: 'x'.repeat(70 * 1024) });
    expect(status).toBe(413);
  });

  it('maps service errors to status and a sanitized envelope', async () => {
    const notAllowed = await rest('/board/v1/code_coordination_board', museKey, { project: 'vessence' });
    expect(notAllowed.status).toBe(404);
    expect(notAllowed.json).toMatchObject({ ok: false, error: { type: 'PROJECT_NOT_FOUND' } });

    fake.replies.set('attention', new Error('connection string postgres://user:pw@host/db'));
    const internal = await rest('/board/v1/coord_attention', museKey, {});
    expect(internal.status).toBe(500);
    expect(internal.json).toEqual({ ok: false, error: { type: 'INTERNAL', message: 'internal error' } });
  });

  it('ignores identity-shaped arguments: the caller is the principal', async () => {
    const { status, json } = await rest('/board/v1/post_code_task', museKey, {
      project: 'oakhaven',
      task: 'fix x',
      claims: [{ path: 'src/a.ts' }],
      agent: 'katie/claude',
      session: 'other',
      worker: 'other',
      token: 'stolen',
      checkout: '/etc',
    });
    expect(status).toBe(200);
    const call = fake.last('file_claim')!;
    expect(call.caller).toEqual({ token: MUSE_CREDENTIAL, session: 'ext-key-muse', engine: 'muse' });
    expect(call.payload).toEqual({ project: 'oakhaven', task: 'fix x', replace: true, claims: [{ path: 'src/a.ts', kind: 'file' }] });
    expect(JSON.stringify(json)).not.toContain('/home/chieh');
  });
});

describe('MCP with the agentcoord backend', () => {
  it('a board key sees exactly the board tools, coord_* included', async () => {
    const result = await rpc(museKey, 'tools/list', {});
    const names = (result.result?.tools ?? []).map((tool: { name: string }) => tool.name).sort();
    expect(names).toEqual([...BOARD_TOOL_NAMES].sort());
  });

  it('runs the same handler as REST, with the identity from the credential', async () => {
    const result = await rpc(museKey, 'tools/call', {
      name: 'message_code_agents',
      arguments: { project: 'oakhaven', body: 'hello', to: 'katie/claude-ui', agent: 'owner' },
    });
    expect(result.result.isError).toBeFalsy();
    expect(fake.last('send')!.caller).toEqual({ token: MUSE_CREDENTIAL, session: 'ext-key-muse', engine: 'muse' });
    expect(fake.last('send')!.payload).toMatchObject({ to: ['katie/claude-ui'] });
  });

  it('surfaces a server routing refusal clearly', async () => {
    const { AgentcoordRemoteError } = await import('../../../src/services/board/agentcoord-client.js');
    fake.replies.set(
      'job_take',
      new AgentcoordRemoteError(403, 'missing_permission', 'agent ext/muse (muse) may only take code-simple work; this is code work', undefined, {}),
    );
    const viaMcp = await rpc(museKey, 'tools/call', { name: 'coord_job_take', arguments: { project: 'oakhaven', id: 11 } });
    expect(viaMcp.result.isError).toBe(true);
    expect(viaMcp.result.content[0].text).toContain('may only take code-simple work');
    const viaRest = await rest('/board/v1/coord_job_take', museKey, { project: 'oakhaven', id: 11 });
    expect(viaRest.status).toBe(403);
    expect(viaRest.json.error.message).toContain('may only take code-simple work');
  });
});
