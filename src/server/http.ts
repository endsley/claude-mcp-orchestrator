import type { Server } from 'node:http';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpExpressApp, hostHeaderValidation } from '@modelcontextprotocol/express';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { AppConfig } from '../config/schema.js';
import { isLoopbackHost } from '../config/schema.js';
import type { Logger } from '../logging/logger.js';
import { orchestratorError } from '../types/errors.js';
import { createOAuthRouter } from '../security/oauth/server.js';
import { OAuthStore } from '../security/oauth/store.js';
import { audienceMatches, canonicalResource } from '../security/oauth/tokens.js';
import { assertSafeDeployment, BearerAuthenticator } from './auth.js';
import type { Services } from './container.js';
import { createMcpServer } from './mcpServer.js';

export interface HttpServerHandle {
  app: Express;
  server: Server;
  close(): Promise<void>;
  /** Actual bound port, which differs from config when port 0 was requested. */
  port: number;
}

export interface ReadinessProbe {
  (): Promise<{ ready: boolean; detail?: string }>;
}

/**
 * Build the HTTP surface: the MCP endpoint plus minimal operational probes.
 *
 * Health endpoints deliberately reveal nothing beyond up/ready. Detailed
 * diagnostics live in the doctor command, which runs locally, because a public
 * probe that lists your machines is an information leak.
 */
/** How often expired OAuth codes and tokens are swept. */
const OAUTH_PRUNE_INTERVAL_MS = 60 * 60_000;

export function createHttpApp(
  services: Services,
  options: { isReady: ReadinessProbe; env?: NodeJS.ProcessEnv },
): { app: Express; mcpHandler: McpHttpHandler; stopPrune: () => void } {
  let pruneTimer: NodeJS.Timeout | undefined;
  const config: AppConfig = services.config;
  const logger: Logger = services.logger.child({ component: 'http' });
  const env = options.env ?? process.env;

  assertSafeDeployment(config.server);

  const loopbackOnly = isLoopbackHost(config.server.host);

  /**
   * The server's own public hostname, derived from auth.resourceUrl.
   *
   * This MUST be allowed automatically. The OAuth consent page is served by
   * this server and posts back to it, so the browser sends
   * `Origin: https://<public-host>`. The SDK defaults Origin validation to
   * localhost-only on a loopback bind, which 403s that same-origin form post
   * and makes the whole OAuth flow impossible. Requiring the operator to
   * hand-configure their own origin would just be a trap.
   */
  const publicHostname = (() => {
    const url = config.server.auth.resourceUrl;
    if (!url) return undefined;
    try {
      return new URL(url).hostname;
    } catch {
      return undefined;
    }
  })();

  const allowedHosts = [
    'localhost',
    '127.0.0.1',
    '[::1]',
    `localhost:${config.server.port}`,
    `127.0.0.1:${config.server.port}`,
    ...(publicHostname ? [publicHostname] : []),
    ...config.server.allowedHosts,
  ];

  // Origin validation is hostname-based and port-agnostic in the SDK.
  const allowedOriginHostnames = [
    'localhost',
    '127.0.0.1',
    '[::1]',
    ...(publicHostname ? [publicHostname] : []),
    ...config.server.allowedHosts,
    // Operators may configure full origins; reduce them to hostnames.
    ...config.server.allowedOrigins.flatMap((origin) => {
      try {
        return [new URL(origin).hostname];
      } catch {
        return [origin];
      }
    }),
  ];

  // DNS-rebinding protection is on by default; a proxied deployment must name
  // its public hostname in config rather than disabling the check.
  const app = createMcpExpressApp({ allowedHosts, allowedOrigins: allowedOriginHostnames });
  app.use(hostHeaderValidation(allowedHosts));
  app.disable('x-powered-by');

  // Bound the request body. Without this an unauthenticated peer can force the
  // process to buffer arbitrary memory before auth is even evaluated.
  app.use(express.json({ limit: config.server.maxBodyBytes }));

  // Reject cross-origin browser requests unless explicitly allowed. Non-browser
  // clients (including Claude's connector) send no Origin and are unaffected.
  // Same-origin requests are always allowed: the consent page this server
  // serves must be able to post back to it.
  const allowedOriginSet = new Set(allowedOriginHostnames.map((host) => host.toLowerCase()));
  app.use((req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (origin === undefined) {
      next();
      return;
    }
    let hostname: string;
    try {
      hostname = new URL(origin).hostname.toLowerCase();
    } catch {
      logger.warn('rejected request with unparseable Origin', { origin });
      res.status(403).json({ error: 'origin not allowed' });
      return;
    }
    if (allowedOriginSet.has(hostname)) {
      next();
      return;
    }
    logger.warn('rejected request from disallowed origin', { origin });
    res.status(403).json({ error: 'origin not allowed' });
  });

  // Cap how long a single request may occupy a socket.
  app.use((req: Request, res: Response, next: NextFunction): void => {
    req.setTimeout(config.server.requestTimeoutMs);
    res.setTimeout(config.server.requestTimeoutMs);
    next();
  });

  // Auth modes are handled exhaustively and the fallback is DENY. A mode with
  // no working authenticator must refuse to start rather than fall through to
  // serving unauthenticated traffic.
  const authenticator =
    config.server.auth.mode === 'bearer'
      ? new BearerAuthenticator(config.server.auth, env, logger)
      : undefined;

  let oauth: { store: OAuthStore; resource: string } | undefined;

  if (config.server.auth.mode === 'oauth') {
    const issuer = config.server.auth.resourceUrl;
    if (!issuer) {
      throw orchestratorError('INVALID_CONFIG', 'auth.mode "oauth" requires auth.resourceUrl');
    }
    const adminPassword = env[config.server.auth.adminPasswordEnvVar] ?? '';
    if (adminPassword.length < 12) {
      throw orchestratorError(
        'UNSAFE_DEPLOYMENT',
        `auth.mode "oauth" requires ${config.server.auth.adminPasswordEnvVar} to be set to at least ` +
          '12 characters. It is the only human secret protecting the consent screen.',
      );
    }

    const store = new OAuthStore(services.db);
    const resource = canonicalResource(`${issuer.replace(/\/+$/, '')}${config.server.mcpPath}`);
    oauth = { store, resource };

    app.use(
      createOAuthRouter({
        issuer: issuer.replace(/\/+$/, ''),
        resource,
        scopesSupported: config.server.auth.scopesSupported,
        adminPassword,
        accessTokenTtlMs: config.server.auth.accessTokenTtlMs,
        refreshTokenTtlMs: config.server.auth.refreshTokenTtlMs,
        authorizationCodeTtlMs: config.server.auth.authorizationCodeTtlMs,
        store,
        logger,
      }),
    );
    // Sweep on a timer rather than only at boot. This process is meant to
    // run for weeks, so a single startup prune let expired codes and tokens
    // accumulate until the next restart. unref() so the sweep never holds the
    // process - or a test - open, and the handle is returned for shutdown.
    const runPrune = (): void => {
      try {
        const pruned = store.pruneExpired();
        if (pruned.codes > 0 || pruned.tokens > 0) logger.info('oauth prune', pruned);
      } catch (error) {
        // A failed sweep must never take the server down with it.
        logger.warn('oauth prune failed', { err: error });
      }
    };
    runPrune();
    pruneTimer = setInterval(runPrune, OAUTH_PRUNE_INTERVAL_MS);
    pruneTimer.unref();
    logger.info('oauth authorization server mounted', { issuer, resource });
  }

  if (!authenticator && !oauth && config.server.auth.mode !== 'none') {
    throw orchestratorError(
      'UNSAFE_DEPLOYMENT',
      `auth.mode "${config.server.auth.mode}" has no authenticator; refusing to serve unauthenticated.`,
    );
  }

  const mcpHandler = createMcpHandler(() => createMcpServer(services), {
    onerror: (error: Error) => logger.error('mcp handler error', { err: error }),
  });
  const nodeHandler = toNodeHandler(mcpHandler, {
    onerror: (error: Error) => logger.error('mcp transport error', { err: error }),
  });

  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  app.get('/readyz', (_req: Request, res: Response) => {
    void options
      .isReady()
      .then((result) => {
        res.status(result.ready ? 200 : 503).json({ status: result.ready ? 'ready' : 'not-ready' });
      })
      .catch(() => {
        res.status(503).json({ status: 'not-ready' });
      });
  });

  /**
   * RFC 9728 challenge. Pointing at the resource metadata is what lets an MCP
   * client discover the authorization server and start the OAuth flow on its
   * own, with no configuration beyond the URL the user typed.
   */
  const challenge = (): string => {
    const parts = ['Bearer realm="claude-mcp-orchestrator"'];
    if (oauth) {
      const issuer = (config.server.auth.resourceUrl ?? '').replace(/\/+$/, '');
      parts.push(`resource_metadata="${issuer}/.well-known/oauth-protected-resource"`);
      parts.push(`scope="${config.server.auth.scopesSupported.join(' ')}"`);
    }
    return parts.join(', ');
  };

  const unauthorized = (res: Response, reason: string): void => {
    logger.warn('rejected unauthenticated MCP request', { reason });
    res.status(401).set('WWW-Authenticate', challenge()).json({ error: 'unauthorized' });
  };

  const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;

    if (oauth) {
      const match = /^Bearer\s+(.+)$/i.exec((header ?? '').trim());
      if (!match?.[1]) {
        unauthorized(res, 'missing bearer token');
        return;
      }
      const record = oauth.store.lookupToken(match[1], 'access');
      if (!record) {
        unauthorized(res, 'access token unknown, expired or revoked');
        return;
      }
      // RFC 8707 / MCP: the token MUST have been issued for THIS resource.
      // Skipping this is how a token minted for another service gets accepted.
      if (!audienceMatches(record.audience, oauth.resource)) {
        logger.warn('rejected token issued for a different audience', { audience: record.audience });
        unauthorized(res, 'token audience does not match this resource');
        return;
      }
      next();
      return;
    }

    if (!authenticator) {
      // Reachable ONLY for mode 'none', which assertSafeDeployment has already
      // proven implies a loopback bind. Re-assert it here rather than trusting
      // a caller to have validated the config.
      if (config.server.auth.mode === 'none' && loopbackOnly) {
        next();
        return;
      }
      logger.error('refusing request: no authenticator for a non-loopback or non-none configuration');
      res.status(500).json({ error: 'server misconfigured' });
      return;
    }

    const result = authenticator.verify(header);
    if (result.ok) {
      next();
      return;
    }
    unauthorized(res, result.reason ?? 'invalid token');
  };

  app.all(config.server.mcpPath, requireAuth, (req: Request, res: Response) => {
    void nodeHandler(req, res, req.body);
  });

  logger.info('http app configured', {
    mcpPath: config.server.mcpPath,
    authMode: config.server.auth.mode,
    loopbackOnly,
  });

  return {
    app,
    mcpHandler,
    stopPrune: (): void => {
      if (pruneTimer !== undefined) clearInterval(pruneTimer);
      pruneTimer = undefined;
    },
  };
}

export async function startHttpServer(
  app: Express,
  host: string,
  port: number,
  logger: Logger,
): Promise<HttpServerHandle> {
  const { createServer } = await import('node:http');
  const server = createServer(app);

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(`port ${port} is already in use on ${host}`)
          : error,
      );
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  logger.info('listening', { host, port: boundPort });

  return {
    app,
    server,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // Idle keep-alive sockets would otherwise hold shutdown open.
        server.closeIdleConnections?.();
      }),
  };
}
