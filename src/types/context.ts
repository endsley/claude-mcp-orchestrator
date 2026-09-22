import type { JsonValue } from './json.js';
import type { ProviderHealth } from './memory.js';

/**
 * Snapshot of what the conversation most recently referred to. Lets a provider
 * bias its output toward the thing the user is actually talking about ("make it
 * smaller") without the provider having to know about conversation plumbing.
 *
 * This is a hint, never authoritative. Entries expire (see ActiveContextStore).
 */
export interface ActiveContextSnapshot {
  projectId?: string;
  computerId?: string;
  workSessionId?: string;
  /** ISO timestamp of the last update, or undefined when nothing is tracked. */
  updatedAt?: string;
}

/** Everything a provider is given for one assembly pass. */
export interface InitialContextRequest {
  /** Resolved profile name, e.g. "default", "coding". */
  profile: string;
  /** Free-text hint from the caller, e.g. "home dashboard mobile nav". */
  focus?: string;
  /**
   * Soft token budget for THIS provider's section. The assembler still trims
   * globally, but a provider that can cheaply produce less should respect it.
   */
  maxTokens: number;
  /** Aborted when the provider exceeds its configured timeout. */
  signal: AbortSignal;
  activeContext: ActiveContextSnapshot;
  /** Provider-specific options from config, already validated by the registry. */
  options: Readonly<Record<string, JsonValue>>;
  /** Correlates provider logs with the MCP request that triggered them. */
  requestId: string;
}

/**
 * A provider's contribution. `lines` is what the voice model actually reads;
 * `data` carries the same information in machine form for structuredContent.
 */
export interface InitialContextSection {
  providerId: string;
  /** Short all-caps heading, e.g. "OTHER COMPUTERS". */
  title: string;
  /**
   * Plain-text lines, already concise. The assembler trims from the END when
   * over budget, so put the most important line first.
   */
  lines: string[];
  /**
   * Number of leading lines that must survive trimming. A section trimmed below
   * this is dropped entirely rather than rendered misleadingly truncated.
   * Defaults to 1.
   */
  minLines?: number;
  /** Structured mirror of `lines`, surfaced in MCP structuredContent. */
  data?: JsonValue;
  /**
   * 0..1 relevance for the current request, used as a tiebreaker within a
   * priority band. Defaults to 0.5.
   */
  relevance?: number;
  /** Non-fatal problems to surface to the caller, e.g. "2 peers unreachable". */
  warnings?: string[];
  /** ISO timestamp of the underlying data, not of this call. */
  generatedAt: string;
  /** True when served from the provider's own cache. */
  cached?: boolean;
}

/**
 * The extension point. Adding a new category of initial context means writing
 * one of these and registering it — the assembler is never edited.
 */
/**
 * The part of a request a provider can inspect before any I/O happens, to say
 * whether it could contribute at all.
 */
export interface ContextApplicability {
  focus?: string;
  options: Record<string, JsonValue>;
}

export interface InitialContextProvider {
  readonly id: string;
  /** One sentence, surfaced verbatim by list_context_capabilities. */
  readonly description: string;
  /** Higher runs and survives trimming first. Config may override. */
  readonly priority: number;
  readonly defaultEnabled: boolean;
  /** Scheduling hint for the bounded-concurrency pool. Defaults to 'moderate'. */
  readonly costHint?: 'cheap' | 'moderate' | 'expensive';

  /**
   * Cheap check for whether the underlying dependency exists at all (Tailscale
   * installed, Mem0 configured...). Must not throw; the registry treats a
   * rejection as unavailable.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Synchronous, allocation-cheap check for whether this provider could say
   * anything about THIS request. Returning false skips it before the
   * availability probe, which for a remote dependency is a network round trip.
   * Omit it and the provider always runs.
   */
  appliesTo?(request: ContextApplicability): boolean;

  /**
   * Produce this provider's section. Return null to contribute nothing for this
   * particular request without being considered a failure.
   */
  getContext(request: InitialContextRequest): Promise<InitialContextSection | null>;

  /** Optional richer health for the doctor command and /readyz. */
  health?(): Promise<ProviderHealth>;
}

/** What list_context_capabilities reports for one provider. */
export interface ContextCapability {
  id: string;
  description: string;
  available: boolean;
  enabled: boolean;
  includedByDefault: boolean;
  priority: number;
  /** Profiles that include this provider. */
  profiles: string[];
  health?: ProviderHealth;
}

export interface ContextAssemblyWarning {
  providerId: string;
  /** Why the section is missing or reduced. */
  reason: 'timeout' | 'error' | 'unavailable' | 'trimmed' | 'dropped' | 'oversized' | 'unknown';
  message: string;
}

export interface AssembledContext {
  profile: string;
  /** Rendered, voice-ready text. This is the primary MCP tool output. */
  text: string;
  sections: InitialContextSection[];
  warnings: ContextAssemblyWarning[];
  /** Estimated tokens in `text`. */
  estimatedTokens: number;
  budgetTokens: number;
  /** Per-provider wall-clock timings, for the responsiveness work. */
  timings: Record<string, number>;
  generatedAt: string;
}
