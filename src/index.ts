import { buildApplication } from './app.js';
import { createHttpApp, startHttpServer } from './server/http.js';
import { OrchestratorError } from './types/errors.js';

/**
 * Service entrypoint.
 *
 * Responsibilities are kept to: build the app, start listening, and shut down
 * cleanly. Everything else lives in `buildApplication`, which tests use
 * directly without binding a port.
 */
async function main(): Promise<void> {
  const app = await buildApplication();
  const { services } = app;
  const logger = services.logger.child({ component: 'main' });

  const { app: expressApp, mcpHandler } = createHttpApp(services, {
    isReady: async () => {
      try {
        // Readiness means "can serve a request", which needs the database. A
        // degraded optional subsystem (Tailscale, Mem0) must NOT flip us to
        // not-ready, or one flaky dependency takes the whole server offline.
        services.db.prepare('SELECT 1').get();
        return { ready: true };
      } catch (error) {
        logger.error('readiness check failed', { err: error });
        return { ready: false, detail: 'database unavailable' };
      }
    },
  });

  const handle = await startHttpServer(
    expressApp,
    services.config.server.host,
    services.config.server.port,
    logger,
  );

  logger.info('claude-mcp-orchestrator started', {
    endpoint: `http://${services.config.server.host}:${handle.port}${services.config.server.mcpPath}`,
    authMode: services.config.server.auth.mode,
    configSource: app.loaded.sourcePath ?? '(defaults)',
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });

    void (async () => {
      // Stop accepting new work before tearing down live workers, so a request
      // cannot start a session we are about to abandon.
      const timeout = setTimeout(() => {
        logger.warn('graceful shutdown timed out; exiting');
        process.exit(1);
      }, 15_000);
      timeout.unref();

      try {
        await handle.close();
        await mcpHandler.close();
        await app.shutdown();
        logger.info('shutdown complete');
        clearTimeout(timeout);
        process.exit(0);
      } catch (error) {
        logger.error('error during shutdown', { err: error });
        process.exit(1);
      }
    })();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection', { err: reason });
  });
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception', { err: error });
    shutdown('uncaughtException');
  });
}

main().catch((error: unknown) => {
  // The logger may not exist yet, so this one path writes to stderr directly.
  if (OrchestratorError.is(error)) {
    process.stderr.write(`startup failed [${error.code}]: ${error.message}\n`);
  } else {
    process.stderr.write(`startup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  }
  process.exit(1);
});
