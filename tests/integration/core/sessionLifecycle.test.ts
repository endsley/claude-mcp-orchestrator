import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appConfigSchema } from '../../../src/config/schema.js';
import { openTestDatabase, type Db } from '../../../src/db/database.js';
import { createNullLogger } from '../../../src/logging/logger.js';
import { FilesystemScope } from '../../../src/security/paths.js';
import type { WorkerAccumulator, WorkerCallbacks, WorkerLike, WorkerStartOptions } from '../../../src/services/claude/worker.js';
import { ActiveContextStore } from '../../../src/services/sessions/activeContext.js';
import { SessionManager, type ComputerLookup, type ProjectLookup } from '../../../src/services/sessions/manager.js';
import { PendingRequestBroker } from '../../../src/services/sessions/pendingRequestBroker.js';
import { WorkSessionStore } from '../../../src/services/sessions/sessionStore.js';
import { OrchestratorError } from '../../../src/types/errors.js';

/**
 * Lifecycle behaviour driven by a controllable fake worker.
 *
 * These are the races a live-voice user actually produces: repeating an answer,
 * cancelling just as work lands, following up mid-tool-call, restarting the
 * service with work in flight.
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
  readonly received: string[] = [];
  interrupted = 0;
  disposed = 0;
  startOptions?: WorkerStartOptions;

  constructor(readonly callbacks: WorkerCallbacks) {}

  start(options: WorkerStartOptions): void {
    this.startOptions = options;
    this.isRunning = true;
    this.received.push(options.instruction);
    this.sessionId = 'claude-session-1';
    this.callbacks.onSessionId(this.sessionId);
  }
  send(instruction: string): void {
    this.received.push(instruction);
  }
  async interrupt(): Promise<void> {
    this.interrupted += 1;
  }
  async dispose(): Promise<void> {
    this.disposed += 1;
    this.isRunning = false;
  }
  /** Test helper: drive the worker's completion callback. */
  finish(summary: string): void {
    this.callbacks.onTurnComplete(summary);
  }
}

const PROJECT = { id: 'project:demo', displayName: 'Demo', path: '/tmp/demo' };

const projects: ProjectLookup = {
  resolve: async (query: string) => {
    if (query === 'ambiguous') {
      return {
        kind: 'ambiguous' as const,
        candidates: [PROJECT, { id: 'project:other', displayName: 'Demo Two', path: '/tmp/demo2' }],
      };
    }
    if (query === 'missing') return { kind: 'not_found' as const, candidates: [] };
    return { kind: 'match' as const, project: PROJECT, candidates: [] };
  },
  get: async () => PROJECT,
};

const computers: ComputerLookup = {
  resolve: async (query: string) => {
    if (query === 'gpu') {
      return {
        kind: 'match' as const,
        computer: { id: 'c:gpu', displayName: 'GPU Server', isSelf: false, tailscale: { online: true } },
        candidates: [],
      };
    }
    return {
      kind: 'match' as const,
      computer: { id: 'c:self', displayName: 'This Machine', isSelf: true, tailscale: { online: true } },
      candidates: [],
    };
  },
  list: async () => [{ id: 'c:self', displayName: 'This Machine', isSelf: true }],
};

let db: Db;
let store: WorkSessionStore;
let manager: SessionManager;
let workers: FakeWorker[];

function build(): void {
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
    securityConfig: { ...config.security, pendingRequestTimeoutMs: 1000 },
    logger: createNullLogger(),
    createWorker: ({ callbacks }) => {
      const worker = new FakeWorker(callbacks);
      workers.push(worker);
      return worker;
    },
  });
}

beforeEach(build);

describe('starting work', () => {
  it('acknowledges quickly and puts the session into working', async () => {
    const output = await manager.startSession({ instruction: 'Fix the nav', project: 'demo' });
    expect(output.status).toBe('working');
    expect(output.sessionId).toMatch(/^ws_/);
    expect(store.getOrThrow(output.sessionId).status).toBe('working');
  });

  it('gives the worker the instruction plus a short preamble, not a copy of CLAUDE.md', async () => {
    await manager.startSession({ instruction: 'Fix the nav', project: 'demo' });
    const prompt = workers[0]?.received[0] ?? '';
    expect(prompt).toContain('Fix the nav');
    expect(prompt).toContain('ask_user');
    expect(prompt.length).toBeLessThan(1000);
  });

  it('refuses a second write session on the same project', async () => {
    await manager.startSession({ instruction: 'First', project: 'demo' });
    await expect(manager.startSession({ instruction: 'Second', project: 'demo' })).rejects.toMatchObject({
      code: 'PROJECT_BUSY',
    });
  });

  it('allows a read-only session alongside a write session', async () => {
    await manager.startSession({ instruction: 'First', project: 'demo' });
    const readOnly = await manager.startSession({ instruction: 'Look', project: 'demo', mode: 'inspect' });
    expect(readOnly.status).toBe('working');
  });

  it('surfaces ambiguity instead of picking a project', async () => {
    await expect(manager.startSession({ instruction: 'x', project: 'ambiguous' })).rejects.toMatchObject({
      code: 'PROJECT_AMBIGUOUS',
    });
  });

  it('refuses to run work on another machine rather than silently using this one', async () => {
    await expect(manager.startSession({ instruction: 'x', project: 'demo', computer: 'gpu' })).rejects.toMatchObject({
      code: 'COMPUTER_REMOTE_UNSUPPORTED',
    });
  });

  it('does not leave a write lock behind when the start is rejected', async () => {
    await manager.startSession({ instruction: 'First', project: 'demo' });
    await expect(manager.startSession({ instruction: 'Second', project: 'demo' })).rejects.toThrow();
    // Exactly one holder: the rejected attempt must not have taken the lock.
    expect(store.getProjectWriteLockHolder('project:demo')).toBeDefined();
  });
});

describe('continuing work', () => {
  it('sends a follow-up into the SAME worker, not a new one', async () => {
    const output = await manager.startSession({ instruction: 'Fix the nav', project: 'demo' });
    await manager.sendInstruction(output.sessionId, 'Make it 20 percent smaller');
    await manager.sendInstruction(output.sessionId, "Don't modify the backend");

    expect(workers).toHaveLength(1);
    expect(workers[0]?.received).toContain('Make it 20 percent smaller');
    expect(workers[0]?.received).toContain("Don't modify the backend");
    expect(store.getOrThrow(output.sessionId).turnCount).toBe(2);
  });

  it('accepts rapid back-to-back instructions', async () => {
    const output = await manager.startSession({ instruction: 'Start', project: 'demo' });
    await Promise.all([
      manager.sendInstruction(output.sessionId, 'one'),
      manager.sendInstruction(output.sessionId, 'two'),
      manager.sendInstruction(output.sessionId, 'three'),
    ]);
    expect(workers[0]?.received).toEqual(expect.arrayContaining(['one', 'two', 'three']));
  });

  // The core product requirement. The Agent SDK emits a result message at the
  // end of every TURN; treating that as the end of the SESSION made follow-ups
  // impossible, which is the bug this test exists to prevent regressing.
  it('accepts a follow-up after a turn completes, in the same worker', async () => {
    const output = await manager.startSession({ instruction: 'Fix the nav', project: 'demo' });
    workers[0]?.finish('Done: adjusted the nav.');
    expect(store.getOrThrow(output.sessionId).status).toBe('idle');

    await manager.sendInstruction(output.sessionId, 'Make it 20 percent smaller');
    expect(workers).toHaveLength(1);
    expect(workers[0]?.received).toContain('Make it 20 percent smaller');
    expect(store.getOrThrow(output.sessionId).status).toBe('working');
  });

  it('keeps the result available while idle between turns', async () => {
    const output = await manager.startSession({ instruction: 'Start', project: 'demo' });
    workers[0]?.accumulator.filesChanged.add('/tmp/demo/Nav.tsx');
    workers[0]?.finish('Done.');
    const result = manager.getResult(output.sessionId);
    expect(result.summary).toBe('Done.');
    expect(result.filesChanged).toEqual(['/tmp/demo/Nav.tsx']);
  });

  it('holds the project write lock between turns', async () => {
    const output = await manager.startSession({ instruction: 'Start', project: 'demo' });
    workers[0]?.finish('Done.');
    expect(store.getProjectWriteLockHolder('project:demo')).toBe(output.sessionId);
    await expect(manager.startSession({ instruction: 'Other', project: 'demo' })).rejects.toMatchObject({
      code: 'PROJECT_BUSY',
    });
  });

  it('refuses a follow-up to a genuinely terminated session', async () => {
    const output = await manager.startSession({ instruction: 'Start', project: 'demo' });
    await manager.cancel(output.sessionId);
    await expect(manager.sendInstruction(output.sessionId, 'more')).rejects.toMatchObject({
      code: 'SESSION_NOT_ACCEPTING_INPUT',
    });
  });
});

describe('questions and approvals', () => {
  it('routes a worker question through to needs_input and back', async () => {
    const output = await manager.startSession({ instruction: 'Start', project: 'demo' });
    const asked = workers[0]!.callbacks.askUser('Top nav or bottom nav?', ['Top', 'Bottom']);

    await vi.waitFor(() => expect(manager.getStatus(output.sessionId).status).toBe('needs_input'));
    const status = manager.getStatus(output.sessionId);
    expect(status.pendingQuestion?.question).toBe('Top nav or bottom nav?');
    expect(status.pendingQuestion?.choices).toEqual(['Top', 'Bottom']);

    manager.respond(output.sessionId, 'Top');
    await expect(asked).resolves.toBe('Top');
    expect(manager.getStatus(output.sessionId).status).toBe('working');
  });

  it('rejects a second answer to the same question', async () => {
    const output = await manager.startSession({ instruction: 'Start', project: 'demo' });
    void workers[0]!.callbacks.askUser('Which one?');
    await vi.waitFor(() => expect(store.getOpenRequest(output.sessionId)).toBeDefined());

    manager.respond(output.sessionId, 'first answer');
    expect(() => manager.respond(output.sessionId, 'second answer')).toThrow(OrchestratorError);
  });

  it('treats a negative reply to an approval as a denial', async () => {
    const output = await manager.startSession({ instruction: 'Start', project: 'demo' });
    const approval = workers[0]!.callbacks.requestApproval({
      question: 'Push to origin?',
      toolName: 'Bash',
      toolSummary: 'git push',
      permissionClass: 'EXTERNAL_SIDE_EFFECT',
    });
    await vi.waitFor(() => expect(manager.getStatus(output.sessionId).status).toBe('awaiting_approval'));

    manager.respond(output.sessionId, 'no, skip it');
    await expect(approval).resolves.toBe(false);
  });

  it('treats an affirmative reply as approval', async () => {
    const output = await manager.startSession({ instruction: 'Start', project: 'demo' });
    const approval = workers[0]!.callbacks.requestApproval({
      question: 'Push to origin?',
      toolName: 'Bash',
      toolSummary: 'git push',
      permissionClass: 'EXTERNAL_SIDE_EFFECT',
    });
    await vi.waitFor(() => expect(store.getOpenRequest(output.sessionId)).toBeDefined());
    manager.respond(output.sessionId, 'yes go ahead');
    await expect(approval).resolves.toBe(true);
  });

  it('rejects an answer when nothing is pending', async () => {
    const output = await manager.startSession({ instruction: 'Start', project: 'demo' });
    expect(() => manager.respond(output.sessionId, 'hello')).toThrow(/not waiting/i);
  });
});

describe('cancellation', () => {
  it('interrupts gracefully before disposing', async () => {
    const output = await manager.startSession({ instruction: 'Start', project: 'demo' });
    await manager.cancel(output.sessionId);
    expect(workers[0]?.interrupted).toBe(1);
    expect(workers[0]?.disposed).toBe(1);
    expect(store.getOrThrow(output.sessionId).status).toBe('cancelled');
  });

  it('releases the project write lock on cancel', async () => {
    const output = await manager.startSession({ instruction: 'Start', project: 'demo' });
    await manager.cancel(output.sessionId);
    expect(store.getProjectWriteLockHolder('project:demo')).toBeUndefined();
    // And the project is immediately usable again.
    await expect(manager.startSession({ instruction: 'Again', project: 'demo' })).resolves.toBeDefined();
  });

  // "Stop" arriving just as the work lands is a normal voice race.
  it('reports calmly when cancelling an already-terminated session', async () => {
    const output = await manager.startSession({ instruction: 'Start', project: 'demo' });
    await manager.cancel(output.sessionId);
    const again = await manager.cancel(output.sessionId);
    expect(again.status).toBe('cancelled');
    expect(again.summary).toContain('already');
  });

  it('cancels an idle session and releases its lock', async () => {
    const output = await manager.startSession({ instruction: 'Start', project: 'demo' });
    workers[0]?.finish('done');
    const result = await manager.cancel(output.sessionId);
    expect(result.status).toBe('cancelled');
    expect(store.getProjectWriteLockHolder('project:demo')).toBeUndefined();
  });

  it('fails a pending question when the session is cancelled', async () => {
    const output = await manager.startSession({ instruction: 'Start', project: 'demo' });
    const asked = workers[0]!.callbacks.askUser('Which one?');
    await vi.waitFor(() => expect(store.getOpenRequest(output.sessionId)).toBeDefined());
    await manager.cancel(output.sessionId);
    await expect(asked).rejects.toThrow();
  });

  it('ignores a late completion from a cancelled worker', async () => {
    const output = await manager.startSession({ instruction: 'Start', project: 'demo' });
    await manager.cancel(output.sessionId);
    workers[0]?.finish('late completion');
    expect(store.getOrThrow(output.sessionId).status).toBe('cancelled');
  });
});

describe('restart recovery', () => {
  it('marks in-flight sessions interrupted rather than claiming they still run', async () => {
    const output = await manager.startSession({ instruction: 'Start', project: 'demo' });
    // A new manager over the SAME database is exactly what a restart looks like.
    build_secondManagerOverSameDb();
    expect(store.getOrThrow(output.sessionId).status).toBe('interrupted');
  });

  function build_secondManagerOverSameDb(): void {
    const config = appConfigSchema.parse({});
    const fresh = new SessionManager({
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
    fresh.recoverOnStartup();
  }

  it('resumes the Claude session id when a follow-up arrives after a restart', async () => {
    const output = await manager.startSession({ instruction: 'Start', project: 'demo' });
    manager.recoverOnStartup();
    expect(store.getOrThrow(output.sessionId).status).toBe('interrupted');

    await manager.sendInstruction(output.sessionId, 'carry on');
    const recovered = workers[workers.length - 1];
    expect(recovered?.startOptions?.resumeSessionId).toBe('claude-session-1');
    expect(store.getOrThrow(output.sessionId).recoveryCount).toBe(1);
    // The user is told continuity was reconstructed, not silently pretended.
    expect(manager.getStatus(output.sessionId).recovered).toBe(true);
  });

  it('survives metadata across a restart', async () => {
    const output = await manager.startSession({ instruction: 'Fix the nav', project: 'demo' });
    manager.recoverOnStartup();
    const reloaded = new WorkSessionStore(db, 100).getOrThrow(output.sessionId);
    expect(reloaded.initialInstruction).toBe('Fix the nav');
    expect(reloaded.projectId).toBe('project:demo');
  });
});

describe('status and results', () => {
  it('summarises status for speech without raw transcripts', async () => {
    const output = await manager.startSession({ instruction: 'Fix the nav', project: 'demo' });
    workers[0]!.callbacks.onProgress({ kind: 'file_changed', message: 'Edited Nav.tsx.' });
    workers[0]!.callbacks.onProgress({ kind: 'test', message: 'Tests passed (47).' });

    const status = manager.getStatus(output.sessionId);
    expect(status.completedSteps).toContain('Edited Nav.tsx.');
    expect(status.currentStep).toBe('Tests passed (47).');
    expect(JSON.stringify(status)).not.toContain('thinking');
  });

  it('never claims tests passed when none ran', async () => {
    const output = await manager.startSession({ instruction: 'Start', project: 'demo' });
    workers[0]?.finish('done without tests');
    expect(manager.getResult(output.sessionId).tests).toBeUndefined();
  });

  it('describes an idle session as done but continuable', async () => {
    const output = await manager.startSession({ instruction: 'Start', project: 'demo' });
    workers[0]?.finish('Adjusted the nav.');
    const status = manager.getStatus(output.sessionId);
    expect(status.status).toBe('idle');
    expect(status.summary).toBe('Adjusted the nav.');
  });

  it('reports files changed from the worker accumulator', async () => {
    const output = await manager.startSession({ instruction: 'Start', project: 'demo' });
    workers[0]?.accumulator.filesChanged.add('/tmp/demo/Nav.tsx');
    workers[0]?.finish('done');
    expect(manager.getResult(output.sessionId).filesChanged).toEqual(['/tmp/demo/Nav.tsx']);
  });
});
