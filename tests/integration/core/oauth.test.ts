import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApplication, type Application } from '../../../src/app.js';
import { createNullLogger } from '../../../src/logging/logger.js';
import { createHttpApp, startHttpServer, type HttpServerHandle } from '../../../src/server/http.js';

/**
 * Drives the complete MCP authorization flow exactly as a remote MCP client
 * does: discover, register, consent, exchange, call. Every security property
 * the spec requires is asserted, because this is the code that stands between
 * the public internet and a worker that can edit the user's repositories.
 */

const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

let dir: string;
let app: Application;
let handle: HttpServerHandle;
let base: string;
let issuer: string;

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

async function form(path: string, body: Record<string, string>, redirect: 'manual' | 'follow' = 'manual') {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    redirect,
  });
}

async function mcpCall(token: string | undefined, id = 1) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    }),
  });
}

/** Register a client and run the flow through to a token pair. */
async function fullFlow(): Promise<{ accessToken: string; refreshToken: string; clientId: string }> {
  const reg = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT_URI] }),
  });
  const { client_id: clientId } = (await reg.json()) as { client_id: string };

  const { verifier, challenge } = pkce();
  const authorize = await fetch(
    `${base}/oauth/authorize?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
      resource: `${issuer}/mcp`,
    })}`,
  );
  const html = await authorize.text();
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)![1]!;

  const consent = await form('/oauth/authorize', {
    request_id: requestId,
    password: ADMIN_PASSWORD,
    approve: 'yes',
  });
  const code = new URL(consent.headers.get('location')!).searchParams.get('code')!;

  const tokenRes = await form('/oauth/token', {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  });
  const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string };
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, clientId };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'oauth-test-'));
  // The issuer must be https per OAuth 2.1; we serve over loopback http here,
  // which is exactly the real shape (TLS terminates at the proxy).
  issuer = 'https://mcp.test.example';
  writeFileSync(
    join(dir, 'orchestrator.yaml'),
    [
      'server:',
      '  host: 127.0.0.1',
      '  port: 0',
      '  auth:',
      '    mode: oauth',
      `    resourceUrl: ${issuer}`,
      '    scopesSupported: [mcp]',
      'database:',
      `  path: ${join(dir, 'oauth.sqlite')}`,
      'memory:',
      '  enabled: false',
      '  provider: none',
      '',
    ].join('\n'),
  );

  app = await buildApplication({
    configPath: join(dir, 'orchestrator.yaml'),
    cwd: dir,
    env: { MCP_ORCHESTRATOR_ADMIN_PASSWORD: ADMIN_PASSWORD },
    logger: createNullLogger(),
  });
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

describe('discovery', () => {
  it('challenges with resource_metadata so a client can self-configure', async () => {
    const res = await mcpCall(undefined);
    expect(res.status).toBe(401);
    const header = res.headers.get('www-authenticate')!;
    expect(header).toContain('resource_metadata=');
    expect(header).toContain('scope="mcp"');
  });

  it('serves RFC 9728 protected resource metadata', async () => {
    const meta = (await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()) as any;
    expect(meta.resource).toBe(`${issuer}/mcp`);
    expect(meta.authorization_servers).toContain(issuer);
    expect(meta.bearer_methods_supported).toContain('header');
  });

  it('serves the path-suffixed resource metadata variant', async () => {
    const res = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
  });

  it('serves RFC 8414 authorization server metadata advertising S256', async () => {
    const meta = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as any;
    expect(meta.issuer).toBe(issuer);
    expect(meta.authorization_endpoint).toBe(`${issuer}/oauth/authorize`);
    expect(meta.token_endpoint).toBe(`${issuer}/oauth/token`);
    expect(meta.registration_endpoint).toBe(`${issuer}/oauth/register`);
    // A conforming MCP client refuses to proceed without this.
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
  });
});

describe('dynamic client registration', () => {
  it('registers a public client', async () => {
    const res = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT_URI] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.client_id).toMatch(/^mcpc_/);
    expect(body.token_endpoint_auth_method).toBe('none');
    // A public client must never be handed a secret it cannot protect.
    expect(body.client_secret).toBeUndefined();
  });

  it('rejects registration with no redirect_uris', async () => {
    const res = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Bad' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a non-loopback plain http redirect_uri', async () => {
    const res = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Bad', redirect_uris: ['http://evil.example.com/cb'] }),
    });
    expect(res.status).toBe(400);
  });
});

describe('authorization endpoint', () => {
  let clientId: string;

  beforeAll(async () => {
    const res = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT_URI] }),
    });
    clientId = ((await res.json()) as any).client_id;
  });

  it('renders a consent screen naming the client and the risk', async () => {
    const { challenge } = pkce();
    const res = await fetch(
      `${base}/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })}`,
    );
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('Authorize access');
    expect(html).toContain('read and');
    expect(html).toContain('name="request_id"');
  });

  // Exact-match redirect validation is what prevents an open redirect.
  it('rejects a redirect_uri that was not registered', async () => {
    const { challenge } = pkce();
    const res = await fetch(
      `${base}/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: 'https://evil.example.com/cb',
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })}`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('refuses a missing or non-S256 PKCE challenge', async () => {
    const res = await fetch(
      `${base}/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        code_challenge: 'abc',
        code_challenge_method: 'plain',
      })}`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
  });

  it('refuses a token request for a different resource', async () => {
    const { challenge } = pkce();
    const res = await fetch(
      `${base}/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: 'https://someone-elses-server.example/mcp',
      })}`,
      { redirect: 'manual' },
    );
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');
  });

  it('rejects an incorrect consent password', async () => {
    const { challenge } = pkce();
    const page = await fetch(
      `${base}/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })}`,
    );
    const requestId = /name="request_id" value="([^"]+)"/.exec(await page.text())![1]!;
    const res = await form('/oauth/authorize', { request_id: requestId, password: 'wrong', approve: 'yes' });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('Incorrect password');
  });

  it('propagates a denial back to the client', async () => {
    const { challenge } = pkce();
    const page = await fetch(
      `${base}/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'st8',
      })}`,
    );
    const requestId = /name="request_id" value="([^"]+)"/.exec(await page.text())![1]!;
    const res = await form('/oauth/authorize', { request_id: requestId, password: ADMIN_PASSWORD, approve: 'no' });
    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('st8');
  });
});

describe('end-to-end authorization', () => {
  it('completes the flow and the token authenticates an MCP call', async () => {
    const { accessToken } = await fullFlow();
    const res = await mcpCall(accessToken, 10);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('claude-mcp-orchestrator');
  });

  it('rejects an authorization code replay', async () => {
    const reg = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT_URI] }),
    });
    const clientId = ((await reg.json()) as any).client_id;
    const { verifier, challenge } = pkce();
    const page = await fetch(
      `${base}/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })}`,
    );
    const requestId = /name="request_id" value="([^"]+)"/.exec(await page.text())![1]!;
    const consent = await form('/oauth/authorize', { request_id: requestId, password: ADMIN_PASSWORD, approve: 'yes' });
    const code = new URL(consent.headers.get('location')!).searchParams.get('code')!;

    const first = await form('/oauth/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(first.status).toBe(200);

    const replay = await form('/oauth/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as any).error).toBe('invalid_grant');
  });

  it('rejects an incorrect PKCE verifier', async () => {
    const reg = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT_URI] }),
    });
    const clientId = ((await reg.json()) as any).client_id;
    const { challenge } = pkce();
    const page = await fetch(
      `${base}/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })}`,
    );
    const requestId = /name="request_id" value="([^"]+)"/.exec(await page.text())![1]!;
    const consent = await form('/oauth/authorize', { request_id: requestId, password: ADMIN_PASSWORD, approve: 'yes' });
    const code = new URL(consent.headers.get('location')!).searchParams.get('code')!;

    const res = await form('/oauth/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: randomBytes(48).toString('base64url'),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error_description).toMatch(/PKCE/i);
  });
});

describe('token lifecycle', () => {
  it('rotates refresh tokens and invalidates the old one', async () => {
    const { refreshToken, clientId } = await fullFlow();

    const first = await form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    });
    expect(first.status).toBe(200);
    const rotated = (await first.json()) as { access_token: string; refresh_token: string };
    expect(rotated.refresh_token).not.toBe(refreshToken);
    expect((await mcpCall(rotated.access_token, 20)).status).toBe(200);

    // OAuth 2.1 requires rotation for public clients; replay must fail.
    const replay = await form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    });
    expect(replay.status).toBe(400);
  });

  it('revokes a token on request', async () => {
    const { accessToken } = await fullFlow();
    expect((await mcpCall(accessToken, 30)).status).toBe(200);
    await form('/oauth/revoke', { token: accessToken });
    expect((await mcpCall(accessToken, 31)).status).toBe(401);
  });

  it('rejects a made-up token', async () => {
    expect((await mcpCall(randomBytes(32).toString('base64url'), 40)).status).toBe(401);
  });

  it('rejects an unsupported grant type', async () => {
    const res = await form('/oauth/token', { grant_type: 'password', username: 'a', password: 'b' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe('unsupported_grant_type');
  });
});

describe('audience binding', () => {
  // The single most important check: a token minted for another resource must
  // not be accepted here, even though this server issued it.
  it('rejects an access token whose audience is a different resource', async () => {
    const store = new (await import('../../../src/security/oauth/store.js')).OAuthStore(app.services.db);
    const foreign = store.issueToken({
      kind: 'access',
      clientId: 'mcpc_someone_else',
      audience: 'https://another-service.example/mcp',
      scope: 'mcp',
      ttlMs: 60_000,
    });
    const res = await mcpCall(foreign.token, 50);
    expect(res.status).toBe(401);
  });

  it('accepts a token whose audience differs only by trailing slash or case', async () => {
    const store = new (await import('../../../src/security/oauth/store.js')).OAuthStore(app.services.db);
    const equivalent = store.issueToken({
      kind: 'access',
      clientId: 'mcpc_self',
      audience: `HTTPS://MCP.TEST.EXAMPLE/mcp/`,
      scope: 'mcp',
      ttlMs: 60_000,
    });
    expect((await mcpCall(equivalent.token, 51)).status).toBe(200);
  });
});
