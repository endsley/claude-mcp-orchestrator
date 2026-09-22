import { beforeEach, describe, expect, it } from 'vitest';
import { appConfigSchema } from '../../../src/config/schema.js';
import { openTestDatabase, type Db } from '../../../src/db/database.js';
import { createNullLogger } from '../../../src/logging/logger.js';
import { FilesystemScope } from '../../../src/security/paths.js';
import type { WorkerAccumulator, WorkerCallbacks, WorkerLike, WorkerStartOptions } from '../../../src/services/claude/worker.js';
import { ActiveContextStore } from '../../../src/services/sessions/activeContext.js';
import { SessionManager, type ComputerLookup, type ProjectLookup } from '../../../src/services/sessions/manager.js';
import { PendingRequestBroker } from '../../../src/services/sessions/pendingRequestBroker.js';
import { WorkSessionStore } from '../../../src/services/sessions/sessionStore.js';

/**
 * claude.sessionTimeoutMs was declared and documented as a wall-clock cap and
 * read nowhere, so a stalled session held its Claude child process and its
 * project write lock for as long as the server ran.
 */

class FakeWorker implements WorkerLike {
  readonly accumulator: WorkerAccumulator = {
    filesChanged: new Set<string>(),
    git: { committed: false },
    warnings: [],
    lastAssistantText: '',
  };
  sessionId: string | undefined;
  isRunning = false;
  interrupted = 0;
  disposed = 0;

  constructor(readonly callbacks: WorkerCallbacks) {}

  start(_options: WorkerStartOptions): void {
    this.isRunning = true;
    this.sessionId = 'claude-session-1';
    this.callbacks.onSessionId(this.sessionId);
  }
  send(_instruction: string): void {}
  async interrupt(): Promise<void> {
    this.interrupted += 1;
  }
  async dispose(): Promise<void> {
    this.disposed += 1;
    this.isRunning = false;
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
    computer: { id: 'c:self', displayName: 'This Machine', isSelf: true, tailscale: { online: true } },
    candidates: [],
  }),
  list: async () => [{ id: 'c:self', displayName: 'This Machine', isSelf: true }],
};

const HOUR = 60 * 60_000;

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
    securityConfig: config.security,
    logger: createNullLogger(),
    createWorker: ({ callbacks }) => {
      const worker = new FakeWorker(callbacks);
      workers.push(worker);
      return worker;
    },
  });
});

describe('session reaper', () => {
  it('leaves a young session completely alone', async () => {
    const { sessionId } = await manager.startSession({ instruction: 'Fix the nav', project: 'demo' });

    expect(manager.reapExpiredSessions(Date.now())).toEqual([]);
    expect(store.getOrThrow(sessionId).status).not.toBe('failed');
    expect(workers[0]!.disposed).toBe(0);
  });

  it('is not fooled by a session that is merely old but under the cap', async () => {
    const { sessionId } = await manager.startSession({ instruction: 'Fix the nav', project: 'demo' });

    // Default cap is two hours; one hour in, nothing should happen.
    expect(manager.reapExpiredSessions(Date.now() + HOUR)).toEqual([]);
    expect(store.getOrThrow(sessionId).status).not.toBe('failed');
  });

  it('fails a session that outlives the wall-clock cap', async () => {
    const { sessionId } = await manager.startSession({ instruction: 'Fix the nav', project: 'demo' });

    const reaped = manager.reapExpiredSessions(Date.now() + 3 * HOUR);

    expect(reaped).toEqual([sessionId]);
    expect(store.getOrThrow(sessionId).status).toBe('failed');
  });

  /** The whole point: a reaped session must not keep its worker or its lock. */
  it('releases the project write lock and disposes the worker', async () => {
    await manager.startSession({ instruction: 'Fix the nav', project: 'demo' });
    expect(store.getProjectWriteLockHolder('project:demo')).toBeDefined();

    manager.reapExpiredSessions(Date.now() + 3 * HOUR);

    expect(store.getProjectWriteLockHolder('project:demo')).toBeUndefined();
    expect(workers[0]!.disposed).toBeGreaterThan(0);
  });

  it('frees the project for a new session afterwards', async () => {
    await manager.startSession({ instruction: 'First', project: 'demo' });
    manager.reapExpiredSessions(Date.now() + 3 * HOUR);

    // Before the reaper existed, this second start was refused forever.
    const second = await manager.startSession({ instruction: 'Second', project: 'demo' });
    expect(store.getOrThrow(second.sessionId).status).not.toBe('cancelled');
  });

  it('is idempotent once a session is terminal', async () => {
    await manager.startSession({ instruction: 'Fix the nav', project: 'demo' });
    const first = manager.reapExpiredSessions(Date.now() + 3 * HOUR);
    const second = manager.reapExpiredSessions(Date.now() + 4 * HOUR);

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  /**
   * Recovery keeps an interrupted session's write lock so it can resume, but
   * nothing re-lists interrupted sessions, so one that is never resumed nor
   * cancelled pinned its project indefinitely.
   */
  it('retires an interrupted session that is past the cap, freeing its lock', async () => {
    const { sessionId } = await manager.startSession({ instruction: 'Fix the nav', project: 'demo' });
    store.setStatus(sessionId, 'interrupted', { summary: 'server restarted' });
    expect(store.getProjectWriteLockHolder('project:demo')).toBeDefined();

    const reaped = manager.reapExpiredSessions(Date.now() + 3 * HOUR);

    expect(reaped).toContain(sessionId);
    expect(store.getProjectWriteLockHolder('project:demo')).toBeUndefined();
  });

  it('leaves a recent interrupted session resumable', async () => {
    const { sessionId } = await manager.startSession({ instruction: 'Fix the nav', project: 'demo' });
    store.setStatus(sessionId, 'interrupted', { summary: 'server restarted' });

    expect(manager.reapExpiredSessions(Date.now() + HOUR)).toEqual([]);
    expect(store.getOrThrow(sessionId).status).toBe('interrupted');
    expect(store.getProjectWriteLockHolder('project:demo')).toBeDefined();
  });

  /**
   * The sweep originally read interrupted sessions through list({ status }),
   * which caps at 20 rows and orders by updated_at DESC. That examined only
   * the most recently touched sessions and never reached the quiet tail -
   * exactly the set a reaper exists to find.
   */
  it('reaps every stale interrupted session, not just the first twenty', () => {
    const total = 25;
    for (let index = 0; index < total; index += 1) {
      const created = store.create({ mode: 'work', writeCapable: false, instruction: `job ${index}` });
      store.setStatus(created.id, 'interrupted', { summary: 'server restarted' });
    }
    expect(store.listAllByStatus('interrupted')).toHaveLength(total);

    const reaped = manager.reapExpiredSessions(Date.now() + 3 * HOUR);

    expect(reaped).toHaveLength(total);
    expect(store.listAllByStatus('interrupted')).toHaveLength(0);
  });

  it('records a timeout as its own cause, not as a worker failure', async () => {
    const { sessionId } = await manager.startSession({ instruction: 'Fix the nav', project: 'demo' });
    manager.reapExpiredSessions(Date.now() + 3 * HOUR);

    const failed = store.getOrThrow(sessionId);
    expect(failed.error?.code).toBe('SESSION_TIMED_OUT');
    // The worker did not cause this, so it must not be blamed for it.
    expect(failed.error?.fromWorker).toBe(false);
  });

  it('startReaper is idempotent and stopReaper is safe to call twice', () => {
    manager.startReaper(60_000);
    manager.startReaper(60_000);
    manager.stopReaper();
    manager.stopReaper();
  });
});

/**
 * A question or approval that nobody answers must not leave the session
 * claiming it is still waiting. The worker fails closed and carries on; the
 * status has to say so too.
 */
describe('status after an unanswered request', () => {
  function buildWithShortTimeout(): { manager: SessionManager; store: WorkSessionStore; workers: FakeWorker[] } {
    const freshDb = openTestDatabase(createNullLogger());
    const freshStore = new WorkSessionStore(freshDb, 100);
    const built: FakeWorker[] = [];
    const config = appConfigSchema.parse({});
    const freshManager = new SessionManager({
      store: freshStore,
      broker: new PendingRequestBroker(freshStore),
      activeContext: new ActiveContextStore(freshDb),
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
      // Short enough to time out inside a test.
      securityConfig: { ...config.security, pendingRequestTimeoutMs: 40 },
      logger: createNullLogger(),
      createWorker: ({ callbacks }) => {
        const worker = new FakeWorker(callbacks);
        built.push(worker);
        return worker;
      },
    });
    return { manager: freshManager, store: freshStore, workers: built };
  }

  it('returns to working when an approval is never answered', async () => {
    const ctx = buildWithShortTimeout();
    const { sessionId } = await ctx.manager.startSession({ instruction: 'Fix the nav', project: 'demo' });

    await expect(
      ctx.workers[0]!.callbacks.requestApproval({
        question: 'Allow the delete?',
        toolName: 'Bash',
        toolSummary: 'rm -rf build',
        permissionClass: 'DESTRUCTIVE',
      }),
    ).rejects.toThrow();

    // Before the fix this stayed 'awaiting_approval' with no request to answer.
    expect(ctx.store.getOrThrow(sessionId).status).toBe('working');
    expect(ctx.store.getOpenRequest(sessionId)).toBeUndefined();
  });

  it('returns to working when a question is never answered', async () => {
    const ctx = buildWithShortTimeout();
    const { sessionId } = await ctx.manager.startSession({ instruction: 'Fix the nav', project: 'demo' });

    await expect(ctx.workers[0]!.callbacks.askUser('Which component?', ['a', 'b'])).rejects.toThrow();

    expect(ctx.store.getOrThrow(sessionId).status).toBe('working');
    expect(ctx.store.getOpenRequest(sessionId)).toBeUndefined();
  });
});
