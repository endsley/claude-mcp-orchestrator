import type { ContextProviderRegistry } from './registry.js';
import type { WorkSessionContextReader } from './contracts.js';
import { ComputerContextProvider } from './providers/computer-provider.js';
import { MemoryContextProvider } from './providers/memory-provider.js';
import { PreferenceContextProvider } from './providers/preference-provider.js';
import { ProjectContextProvider } from './providers/project-provider.js';
import { SystemStatusContextProvider } from './providers/system-status-provider.js';
import { WorkSessionContextProvider } from './providers/work-session-provider.js';
import { type MemoryProvider } from '../services/memory/types.js';
import type { ProjectRegistry } from '../services/projects/project-registry.js';
import type { SystemStatusService } from '../services/system/system-status-service.js';
import type { ComputerService } from '../services/tailscale/computer-service.js';

export interface DefaultProviderDependencies {
  computers: ComputerService;
  projects: ProjectRegistry;
  sessions: WorkSessionContextReader;
  memory: MemoryProvider;
  systemStatus: SystemStatusService;
  preferenceSummaries?: string[];
  memoryMaxTokens?: number;
}

/** Add a provider by registration only; the assembler itself never changes. */
export function registerDefaultProviders(registry: ContextProviderRegistry, deps: DefaultProviderDependencies): void {
  registry.register(new ComputerContextProvider(deps.computers));
  registry.register(new ProjectContextProvider(deps.projects));
  registry.register(new WorkSessionContextProvider(deps.sessions));
  registry.register(new PreferenceContextProvider(deps.preferenceSummaries));
  registry.register(new MemoryContextProvider(deps.memory, deps.memoryMaxTokens));
  registry.register(new SystemStatusContextProvider(deps.systemStatus));
}
