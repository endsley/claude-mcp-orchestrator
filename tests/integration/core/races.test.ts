import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appConfigSchema } from '../../../src/config/schema.js';
import { openTestDatabase, type Db } from '../../../src/db/database.js';
import { KvCache } from '../../../src/db/kvCache.js';
import { createNullLogger } from '../../../src/logging/logger.js';
import { FilesystemScope } from '../../../src/security/paths.js';
import type { WorkerAccumulator, WorkerCallbacks, WorkerLike, WorkerStartOptions } from '../../../src/services/claude/worker.js';
import { ActiveContextStore } from '../../../src/services/sessions/activeContext.js';
import { SessionManager, type ComputerLookup, type ProjectLookup } from '../../../src/services/sessions/manager.js';
import { PendingRequestBroker } from '../../../src/services/sessions/pendingRequestBroker.js';
import { WorkSessionStore } from '../../../src/services/sessions/sessionStore.js';

/**
 * Adversarial lifecycle tests.
 *
 * Everything here models something a real voice user does by accident:
 * repeating themselves, changing their mind mid-action, or talking over the
 * system. Each was written to try to break the state machine.
 */

class FakeWorker implements WorkerLike {
  readonly accumulator: WorkerAccumulator = {
    filesChanged: new Set<string>(),
    git: { committed: false },
    warnings: [],
    lastAssistantText: '',
  };
  sessionId: string | undefined = 'claude-1';
  isRunning = false;
  readonly received: string[] = [];
  interrupted = 0;
  disposed = 0;
  startOptions?: WorkerStartOptions;
  /** Makes interrupt slow, to open a window for a racing call. */
  interruptDelayMs = 0;

  constructor(readonly callbacks: WorkerCallbacks) {}
  start(options: WorkerStartOptions): void {
    this.startOptions = options;
    this.isRunning = true;
    this.callbacks.onSessionId('claude-1');
  }
  send(instruction: string): void {
    if (!this.isRunning) throw new Error('worker not running');
    this.received.push(instruction);
  }
  async interrupt(): Promise<void> {
    this.interrupted += 1;
    if (this.interruptDelayMs > 0) await new Promise((r) => setTimeout(r, this.interruptDelayMs));
  }
  async dispose(): Promise<void> {
    this.disposed += 1;
    this.isRunning = false;
  }
  finish(summary: string): void {
    this.callbacks.onTurnComplete(summary);
  }
  fail(error: Error): void {
    this.callbacks.onError(error as never);
  }
}

const PROJECT = { id: 'project:demo', displayName: 'Demo', path: '/tmp/demo' };
const projects: ProjectLookup = {
  resolve: async () => ({ kind: 'match' as const, project: PROJECT, candidates: [] }),
  get: async () => PROJECT,
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

beforeEach(() => {
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
    securityConfig: { ...config.security, pendingRequestTimeoutMs: 500 },
    logger: createNullLogger(),
    createWorker: ({ callbacks }) => {
      const worker = new FakeWorker(callbacks);
      workers.push(worker);
      return worker;
    },
  });
});

describe('concurrent project writes', () => {
  it('lets exactly one of many simultaneous starts win', async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => manager.startSession({ instruction: `task ${i}`, project: 'demo' })),
    );
    const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    for (const rejected of attempts.filter((a) => a.status === 'rejected')) {
      expect((rejected as PromiseRejectedResult).reason.code).toBe('PROJECT_BUSY');
    }
    // No orphan lock rows, and no session left mid-flight.
    const holders = db.prepare('SELECT COUNT(*) AS n FROM project_write_locks').get() as { n: number };
    expect(holders.n).toBe(1);
  });

  it('does not leave losing sessions in a non-terminal state', async () => {
    await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => manager.startSession({ instruction: `task ${i}`, project: 'demo' })),
    );
    const stuck = store
      .list({ limit: 50 })
      .filter((s) => s.status === 'starting');
    expect(stuck).toHaveLength(0);
  });
});

describe('cancellation races', () => {
  it('handles cancel arriving twice concurrently', async () => {
    const output = await manager.startSession({ instruction: 'x', project: 'demo' });
    const [a, b] = await Promise.all([
      manager.cancel(output.sessionId),
      manager.cancel(output.sessionId),
    ]);
    expect([a.status, b.status]).toContain('cancelled');
    expect(store.getOrThrow(output.sessionId).status).toBe('cancelled');
  });

  // "Stop" spoken just as the work lands. Whichever wins, the outcome must be
  // a truthful terminal state reported calmly - never a thrown
  // invalid-transition error, and never a session left claiming to be working.
  it('reports the truth when a completion lands during a slow interrupt', async () => {
    const output = await manager.startSession({ instruction: 'x', project: 'demo' });
    const worker = workers[0]!;
    worker.interruptDelayMs = 50;

    const cancelling = manager.cancel(output.sessionId);
    // The worker finishes while the interrupt is still in flight.
    await new Promise((r) => setTimeout(r, 10));
    worker.finish('done anyway');

    const result = await cancelling;
    const finalStatus = store.getOrThrow(output.sessionId).status;

    expect(['completed', 'cancelled']).toContain(finalStatus);
    expect(result.status).toBe(finalStatus);
    // The project must not stay locked by a session that is over.
    expect(store.getProjectWriteLockHolder('project:demo')).toBeUndefined();
  });

  it('refuses a follow-up sent immediately after cancel', async () => {
    const output = await manager.startSession({ instruction: 'x', project: 'demo' });
    await manager.cancel(output.sessionId);
    await expect(manager.sendInstruction(output.sessionId, 'more')).rejects.toMatchObject({
      code: 'SESSION_NOT_ACCEPTING_INPUT',
    });
  });

  it('ignores a worker error arriving after cancellation', async () => {
    const output = await manager.startSession({ instruction: 'x', project: 'demo' });
    await manager.cancel(output.sessionId);
    workers[0]?.fail(new Error('late boom'));
    expect(store.getOrThrow(output.sessionId).status).toBe('cancelled');
  });
});

describe('answer races', () => {
  it('only the first of two simultaneous answers is accepted', async () => {
    const output = await manager.startSession({ instruction: 'x', project: 'demo' });
    const asked = workers[0]!.callbacks.askUser('Which?');
    await vi.waitFor(() => expect(store.getOpenRequest(output.sessionId)).toBeDefined());

    const results = await Promise.allSettled([
      Promise.resolve().then(() => manager.respond(output.sessionId, 'A')),
      Promise.resolve().then(() => manager.respond(output.sessionId, 'B')),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await expect(asked).resolves.toMatch(/^[AB]$/);
  });

  it('a late approval after cancellation is rejected, not applied', async () => {
    const output = await manager.startSession({ instruction: 'x', project: 'demo' });
    const approval = workers[0]!.callbacks.requestApproval({
      question: 'Push?',
      toolName: 'Bash',
      toolSummary: 'git push',
      permissionClass: 'EXTERNAL_SIDE_EFFECT',
    });
    await vi.waitFor(() => expect(store.getOpenRequest(output.sessionId)).toBeDefined());
    const requestId = store.getOpenRequest(output.sessionId)!.requestId;

    await manager.cancel(output.sessionId);
    await expect(approval).rejects.toThrow();
    // Answering afterwards must not silently "approve" a dead request.
    expect(() => manager.respond(output.sessionId, 'yes', requestId)).toThrow();
  });

  // A worker blocked on a question nobody answers must not pin the project.
  it('times out an unanswered question and fails closed', async () => {
    const output = await manager.startSession({ instruction: 'x', project: 'demo' });
    const approval = workers[0]!.callbacks.requestApproval({
      question: 'Push?',
      toolName: 'Bash',
      toolSummary: 'git push',
      permissionClass: 'EXTERNAL_SIDE_EFFECT',
    });
    await expect(approval).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(store.getOpenRequest(output.sessionId)).toBeUndefined();
  });
});

describe('duplicate and repeated requests', () => {
  it('repeating the same instruction does not spawn a second worker', async () => {
    const output = await manager.startSession({ instruction: 'Fix nav', project: 'demo' });
    await manager.sendInstruction(output.sessionId, 'Fix nav');
    await manager.sendInstruction(output.sessionId, 'Fix nav');
    expect(workers).toHaveLength(1);
  });

  it('many concurrent status polls stay consistent', async () => {
    const output = await manager.startSession({ instruction: 'x', project: 'demo' });
    const statuses = await Promise.all(
      Array.from({ length: 25 }, async () => manager.getStatus(output.sessionId).status),
    );
    expect(new Set(statuses)).toEqual(new Set(['working']));
  });
});

describe('kv cache', () => {
  it('expires entries and survives corrupt rows', () => {
    const cache = new KvCache(db);
    cache.set('ns', 'k', { a: 1 }, 1000);
    expect(cache.get('ns', 'k')).toEqual({ a: 1 });
    expect(cache.get('ns', 'k', new Date(Date.now() + 5000))).toBeUndefined();

    db.prepare(
      "INSERT INTO kv_cache (namespace, key, value_json, expires_at, updated_at) VALUES ('ns','bad','{not json', NULL, '2026-01-01')",
    ).run();
    // A corrupt row is a miss, never a crash.
    expect(cache.get('ns', 'bad')).toBeUndefined();
  });

  it('prunes expired rows', () => {
    const cache = new KvCache(db);
    cache.set('ns', 'a', 1, 10);
    cache.set('ns', 'b', 2, 999_999);
    expect(cache.pruneExpired(new Date(Date.now() + 1000))).toBe(1);
    expect(cache.get('ns', 'b')).toBe(2);
  });
});
