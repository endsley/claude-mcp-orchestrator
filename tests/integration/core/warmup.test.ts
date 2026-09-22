import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApplication, type Application } from '../../../src/app.js';
import { createNullLogger } from '../../../src/logging/logger.js';

/**
 * Warming the project registry at boot.
 *
 * Measured on the real host, 28 projects across two roots: the first scan in a
 * fresh process with a cold OS page cache took 7.6 SECONDS, a second scan 284ms,
 * a cached one 1ms. Unwarmed, the projects context provider (2500ms timeout)
 * did not merely wait on the first turn after a cold boot -- it timed out and
 * dropped project context silently, while start_work_session waited the full
 * scan because list() has no timeout.
 *
 * These tests cannot reproduce a 7.6s filesystem, and pretending otherwise with
 * a fake clock would prove nothing about the real cost. What they pin is the
 * contract that makes the warm-up safe to call from startup: it returns
 * immediately, it fills the cache, and it cannot take the process down.
 */
let dir: string;
let app: Application;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'warmup-test-'));
  const projects = join(dir, 'projects');
  for (const name of ['alpha', 'beta', 'gamma']) {
    mkdirSync(join(projects, name), { recursive: true });
    writeFileSync(join(projects, name, 'package.json'), JSON.stringify({ name }));
  }
  writeFileSync(
    join(dir, 'orchestrator.yaml'),
    [
      'server:',
      '  host: 127.0.0.1',
      '  port: 0',
      '  auth:',
      '    mode: none',
      'database:',
      `  path: ${join(dir, 'test.sqlite')}`,
      'projects:',
      '  roots:',
      `    - ${projects}`,
      'memory:',
      '  enabled: false',
      '  provider: none',
      'tailscale:',
      '  enabled: false',
      '',
    ].join('\n'),
  );
  app = await buildApplication({
    configPath: join(dir, 'orchestrator.yaml'),
    cwd: dir,
    env: {},
    logger: createNullLogger(),
  });
}, 60_000);

afterAll(async () => {
  await app?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('Application.warmUp', () => {
  it('returns synchronously, so it cannot delay the port opening', () => {
    // index.ts calls this on the startup path with no await. If it ever became
    // blocking, boot would stall behind a filesystem walk.
    const started = Date.now();
    app.warmUp();
    expect(Date.now() - started).toBeLessThan(50);
  });

  it('performs the scan itself, rather than leaving it for the first request', async () => {
    // The assertion has to watch the warm-up DO the scan. An earlier version of
    // this test polled projects.list() to see whether the cache was warm -- but
    // that call warms the cache itself, so it passed with the warm-up disabled.
    // Same mistake as two other tests this session: the check performed the work
    // it was supposed to be checking for.
    const listSpy = vi.spyOn(app.services.projects, 'list');
    try {
      expect(listSpy).not.toHaveBeenCalled();
      app.warmUp();
      await vi.waitFor(() => {
        expect(listSpy).toHaveBeenCalledTimes(1);
      }, { timeout: 20_000 });
    } finally {
      listSpy.mockRestore();
    }

    // And the result really is usable afterwards.
    const cached = await app.services.projects.list();
    expect(cached.map((project) => project.displayName).sort()).toEqual(['alpha', 'beta', 'gamma']);
  }, 30_000);

  it('swallows a failing scan instead of crashing the process', async () => {
    // A warm cache is an optimisation, not a precondition, and this runs where
    // an unhandled rejection would take down a server that is already serving.
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const listSpy = vi
      .spyOn(app.services.projects, 'list')
      .mockRejectedValue(new Error('disk went away'));
    try {
      expect(() => app.warmUp()).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(listSpy).toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      listSpy.mockRestore();
      process.off('unhandledRejection', unhandled);
    }
  });
});
