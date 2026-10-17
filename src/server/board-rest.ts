import type { Request, Response } from 'express';
import type { Logger } from '../logging/logger.js';
import { principalFromAuthInfo } from '../security/principal.js';
import { redactValue } from '../security/redaction.js';
import { BOARD_TOOL_NAMES, toolAllowed } from '../security/scopes.js';
import { boardTools } from '../tools/board.js';
import { OrchestratorError, type OrchestratorErrorCode } from '../types/errors.js';
import type { JsonObject } from '../types/json.js';
import type { Services } from './container.js';

/**
 * REST front door to the board tools: `POST /board/v1/<tool_name>`.
 *
 * For outside agents that speak HTTP but not MCP. It is the SAME tool set as
 * MCP (tools/board.ts boardTools): the same zod schema validates the JSON
 * body, the same handler runs with the principal that authentication
 * established, and the same per-identity rate limits apply. Authentication is
 * the MCP endpoint's (mounted in http.ts in front of this handler); scope is
 * checked here per tool with the same toolAllowed gate.
 *
 *   200 {ok: true, text, result}
 *   4xx/5xx {ok: false, error: {type, message, hint?, details?, retryable?}}
 */

/** Board tool arguments are small; refuse anything bigger before parsing it as arguments. */
export const BOARD_REST_MAX_BODY_BYTES = 64 * 1024;

const STATUS_FOR: Partial<Record<OrchestratorErrorCode, number>> = {
  INVALID_ARGUMENT: 400,
  PROJECT_NOT_FOUND: 404,
  PERMISSION_DENIED: 403,
  RATE_LIMITED: 429,
  BOARD_CLAIM_CONFLICT: 409,
  BOARD_REJECTED: 422,
  BOARD_UNAVAILABLE: 503,
};

type Failure = { type: string; message: string; hint?: string; details?: unknown; retryable?: boolean };

function fail(res: Response, status: number, error: Failure): void {
  res.status(status).json({ ok: false, error: redactValue(error) });
}

/** A short, safe description of what failed validation (no echo of values). */
function describeIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join('.') || '(body)'}: ${issue.message}`)
    .join('; ')
    .slice(0, 500);
}

export function createBoardRestHandler(services: Services, logger: Logger): (req: Request, res: Response) => void {
  return (req: Request, res: Response): void => {
    void (async () => {
      const name = String(req.params['tool'] ?? '');
      const principal = principalFromAuthInfo((req as Request & { auth?: Parameters<typeof principalFromAuthInfo>[0] }).auth);
      if (!principal) {
        // requireAuth runs first, so this means a wiring mistake: refuse.
        fail(res, 401, { type: 'AUTH_REQUIRED', message: 'unauthorized' });
        return;
      }
      if (!BOARD_TOOL_NAMES.has(name)) {
        fail(res, 404, { type: 'NOT_FOUND', message: 'no such board tool' });
        return;
      }
      if (!toolAllowed(name, principal.scopes)) {
        fail(res, 403, { type: 'PERMISSION_DENIED', message: `This credential's scope does not allow ${name}.` });
        return;
      }
      const tool = boardTools(services, principal).find((candidate) => candidate.name === name);
      if (!tool) {
        fail(res, 404, { type: 'NOT_FOUND', message: `${name} is not available with this server's board backend` });
        return;
      }

      const declared = Number(req.headers['content-length'] ?? 0);
      const body: unknown = req.body;
      if (
        (Number.isFinite(declared) && declared > BOARD_REST_MAX_BODY_BYTES) ||
        (body !== undefined && JSON.stringify(body).length > BOARD_REST_MAX_BODY_BYTES)
      ) {
        fail(res, 413, { type: 'INVALID_ARGUMENT', message: `request body is larger than ${BOARD_REST_MAX_BODY_BYTES} bytes` });
        return;
      }
      // No body at all means no arguments; anything else must be a JSON object.
      const args: unknown = body === undefined && !(declared > 0) ? {} : body;
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        fail(res, 400, { type: 'INVALID_ARGUMENT', message: 'send the tool arguments as a JSON object (content-type: application/json)' });
        return;
      }
      const parsed = tool.inputSchema.safeParse(args);
      if (!parsed.success) {
        fail(res, 400, { type: 'INVALID_ARGUMENT', message: `invalid arguments: ${describeIssues(parsed.error.issues)}` });
        return;
      }

      const started = Date.now();
      try {
        const { text, structured } = await tool.run(parsed.data);
        logger.debug('board rest call completed', { toolName: name, durationMs: Date.now() - started });
        res.status(200).json({ ok: true, text: redactValue(text), result: redactValue(structured) });
      } catch (error) {
        if (OrchestratorError.is(error) && error.code !== 'INTERNAL') {
          logger.warn('board rest call returned a structured error', { toolName: name, code: error.code });
          const payload = error.toPayload();
          const failure: Failure = { type: payload.code, message: payload.message };
          if (payload.hint !== undefined) failure.hint = payload.hint;
          if (payload.details !== undefined) failure.details = payload.details as JsonObject;
          if (payload.retryable === true) failure.retryable = true;
          fail(res, STATUS_FOR[payload.code] ?? 500, failure);
          return;
        }
        // Never return an unexpected error's text: it may describe internals.
        logger.error('board rest call failed', { toolName: name, err: error });
        fail(res, 500, { type: 'INTERNAL', message: 'internal error' });
      }
    })();
  };
}
