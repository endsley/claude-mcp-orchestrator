import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { DatabaseConfig } from '../config/schema.js';
import type { Logger } from '../logging/logger.js';
import { orchestratorError } from '../types/errors.js';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './migrations.js';

export type Db = Database.Database;

/**
 * Open the application database and bring it to the latest schema version.
 *
 * WAL plus a busy timeout is what makes concurrent access survivable: the MCP
 * request path reads while a worker writes progress events, and without WAL
 * those readers would intermittently see SQLITE_BUSY under exactly the load we
 * care about.
 */
export function openDatabase(config: DatabaseConfig, logger: Logger): Db {
  mkdirSync(dirname(config.path), { recursive: true });

  const db = new Database(config.path);
  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${config.busyTimeoutMs}`);
  if (config.walMode) {
    db.pragma('journal_mode = WAL');
    // NORMAL is durable across process crashes (only a power loss can lose the
    // last transactions) and avoids an fsync per progress event.
    db.pragma('synchronous = NORMAL');
  }

  migrate(db, logger);
  return db;
}

function currentVersion(db: Db): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL)');
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as
    | { version: number | null }
    | undefined;
  return row?.version ?? 0;
}

export function migrate(db: Db, logger: Logger): number {
  const from = currentVersion(db);
  if (from > LATEST_SCHEMA_VERSION) {
    throw orchestratorError(
      'INVALID_CONFIG',
      `database schema version ${from} is newer than this build supports (${LATEST_SCHEMA_VERSION}); ` +
        'upgrade the orchestrator or point at a different database file',
    );
  }
  if (from === LATEST_SCHEMA_VERSION) return from;

  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    const apply = db.transaction(() => {
      for (const statement of migration.statements) db.exec(statement);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        new Date().toISOString(),
      );
    });
    try {
      apply();
    } catch (error) {
      throw orchestratorError(
        'INTERNAL',
        `migration ${migration.version} (${migration.name}) failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    logger.info('applied database migration', { version: migration.version, name: migration.name });
  }
  return LATEST_SCHEMA_VERSION;
}

/** Open an in-memory database at the latest schema version. For tests. */
export function openTestDatabase(logger: Logger): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, logger);
  return db;
}
