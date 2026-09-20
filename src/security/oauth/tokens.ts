import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Token and authorization-code primitives.
 *
 * Two rules drive this file:
 *  - secrets are stored HASHED, never in plaintext, so a database read (backup,
 *    stray copy, SQL injection elsewhere) does not yield a usable credential;
 *  - comparisons are constant time, because a plain `===` on a secret is a
 *    timing oracle.
 */

/** 256 bits of entropy, URL-safe. */
export function mintSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** SHA-256 hex. Tokens are high-entropy random values, so a plain hash is
 *  appropriate here - this is not a low-entropy user password. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Verify an RFC 7636 PKCE challenge.
 *
 * Only S256 is accepted. `plain` is permitted by the RFC but forbidden by
 * OAuth 2.1 and by the MCP spec, and accepting it would silently remove the
 * protection that makes a public client safe.
 */
export function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method !== 'S256') return false;
  if (verifier.length < 43 || verifier.length > 128) return false;
  const computed = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return safeEquals(computed, challenge);
}

/**
 * Canonical resource URI per RFC 8707 / MCP: lowercase scheme and host, no
 * fragment, no trailing slash. Used for audience comparison, so both sides must
 * normalise identically or valid tokens get rejected.
 */
export function canonicalResource(value: string): string {
  const url = new URL(value);
  url.hash = '';
  url.username = '';
  url.password = '';
  const path = url.pathname.replace(/\/+$/, '');
  const port = url.port ? `:${url.port}` : '';
  return `${url.protocol.toLowerCase()}//${url.hostname.toLowerCase()}${port}${path}`;
}

/** True when a token's audience covers the resource being accessed. */
export function audienceMatches(tokenAudience: string, resource: string): boolean {
  return canonicalResource(tokenAudience) === canonicalResource(resource);
}
