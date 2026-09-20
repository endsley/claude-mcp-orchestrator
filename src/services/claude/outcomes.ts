import type { TestSummary } from '../../types/sessions.js';

/** Commands we recognise as "running the tests". */
const TEST_COMMAND = /\b(npm|pnpm|yarn)\s+(run\s+)?test\b|\b(vitest|jest|pytest|mocha|ava|tap)\b|\bgo\s+test\b|\bcargo\s+test\b|\bmvn\s+test\b|\bgradlew?\s+test\b/;

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command);
}

/**
 * Pull counts out of a test runner's output.
 *
 * Returns partial data on purpose: a runner we cannot parse still yields a
 * trustworthy pass/fail from the exit code, and inventing numbers to fill the
 * gap would be worse than omitting them.
 */
export function parseTestOutput(output: string): Pick<TestSummary, 'run' | 'passed' | 'failed' | 'skipped'> {
  const result: Pick<TestSummary, 'run' | 'passed' | 'failed' | 'skipped'> = {};

  // vitest / jest: "Tests  47 passed (47)" or "Tests: 1 failed, 46 passed, 47 total"
  const passed = /(\d+)\s+passed/i.exec(output);
  const failed = /(\d+)\s+failed/i.exec(output);
  const skipped = /(\d+)\s+(?:skipped|pending|todo)/i.exec(output);
  const total = /(\d+)\s+total|\((\d+)\)\s*$/im.exec(output);

  if (passed?.[1]) result.passed = Number.parseInt(passed[1], 10);
  if (failed?.[1]) result.failed = Number.parseInt(failed[1], 10);
  if (skipped?.[1]) result.skipped = Number.parseInt(skipped[1], 10);

  const totalRaw = total?.[1] ?? total?.[2];
  if (totalRaw) result.run = Number.parseInt(totalRaw, 10);
  else if (result.passed !== undefined || result.failed !== undefined) {
    result.run = (result.passed ?? 0) + (result.failed ?? 0) + (result.skipped ?? 0);
  }

  // pytest: "5 passed, 2 failed in 1.23s" is already covered; go test prints
  // "ok"/"FAIL" per package with no counts, which correctly yields nothing.
  return result;
}

/**
 * Build a test summary from a command, its output and its exit status.
 * `exitCode === undefined` means we never saw the process finish.
 */
export function summariseTest(command: string, output: string, exitCode: number | undefined): TestSummary {
  const counts = parseTestOutput(output);
  const outcome: TestSummary['outcome'] =
    exitCode === undefined ? 'unknown' : exitCode === 0 ? 'passed' : 'failed';
  return {
    outcome,
    ...counts,
    command,
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}

/** Extract an exit code from Claude Code's Bash tool result text, if present. */
export function parseExitCode(resultText: string): number | undefined {
  // Matches "exit 1", "exit code 2", "Exit status: 0" and "exitCode=3".
  // The optional separator group is what the earlier version got wrong: it
  // required whitespace before "code" but not before "status".
  const match = /\bexit\s*(?:code|status)?\s*[:=]?\s*(\d+)/i.exec(resultText);
  if (match?.[1]) return Number.parseInt(match[1], 10);
  return undefined;
}
