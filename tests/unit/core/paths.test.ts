import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FilesystemScope, isWithin, resolveExistingAncestor } from '../../../src/security/paths.js';

let root: string;
let projectRoot: string;
let outside: string;
let scope: FilesystemScope;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'scope-test-'));
  projectRoot = join(root, 'project');
  outside = join(root, 'outside');
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(projectRoot, 'src', 'a.ts'), 'export {};');
  writeFileSync(join(outside, 'secret.txt'), 'top secret');
  // The classic escape: a symlink inside the project pointing out of it.
  symlinkSync(outside, join(projectRoot, 'escape'));

  scope = new FilesystemScope({
    projectRoots: [projectRoot],
    additionalReadablePaths: [],
    deniedPaths: [join(projectRoot, 'private')],
    allowOutsideProjectRead: false,
    allowOutsideProjectWrite: false,
  });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('isWithin', () => {
  it('accepts a child and the root itself', () => {
    expect(isWithin('/a/b', '/a/b/c')).toBe(true);
    expect(isWithin('/a/b', '/a/b')).toBe(true);
  });
  it('rejects siblings, parents and traversal', () => {
    expect(isWithin('/a/b', '/a/c')).toBe(false);
    expect(isWithin('/a/b', '/a')).toBe(false);
    expect(isWithin('/a/b', '/a/b/../../etc')).toBe(false);
  });
  it('is not fooled by a shared name prefix', () => {
    expect(isWithin('/a/proj', '/a/project-other/file')).toBe(false);
  });
});

describe('FilesystemScope', () => {
  it('allows reads and writes inside the project', () => {
    expect(scope.check(join(projectRoot, 'src', 'a.ts'), 'read').allowed).toBe(true);
    expect(scope.check(join(projectRoot, 'src', 'new.ts'), 'write').allowed).toBe(true);
  });

  it('blocks path traversal out of the project', () => {
    const decision = scope.check(join(projectRoot, '..', 'outside', 'secret.txt'), 'read');
    expect(decision.allowed).toBe(false);
  });

  it('blocks a symlink that escapes the project root', () => {
    const decision = scope.check(join(projectRoot, 'escape', 'secret.txt'), 'read');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('symlink');
  });

  it('blocks explicitly denied paths inside the project', () => {
    const decision = scope.check(join(projectRoot, 'private', 'x'), 'read');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('denied');
  });

  it('permits writing a file that does not exist yet', () => {
    // resolveExistingAncestor must judge by the parent dir, or every new file
    // would be rejected.
    const decision = scope.check(join(projectRoot, 'src', 'brand', 'new.ts'), 'write');
    expect(decision.allowed).toBe(true);
  });

  it('honours allowOutsideProjectRead when explicitly enabled', () => {
    const permissive = new FilesystemScope({
      projectRoots: [projectRoot],
      additionalReadablePaths: [],
      deniedPaths: [],
      allowOutsideProjectRead: true,
      allowOutsideProjectWrite: false,
    });
    expect(permissive.check(join(outside, 'secret.txt'), 'read').allowed).toBe(true);
    expect(permissive.check(join(outside, 'secret.txt'), 'write').allowed).toBe(false);
  });
});

describe('resolveExistingAncestor', () => {
  it('resolves through a symlinked directory', () => {
    const resolved = resolveExistingAncestor(join(projectRoot, 'escape', 'secret.txt'));
    expect(resolved).toContain('outside');
  });
  it('returns an absolute path for a wholly non-existent path', () => {
    expect(resolveExistingAncestor('/definitely/not/here/file.txt')).toBe('/definitely/not/here/file.txt');
  });
});

/**
 * The deny loop tests BOTH the lexical path and the symlink-resolved one.
 * Every existing deny test used a lexically-denied path, so dropping the
 * realpath arm passed the whole suite: a symlink inside the project pointing
 * into a denied directory would then have resolved to allowed.
 */
describe('denied locations cannot be reached through a symlink', () => {
  let symRoot: string;
  let symProject: string;
  let symScope: FilesystemScope;

  beforeAll(() => {
    symRoot = mkdtempSync(join(tmpdir(), 'scope-deny-'));
    symProject = join(symRoot, 'project');
    const secrets = join(symProject, 'private');
    mkdirSync(secrets, { recursive: true });
    writeFileSync(join(secrets, 'key.pem'), 'PRIVATE KEY');
    // Lexically OUTSIDE private/, but resolves inside it.
    symlinkSync(secrets, join(symProject, 'shortcut'));

    symScope = new FilesystemScope({
      projectRoots: [symProject],
      additionalReadablePaths: [],
      deniedPaths: [secrets],
      allowOutsideProjectRead: false,
      allowOutsideProjectWrite: false,
    });
  });

  it('refuses the denied directory named directly', () => {
    const decision = symScope.check(join(symProject, 'private', 'key.pem'), 'read');
    expect(decision.allowed).toBe(false);
  });

  it('refuses a symlink whose target is inside the denied directory', () => {
    // Lexical check alone cannot catch this: the candidate path contains no
    // "private" segment at all.
    const viaLink = join(symProject, 'shortcut', 'key.pem');
    expect(viaLink).not.toContain('private');

    const decision = symScope.check(viaLink, 'read');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/denied/i);
  });

  it('still allows an ordinary file in the project', () => {
    writeFileSync(join(symProject, 'ok.ts'), 'export {};');
    expect(symScope.check(join(symProject, 'ok.ts'), 'read').allowed).toBe(true);
  });
});

/**
 * A project root that is itself a symlink.
 *
 * check() canonicalises every candidate, so a root left un-canonicalised could
 * never contain any of them: EVERY file in the project was refused, with a
 * message accusing the user of escaping through a symlink. Not exotic -- /tmp
 * is /private/tmp on macOS, and a symlinked ~/work or a checkout under a
 * linked directory does the same thing. The project was unusable under either
 * name, since the real path was then "outside every configured project root".
 *
 * Found by asking what the system wrongly REFUSES (endsley/bodhi-inbox#37),
 * the third time that inversion has paid on this repo.
 */
describe('a project root reached through a symlink', () => {
  let base: string;
  let realRoot: string;
  let linkedRoot: string;
  let outside: string;
  let shared: string;
  let denied: string;
  let scope: FilesystemScope;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'symlinked-root-'));
    realRoot = join(base, 'real-project');
    mkdirSync(join(realRoot, 'src'), { recursive: true });
    writeFileSync(join(realRoot, 'src', 'a.ts'), 'export {};');

    linkedRoot = join(base, 'linked-project');
    symlinkSync(realRoot, linkedRoot);

    outside = join(base, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(outside, join(realRoot, 'escape'));

    denied = join(realRoot, 'private');
    mkdirSync(denied, { recursive: true });
    writeFileSync(join(denied, 'k.pem'), 'key');
    symlinkSync(denied, join(realRoot, 'shortcut'));

    shared = join(base, 'shared-docs');
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, 'guide.md'), '# guide');
    symlinkSync(shared, join(realRoot, 'docs'));

    // The root is configured BY ITS LINK, which is the whole point.
    scope = new FilesystemScope({
      projectRoots: [linkedRoot],
      additionalReadablePaths: [shared],
      deniedPaths: [denied],
      allowOutsideProjectRead: false,
      allowOutsideProjectWrite: false,
    });
  });

  it('allows the project files by the linked name', () => {
    expect(scope.check(join(linkedRoot, 'src', 'a.ts'), 'read').allowed).toBe(true);
    expect(scope.check(join(linkedRoot, 'src', 'b.ts'), 'write').allowed).toBe(true);
  });

  it('allows the same files by their real name', () => {
    // Refusing this was the second half of the bug: unusable either way.
    expect(scope.check(join(realRoot, 'src', 'a.ts'), 'read').allowed).toBe(true);
  });

  it('allows an explicitly readable target however it is reached', () => {
    // The same file, opposite answers, decided by which name was used: through
    // the in-project link it was refused, named directly it was allowed.
    expect(scope.check(join(realRoot, 'docs', 'guide.md'), 'read').allowed).toBe(true);
    expect(scope.check(join(shared, 'guide.md'), 'read').allowed).toBe(true);
  });

  it('still refuses a symlink that leaves the project', () => {
    const decision = scope.check(join(realRoot, 'escape', 'secret.txt'), 'read');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/symlink/i);
  });

  it('still refuses the denied directory, by either name', () => {
    expect(scope.check(join(denied, 'k.pem'), 'read').allowed).toBe(false);
    expect(scope.check(join(realRoot, 'shortcut', 'k.pem'), 'read').allowed).toBe(false);
  });

  it('still refuses writes to a read-only allowlisted path', () => {
    // Readable is not writable, and the new ordering must not blur that.
    expect(scope.check(join(shared, 'guide.md'), 'write').allowed).toBe(false);
  });

  it('still refuses somewhere outside everything', () => {
    expect(scope.check(join(outside, 'secret.txt'), 'read').allowed).toBe(false);
    expect(scope.check(join(realRoot, '..', 'outside', 'secret.txt'), 'read').allowed).toBe(false);
  });
});

describe('the deny list is checked on both the literal and the resolved path', () => {
  it('refuses a link INSIDE a denied directory that points outside it', () => {
    // The two arms catch opposite tricks. The resolved arm stops a link
    // elsewhere pointing INTO the denied directory; this one stops a link
    // inside it pointing OUT, which would otherwise be an allowed read of
    // something the operator placed off limits. Found by mutation: removing
    // the literal arm passed every existing test.
    const base = mkdtempSync(join(tmpdir(), 'deny-both-arms-'));
    const project = join(base, 'project');
    const secrets = join(project, 'private');
    mkdirSync(secrets, { recursive: true });
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'notes.txt'), 'notes');
    // A link that lives in the denied directory and points out of it.
    symlinkSync(join(elsewhere, 'notes.txt'), join(secrets, 'outward'));

    const scope = new FilesystemScope({
      projectRoots: [project],
      additionalReadablePaths: [elsewhere],
      deniedPaths: [secrets],
      allowOutsideProjectRead: false,
      allowOutsideProjectWrite: false,
    });

    const decision = scope.check(join(secrets, 'outward'), 'read');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/denied/i);
  });
});
