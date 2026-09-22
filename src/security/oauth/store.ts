import { randomUUID } from 'node:crypto';
import type { Db } from '../../db/database.js';
import { orchestratorError } from '../../types/errors.js';
import { hashSecret, mintSecret } from './tokens.js';

/**
 * How long after a rotation a replay of the old refresh token is treated as
 * a benign retry rather than theft. Concurrent refreshes and post-timeout
 * retries land within moments; a thief replaying a stolen token generally
 * does not.
 */
const REFRESH_REPLAY_GRACE_MS = 10_000;

export interface OAuthClient {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: string;
  scope?: string;
  clientUri?: string;
  createdAt: string;
}

export interface IssuedToken {
  token: string;
  expiresAt: Date;
}

export interface TokenRecord {
  kind: 'access' | 'refresh';
  clientId: string;
  audience: string;
  scope: string;
  expiresAt: string;
  revokedAt?: string;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Persistence for the built-in authorization server.
 *
 * Everything secret (authorization codes, access tokens, refresh tokens) is
 * keyed by hash. The plaintext exists only in the HTTP response that hands it
 * to the client and is never written anywhere.
 */
export class OAuthStore {
  constructor(private readonly db: Db) {}

  private now(): string {
    return new Date().toISOString();
  }

  // ----------------------------------------------------------------- clients

  registerClient(input: {
    clientName?: string;
    redirectUris: string[];
    grantTypes?: string[];
    responseTypes?: string[];
    tokenEndpointAuthMethod?: string;
    scope?: string;
    clientUri?: string;
  }): OAuthClient {
    const clientId = `mcpc_${randomUUID().replace(/-/g, '')}`;
    const client: OAuthClient = {
      clientId,
      ...(input.clientName !== undefined ? { clientName: input.clientName } : {}),
      redirectUris: input.redirectUris,
      grantTypes: input.grantTypes ?? ['authorization_code', 'refresh_token'],
      responseTypes: input.responseTypes ?? ['code'],
      // Public client: a phone app cannot hold a secret, so PKCE is the defence.
      tokenEndpointAuthMethod: input.tokenEndpointAuthMethod ?? 'none',
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.clientUri !== undefined ? { clientUri: input.clientUri } : {}),
      createdAt: this.now(),
    };

    this.db
      .prepare(
        `INSERT INTO oauth_clients
           (client_id, client_name, redirect_uris_json, grant_types_json, response_types_json,
            token_endpoint_auth_method, scope, client_uri, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        client.clientId,
        client.clientName ?? null,
        JSON.stringify(client.redirectUris),
        JSON.stringify(client.grantTypes),
        JSON.stringify(client.responseTypes),
        client.tokenEndpointAuthMethod,
        client.scope ?? null,
        client.clientUri ?? null,
        client.createdAt,
      );
    return client;
  }

  getClient(clientId: string): OAuthClient | undefined {
    const row = this.db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as
      | {
          client_id: string;
          client_name: string | null;
          redirect_uris_json: string;
          grant_types_json: string;
          response_types_json: string;
          token_endpoint_auth_method: string;
          scope: string | null;
          client_uri: string | null;
          created_at: string;
        }
      | undefined;
    if (!row) return undefined;
    const client: OAuthClient = {
      clientId: row.client_id,
      redirectUris: parseJson<string[]>(row.redirect_uris_json, []),
      grantTypes: parseJson<string[]>(row.grant_types_json, []),
      responseTypes: parseJson<string[]>(row.response_types_json, []),
      tokenEndpointAuthMethod: row.token_endpoint_auth_method,
      createdAt: row.created_at,
    };
    if (row.client_name) client.clientName = row.client_name;
    if (row.scope) client.scope = row.scope;
    if (row.client_uri) client.clientUri = row.client_uri;
    return client;
  }

  // ------------------------------------------------------- authorization code

  /**
   * Issue a single-use authorization code, binding everything the token request
   * must later be checked against. Binding at issue time is what prevents a
   * stolen code being redeemed by a different client or redirect URI.
   */
  issueAuthorizationCode(input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    resource?: string;
    scope: string;
    ttlMs: number;
  }): string {
    const code = mintSecret(32);
    const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();
    this.db
      .prepare(
        `INSERT INTO oauth_authorization_codes
           (code_hash, client_id, redirect_uri, code_challenge, code_challenge_method,
            resource, scope, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        hashSecret(code),
        input.clientId,
        input.redirectUri,
        input.codeChallenge,
        input.codeChallengeMethod,
        input.resource ?? null,
        input.scope,
        expiresAt,
        this.now(),
      );
    return code;
  }

  /**
   * Atomically consume an authorization code.
   *
   * The UPDATE-then-check makes redemption single-use even under concurrent
   * requests: only one caller can transition `consumed_at` from NULL.
   */
  consumeAuthorizationCode(code: string):
    | {
        clientId: string;
        redirectUri: string;
        codeChallenge: string;
        codeChallengeMethod: string;
        resource?: string;
        scope: string;
      }
    | undefined {
    const codeHash = hashSecret(code);
    const run = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT * FROM oauth_authorization_codes WHERE code_hash = ?')
        .get(codeHash) as
        | {
            client_id: string;
            redirect_uri: string;
            code_challenge: string;
            code_challenge_method: string;
            resource: string | null;
            scope: string;
            expires_at: string;
            consumed_at: string | null;
          }
        | undefined;
      if (!row) return undefined;
      if (row.consumed_at !== null) return undefined;
      if (new Date(row.expires_at).getTime() <= Date.now()) return undefined;

      const result = this.db
        .prepare('UPDATE oauth_authorization_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL')
        .run(this.now(), codeHash);
      if (result.changes === 0) return undefined;

      return {
        clientId: row.client_id,
        redirectUri: row.redirect_uri,
        codeChallenge: row.code_challenge,
        codeChallengeMethod: row.code_challenge_method,
        ...(row.resource !== null ? { resource: row.resource } : {}),
        scope: row.scope,
      };
    });
    return run();
  }

  // ------------------------------------------------------------------ tokens

  issueToken(input: {
    kind: 'access' | 'refresh';
    clientId: string;
    audience: string;
    scope: string;
    ttlMs: number;
  }): IssuedToken {
    const token = mintSecret(32);
    const expiresAt = new Date(Date.now() + input.ttlMs);
    this.db
      .prepare(
        `INSERT INTO oauth_tokens (token_hash, kind, client_id, audience, scope, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(hashSecret(token), input.kind, input.clientId, input.audience, input.scope, expiresAt.toISOString(), this.now());
    return { token, expiresAt };
  }

  /** Look up a token by its value. Returns undefined when unknown/expired/revoked. */
  lookupToken(token: string, kind: 'access' | 'refresh'): TokenRecord | undefined {
    const row = this.db.prepare('SELECT * FROM oauth_tokens WHERE token_hash = ?').get(hashSecret(token)) as
      | {
          kind: string;
          client_id: string;
          audience: string;
          scope: string;
          expires_at: string;
          revoked_at: string | null;
        }
      | undefined;
    if (!row) return undefined;
    if (row.kind !== kind) return undefined;
    if (row.revoked_at !== null) return undefined;
    if (new Date(row.expires_at).getTime() <= Date.now()) return undefined;
    return {
      kind: row.kind as 'access' | 'refresh',
      clientId: row.client_id,
      audience: row.audience,
      scope: row.scope,
      expiresAt: row.expires_at,
      ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
    };
  }

  /**
   * Rotate a refresh token, as OAuth 2.1 requires for public clients.
   *
   * The old token is revoked in the same transaction that mints the new one, so
   * a replayed refresh token cannot yield a second live credential.
   */
  rotateRefreshToken(oldToken: string, ttlMs: number): { record: TokenRecord; next: IssuedToken } | undefined {
    const run = this.db.transaction(() => {
      const record = this.lookupToken(oldToken, 'refresh');
      if (!record) return undefined;
      const next = this.issueToken({
        kind: 'refresh',
        clientId: record.clientId,
        audience: record.audience,
        scope: record.scope,
        ttlMs,
      });
      // Guarded and checked, matching consumeAuthorizationCode and revokeToken.
      // The lookup above already rejects a revoked token, and better-sqlite3 is
      // synchronous so two rotations cannot interleave today - but that is an
      // assumption about the runtime, not about this code, and it is the kind
      // that stops holding quietly. If the UPDATE ever matches nothing, the
      // token was rotated out from under us and this caller must not win.
      const revoked = this.db
        .prepare('UPDATE oauth_tokens SET revoked_at = ?, rotated_to = ? WHERE token_hash = ? AND revoked_at IS NULL')
        .run(this.now(), hashSecret(next.token), hashSecret(oldToken));
      if (revoked.changes === 0) return undefined;
      return { record, next };
    });
    return run();
  }

  /**
   * Classify a refused refresh, and on a genuine replay revoke the chain.
   *
   * `rotated_to` has been written on every rotation since the schema was
   * created and read nowhere, so the server could see a replay - it answered
   * 400 - and then take no action against the credential the other party was
   * still holding. OAuth 2.1's security BCP says revoke the descendant chain
   * on detected reuse.
   *
   * The grace window is the part that makes this safe to turn on. A client
   * that fires two refreshes concurrently, or retries after a dropped
   * response, presents the same token twice within moments and is not a
   * thief. Revoking the chain for that turns an ordinary network hiccup into
   * a forced re-consent - which is exactly what an earlier naive version of
   * this did, caught by the concurrency tests. So a replay within the window
   * is refused without punishment, and only a later one is treated as theft.
   *
   * `revoked_at` is written at rotation time, so it doubles as the rotation
   * timestamp; no extra column is needed.
   */
  classifyRefreshReplay(
    token: string,
    graceMs: number = REFRESH_REPLAY_GRACE_MS,
    now: Date = new Date(),
  ): { verdict: 'retry' | 'theft' | 'unrelated'; revoked: number } {
    const row = this.db
      .prepare('SELECT kind, revoked_at, rotated_to FROM oauth_tokens WHERE token_hash = ?')
      .get(hashSecret(token)) as { kind: string; revoked_at: string | null; rotated_to: string | null } | undefined;

    // Unknown token, wrong kind, or one that was revoked by something other
    // than a rotation (an admin revoke): none of these is a reuse signal.
    if (row === undefined || row.kind !== 'refresh') return { verdict: 'unrelated', revoked: 0 };
    if (row.revoked_at === null || row.rotated_to === null) return { verdict: 'unrelated', revoked: 0 };

    const rotatedAt = Date.parse(row.revoked_at);
    if (!Number.isFinite(rotatedAt)) return { verdict: 'unrelated', revoked: 0 };
    // graceMs of 0 means no grace at all, so an elapsed time of 0 must not
    // count as inside the window.
    if (graceMs > 0 && now.getTime() - rotatedAt <= graceMs) return { verdict: 'retry', revoked: 0 };

    return { verdict: 'theft', revoked: this.revokeRotationChain(token, now) };
  }

  /** Revoke every token reachable by following `rotated_to` forward. */
  private revokeRotationChain(from: string, now: Date): number {
    const run = this.db.transaction(() => {
      let hash: string | undefined = hashSecret(from);
      const seen = new Set<string>();
      let revoked = 0;
      while (hash !== undefined && !seen.has(hash)) {
        seen.add(hash);
        const row = this.db
          .prepare('SELECT rotated_to, revoked_at FROM oauth_tokens WHERE token_hash = ?')
          .get(hash) as { rotated_to: string | null; revoked_at: string | null } | undefined;
        if (row === undefined) break;
        if (row.revoked_at === null) {
          this.db
            .prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
            .run(now.toISOString(), hash);
          revoked += 1;
        }
        hash = row.rotated_to ?? undefined;
      }
      return revoked;
    });
    return run();
  }

  revokeToken(token: string): void {
    this.db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
      .run(this.now(), hashSecret(token));
  }

  /** Revoke everything issued to a client. Used by the admin revoke endpoint. */
  revokeClientTokens(clientId: string): number {
    return this.db
      .prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL')
      .run(this.now(), clientId).changes;
  }

  /** Housekeeping: drop expired codes and tokens. */
  /**
   * Delete everything that has expired.
   *
   * The token clause used to also require `revoked_at IS NOT NULL OR kind =
   * 'access'`, which left one class behind forever: a refresh token that
   * expired naturally without ever being rotated. That is one permanent row
   * per authorization flow that never refreshed. An expired token cannot be
   * used either way - lookupToken() rejects on expiry before looking at
   * anything else - so keeping it bought nothing.
   */
  pruneExpired(): { codes: number; tokens: number } {
    const now = this.now();
    const codes = this.db.prepare('DELETE FROM oauth_authorization_codes WHERE expires_at <= ?').run(now).changes;
    const tokens = this.db.prepare('DELETE FROM oauth_tokens WHERE expires_at <= ?').run(now).changes;
    return { codes, tokens };
  }

  listClients(): OAuthClient[] {
    const rows = this.db.prepare('SELECT client_id FROM oauth_clients ORDER BY created_at DESC').all() as Array<{
      client_id: string;
    }>;
    return rows.flatMap((row) => {
      const client = this.getClient(row.client_id);
      return client ? [client] : [];
    });
  }

  requireClient(clientId: string): OAuthClient {
    const client = this.getClient(clientId);
    if (!client) {
      throw orchestratorError('AUTH_INVALID', `unknown client_id "${clientId}"`);
    }
    return client;
  }
}
