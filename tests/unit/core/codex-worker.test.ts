import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNullLogger } from '../../../src/logging/logger.js';
import type { WorkerCallbacks } from '../../../src/services/claude/worker.js';
import { CodexWorker } from '../../../src/services/codex/worker.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function callbacksFor(completions: string[], sessionIds: string[]): WorkerCallbacks {
  return {
    onSessionId: (id) => sessionIds.push(id),
    onProgress: () => undefined,
    onTurnComplete: (summary) => completions.push(summary),
    onError: (error) => {
      throw error;
    },
    askUser: async () => '',
    requestApproval: async () => false,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for fake Codex worker');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('CodexWorker', () => {
  it('runs unattended and resumes the durable Codex thread for follow-ups', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-worker-'));
    temporaryDirectories.push(directory);
    const executable = join(directory, 'fake-codex');
    const argumentsLog = join(directory, 'arguments.log');
    const quotedLog = JSON.stringify(argumentsLog);
    await writeFile(
      executable,
      `#!/bin/sh
printf '%s ' "$@" >> ${quotedLog}
printf '\\n---\\n' >> ${quotedLog}
if [ "$2" = "resume" ]; then
  printf '%s\\n' '{"type":"turn.started"}'
  printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"second turn"}}'
else
  printf '%s\\n' '{"type":"thread.started","thread_id":"thread-123"}'
  printf '%s\\n' '{"type":"turn.started"}'
  printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"first turn"}}'
fi
`,
    );
    await chmod(executable, 0o700);

    const completions: string[] = [];
    const sessionIds: string[] = [];
    const worker = new CodexWorker(
      'ws_test',
      { enabled: true, executablePath: executable, sessionTimeoutMs: 60_000 },
      callbacksFor(completions, sessionIds),
      createNullLogger(),
    );

    worker.start({ instruction: 'first instruction', cwd: directory, mode: 'inspect' });
    await waitFor(() => completions.length === 1);
    worker.send('second instruction');
    await waitFor(() => completions.length === 2);

    const calls = await readFile(argumentsLog, 'utf8');
    expect(sessionIds).toEqual(['thread-123']);
    expect(completions).toEqual(['first turn', 'second turn']);
    expect(calls).toContain('exec --json --cd');
    expect(calls).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(calls).toContain('exec resume --json --dangerously-bypass-approvals-and-sandbox thread-123 second instruction');
    expect(calls).not.toContain('--sandbox');
    await worker.dispose();
  });
});
