import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database.js';
import { orchestratorError } from '../types/errors.js';
import { hashSecret, mintSecret, safeEquals } from './oauth/tokens.js';

/**
 * Long-lived bearer keys for headless outside agents, board scope only.
 *
 * A key's NAME is the agent's identity on the coordination board. Only the
 * SHA-256 of a key is stored; the plaintext is returned once, by create(),
 * and never written anywhere by this module.
 */

/** Every board key starts with this, so the auth path can route it cheaply. */
export const BOARD_KEY_PREFIX = 'mcpbk_';

/** Letters, digits, dot, dash and underscore; no colon, so a key name can
 *  never look like the `oauth:` identities. */
export const BOARD_KEY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;

/** last_used_at is refreshed at most this often per key, not on every request. */
const LAST_USED_RESOLUTION_MS = 60_000;

export interface BoardKeyRecord {
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  revoked: boolean;
  revokedAt?: string;
}

interface Row {
  id: string;
  name: string;
  key_hash: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

function toRecord(row: Row): BoardKeyRecord {
  return {
    name: row.name,
    createdAt: row.created_at,
    ...(row.last_used_at !== null ? { lastUsedAt: row.last_used_at } : {}),
    revoked: row.revoked_at !== null,
    ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
  };
}

/** Prefixes kept for other identity kinds, so a key cannot pose as one. */
const RESERVED_NAME_PREFIX = /^(oauth|owner|ext)([._-]|$)/i;

export function assertValidKeyName(name: string): void {
  if (RESERVED_NAME_PREFIX.test(name)) {
    throw orchestratorError('INVALID_ARGUMENT', 'board key names may not start with "oauth", "owner" or "ext"; those name other identities');
  }
  if (!BOARD_KEY_NAME_PATTERN.test(name)) {
    throw orchestratorError(
      'INVALID_ARGUMENT',
      'board key name must be 1-48 characters: letters, digits, dot, dash or underscore, starting with a letter or digit',
    );
  }
}

export class BoardKeyStore {
  constructor(private readonly db: Db) {}

  /** Create a key. Returns the plaintext key; it is never retrievable again. */
  create(name: string): { key: string; record: BoardKeyRecord } {
    assertValidKeyName(name);
    const key = `${BOARD_KEY_PREFIX}${mintSecret(32)}`;
    const now = new Date().toISOString();
    try {
      this.db
        .prepare('INSERT INTO board_keys (id, name, key_hash, created_at) VALUES (?, ?, ?, ?)')
        .run(randomUUID(), name, hashSecret(key), now);
    } catch (error) {
      if (error instanceof Error && /UNIQUE/i.test(error.message)) {
        throw orchestratorError('INVALID_ARGUMENT', `an active board key named "${name}" already exists; revoke it first`);
      }
      throw error;
    }
    return { key, record: { name, createdAt: now, revoked: false } };
  }

  list(): BoardKeyRecord[] {
    const rows = this.db.prepare('SELECT * FROM board_keys ORDER BY name, created_at').all() as Row[];
    return rows.map(toRecord);
  }

  /** Revoke the active key with this name. Returns false when there is none. */
  revoke(name: string): boolean {
    return (
      this.db
        .prepare('UPDATE board_keys SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL')
        .run(new Date().toISOString(), name).changes > 0
    );
  }

  /**
   * Verify a presented key. Returns the key's name, or undefined for anything
   * unknown or revoked.
   *
   * The lookup is by hash (so the database never compares plaintext) and the
   * stored hash is then compared in constant time against the computed one.
   */
  verify(presented: string): { name: string } | undefined {
    if (!presented.startsWith(BOARD_KEY_PREFIX) || presented.length > 256) return undefined;
    const computed = hashSecret(presented);
    const row = this.db.prepare('SELECT * FROM board_keys WHERE key_hash = ?').get(computed) as Row | undefined;
    if (!row || !safeEquals(row.key_hash, computed)) return undefined;
    if (row.revoked_at !== null) return undefined;

    const now = Date.now();
    const lastUsed = row.last_used_at === null ? 0 : Date.parse(row.last_used_at);
    if (!Number.isFinite(lastUsed) || now - lastUsed >= LAST_USED_RESOLUTION_MS) {
      try {
        this.db.prepare('UPDATE board_keys SET last_used_at = ? WHERE id = ?').run(new Date(now).toISOString(), row.id);
      } catch {
        // Bookkeeping only; a busy database must not fail authentication.
      }
    }
    return { name: row.name };
  }
}
