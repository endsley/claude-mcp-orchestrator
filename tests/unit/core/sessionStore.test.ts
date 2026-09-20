import { beforeEach, describe, expect, it } from 'vitest';
import { openTestDatabase, type Db } from '../../../src/db/database.js';
import { createNullLogger } from '../../../src/logging/logger.js';
import { ActiveContextStore } from '../../../src/services/sessions/activeContext.js';
import { WorkSessionStore } from '../../../src/services/sessions/sessionStore.js';
import { type OrchestratorError } from '../../../src/types/errors.js';

let db: Db;
let store: WorkSessionStore;

beforeEach(() => {
  db = openTestDatabase(createNullLogger());
  store = new WorkSessionStore(db, 10);
});

function newSession(overrides: Partial<Parameters<WorkSessionStore['create']>[0]> = {}) {
  return store.create({
    instruction: 'Fix the mobile navigation',
    mode: 'work',
    writeCapable: true,
    projectId: 'project:abc',
    ...overrides,
  });
}

describe('WorkSessionStore lifecycle', () => {
  it('creates a session in the starting state', () => {
    const session = newSession();
    expect(session.status).toBe('starting');
    expect(session.id).toMatch(/^ws_/);
    expect(store.get(session.id)?.initialInstruction).toBe('Fix the mobile navigation');
  });

  it('throws a structured error for an unknown id', () => {
    try {
      store.getOrThrow('ws_nope');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as OrchestratorError).code).toBe('SESSION_NOT_FOUND');
    }
  });

  it('rejects an illegal transition', () => {
    const session = newSession();
    store.setStatus(session.id, 'working');
    store.setStatus(session.id, 'completed', { summary: 'done' });
    expect(() => store.setStatus(session.id, 'working')).toThrow(/already finished/i);
  });

  it('records a result and stamps finishedAt exactly once', () => {
    const session = newSession();
    store.setStatus(session.id, 'working');
    const updated = store.setStatus(session.id, 'completed', {
      summary: 'done',
      result: { status: 'completed', summary: 'done', filesChanged: ['a.ts'], warnings: [], artifacts: [] },
    });
    expect(updated.finishedAt).toBeDefined();
    expect(updated.result?.filesChanged).toEqual(['a.ts']);
  });
});

describe('project write locks', () => {
  it('permits exactly one write-capable session per project', () => {
    const first = newSession();
    const second = newSession();
    expect(store.tryAcquireProjectWriteLock('project:abc', first.id)).toEqual({ ok: true });
    const blocked = store.tryAcquireProjectWriteLock('project:abc', second.id);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.heldBy).toBe(first.id);
  });

  it('releases the lock automatically when the session finishes', () => {
    const session = newSession();
    store.tryAcquireProjectWriteLock('project:abc', session.id);
    store.setStatus(session.id, 'working');
    store.setStatus(session.id, 'completed', { summary: 'done' });
    expect(store.getProjectWriteLockHolder('project:abc')).toBeUndefined();
  });

  it('releases orphaned locks left behind by a crash', () => {
    const session = newSession();
    store.tryAcquireProjectWriteLock('project:abc', session.id);
    // Simulate a crash: the row says completed but the lock was never released.
    db.prepare("UPDATE work_sessions SET status = 'completed' WHERE id = ?").run(session.id);
    expect(store.releaseOrphanedLocks()).toBe(1);
    expect(store.getProjectWriteLockHolder('project:abc')).toBeUndefined();
  });
});

describe('pending requests', () => {
  it('returns the single open request for a session', () => {
    const session = newSession();
    const request = store.createPendingRequest({
      workSessionId: session.id,
      type: 'question',
      question: 'Which nav?',
      choices: ['Top', 'Bottom'],
    });
    expect(store.getOpenRequest(session.id)?.requestId).toBe(request.requestId);
    expect(store.getOpenRequest(session.id)?.choices).toEqual(['Top', 'Bottom']);
  });

  // Answering twice is a realistic voice race: the user repeats themselves.
  it('refuses a second answer to the same request', () => {
    const session = newSession();
    const request = store.createPendingRequest({ workSessionId: session.id, type: 'question', question: 'Which?' });
    store.answerPendingRequest(request.requestId, 'Top');
    try {
      store.answerPendingRequest(request.requestId, 'Bottom');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as OrchestratorError).code).toBe('PENDING_REQUEST_ALREADY_ANSWERED');
    }
  });

  it('voids open requests when the session finishes', () => {
    const session = newSession();
    store.createPendingRequest({ workSessionId: session.id, type: 'question', question: 'Which?' });
    store.setStatus(session.id, 'working');
    store.setStatus(session.id, 'cancelled', { summary: 'stopped' });
    expect(store.getOpenRequest(session.id)).toBeUndefined();
  });

  it('refuses to answer a voided request', () => {
    const session = newSession();
    const request = store.createPendingRequest({ workSessionId: session.id, type: 'question', question: 'Which?' });
    store.voidOpenRequests(session.id, 'test');
    expect(() => store.answerPendingRequest(request.requestId, 'Top')).toThrow(/no longer open/i);
  });

  it('finds requests that have been open too long', () => {
    const session = newSession();
    store.createPendingRequest({ workSessionId: session.id, type: 'question', question: 'Which?' });
    const future = new Date(Date.now() + 60_000);
    expect(store.listStaleOpenRequests(1000, future)).toHaveLength(1);
    expect(store.listStaleOpenRequests(120_000, future)).toHaveLength(0);
  });
});

describe('progress events', () => {
  it('returns events in chronological order', () => {
    const session = newSession();
    store.appendProgress(session.id, 'step', 'one');
    store.appendProgress(session.id, 'step', 'two');
    expect(store.listProgress(session.id).map((event) => event.message)).toEqual(['one', 'two']);
  });

  it('caps stored events so a long session cannot grow without bound', () => {
    const session = newSession();
    for (let i = 0; i < 25; i += 1) store.appendProgress(session.id, 'step', `event ${i}`);
    const events = store.listProgress(session.id, 100);
    expect(events).toHaveLength(10);
    expect(events[events.length - 1]?.message).toBe('event 24');
  });
});

describe('ActiveContextStore', () => {
  it('round-trips and merges partial updates', () => {
    const active = new ActiveContextStore(db);
    active.update({ projectId: 'p1' });
    active.update({ workSessionId: 'ws_1' });
    const snapshot = active.get();
    expect(snapshot.projectId).toBe('p1');
    expect(snapshot.workSessionId).toBe('ws_1');
  });

  it('expires stale context rather than treating it as truth', () => {
    const active = new ActiveContextStore(db, 1000);
    active.update({ projectId: 'p1' });
    expect(active.get(new Date(Date.now() + 60_000)).projectId).toBeUndefined();
  });

  it('starts empty', () => {
    expect(new ActiveContextStore(db).get()).toEqual({});
  });
});
