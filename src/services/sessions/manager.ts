import type { ClaudeWorkerConfig, SecurityConfig } from '../../config/schema.js';
import type { InitialContextSection } from '../../types/context.js';
import type { Logger } from '../../logging/logger.js';
import type { FilesystemScope } from '../../security/paths.js';
import { OrchestratorError, orchestratorError } from '../../types/errors.js';
import type { PermissionAction, PermissionClass } from '../../types/permissions.js';
import {
  isTerminalStatus,
  type WorkResult,
  type WorkSession,
  type WorkSessionMode,
  type WorkSessionStatusView,
} from '../../types/sessions.js';
import { ClaudeWorker, type WorkerCallbacks, type WorkerLike, type WorkerProgress } from '../claude/worker.js';
import { type ActiveContextStore } from './activeContext.js';
import { type PendingRequestBroker } from './pendingRequestBroker.js';
import { acceptsInstruction } from './stateMachine.js';
import type { WorkSessionStore } from './sessionStore.js';

/** Minimal view of the project service this manager depends on. */
export interface ProjectLookup {
  resolve(query: string, computerId?: string): Promise<{
    kind: 'match' | 'ambiguous' | 'not_found';
    project?: { id: string; displayName: string; path: string };
    candidates: Array<{ id: string; displayName: string; path: string }>;
  }>;
  get(idOrPath: string): Promise<{ id: string; displayName: string; path: string }>;
}

/** Minimal view of the computer service this manager depends on. */
export interface ComputerLookup {
  resolve(query: string): Promise<{
    kind: 'match' | 'ambiguous' | 'not_found';
    computer?: { id: string; displayName: string; isSelf: boolean; tailscale: { online?: boolean } };
    candidates: Array<{ id: string; displayName: string }>;
  }>;
  list(forceRefresh?: boolean): Promise<Array<{ id: string; displayName: string; isSelf: boolean }>>;
}

export interface StartSessionInput {
  instruction: string;
  project?: string;
  computer?: string;
  mode?: WorkSessionMode;
  /** Extra context the caller wants handed to the worker verbatim. */
  context?: string;
}

export interface StartSessionOutput {
  sessionId: string;
  status: WorkSession['status'];
  summary: string;
  project?: string;
  computer?: string;
  warnings: string[];
}

export interface SessionManagerDeps {
  store: WorkSessionStore;
  broker: PendingRequestBroker;
  activeContext: ActiveContextStore;
  projects: ProjectLookup;
  computers: ComputerLookup;
  scope: FilesystemScope;
  claudeConfig: ClaudeWorkerConfig;
  securityConfig: SecurityConfig;
  logger: Logger;
  /** Overridable so tests can inject a fake worker. */
  createWorker?: (args: WorkerFactoryArgs) => WorkerLike;
}

export interface WorkerFactoryArgs {
  workSessionId: string;
  config: ClaudeWorkerConfig;
  scope: FilesystemScope;
  policy: (cls: PermissionClass) => PermissionAction;
  callbacks: WorkerCallbacks;
  logger: Logger;
}

/**
 * Owns the lifecycle of every work session.
 *
 * Workers live in a process-local map while their metadata lives in SQLite.
 * That split is deliberate: the metadata has to survive a restart, but a
 * half-dead child process must not, so recovery reconstructs workers from
 * durable state rather than trying to adopt orphans.
 */
export class SessionManager {
  /** Interrupted sessions older than this stop counting as current work. */
  private static readonly INTERRUPTED_CONTEXT_WINDOW_MS = 60 * 60 * 1000;

  private readonly workers = new Map<string, WorkerLike>();
  private readonly store: WorkSessionStore;
  private readonly broker: PendingRequestBroker;
  private readonly activeContext: ActiveContextStore;
  private readonly logger: Logger;

  private reaperTimer?: NodeJS.Timeout;

  constructor(private readonly deps: SessionManagerDeps) {
    this.store = deps.store;
    this.broker = deps.broker;
    this.activeContext = deps.activeContext;
    this.logger = deps.logger.child({ component: 'sessions' });
  }

  private policy(): (cls: PermissionClass) => PermissionAction {
    const approvals = this.deps.securityConfig.approvals;
    return (cls) => approvals[cls];
  }

  // ------------------------------------------------------------------ start

  async startSession(input: StartSessionInput): Promise<StartSessionOutput> {
    const warnings: string[] = [];
    const mode: WorkSessionMode = input.mode ?? 'work';
    const writeCapable = mode === 'work';

    const computer = await this.resolveComputer(input.computer);
    if (computer && !computer.isSelf) {
      throw orchestratorError(
        'COMPUTER_REMOTE_UNSUPPORTED',
        `${computer.displayName} is a known machine, but running work there is not supported yet. ` +
          'Work currently runs on this computer only.',
        { details: { computerId: computer.id }, hint: 'Ask again without naming another computer.' },
      );
    }

    const project = await this.resolveProject(input.project, computer?.id);

    // Claim the write lock BEFORE creating the session so a rejected request
    // does not leave an orphan row behind.
    const session = this.store.create({
      instruction: input.instruction,
      mode,
      writeCapable,
      ...(project ? { projectId: project.id } : {}),
      ...(computer ? { computerId: computer.id } : {}),
    });

    if (writeCapable && project && this.deps.claudeConfig.enforceProjectWriteLock) {
      const lock = this.store.tryAcquireProjectWriteLock(project.id, session.id);
      if (!lock.ok) {
        // Roll the new session straight to cancelled; it never started.
        this.store.setStatus(session.id, 'cancelled', {
          summary: 'Not started: another session holds this project.',
        });

        // Describe the holder concretely. A session that finished its turn
        // hours ago still holds the lock by design, and the user can only make
        // a sensible choice if we say so out loud rather than just refusing.
        const holder = this.store.get(lock.heldBy);
        const holderSummary = holder?.currentSummary ?? holder?.initialInstruction;
        const idleFor = holder ? describeAge(holder.updatedAt) : undefined;
        const holderState =
          holder?.status === 'idle'
            ? `It finished its last task${idleFor ? ` ${idleFor}` : ''} and is waiting for more.`
            : holder
              ? `It is currently ${holder.status}.`
              : '';

        throw orchestratorError(
          'PROJECT_BUSY',
          `Project ${project.displayName} is already held by work session ${lock.heldBy}. ` +
            `${holderSummary ? `That session: ${firstLine(holderSummary)}. ` : ''}${holderState}`,
          {
            details: {
              projectId: project.id,
              heldBy: lock.heldBy,
              holderStatus: holder?.status ?? 'unknown',
              holderSummary: holderSummary ?? null,
            },
            hint:
              `Send this instruction to ${lock.heldBy} with send_work_session_instruction to continue that work, ` +
              `cancel it with cancel_work_session, or use mode "inspect" for a read-only look.`,
          },
        );
      }
    }

    const cwd = project?.path ?? process.cwd();
    const worker = this.buildWorker(session.id, cwd);
    this.workers.set(session.id, worker);

    const prompt = this.composePrompt(input.instruction, input.context, mode);

    try {
      worker.start({ instruction: prompt, cwd, mode });
    } catch (error) {
      this.failSession(session.id, error);
      throw error;
    }

    this.store.setStatus(session.id, 'working', { summary: firstLine(input.instruction) });
    this.store.appendProgress(session.id, 'started', `Started work: ${firstLine(input.instruction)}`);
    this.activeContext.update({
      workSessionId: session.id,
      ...(project ? { projectId: project.id } : {}),
      ...(computer ? { computerId: computer.id } : {}),
    });

    return {
      sessionId: session.id,
      status: 'working',
      summary: `Started work on ${project?.displayName ?? 'this machine'}: ${firstLine(input.instruction)}`,
      ...(project ? { project: project.displayName } : {}),
      ...(computer ? { computer: computer.displayName } : {}),
      warnings,
    };
  }

  /**
   * Compose the worker's opening prompt.
   *
   * Intentionally short. The worker already loads CLAUDE.md and the user's
   * settings through `settingSources`, so repeating preferences here would
   * create a second, drifting source of truth.
   */
  private composePrompt(instruction: string, context: string | undefined, mode: WorkSessionMode): string {
    const parts: string[] = [];
    if (mode === 'inspect') {
      parts.push('Investigate and report only. Do not modify any files.');
    }
    parts.push(
      'You are being driven by a user speaking to Claude on their phone. Keep replies short and ' +
        'concrete. When a decision genuinely needs the user, call the ask_user tool rather than guessing.',
    );
    if (context && context.trim() !== '') parts.push(`Relevant context:\n${context.trim()}`);
    parts.push(instruction);
    return parts.join('\n\n');
  }

  // ------------------------------------------------------------- continuing

  async sendInstruction(sessionId: string, instruction: string): Promise<{ status: WorkSession['status']; summary: string }> {
    const session = this.store.getOrThrow(sessionId);
    if (!acceptsInstruction(session.status)) {
      throw orchestratorError(
        'SESSION_NOT_ACCEPTING_INPUT',
        `work session ${sessionId} is "${session.status}" and cannot take another instruction`,
        { details: { sessionId, status: session.status } },
      );
    }

    const worker = this.workers.get(sessionId) ?? (await this.recoverWorker(session));

    worker.send(instruction);
    this.store.incrementTurn(sessionId);
    this.store.appendProgress(sessionId, 'step', `New instruction: ${firstLine(instruction)}`);
    if (session.status !== 'working') {
      this.store.setStatus(sessionId, 'working', { summary: firstLine(instruction) });
    } else {
      this.store.updateProgress(sessionId, { summary: firstLine(instruction) });
    }
    this.activeContext.update({ workSessionId: sessionId });

    return { status: 'working', summary: `Sent to session ${sessionId}: ${firstLine(instruction)}` };
  }

  // ------------------------------------------------------------------ input

  respond(sessionId: string, answer: string, requestId?: string): { status: WorkSession['status']; summary: string } {
    const session = this.store.getOrThrow(sessionId);
    const open = requestId ? this.store.getPendingRequestOrThrow(requestId) : this.store.getOpenRequest(sessionId);
    if (!open) {
      throw orchestratorError('PENDING_REQUEST_NOT_FOUND', `work session ${sessionId} is not waiting on anything`, {
        details: { sessionId },
      });
    }
    if (open.workSessionId !== sessionId) {
      throw orchestratorError('INVALID_ARGUMENT', `request ${open.requestId} does not belong to session ${sessionId}`);
    }

    const denied = open.type === 'approval' && isNegative(answer);
    this.broker.answer(open.requestId, answer, denied);
    this.store.appendProgress(sessionId, 'answer', `Answered: ${firstLine(answer)}`);

    if (session.status === 'needs_input' || session.status === 'awaiting_approval') {
      this.store.setStatus(sessionId, 'working', { summary: 'Continuing with your answer.' });
    }
    return { status: 'working', summary: 'Answer delivered; work continues.' };
  }

  // ----------------------------------------------------------------- cancel

  async cancel(sessionId: string, reason = 'cancelled by user'): Promise<{ status: WorkSession['status']; summary: string }> {
    const alreadyDone = (status: WorkSession['status']): boolean =>
      status === 'completed' || status === 'failed' || status === 'cancelled';

    const finishedResponse = (status: WorkSession['status']) => ({
      status,
      summary: `Session ${sessionId} had already ${status === 'completed' ? 'finished' : status}.`,
    });

    const session = this.store.getOrThrow(sessionId);
    // A voice user saying "stop" just as work lands is normal, not an error
    // worth alarming them about.
    if (alreadyDone(session.status)) return finishedResponse(session.status);

    const worker = this.workers.get(sessionId);
    if (worker) {
      // Graceful interrupt first; dispose only after, so an in-flight write is
      // allowed to finish rather than being torn out mid-file.
      await worker.interrupt();
      await worker.dispose();
      this.workers.delete(sessionId);
    }

    // Re-read AFTER the awaits above: the worker can legitimately complete
    // while we were interrupting it, and racing a terminal state must report
    // the truth rather than throwing an invalid-transition error at the user.
    const current = this.store.getOrThrow(sessionId);
    if (alreadyDone(current.status)) {
      this.broker.abandonSession(sessionId, reason);
      return finishedResponse(current.status);
    }

    this.broker.abandonSession(sessionId, reason);
    this.store.setStatus(sessionId, 'cancelled', { summary: `Stopped: ${reason}.`, step: null });
    this.store.appendProgress(sessionId, 'cancelled', `Stopped: ${reason}.`);
    return { status: 'cancelled', summary: `Stopped work session ${sessionId}.` };
  }

  // ----------------------------------------------------------------- status

  getStatus(sessionId: string): WorkSessionStatusView {
    const session = this.store.getOrThrow(sessionId);
    const events = this.store.listProgress(sessionId, 40);
    const open = this.store.getOpenRequest(sessionId);

    const completedSteps = events
      .filter((event) => event.kind === 'file_changed' || event.kind === 'test' || event.kind === 'git' || event.kind === 'command')
      .map((event) => event.message)
      .slice(-6);

    const warnings = events.filter((event) => event.kind === 'warning').map((event) => event.message).slice(-4);

    const started = session.startedAt ?? session.createdAt;
    const end = session.finishedAt ? new Date(session.finishedAt) : new Date();
    const elapsedSeconds = Math.max(0, Math.round((end.getTime() - new Date(started).getTime()) / 1000));

    const view: WorkSessionStatusView = {
      sessionId,
      status: session.status,
      summary: session.currentSummary ?? firstLine(session.initialInstruction),
      completedSteps,
      warnings,
      elapsedSeconds,
      recovered: session.recoveryCount > 0,
    };
    if (session.currentStep) view.currentStep = session.currentStep;
    if (open) {
      view.pendingQuestion = {
        requestId: open.requestId,
        type: open.type,
        question: open.question,
        ...(open.choices ? { choices: open.choices } : {}),
      };
    }
    if (session.recoveryNote) view.warnings = [...view.warnings, session.recoveryNote];
    return view;
  }

  getResult(sessionId: string): WorkResult {
    const session = this.store.getOrThrow(sessionId);
    if (session.result) return session.result;

    const worker = this.workers.get(sessionId);
    const artifacts = this.store.listArtifacts(sessionId);
    return {
      status: session.status,
      summary: session.currentSummary ?? 'Work is still in progress.',
      filesChanged: worker ? [...worker.accumulator.filesChanged] : [],
      ...(worker?.accumulator.tests ? { tests: worker.accumulator.tests } : {}),
      ...(worker ? { git: worker.accumulator.git } : {}),
      warnings: worker?.accumulator.warnings ?? [],
      artifacts: artifacts.map((a) => ({
        id: a.id,
        kind: a.kind,
        title: a.title,
        ...(a.sizeBytes !== undefined ? { sizeBytes: a.sizeBytes } : {}),
      })),
    };
  }

  /**
   * Implements the context layer's WorkSessionContextReader.
   *
   * Only genuinely current work is presented as ACTIVE WORK. An `interrupted`
   * session is technically non-terminal but a week-old one is not "what we are
   * working on" - surfacing those at the top of every voice turn crowded out
   * the context that mattered, so they age out.
   */
  async getCompactActiveContext(): Promise<InitialContextSection | null> {
    const recent = this.store.list({ limit: 8 });
    if (recent.length === 0) return null;

    const now = Date.now();
    const isFresh = (session: WorkSession): boolean =>
      now - new Date(session.updatedAt).getTime() < SessionManager.INTERRUPTED_CONTEXT_WINDOW_MS;

    const active = recent.filter(
      (s) => s.status === 'working' || s.status === 'idle' || s.status === 'needs_input' || s.status === 'awaiting_approval',
    );
    const resumable = recent.filter((s) => s.status === 'interrupted' && isFresh(s));
    const shown = [...active, ...resumable].slice(0, 3);

    const lines: string[] = [];
    for (const session of shown) {
      const open = this.store.getOpenRequest(session.id);
      const label =
        session.status === 'idle'
          ? 'finished, ready for more'
          : session.status === 'interrupted'
            ? 'interrupted, can be resumed'
            : session.status;
      lines.push(`${session.id} — ${session.currentSummary ?? firstLine(session.initialInstruction)} [${label}]`);
      if (session.currentStep) lines.push(`  now: ${session.currentStep}`);
      if (open) lines.push(`  waiting on you: ${open.question}`);
    }

    if (shown.length === 0) {
      // Nothing current: mention only the latest finished work, and mark it
      // low-relevance so it is the first thing trimmed under budget pressure.
      const last = recent[0];
      if (!last) return null;
      return {
        providerId: 'workSessions',
        title: 'RECENT WORK',
        lines: [`${last.id} — ${last.currentSummary ?? firstLine(last.initialInstruction)} [${last.status}]`],
        minLines: 1,
        relevance: 0.2,
        generatedAt: new Date().toISOString(),
        data: { sessions: [{ id: last.id, status: last.status, summary: last.currentSummary ?? null }] },
      };
    }

    return {
      providerId: 'workSessions',
      title: 'ACTIVE WORK',
      lines,
      minLines: 1,
      relevance: 1,
      generatedAt: new Date().toISOString(),
      data: {
        sessions: shown.map((s) => ({ id: s.id, status: s.status, summary: s.currentSummary ?? null })),
      },
    };
  }

  // --------------------------------------------------------------- recovery

  /**
   * Reconcile durable state with reality at startup.
   *
   * A session that believed it was running has no worker after a restart, so it
   * is marked `interrupted` rather than left claiming to be working. That is
   * the honest state, and it is recoverable: the next instruction resumes it.
   */
  recoverOnStartup(): { interrupted: number; locksReleased: number } {
    const locksReleased = this.store.releaseOrphanedLocks();
    let interrupted = 0;
    for (const session of this.store.listResumable()) {
      // Marking a session "interrupted" asserts that it has no live worker, so
      // make that true rather than merely claiming it. In the normal restart
      // path the map is already empty; this keeps the method honest if it is
      // ever called on a running manager.
      const existing = this.workers.get(session.id);
      if (existing) {
        this.workers.delete(session.id);
        void existing.dispose();
      }
      this.store.setStatus(session.id, 'interrupted', {
        summary: 'Interrupted when the orchestrator restarted.',
        step: null,
      });
      this.store.voidOpenRequests(session.id, 'orchestrator restarted');
      this.store.appendProgress(session.id, 'warning', 'Interrupted by an orchestrator restart.');
      interrupted += 1;
    }
    if (interrupted > 0 || locksReleased > 0) {
      this.logger.warn('recovered sessions after restart', { interrupted, locksReleased });
    }
    return { interrupted, locksReleased };
  }

  /**
   * A warning when a session is at or near its wall-clock cap.
   *
   * `started_at` is written with COALESCE and so survives a resume: the cap is
   * a cap on the whole session, not on the current run. That is the documented
   * meaning, but it makes resuming an old session quietly futile, so the
   * remaining time is surfaced instead of discovered.
   */
  private isPastLifetimeCap(session: WorkSession): boolean {
    const startedAt = Date.parse(session.startedAt ?? session.createdAt);
    // An unparseable timestamp is never treated as expired.
    if (!Number.isFinite(startedAt)) return false;
    return Date.now() - startedAt > this.deps.claudeConfig.sessionTimeoutMs;
  }

  private remainingLifetimeNote(session: WorkSession): string | undefined {
    const cap = this.deps.claudeConfig.sessionTimeoutMs;
    const startedAt = Date.parse(session.startedAt ?? session.createdAt);
    if (!Number.isFinite(startedAt)) return undefined;
    const remainingMs = cap - (Date.now() - startedAt);
    // Past-cap sessions never reach here: recoverWorker refuses them outright.
    if (remainingMs <= 0) return undefined;
    if (remainingMs > 10 * 60_000) return undefined;
    return `Only about ${Math.max(1, Math.round(remainingMs / 60_000))} minute(s) remain before this session reaches its wall-clock cap.`;
  }

  /** Rebuild a worker for a session whose process is gone, resuming if possible. */
  private async recoverWorker(session: WorkSession): Promise<WorkerLike> {
    // Refuse rather than spawn. Telling someone to start a new session while
    // handing them a worker the reaper ends within the minute is incoherent,
    // and it costs a Claude child process to say it. The session's progress
    // and summaries remain readable through get_work_session_status.
    if (this.isPastLifetimeCap(session)) {
      throw orchestratorError(
        'SESSION_TIMED_OUT',
        `work session ${session.id} is past its wall-clock cap and cannot be resumed; start a new session`,
        { details: { sessionId: session.id } },
      );
    }
    const project = session.projectId ? await this.safeGetProject(session.projectId) : undefined;
    const cwd = project?.path ?? process.cwd();
    const worker = this.buildWorker(session.id, cwd);
    this.workers.set(session.id, worker);

    const canResume = session.claudeSessionId !== undefined;
    try {
      worker.start({
        instruction: canResume
          ? 'Continue from where you left off.'
          : this.reconstructionPrompt(session),
        cwd,
        mode: session.mode,
        ...(session.claudeSessionId ? { resumeSessionId: session.claudeSessionId } : {}),
      });
    } catch (error) {
      this.workers.delete(session.id);
      throw orchestratorError('CLAUDE_SESSION_RESUME_FAILED', `could not resume work session ${session.id}`, {
        cause: error,
        details: { sessionId: session.id },
      });
    }

    const base = canResume
      ? 'Worker restarted and resumed the previous Claude session.'
      : 'Worker restarted from a summary; earlier conversation detail was not recovered.';
    // The cap counts from the ORIGINAL start and is not reset by a resume, so
    // resuming a long-lived session can hand back a worker the reaper retires
    // a minute later. Say so rather than letting it happen silently.
    const capNote = this.remainingLifetimeNote(session);
    const note = capNote ? `${base} ${capNote}` : base;
    this.store.recordRecovery(session.id, note);
    this.store.appendProgress(session.id, 'recovered', note);
    this.logger.info('recovered worker', { workSessionId: session.id, resumed: canResume });
    return worker;
  }

  /** Compact restatement used when the Claude session cannot be resumed. */
  private reconstructionPrompt(session: WorkSession): string {
    const events = this.store.listProgress(session.id, 20);
    const done = events
      .filter((e) => e.kind === 'file_changed' || e.kind === 'test' || e.kind === 'command')
      .map((e) => `- ${e.message}`)
      .join('\n');
    return [
      'This work was interrupted and the previous conversation could not be restored.',
      `Original request: ${session.initialInstruction}`,
      done ? `Progress so far:\n${done}` : 'No recorded progress.',
      'Re-check the current state of the files before continuing.',
    ].join('\n\n');
  }

  private async safeGetProject(projectId: string): Promise<{ path: string } | undefined> {
    try {
      return await this.deps.projects.get(projectId);
    } catch {
      // The project may have been moved or deleted since the session started.
      return undefined;
    }
  }

  // ---------------------------------------------------------------- workers

  private buildWorker(sessionId: string, _cwd: string): WorkerLike {
    const callbacks: WorkerCallbacks = {
      onSessionId: (claudeSessionId) => {
        this.store.setClaudeSessionId(sessionId, claudeSessionId);
      },
      onProgress: (progress: WorkerProgress) => {
        this.store.appendProgress(
          sessionId,
          progress.kind,
          progress.message,
          progress.data ? (progress.data as Record<string, never>) : undefined,
        );
        this.store.updateProgress(sessionId, { step: progress.message });
      },
      onTurnComplete: (summary) => {
        this.finishTurn(sessionId, summary);
      },
      onError: (error) => this.failSession(sessionId, error),
      askUser: async (question, choices) => {
        this.store.setStatus(sessionId, 'needs_input', { summary: question, step: null });
        this.store.appendProgress(sessionId, 'question', `Asked: ${question}`);
        try {
          const result = await this.broker.ask({
            workSessionId: sessionId,
            type: 'question',
            question,
            ...(choices ? { choices } : {}),
            timeoutMs: this.deps.securityConfig.pendingRequestTimeoutMs,
          });
          return result.answer;
        } catch (error) {
          this.clearUnansweredStatus(sessionId, 'question');
          throw error;
        }
      },
      requestApproval: async ({ question, toolName, toolSummary, permissionClass }) => {
        this.store.setStatus(sessionId, 'awaiting_approval', { summary: question, step: null });
        this.store.appendProgress(sessionId, 'approval', `Approval needed: ${toolSummary}`);
        try {
          const result = await this.broker.ask({
            workSessionId: sessionId,
            type: 'approval',
            question,
            choices: ['Yes, do it', 'No, skip it'],
            toolName,
            toolSummary,
            permissionClass,
            timeoutMs: this.deps.securityConfig.pendingRequestTimeoutMs,
          });
          return !result.denied;
        } catch (error) {
          this.clearUnansweredStatus(sessionId, 'approval');
          throw error;
        }
      },
    };

    if (this.deps.createWorker) {
      return this.deps.createWorker({
        workSessionId: sessionId,
        config: this.deps.claudeConfig,
        scope: this.deps.scope,
        policy: this.policy(),
        callbacks,
        logger: this.logger,
      });
    }

    return new ClaudeWorker(
      sessionId,
      this.deps.claudeConfig,
      this.deps.scope,
      this.policy(),
      callbacks,
      this.logger,
    );
  }

  /**
   * Record the end of a turn.
   *
   * The session becomes `idle`, not `completed`: the worker is still alive and
   * the next instruction continues the same Claude conversation. The result is
   * stored so get_work_session_result answers immediately, and the project
   * write lock is deliberately retained so nothing else claims the repository
   * between turns.
   */
  private finishTurn(sessionId: string, summary: string): void {
    const worker = this.workers.get(sessionId);
    const session = this.store.get(sessionId);
    if (!session || isTerminalStatus(session.status)) return;

    const artifacts = this.store.listArtifacts(sessionId);
    const result: WorkResult = {
      status: 'idle',
      summary,
      filesChanged: worker ? [...worker.accumulator.filesChanged] : [],
      ...(worker?.accumulator.tests ? { tests: worker.accumulator.tests } : {}),
      ...(worker ? { git: worker.accumulator.git } : {}),
      warnings: worker?.accumulator.warnings ?? [],
      artifacts: artifacts.map((a) => ({
        id: a.id,
        kind: a.kind,
        title: a.title,
        ...(a.sizeBytes !== undefined ? { sizeBytes: a.sizeBytes } : {}),
      })),
    };
    this.store.setStatus(sessionId, 'idle', { summary, step: null, result });
    this.store.appendProgress(sessionId, 'completed', summary);
  }

  /**
   * Put a session back to `working` after a question or approval went
   * unanswered.
   *
   * The broker voids the request row and rejects, and the worker fails closed
   * by denying that one tool and carrying on - which is the right behaviour.
   * But the status was set to needs_input/awaiting_approval before the ask,
   * and nothing moved it back, so get_work_session_status reported a session
   * waiting on a question that no longer exists: `respond` would answer with
   * PENDING_REQUEST_NOT_FOUND while the status invited the user to answer.
   * It self-healed on the next completed turn, which is not much comfort to
   * someone looking at a quiet session.
   */
  private clearUnansweredStatus(sessionId: string, kind: 'question' | 'approval'): void {
    const session = this.store.get(sessionId);
    if (!session || isTerminalStatus(session.status)) return;
    if (session.status !== 'needs_input' && session.status !== 'awaiting_approval') return;
    this.store.setStatus(sessionId, 'working', {
      summary: `No answer to the ${kind}; continuing without it.`,
      step: null,
    });
    this.store.appendProgress(sessionId, 'warning', `The ${kind} went unanswered, so work continued without it.`);
  }

  private failSession(sessionId: string, error: unknown, options: { fromWorker?: boolean } = {}): void {
    const session = this.store.get(sessionId);
    if (!session) return;
    if (isTerminalStatus(session.status)) return;

    const orchestratorErr = OrchestratorError.is(error)
      ? error
      : orchestratorError('CLAUDE_WORKER_FAILED', error instanceof Error ? error.message : String(error));

    this.store.setStatus(sessionId, 'failed', {
      summary: `Work failed: ${orchestratorErr.message}`,
      step: null,
      error: { code: orchestratorErr.code, message: orchestratorErr.message, fromWorker: options.fromWorker ?? true },
    });
    this.store.appendProgress(sessionId, 'error', `Failed: ${orchestratorErr.message}`);

    // Release the worker. Without this a failed session leaves its Claude child
    // process alive and its entry in the map forever - a real process leak that
    // also keeps a dead session looking recoverable.
    const worker = this.workers.get(sessionId);
    if (worker) {
      this.workers.delete(sessionId);
      void worker.dispose();
    }
    this.broker.abandonSession(sessionId, 'session failed');

    this.logger.error('work session failed', { workSessionId: sessionId, err: orchestratorErr });
  }

  private async resolveComputer(query: string | undefined) {
    if (!query || query.trim() === '') return undefined;
    const resolution = await this.deps.computers.resolve(query);
    if (resolution.kind === 'match' && resolution.computer) return resolution.computer;
    if (resolution.kind === 'ambiguous') {
      throw orchestratorError('COMPUTER_AMBIGUOUS', `"${query}" matches more than one computer.`, {
        details: { candidates: resolution.candidates.map((c) => c.displayName) },
        hint: `Did you mean ${resolution.candidates.map((c) => c.displayName).join(' or ')}?`,
      });
    }
    throw orchestratorError('COMPUTER_NOT_FOUND', `No computer matches "${query}".`, {
      details: { query },
    });
  }

  private async resolveProject(query: string | undefined, computerId?: string) {
    if (!query || query.trim() === '') return undefined;
    const resolution = await this.deps.projects.resolve(query, computerId);
    if (resolution.kind === 'match' && resolution.project) return resolution.project;
    if (resolution.kind === 'ambiguous') {
      throw orchestratorError('PROJECT_AMBIGUOUS', `"${query}" matches more than one project.`, {
        details: { candidates: resolution.candidates.map((p) => p.displayName) },
        hint: `Did you mean ${resolution.candidates.map((p) => p.displayName).join(' or ')}?`,
      });
    }
    throw orchestratorError('PROJECT_NOT_FOUND', `No project matches "${query}".`, { details: { query } });
  }

  /** Stop every worker. Used on shutdown. */
  /**
   * Fail sessions that have outlived `claude.sessionTimeoutMs`.
   *
   * That setting was declared and documented as a "wall-clock cap for a single
   * work session" but read nowhere, so nothing ever enforced it. `maxTurns`
   * bounds agentic turns within one conversation, not elapsed time, so a
   * session that stalled - a worker waiting on something that never comes, a
   * client that walked away - held its Claude child process and, if it was
   * write-capable, that project's write lock, for as long as the server ran.
   *
   * Reaping goes through failSession, which is already the audited path: it
   * writes a terminal status, releases the write lock in the same transaction,
   * and disposes the worker. Exposed rather than private so it can be tested
   * against a clock instead of a timer.
   */
  reapExpiredSessions(nowMs: number = Date.now()): string[] {
    const cap = this.deps.claudeConfig.sessionTimeoutMs;
    const reaped: string[] = [];
    // `interrupted` is included deliberately. Recovery marks a session
    // interrupted and lets it KEEP its write lock so it can be resumed, but
    // nothing ever re-lists it, so one that is never resumed nor cancelled
    // pins that project forever. A session already past its total wall-clock
    // cap cannot legitimately resume, so the same cap retires it - rather
    // than inventing a second, separate staleness policy for interrupted.
    const candidates = [...this.store.listResumable(), ...this.store.listAllByStatus('interrupted')];
    for (const session of candidates) {
      const startedAt = Date.parse(session.startedAt ?? session.createdAt);
      // An unparseable timestamp is not a reason to kill someone's work.
      if (!Number.isFinite(startedAt)) continue;
      if (nowMs - startedAt <= cap) continue;
      // Its own code, and NOT attributed to the worker: nothing the worker
      // did caused this, and SESSION_ALREADY_FINISHED means something else.
      this.failSession(
        session.id,
        orchestratorError(
          'SESSION_TIMED_OUT',
          `work session exceeded its ${Math.round(cap / 60_000)} minute wall-clock cap and was ended`,
        ),
        { fromWorker: false },
      );
      reaped.push(session.id);
    }
    return reaped;
  }

  /** Begin periodic reaping. Idempotent; the timer never holds the process open. */
  startReaper(intervalMs = 60_000): void {
    if (this.reaperTimer !== undefined) return;
    this.reaperTimer = setInterval(() => {
      try {
        const reaped = this.reapExpiredSessions();
        if (reaped.length > 0) this.logger.warn('reaped timed-out work sessions', { count: reaped.length, sessions: reaped });
      } catch (error) {
        // A failed sweep must never take the server down with it.
        this.logger.warn('session reaper failed', { err: error });
      }
    }, intervalMs);
    this.reaperTimer.unref();
  }

  stopReaper(): void {
    if (this.reaperTimer !== undefined) clearInterval(this.reaperTimer);
    this.reaperTimer = undefined;
  }

  async shutdown(): Promise<void> {
    this.stopReaper();
    await Promise.all([...this.workers.values()].map((worker) => worker.dispose()));
    this.workers.clear();
  }
}

// ------------------------------------------------------------------ helpers

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? text;
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

/** Speech-friendly relative age, e.g. "about 3 hours ago". */
function describeAge(iso: string): string | undefined {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `about ${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `about ${days} day${days === 1 ? '' : 's'} ago`;
}

const NEGATIVE = /^\s*(no|nope|don'?t|do not|deny|denied|cancel|stop|skip|never)\b/i;

function isNegative(answer: string): boolean {
  return NEGATIVE.test(answer);
}
