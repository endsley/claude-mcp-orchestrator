import { OrchestratorError } from '../types/errors.js';
import { redactText } from '../security/redaction.js';

/**
 * Format a startup failure for stderr.
 *
 * This exists as its own module for one reason: it is the only egress in the
 * process that does not go through the logger, because it runs when the logger
 * may not have been constructed yet. That made it the only path that skipped
 * redaction, and startup is exactly where a connection string, an API key read
 * from the environment or a config value ends up inside an exception message --
 * which systemd then copies verbatim into the journal.
 *
 * Inline in `main().catch` it was also untestable: importing the entry point to
 * check it would start the server.
 */
export function formatStartupFailure(error: unknown): string {
  if (OrchestratorError.is(error)) {
    return `startup failed [${error.code}]: ${redactText(error.message)}`;
  }
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  return `startup failed: ${redactText(detail)}`;
}
