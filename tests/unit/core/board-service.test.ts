import { describe, expect, it } from 'vitest';
import { appConfigSchema, boardConfigSchema } from '../../../src/config/schema.js';
import { createNullLogger } from '../../../src/logging/logger.js';
import { boardKeyPrincipal } from '../../../src/security/principal.js';
import { parseScopes } from '../../../src/security/scopes.js';
import { BoardService, normaliseClaim } from '../../../src/services/board/board-service.js';
import { BoardRemoteError, BoardUnavailableError } from '../../../src/services/board/types.js';
import { OrchestratorError } from '../../../src/types/errors.js';
import { FakeBoardClient } from '../../fakes/fake-board-client.js';

function setup(overrides: Record<string, unknown> = {}) {
  const fake = new FakeBoardClient();
  const config = boardConfigSchema.parse({
    enabled: true,
    projects: { 'demo-app': '/srv/demo-app', 'other-app': '/srv/other-app' },
    ...overrides,
  });
  let now = 1_000_000;
  const service = new BoardService(fake, config, createNullLogger(), () => now);
  const principal = boardKeyPrincipal('helper-bot', parseScopes('board'));
  return { fake, service, principal, advance: (ms: number) => (now += ms) };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (OrchestratorError.is(error)) return error.code;
    throw error;
  }
  return 'OK';
}

describe('BoardService', () => {
  it('fills identity and project root from the principal and config, never the caller', async () => {
    const { fake, service, principal } = setup();
    await service.postTask(principal, { project: 'demo-app', task: 'fix x', claims: [{ path: './src//a.py', kind: 'file' }] });
    expect(fake.lastPayload('post_task')).toEqual({
      task: 'fix x',
      project: 'demo-app',
      project_root: '/srv/demo-app',
      session_id: 'ext-key-helper-bot',
      agent: 'helper-bot',
      cwd: '',
      claims: [['src/a.py', 'file']],
      replace_claims: true,
    });
  });

  it('records the identity on messages, finish and heartbeat too', async () => {
    const { fake, service, principal } = setup();
    await service.message(principal, { project: 'demo-app', body: 'hi', recipientSessionId: 'abc' });
    expect(fake.lastPayload('message')).toMatchObject({ agent: 'helper-bot', session_id: 'ext-key-helper-bot', recipient_session_id: 'abc' });
    await service.finish(principal, { project: 'demo-app', result: 'done' });
    expect(fake.lastPayload('finish')).toMatchObject({ session_id: 'ext-key-helper-bot', project: 'demo-app', all_projects: false });
    await service.heartbeat(principal, {});
    expect(fake.lastPayload('heartbeat')).toEqual({ session_id: 'ext-key-helper-bot', project: null });
  });

  it('refuses a project that is not configured, before calling the board', async () => {
    const { fake, service, principal } = setup();
    expect(await code(service.snapshot(principal, { project: 'secret-repo' }))).toBe('PROJECT_NOT_FOUND');
    expect(await code(service.message(principal, { project: 'secret-repo', body: 'x' }))).toBe('PROJECT_NOT_FOUND');
    expect(fake.calls).toHaveLength(0);
  });

  it('is unavailable when disabled', async () => {
    const { service, principal } = setup({ enabled: false });
    expect(await code(service.snapshot(principal, { project: 'demo-app' }))).toBe('BOARD_UNAVAILABLE');
  });

  it('rate-limits writes per identity and resets after the window', async () => {
    const { service, principal, advance } = setup({ writesPerMinute: 2 });
    const other = boardKeyPrincipal('second-bot', parseScopes('board'));
    const post = (who = principal) => service.postTask(who, { project: 'demo-app', task: 't', claims: [] });
    expect(await code(post())).toBe('OK');
    expect(await code(post())).toBe('OK');
    expect(await code(post())).toBe('RATE_LIMITED');
    expect(await code(post(other))).toBe('OK');
    // Reads have their own budget.
    expect(await code(service.snapshot(principal, { project: 'demo-app' }))).toBe('OK');
    advance(60_001);
    expect(await code(post())).toBe('OK');
  });

  it('maps a claim conflict to a clear error with the conflicting claims', async () => {
    const { fake, service, principal } = setup();
    fake.failNext = new BoardRemoteError('ClaimConflict', 'src/a.py is claimed by other-agent', [
      { path: 'src/a.py', kind: 'file', agent: 'other-agent', session_id: 's1', task: 'refactor' },
    ]);
    try {
      await service.claim(principal, { project: 'demo-app', claims: [{ path: 'src/a.py', kind: 'file' }] });
      expect.unreachable();
    } catch (error) {
      expect(OrchestratorError.is(error) && error.code).toBe('BOARD_CLAIM_CONFLICT');
      expect((error as OrchestratorError).details).toEqual({
        conflicts: [{ path: 'src/a.py', kind: 'file', agent: 'other-agent', session_id: 's1', task: 'refactor' }],
      });
    }
  });

  it('maps other rejections and outages', async () => {
    const { fake, service, principal } = setup();
    fake.failNext = new BoardRemoteError('CoordinationError', 'Post the task before claiming files');
    expect(await code(service.claim(principal, { project: 'demo-app', claims: [{ path: 'a', kind: 'file' }] }))).toBe('BOARD_REJECTED');
    fake.failNext = new BoardUnavailableError('node-a: TypeError');
    expect(await code(service.snapshot(principal, { project: 'demo-app' }))).toBe('BOARD_UNAVAILABLE');
  });

  it('requires a project or all_projects to finish', async () => {
    const { fake, service, principal } = setup();
    expect(await code(service.finish(principal, {}))).toBe('INVALID_ARGUMENT');
    await service.finish(principal, { allProjects: true });
    expect(fake.lastPayload('finish')).toMatchObject({ all_projects: true, project: null });
  });
});

describe('claim path normalisation', () => {
  it('accepts project-relative paths', () => {
    expect(normaliseClaim({ path: 'src/app.ts', kind: 'file' })).toEqual(['src/app.ts', 'file']);
    expect(normaliseClaim({ path: './docs/', kind: 'tree' })).toEqual(['docs', 'tree']);
    expect(normaliseClaim({ path: 'anything', kind: 'project' })).toEqual(['.', 'project']);
  });

  it('rejects anything that escapes or is not relative', () => {
    for (const path of ['/etc/passwd', '~/x', '../x', 'a/../../b', 'a/./b', '.', '', 'a\\b', 'a\u0000b', 'x'.repeat(513)]) {
      expect(() => normaliseClaim({ path, kind: 'file' }), path).toThrow();
    }
  });
});

describe('board config', () => {
  it('refuses an enabled board with no nodes or token file', () => {
    const result = appConfigSchema.safeParse({ board: { enabled: true } });
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map((issue) => issue.path.join('.'));
    expect(paths).toEqual(expect.arrayContaining(['board.nodes', 'board.tokenFile']));
  });

  it('defaults to disabled, which needs nothing', () => {
    expect(appConfigSchema.parse({}).board.enabled).toBe(false);
  });
});
