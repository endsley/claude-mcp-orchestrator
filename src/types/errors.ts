import type { JsonValue } from './json.js';

/**
 * Every failure the MCP layer reports to Android Claude carries one of these
 * codes. The set is closed on purpose: the phone-side model branches on the
 * code, so a new failure mode must be given a name here rather than degrading
 * into an opaque 500.
 */
export const ORCHESTRATOR_ERROR_CODES = [
  'PROJECT_NOT_FOUND',
  'PROJECT_AMBIGUOUS',
  'PROJECT_BUSY',
  'COMPUTER_NOT_FOUND',
  'COMPUTER_AMBIGUOUS',
  'COMPUTER_OFFLINE',
  'COMPUTER_REMOTE_UNSUPPORTED',
  'SESSION_NOT_FOUND',
  'SESSION_ALREADY_FINISHED',
  'SESSION_NOT_ACCEPTING_INPUT',
  'INVALID_STATE_TRANSITION',
  'PENDING_REQUEST_NOT_FOUND',
  'PENDING_REQUEST_ALREADY_ANSWERED',
  'APPROVAL_REQUIRED',
  'PERMISSION_DENIED',
  'CLAUDE_WORKER_FAILED',
  'CLAUDE_WORKER_UNAVAILABLE',
  'CLAUDE_SESSION_RESUME_FAILED',
  'TAILSCALE_UNAVAILABLE',
  'MEMORY_UNAVAILABLE',
  'PROJECT_REGISTRY_UNAVAILABLE',
  'AUTH_REQUIRED',
  'AUTH_INVALID',
  'PROVIDER_TIMEOUT',
  'PROVIDER_FAILED',
  'PROVIDER_NOT_FOUND',
  'PROFILE_NOT_FOUND',
  'INVALID_CONFIG',
  'INVALID_ARGUMENT',
  'PATH_OUTSIDE_SCOPE',
  'ARTIFACT_NOT_FOUND',
  'RATE_LIMITED',
  'UNSAFE_DEPLOYMENT',
  'INTERNAL',
] as const;

export type OrchestratorErrorCode = (typeof ORCHESTRATOR_ERROR_CODES)[number];

export interface OrchestratorErrorPayload {
  code: OrchestratorErrorCode;
  message: string;
  /** Machine-readable extras: candidate lists, offending path, provider id... */
  details?: JsonValue;
  /** True when the same call could plausibly succeed if retried later. */
  retryable?: boolean;
  /** A short next action phrased for a voice assistant to read aloud. */
  hint?: string;
}

export class OrchestratorError extends Error {
  readonly code: OrchestratorErrorCode;
  readonly details?: JsonValue;
  readonly retryable: boolean;
  readonly hint?: string;

  constructor(payload: OrchestratorErrorPayload, options?: { cause?: unknown }) {
    super(payload.message, options);
    this.name = 'OrchestratorError';
    this.code = payload.code;
    if (payload.details !== undefined) this.details = payload.details;
    this.retryable = payload.retryable ?? false;
    if (payload.hint !== undefined) this.hint = payload.hint;
  }

  toPayload(): OrchestratorErrorPayload {
    const payload: OrchestratorErrorPayload = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.details !== undefined) payload.details = this.details;
    if (this.hint !== undefined) payload.hint = this.hint;
    return payload;
  }

  static is(value: unknown): value is OrchestratorError {
    return value instanceof OrchestratorError;
  }
}

/** Convenience constructor so call sites stay one line. */
export function orchestratorError(
  code: OrchestratorErrorCode,
  message: string,
  extra?: Omit<OrchestratorErrorPayload, 'code' | 'message'> & { cause?: unknown },
): OrchestratorError {
  const { cause, ...rest } = extra ?? {};
  return new OrchestratorError({ code, message, ...rest }, cause !== undefined ? { cause } : undefined);
}
