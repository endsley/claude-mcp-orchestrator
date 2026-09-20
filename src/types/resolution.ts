/**
 * Result of resolving a spoken phrase ("the GPU machine", "my transit app") to
 * a concrete entity.
 *
 * Ambiguity is a first-class outcome rather than an error thrown away by a
 * best-guess heuristic: the voice front end can read the candidates back to the
 * user, which is far better than silently editing the wrong repository.
 */
export interface ResolutionCandidate<T> {
  value: T;
  /** 0..1. 1 means an exact identifier match. */
  confidence: number;
  /** Which field produced the match, e.g. "alias:gpu machine", "machineName". */
  matchedOn: string;
}

export type Resolution<T> =
  | { kind: 'match'; candidate: ResolutionCandidate<T> }
  | { kind: 'ambiguous'; candidates: ResolutionCandidate<T>[] }
  | { kind: 'none'; query: string; nearMisses: ResolutionCandidate<T>[] };

export function matched<T>(candidate: ResolutionCandidate<T>): Resolution<T> {
  return { kind: 'match', candidate };
}

export function ambiguous<T>(candidates: ResolutionCandidate<T>[]): Resolution<T> {
  return { kind: 'ambiguous', candidates };
}

export function unresolved<T>(query: string, nearMisses: ResolutionCandidate<T>[] = []): Resolution<T> {
  return { kind: 'none', query, nearMisses };
}
