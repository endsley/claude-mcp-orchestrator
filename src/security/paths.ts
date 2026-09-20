import { realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { FilesystemScopeConfig } from './types.js';

/**
 * Filesystem scope enforcement.
 *
 * Two distinct checks matter here and conflating them is a real vulnerability:
 *  - LEXICAL containment (`a/b` is inside `a`) stops `../../etc/passwd`;
 *  - REALPATH containment stops a symlink inside the project pointing out of it.
 *
 * We evaluate both. Realpath is only advisory when the path does not exist yet
 * (a file about to be created), in which case the nearest existing ancestor is
 * resolved instead — otherwise every "write a new file" would fail closed.
 */

export type ScopeAccess = 'read' | 'write';

export interface ScopeDecision {
  allowed: boolean;
  /** Which configured root permitted it, when allowed. */
  root?: string;
  reason?: string;
  /** The resolved path the decision was made about. */
  resolvedPath: string;
}

/** Lexical containment: is `child` at or below `parent`? */
export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (rel === '') return true;
  // `..` prefix means it escaped; an absolute result means different roots.
  return !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/**
 * Resolve symlinks as far as the path actually exists.
 *
 * Returns the realpath of the deepest existing ancestor joined with the
 * remaining (non-existent) segments, so a not-yet-created file is still judged
 * against the real location of its parent directory.
 */
export function resolveExistingAncestor(path: string): string {
  let current = resolve(path);
  const trailing: string[] = [];

  for (;;) {
    try {
      const real = realpathSync(current);
      return trailing.length > 0 ? resolve(real, ...trailing.reverse()) : real;
    } catch {
      const parent = resolve(current, '..');
      if (parent === current) return resolve(path); // reached the filesystem root
      // basename, not a slice of the parent's length: at the root the parent is
      // "/" and a length-based slice eats the first character of the segment.
      trailing.push(basename(current));
      current = parent;
    }
  }
}

export class FilesystemScope {
  private readonly projectRoots: string[];
  private readonly readablePaths: string[];
  private readonly deniedPaths: string[];

  constructor(private readonly config: FilesystemScopeConfig) {
    this.projectRoots = config.projectRoots.map((p) => resolve(p));
    this.readablePaths = config.additionalReadablePaths.map((p) => resolve(p));
    this.deniedPaths = config.deniedPaths.map((p) => resolve(p));
  }

  /**
   * Decide whether `candidate` may be accessed for `access`.
   *
   * Deny rules are checked first and are absolute: nothing later can re-permit
   * a denied path.
   */
  check(candidate: string, access: ScopeAccess): ScopeDecision {
    const lexical = resolve(candidate);
    const real = resolveExistingAncestor(lexical);

    for (const denied of this.deniedPaths) {
      if (isWithin(denied, lexical) || isWithin(denied, real)) {
        return { allowed: false, reason: `path is inside a denied location (${denied})`, resolvedPath: real };
      }
    }

    // Both the literal and the symlink-resolved path must sit inside the root,
    // so a symlink cannot be used to smuggle access out of the project.
    const inRoot = this.projectRoots.find((root) => isWithin(root, lexical) && isWithin(root, real));
    if (inRoot) return { allowed: true, root: inRoot, resolvedPath: real };

    const escapesViaSymlink = this.projectRoots.some((root) => isWithin(root, lexical) && !isWithin(root, real));
    if (escapesViaSymlink) {
      return {
        allowed: false,
        reason: 'path resolves outside the project through a symlink',
        resolvedPath: real,
      };
    }

    if (access === 'read') {
      const readable = this.readablePaths.find((p) => isWithin(p, lexical) && isWithin(p, real));
      if (readable) return { allowed: true, root: readable, resolvedPath: real };
      if (this.config.allowOutsideProjectRead) {
        return { allowed: true, reason: 'reads outside project roots are permitted by config', resolvedPath: real };
      }
      return { allowed: false, reason: 'path is outside every configured project root', resolvedPath: real };
    }

    if (this.config.allowOutsideProjectWrite) {
      return { allowed: true, reason: 'writes outside project roots are permitted by config', resolvedPath: real };
    }
    return { allowed: false, reason: 'writes are restricted to configured project roots', resolvedPath: real };
  }

  get roots(): readonly string[] {
    return this.projectRoots;
  }
}
