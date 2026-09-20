import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApplication, type Application } from '../../../src/app.js';
import { createNullLogger } from '../../../src/logging/logger.js';
import { createHttpApp, startHttpServer, type HttpServerHandle } from '../../../src/server/http.js';

/**
 * End-to-end over the real Streamable HTTP wire protocol.
 *
 * Deliberately NOT mocking the transport: the point is to prove that a remote
 * MCP client can initialize, list tools and call them, which is exactly what
 * Claude on Android will do.
 */

const TOKEN = 'integration-test-token-0123456789abcdef';
let dir: string;
let app: Application;
let handle: HttpServerHandle;
let endpoint: string;

async function rpc(method: string, params?: unknown, id: number | string = 1): Promise<any> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  // A modern exchange may answer as a single JSON body or as an SSE stream.
  if (text.startsWith('event:') || text.includes('\ndata: ')) {
    const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
    return JSON.parse(dataLine!.slice(6));
  }
  return JSON.parse(text);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-e2e-'));
  mkdirSync(join(dir, 'projects', 'demo-app'), { recursive: true });
  writeFileSync(join(dir, 'projects', 'demo-app', 'package.json'), JSON.stringify({ name: 'demo-app' }));
  writeFileSync(join(dir, 'projects', 'demo-app', 'README.md'), '# demo');

  writeFileSync(
    join(dir, 'orchestrator.yaml'),
    [
      'server:',
      '  host: 127.0.0.1',
      '  port: 0',
      '  auth:',
      '    mode: bearer',
      '    tokenEnvVars: [TEST_MCP_TOKEN]',
      'database:',
      `  path: ${join(dir, 'test.sqlite')}`,
      'projects:',
      '  roots:',
      `    - ${join(dir, 'projects')}`,
      'memory:',
      '  enabled: false',
      '  provider: none',
      'tailscale:',
      '  enabled: true',
      '',
    ].join('\n'),
  );

  app = await buildApplication({
    configPath: join(dir, 'orchestrator.yaml'),
    cwd: dir,
    env: { TEST_MCP_TOKEN: TOKEN },
    logger: createNullLogger(),
  });

  const { app: expressApp } = createHttpApp(app.services, {
    isReady: async () => ({ ready: true }),
    env: { TEST_MCP_TOKEN: TOKEN },
  });
  handle = await startHttpServer(expressApp, '127.0.0.1', 0, createNullLogger());
  endpoint = `http://127.0.0.1:${handle.port}/mcp`;
}, 60_000);

afterAll(async () => {
  await handle?.close();
  await app?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('operational endpoints', () => {
  it('serves /healthz and /readyz without authentication', async () => {
    const health = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
    expect(health.status).toBe(200);
    const ready = await fetch(`http://127.0.0.1:${handle.port}/readyz`);
    expect(ready.status).toBe(200);
  });

  it('does not leak internal detail from health endpoints', async () => {
    const body = await (await fetch(`http://127.0.0.1:${handle.port}/healthz`)).text();
    expect(body).toBe(JSON.stringify({ status: 'ok' }));
  });
});

describe('authentication', () => {
  it('rejects an MCP request with no token', async () => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(response.status).toBe(401);
  });

  it('rejects an MCP request with a wrong token', async () => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer wrong-token-wrong-token-wrong-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(response.status).toBe(401);
  });
});

describe('MCP protocol', () => {
  it('completes initialize and advertises server instructions', async () => {
    const result = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'integration-test', version: '1.0.0' },
    });
    expect(result.result.serverInfo.name).toBe('claude-mcp-orchestrator');
    expect(result.result.instructions).toContain('get_environment_context');
  });

  it('lists every high-level tool and NO primitive machine-control tool', async () => {
    const result = await rpc('tools/list', {}, 2);
    const names: string[] = result.result.tools.map((tool: { name: string }) => tool.name);

    for (const expected of [
      'get_environment_context',
      'list_context_capabilities',
      'list_computers',
      'get_computer',
      'list_projects',
      'find_project',
      'get_project_context',
      'recall_context',
      'start_work_session',
      'continue_work_session',
      'send_work_session_instruction',
      'get_work_session_status',
      'get_work_session_result',
      'respond_to_work_session',
      'cancel_work_session',
      'get_recent_activity',
    ]) {
      expect(names).toContain(expected);
    }

    // The security boundary, asserted as a test rather than a comment.
    for (const forbidden of ['run_shell', 'execute_bash', 'write_any_file', 'read_any_file', 'execute_python', 'sudo']) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe('context and discovery tools', () => {
  it('returns real environment context', async () => {
    const result = await rpc('tools/call', { name: 'get_environment_context', arguments: {} }, 3);
    expect(result.result.isError).toBeFalsy();
    const text: string = result.result.content[0].text;
    expect(text.length).toBeGreaterThan(0);
  });

  it('describes registered context capabilities', async () => {
    const result = await rpc('tools/call', { name: 'list_context_capabilities', arguments: {} }, 4);
    const ids = result.result.structuredContent.capabilities.map((c: { id: string }) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['computers', 'projects', 'workSessions', 'systemStatus']));
  });

  it('finds the fixture project by name', async () => {
    const result = await rpc('tools/call', { name: 'find_project', arguments: { query: 'demo-app' } }, 5);
    expect(result.result.isError).toBeFalsy();
    expect(result.result.structuredContent.path).toContain('demo-app');
  });

  it('returns a structured PROJECT_NOT_FOUND rather than inventing a project', async () => {
    const result = await rpc('tools/call', { name: 'find_project', arguments: { query: 'nonexistent-xyz-123' } }, 6);
    expect(result.result.isError).toBe(true);
    expect(result.result.structuredContent.code).toBe('PROJECT_NOT_FOUND');
  });

  it('reports memory as unavailable rather than failing opaquely', async () => {
    const result = await rpc('tools/call', { name: 'recall_context', arguments: { query: 'anything' } }, 7);
    expect(result.result.isError).toBe(true);
    expect(result.result.structuredContent.code).toBe('MEMORY_UNAVAILABLE');
  });
});

describe('work session tools', () => {
  it('returns a structured error when there is no session to report on', async () => {
    const result = await rpc('tools/call', { name: 'get_work_session_status', arguments: {} }, 8);
    expect(result.result.isError).toBe(true);
    expect(result.result.structuredContent.code).toBe('SESSION_NOT_FOUND');
  });

  it('reports no recorded activity on a fresh install', async () => {
    const result = await rpc('tools/call', { name: 'get_recent_activity', arguments: {} }, 9);
    expect(result.result.isError).toBeFalsy();
    expect(result.result.content[0].text).toContain('no recorded work');
  });
});

describe('responsiveness', () => {
  // The voice front end makes these calls on nearly every turn, so their
  // latency is a user-facing feature rather than an implementation detail.
  it('answers list_context_capabilities fast on repeat calls', async () => {
    await rpc('tools/call', { name: 'list_context_capabilities', arguments: {} }, 20);
    const started = Date.now();
    for (let i = 0; i < 5; i += 1) {
      await rpc('tools/call', { name: 'list_context_capabilities', arguments: {} }, 21 + i);
    }
    const perCall = (Date.now() - started) / 5;
    expect(perCall).toBeLessThan(150);
  });

  it('answers the default environment context fast', async () => {
    await rpc('tools/call', { name: 'get_environment_context', arguments: {} }, 30);
    const started = Date.now();
    await rpc('tools/call', { name: 'get_environment_context', arguments: {} }, 31);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('HTTP hardening', () => {
  it('rejects a browser request from a disallowed origin', async () => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${TOKEN}`,
        origin: 'https://evil.example.com',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'initialize', params: {} }),
    });
    expect(response.status).toBe(403);
  });

  it('rejects a body larger than the configured limit', async () => {
    const huge = 'x'.repeat(2 * 1024 * 1024);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 98, method: 'initialize', params: { pad: huge } }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).not.toBe(200);
  });

  // An auth mode that cannot actually authenticate must refuse to start rather
  // than fall through to serving unauthenticated traffic.
  it('refuses oauth mode without an admin password', () => {
    const unsafe = {
      ...app.services,
      config: {
        ...app.services.config,
        server: {
          ...app.services.config.server,
          auth: {
            ...app.services.config.server.auth,
            mode: 'oauth' as const,
            resourceUrl: 'https://mcp.test.example',
          },
        },
      },
    };
    expect(() =>
      createHttpApp(unsafe, { isReady: async () => ({ ready: true }), env: {} }),
    ).toThrow(/ADMIN_PASSWORD/);
  });
});
