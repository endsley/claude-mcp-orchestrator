import type { ContextAssembler } from '../context/assembler.js';
import type { ContextProviderRegistry } from '../context/registry.js';
import type { AppConfig } from '../config/schema.js';
import type { Db } from '../db/database.js';
import type { KvCache } from '../db/kvCache.js';
import type { Logger } from '../logging/logger.js';
import type { MemoryProvider } from '../services/memory/types.js';
import type { ProjectRegistry } from '../services/projects/project-registry.js';
import type { ActiveContextStore } from '../services/sessions/activeContext.js';
import type { SessionManager } from '../services/sessions/manager.js';
import type { WorkSessionStore } from '../services/sessions/sessionStore.js';
import type { SystemStatusService } from '../services/system/system-status-service.js';
import type { ComputerService } from '../services/tailscale/computer-service.js';

/**
 * Everything the MCP tool layer needs, assembled once at startup.
 *
 * Passing one container rather than a dozen parameters keeps tool registration
 * readable and makes it obvious what the tools are allowed to touch — notably,
 * no raw filesystem or shell handle appears here.
 */
export interface Services {
  config: AppConfig;
  logger: Logger;
  db: Db;
  cache: KvCache;
  sessions: SessionManager;
  sessionStore: WorkSessionStore;
  activeContext: ActiveContextStore;
  computers: ComputerService;
  projects: ProjectRegistry;
  memory: MemoryProvider;
  systemStatus: SystemStatusService;
  contextAssembler: ContextAssembler;
  /** Exposed so diagnostics and tests can introspect registered providers. */
  contextRegistry: ContextProviderRegistry;
}
