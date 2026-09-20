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
