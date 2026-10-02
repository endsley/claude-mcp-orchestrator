import type { AuthInfo } from '@modelcontextprotocol/server';
import { SCOPE_FULL, type Scope } from './scopes.js';

/**
 * Who is calling, as established by authentication - never by tool arguments.
 *
 * `board` is the caller's identity on the coordination board. It is derived
 * here, from the credential, so a tool handler has no way to take it from the
 * request: every board write records the authenticated caller.
 */
export interface Principal {
  kind: 'oauth' | 'board-key' | 'static-bearer' | 'local';
  scopes: ReadonlySet<Scope>;
  board: {
    /** Display name recorded on the board (`agent`). */
    agent: string;
    /** Stable per-identity session id recorded on the board. */
    sessionId: string;
  };
}

/** Max length the board accepts for an agent name. */
const MAX_AGENT_CHARS = 80;

/**
 * Make an attacker-supplied label safe to record. OAuth client names come
 * from unauthenticated dynamic registration, so strip control characters,
 * collapse whitespace and cap the length.
 */
export function sanitizeLabel(value: string, maxChars: number): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, maxChars);
}

export function oauthPrincipal(input: { clientId: string; clientName?: string; scopes: ReadonlySet<Scope> }): Principal {
  const label = sanitizeLabel(input.clientName ?? '', MAX_AGENT_CHARS - 'oauth:'.length) || input.clientId;
  return {
    kind: 'oauth',
    scopes: input.scopes,
    board: {
      agent: `oauth:${label}`,
      // Keyed by client_id, not client_name: names are not unique, and two
      // clients that registered the same name must not share a board session.
      sessionId: `ext-oauth-${input.clientId}`,
    },
  };
}

export function boardKeyPrincipal(name: string, scopes: ReadonlySet<Scope>): Principal {
  // Each credential kind has its own session-id namespace (ext-key-,
  // ext-oauth-, ext-owner-), so no key name can produce another kind's id.
  return { kind: 'board-key', scopes, board: { agent: name, sessionId: `ext-key-${name}` } };
}

export function staticBearerPrincipal(): Principal {
  return { kind: 'static-bearer', scopes: new Set([SCOPE_FULL]), board: { agent: 'owner-bearer', sessionId: 'ext-owner-bearer' } };
}

export function localPrincipal(): Principal {
  return { kind: 'local', scopes: new Set([SCOPE_FULL]), board: { agent: 'owner-local', sessionId: 'ext-owner-local' } };
}

const PRINCIPAL_KEY = 'claudeMcpOrchestratorPrincipal';

/**
 * Carry the principal through the SDK as AuthInfo. The `token` field is a
 * placeholder on purpose: nothing downstream needs the credential, and not
 * passing it means it cannot leak from there.
 */
export function principalToAuthInfo(principal: Principal, clientId: string): AuthInfo {
  return { token: '[redacted]', clientId, scopes: [...principal.scopes], extra: { [PRINCIPAL_KEY]: principal } };
}

/** Recover the principal; undefined (=> no tools) when absent or malformed. */
export function principalFromAuthInfo(authInfo: AuthInfo | undefined): Principal | undefined {
  const value = authInfo?.extra?.[PRINCIPAL_KEY] as Principal | undefined;
  if (!value || typeof value !== 'object' || !(value.scopes instanceof Set)) return undefined;
  return value;
}
