import { hostname } from 'node:os';
import { loadConfig, type LoadedConfig } from './config/load.js';
import { ContextAssembler } from './context/assembler.js';
import { contextAssemblyConfiguration } from './context/config-adapter.js';
import { registerDefaultProviders } from './context/default-providers.js';
import { ContextProviderRegistry } from './context/registry.js';
import { openDatabase, type Db } from './db/database.js';
import { KvCache } from './db/kvCache.js';
import { createLogger, type Logger } from './logging/logger.js';
import { FilesystemScope } from './security/paths.js';
import { Mem0HttpMemoryProvider } from './services/memory/mem0-provider.js';
import type { MemoryProvider } from './services/memory/types.js';
import { ProjectRegistry } from './services/projects/project-registry.js';
import { ActiveContextStore } from './services/sessions/activeContext.js';
import { SessionManager } from './services/sessions/manager.js';
import { PendingRequestBroker } from './services/sessions/pendingRequestBroker.js';
import { WorkSessionStore } from './services/sessions/sessionStore.js';
import { SystemStatusService } from './services/system/system-status-service.js';
import { ComputerService } from './services/tailscale/computer-service.js';
import { LocalTailscaleCommandRunner, TailscaleClient } from './services/tailscale/tailscale-client.js';
import type { Services } from './server/container.js';

/**
 * Composition root.
 *
 * Every dependency is constructed exactly once here and injected downward, so
 * no module reaches for global state and tests can swap any piece.
 */
export interface Application {
  services: Services;
  loaded: LoadedConfig;
  db: Db;
  shutdown(): Promise<void>;
}

/** A memory provider that reports unavailable, used when Mem0 is disabled. */
class DisabledMemoryProvider implements MemoryProvider {
  readonly id = 'disabled';
  async search(): Promise<[]> {
    return [];
  }
  async health(): Promise<{ status: 'disabled'; checkedAt: string; detail: string }> {
    return {
      status: 'disabled',
      checkedAt: new Date().toISOString(),
      detail: 'long-term memory is disabled in configuration',
    };
  }
}

export interface BuildApplicationOptions {
  configPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Override the logger, e.g. to silence it in tests. */
  logger?: Logger;
}

export async function buildApplication(options: BuildApplicationOptions = {}): Promise<Application> {
  const env = options.env ?? process.env;
  const loaded = loadConfig({
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    env,
  });
  const config = loaded.config;

  const logger =
    options.logger ??
    createLogger({
      level: config.logging.level,
      pretty: config.logging.pretty,
      logInstructionText: config.logging.logInstructionText,
      ...(config.logging.filePath ? { filePath: config.logging.filePath } : {}),
    });

  for (const warning of loaded.warnings) logger.warn(warning, { component: 'config' });

  const db = openDatabase(config.database, logger);
  const cache = new KvCache(db);

  // ---- computers
  const tailscale = new TailscaleClient(
    new LocalTailscaleCommandRunner(),
    config.tailscale.executablePath,
    config.tailscale.timeoutMs,
  );
  const computers = new ComputerService(tailscale, {
    metadata: config.computers,
    cacheTtlMs: config.tailscale.cacheTtlMs,
  });

  // The local machine's Tailscale identity is the default owner of projects.
  const selfId = await resolveSelfComputerId(computers, logger);

  // ---- projects
  const projectRoots = config.projects.roots.length > 0 ? config.projects.roots : config.security.filesystem.projectRoots;
  const projects = new ProjectRegistry({
    roots: projectRoots,
    metadata: config.projects.metadata,
    defaultComputerId: selfId,
    cacheTtlMs: config.projects.refreshIntervalMs,
    maxDepth: config.projects.maxDepth,
    ignoreDirs: config.projects.ignoreDirs,
  });

  // ---- memory
  const memory: MemoryProvider =
    config.memory.enabled && config.memory.provider !== 'none'
      ? new Mem0HttpMemoryProvider({
          ...(config.memory.baseUrl !== undefined ? { baseUrl: config.memory.baseUrl } : {}),
          ...(env['MEM0_BACKUP_URL'] !== undefined ? { backupUrl: env['MEM0_BACKUP_URL'] } : {}),
          ...(env[config.memory.apiKeyEnvVar] !== undefined ? { apiKey: env[config.memory.apiKeyEnvVar] } : {}),
          ...(env[config.memory.userIdEnvVar] !== undefined ? { userId: env[config.memory.userIdEnvVar] } : {}),
          timeoutMs: config.memory.timeoutMs,
          allowWrites: config.memory.allowWrites,
        })
      : new DisabledMemoryProvider();

  const systemStatus = new SystemStatusService();

  // ---- sessions
  const sessionStore = new WorkSessionStore(db, config.claude.maxProgressEvents);
  const broker = new PendingRequestBroker(sessionStore);
  const activeContext = new ActiveContextStore(db);
  const scope = new FilesystemScope({
    projectRoots:
      config.security.filesystem.projectRoots.length > 0
        ? config.security.filesystem.projectRoots
        : projectRoots,
    additionalReadablePaths: config.security.filesystem.additionalReadablePaths,
    deniedPaths: config.security.filesystem.deniedPaths,
    allowOutsideProjectRead: config.security.filesystem.allowOutsideProjectRead,
    allowOutsideProjectWrite: config.security.filesystem.allowOutsideProjectWrite,
  });

  const sessions = new SessionManager({
    store: sessionStore,
    broker,
    activeContext,
    projects,
    computers,
    scope,
    claudeConfig: config.claude,
    securityConfig: config.security,
    logger,
  });

  // ---- context assembly
  const registry = new ContextProviderRegistry();
  registerDefaultProviders(registry, {
    computers,
    projects,
    sessions,
    memory,
    systemStatus,
    memoryMaxTokens: config.memory.maxTokens,
  });
  const contextAssembler = new ContextAssembler(registry, contextAssemblyConfiguration(config));

  const services: Services = {
    config,
    logger,
    db,
    cache,
    sessions,
    sessionStore,
    activeContext,
    computers,
    projects,
    memory,
    systemStatus,
    contextAssembler,
    contextRegistry: registry,
  };

  // Reconcile durable state with the fact that no workers survived a restart.
  sessions.recoverOnStartup();
  cache.pruneExpired();

  return {
    services,
    loaded,
    db,
    shutdown: async () => {
      await sessions.shutdown();
      db.close();
    },
  };
}

/**
 * Identify this machine among the Tailscale peers.
 *
 * Falls back to the OS hostname so project indexing still works when Tailscale
 * is down — machine awareness degrades, the rest of the system does not.
 */
async function resolveSelfComputerId(computers: ComputerService, logger: Logger): Promise<string> {
  try {
    const all = await computers.list();
    const self = all.find((computer) => computer.isSelf);
    if (self) return self.id;
    logger.warn('tailscale did not report a self node; using hostname', { component: 'startup' });
  } catch (error) {
    logger.warn('tailscale unavailable at startup; continuing without it', {
      component: 'startup',
      err: error,
    });
  }
  return `host:${hostname()}`;
}
