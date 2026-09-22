import { orchestratorError } from '../types/errors.js';
import type {
  AssembledContext,
  ContextApplicability,
  ContextCapability,
  ContextAssemblyWarning,
  InitialContextProvider,
  InitialContextRequest,
  InitialContextSection,
} from '../types/context.js';
import type { JsonValue } from '../types/json.js';
import type { ContextAssemblyConfiguration, ContextAssemblyInput } from './contracts.js';
import type { ContextProviderRegistry } from './registry.js';
import { estimateTokens, trimToTokens } from './text.js';

interface ProviderResult {
  providerId: string;
  section: InitialContextSection | null;
  warning?: ContextAssemblyWarning;
  elapsedMs: number;
  priority: number;
}

function now(): string {
  return new Date().toISOString();
}

function render(section: InitialContextSection): string {
  return `${section.title}\n${section.lines.join('\n')}`;
}

async function timed<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<{ value: T; elapsedMs: number }> {
  const controller = new AbortController();
  const started = performance.now();
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    const value = await Promise.race([operation(controller.signal), timeoutPromise]);
    return { value, elapsedMs: Math.round(performance.now() - started) };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * Executes providers independently with real bounded concurrency and isolation.
 * A single provider can time out, return malformed context, or fail without
 * taking down the environment-context MCP tool.
 */
export class ContextAssembler {
  /** Opt-in per-provider section cache, keyed by provider and request shape. */
  private readonly sectionCache = new Map<string, { section: InitialContextSection | null; expiresAt: number }>();

  constructor(
    private readonly registry: ContextProviderRegistry,
    private readonly configuration: ContextAssemblyConfiguration,
  ) {}

  async assemble(input: ContextAssemblyInput = {}): Promise<AssembledContext> {
    const profileName = input.profile ?? this.configuration.defaultProfile;
    const profile = this.configuration.profiles[profileName];
    if (profile === undefined) {
      throw orchestratorError('PROFILE_NOT_FOUND', `Context profile '${profileName}' is not configured.`);
    }
    const budgetTokens = Math.max(1, input.maxTokens ?? profile.maxTokens ?? this.configuration.maxTokens);
    const providers = this.selectedProviders(profile.providers, input);
    // A request ID names the whole fan-out, not an individual provider call.
    // Keeping it stable makes provider-level structured logs correlatable
    // without ever recording the caller's full instruction text.
    const requestId = input.requestId ?? crypto.randomUUID();
    const results = await this.runBounded(
      providers.map(({ id, provider }) => () => this.fetch(id, provider, input, profileName, budgetTokens, requestId)),
    );
    const timings = Object.fromEntries(results.map((result) => [result.providerId, result.elapsedMs]));
    const warnings = results.flatMap((result) => result.warning === undefined ? [] : [result.warning]);
    const ordered = results
      .flatMap((result) => result.section === null ? [] : [{ ...result, section: result.section }])
      .sort((left, right) => right.priority - left.priority || (right.section.relevance ?? 0.5) - (left.section.relevance ?? 0.5) || left.providerId.localeCompare(right.providerId));

    const retained: InitialContextSection[] = [];
    let used = 0;
    for (const entry of ordered) {
      const remaining = budgetTokens - used;
      if (remaining <= 0) {
        warnings.push({ providerId: entry.providerId, reason: 'dropped', message: `${entry.section.title} was omitted because the context budget was exhausted.` });
        continue;
      }
      const section = this.fitSection(entry.section, remaining);
      if (section === null) {
        warnings.push({ providerId: entry.providerId, reason: 'dropped', message: `${entry.section.title} could not fit its required summary lines.` });
        continue;
      }
      const originalTokens = estimateTokens(render(entry.section));
      const keptTokens = estimateTokens(render(section));
      retained.push(section);
      used += keptTokens;
      if (keptTokens < originalTokens) {
        warnings.push({ providerId: entry.providerId, reason: 'trimmed', message: `${entry.section.title} was trimmed to the configured token budget.` });
      }
    }
    return {
      profile: profileName,
      text: retained.map(render).join('\n\n'),
      sections: retained,
      warnings,
      estimatedTokens: used,
      budgetTokens,
      timings,
      generatedAt: now(),
    };
  }

  async capabilities(): Promise<ContextCapability[]> {
    return this.runBounded(this.registry.list().map((provider) => async () => {
      const setting = this.configuration.providers[provider.id];
      const timeoutMs = setting?.timeoutMs ?? this.configuration.defaultTimeoutMs;
      let available = false;
      try {
        available = (await timed(() => provider.isAvailable(), timeoutMs)).value;
      } catch {
        available = false;
      }
      const capability: ContextCapability = {
        id: provider.id,
        description: provider.description,
        available,
        enabled: setting?.enabled ?? provider.defaultEnabled,
        includedByDefault: (this.configuration.profiles[this.configuration.defaultProfile]?.providers ?? []).includes(provider.id),
        priority: setting?.priority ?? provider.priority,
        profiles: Object.entries(this.configuration.profiles)
          .filter(([, profile]) => profile.providers.includes(provider.id))
          .map(([name]) => name),
      };
      if (provider.health !== undefined) {
        try {
          capability.health = (await timed(() => provider.health!(), timeoutMs)).value;
        } catch {
          capability.health = { status: 'unavailable', checkedAt: now(), detail: 'Health check timed out or failed.' };
        }
      }
      return capability;
    }));
  }

  private selectedProviders(profileIds: string[], input: ContextAssemblyInput): Array<{ id: string; provider: InitialContextProvider }> {
    const excluded = new Set(input.exclude ?? []);
    const requested = new Set([...profileIds, ...(input.include ?? [])]);
    return [...requested].flatMap((id) => {
      const provider = this.registry.get(id);
      const configured = this.configuration.providers[id];
      if (provider === undefined || excluded.has(id) || !(configured?.enabled ?? provider.defaultEnabled)) return [];
      return [{ id, provider }];
    });
  }

  private async runBounded<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
    const concurrency = Math.max(1, Math.min(16, this.configuration.retrievalConcurrency));
    const output: T[] = new Array(tasks.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= tasks.length) return;
        output[index] = await tasks[index]!();
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
    return output;
  }

  private async fetch(
    providerId: string,
    provider: InitialContextProvider,
    input: ContextAssemblyInput,
    profile: string,
    maxTokens: number,
    requestId: string,
  ): Promise<ProviderResult> {
    const setting = this.configuration.providers[providerId];
    const timeoutMs = setting?.timeoutMs ?? this.configuration.defaultTimeoutMs;
    const started = performance.now();

    // Per-provider caching is OPT-IN via cacheTtlMs. That matters: memory
    // searches deliberately have no TTL configured, because serving a stale or
    // unrelated recollection is worse than paying for the lookup.
    const cacheTtlMs = setting?.cacheTtlMs ?? 0;
    // maxTokens is deliberately NOT part of the key. What gets cached is the
    // provider's raw section; trimming to the budget happens later in
    // assemble() via fitSection, so the cached value does not depend on the
    // budget. Including it only fragmented the cache, making the same focus at
    // a different budget re-run the provider for an identical result.
    const cacheKey = cacheTtlMs > 0 ? `${providerId}|${profile}|${input.focus ?? ''}|${input.projectId ?? ''}|${input.computerId ?? ''}` : undefined;
    if (cacheKey !== undefined) {
      const hit = this.sectionCache.get(cacheKey);
      if (hit !== undefined && hit.expiresAt > Date.now()) {
        return {
          providerId,
          section: hit.section === null ? null : { ...hit.section, cached: true },
          priority: setting?.priority ?? provider.priority,
          elapsedMs: Math.round(performance.now() - started),
        };
      }
    }

    const options: Record<string, JsonValue> = {
      ...(setting?.options ?? {}),
      projectId: input.projectId ?? null,
      computerId: input.computerId ?? null,
      workSessionId: input.workSessionId ?? null,
    };

    // Ask before paying. A provider that cannot answer this request should not
    // cost an availability probe first, because for a remote dependency that
    // probe is a network round trip spent to produce nothing.
    const applicability: ContextApplicability = { options };
    if (input.focus !== undefined) applicability.focus = input.focus;
    if (provider.appliesTo?.(applicability) === false) {
      return { providerId, section: null, priority: setting?.priority ?? provider.priority, elapsedMs: Math.round(performance.now() - started) };
    }

    // One budget for the whole provider, not one per call. isAvailable() and
    // getContext() were each given the full timeoutMs, so a provider
    // configured for 10s could hold the assembly for 20s - and the assembly
    // only returns once every provider has settled.
    const deadline = Date.now() + timeoutMs;
    const remainingMs = (): number => Math.max(1, deadline - Date.now());

    try {
      const available = (await timed(() => provider.isAvailable(), remainingMs())).value;
      if (!available) {
        return { providerId, section: null, priority: setting?.priority ?? provider.priority, elapsedMs: Math.round(performance.now() - started), warning: { providerId, reason: 'unavailable', message: `${provider.description} is unavailable.` } };
      }
      const result = await timed((signal) => {
        const request: InitialContextRequest = {
          profile,
          maxTokens,
          signal,
          activeContext: input.activeContext ?? {},
          options,
          requestId,
        };
        if (input.focus !== undefined) request.focus = input.focus;
        return provider.getContext(request);
      }, remainingMs());
      const section = result.value;
      if (section !== null && (!section.title.trim() || section.lines.some((line) => typeof line !== 'string'))) {
        throw new Error('Provider returned malformed context.');
      }
      if (cacheKey !== undefined) {
        this.sectionCache.set(cacheKey, { section, expiresAt: Date.now() + cacheTtlMs });
        // Bound the cache so a long-running server with many focus strings
        // cannot grow it without limit.
        if (this.sectionCache.size > 200) {
          const oldest = this.sectionCache.keys().next();
          if (!oldest.done) this.sectionCache.delete(oldest.value);
        }
      }
      return { providerId, section, priority: setting?.priority ?? provider.priority, elapsedMs: Math.round(performance.now() - started) };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown provider failure.';
      return {
        providerId,
        section: null,
        priority: setting?.priority ?? provider.priority,
        elapsedMs: Math.round(performance.now() - started),
        warning: { providerId, reason: /timed out/i.test(message) ? 'timeout' : 'error', message: `${provider.description}: ${message}` },
      };
    }
  }

  private fitSection(section: InitialContextSection, budget: number): InitialContextSection | null {
    const required = Math.max(1, Math.min(section.minLines ?? 1, section.lines.length));
    const lines: string[] = [];
    let used = estimateTokens(section.title);
    for (const line of section.lines) {
      const lineTokens = estimateTokens(line);
      if (used + lineTokens <= budget) {
        lines.push(line);
        used += lineTokens;
      } else if (lines.length < required) {
        const trimmed = trimToTokens(line, Math.max(0, budget - used));
        if (trimmed) {
          lines.push(trimmed);
          used += estimateTokens(trimmed);
        }
        break;
      } else {
        break;
      }
    }
    if (lines.length < required) return null;
    return { ...section, lines };
  }
}
