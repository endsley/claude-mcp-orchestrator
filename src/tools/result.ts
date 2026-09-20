import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Logger } from '../logging/logger.js';
import { redactValue } from '../security/redaction.js';
import { OrchestratorError, orchestratorError } from '../types/errors.js';
import type { JsonObject, JsonValue } from '../types/json.js';

/**
 * Build a tool result.
 *
 * `text` is what the voice model reads aloud, so it must be a short, complete
 * sentence. `structured` carries the detail for any follow-up reasoning. Both
 * are redacted on the way out — this is the last place before data leaves the
 * process.
 */
export function toolResult(text: string, structured?: JsonValue): CallToolResult {
  const safeText = String(redactValue(text));
  const result: CallToolResult = {
    content: [{ type: 'text', text: safeText }],
  };
  if (structured !== undefined) {
    const redacted = redactValue(structured);
    // structuredContent must be an object; wrap anything else.
    result.structuredContent =
      typeof redacted === 'object' && redacted !== null && !Array.isArray(redacted)
        ? (redacted as JsonObject)
        : { value: redacted };
  }
  return result;
}

/**
 * Render a failure as a structured, recoverable error rather than a 500.
 *
 * The phone-side model branches on `code`, so the code is repeated inside the
 * spoken text only when it adds nothing — normally the message and hint carry
 * the meaning.
 */
export function errorResult(error: unknown, logger: Logger, context: Record<string, unknown> = {}): CallToolResult {
  const orchestratorErr = OrchestratorError.is(error)
    ? error
    : orchestratorError('INTERNAL', error instanceof Error ? error.message : String(error), { cause: error });

  if (orchestratorErr.code === 'INTERNAL') {
    logger.error('unhandled tool error', { ...context, err: error });
  } else {
    logger.warn('tool returned a structured error', { ...context, code: orchestratorErr.code });
  }

  const payload = orchestratorErr.toPayload();
  const spoken = orchestratorErr.hint ? `${orchestratorErr.message} ${orchestratorErr.hint}` : orchestratorErr.message;

  return {
    isError: true,
    content: [{ type: 'text', text: String(redactValue(spoken)) }],
    structuredContent: redactValue(payload) as JsonObject,
  };
}

/** Wrap a tool handler so every throw becomes a structured error result. */
export function guarded<TArgs>(
  toolName: string,
  logger: Logger,
  handler: (args: TArgs) => Promise<CallToolResult>,
): (args: TArgs) => Promise<CallToolResult> {
  return async (args: TArgs) => {
    const started = Date.now();
    try {
      const result = await handler(args);
      logger.debug('tool completed', { toolName, durationMs: Date.now() - started });
      return result;
    } catch (error) {
      return errorResult(error, logger, { toolName, durationMs: Date.now() - started });
    }
  };
}
