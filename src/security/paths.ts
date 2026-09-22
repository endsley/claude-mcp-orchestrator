import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
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

/**
 * Expand a leading `~` the way a shell would, or refuse the path.
 *
 * resolve() treats `~` as an ordinary directory name, so `~/.ssh/id_rsa`
 * became `<cwd>/~/.ssh/id_rsa` -- lexically INSIDE the project root, because
 * the server's working directory is a project -- and check() allowed it. The
 * tool downstream then expands `~` for real and writes to the home directory.
 * A scope check is only as good as its agreement with whatever finally opens
 * the file.
 *
 * `~user` is refused rather than guessed: resolving another account's home
 * requires /etc/passwd, and treating it as a literal directory name is exactly
 * the bug above.
 */
function expandHome(candidate: string): string | null {
  if (candidate === '~') return homedir();
  if (candidate.startsWith('~/')) return join(homedir(), candidate.slice(2));
  if (candidate.startsWith('~')) return null;
  return candidate;
}

/**
 * The canonical form of a configured location.
 *
 * Falls back to a lexical resolve when the path does not exist yet: a project
 * root can legitimately be created after the server starts, and refusing to
 * construct the scope over it would be worse than comparing lexically until it
 * appears.
 */
function canonicalise(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export class FilesystemScope {
  private readonly projectRoots: string[];
  private readonly readablePaths: string[];
  private readonly deniedPaths: string[];

  constructor(private readonly config: FilesystemScopeConfig) {
    // Configured locations are CANONICALISED, not merely resolved.
    //
    // check() realpaths every candidate, so a root that is itself a symlink
    // was being compared against canonical paths it could never contain: every
    // single file in that project failed containment and was refused as "path
    // resolves outside the project through a symlink" -- accusing the user of
    // an escape that was not happening, and making the project unusable by
    // either name. That is not exotic: /tmp is /private/tmp on macOS, and a
    // symlinked ~/work or a checkout under a linked directory does it too.
    //
    // This does not weaken the escape check. A symlink INSIDE the project
    // pointing out still lands outside the canonical root and is still caught.
    this.projectRoots = config.projectRoots.map(canonicalise);
    this.readablePaths = config.additionalReadablePaths.map(canonicalise);
    this.deniedPaths = config.deniedPaths.map(canonicalise);
  }

  /**
   * Decide whether `candidate` may be accessed for `access`.
   *
   * Deny rules are checked first and are absolute: nothing later can re-permit
   * a denied path.
   */
  check(candidate: string, access: ScopeAccess): ScopeDecision {
    const expanded = expandHome(candidate);
    if (expanded === null) {
      return {
        allowed: false,
        reason: `cannot resolve a home-relative path for another user (${candidate})`,
        resolvedPath: candidate,
      };
    }
    const lexical = resolve(expanded);
    const real = resolveExistingAncestor(lexical);

    for (const denied of this.deniedPaths) {
      if (isWithin(denied, lexical) || isWithin(denied, real)) {
        return { allowed: false, reason: `path is inside a denied location (${denied})`, resolvedPath: real };
      }
    }

    // Containment is decided by where the path RESOLVES, because that is the
    // file being opened. Requiring the literal path to be inside the root as
    // well looks stricter and is not: the case it was there to catch --
    // lexically inside, really outside -- already fails this test, and is
    // still reported as an escape below. What it actually excluded was a file
    // genuinely inside the project that happened to be NAMED through a
    // symlink, which is every path in a project whose root is itself a link.
    const inRoot = this.projectRoots.find((root) => isWithin(root, real));
    if (inRoot) return { allowed: true, root: inRoot, resolvedPath: real };

    // An explicitly allowlisted destination is sanctioned however it is
    // reached. This is checked BEFORE the escape branch because a link inside
    // the project pointing at a directory the operator listed as readable was
    // being refused, while the very same file named directly was allowed --
    // the same target, opposite answers, decided by which name was used.
    if (access === 'read') {
      const sanctioned = this.readablePaths.find((p) => isWithin(p, real));
      if (sanctioned) return { allowed: true, root: sanctioned, resolvedPath: real };
    }

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
