import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appConfigSchema } from '../../../src/config/schema.js';
import { openDatabase, openTestDatabase, type Db } from '../../../src/db/database.js';
import { createNullLogger } from '../../../src/logging/logger.js';
import { FilesystemScope } from '../../../src/security/paths.js';
import type { WorkerAccumulator, WorkerCallbacks, WorkerLike, WorkerStartOptions } from '../../../src/services/claude/worker.js';
import { ActiveContextStore } from '../../../src/services/sessions/activeContext.js';
import { SessionManager, type ComputerLookup, type ProjectLookup } from '../../../src/services/sessions/manager.js';
import { PendingRequestBroker } from '../../../src/services/sessions/pendingRequestBroker.js';
import { WorkSessionStore } from '../../../src/services/sessions/sessionStore.js';
import { orchestratorError } from '../../../src/types/errors.js';

class FakeWorker implements WorkerLike {
  readonly accumulator: WorkerAccumulator = {
    filesChanged: new Set<string>(),
    git: { committed: false },
    warnings: [],
    lastAssistantText: '',
  };
  sessionId: string | undefined = 'claude-1';
  isRunning = false;
  startOptions?: WorkerStartOptions;
  /** Simulates a worker that dies immediately on start. */
  failOnStart = false;

  constructor(readonly callbacks: WorkerCallbacks) {}
  start(options: WorkerStartOptions): void {
    if (this.failOnStart) throw new Error('worker process died');
    this.startOptions = options;
    this.isRunning = true;
  }
  send(): void {}
  async interrupt(): Promise<void> {}
  async dispose(): Promise<void> {
    this.isRunning = false;
  }
  crash(message: string): void {
    this.callbacks.onError(orchestratorError('CLAUDE_WORKER_FAILED', message) as never);
  }
}

const PROJECT = { id: 'project:demo', displayName: 'Demo', path: '/tmp/demo' };
let projectMissing = false;

const projects: ProjectLookup = {
  resolve: async () => ({ kind: 'match' as const, project: PROJECT, candidates: [] }),
  get: async () => {
    if (projectMissing) throw orchestratorError('PROJECT_NOT_FOUND', 'project was deleted');
    return PROJECT;
  },
};
const computers: ComputerLookup = {
  resolve: async () => ({
    kind: 'match' as const,
    computer: { id: 'c:self', displayName: 'Self', isSelf: true, tailscale: { online: true } },
    candidates: [],
  }),
  list: async () => [{ id: 'c:self', displayName: 'Self', isSelf: true }],
};

let db: Db;
let store: WorkSessionStore;
let manager: SessionManager;
let workers: FakeWorker[];
let failNextStart = false;

beforeEach(() => {
  projectMissing = false;
  failNextStart = false;
  db = openTestDatabase(createNullLogger());
  store = new WorkSessionStore(db, 100);
  workers = [];
  const config = appConfigSchema.parse({});
  manager = new SessionManager({
    store,
    broker: new PendingRequestBroker(store),
    activeContext: new ActiveContextStore(db),
    projects,
    computers,
    scope: new FilesystemScope({
      projectRoots: ['/tmp/demo'],
      additionalReadablePaths: [],
      deniedPaths: [],
      allowOutsideProjectRead: false,
      allowOutsideProjectWrite: false,
    }),
    claudeConfig: config.claude,
    securityConfig: config.security,
    logger: createNullLogger(),
    createWorker: ({ callbacks }) => {
      const worker = new FakeWorker(callbacks);
      worker.failOnStart = failNextStart;
      workers.push(worker);
      return worker;
    },
  });
});

describe('worker failure', () => {
  it('fails the session cleanly when the worker cannot start', async () => {
    failNextStart = true;
    await expect(manager.startSession({ instruction: 'x', project: 'demo' })).rejects.toThrow();
    const sessions = store.list({ limit: 5 });
    expect(sessions[0]?.status).toBe('failed');
    // A failed start must not leave the project locked.
    expect(store.getProjectWriteLockHolder('project:demo')).toBeUndefined();
  });

  it('records a worker crash as a failed session with a reason', async () => {
    const output = await manager.startSession({ instruction: 'x', project: 'demo' });
    workers[0]?.crash('claude exited unexpectedly');
    const session = store.getOrThrow(output.sessionId);
    expect(session.status).toBe('failed');
    expect(session.error?.message).toContain('claude exited');
    expect(store.getProjectWriteLockHolder('project:demo')).toBeUndefined();
  });

  it('reports status for a failed session without throwing', async () => {
    const output = await manager.startSession({ instruction: 'x', project: 'demo' });
    workers[0]?.crash('boom');
    const status = manager.getStatus(output.sessionId);
    expect(status.status).toBe('failed');
    expect(status.summary).toContain('boom');
  });
});

describe('project moved or deleted', () => {
  it('still recovers a worker when the project path is gone', async () => {
    const output = await manager.startSession({ instruction: 'x', project: 'demo' });
    manager.recoverOnStartup();
    projectMissing = true;
    // Falls back to the process cwd rather than refusing to continue.
    await expect(manager.sendInstruction(output.sessionId, 'carry on')).resolves.toBeDefined();
  });
});

describe('unusual instruction text', () => {
  const nasty = [
    'Fix the nav 🙂 with émojis and ünïcode',
    '日本語の指示です',
    'a'.repeat(20_000),
    'line one\nline two\nline three',
    'quotes "double" and \'single\' and `backtick`',
    'null byte \u0000 inside',
  ];

  it('accepts and stores unusual instruction text intact', async () => {
    for (const [index, instruction] of nasty.entries()) {
      const output = await manager.startSession({ instruction, mode: 'inspect' });
      const session = store.getOrThrow(output.sessionId);
      expect(session.initialInstruction, `case ${index}`).toBe(instruction);
      // The spoken summary must stay short regardless of input size.
      expect(output.summary.length).toBeLessThan(400);
    }
  });

  it('keeps status summaries bounded for enormous instructions', async () => {
    const output = await manager.startSession({ instruction: 'z'.repeat(50_000), mode: 'inspect' });
    expect(manager.getStatus(output.sessionId).summary.length).toBeLessThan(400);
  });
});

describe('sqlite concurrency', () => {
  it('serialises writes from two connections to the same WAL database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wal-test-'));
    try {
      const path = join(dir, 'concurrent.sqlite');
      const first = openDatabase({ path, walMode: true, busyTimeoutMs: 5000 }, createNullLogger());
      const second = new Database(path);
      second.pragma('busy_timeout = 5000');

      const storeA = new WorkSessionStore(first, 100);
      const sessionA = storeA.create({ instruction: 'from A', mode: 'inspect', writeCapable: false });

      // A second connection must see the committed row and be able to write.
      const seen = second.prepare('SELECT id FROM work_sessions WHERE id = ?').get(sessionA.id);
      expect(seen).toBeDefined();
      second
        .prepare('UPDATE work_sessions SET current_summary = ? WHERE id = ?')
        .run('written by B', sessionA.id);
      expect(storeA.getOrThrow(sessionA.id).currentSummary).toBe('written by B');

      second.close();
      first.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resource cleanup on failure', () => {
  it('disposes the worker when a session fails, leaving no live process', async () => {
    const output = await manager.startSession({ instruction: 'x', project: 'demo' });
    const worker = workers[0]!;
    expect(worker.isRunning).toBe(true);
    worker.crash('claude died');
    // dispose() is fired without awaiting; give the microtask queue a turn.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(worker.isRunning).toBe(false);
    expect(store.getOrThrow(output.sessionId).status).toBe('failed');
  });

  it('voids a pending question when the session fails', async () => {
    const output = await manager.startSession({ instruction: 'x', project: 'demo' });
    store.createPendingRequest({ workSessionId: output.sessionId, type: 'question', question: 'Which?' });
    workers[0]?.crash('boom');
    expect(store.getOpenRequest(output.sessionId)).toBeUndefined();
  });

  it('frees the project so new work can start after a failure', async () => {
    const first = await manager.startSession({ instruction: 'x', project: 'demo' });
    workers[0]?.crash('boom');
    expect(store.getOrThrow(first.sessionId).status).toBe('failed');
    await expect(manager.startSession({ instruction: 'retry', project: 'demo' })).resolves.toBeDefined();
  });
});
