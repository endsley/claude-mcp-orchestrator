import { describe, expect, it } from 'vitest';
import { BOARD_TOOL_NAMES, parseScopes, toolAllowed } from '../../../src/security/scopes.js';
import { oauthPrincipal, principalFromAuthInfo, principalToAuthInfo, boardKeyPrincipal } from '../../../src/security/principal.js';

describe('scopes fail closed', () => {
  it('parses only known scopes', () => {
    expect([...parseScopes('mcp board')].sort()).toEqual(['board', 'mcp']);
    expect([...parseScopes('admin  root')]).toEqual([]);
    expect([...parseScopes('')]).toEqual([]);
    expect([...parseScopes(undefined)]).toEqual([]);
    expect([...parseScopes('MCP')]).toEqual([]);
  });

  it('grants nothing without a known scope', () => {
    expect(toolAllowed('code_coordination_board', new Set())).toBe(false);
    expect(toolAllowed('start_work_session', parseScopes('anything'))).toBe(false);
  });

  it('board scope grants exactly the board tools', () => {
    const board = parseScopes('board');
    for (const name of BOARD_TOOL_NAMES) expect(toolAllowed(name, board)).toBe(true);
    for (const name of ['start_work_session', 'recall_context', 'list_computers', 'get_environment_context', 'new_tool']) {
      expect(toolAllowed(name, board)).toBe(false);
    }
  });

  it('mcp scope grants everything, board tools included', () => {
    const full = parseScopes('mcp');
    expect(toolAllowed('start_work_session', full)).toBe(true);
    expect(toolAllowed('post_code_task', full)).toBe(true);
  });
});

describe('principal identity', () => {
  it('derives the oauth identity from the client, sanitising the attacker-supplied name', () => {
    const principal = oauthPrincipal({ clientId: 'mcpc_1', clientName: 'Evil\n\u0007Bot   ' + 'x'.repeat(200), scopes: new Set() });
    expect(principal.board.agent.startsWith('oauth:Evil Bot')).toBe(true);
    expect(principal.board.agent.length).toBeLessThanOrEqual(80);
    expect(principal.board.agent).not.toMatch(/[\n\u0007]/);
    expect(principal.board.sessionId).toBe('ext-oauth-mcpc_1');
  });

  it('falls back to the client id when the name is empty', () => {
    expect(oauthPrincipal({ clientId: 'mcpc_2', clientName: '  ', scopes: new Set() }).board.agent).toBe('oauth:mcpc_2');
  });

  it('round-trips through AuthInfo without carrying the credential', () => {
    const principal = boardKeyPrincipal('helper-bot', parseScopes('board'));
    const info = principalToAuthInfo(principal, 'board-key:helper-bot');
    expect(info.token).toBe('[redacted]');
    expect(principalFromAuthInfo(info)).toBe(principal);
    expect(principalFromAuthInfo(undefined)).toBeUndefined();
    expect(principalFromAuthInfo({ token: 't', clientId: 'c', scopes: ['mcp'] })).toBeUndefined();
  });
});
