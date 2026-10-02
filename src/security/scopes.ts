/**
 * OAuth scopes and the tool surface each one grants.
 *
 * Two scopes exist:
 *  - `mcp`: everything, including start_work_session, which runs Claude Code
 *    on the owner's machines. This is what the owner's own phone connector
 *    holds, and what every token issued before scopes existed carries.
 *  - `board`: the code coordination board tools only. This is what an
 *    outside agent gets, via OAuth or a board token key.
 *
 * Everything here FAILS CLOSED. An unknown scope string grants nothing, a
 * token with no recognised scope sees no tools, and a tool that is not named
 * in BOARD_TOOL_NAMES is never reachable from the board scope - so a new tool
 * added later is full-access-only until someone deliberately lists it here.
 */

export const SCOPE_FULL = 'mcp';
export const SCOPE_BOARD = 'board';

export const KNOWN_SCOPES = [SCOPE_FULL, SCOPE_BOARD] as const;
export type Scope = (typeof KNOWN_SCOPES)[number];

/** The tools a `board`-scoped caller may list and call. Nothing else. */
export const BOARD_TOOL_NAMES: ReadonlySet<string> = new Set([
  'code_coordination_board',
  'post_code_task',
  'claim_code_files',
  'release_code_files',
  'heartbeat_code_task',
  'message_code_agents',
  'finish_code_task',
]);

export function isKnownScope(value: string): value is Scope {
  return (KNOWN_SCOPES as readonly string[]).includes(value);
}

/**
 * Parse a space-separated scope string (or list) into the set of KNOWN
 * scopes it names. Unknown values are dropped, not passed through: they must
 * never be able to mean anything.
 */
export function parseScopes(value: string | readonly string[] | undefined | null): Set<Scope> {
  const parts = value === undefined || value === null ? [] : typeof value === 'string' ? value.split(/\s+/) : value;
  const out = new Set<Scope>();
  for (const part of parts) {
    const trimmed = part.trim();
    if (isKnownScope(trimmed)) out.add(trimmed);
  }
  return out;
}

/** Whether a caller holding `scopes` may list and call the tool `toolName`. */
export function toolAllowed(toolName: string, scopes: ReadonlySet<Scope>): boolean {
  if (scopes.has(SCOPE_FULL)) return true;
  if (scopes.has(SCOPE_BOARD)) return BOARD_TOOL_NAMES.has(toolName);
  return false;
}

/** Human-readable label used on the consent page. */
export function describeScope(scope: Scope): { title: string; detail: string } {
  if (scope === SCOPE_BOARD) {
    return {
      title: 'Coordination board only',
      detail:
        'Read the code coordination board, post and finish tasks, claim and release files, and send ' +
        'board messages. Cannot start Claude Code, read files, or use any other tool.',
    };
  }
  return {
    title: 'Full access',
    detail:
      'Every tool, including starting Claude Code sessions that can read and modify files in your ' +
      'configured project directories.',
  };
}
