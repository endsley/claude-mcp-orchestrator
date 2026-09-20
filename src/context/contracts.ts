import type { JsonValue } from '../types/json.js';
import type { ActiveContextSnapshot, AssembledContext, ContextCapability, ContextAssemblyWarning, InitialContextProvider, InitialContextRequest, InitialContextSection } from '../types/context.js';

export type {
  ActiveContextSnapshot,
  AssembledContext,
  ContextCapability,
  ContextAssemblyWarning,
  InitialContextProvider,
  InitialContextRequest,
  InitialContextSection,
};
export type { ProviderHealth } from '../types/memory.js';

/** Public assembly options accepted from the MCP layer. */
export interface ContextAssemblyInput {
  profile?: string;
  focus?: string;
  include?: string[];
  exclude?: string[];
  maxTokens?: number;
  projectId?: string;
  computerId?: string;
  workSessionId?: string;
  requestId?: string;
  activeContext?: ActiveContextSnapshot;
}

export interface ContextProfile {
  providers: string[];
  maxTokens?: number;
}

export interface ContextProviderSettings {
  enabled?: boolean;
  priority?: number;
  timeoutMs?: number;
  cacheTtlMs?: number;
  options?: Record<string, JsonValue>;
}

export interface ContextAssemblyConfiguration {
  defaultProfile: string;
  maxTokens: number;
  /**
   * Timeout applied to any provider without its own override.
   *
   * Previously the adapter only emitted settings for providers explicitly named
   * in config, so an unlisted provider silently fell back to a hardcoded value
   * and `initialContext.defaultTimeoutMs` did nothing for it.
   */
  defaultTimeoutMs: number;
  retrievalConcurrency: number;
  profiles: Record<string, ContextProfile>;
  providers: Record<string, ContextProviderSettings>;
}

/** Dependency implemented by the core session service without a circular import. */
export interface WorkSessionContextReader {
  getCompactActiveContext(): Promise<InitialContextSection | null>;
}
