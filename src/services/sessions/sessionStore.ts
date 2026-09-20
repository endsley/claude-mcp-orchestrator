import { randomUUID } from 'node:crypto';
import type { Db } from '../../db/database.js';
import { orchestratorError } from '../../types/errors.js';
import type { JsonValue } from '../../types/json.js';
import type {
  Artifact,
  PendingRequest,
  PendingRequestType,
  ProgressEvent,
  ProgressEventKind,
  WorkResult,
  WorkSession,
  WorkSessionError,
  WorkSessionMode,
  WorkSessionStatus,
} from '../../types/sessions.js';
import { assertTransition } from './stateMachine.js';

interface WorkSessionRow {
  id: string;
  claude_session_id: string | null;
  project_id: string | null;
  computer_id: string | null;
  mode: string;
  write_capable: number;
  status: string;
  initial_instruction: string;
  current_summary: string | null;
  current_step: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  result_json: string | null;
  error_json: string | null;
  recovery_count: number;
  recovery_note: string | null;
  turn_count: number;
}

interface PendingRequestRow {
  request_id: string;
  work_session_id: string;
  type: string;
  question: string;
  choices_json: string | null;
  tool_name: string | null;
  tool_summary: string | null;
  permission_class: string | null;
  created_at: string;
  answered_at: string | null;
  answer: string | null;
  denied: number | null;
  voided_at: string | null;
  void_reason: string | null;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToSession(row: WorkSessionRow): WorkSession {
  const session: WorkSession = {
    id: row.id,
    mode: row.mode as WorkSessionMode,
    writeCapable: row.write_capable === 1,
    status: row.status as WorkSessionStatus,
    initialInstruction: row.initial_instruction,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    recoveryCount: row.recovery_count,
    turnCount: row.turn_count,
  };
  if (row.claude_session_id) session.claudeSessionId = row.claude_session_id;
  if (row.project_id) session.projectId = row.project_id;
  if (row.computer_id) session.computerId = row.computer_id;
  if (row.current_summary) session.currentSummary = row.current_summary;
  if (row.current_step) session.currentStep = row.current_step;
  if (row.started_at) session.startedAt = row.started_at;
  if (row.finished_at) session.finishedAt = row.finished_at;
  if (row.recovery_note) session.recoveryNote = row.recovery_note;
  if (row.result_json) {
    const parsed = parseJson<WorkResult | null>(row.result_json, null);
    if (parsed) session.result = parsed;
  }
  if (row.error_json) {
    const parsed = parseJson<WorkSessionError | null>(row.error_json, null);
    if (parsed) session.error = parsed;
  }
  return session;
}

function rowToPendingRequest(row: PendingRequestRow): PendingRequest {
  const request: PendingRequest = {
    requestId: row.request_id,
    workSessionId: row.work_session_id,
    type: row.type as PendingRequestType,
    question: row.question,
    createdAt: row.created_at,
  };
  const choices = parseJson<string[] | null>(row.choices_json, null);
  if (choices && choices.length > 0) request.choices = choices;
  if (row.tool_name) request.toolName = row.tool_name;
  if (row.tool_summary) request.toolSummary = row.tool_summary;
  if (row.permission_class) request.permissionClass = row.permission_class;
  if (row.answered_at) request.answeredAt = row.answered_at;
  if (row.answer !== null) request.answer = row.answer;
  if (row.denied !== null) request.denied = row.denied === 1;
  if (row.voided_at) request.voidedAt = row.voided_at;
  if (row.void_reason) request.voidReason = row.void_reason;
  return request;
}

export interface CreateWorkSessionInput {
  instruction: string;
  mode: WorkSessionMode;
  writeCapable: boolean;
  projectId?: string;
  computerId?: string;
}

/**
 * All durable work-session state lives behind this class.
 *
 * Every status change goes through {@link WorkSessionStore.setStatus}, which
 * re-reads the row inside the same transaction before validating the
 * transition. That read-inside-transaction is what makes concurrent
 * cancel/complete races resolve deterministically instead of both "winning".
 */
export class WorkSessionStore {
  constructor(
    private readonly db: Db,
    private readonly maxProgressEvents: number = 500,
  ) {}

  private now(): string {
    return new Date().toISOString();
  }

  create(input: CreateWorkSessionInput): WorkSession {
    const id = `ws_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO work_sessions
           (id, project_id, computer_id, mode, write_capable, status, initial_instruction,
            created_at, updated_at, recovery_count, turn_count)
         VALUES (?, ?, ?, ?, ?, 'starting', ?, ?, ?, 0, 0)`,
      )
      .run(
        id,
        input.projectId ?? null,
        input.computerId ?? null,
        input.mode,
        input.writeCapable ? 1 : 0,
        input.instruction,
        now,
        now,
      );
    return this.getOrThrow(id);
  }

  get(id: string): WorkSession | undefined {
    const row = this.db.prepare('SELECT * FROM work_sessions WHERE id = ?').get(id) as
      | WorkSessionRow
      | undefined;
    return row ? rowToSession(row) : undefined;
  }

  getOrThrow(id: string): WorkSession {
    const session = this.get(id);
    if (!session) {
      throw orchestratorError('SESSION_NOT_FOUND', `no work session with id "${id}"`, {
        details: { sessionId: id },
      });
    }
    return session;
  }

  list(options: { limit?: number; status?: WorkSessionStatus; projectId?: string } = {}): WorkSession[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.status) {
      clauses.push('status = ?');
      params.push(options.status);
    }
    if (options.projectId) {
      clauses.push('project_id = ?');
      params.push(options.projectId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(options.limit ?? 20);
    const rows = this.db
      .prepare(`SELECT * FROM work_sessions ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params) as WorkSessionRow[];
    return rows.map(rowToSession);
  }

  /** Sessions that the supervisor believes should have a live worker. */
  listResumable(): WorkSession[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM work_sessions
         WHERE status IN ('starting','working','idle','needs_input','awaiting_approval')
         ORDER BY updated_at DESC`,
      )
      .all() as WorkSessionRow[];
    return rows.map(rowToSession);
  }

  /**
   * Move a session to `next`, rejecting illegal transitions.
   *
   * Returns the updated session. The whole check-and-set runs in one
   * transaction so two callers cannot both observe `working` and then both
   * write a terminal state.
   */
  setStatus(
    id: string,
    next: WorkSessionStatus,
    patch: {
      summary?: string;
      step?: string | null;
      result?: WorkResult;
      error?: WorkSessionError;
      finished?: boolean;
    } = {},
  ): WorkSession {
    const run = this.db.transaction((): WorkSession => {
      const row = this.db.prepare('SELECT * FROM work_sessions WHERE id = ?').get(id) as
        | WorkSessionRow
        | undefined;
      if (!row) {
        throw orchestratorError('SESSION_NOT_FOUND', `no work session with id "${id}"`, {
          details: { sessionId: id },
        });
      }
      const current = row.status as WorkSessionStatus;
      assertTransition(id, current, next);

      const now = this.now();
      const finished =
        patch.finished ?? (next === 'completed' || next === 'failed' || next === 'cancelled');

      this.db
        .prepare(
          `UPDATE work_sessions SET
             status = ?,
             current_summary = COALESCE(?, current_summary),
             current_step = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(?, current_step) END,
             result_json = COALESCE(?, result_json),
             error_json = COALESCE(?, error_json),
             started_at = COALESCE(started_at, ?),
             finished_at = CASE WHEN ? = 1 THEN COALESCE(finished_at, ?) ELSE finished_at END,
             updated_at = ?
           WHERE id = ?`,
        )
        .run(
          next,
          patch.summary ?? null,
          patch.step === null ? 1 : 0,
          patch.step ?? null,
          patch.result ? JSON.stringify(patch.result) : null,
          patch.error ? JSON.stringify(patch.error) : null,
          next === 'working' ? now : null,
          finished ? 1 : 0,
          now,
          now,
          id,
        );

      // A finished session must not keep holding a project write lock, and
      // must not leave the phone waiting on a question nobody will answer.
      if (finished) {
        this.db.prepare('DELETE FROM project_write_locks WHERE work_session_id = ?').run(id);
        this.db
          .prepare(
            `UPDATE pending_requests SET voided_at = ?, void_reason = ?
             WHERE work_session_id = ? AND answered_at IS NULL AND voided_at IS NULL`,
          )
          .run(now, `session ${next}`, id);
      }
      return this.getOrThrow(id);
    });
    return run();
  }

  /** Update progress fields without changing status. */
  updateProgress(id: string, patch: { summary?: string; step?: string | null }): void {
    this.db
      .prepare(
        `UPDATE work_sessions SET
           current_summary = COALESCE(?, current_summary),
           current_step = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(?, current_step) END,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(patch.summary ?? null, patch.step === null ? 1 : 0, patch.step ?? null, this.now(), id);
  }

  setClaudeSessionId(id: string, claudeSessionId: string): void {
    this.db
      .prepare('UPDATE work_sessions SET claude_session_id = ?, updated_at = ? WHERE id = ?')
      .run(claudeSessionId, this.now(), id);
  }

  incrementTurn(id: string): void {
    this.db
      .prepare('UPDATE work_sessions SET turn_count = turn_count + 1, updated_at = ? WHERE id = ?')
      .run(this.now(), id);
  }

  recordRecovery(id: string, note: string): void {
    this.db
      .prepare(
        'UPDATE work_sessions SET recovery_count = recovery_count + 1, recovery_note = ?, updated_at = ? WHERE id = ?',
      )
      .run(note, this.now(), id);
  }

  // ---------------------------------------------------------------- progress

  appendProgress(
    workSessionId: string,
    kind: ProgressEventKind,
    message: string,
    data?: JsonValue,
  ): ProgressEvent {
    const now = this.now();
    const info = this.db
      .prepare(
        'INSERT INTO progress_events (work_session_id, kind, message, data_json, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(workSessionId, kind, message, data === undefined ? null : JSON.stringify(data), now);

    // Bound the per-session history so a chatty worker cannot grow the database
    // without limit over a long session.
    this.db
      .prepare(
        `DELETE FROM progress_events
         WHERE work_session_id = ?
           AND id NOT IN (
             SELECT id FROM progress_events WHERE work_session_id = ? ORDER BY id DESC LIMIT ?
           )`,
      )
      .run(workSessionId, workSessionId, this.maxProgressEvents);

    const event: ProgressEvent = {
      id: Number(info.lastInsertRowid),
      workSessionId,
      kind,
      message,
      createdAt: now,
    };
    if (data !== undefined) event.data = data;
    return event;
  }

  listProgress(workSessionId: string, limit = 50): ProgressEvent[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM progress_events WHERE work_session_id = ? ORDER BY id DESC LIMIT ?',
      )
      .all(workSessionId, limit) as Array<{
      id: number;
      work_session_id: string;
      kind: string;
      message: string;
      data_json: string | null;
      created_at: string;
    }>;
    return rows.reverse().map((row) => {
      const event: ProgressEvent = {
        id: row.id,
        workSessionId: row.work_session_id,
        kind: row.kind as ProgressEventKind,
        message: row.message,
        createdAt: row.created_at,
      };
      if (row.data_json !== null) event.data = parseJson<JsonValue>(row.data_json, null);
      return event;
    });
  }

  // -------------------------------------------------------- pending requests

  createPendingRequest(input: {
    workSessionId: string;
    type: PendingRequestType;
    question: string;
    choices?: string[];
    toolName?: string;
    toolSummary?: string;
    permissionClass?: string;
  }): PendingRequest {
    const requestId = `req_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    this.db
      .prepare(
        `INSERT INTO pending_requests
           (request_id, work_session_id, type, question, choices_json, tool_name, tool_summary, permission_class, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        requestId,
        input.workSessionId,
        input.type,
        input.question,
        input.choices ? JSON.stringify(input.choices) : null,
        input.toolName ?? null,
        input.toolSummary ?? null,
        input.permissionClass ?? null,
        this.now(),
      );
    return this.getPendingRequestOrThrow(requestId);
  }

  getPendingRequest(requestId: string): PendingRequest | undefined {
    const row = this.db.prepare('SELECT * FROM pending_requests WHERE request_id = ?').get(requestId) as
      | PendingRequestRow
      | undefined;
    return row ? rowToPendingRequest(row) : undefined;
  }

  getPendingRequestOrThrow(requestId: string): PendingRequest {
    const request = this.getPendingRequest(requestId);
    if (!request) {
      throw orchestratorError('PENDING_REQUEST_NOT_FOUND', `no pending request with id "${requestId}"`, {
        details: { requestId },
      });
    }
    return request;
  }

  /** The single open request for a session, if any. */
  getOpenRequest(workSessionId: string): PendingRequest | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM pending_requests
         WHERE work_session_id = ? AND answered_at IS NULL AND voided_at IS NULL
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(workSessionId) as PendingRequestRow | undefined;
    return row ? rowToPendingRequest(row) : undefined;
  }

  /**
   * Record an answer, refusing a second answer to the same request.
   *
   * The conditional UPDATE plus `changes` check is the whole concurrency story:
   * two simultaneous `respond_to_work_session` calls cannot both succeed, so
   * the worker is never handed two conflicting answers.
   */
  answerPendingRequest(requestId: string, answer: string, denied = false): PendingRequest {
    const run = this.db.transaction((): PendingRequest => {
      const existing = this.getPendingRequestOrThrow(requestId);
      if (existing.voidedAt) {
        throw orchestratorError(
          'PENDING_REQUEST_ALREADY_ANSWERED',
          `request ${requestId} is no longer open (${existing.voidReason ?? 'voided'})`,
          { details: { requestId } },
        );
      }
      const result = this.db
        .prepare(
          `UPDATE pending_requests SET answered_at = ?, answer = ?, denied = ?
           WHERE request_id = ? AND answered_at IS NULL AND voided_at IS NULL`,
        )
        .run(this.now(), answer, denied ? 1 : 0, requestId);
      if (result.changes === 0) {
        throw orchestratorError(
          'PENDING_REQUEST_ALREADY_ANSWERED',
          `request ${requestId} was already answered`,
          { details: { requestId }, hint: 'The earlier answer was used.' },
        );
      }
      return this.getPendingRequestOrThrow(requestId);
    });
    return run();
  }

  voidOpenRequests(workSessionId: string, reason: string): number {
    const result = this.db
      .prepare(
        `UPDATE pending_requests SET voided_at = ?, void_reason = ?
         WHERE work_session_id = ? AND answered_at IS NULL AND voided_at IS NULL`,
      )
      .run(this.now(), reason, workSessionId);
    return result.changes;
  }

  /** Requests open longer than `maxAgeMs`, used to fail abandoned sessions. */
  listStaleOpenRequests(maxAgeMs: number, now = new Date()): PendingRequest[] {
    const cutoff = new Date(now.getTime() - maxAgeMs).toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM pending_requests
         WHERE answered_at IS NULL AND voided_at IS NULL AND created_at <= ?`,
      )
      .all(cutoff) as PendingRequestRow[];
    return rows.map(rowToPendingRequest);
  }

  // --------------------------------------------------------------- artifacts

  registerArtifact(input: Omit<Artifact, 'id' | 'createdAt'>): Artifact {
    const id = `art_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO artifacts (id, work_session_id, kind, title, path, size_bytes, mime_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workSessionId,
        input.kind,
        input.title,
        input.path,
        input.sizeBytes ?? null,
        input.mimeType ?? null,
        now,
      );
    return { ...input, id, createdAt: now };
  }

  listArtifacts(workSessionId: string): Artifact[] {
    const rows = this.db
      .prepare('SELECT * FROM artifacts WHERE work_session_id = ? ORDER BY created_at ASC')
      .all(workSessionId) as Array<{
      id: string;
      work_session_id: string;
      kind: string;
      title: string;
      path: string;
      size_bytes: number | null;
      mime_type: string | null;
      created_at: string;
    }>;
    return rows.map((row) => {
      const artifact: Artifact = {
        id: row.id,
        workSessionId: row.work_session_id,
        kind: row.kind as Artifact['kind'],
        title: row.title,
        path: row.path,
        createdAt: row.created_at,
      };
      if (row.size_bytes !== null) artifact.sizeBytes = row.size_bytes;
      if (row.mime_type !== null) artifact.mimeType = row.mime_type;
      return artifact;
    });
  }

  // ----------------------------------------------------- project write locks

  /**
   * Try to take the write lock for a project.
   *
   * Relies on the PRIMARY KEY for atomicity rather than a JS-level check, so
   * two concurrent start_work_session calls for the same project cannot both
   * succeed no matter how they interleave.
   */
  tryAcquireProjectWriteLock(projectId: string, workSessionId: string): { ok: true } | { ok: false; heldBy: string } {
    try {
      this.db
        .prepare(
          'INSERT INTO project_write_locks (project_id, work_session_id, acquired_at) VALUES (?, ?, ?)',
        )
        .run(projectId, workSessionId, this.now());
      return { ok: true };
    } catch {
      const holder = this.getProjectWriteLockHolder(projectId);
      return { ok: false, heldBy: holder ?? 'unknown' };
    }
  }

  getProjectWriteLockHolder(projectId: string): string | undefined {
    const row = this.db
      .prepare('SELECT work_session_id FROM project_write_locks WHERE project_id = ?')
      .get(projectId) as { work_session_id: string } | undefined;
    return row?.work_session_id;
  }

  releaseProjectWriteLock(workSessionId: string): void {
    this.db.prepare('DELETE FROM project_write_locks WHERE work_session_id = ?').run(workSessionId);
  }

  /**
   * Drop locks whose session is no longer live. Called at startup: a crash
   * leaves a lock row behind that would otherwise block the project forever.
   */
  releaseOrphanedLocks(): number {
    const result = this.db
      .prepare(
        `DELETE FROM project_write_locks
         WHERE work_session_id IN (
           SELECT id FROM work_sessions WHERE status IN ('completed','failed','cancelled')
         )`,
      )
      .run();
    return result.changes;
  }
}
