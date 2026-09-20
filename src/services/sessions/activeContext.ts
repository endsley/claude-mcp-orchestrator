import type { Db } from '../../db/database.js';
import type { ActiveContextSnapshot } from '../../types/context.js';

/**
 * "What the conversation was just talking about."
 *
 * This is what lets "make that smaller" or "run it again" resolve without the
 * user repeating themselves. It is explicitly a HINT with an expiry: treating
 * it as truth is how an assistant confidently edits last week's project.
 */
export class ActiveContextStore {
  constructor(
    private readonly db: Db,
    /** Entries older than this are ignored. Default 2 hours. */
    private readonly ttlMs: number = 2 * 60 * 60 * 1000,
  ) {}

  get(now = new Date()): ActiveContextSnapshot {
    const row = this.db
      .prepare('SELECT project_id, computer_id, work_session_id, updated_at FROM active_context WHERE id = 1')
      .get() as
      | {
          project_id: string | null;
          computer_id: string | null;
          work_session_id: string | null;
          updated_at: string | null;
        }
      | undefined;

    if (!row || row.updated_at === null) return {};

    const age = now.getTime() - new Date(row.updated_at).getTime();
    if (!Number.isFinite(age) || age > this.ttlMs) return {};

    const snapshot: ActiveContextSnapshot = { updatedAt: row.updated_at };
    if (row.project_id) snapshot.projectId = row.project_id;
    if (row.computer_id) snapshot.computerId = row.computer_id;
    if (row.work_session_id) snapshot.workSessionId = row.work_session_id;
    return snapshot;
  }

  /** Merge non-undefined fields; omitted fields keep their previous value. */
  update(patch: Omit<ActiveContextSnapshot, 'updatedAt'>, now = new Date()): void {
    this.db
      .prepare(
        `UPDATE active_context SET
           project_id = COALESCE(?, project_id),
           computer_id = COALESCE(?, computer_id),
           work_session_id = COALESCE(?, work_session_id),
           updated_at = ?
         WHERE id = 1`,
      )
      .run(patch.projectId ?? null, patch.computerId ?? null, patch.workSessionId ?? null, now.toISOString());
  }

  clear(): void {
    this.db
      .prepare(
        'UPDATE active_context SET project_id = NULL, computer_id = NULL, work_session_id = NULL, updated_at = NULL WHERE id = 1',
      )
      .run();
  }
}
