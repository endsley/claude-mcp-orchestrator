/**
 * Cross-request memo for provider capability probing.
 *
 * This lives in its own module for a specific reason. `registerContextTools`
 * runs once per REQUEST, because `createMcpServer` is a per-request factory
 * (`server/http.ts` passes `() => createMcpServer(services)`). A cache held in
 * that function's closure is therefore a brand new cache on every request, so
 * its TTL could never survive one and every `list_context_capabilities` paid a
 * full round of provider health probes - a Mem0 search, a `tailscale`
 * subprocess, a project scan - on a live voice turn.
 *
 * Module scope is what actually persists across requests. The cache is keyed
 * weakly by the shared source object so that tests, which build many
 * assemblers, neither retain them nor leak state between cases.
 */

export interface CapabilitySource<T> {
  capabilities(): Promise<T>;
}

interface Entry<T> {
  at: number;
  value: T;
}

const entries = new WeakMap<object, Entry<unknown>>();
const inFlight = new WeakMap<object, Promise<unknown>>();

/**
 * Probe `source` at most once per `ttlMs`, collapsing concurrent callers onto
 * a single probe so three rapid voice turns do not trigger three rounds of
 * health checks.
 *
 * A failed probe is not cached: the rejection propagates and the next caller
 * retries, because a transient Mem0 outage should not pin "unavailable" for
 * the rest of the TTL.
 */
export async function cachedCapabilities<T>(source: CapabilitySource<T>, ttlMs: number): Promise<T> {
  const key: object = source;
  const cached = entries.get(key) as Entry<T> | undefined;
  if (cached !== undefined && Date.now() - cached.at < ttlMs) return cached.value;

  const pending = inFlight.get(key) as Promise<T> | undefined;
  if (pending !== undefined) return pending;

  const probe = source
    .capabilities()
    .then((value) => {
      entries.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, probe);
  return probe;
}
