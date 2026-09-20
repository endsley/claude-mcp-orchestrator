import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, openTestDatabase } from '../../../src/db/database.js';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../../../src/db/migrations.js';
import { createNullLogger } from '../../../src/logging/logger.js';
import { type OrchestratorError } from '../../../src/types/errors.js';

const logger = createNullLogger();
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'db-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('migrations', () => {
  it('has strictly increasing, unique versions', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('brings a fresh database to the latest version', () => {
    const db = openTestDatabase(logger);
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(row.v).toBe(LATEST_SCHEMA_VERSION);
  });

  it('is idempotent when run again', () => {
    const db = openTestDatabase(logger);
    expect(migrate(db, logger)).toBe(LATEST_SCHEMA_VERSION);
    expect(migrate(db, logger)).toBe(LATEST_SCHEMA_VERSION);
    const count = db.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as { n: number };
    expect(count.n).toBe(MIGRATIONS.length);
  });

  // Downgrading silently would corrupt data; refusing is the safe behaviour.
  it('refuses a database newer than this build understands', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL)');
    db.prepare('INSERT INTO schema_version VALUES (?, ?)').run(LATEST_SCHEMA_VERSION + 5, new Date().toISOString());
    try {
      migrate(db, logger);
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as OrchestratorError).code).toBe('INVALID_CONFIG');
      expect((error as OrchestratorError).message).toMatch(/newer than this build/);
    }
  });

  it('enables WAL and foreign keys on a real file database', () => {
    const path = join(dir, 'test.sqlite');
    const db = openDatabase({ path, walMode: true, busyTimeoutMs: 5000 }, logger);
    expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('creates parent directories for the database file', () => {
    const path = join(dir, 'nested', 'deeper', 'test.sqlite');
    const db = openDatabase({ path, walMode: false, busyTimeoutMs: 1000 }, logger);
    expect(db.prepare('SELECT 1 AS ok').get()).toEqual({ ok: 1 });
    db.close();
  });

  it('cascades deletes from a work session to its children', () => {
    const db = openTestDatabase(logger);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO work_sessions (id, mode, write_capable, status, initial_instruction, created_at, updated_at, recovery_count, turn_count)
       VALUES ('ws_x','work',1,'working','go',?,?,0,0)`,
    ).run(now, now);
    db.prepare(
      "INSERT INTO progress_events (work_session_id, kind, message, created_at) VALUES ('ws_x','step','hi',?)",
    ).run(now);
    db.prepare(
      "INSERT INTO pending_requests (request_id, work_session_id, type, question, created_at) VALUES ('r1','ws_x','question','?',?)",
    ).run(now);

    db.prepare("DELETE FROM work_sessions WHERE id = 'ws_x'").run();
    expect((db.prepare('SELECT COUNT(*) AS n FROM progress_events').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM pending_requests').get() as { n: number }).n).toBe(0);
  });
});
