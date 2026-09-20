import { describe, expect, it } from 'vitest';
import { assertSafeDeployment, BearerAuthenticator } from '../../../src/server/auth.js';
import { appConfigSchema } from '../../../src/config/schema.js';
import { createNullLogger } from '../../../src/logging/logger.js';
import { type OrchestratorError } from '../../../src/types/errors.js';

const logger = createNullLogger();
const GOOD_TOKEN = 'a'.repeat(40);

function authConfig(overrides: Record<string, unknown> = {}) {
  return appConfigSchema.parse({ server: { auth: { mode: 'bearer', ...overrides } } }).server.auth;
}

describe('BearerAuthenticator', () => {
  it('accepts a matching bearer token', () => {
    const auth = new BearerAuthenticator(authConfig(), { MCP_ORCHESTRATOR_TOKEN: GOOD_TOKEN }, logger);
    expect(auth.verify(`Bearer ${GOOD_TOKEN}`).ok).toBe(true);
  });

  it('is case-insensitive about the Bearer keyword', () => {
    const auth = new BearerAuthenticator(authConfig(), { MCP_ORCHESTRATOR_TOKEN: GOOD_TOKEN }, logger);
    expect(auth.verify(`bearer ${GOOD_TOKEN}`).ok).toBe(true);
  });

  it('rejects a wrong token, a missing header and a non-bearer scheme', () => {
    const auth = new BearerAuthenticator(authConfig(), { MCP_ORCHESTRATOR_TOKEN: GOOD_TOKEN }, logger);
    expect(auth.verify(`Bearer ${'b'.repeat(40)}`).ok).toBe(false);
    expect(auth.verify(undefined).ok).toBe(false);
    expect(auth.verify(`Basic ${GOOD_TOKEN}`).ok).toBe(false);
  });

  it('never echoes the presented token in the rejection reason', () => {
    const auth = new BearerAuthenticator(authConfig(), { MCP_ORCHESTRATOR_TOKEN: GOOD_TOKEN }, logger);
    const result = auth.verify('Bearer super-secret-presented-value-xxxxxxxx');
    expect(result.reason).toBeDefined();
    expect(result.reason).not.toContain('super-secret');
  });

  it('refuses a token that is too short to be safe', () => {
    try {
      new BearerAuthenticator(authConfig(), { MCP_ORCHESTRATOR_TOKEN: 'short' }, logger);
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as OrchestratorError).code).toBe('UNSAFE_DEPLOYMENT');
    }
  });

  it('refuses bearer mode with no token configured', () => {
    try {
      new BearerAuthenticator(authConfig(), {}, logger);
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as OrchestratorError).code).toBe('AUTH_REQUIRED');
    }
  });

  it('accepts any one of several configured token variables', () => {
    const config = authConfig({ tokenEnvVars: ['A_TOKEN', 'B_TOKEN'] });
    const auth = new BearerAuthenticator(config, { B_TOKEN: GOOD_TOKEN }, logger);
    expect(auth.tokenCount).toBe(1);
    expect(auth.verify(`Bearer ${GOOD_TOKEN}`).ok).toBe(true);
  });
});

describe('assertSafeDeployment', () => {
  const server = (overrides: Record<string, unknown>) =>
    appConfigSchema.parse({ server: overrides }).server;

  it('permits loopback without auth', () => {
    expect(() => assertSafeDeployment(server({ host: '127.0.0.1' }))).not.toThrow();
  });

  it('refuses an unauthenticated public bind', () => {
    // Build the object directly: the schema would already have rejected this,
    // and this assertion exists precisely to catch a config built in code.
    const unsafe = { ...server({ host: '127.0.0.1' }), host: '0.0.0.0' };
    expect(() => assertSafeDeployment(unsafe)).toThrow(/without authentication/i);
  });

  it('refuses a non-loopback bind that was not explicitly acknowledged', () => {
    const cfg = server({ host: '10.0.0.5', auth: { mode: 'bearer' }, allowNonLoopbackBind: true });
    const notAcknowledged = { ...cfg, allowNonLoopbackBind: false };
    expect(() => assertSafeDeployment(notAcknowledged)).toThrow(/allowNonLoopbackBind/);
  });
});
