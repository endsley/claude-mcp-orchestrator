import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/db/database.js';
import { createNullLogger } from '../../../src/logging/logger.js';
import { OAuthStore } from '../../../src/security/oauth/store.js';

/**
 * Reuse detection. `rotated_to` was written on every rotation and read
 * nowhere, so a detected replay left the other party's live descendant
 * working. The grace window is what makes acting on it safe: a client firing
 * concurrent refreshes, or retrying after a dropped response, presents the
 * same token twice within moments and is not a thief.
 */

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function store(): OAuthStore {
  const dir = mkdtempSync(join(tmpdir(), 'oauth-replay-'));
  dirs.push(dir);
  return new OAuthStore(openDatabase({ path: join(dir, 'r.sqlite'), walMode: true, busyTimeoutMs: 2_000 }, createNullLogger()));
}

function chainOfTwo(subject: OAuthStore): { r1: string; r2: string } {
  const client = subject.registerClient({ redirectUris: ['https://claude.ai/cb'] });
  const r1 = subject.issueToken({
    kind: 'refresh', clientId: client.clientId, audience: 'https://x/mcp', scope: 'mcp', ttlMs: 600_000,
  });
  const rotated = subject.rotateRefreshToken(r1.token, 600_000);
  if (!rotated) throw new Error('rotation should have succeeded');
  return { r1: r1.token, r2: rotated.next.token };
}

describe('classifyRefreshReplay', () => {
  it('calls an immediate replay a retry and revokes nothing', () => {
    const subject = store();
    const { r1, r2 } = chainOfTwo(subject);

    const verdict = subject.classifyRefreshReplay(r1);

    expect(verdict.verdict).toBe('retry');
    expect(verdict.revoked).toBe(0);
    // The whole point: the descendant the legitimate client just got survives.
    expect(subject.lookupToken(r2, 'refresh')).toBeDefined();
  });

  it('calls a replay past the grace window theft and revokes the descendant', () => {
    const subject = store();
    const { r1, r2 } = chainOfTwo(subject);

    const verdict = subject.classifyRefreshReplay(r1, 0);

    expect(verdict.verdict).toBe('theft');
    expect(verdict.revoked).toBeGreaterThan(0);
    // Whoever won the race must not keep a working credential.
    expect(subject.lookupToken(r2, 'refresh')).toBeUndefined();
  });

  it('respects the window boundary using the clock it is given', () => {
    const subject = store();
    const { r1 } = chainOfTwo(subject);

    const inside = subject.classifyRefreshReplay(r1, 10_000, new Date(Date.now() + 5_000));
    expect(inside.verdict).toBe('retry');

    const outside = subject.classifyRefreshReplay(r1, 10_000, new Date(Date.now() + 60_000));
    expect(outside.verdict).toBe('theft');
  });

  it('does not treat an unknown token as a replay', () => {
    const subject = store();
    chainOfTwo(subject);
    expect(subject.classifyRefreshReplay('never-issued-this', 0).verdict).toBe('unrelated');
  });

  it('does not treat an admin revoke as a replay', () => {
    const subject = store();
    const client = subject.registerClient({ redirectUris: ['https://claude.ai/cb'] });
    const token = subject.issueToken({
      kind: 'refresh', clientId: client.clientId, audience: 'https://x/mcp', scope: 'mcp', ttlMs: 600_000,
    });
    // Revoked, but never rotated: rotated_to stays null, so this is not reuse.
    subject.revokeToken(token.token);

    expect(subject.classifyRefreshReplay(token.token, 0).verdict).toBe('unrelated');
  });

  it('does not treat an access token as a refresh replay', () => {
    const subject = store();
    const client = subject.registerClient({ redirectUris: ['https://claude.ai/cb'] });
    const access = subject.issueToken({
      kind: 'access', clientId: client.clientId, audience: 'https://x/mcp', scope: 'mcp', ttlMs: 600_000,
    });
    expect(subject.classifyRefreshReplay(access.token, 0).verdict).toBe('unrelated');
  });

  /**
   * The gap Bodhi found in this suite: every other test here passes against
   * an implementation that responds to theft by calling revokeClientTokens,
   * nuking every session the client has. Revocation must be scoped to the
   * compromised chain, and nothing pinned that.
   */
  it('leaves an unrelated chain of the same client alone', () => {
    const subject = store();
    const client = subject.registerClient({ redirectUris: ['https://claude.ai/cb'] });
    const mint = (): string =>
      subject.issueToken({
        kind: 'refresh', clientId: client.clientId, audience: 'https://x/mcp', scope: 'mcp', ttlMs: 600_000,
      }).token;

    // Two independent sessions for the same client - a phone and a laptop.
    const compromised = mint();
    const innocent = mint();
    const compromisedNext = subject.rotateRefreshToken(compromised, 600_000)!.next.token;
    const innocentNext = subject.rotateRefreshToken(innocent, 600_000)!.next.token;

    const verdict = subject.classifyRefreshReplay(compromised, 0);
    expect(verdict.verdict).toBe('theft');

    // The stolen chain dies...
    expect(subject.lookupToken(compromisedNext, 'refresh')).toBeUndefined();
    // ...and the other session keeps working.
    expect(subject.lookupToken(innocentNext, 'refresh')).toBeDefined();
  });

  /**
   * Revoking the refresh chain used to leave the access tokens issued
   * alongside it live until their own expiry, so a detected thief kept
   * calling the API for up to accessTokenTtlMs after detection. There was no
   * way to scope that: nothing recorded which chain an access token belonged
   * to.
   */
  it('takes the chain\'s access tokens with it', () => {
    const subject = store();
    const client = subject.registerClient({ redirectUris: ['https://claude.ai/cb'] });
    const refresh = subject.issueToken({
      kind: 'refresh', clientId: client.clientId, audience: 'https://x/mcp', scope: 'mcp', ttlMs: 600_000,
    });
    const access = subject.issueToken({
      kind: 'access', parentToken: refresh.token, clientId: client.clientId,
      audience: 'https://x/mcp', scope: 'mcp', ttlMs: 600_000,
    });
    const next = subject.rotateRefreshToken(refresh.token, 600_000)!;
    const accessAfterRotation = subject.issueToken({
      kind: 'access', parentToken: next.next.token, clientId: client.clientId,
      audience: 'https://x/mcp', scope: 'mcp', ttlMs: 600_000,
    });

    expect(subject.lookupToken(access.token, 'access')).toBeDefined();
    expect(subject.lookupToken(accessAfterRotation.token, 'access')).toBeDefined();

    const verdict = subject.classifyRefreshReplay(refresh.token, 0);
    expect(verdict.verdict).toBe('theft');

    // Both links' access tokens are gone, not just the head's.
    expect(subject.lookupToken(access.token, 'access')).toBeUndefined();
    expect(subject.lookupToken(accessAfterRotation.token, 'access')).toBeUndefined();
  });

  it('does not touch another session\'s access token', () => {
    const subject = store();
    const client = subject.registerClient({ redirectUris: ['https://claude.ai/cb'] });
    const mintPair = (): { refresh: string; access: string } => {
      const r = subject.issueToken({
        kind: 'refresh', clientId: client.clientId, audience: 'https://x/mcp', scope: 'mcp', ttlMs: 600_000,
      });
      const a = subject.issueToken({
        kind: 'access', parentToken: r.token, clientId: client.clientId,
        audience: 'https://x/mcp', scope: 'mcp', ttlMs: 600_000,
      });
      return { refresh: r.token, access: a.token };
    };
    const compromised = mintPair();
    const innocent = mintPair();
    subject.rotateRefreshToken(compromised.refresh, 600_000);

    expect(subject.classifyRefreshReplay(compromised.refresh, 0).verdict).toBe('theft');

    expect(subject.lookupToken(compromised.access, 'access')).toBeUndefined();
    // The laptop session keeps working.
    expect(subject.lookupToken(innocent.access, 'access')).toBeDefined();
  });

  it('tolerates a pre-migration access token with no recorded parent', () => {
    const subject = store();
    const client = subject.registerClient({ redirectUris: ['https://claude.ai/cb'] });
    const refresh = subject.issueToken({
      kind: 'refresh', clientId: client.clientId, audience: 'https://x/mcp', scope: 'mcp', ttlMs: 600_000,
    });
    // No parentToken: exactly what rows written before the migration look like.
    const orphan = subject.issueToken({
      kind: 'access', clientId: client.clientId, audience: 'https://x/mcp', scope: 'mcp', ttlMs: 600_000,
    });
    subject.rotateRefreshToken(refresh.token, 600_000);

    expect(subject.classifyRefreshReplay(refresh.token, 0).verdict).toBe('theft');
    // Not chain-revocable, which is the old behaviour rather than a crash.
    expect(subject.lookupToken(orphan.token, 'access')).toBeDefined();
  });

  it('reports a truncated walk so missed descendants are visible', () => {
    const subject = store();
    const { r1, r2 } = chainOfTwo(subject);
    const third = subject.rotateRefreshToken(r2, 600_000);
    if (!third) throw new Error('second rotation should have succeeded');

    const intact = subject.classifyRefreshReplay(r1, 0);
    expect(intact.verdict).toBe('theft');
    expect(intact.truncated).toBe(false);
  });

  it('revokes a longer chain, not just the next link', () => {
    const subject = store();
    const { r1, r2 } = chainOfTwo(subject);
    const third = subject.rotateRefreshToken(r2, 600_000);
    if (!third) throw new Error('second rotation should have succeeded');
    const r3 = third.next.token;

    const verdict = subject.classifyRefreshReplay(r1, 0);

    expect(verdict.verdict).toBe('theft');
    expect(subject.lookupToken(r3, 'refresh')).toBeUndefined();
  });
});
