import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApplication, type Application } from '../../../src/app.js';
import { createNullLogger } from '../../../src/logging/logger.js';
import { BoardKeyStore } from '../../../src/security/board-keys.js';
import { OAuthStore } from '../../../src/security/oauth/store.js';
import { BOARD_TOOL_NAMES } from '../../../src/security/scopes.js';
import { createHttpApp, startHttpServer, type HttpServerHandle } from '../../../src/server/http.js';
import { FakeBoardClient } from '../../fakes/fake-board-client.js';

/**
 * Outside-agent access to the coordination board, over the real HTTP + MCP
 * wire, in the production auth mode (oauth) with a fake board backend.
 *
 * The properties under test are the security ones: a board credential sees
 * and can call ONLY board tools, the full scope is unchanged, an unknown
 * scope sees nothing, and every board write carries the authenticated
 * identity no matter what the tool arguments say.
 */

const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';
const issuer = 'https://mcp.test.example';

let dir: string;
let app: Application;
let handle: HttpServerHandle;
let base: string;
let fake: FakeBoardClient;
let keys: BoardKeyStore;

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier, 'ascii').digest('base64url') };
}

async function form(path: string, body: Record<string, string>): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    redirect: 'manual',
  });
}

async function rpc(token: string, method: string, params?: unknown): Promise<any> {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params !== undefined ? { params } : {}) }),
  });
  const text = await response.text();
  if (!response.ok) return { httpStatus: response.status };
  if (text.startsWith('event:') || text.includes('\ndata: ')) {
    const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
    return JSON.parse(dataLine!.slice(6));
  }
  return JSON.parse(text);
}

async function toolNames(token: string): Promise<string[]> {
  const result = await rpc(token, 'tools/list', {});
  return (result.result?.tools ?? []).map((tool: { name: string }) => tool.name).sort();
}

/** True when a tools/call did NOT run the tool. */
function refused(result: any): boolean {
  return result.error !== undefined || result.result?.isError === true || result.httpStatus !== undefined;
}

async function startAuthorize(clientName: string, scope?: string) {
  const reg = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: clientName, redirect_uris: [REDIRECT_URI] }),
  });
  const { client_id: clientId } = (await reg.json()) as { client_id: string };
  const { verifier, challenge } = pkce();
  const params: Record<string, string> = {
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 's',
    resource: `${issuer}/mcp`,
  };
  if (scope !== undefined) params['scope'] = scope;
  const page = await fetch(`${base}/oauth/authorize?${new URLSearchParams(params)}`, { redirect: 'manual' });
  const html = await page.text();
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1] ?? '';
  return { clientId, verifier, html, requestId, status: page.status };
}

/** Full flow; `chosen` is the scope radio the approver submits. */
async function oauthToken(clientName: string, scope: string | undefined, chosen: string | undefined) {
  const flow = await startAuthorize(clientName, scope);
  const consent = await form('/oauth/authorize', {
    request_id: flow.requestId,
    password: ADMIN_PASSWORD,
    approve: 'yes',
    ...(chosen !== undefined ? { scope: chosen } : {}),
  });
  const code = new URL(consent.headers.get('location')!).searchParams.get('code')!;
  const tokenRes = await form('/oauth/token', {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: flow.clientId,
    code_verifier: flow.verifier,
  });
  const tokens = (await tokenRes.json()) as { access_token: string; scope: string };
  return { accessToken: tokens.access_token, scope: tokens.scope, clientId: flow.clientId };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'board-access-'));
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
      '  nodes: [{ name: fake, url: "http://127.0.0.1:9" }]',
      `  tokenFile: ${join(dir, 'board_token')}`,
      '  projects:',
      '    demo-app: /srv/demo-app',
      '',
    ].join('\n'),
  );
  fake = new FakeBoardClient();
  app = await buildApplication({
    configPath: join(dir, 'orchestrator.yaml'),
    cwd: dir,
    env: { MCP_ORCHESTRATOR_ADMIN_PASSWORD: ADMIN_PASSWORD },
    logger: createNullLogger(),
    boardClient: fake,
  });
  keys = new BoardKeyStore(app.db);
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

describe('board token keys', () => {
  it('see exactly the board tools', async () => {
    const { key } = keys.create('lister');
    expect(await toolNames(key)).toEqual([...BOARD_TOOL_NAMES].sort());
  });

  it('cannot call start_work_session or any other non-board tool', async () => {
    const { key } = keys.create('caller');
    for (const name of ['start_work_session', 'list_computers', 'recall_context', 'get_environment_context']) {
      const result = await rpc(key, 'tools/call', { name, arguments: { instruction: 'rm -rf /' } });
      expect(refused(result), name).toBe(true);
    }
  });

  it('call board tools, and the write carries the key name whatever the arguments say', async () => {
    const { key } = keys.create('helper-bot');
    const result = await rpc(key, 'tools/call', {
      name: 'post_code_task',
      arguments: {
        project: 'demo-app',
        task: 'add tests',
        claims: [{ path: 'tests/test_x.py' }],
        // Spoofing attempts: none of these may reach the board.
        agent: 'owner',
        session_id: 'other-agent-session',
        project_root: '/etc',
      },
    });
    expect(refused(result)).toBe(false);
    // The caller never sees the host-side project root or cwd.
    expect(JSON.stringify(result.result)).not.toContain('/srv/demo-app');
    expect(result.result.structuredContent).toMatchObject({ agent: 'helper-bot', task: 'add tests' });
    expect(fake.lastPayload('post_task')).toMatchObject({
      agent: 'helper-bot',
      session_id: 'ext-key-helper-bot',
      project_root: '/srv/demo-app',
      claims: [['tests/test_x.py', 'file']],
    });

    const board = await rpc(key, 'tools/call', { name: 'code_coordination_board', arguments: { project: 'demo-app' } });
    expect(board.result.structuredContent.work_items.length).toBeGreaterThan(0);
    expect(JSON.stringify(board.result)).not.toContain('/srv/demo-app');

    await rpc(key, 'tools/call', { name: 'message_code_agents', arguments: { project: 'demo-app', body: 'hello', agent: 'owner' } });
    expect(fake.lastPayload('message')).toMatchObject({ agent: 'helper-bot', session_id: 'ext-key-helper-bot' });
  });

  it('stop working the moment they are revoked', async () => {
    const { key } = keys.create('short-lived');
    expect((await toolNames(key)).length).toBeGreaterThan(0);
    keys.revoke('short-lived');
    expect((await rpc(key, 'tools/list', {})).httpStatus).toBe(401);
  });

  it('an unknown board-prefixed token is refused, not treated as an OAuth token', async () => {
    expect((await rpc('mcpbk_not-a-real-key-0000000000000000000000', 'tools/list', {})).httpStatus).toBe(401);
  });
});

describe('OAuth scopes', () => {
  it('the consent page names the scope and offers board-only alongside full access', async () => {
    const flow = await startAuthorize('Phone', 'mcp');
    expect(flow.status).toBe(200);
    expect(flow.html).toContain('value="mcp" checked');
    expect(flow.html).toContain('value="board"');
    expect(flow.html).toContain('Full access');
    expect(flow.html).toContain('Coordination board only');
  });

  it('a board-scope request is offered board only, and cannot be widened by the form', async () => {
    const flow = await startAuthorize('Outside', 'board');
    expect(flow.html).toContain('value="board" checked');
    expect(flow.html).not.toContain('value="mcp"');
    const consent = await form('/oauth/authorize', {
      request_id: flow.requestId,
      password: ADMIN_PASSWORD,
      approve: 'yes',
      scope: 'mcp',
    });
    expect(consent.status).toBe(400);
    expect(consent.headers.get('location')).toBeNull();
  });

  it('a board-scoped OAuth token sees only board tools and is identified as oauth:<client_name>', async () => {
    const { accessToken, scope, clientId } = await oauthToken('Remote Agent', 'board', 'board');
    expect(scope).toBe('board');
    expect(await toolNames(accessToken)).toEqual([...BOARD_TOOL_NAMES].sort());
    expect(refused(await rpc(accessToken, 'tools/call', { name: 'start_work_session', arguments: { instruction: 'x' } }))).toBe(true);

    await rpc(accessToken, 'tools/call', { name: 'heartbeat_code_task', arguments: { agent: 'helper-bot' } });
    expect(fake.lastPayload('heartbeat')).toEqual({ session_id: `ext-oauth-${clientId}`, project: null });
    await rpc(accessToken, 'tools/call', { name: 'message_code_agents', arguments: { project: 'demo-app', body: 'hi' } });
    expect(fake.lastPayload('message')).toMatchObject({ agent: 'oauth:Remote Agent' });
  });

  it('the approver can narrow a full-access request to board only', async () => {
    const { accessToken, scope } = await oauthToken('Narrowed', 'mcp', 'board');
    expect(scope).toBe('board');
    expect(await toolNames(accessToken)).toEqual([...BOARD_TOOL_NAMES].sort());
  });

  it('the mcp scope still gets every tool, board tools included', async () => {
    const { accessToken, scope } = await oauthToken('Phone', undefined, undefined);
    expect(scope).toBe('mcp');
    const names = await toolNames(accessToken);
    expect(names).toContain('start_work_session');
    for (const board of BOARD_TOOL_NAMES) expect(names).toContain(board);
  });

  it('a token whose scope names nothing known sees no tools at all', async () => {
    const store = new OAuthStore(app.db);
    const client = store.registerClient({ clientName: 'Legacy', redirectUris: [REDIRECT_URI] });
    const { token } = store.issueToken({
      kind: 'access',
      clientId: client.clientId,
      audience: `${issuer}/mcp`,
      scope: 'admin',
      ttlMs: 60_000,
    });
    expect(await toolNames(token)).toEqual([]);
    expect(refused(await rpc(token, 'tools/call', { name: 'code_coordination_board', arguments: { project: 'demo-app' } }))).toBe(true);
  });
});
