/**
 * Schema migrations.
 *
 * Append-only: never edit a shipped migration, add a new one. Each entry runs
 * inside a transaction together with the `schema_version` bump, so a failed
 * migration leaves the database on the previous version rather than half-way.
 */
export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    statements: [
      `CREATE TABLE work_sessions (
        id TEXT PRIMARY KEY,
        claude_session_id TEXT,
        project_id TEXT,
        computer_id TEXT,
        mode TEXT NOT NULL,
        write_capable INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        initial_instruction TEXT NOT NULL,
        current_summary TEXT,
        current_step TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        result_json TEXT,
        error_json TEXT,
        recovery_count INTEGER NOT NULL DEFAULT 0,
        recovery_note TEXT,
        turn_count INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX idx_work_sessions_status ON work_sessions(status)`,
      `CREATE INDEX idx_work_sessions_project ON work_sessions(project_id)`,
      `CREATE INDEX idx_work_sessions_updated ON work_sessions(updated_at DESC)`,

      `CREATE TABLE pending_requests (
        request_id TEXT PRIMARY KEY,
        work_session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        question TEXT NOT NULL,
        choices_json TEXT,
        tool_name TEXT,
        tool_summary TEXT,
        permission_class TEXT,
        created_at TEXT NOT NULL,
        answered_at TEXT,
        answer TEXT,
        denied INTEGER,
        voided_at TEXT,
        void_reason TEXT
      )`,
      `CREATE INDEX idx_pending_requests_session ON pending_requests(work_session_id)`,
      // Partial index: the hot query is "is there an OPEN request for this
      // session", which must stay O(1) while answered history accumulates.
      `CREATE INDEX idx_pending_requests_open
         ON pending_requests(work_session_id)
         WHERE answered_at IS NULL AND voided_at IS NULL`,

      `CREATE TABLE progress_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        data_json TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_progress_events_session ON progress_events(work_session_id, id DESC)`,

      `CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        work_session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        path TEXT NOT NULL,
        size_bytes INTEGER,
        mime_type TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_artifacts_session ON artifacts(work_session_id)`,

      `CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        computer_id TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        markers_json TEXT NOT NULL DEFAULT '[]',
        language TEXT,
        framework TEXT,
        git_json TEXT,
        has_claude_md INTEGER NOT NULL DEFAULT 0,
        last_activity_at TEXT,
        description TEXT,
        indexed_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_projects_name ON projects(name)`,

      // Single-row table holding "what the conversation last referred to".
      `CREATE TABLE active_context (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        project_id TEXT,
        computer_id TEXT,
        work_session_id TEXT,
        updated_at TEXT
      )`,
      `INSERT INTO active_context (id) VALUES (1)`,

      // Generic namespaced cache so a new service does not need a migration.
      `CREATE TABLE kv_cache (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        expires_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (namespace, key)
      )`,
    ],
  },
  {
    version: 2,
    name: 'project_write_locks',
    statements: [
      // A dedicated table rather than a column on `projects`, because the lock
      // must be claimable for a project that is not in the index yet (a path
      // the user named explicitly), and because UNIQUE gives us atomic
      // acquisition without an application-level mutex.
      `CREATE TABLE project_write_locks (
        project_id TEXT PRIMARY KEY,
        work_session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
        acquired_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX idx_project_write_locks_session ON project_write_locks(work_session_id)`,
    ],
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
