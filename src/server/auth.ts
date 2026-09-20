import { timingSafeEqual } from 'node:crypto';
import type { AuthConfig, ServerConfig } from '../config/schema.js';
import { isLoopbackHost } from '../config/schema.js';
import type { Logger } from '../logging/logger.js';
import { orchestratorError } from '../types/errors.js';

export interface AuthResult {
  ok: boolean;
  /** Reason for rejection. Never includes any part of the presented token. */
  reason?: string;
}

/**
 * Bearer-token authentication.
 *
 * Tokens are read from the environment by NAME, so the config file that names
 * them can be committed while the secret itself cannot. Comparison is constant
 * time; a plain `===` on a secret is a textbook timing oracle.
 */
export class BearerAuthenticator {
  private readonly tokens: Buffer[];

  constructor(config: AuthConfig, env: NodeJS.ProcessEnv, logger: Logger) {
    this.tokens = [];
    for (const name of config.tokenEnvVars) {
      const value = env[name];
      if (value === undefined || value.trim() === '') continue;
      if (value.length < 24) {
        // Short tokens are brute-forceable; refuse rather than pretend.
        throw orchestratorError(
          'UNSAFE_DEPLOYMENT',
          `bearer token in ${name} is too short (${value.length} chars); use at least 24 random characters`,
        );
      }
      this.tokens.push(Buffer.from(value, 'utf8'));
    }

    if (config.mode === 'bearer' && this.tokens.length === 0) {
      throw orchestratorError(
        'AUTH_REQUIRED',
        `auth.mode is "bearer" but none of ${config.tokenEnvVars.join(', ')} is set in the environment`,
      );
    }
    logger.info('bearer authentication configured', { tokenCount: this.tokens.length });
  }

  verify(authorizationHeader: string | undefined): AuthResult {
    if (!authorizationHeader) return { ok: false, reason: 'missing Authorization header' };
    const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
    if (!match?.[1]) return { ok: false, reason: 'Authorization header is not a Bearer token' };

    const presented = Buffer.from(match[1], 'utf8');
    for (const token of this.tokens) {
      // timingSafeEqual requires equal lengths, so compare lengths separately.
      // Length is not secret in practice and leaking it is acceptable here.
      if (token.length === presented.length && timingSafeEqual(token, presented)) {
        return { ok: true };
      }
    }
    return { ok: false, reason: 'token not recognised' };
  }

  get tokenCount(): number {
    return this.tokens.length;
  }
}

/**
 * Refuse configurations that would publish a powerful server unauthenticated.
 *
 * This runs at startup and throws. It duplicates the config-schema check on
 * purpose: the schema can be bypassed by constructing a config object in code,
 * and this invariant is important enough to assert twice.
 */
export function assertSafeDeployment(server: ServerConfig): void {
  const loopback = isLoopbackHost(server.host);
  if (loopback) return;

  if (server.auth.mode === 'none') {
    throw orchestratorError(
      'UNSAFE_DEPLOYMENT',
      `refusing to listen on ${server.host}:${server.port} without authentication. ` +
        'Bind 127.0.0.1 and use a TLS proxy, or set server.auth.mode to "bearer" or "oauth".',
    );
  }
  if (!server.allowNonLoopbackBind) {
    throw orchestratorError(
      'UNSAFE_DEPLOYMENT',
      `refusing to bind non-loopback address ${server.host} without server.allowNonLoopbackBind=true.`,
    );
  }
}
