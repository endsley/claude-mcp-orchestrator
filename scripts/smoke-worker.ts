#!/usr/bin/env tsx
/**
 * Real Claude Code worker smoke test.
 *
 * Creates a throwaway fixture repository, asks the worker to read a file, make
 * a controlled trivial edit, and run the test, then reports structured results.
 * Never point this at a real project: it grants the worker write access to the
 * directory it creates.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApplication } from '../src/app.js';
import { createLogger } from '../src/logging/logger.js';

function createFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orchestrator-fixture-'));
  const repo = join(dir, 'greeting-app');
  mkdirSync(repo, { recursive: true });

  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'greeting-app', version: '1.0.0', scripts: { test: 'node test.js' } }, null, 2),
  );
  writeFileSync(join(repo, 'greeting.js'), `export function greet(name) {\n  return 'Hello, ' + name + '!';\n}\n`);
  writeFileSync(
    join(repo, 'test.js'),
    [
      "import { greet } from './greeting.js';",
      "import assert from 'node:assert';",
      "assert.strictEqual(greet('World'), 'Hello, World!');",
      "console.log('1 passed, 0 failed');",
      "console.log('tests ok');",
      '',
    ].join('\n'),
  );
  writeFileSync(join(repo, 'README.md'), '# greeting-app\n\nA fixture used to smoke-test the orchestrator.\n');
  // package.json needs type:module for the ESM test above.
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as Record<string, unknown>;
  pkg['type'] = 'module';
  writeFileSync(join(repo, 'package.json'), JSON.stringify(pkg, null, 2));

  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=smoke@test', '-c', 'user.name=Smoke Test', 'commit', '-q', '-m', 'fixture'], {
    cwd: repo,
  });
  return repo;
}

async function main(): Promise<void> {
  const repo = createFixture();
  const workspace = mkdtempSync(join(tmpdir(), 'orchestrator-run-'));
  console.log(`fixture repository: ${repo}`);

  writeFileSync(
    join(workspace, 'orchestrator.yaml'),
    [
      'server:',
      '  host: 127.0.0.1',
      '  port: 0',
      'database:',
      `  path: ${join(workspace, 'smoke.sqlite')}`,
      'projects:',
      '  roots:',
      `    - ${repo.slice(0, repo.lastIndexOf('/'))}`,
      'security:',
      '  filesystem:',
      '    projectRoots:',
      `      - ${repo}`,
      '  approvals:',
      // Deliberately permissive for local-reversible work only; anything
      // external or destructive still requires approval and will time out here.
      '    READ_ONLY: allow',
      '    LOCAL_REVERSIBLE: allow',
      '    EXTERNAL_SIDE_EFFECT: deny',
      '    DESTRUCTIVE: deny',
      '    PROHIBITED: deny',
      'memory:',
      '  enabled: false',
      '  provider: none',
      'logging:',
      '  level: info',
      '  pretty: true',
      '',
    ].join('\n'),
  );

  const app = await buildApplication({
    configPath: join(workspace, 'orchestrator.yaml'),
    cwd: workspace,
    logger: createLogger({ level: 'info', pretty: true, logInstructionText: false }),
  });

  const { sessions } = app.services;
  const started = Date.now();

  const output = await sessions.startSession({
    instruction:
      'Read greeting.js. Change the greeting so it says "Hi, NAME!" instead of "Hello, NAME!". ' +
      'Update test.js so the assertion still passes. Then run `npm test` and tell me the result.',
    project: 'greeting-app',
    mode: 'work',
  });

  console.log(`\nstart_work_session acknowledged in ${Date.now() - started}ms`);
  console.log(`session: ${output.sessionId} (${output.status})`);
  console.log(`summary: ${output.summary}\n`);

  // Poll until terminal or timeout.
  const deadline = Date.now() + 5 * 60_000;
  let lastStep = '';
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const status = sessions.getStatus(output.sessionId);

    if (status.currentStep && status.currentStep !== lastStep) {
      lastStep = status.currentStep;
      console.log(`  [${status.status}] ${status.currentStep}`);
    }
    if (status.pendingQuestion) {
      console.log(`  worker asked: ${status.pendingQuestion.question}`);
      sessions.respond(output.sessionId, 'Use your best judgement and continue.');
    }
    if (['idle', 'completed', 'failed', 'cancelled'].includes(status.status)) break;
    if (Date.now() > deadline) {
      console.log('  TIMEOUT — cancelling');
      await sessions.cancel(output.sessionId, 'smoke test timeout');
      break;
    }
  }

  const result = sessions.getResult(output.sessionId);
  console.log('\n--- RESULT (turn 1) ---');
  console.log(JSON.stringify(result, null, 2));

  // ---- turn 2: a bare follow-up that only makes sense with prior context.
  // "that greeting" has no antecedent unless the SAME Claude conversation
  // continues, so this is the real test of session continuity.
  let continuity: 'passed' | 'failed' = 'failed';
  const statusBefore = sessions.getStatus(output.sessionId);
  if (statusBefore.status !== 'failed' && statusBefore.status !== 'cancelled') {
    console.log('\n--- turn 2: follow-up "actually make that greeting say Hey instead" ---');
    const followUpStart = Date.now();
    await sessions.sendInstruction(output.sessionId, 'Actually, make that greeting say "Hey" instead. Keep the tests passing.');
    console.log(`continue acknowledged in ${Date.now() - followUpStart}ms`);

    const followDeadline = Date.now() + 5 * 60_000;
    let step = '';
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const status = sessions.getStatus(output.sessionId);
      if (status.currentStep && status.currentStep !== step) {
        step = status.currentStep;
        console.log(`  [${status.status}] ${status.currentStep}`);
      }
      if (status.pendingQuestion) {
        sessions.respond(output.sessionId, 'Use your best judgement and continue.');
      }
      if (['idle', 'completed', 'failed', 'cancelled'].includes(status.status)) break;
      if (Date.now() > followDeadline) {
        await sessions.cancel(output.sessionId, 'follow-up timeout');
        break;
      }
    }

    const after = readFileSync(join(repo, 'greeting.js'), 'utf8');
    console.log('\n--- greeting.js after follow-up ---');
    console.log(after);
    continuity = after.includes('Hey') ? 'passed' : 'failed';
    console.log(`session continuity (bare "that greeting" resolved): ${continuity.toUpperCase()}`);
    console.log(`turns recorded on the session: ${sessions.getStatus(output.sessionId).status}`);
  }

  const greeting = readFileSync(join(repo, 'greeting.js'), 'utf8');
  const edited = greeting.includes('Hi, ') || greeting.includes('Hey');
  console.log(`\nfile actually edited: ${edited ? 'YES' : 'NO'}`);
  console.log(`tests recorded: ${result.tests ? `${result.tests.outcome} (exit ${result.tests.exitCode})` : 'none'}`);
  console.log(`session continuity: ${continuity.toUpperCase()}`);

  await app.shutdown();
  rmSync(workspace, { recursive: true, force: true });
  console.log(`\nfixture left at ${repo} for inspection; remove it when done.`);
  process.exit(edited && continuity === 'passed' ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error('smoke test failed:', error);
  process.exit(1);
});
