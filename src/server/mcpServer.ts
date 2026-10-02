import { McpServer } from '@modelcontextprotocol/server';
import type { Principal } from '../security/principal.js';
import { SCOPE_FULL, toolAllowed } from '../security/scopes.js';
import { registerAllTools } from '../tools/index.js';
import { errorResult } from '../tools/result.js';
import { orchestratorError } from '../types/errors.js';
import type { Services } from './container.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';

export const SERVER_NAME = 'claude-mcp-orchestrator';
export const SERVER_VERSION = '0.1.0';

type RegisterTool = McpServer['registerTool'];

/** Instructions for a board-only caller, who cannot see any other tool. */
const BOARD_INSTRUCTIONS =
  'This server exposes the shared code coordination board used by every agent working on the ' +
  "owner's repositories. Before editing a project, read code_coordination_board, then post_code_task " +
  'with the files you will modify. Heartbeat during long work, message owners of conflicting claims ' +
  'instead of editing through them, and always finish_code_task when you stop. Your board identity ' +
  'comes from your credential and cannot be changed.';

/**
 * Build a fully-registered MCP server for one request's principal.
 *
 * Called once per request by the per-request handler factory, so it must stay
 * cheap: all the expensive state (database, caches, live workers) lives in
 * `services` and is shared, while the protocol object itself is disposable.
 *
 * Scope enforcement happens here, twice:
 *  1. a tool the principal's scopes do not allow is never registered on this
 *     instance, so tools/list does not show it and tools/call cannot find it;
 *  2. every registered handler re-checks before running, so a future change
 *     that registers tools some other way still cannot skip the check.
 * No principal (an unauthenticated path that should not exist) means no tools.
 */
export function createMcpServer(services: Services, principal: Principal | undefined): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: principal?.scopes.has(SCOPE_FULL) ? SERVER_INSTRUCTIONS : BOARD_INSTRUCTIONS },
  );
  const scopes = principal?.scopes ?? new Set();
  const original = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  let skipped = 0;

  const gated = ((name: string, config: unknown, handler: (...args: unknown[]) => unknown) => {
    if (!principal || !toolAllowed(name, scopes)) {
      skipped += 1;
      return undefined;
    }
    const checked = async (...args: unknown[]): Promise<unknown> => {
      if (!toolAllowed(name, scopes)) {
        return errorResult(
          orchestratorError('PERMISSION_DENIED', `This credential's scope does not allow ${name}.`),
          services.logger,
          { toolName: name },
        );
      }
      return handler(...args);
    };
    return original(name, config, checked);
  }) as unknown as RegisterTool;
  server.registerTool = gated;

  if (principal) registerAllTools(server, services, principal);
  if (skipped > 0) services.logger.debug('tools hidden by scope', { skipped, kind: principal?.kind ?? 'none' });
  return server;
}
