import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApplication, type Application } from '../../../src/app.js';
import { createNullLogger } from '../../../src/logging/logger.js';
import { createHttpApp, startHttpServer, type HttpServerHandle } from '../../../src/server/http.js';

/**
 * Single-use of refresh tokens and authorization codes is a security property
 * that had only ever been TRACED - asserted from reading a conditional UPDATE.
 * Reading is weaker evidence than an experiment here: rotateRefreshToken's
 * UPDATE carries no `AND revoked_at IS NULL` guard (unlike revokeToken right
 * below it) and relies entirely on the lookup inside its transaction. That is
 * sound while the store is synchronous and single-process, which is exactly
 * the kind of assumption that should fail loudly if someone changes it.
 *
 * These fire genuinely parallel requests at the real HTTP server and assert
 * that exactly one wins.
 */

const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';
const PARALLEL = 8;

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

/** Register, consent and exchange, returning a live code or token pair. */
async function authorizeToCode(): Promise<{ code: string; verifier: string; clientId: string }> {
  const reg = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Concurrency', redirect_uris: [REDIRECT_URI] }),
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
  const requestId = /name="request_id" value="([^"]+)"/.exec(await authorize.text())![1]!;
  const consent = await form('/oauth/authorize', { request_id: requestId, password: ADMIN_PASSWORD, approve: 'yes' });
  const code = new URL(consent.headers.get('location')!).searchParams.get('code')!;
  return { code, verifier, clientId };
}

async function freshRefreshToken(): Promise<{ refreshToken: string; clientId: string }> {
  const { code, verifier, clientId } = await authorizeToCode();
  const res = await form('/oauth/token', {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  });
  const tokens = (await res.json()) as { refresh_token: string };
  return { refreshToken: tokens.refresh_token, clientId };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'oauth-conc-'));
  issuer = 'https://mcp.test.example';
  writeFileSync(
    join(dir, 'orchestrator.yaml'),
    [
      'server:', '  host: 127.0.0.1', '  port: 0', '  auth:', '    mode: oauth',
      `    resourceUrl: ${issuer}`, '    scopesSupported: [mcp]',
      'database:', `  path: ${join(dir, 'conc.sqlite')}`,
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

describe('single-use under concurrency', () => {
  it('lets exactly one of many parallel refreshes win', async () => {
    const { refreshToken, clientId } = await freshRefreshToken();

    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        form('/oauth/token', { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }),
      ),
    );
    const statuses = responses.map((response) => response.status);
    const winners = statuses.filter((status) => status === 200);

    // A second winner would mean one refresh token minted two live sessions.
    expect(winners).toHaveLength(1);
    expect(statuses.filter((status) => status === 400)).toHaveLength(PARALLEL - 1);
  }, 30_000);

  it('lets exactly one of many parallel code exchanges win', async () => {
    const { code, verifier, clientId } = await authorizeToCode();

    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        form('/oauth/token', {
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          client_id: clientId,
          code_verifier: verifier,
        }),
      ),
    );
    const winners = responses.filter((response) => response.status === 200);

    expect(winners).toHaveLength(1);
  }, 30_000);

  it('does not mint two usable refresh tokens from one parallel burst', async () => {
    const { refreshToken, clientId } = await freshRefreshToken();

    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        form('/oauth/token', { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }),
      ),
    );
    const issued: string[] = [];
    for (const response of responses) {
      if (response.status !== 200) { await response.text(); continue; }
      issued.push(((await response.json()) as { refresh_token: string }).refresh_token);
    }

    expect(issued).toHaveLength(1);
    // And the one that was issued must itself still work exactly once.
    const reuse = await Promise.all(
      Array.from({ length: 4 }, () =>
        form('/oauth/token', { grant_type: 'refresh_token', refresh_token: issued[0]!, client_id: clientId }),
      ),
    );
    expect(reuse.filter((response) => response.status === 200)).toHaveLength(1);
  }, 30_000);
});
