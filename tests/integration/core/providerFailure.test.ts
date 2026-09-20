import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApplication, type Application } from '../../../src/app.js';
import { createNullLogger } from '../../../src/logging/logger.js';
import { createHttpApp, startHttpServer, type HttpServerHandle } from '../../../src/server/http.js';
import type { InitialContextProvider, InitialContextSection } from '../../../src/types/context.js';

/**
 * Acceptance criterion, proven end to end rather than only at the unit level:
 * get_environment_context must still return useful context when an optional
 * provider throws, hangs, returns garbage, or floods the budget.
 *
 * These providers are registered through the ordinary registry API, which also
 * demonstrates that adding a provider needs no change to the assembler.
 */

function section(providerId: string, lines: string[]): InitialContextSection {
  return {
    providerId,
    title: providerId.toUpperCase(),
    lines,
    generatedAt: new Date().toISOString(),
  };
}

class ThrowingProvider implements InitialContextProvider {
  readonly id = 'brokenThrows';
  readonly description = 'Always throws.';
  readonly priority = 85;
  readonly defaultEnabled = true;
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async getContext(): Promise<InitialContextSection> {
    throw new Error('provider exploded');
  }
}

class HangingProvider implements InitialContextProvider {
  readonly id = 'brokenHangs';
  readonly description = 'Never resolves.';
  readonly priority = 84;
  readonly defaultEnabled = true;
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async getContext(): Promise<InitialContextSection> {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    return section(this.id, ['never']);
  }
}

class OversizedProvider implements InitialContextProvider {
  readonly id = 'brokenOversized';
  readonly description = 'Returns far more than the budget.';
  readonly priority = 10;
  readonly defaultEnabled = true;
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async getContext(): Promise<InitialContextSection> {
    return section(this.id, Array.from({ length: 5000 }, (_, i) => `noise line ${i} ${'x'.repeat(200)}`));
  }
}

class MalformedProvider implements InitialContextProvider {
  readonly id = 'brokenMalformed';
  readonly description = 'Returns structurally invalid output.';
  readonly priority = 83;
  readonly defaultEnabled = true;
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async getContext(): Promise<InitialContextSection> {
    // Deliberately violates the contract: lines is not an array of strings.
    return { providerId: this.id, title: 'BAD', lines: null as never, generatedAt: 'not-a-date' };
  }
}

class AvailabilityThrowsProvider implements InitialContextProvider {
  readonly id = 'brokenAvailability';
  readonly description = 'isAvailable rejects.';
  readonly priority = 82;
  readonly defaultEnabled = true;
  async isAvailable(): Promise<boolean> {
    throw new Error('cannot determine availability');
  }
  async getContext(): Promise<InitialContextSection> {
    return section(this.id, ['should not appear']);
  }
}

class HealthyProvider implements InitialContextProvider {
  readonly id = 'healthyMarker';
  readonly description = 'A known-good provider.';
  readonly priority = 99;
  readonly defaultEnabled = true;
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async getContext(): Promise<InitialContextSection> {
    return section(this.id, ['HEALTHY-MARKER-PRESENT']);
  }
}

let dir: string;
let app: Application;
let handle: HttpServerHandle;
let endpoint: string;
const TOKEN = 'provider-failure-test-token-0123456789';

async function callTool(name: string, args: Record<string, unknown> = {}, id = 1): Promise<any> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await response.text();
  if (text.includes('\ndata: ')) {
    return JSON.parse(text.split('\n').find((line) => line.startsWith('data: '))!.slice(6));
  }
  return JSON.parse(text);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'provider-fail-'));
  writeFileSync(
    join(dir, 'orchestrator.yaml'),
    [
      'server:',
      '  host: 127.0.0.1',
      '  port: 0',
      '  auth:',
      '    mode: bearer',
      '    tokenEnvVars: [PF_TOKEN]',
      'database:',
      `  path: ${join(dir, 'pf.sqlite')}`,
      'memory:',
      '  enabled: false',
      '  provider: none',
      'initialContext:',
      '  maxTokens: 800',
      '  defaultTimeoutMs: 300',
      'contextProfiles:',
      '  default:',
      '    providers:',
      '      - healthyMarker',
      '      - brokenThrows',
      '      - brokenHangs',
      '      - brokenMalformed',
      '      - brokenAvailability',
      '      - brokenOversized',
      '      - computers',
      '',
    ].join('\n'),
  );

  app = await buildApplication({
    configPath: join(dir, 'orchestrator.yaml'),
    cwd: dir,
    env: { PF_TOKEN: TOKEN },
    logger: createNullLogger(),
  });

  // Registration alone is enough: the assembler is never modified.
  app.services.contextRegistry.register(new HealthyProvider());
  app.services.contextRegistry.register(new ThrowingProvider());
  app.services.contextRegistry.register(new HangingProvider());
  app.services.contextRegistry.register(new OversizedProvider());
  app.services.contextRegistry.register(new MalformedProvider());
  app.services.contextRegistry.register(new AvailabilityThrowsProvider());

  const { app: expressApp } = createHttpApp(app.services, {
    isReady: async () => ({ ready: true }),
    env: { PF_TOKEN: TOKEN },
  });
  handle = await startHttpServer(expressApp, '127.0.0.1', 0, createNullLogger());
  endpoint = `http://127.0.0.1:${handle.port}/mcp`;
}, 60_000);

afterAll(async () => {
  await handle?.close();
  await app?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('one broken provider does not break environment context', () => {
  it('still returns the healthy provider despite five broken ones', async () => {
    const result = await callTool('get_environment_context', {}, 1);
    expect(result.result.isError).toBeFalsy();
    expect(result.result.content[0].text).toContain('HEALTHY-MARKER-PRESENT');
  });

  it('returns promptly rather than waiting on the hanging provider', async () => {
    const started = Date.now();
    await callTool('get_environment_context', {}, 2);
    // The hanging provider sleeps 60s. With initialContext.defaultTimeoutMs of
    // 300ms the whole call must finish in well under a second; before that
    // config value was actually honoured this took ~2s.
    expect(Date.now() - started).toBeLessThan(1500);
  }, 20_000);

  it('reports warnings naming the providers that failed', async () => {
    const result = await callTool('get_environment_context', {}, 3);
    const warnings = JSON.stringify(result.result.structuredContent.warnings);
    expect(warnings).toContain('brokenThrows');
    expect(warnings).toContain('brokenHangs');
  });

  it('keeps the payload inside its token budget despite the oversized provider', async () => {
    const result = await callTool('get_environment_context', {}, 4);
    expect(result.result.structuredContent.estimatedTokens).toBeLessThanOrEqual(800);
  });

  it('excludes a provider whose availability check throws', async () => {
    const result = await callTool('get_environment_context', {}, 5);
    expect(result.result.content[0].text).not.toContain('should not appear');
  });

  it('still lists capabilities, marking broken providers', async () => {
    const result = await callTool('list_context_capabilities', {}, 6);
    expect(result.result.isError).toBeFalsy();
    const capabilities = result.result.structuredContent.capabilities as Array<{ id: string; available: boolean }>;
    expect(capabilities.find((c) => c.id === 'brokenAvailability')?.available).toBe(false);
    expect(capabilities.find((c) => c.id === 'healthyMarker')?.available).toBe(true);
  });

  it('keeps unrelated tools working while providers are broken', async () => {
    const result = await callTool('get_recent_activity', {}, 7);
    expect(result.result.isError).toBeFalsy();
  });
});
