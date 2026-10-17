import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Principal } from '../security/principal.js';
import type { Services } from '../server/container.js';
import { BOARD_LIMITS } from '../services/board/board-service.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import { agentcoordBoardTools } from './agentcoord-board.js';
import { claimArg, defineBoardTool, type BoardToolDef } from './board-tool.js';
import { guarded, toolResult } from './result.js';

/**
 * Code coordination board tools: the whole surface a `board`-scoped outside
 * agent can reach.
 *
 * Each tool is a BoardToolDef - name, description, zod input schema and a
 * handler bound to the caller's principal - so the MCP registration below and
 * the REST front door (server/board-rest.ts) run exactly the same code. Which
 * set is live depends on board.backend: agentcoord (tools/agentcoord-board.ts)
 * or the legacy board (legacyBoardTools below, kept for rollback).
 *
 * Note what no schema here has: an agent, session_id or identity field. The
 * caller's board identity comes from `principal`, which authentication
 * established; a tool argument has no path to it. zod objects strip unknown
 * keys, so a caller sending `agent: "someone-else"` is simply ignored.
 */

const projectArg = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'a board project alias such as "demo-app"')
  .describe('Board project alias, e.g. "demo-app". Not a path.');

const claimsArg = z.array(claimArg).max(BOARD_LIMITS.claimsPerCall);

function asObject(value: JsonValue | undefined): JsonObject {
  return (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as JsonObject;
}

function pick(source: JsonObject, keys: readonly string[]): JsonObject {
  const out: JsonObject = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

/*
 * What an outside caller may see of the board. An ALLOWLIST: the board's rows
 * also carry the host-side project root and each agent's working directory,
 * which are the owner's filesystem layout and none of an outside agent's
 * business. A field the board adds later stays hidden until listed here.
 */
const WORK_ITEM_FIELDS = [
  'id', 'project', 'session_id', 'agent', 'task', 'status', 'note', 'result',
  'started_at', 'heartbeat_at', 'completed_at',
] as const;
const MESSAGE_FIELDS = [
  'id', 'project', 'sender_session_id', 'sender_agent', 'recipient_session_id', 'body', 'created_at',
] as const;

export function publicWorkItem(value: JsonValue | undefined): JsonObject {
  const item = asObject(value);
  const out = pick(item, WORK_ITEM_FIELDS);
  if (Array.isArray(item['claims'])) {
    out['claims'] = item['claims'].map((claim) => pick(asObject(claim), ['path', 'kind']));
  }
  return out;
}

export function publicSnapshot(value: JsonValue): JsonObject {
  const snapshot = asObject(value);
  return {
    project: snapshot['project'] ?? null,
    work_items: Array.isArray(snapshot['work_items']) ? snapshot['work_items'].map(publicWorkItem) : [],
    messages: Array.isArray(snapshot['messages'])
      ? snapshot['messages'].map((message) => pick(asObject(message), MESSAGE_FIELDS))
      : [],
    ...(typeof snapshot['stale_after_seconds'] === 'number' ? { stale_after_seconds: snapshot['stale_after_seconds'] } : {}),
  };
}

function summariseSnapshot(result: JsonValue, project: string): string {
  const snapshot = (typeof result === 'object' && result !== null && !Array.isArray(result) ? result : {}) as JsonObject;
  const items = Array.isArray(snapshot['work_items']) ? snapshot['work_items'] : [];
  const messages = Array.isArray(snapshot['messages']) ? snapshot['messages'] : [];
  const lines = [`Board for ${project}: ${items.length} task(s), ${messages.length} recent message(s).`];
  for (const raw of items.slice(0, 20)) {
    const item = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as JsonObject;
    const claims = Array.isArray(item['claims'])
      ? item['claims']
          .map((claim) => {
            const c = (typeof claim === 'object' && claim !== null && !Array.isArray(claim) ? claim : {}) as JsonObject;
            return c['kind'] === 'tree' ? `${String(c['path'])}/**` : String(c['path']);
          })
          .join(', ')
      : '';
    lines.push(
      `- [${String(item['status'] ?? '?')}] ${String(item['agent'] ?? '?')} (${String(item['session_id'] ?? '?')}): ` +
        `${String(item['task'] ?? '')}${claims ? ` - ${claims}` : ''}`,
    );
  }
  return lines.join('\n');
}

export type { BoardToolDef } from './board-tool.js';

/** The legacy code coordination board's tools (board.backend: legacy). */
export function legacyBoardTools(services: Services, principal: Principal): BoardToolDef[] {
  const { board } = services;
  const you = `You appear on the board as "${principal.board.agent}" (session ${principal.board.sessionId}).`;

  return [
    defineBoardTool({
      name: 'code_coordination_board',
      title: 'Read the code coordination board',
      description:
        'Show the shared code coordination board for a project: active tasks, the files each agent has ' +
        'claimed, and recent messages. Read it before editing anything; other agents edit the same ' +
        `repositories at the same time. ${you}`,
      inputSchema: z.object({
        project: projectArg,
        include_history: z.boolean().optional().describe('Also include recently finished tasks.'),
      }),
      run: async (args) => {
        const result = await board.snapshot(principal, {
          project: args.project,
          ...(args.include_history !== undefined ? { includeHistory: args.include_history } : {}),
        });
        const visible = publicSnapshot(result);
        return { text: summariseSnapshot(visible, args.project), structured: visible };
      },
    }),
    defineBoardTool({
      name: 'post_code_task',
      title: 'Post a task to the board',
      description:
        'Announce what you are about to work on in a project, and claim the files or directories you ' +
        'expect to modify. Replaces your previous claims in that project. Fails with a conflict when ' +
        `another agent holds an overlapping claim. ${you}`,
      inputSchema: z.object({
        project: projectArg,
        task: z.string().min(1).max(BOARD_LIMITS.taskChars).describe('One line: what you are doing.'),
        claims: claimsArg.default([]).describe('Files or directories you will modify.'),
      }),
      run: async (args) => {
        const result = await board.postTask(principal, { project: args.project, task: args.task, claims: args.claims });
        return { text: `Posted your task on ${args.project} with ${args.claims.length} claim(s).`, structured: publicWorkItem(result) };
      },
    }),
    defineBoardTool({
      name: 'claim_code_files',
      title: 'Claim more files',
      description:
        'Add file or directory claims to your posted task in a project, keeping the ones you already ' +
        'hold. Post a task first, or pass `task` to post one.',
      inputSchema: z.object({
        project: projectArg,
        claims: claimsArg.min(1),
        task: z.string().min(1).max(BOARD_LIMITS.taskChars).optional(),
      }),
      run: async (args) => {
        const result = await board.claim(principal, {
          project: args.project,
          claims: args.claims,
          ...(args.task !== undefined ? { task: args.task } : {}),
        });
        return { text: `Claimed ${args.claims.length} more path(s) on ${args.project}.`, structured: publicWorkItem(result) };
      },
    }),
    defineBoardTool({
      name: 'release_code_files',
      title: 'Release claimed files',
      description: 'Release some of your claims in a project while keeping your task open.',
      inputSchema: z.object({ project: projectArg, claims: claimsArg.min(1) }),
      run: async (args) => {
        const result = await board.release(principal, { project: args.project, claims: args.claims });
        return { text: `Released ${typeof result === 'number' ? result : 0} claim(s) on ${args.project}.`, structured: { released: result } };
      },
    }),
    defineBoardTool({
      name: 'heartbeat_code_task',
      title: 'Keep your board task alive',
      description:
        'Refresh your open task(s) so the board does not treat them as stale. Call it every few minutes ' +
        'during long work. Omit project to refresh all of your open tasks.',
      inputSchema: z.object({ project: projectArg.optional() }),
      run: async (args) => {
        const result = await board.heartbeat(principal, args.project !== undefined ? { project: args.project } : {});
        return { text: `Refreshed ${typeof result === 'number' ? result : 0} open task(s).`, structured: { refreshed: result } };
      },
    }),
    defineBoardTool({
      name: 'message_code_agents',
      title: 'Message other agents',
      description:
        'Post a message on a project board: to everyone, or to one agent by its session id (from ' +
        'code_coordination_board). Use it to ask a claim owner to release files or to announce your slice.',
      inputSchema: z.object({
        project: projectArg,
        body: z.string().min(1).max(BOARD_LIMITS.messageChars),
        recipient_session_id: z.string().min(1).max(200).optional().describe('Omit to broadcast.'),
      }),
      run: async (args) => {
        const result = await board.message(principal, {
          project: args.project,
          body: args.body,
          ...(args.recipient_session_id !== undefined ? { recipientSessionId: args.recipient_session_id } : {}),
        });
        return { text: `Message posted on ${args.project}.`, structured: { message_id: result } };
      },
    }),
    defineBoardTool({
      name: 'finish_code_task',
      title: 'Finish your board task',
      description:
        'Mark your task in a project completed (or canceled) and release all of its claims. Always call ' +
        'this when you stop working, so your claims do not block others.',
      inputSchema: z.object({
        project: projectArg.optional(),
        all_projects: z.boolean().optional().describe('Finish your open tasks in every project.'),
        result: z.string().max(BOARD_LIMITS.resultChars).optional().describe('What you did, briefly.'),
        canceled: z.boolean().optional(),
      }),
      run: async (args) => {
        const result = await board.finish(principal, {
          ...(args.project !== undefined ? { project: args.project } : {}),
          ...(args.all_projects !== undefined ? { allProjects: args.all_projects } : {}),
          ...(args.result !== undefined ? { result: args.result } : {}),
          ...(args.canceled !== undefined ? { canceled: args.canceled } : {}),
        });
        return {
          text: result === true ? 'Task finished and claims released.' : 'You had no open task to finish.',
          structured: { finished: result },
        };
      },
    }),
  ];
}

/** The live board tool set for this server's backend, bound to `principal`. */
export function boardTools(services: Services, principal: Principal): BoardToolDef[] {
  return services.config.board.backend === 'legacy'
    ? legacyBoardTools(services, principal)
    : agentcoordBoardTools(services, principal);
}

export function registerBoardTools(server: McpServer, services: Services, principal: Principal): void {
  const { logger } = services;
  for (const tool of boardTools(services, principal)) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
      guarded(tool.name, logger, async (args: unknown) => {
        const { text, structured } = await tool.run(args);
        return toolResult(text, structured);
      }),
    );
  }
}
