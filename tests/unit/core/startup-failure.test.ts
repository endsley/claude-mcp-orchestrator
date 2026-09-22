import { describe, expect, it } from 'vitest';
import { formatStartupFailure } from '../../../src/logging/startup.js';
import { orchestratorError } from '../../../src/types/errors.js';

/**
 * The only unredacted egress in the process, found by an adversarial review of
 * the redaction layer. Everything else goes through the logger or toolResult,
 * both of which redact; this one writes to stderr directly because it runs
 * before the logger exists, and systemd copies stderr into the journal.
 */
describe('formatStartupFailure', () => {
  const secret = `sk-ant-api03-${'A'.repeat(40)}`;

  it('redacts a secret in an OrchestratorError message', () => {
    const line = formatStartupFailure(orchestratorError('INVALID_CONFIG', `bad apiKey ${secret}`));
    expect(line).not.toContain(secret);
    expect(line).toContain('[redacted]');
    // The code still identifies what failed, which is the point of the line.
    expect(line).toContain('INVALID_CONFIG');
  });

  it('redacts a secret in a plain Error stack, not only its message', () => {
    // The stack is the larger surface: it carries the failing call's arguments
    // in many runtimes and is what the non-OrchestratorError branch prints.
    const error = new Error('connect failed');
    error.stack = `Error: connect failed\n    at pg://user:hunter2hunter2@db/app\n    at main (/app/index.js:1:1)`;
    const line = formatStartupFailure(error);
    expect(line).not.toContain('hunter2hunter2');
    expect(line).toContain('index.js');
  });

  it('redacts a thrown non-Error too', () => {
    const line = formatStartupFailure(`DATABASE_PASSWORD=${'p'.repeat(20)}`);
    expect(line).not.toContain('p'.repeat(20));
  });

  it('still says something useful when there is no secret', () => {
    expect(formatStartupFailure(new Error('port 8788 already in use'))).toContain('port 8788 already in use');
  });
});
