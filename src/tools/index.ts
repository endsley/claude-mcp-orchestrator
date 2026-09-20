import type { McpServer } from '@modelcontextprotocol/server';
import type { Services } from '../server/container.js';
import { registerComputerTools } from './computers.js';
import { registerContextTools } from './context.js';
import { registerMemoryTools } from './memory.js';
import { registerProjectTools } from './projects.js';
import { registerSessionTools } from './sessions.js';

/**
 * Register the whole public tool surface.
 *
 * Note what is absent: there is no run_shell, no read_any_file, no
 * execute_python. The phone expresses intent; the computer-side worker holds
 * the dangerous capabilities behind its own permission policy. Adding a
 * primitive machine-control tool here would collapse that boundary.
 */
export function registerAllTools(server: McpServer, services: Services): void {
  registerContextTools(server, services);
  registerComputerTools(server, services);
  registerProjectTools(server, services);
  registerMemoryTools(server, services);
  registerSessionTools(server, services);
}

export { deduplicateMemories } from './memory.js';
