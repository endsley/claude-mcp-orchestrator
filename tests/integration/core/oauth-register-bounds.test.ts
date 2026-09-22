import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApplication, type Application } from '../../../src/app.js';
import { createNullLogger } from '../../../src/logging/logger.js';
import { createHttpApp, startHttpServer, type HttpServerHandle } from '../../../src/server/http.js';

/**
 * /oauth/register is unauthenticated by design (RFC 7591 public clients) and
 * reachable by anyone who can reach the tunnel. A registered client is a
 * PERMANENT row - tokens expire, clients do not - so an unbounded caller could
 * grow the database until the disk was gone.
 */

const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';
const REGISTRATION_LIMIT = 30;

let dir: string;
let app: Application;
let handle: HttpServerHandle;
let base: string;

async function register(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'oauth-bounds-'));
  writeFileSync(
    join(dir, 'orchestrator.yaml'),
    [
      'server:',
      '  host: 127.0.0.1',
      '  port: 0',
      '  auth:',
      '    mode: oauth',
      '    resourceUrl: https://mcp.test.example',
      '    scopesSupported: [mcp]',
      'database:',
      `  path: ${join(dir, 'bounds.sqlite')}`,
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

describe('dynamic client registration bounds', () => {
  it('rejects a registration stuffed with redirect_uris', async () => {
    const many = Array.from({ length: 50 }, (_, index) => `https://example.com/cb/${index}`);
    const res = await register({ client_name: 'greedy', redirect_uris: many });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_redirect_uri');
  });

  it('serves normal registrations, then throttles a flood', async () => {
    // The first one must work: throttling legitimate single-user setup would
    // be a worse bug than the one being fixed.
    const first = await register({ client_name: 'Claude', redirect_uris: [REDIRECT_URI] });
    expect(first.status).toBe(201);

    let throttled: Response | undefined;
    for (let attempt = 0; attempt < REGISTRATION_LIMIT + 2; attempt += 1) {
      const res = await register({ client_name: `flood-${attempt}`, redirect_uris: [REDIRECT_URI] });
      if (res.status === 429) { throttled = res; break; }
      await res.json();
    }

    expect(throttled, 'a flood should eventually be refused').toBeDefined();
    expect(throttled!.status).toBe(429);
    expect(((await throttled!.json()) as { error: string }).error).toBe('too_many_requests');
  }, 30_000);
});
