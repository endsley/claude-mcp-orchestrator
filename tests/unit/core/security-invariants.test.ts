import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/db/database.js';
import { createNullLogger } from '../../../src/logging/logger.js';
import { OAuthStore } from '../../../src/security/oauth/store.js';
import { toolResult } from '../../../src/tools/result.js';

/**
 * These exist because a mutation sweep found them missing.
 *
 * Each invariant below was silently unguarded: the corresponding mutation of
 * the source left all 377 tests green. They are not hypothetical failure
 * modes - they are the specific regressions this suite could not see.
 */

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function store(): OAuthStore {
  const dir = mkdtempSync(join(tmpdir(), 'invariants-'));
  dirs.push(dir);
  return new OAuthStore(openDatabase({ path: join(dir, 'i.sqlite'), walMode: true, busyTimeoutMs: 2_000 }, createNullLogger()));
}

function client(subject: OAuthStore, redirectUris = ['https://claude.ai/api/mcp/auth_callback']): string {
  return subject.registerClient({ redirectUris }).clientId;
}

describe('token expiry is enforced', () => {
  /**
   * Mutation that survived: deleting the expiry check in lookupToken. Nothing
   * asserted that an expired token stops working, which is about as core as
   * an auth invariant gets.
   */
  it('refuses an expired access token', () => {
    const subject = store();
    const id = client(subject);
    const expired = subject.issueToken({
      kind: 'access', clientId: id, audience: 'https://x/mcp', scope: 'mcp', ttlMs: -1_000,
    });
    expect(subject.lookupToken(expired.token, 'access')).toBeUndefined();
  });

  it('refuses an expired refresh token', () => {
    const subject = store();
    const id = client(subject);
    const expired = subject.issueToken({
      kind: 'refresh', clientId: id, audience: 'https://x/mcp', scope: 'mcp', ttlMs: -1_000,
    });
    expect(subject.lookupToken(expired.token, 'refresh')).toBeUndefined();
  });

  it('refuses to rotate an expired refresh token', () => {
    const subject = store();
    const id = client(subject);
    const expired = subject.issueToken({
      kind: 'refresh', clientId: id, audience: 'https://x/mcp', scope: 'mcp', ttlMs: -1_000,
    });
    expect(subject.rotateRefreshToken(expired.token, 600_000)).toBeUndefined();
  });

  it('still accepts a token inside its lifetime', () => {
    const subject = store();
    const id = client(subject);
    const live = subject.issueToken({
      kind: 'access', clientId: id, audience: 'https://x/mcp', scope: 'mcp', ttlMs: 600_000,
    });
    expect(subject.lookupToken(live.token, 'access')).toBeDefined();
  });

  it('refuses an expired authorization code', () => {
    const subject = store();
    const id = client(subject);
    const code = subject.issueAuthorizationCode({
      clientId: id,
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      codeChallenge: 'x'.repeat(43),
      codeChallengeMethod: 'S256',
      scope: 'mcp',
      ttlMs: -1_000,
    });
    expect(subject.consumeAuthorizationCode(code)).toBeUndefined();
  });
});

/*
 * The redirect_uri exact-match invariant is covered in
 * tests/integration/core/oauth-chain.test.ts, against the real authorize
 * endpoint. It was first written here as assertions on the stored
 * redirectUris array, which could not fail: it tested the data rather than
 * the server's check, and the prefix-match mutation walked straight past it.
 */

describe('tool results are redacted on the way out', () => {
  /**
   * Mutation that survived: removing redactValue from toolResult's text path.
   * redaction.ts is well covered on its own, but nothing asserted that the
   * tool-result path actually calls it - the same shape as the access-token
   * wiring gap: the unit tested, the wiring not.
   */
  it('redacts a secret in the spoken text', () => {
    const result = toolResult('the api_key is sk-' + 'abcdefghijklmnopqrstuvwxyz0123456789');
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).not.toContain('sk-' + 'abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('redacts a secret in the structured payload', () => {
    const result = toolResult('fine', { api_key: 'sk-' + 'abcdefghijklmnopqrstuvwxyz0123456789' });
    expect(JSON.stringify(result.structuredContent)).not.toContain('sk-' + 'abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('leaves ordinary prose untouched', () => {
    const result = toolResult('28 projects known, 4 computers online.');
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toBe('28 projects known, 4 computers online.');
  });
});
