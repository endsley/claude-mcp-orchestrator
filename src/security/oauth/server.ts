import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import type { Logger } from '../../logging/logger.js';
import { type OAuthStore } from './store.js';
import { canonicalResource, mintSecret, safeEquals, verifyPkce } from './tokens.js';

export interface OAuthServerOptions {
  /** Public origin this server is reached at, e.g. https://mcp.example.com */
  issuer: string;
  /** Canonical resource identifier of the MCP endpoint (RFC 8707 audience). */
  resource: string;
  /** Scopes this resource understands. */
  scopesSupported: string[];
  /** Password that gates the consent screen. */
  adminPassword: string;
  accessTokenTtlMs: number;
  refreshTokenTtlMs: number;
  authorizationCodeTtlMs: number;
  store: OAuthStore;
  logger: Logger;
}

/** Escape text for interpolation into HTML. Client names are attacker-supplied. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function oauthError(res: Response, status: number, error: string, description?: string): void {
  res.status(status).json({ error, ...(description ? { error_description: description } : {}) });
}

/**
 * Simple fixed-window throttle.
 *
 * Used for the consent password, which is the one place a human secret is
 * checked and therefore the one place worth brute forcing, and for dynamic
 * client registration, which is unauthenticated by design.
 *
 * Keyed by IP, with an important caveat: this server listens on loopback
 * behind a Cloudflare tunnel and does not set Express `trust proxy`, so every
 * remote request presents the same loopback address. In that deployment the
 * key is constant and the limit is effectively global rather than per-client.
 * That is acceptable for a single-user server - a global cap still bounds the
 * damage - and the moment a real client IP is forwarded the same code becomes
 * per-IP with no change. State is in-memory on purpose so a restart clears it.
 */
class FixedWindowThrottle {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit = 5,
    private readonly windowMs = 5 * 60_000,
  ) {}

  check(key: string): boolean {
    const now = Date.now();
    const entry = this.attempts.get(key);
    if (!entry) return true;
    if (entry.resetAt <= now) {
      // Drop it rather than leaving it to sit forever. Behind the tunnel
      // there is effectively one key so this was latent, but the server
      // supports non-loopback binds, where every distinct source address
      // left a permanent entry and a slow drip of addresses grew the map
      // without limit.
      this.attempts.delete(key);
      return true;
    }
    return entry.count < this.limit;
  }

  record(key: string): void {
    const now = Date.now();
    const entry = this.attempts.get(key);
    if (!entry || entry.resetAt <= now) {
      this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    entry.count += 1;
  }

  clear(key: string): void {
    this.attempts.delete(key);
  }
}

/**
 * The built-in OAuth 2.1 authorization server.
 *
 * Hosting the AS alongside the resource server is explicitly allowed by the MCP
 * authorization spec, and for a single-user personal server it avoids standing
 * up an external identity provider just to prove one person is themselves.
 */
export function createOAuthRouter(options: OAuthServerOptions): Router {
  const router = express.Router();
  const { store, logger } = options;
  const throttle = new FixedWindowThrottle();
  // Registration creates a permanent row and is reachable by anyone who can
  // reach the tunnel. Tokens expire; clients never do and are never pruned,
  // so before this an unbounded caller could grow the database until the disk
  // was gone. This bounds the RATE, not the total - a determined caller can
  // still add rows slowly, and pruning clients that never completed an
  // authorization is the remaining piece of work.
  const registrationThrottle = new FixedWindowThrottle(30, 15 * 60_000);
  const MAX_REDIRECT_URIS = 10;
  const resource = canonicalResource(options.resource);

  // Pending consents: maps an opaque request id to the validated authorization
  // request, so the POSTed form cannot smuggle different parameters than the
  // ones we validated and displayed.
  const pending = new Map<
    string,
    {
      clientId: string;
      redirectUri: string;
      state?: string;
      codeChallenge: string;
      codeChallengeMethod: string;
      scope: string;
      resource?: string;
      expiresAt: number;
    }
  >();

  const prunePending = (): void => {
    const now = Date.now();
    for (const [key, value] of pending) if (value.expiresAt <= now) pending.delete(key);
  };

  router.use(express.urlencoded({ extended: false, limit: '32kb' }));

  // ------------------------------------------------- RFC 9728 resource metadata
  const protectedResourceMetadata = (_req: Request, res: Response): void => {
    res.json({
      resource,
      authorization_servers: [options.issuer],
      scopes_supported: options.scopesSupported,
      bearer_methods_supported: ['header'],
      resource_documentation: `${options.issuer}/`,
    });
  };
  router.get('/.well-known/oauth-protected-resource', protectedResourceMetadata);
  // Clients also probe the path-suffixed form for a non-root MCP endpoint.
  router.get('/.well-known/oauth-protected-resource/*splat', protectedResourceMetadata);

  // ------------------------------------------------------ RFC 8414 AS metadata
  router.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
    res.json({
      issuer: options.issuer,
      authorization_endpoint: `${options.issuer}/oauth/authorize`,
      token_endpoint: `${options.issuer}/oauth/token`,
      registration_endpoint: `${options.issuer}/oauth/register`,
      revocation_endpoint: `${options.issuer}/oauth/revoke`,
      scopes_supported: options.scopesSupported,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      // Absent or non-S256 here makes a conforming MCP client refuse to proceed.
      code_challenge_methods_supported: ['S256'],
      resource_indicators_supported: true,
    });
  });
  // Some clients probe the OIDC path; answer with the same document.
  router.get('/.well-known/openid-configuration', (_req: Request, res: Response) => {
    res.redirect(308, '/.well-known/oauth-authorization-server');
  });

  // ------------------------------------------- RFC 7591 dynamic registration
  router.post('/oauth/register', express.json({ limit: '32kb' }), (req: Request, res: Response) => {
    const throttleKey = req.ip ?? 'unknown';
    if (!registrationThrottle.check(throttleKey)) {
      logger.warn('registration throttled', { ip: throttleKey });
      oauthError(res, 429, 'too_many_requests', 'Too many client registrations. Try again later.');
      return;
    }
    // Budget is spent below, only once the request has passed validation.
    // Recording first let a malformed request consume the allowance without
    // ever creating a row, which spends the owner's shared bucket on traffic
    // that was never going to cost anything.

    const body = (req.body ?? {}) as Record<string, unknown>;
    const redirectUris = Array.isArray(body['redirect_uris']) ? (body['redirect_uris'] as unknown[]) : [];
    if (redirectUris.length > MAX_REDIRECT_URIS) {
      oauthError(res, 400, 'invalid_redirect_uri', `at most ${MAX_REDIRECT_URIS} redirect_uris are allowed`);
      return;
    }

    const uris: string[] = [];
    for (const candidate of redirectUris) {
      if (typeof candidate !== 'string') continue;
      let parsed: URL;
      try {
        parsed = new URL(candidate);
      } catch {
        oauthError(res, 400, 'invalid_redirect_uri', `not a valid URL: ${candidate}`);
        return;
      }
      // OAuth 2.1: https everywhere, with plain http allowed only on loopback.
      //
      // Stated as an allowlist on purpose. The previous form tested
      // `protocol !== 'https:' && !isLoopback && protocol !== 'http:'`, which
      // short-circuits on `!isLoopback`, so for a loopback host NO scheme
      // check ran and gopher://localhost/x or ftp://127.0.0.1/y registered
      // happily. Enumerate what is allowed rather than what is forbidden.
      const isLoopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
      const allowed = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopback);
      if (!allowed) {
        oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uri must use https, or http on loopback');
        return;
      }
      uris.push(candidate);
    }

    if (uris.length === 0) {
      oauthError(res, 400, 'invalid_redirect_uri', 'at least one redirect_uri is required');
      return;
    }

    // Validation passed and a row is about to exist: charge it now.
    registrationThrottle.record(throttleKey);

    const client = store.registerClient({
      ...(typeof body['client_name'] === 'string' ? { clientName: body['client_name'] } : {}),
      redirectUris: uris,
      ...(typeof body['client_uri'] === 'string' ? { clientUri: body['client_uri'] } : {}),
      ...(typeof body['scope'] === 'string' ? { scope: body['scope'] } : {}),
    });

    logger.info('registered oauth client', { clientId: client.clientId, clientName: client.clientName });

    res.status(201).json({
      client_id: client.clientId,
      client_id_issued_at: Math.floor(new Date(client.createdAt).getTime() / 1000),
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      response_types: client.responseTypes,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      ...(client.clientName ? { client_name: client.clientName } : {}),
    });
  });

  // ------------------------------------------------------ authorization endpoint
  router.get('/oauth/authorize', (req: Request, res: Response) => {
    prunePending();
    const q = req.query as Record<string, string | undefined>;

    const clientId = q['client_id'];
    const redirectUri = q['redirect_uri'];
    const responseType = q['response_type'];
    const codeChallenge = q['code_challenge'];
    const codeChallengeMethod = q['code_challenge_method'] ?? 'plain';

    if (!clientId || !redirectUri) {
      oauthError(res, 400, 'invalid_request', 'client_id and redirect_uri are required');
      return;
    }
    const client = store.getClient(clientId);
    if (!client) {
      oauthError(res, 400, 'invalid_client', 'unknown client_id');
      return;
    }
    // Exact match only. A prefix match here is the classic open-redirect bug.
    if (!client.redirectUris.includes(redirectUri)) {
      oauthError(res, 400, 'invalid_request', 'redirect_uri does not match a registered value');
      return;
    }

    // From here on errors go back to the client via the (now trusted) redirect.
    const fail = (error: string, description: string): void => {
      const target = new URL(redirectUri);
      target.searchParams.set('error', error);
      target.searchParams.set('error_description', description);
      if (q['state']) target.searchParams.set('state', q['state']);
      res.redirect(302, target.toString());
    };

    if (responseType !== 'code') {
      fail('unsupported_response_type', 'only the authorization code flow is supported');
      return;
    }
    if (!codeChallenge || codeChallengeMethod !== 'S256') {
      fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
      return;
    }
    if (q['resource'] !== undefined) {
      let requested: string;
      try {
        requested = canonicalResource(q['resource']);
      } catch {
        fail('invalid_target', 'resource is not a valid URI');
        return;
      }
      if (requested !== resource) {
        fail('invalid_target', `this authorization server only issues tokens for ${resource}`);
        return;
      }
    }

    const requestId = mintSecret(16);
    pending.set(requestId, {
      clientId,
      redirectUri,
      ...(q['state'] !== undefined ? { state: q['state'] } : {}),
      codeChallenge,
      codeChallengeMethod,
      scope: q['scope'] ?? options.scopesSupported.join(' '),
      ...(q['resource'] !== undefined ? { resource: q['resource'] } : {}),
      expiresAt: Date.now() + 10 * 60_000,
    });

    res.type('html').send(consentPage({
      requestId,
      clientName: client.clientName ?? client.clientId,
      redirectUri,
      resource,
      scope: q['scope'] ?? options.scopesSupported.join(' '),
    }));
  });

  router.post('/oauth/authorize', (req: Request, res: Response) => {
    prunePending();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const requestId = typeof body['request_id'] === 'string' ? body['request_id'] : '';
    const password = typeof body['password'] === 'string' ? body['password'] : '';
    const approved = body['approve'] === 'yes';

    const entry = pending.get(requestId);
    if (!entry) {
      res.status(400).type('html').send(errorPage('This approval request expired. Start again from Claude.'));
      return;
    }

    const throttleKey = req.ip ?? 'unknown';
    if (!throttle.check(throttleKey)) {
      logger.warn('consent throttled', { ip: throttleKey });
      res.status(429).type('html').send(errorPage('Too many attempts. Wait a few minutes and try again.'));
      return;
    }

    if (!approved) {
      pending.delete(requestId);
      const target = new URL(entry.redirectUri);
      target.searchParams.set('error', 'access_denied');
      if (entry.state) target.searchParams.set('state', entry.state);
      res.redirect(302, target.toString());
      return;
    }

    if (!safeEquals(password, options.adminPassword)) {
      throttle.record(throttleKey);
      logger.warn('consent password rejected', { ip: throttleKey });
      res.status(401).type('html').send(
        consentPage({
          requestId,
          clientName: store.getClient(entry.clientId)?.clientName ?? entry.clientId,
          redirectUri: entry.redirectUri,
          resource,
          scope: entry.scope,
          error: 'Incorrect password.',
        }),
      );
      return;
    }

    throttle.clear(throttleKey);
    pending.delete(requestId);

    const code = store.issueAuthorizationCode({
      clientId: entry.clientId,
      redirectUri: entry.redirectUri,
      codeChallenge: entry.codeChallenge,
      codeChallengeMethod: entry.codeChallengeMethod,
      ...(entry.resource !== undefined ? { resource: entry.resource } : {}),
      scope: entry.scope,
      ttlMs: options.authorizationCodeTtlMs,
    });

    logger.info('authorization granted', { clientId: entry.clientId });

    const target = new URL(entry.redirectUri);
    target.searchParams.set('code', code);
    if (entry.state) target.searchParams.set('state', entry.state);
    res.redirect(302, target.toString());
  });

  // -------------------------------------------------------------- token endpoint
  router.post('/oauth/token', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const grantType = typeof body['grant_type'] === 'string' ? body['grant_type'] : '';

    if (grantType === 'authorization_code') {
      const code = typeof body['code'] === 'string' ? body['code'] : '';
      const redirectUri = typeof body['redirect_uri'] === 'string' ? body['redirect_uri'] : '';
      const verifier = typeof body['code_verifier'] === 'string' ? body['code_verifier'] : '';
      const clientId = typeof body['client_id'] === 'string' ? body['client_id'] : '';

      // Every rejection below answers with the SAME description. The four
      // reasons used to be distinguishable - "invalid, expired or already
      // used" versus "not issued to this client" versus "redirect_uri does
      // not match" versus "PKCE verification failed" - which let anyone
      // holding a code probe server state: whether the code exists, which
      // client it belongs to, and which redirect was registered. The specific
      // reason is logged instead, so an operator debugging a real client
      // still gets it while a caller learns only that the grant failed.
      //
      // Note the deliberate ordering: the code is consumed BEFORE these
      // checks, so a failed redemption burns it. That is intended. OAuth 2.1
      // requires single use and recommends invalidating a code on suspected
      // abuse, and an attacker who intercepted a code and guesses at the
      // verifier should destroy it rather than be allowed to retry. The cost
      // is that a buggy client forces a fresh consent, which is an annoyance
      // rather than a weakness.
      const denyGrant = (reason: string): void => {
        logger.warn('authorization code rejected', { reason, clientId: clientId || undefined });
        oauthError(res, 400, 'invalid_grant', 'authorization code is invalid, expired or already used');
      };

      const record = store.consumeAuthorizationCode(code);
      if (!record) {
        denyGrant('unknown, expired or already used');
        return;
      }
      if (record.clientId !== clientId) {
        denyGrant('client mismatch');
        return;
      }
      if (record.redirectUri !== redirectUri) {
        denyGrant('redirect_uri mismatch');
        return;
      }
      if (!verifyPkce(verifier, record.codeChallenge, record.codeChallengeMethod)) {
        denyGrant('pkce verification failed');
        return;
      }

      issueTokenPair(res, record.clientId, record.resource ?? resource, record.scope);
      return;
    }

    if (grantType === 'refresh_token') {
      const refreshToken = typeof body['refresh_token'] === 'string' ? body['refresh_token'] : '';
      const rotated = store.rotateRefreshToken(refreshToken, options.refreshTokenTtlMs);
      if (!rotated) {
        // A refused refresh may be a replay of an already-rotated token,
        // which is the classic token-theft signal. Refusing the request is
        // not enough on its own: whoever won the rotation still holds a
        // working descendant. classifyRefreshReplay decides whether this
        // looks like theft or like a client retrying within moments, and only
        // the former revokes the chain - a naive version without that
        // distinction turned an ordinary concurrent retry into a forced
        // re-consent.
        const replay = store.classifyRefreshReplay(refreshToken);
        if (replay.verdict === 'theft') {
          logger.warn('refresh token reuse detected; revoked the rotation chain', {
            revoked: replay.revoked,
          });
        }
        oauthError(res, 400, 'invalid_grant', 'refresh token is invalid, expired or already used');
        return;
      }
      const access = store.issueToken({
        kind: 'access',
        clientId: rotated.record.clientId,
        audience: rotated.record.audience,
        scope: rotated.record.scope,
        ttlMs: options.accessTokenTtlMs,
      });
      res.json({
        access_token: access.token,
        token_type: 'Bearer',
        expires_in: Math.floor(options.accessTokenTtlMs / 1000),
        refresh_token: rotated.next.token,
        scope: rotated.record.scope,
      });
      return;
    }

    oauthError(res, 400, 'unsupported_grant_type', `grant_type "${grantType}" is not supported`);
  });

  function issueTokenPair(res: Response, clientId: string, audience: string, scope: string): void {
    const access = store.issueToken({
      kind: 'access',
      clientId,
      audience: canonicalResource(audience),
      scope,
      ttlMs: options.accessTokenTtlMs,
    });
    const refresh = store.issueToken({
      kind: 'refresh',
      clientId,
      audience: canonicalResource(audience),
      scope,
      ttlMs: options.refreshTokenTtlMs,
    });
    res.json({
      access_token: access.token,
      token_type: 'Bearer',
      expires_in: Math.floor(options.accessTokenTtlMs / 1000),
      refresh_token: refresh.token,
      scope,
    });
  }

  router.post('/oauth/revoke', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body['token'] === 'string') store.revokeToken(body['token']);
    // RFC 7009: always 200, so an attacker learns nothing about token validity.
    res.status(200).json({});
  });

  router.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('oauth route error', { err: error });
    if (!res.headersSent) oauthError(res, 500, 'server_error', 'unexpected error');
  });

  return router;
}

// ------------------------------------------------------------------- views

function consentPage(input: {
  requestId: string;
  clientName: string;
  redirectUri: string;
  resource: string;
  scope: string;
  error?: string;
}): string {
  const host = (() => {
    try {
      return new URL(input.redirectUri).host || input.redirectUri;
    } catch {
      return input.redirectUri;
    }
  })();

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize access</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         margin:0; padding:2rem 1.25rem; display:flex; justify-content:center; }
  main { width:100%; max-width:26rem; }
  h1 { font-size:1.25rem; margin:0 0 .25rem; }
  p { line-height:1.5; margin:.5rem 0; }
  .muted { opacity:.7; font-size:.9rem; }
  .box { border:1px solid rgba(128,128,128,.35); border-radius:.6rem; padding:.85rem 1rem; margin:1rem 0; }
  .row { display:flex; justify-content:space-between; gap:1rem; font-size:.9rem; padding:.2rem 0; }
  .row span:first-child { opacity:.7; }
  .warn { border-left:3px solid #d97706; padding-left:.75rem; font-size:.9rem; }
  .err { color:#dc2626; font-weight:600; }
  label { display:block; margin:1rem 0 .35rem; font-size:.9rem; }
  input[type=password] { width:100%; padding:.7rem; font-size:1rem; border-radius:.45rem;
                         border:1px solid rgba(128,128,128,.5); background:transparent; color:inherit; box-sizing:border-box; }
  .actions { display:flex; gap:.6rem; margin-top:1.25rem; }
  button { flex:1; padding:.75rem; font-size:1rem; border-radius:.45rem; border:0; cursor:pointer; }
  .approve { background:#2563eb; color:#fff; }
  .deny { background:transparent; border:1px solid rgba(128,128,128,.5); color:inherit; }
</style></head>
<body><main>
  <h1>Authorize access</h1>
  <p class="muted">A client is asking to control Claude Code on your computer.</p>
  ${input.error ? `<p class="err">${escapeHtml(input.error)}</p>` : ''}
  <div class="box">
    <div class="row"><span>Client</span><strong>${escapeHtml(input.clientName)}</strong></div>
    <div class="row"><span>Redirects to</span><strong>${escapeHtml(host)}</strong></div>
    <div class="row"><span>Resource</span><strong>${escapeHtml(input.resource)}</strong></div>
    <div class="row"><span>Scope</span><strong>${escapeHtml(input.scope)}</strong></div>
  </div>
  <p class="warn">Approving lets this client start Claude Code sessions that can read and
  modify files in your configured project directories. Only approve a client you started yourself.</p>
  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="request_id" value="${escapeHtml(input.requestId)}">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
    <div class="actions">
      <button class="deny" type="submit" name="approve" value="no">Deny</button>
      <button class="approve" type="submit" name="approve" value="yes">Approve</button>
    </div>
  </form>
</main></body></html>`;
}

function errorPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorization error</title></head>
<body style="font-family:sans-serif;padding:2rem"><h1 style="font-size:1.2rem">Authorization error</h1>
<p>${escapeHtml(message)}</p></body></html>`;
}
