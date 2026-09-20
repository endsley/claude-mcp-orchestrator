import { describe, expect, it } from 'vitest';
import { isTestCommand, parseExitCode, parseTestOutput, summariseTest } from '../../../src/services/claude/outcomes.js';
import { AsyncMessageQueue } from '../../../src/services/claude/asyncQueue.js';

describe('isTestCommand', () => {
  it('recognises common test runners', () => {
    for (const command of ['npm test', 'npm run test', 'pnpm test', 'yarn test', 'npx vitest run', 'pytest -q', 'go test ./...', 'cargo test']) {
      expect(isTestCommand(command)).toBe(true);
    }
  });
  it('does not mistake unrelated commands for tests', () => {
    for (const command of ['npm run build', 'git status', 'ls', 'npm install']) {
      expect(isTestCommand(command)).toBe(false);
    }
  });
});

describe('parseTestOutput', () => {
  it('parses vitest-style output', () => {
    expect(parseTestOutput('Tests  47 passed (47)')).toMatchObject({ passed: 47, run: 47 });
  });
  it('parses jest-style output with failures', () => {
    expect(parseTestOutput('Tests: 1 failed, 46 passed, 47 total')).toMatchObject({
      failed: 1,
      passed: 46,
      run: 47,
    });
  });
  it('parses pytest-style output', () => {
    expect(parseTestOutput('5 passed, 2 failed in 1.23s')).toMatchObject({ passed: 5, failed: 2 });
  });
  it('returns nothing parseable for output with no counts', () => {
    expect(parseTestOutput('ok  \tgithub.com/x/y\t0.01s')).toEqual({});
  });
});

/**
 * The honesty guarantee: the system must never report a pass it did not
 * observe. Outcome always derives from the process exit status.
 */
describe('summariseTest honesty', () => {
  it('reports passed only on exit code 0', () => {
    expect(summariseTest('npm test', '47 passed (47)', 0).outcome).toBe('passed');
  });

  it('reports failed on a non-zero exit even if the text says passed', () => {
    const summary = summariseTest('npm test', '47 passed (47)', 1);
    expect(summary.outcome).toBe('failed');
  });

  it('reports unknown when the process never reported an exit status', () => {
    const summary = summariseTest('npm test', 'some output', undefined);
    expect(summary.outcome).toBe('unknown');
    expect(summary.exitCode).toBeUndefined();
  });

  it('omits counts entirely rather than inventing them', () => {
    const summary = summariseTest('go test ./...', 'ok  \tpkg\t0.01s', 0);
    expect(summary.outcome).toBe('passed');
    expect(summary.run).toBeUndefined();
    expect(summary.passed).toBeUndefined();
  });
});

describe('parseExitCode', () => {
  it('extracts an exit code when the runner reports one', () => {
    expect(parseExitCode('command failed with exit code 2')).toBe(2);
    expect(parseExitCode('Exit status: 0')).toBe(0);
  });
  it('returns undefined when there is no exit code to read', () => {
    expect(parseExitCode('just some output')).toBeUndefined();
  });
});

describe('AsyncMessageQueue', () => {
  it('delivers items pushed before iteration starts', async () => {
    const queue = new AsyncMessageQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.close();
    const received: number[] = [];
    for await (const item of queue) received.push(item);
    expect(received).toEqual([1, 2]);
  });

  // This is the property that makes follow-up instructions work: the generator
  // stays open and later pushes are delivered to the waiting consumer.
  it('delivers items pushed while the consumer is waiting', async () => {
    const queue = new AsyncMessageQueue<string>();
    const received: string[] = [];
    const consumer = (async () => {
      for await (const item of queue) {
        received.push(item);
        if (received.length === 2) queue.close();
      }
    })();

    await new Promise((r) => setTimeout(r, 10));
    queue.push('first');
    await new Promise((r) => setTimeout(r, 10));
    queue.push('second');
    await consumer;
    expect(received).toEqual(['first', 'second']);
  });

  it('ignores pushes after close rather than throwing', async () => {
    const queue = new AsyncMessageQueue<number>();
    queue.close();
    queue.push(99);
    const received: number[] = [];
    for await (const item of queue) received.push(item);
    expect(received).toEqual([]);
  });

  it('surfaces a failure to the consumer', async () => {
    const queue = new AsyncMessageQueue<number>();
    queue.fail(new Error('boom'));
    await expect(
      (async () => {
        for await (const _item of queue) {
          // drain
        }
      })(),
    ).rejects.toThrow('boom');
  });
});
