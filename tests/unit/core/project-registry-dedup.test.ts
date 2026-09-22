import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectRegistry } from '../../../src/services/projects/project-registry.js';

/**
 * Concurrent callers of list() share one scan.
 *
 * Without this, the cache check and the scan are not atomic, so every caller
 * arriving before the first scan finishes starts its own. Measured on the real
 * 28-project corpus with the OS page cache warmed first, so both sides of the
 * comparison were on equal footing: before, 1 caller 94ms / 3 callers 285ms /
 * 5 callers 454ms -- linear in caller count. After: 137ms / 143ms / 143ms.
 *
 * The timing is the evidence but not the test, because a timing test on a
 * shared box is a flake. What is asserted here is the thing the timing was
 * evidence OF: the scan runs once.
 */
let dir: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function registry(): ProjectRegistry {
  dir = mkdtempSync(join(tmpdir(), 'registry-dedup-'));
  for (const name of ['alpha', 'beta', 'gamma']) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'package.json'), JSON.stringify({ name }));
  }
  return new ProjectRegistry({
    roots: [dir],
    metadata: {},
    defaultComputerId: 'self',
    cacheTtlMs: 60_000,
    maxDepth: 2,
    ignoreDirs: [],
  });
}

/** The private scan, reached deliberately: it is the thing being counted. */
function spyOnScan(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(ProjectRegistry.prototype as unknown as { scanProjects: () => Promise<unknown> }, 'scanProjects');
}

describe('ProjectRegistry.list', () => {
  it('scans once for five concurrent cold callers', async () => {
    const scan = spyOnScan();
    const subject = registry();

    const results = await Promise.all(Array.from({ length: 5 }, () => subject.list()));

    expect(scan).toHaveBeenCalledTimes(1);
    // And every caller still got the full answer, not an empty one.
    for (const result of results) {
      expect(result.map((project) => project.displayName).sort()).toEqual(['alpha', 'beta', 'gamma']);
    }
  });

  it('gives concurrent callers independent objects', async () => {
    const subject = registry();
    const [first, second] = await Promise.all([subject.list(), subject.list()]);

    first[0]!.displayName = 'MUTATED';
    expect(second[0]!.displayName).not.toBe('MUTATED');
    // And the shared cache was not poisoned by that mutation either.
    const later = await subject.list();
    expect(later[0]!.displayName).not.toBe('MUTATED');
  });

  it('serves the cache without scanning again', async () => {
    const subject = registry();
    await subject.list();
    const scan = spyOnScan();
    await subject.list();
    expect(scan).not.toHaveBeenCalled();
  });

  it('lets forceRefresh scan even while another scan is in flight', async () => {
    // A forceRefresh caller is asking for state newer than the in-flight scan
    // began with, so joining it would answer the wrong question.
    const scan = spyOnScan();
    const subject = registry();
    await Promise.all([subject.list(), subject.list(true)]);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('does not wedge after a failed scan', async () => {
    const subject = registry();
    const scan = spyOnScan().mockRejectedValueOnce(new Error('disk went away'));

    await expect(subject.list()).rejects.toThrow('disk went away');

    // The in-flight entry must be cleared, or every later call inherits the
    // rejection and the registry is permanently broken.
    scan.mockRestore();
    const recovered = await subject.list();
    expect(recovered).toHaveLength(3);
  });
});
