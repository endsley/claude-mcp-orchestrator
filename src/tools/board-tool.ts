import { z } from 'zod';
import { BOARD_LIMITS } from '../services/board/board-service.js';
import type { JsonValue } from '../types/json.js';

/**
 * One board tool, bound to the authenticated caller.
 *
 * The same definition backs the MCP tool (tools/board.ts) and the REST front
 * door (server/board-rest.ts), so validation, identity and output filtering
 * cannot drift apart between the two.
 */
export interface BoardToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodObject;
  /** Runs with arguments already validated by inputSchema. */
  run(args: unknown): Promise<{ text: string; structured: JsonValue }>;
}

/** Type a tool's handler against its own schema, then erase it into the list. */
export function defineBoardTool<S extends z.ZodObject>(def: {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  run(args: z.infer<S>): Promise<{ text: string; structured: JsonValue }>;
}): BoardToolDef {
  return { ...def, run: (args: unknown) => def.run(args as z.infer<S>) };
}

export const claimArg = z.object({
  path: z
    .string()
    .min(1)
    .max(BOARD_LIMITS.claimPathChars)
    .describe('Path relative to the project root, e.g. "src/app.ts" or "docs". Ignored for kind "project".'),
  kind: z
    .enum(['file', 'tree', 'project'])
    .default('file')
    .describe('"file" for one file, "tree" for a directory and everything under it, "project" for the whole project.'),
});

