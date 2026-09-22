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
