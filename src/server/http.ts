import type { Server } from 'node:http';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpExpressApp, hostHeaderValidation } from '@modelcontextprotocol/express';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { AppConfig } from '../config/schema.js';
import { isLoopbackHost } from '../config/schema.js';
import type { Logger } from '../logging/logger.js';
import { orchestratorError } from '../types/errors.js';
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
export function createHttpApp(
  services: Services,
  options: { isReady: ReadinessProbe; env?: NodeJS.ProcessEnv },
): { app: Express; mcpHandler: McpHttpHandler } {
  const config: AppConfig = services.config;
  const logger: Logger = services.logger.child({ component: 'http' });
  const env = options.env ?? process.env;

  assertSafeDeployment(config.server);

  const loopbackOnly = isLoopbackHost(config.server.host);
  const allowedHosts = [
    'localhost',
    '127.0.0.1',
    '[::1]',
    `localhost:${config.server.port}`,
    `127.0.0.1:${config.server.port}`,
    ...config.server.allowedHosts,
  ];

  // DNS-rebinding protection is on by default; a proxied deployment must name
  // its public hostname in config rather than disabling the check.
  const app = createMcpExpressApp({ allowedHosts });
  app.use(hostHeaderValidation(allowedHosts));
  app.disable('x-powered-by');

  // Bound the request body. Without this an unauthenticated peer can force the
  // process to buffer arbitrary memory before auth is even evaluated.
  app.use(express.json({ limit: config.server.maxBodyBytes }));

  // Reject cross-origin browser requests unless explicitly allowed. Non-browser
  // clients (including Claude's connector) send no Origin and are unaffected.
  const allowedOrigins = new Set(config.server.allowedOrigins);
  app.use((req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (origin === undefined || allowedOrigins.has(origin)) {
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

  // Auth modes are handled exhaustively and the fallback is DENY.
  //
  // The previous shape built an authenticator only for 'bearer' and let every
  // other mode fall through to next(), which meant configuring auth.mode
  // "oauth" produced a completely unauthenticated server - the exact opposite
  // of what the operator asked for. Fail fast instead.
  if (config.server.auth.mode === 'oauth') {
    throw orchestratorError(
      'UNSAFE_DEPLOYMENT',
      'auth.mode "oauth" is not implemented yet and must not be used: it would leave this server ' +
        'unauthenticated. Use auth.mode "bearer" behind a TLS proxy, or bind loopback with mode "none".',
    );
  }

  const authenticator =
    config.server.auth.mode === 'bearer'
      ? new BearerAuthenticator(config.server.auth, env, logger)
      : undefined;

  if (!authenticator && config.server.auth.mode !== 'none') {
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

  const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
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
    const result = authenticator.verify(req.headers.authorization);
    if (result.ok) {
      next();
      return;
    }
    logger.warn('rejected unauthenticated MCP request', { reason: result.reason });
    res
      .status(401)
      .set('WWW-Authenticate', 'Bearer realm="claude-mcp-orchestrator"')
      .json({ error: 'unauthorized' });
  };

  app.all(config.server.mcpPath, requireAuth, (req: Request, res: Response) => {
    void nodeHandler(req, res, req.body);
  });

  logger.info('http app configured', {
    mcpPath: config.server.mcpPath,
    authMode: config.server.auth.mode,
    loopbackOnly,
  });

  return { app, mcpHandler };
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
