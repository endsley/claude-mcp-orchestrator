import { describe, expect, it } from 'vitest';
import { openTestDatabase } from '../../../src/db/database.js';
import { createNullLogger } from '../../../src/logging/logger.js';
import { BOARD_KEY_PREFIX, BoardKeyStore } from '../../../src/security/board-keys.js';
import { hashSecret } from '../../../src/security/oauth/tokens.js';

function store() {
  const db = openTestDatabase(createNullLogger());
  return { db, keys: new BoardKeyStore(db) };
}

describe('board token keys', () => {
  it('creates a prefixed, high-entropy key and verifies it by name', () => {
    const { keys } = store();
    const { key, record } = keys.create('helper-bot');
    expect(key.startsWith(BOARD_KEY_PREFIX)).toBe(true);
    expect(key.length).toBeGreaterThanOrEqual(BOARD_KEY_PREFIX.length + 43);
    expect(record).toMatchObject({ name: 'helper-bot', revoked: false });
    expect(keys.verify(key)).toEqual({ name: 'helper-bot' });
  });

  it('stores only the hash: the plaintext key appears nowhere in the table', () => {
    const { db, keys } = store();
    const { key } = keys.create('second-bot');
    const rows = db.prepare('SELECT * FROM board_keys').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(key);
    expect(dump).not.toContain(key.slice(BOARD_KEY_PREFIX.length));
    expect(rows[0]!['key_hash']).toBe(hashSecret(key));
  });

  it('rejects unknown, tampered and unprefixed keys', () => {
    const { keys } = store();
    const { key } = keys.create('agent-a');
    expect(keys.verify(`${key}x`)).toBeUndefined();
    expect(keys.verify(key.slice(0, -1))).toBeUndefined();
    expect(keys.verify(key.slice(BOARD_KEY_PREFIX.length))).toBeUndefined();
    expect(keys.verify('')).toBeUndefined();
  });

  it('revocation takes effect immediately and keeps the audit row', () => {
    const { keys } = store();
    const { key } = keys.create('agent-b');
    expect(keys.revoke('agent-b')).toBe(true);
    expect(keys.verify(key)).toBeUndefined();
    expect(keys.revoke('agent-b')).toBe(false);
    expect(keys.list()).toEqual([expect.objectContaining({ name: 'agent-b', revoked: true })]);
  });

  it('allows one live key per name, and reissue only after revoke', () => {
    const { keys } = store();
    const first = keys.create('agent-c');
    expect(() => keys.create('agent-c')).toThrow(/already exists/);
    keys.revoke('agent-c');
    const second = keys.create('agent-c');
    expect(keys.verify(first.key)).toBeUndefined();
    expect(keys.verify(second.key)).toEqual({ name: 'agent-c' });
  });

  it('refuses names that could impersonate another identity form', () => {
    const { keys } = store();
    for (const bad of ['oauth:claude', 'oauth-mcpc_1', 'owner-local', 'Owner_bearer', 'ext-oauth-x', 'oauth', '', ' x', 'a/b', 'x'.repeat(49), '-lead', 'name with space', 'ext\u0000']) {
      expect(() => keys.create(bad), bad).toThrow(/board key name/);
    }
  });

  it('records last use', () => {
    const { keys } = store();
    const { key } = keys.create('agent-d');
    expect(keys.list()[0]!.lastUsedAt).toBeUndefined();
    keys.verify(key);
    expect(keys.list()[0]!.lastUsedAt).toBeDefined();
  });
});
