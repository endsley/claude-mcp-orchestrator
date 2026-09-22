import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/db/database.js';
import { createNullLogger } from '../../../src/logging/logger.js';
import { OAuthStore } from '../../../src/security/oauth/store.js';

/**
 * An expired token cannot be used - lookupToken rejects on expiry before looking
 * at anything else - so any expired row is dead weight. The sweep used to keep
 * one class of them forever: a refresh token that expired without ever being
 * rotated, which is one permanent row per authorization flow that never
 * refreshed.
 */

const dirs: string[] = [];

afterEach(() => {
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function store(): OAuthStore {
  const dir = mkdtempSync(join(tmpdir(), 'oauth-prune-'));
  dirs.push(dir);
  const db = openDatabase({ path: join(dir, 'p.sqlite'), walMode: true, busyTimeoutMs: 2_000 }, createNullLogger());
  return new OAuthStore(db);
}

function client(subject: OAuthStore): string {
  return subject.registerClient({ redirectUris: ['https://claude.ai/cb'], clientName: 'c' }).clientId;
}

describe('OAuthStore.pruneExpired', () => {
  it('removes a refresh token that expired without ever being rotated', () => {
    const subject = store();
    const clientId = client(subject);
    // Already expired on issue.
    subject.issueToken({ kind: 'refresh', clientId, audience: 'https://x/mcp', scope: 'mcp', ttlMs: -1_000 });

    const pruned = subject.pruneExpired();
    expect(pruned.tokens).toBe(1);
  });

  it('removes expired access tokens too', () => {
    const subject = store();
    const clientId = client(subject);
    subject.issueToken({ kind: 'access', clientId, audience: 'https://x/mcp', scope: 'mcp', ttlMs: -1_000 });
    expect(subject.pruneExpired().tokens).toBe(1);
  });

  it('leaves live tokens alone', () => {
    const subject = store();
    const clientId = client(subject);
    const live = subject.issueToken({ kind: 'refresh', clientId, audience: 'https://x/mcp', scope: 'mcp', ttlMs: 60_000 });
    expect(subject.pruneExpired().tokens).toBe(0);
    expect(subject.lookupToken(live.token, 'refresh')).toBeDefined();
  });

  it('is safe to run repeatedly', () => {
    const subject = store();
    const clientId = client(subject);
    subject.issueToken({ kind: 'refresh', clientId, audience: 'https://x/mcp', scope: 'mcp', ttlMs: -1_000 });
    expect(subject.pruneExpired().tokens).toBe(1);
    expect(subject.pruneExpired().tokens).toBe(0);
  });
});
