import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, parseEnvFile } from '../../../src/config/load.js';
import { appConfigSchema, isLoopbackHost } from '../../../src/config/schema.js';
import { type OrchestratorError } from '../../../src/types/errors.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cfg-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(yaml: string): void {
  writeFileSync(join(dir, 'orchestrator.yaml'), yaml);
}

describe('isLoopbackHost', () => {
  it('recognises loopback addresses', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '127.5.5.5']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });
  // 0.0.0.0 is the classic way to publish something by accident.
  it('does NOT treat wildcard binds as loopback', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
    expect(isLoopbackHost('192.168.1.5')).toBe(false);
  });
});

describe('unsafe deployment refusal', () => {
  it('rejects a non-loopback bind with auth mode none', () => {
    const result = appConfigSchema.safeParse({ server: { host: '0.0.0.0', allowNonLoopbackBind: true } });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('auth.mode');
  });

  it('rejects a non-loopback bind without explicit acknowledgement', () => {
    const result = appConfigSchema.safeParse({
      server: { host: '10.0.0.5', auth: { mode: 'bearer' } },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('allowNonLoopbackBind');
  });

  it('accepts a non-loopback bind with bearer auth and acknowledgement', () => {
    const result = appConfigSchema.safeParse({
      server: { host: '10.0.0.5', auth: { mode: 'bearer' }, allowNonLoopbackBind: true },
    });
    expect(result.success).toBe(true);
  });

  it('accepts the default loopback configuration with no auth', () => {
    expect(appConfigSchema.safeParse({}).success).toBe(true);
  });

  it('requires a resourceUrl for oauth mode', () => {
    const result = appConfigSchema.safeParse({ server: { auth: { mode: 'oauth' } } });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('resourceUrl');
  });
});

describe('loadConfig', () => {
  it('falls back to defaults and warns when no file exists', () => {
    const loaded = loadConfig({ cwd: dir, env: {} });
    expect(loaded.sourcePath).toBeNull();
    expect(loaded.warnings.join(' ')).toMatch(/no config file/i);
    expect(loaded.config.server.host).toBe('127.0.0.1');
  });

  it('merges built-in context profiles so a fresh install is usable', () => {
    const loaded = loadConfig({ cwd: dir, env: {} });
    expect(Object.keys(loaded.config.contextProfiles)).toEqual(
      expect.arrayContaining(['default', 'coding', 'infrastructure', 'minimal']),
    );
  });

  it('lets operator profiles override built-ins of the same name', () => {
    writeConfig('contextProfiles:\n  default:\n    providers: [computers]\n');
    const loaded = loadConfig({ cwd: dir, env: {} });
    expect(loaded.config.contextProfiles['default']?.providers).toEqual(['computers']);
  });

  it('rejects malformed YAML with INVALID_CONFIG', () => {
    writeConfig('server:\n  port: [unclosed\n');
    try {
      loadConfig({ cwd: dir, env: {} });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as OrchestratorError).code).toBe('INVALID_CONFIG');
    }
  });

  it('rejects a YAML file that is not a mapping', () => {
    writeConfig('- just\n- a list\n');
    expect(() => loadConfig({ cwd: dir, env: {} })).toThrow(/must contain a YAML mapping/);
  });

  it('applies environment overrides', () => {
    const loaded = loadConfig({ cwd: dir, env: { MCP_ORCHESTRATOR_PORT: '9999', MCP_ORCHESTRATOR_LOG_LEVEL: 'debug' } });
    expect(loaded.config.server.port).toBe(9999);
    expect(loaded.config.logging.level).toBe('debug');
  });

  it('resolves relative paths to absolute ones', () => {
    writeConfig('database:\n  path: data/test.sqlite\n');
    const loaded = loadConfig({ cwd: dir, env: {} });
    expect(loaded.config.database.path).toBe(join(dir, 'data/test.sqlite'));
  });

  it('takes the Mem0 base URL from the environment when absent from YAML', () => {
    writeConfig('memory:\n  provider: mem0-http\n');
    const loaded = loadConfig({ cwd: dir, env: { MEM0_BASE_URL: 'https://mem0.example.test' } });
    expect(loaded.config.memory.baseUrl).toBe('https://mem0.example.test');
  });

  it('reads Mem0 settings from an envFile without them touching the YAML', () => {
    const envPath = join(dir, 'mem0.env');
    writeFileSync(envPath, 'MEM0_BASE_URL=https://from-file.example.test\nMEM0_API_KEY=secret-value\n');
    writeConfig(`memory:\n  provider: mem0-http\n  envFile: ${envPath}\n`);
    const env: NodeJS.ProcessEnv = {};
    const loaded = loadConfig({ cwd: dir, env });
    expect(loaded.config.memory.baseUrl).toBe('https://from-file.example.test');
    expect(env['MEM0_API_KEY']).toBe('secret-value');
  });

  it('does not let an envFile clobber an already-exported value', () => {
    const envPath = join(dir, 'mem0.env');
    writeFileSync(envPath, 'MEM0_BASE_URL=https://from-file.example.test\n');
    writeConfig(`memory:\n  provider: mem0-http\n  envFile: ${envPath}\n`);
    const loaded = loadConfig({ cwd: dir, env: { MEM0_BASE_URL: 'https://exported.example.test' } });
    expect(loaded.config.memory.baseUrl).toBe('https://exported.example.test');
  });
});

describe('parseEnvFile', () => {
  it('parses plain, quoted and exported assignments', () => {
    const parsed = parseEnvFile(['# comment', 'A=1', 'B="two"', "C='three'", 'export D=4', '', 'bad line'].join('\n'));
    expect(parsed).toEqual({ A: '1', B: 'two', C: 'three', D: '4' });
  });
  it('ignores keys that are not valid identifiers', () => {
    expect(parseEnvFile('9BAD=x\nGOOD=y')).toEqual({ GOOD: 'y' });
  });
});

/**
 * isLoopbackHost gates the refusal to run `auth.mode: none` off-host, which
 * schema.ts calls the single most important invariant in the file. It used to
 * accept anything beginning with "127.", so a DNS name that merely looked
 * like a loopback literal could switch that invariant off. The existing tests
 * covered exact loopbacks and wildcards and nothing in between.
 */
describe('isLoopbackHost boundary', () => {
  it.each(['127.0.0.1', '127.0.0.5', '127.1.2.3', 'localhost', '::1', '[::1]'])(
    'treats %s as loopback',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each([
    '127.0.0.1.evil.com',
    '127.evil.com',
    '127.0.0.1.nip.io',
    'localhost.evil.com',
  ])('does not treat the lookalike %s as loopback', (host) => {
    // These are DNS names. They can resolve anywhere, including off-host.
    expect(isLoopbackHost(host)).toBe(false);
  });

  it.each(['0.0.0.0', '::', '1.2.3.4', '10.0.0.1'])('does not treat %s as loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });

  it.each(['127.1', '127.0.0', '127.0.0.256', '127.0.0.01', '127.0.0.-1', ''])(
    'rejects the malformed %s rather than guessing',
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );

  it('still refuses auth.mode none on a loopback lookalike', () => {
    // The invariant this function exists to protect.
    expect(() =>
      appConfigSchema.parse({ server: { host: '127.evil.com', auth: { mode: 'none' } } }),
    ).toThrow(/not loopback/i);
  });

  it('still allows auth.mode none on a genuine loopback bind', () => {
    expect(() =>
      appConfigSchema.parse({ server: { host: '127.0.0.1', auth: { mode: 'none' } } }),
    ).not.toThrow();
  });
});
