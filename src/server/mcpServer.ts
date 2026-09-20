import { McpServer } from '@modelcontextprotocol/server';
import { registerAllTools } from '../tools/index.js';
import type { Services } from './container.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';

export const SERVER_NAME = 'claude-mcp-orchestrator';
export const SERVER_VERSION = '0.1.0';

/**
 * Build a fully-registered MCP server.
 *
 * Called once per request by the per-request handler factory, so it must stay
 * cheap: all the expensive state (database, caches, live workers) lives in
 * `services` and is shared, while the protocol object itself is disposable.
 */
export function createMcpServer(services: Services): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerAllTools(server, services);
  return server;
}
