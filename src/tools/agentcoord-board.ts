import { z } from 'zod';
import type { Principal } from '../security/principal.js';
import type { Services } from '../server/container.js';
import { COORD_LIMITS } from '../services/board/agentcoord-service.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import { claimArg, defineBoardTool, type BoardToolDef } from './board-tool.js';

/**
 * Board tools backed by the Agent Coordination service (board.backend:
 * agentcoord). The seven legacy names keep their argument shapes; the coord_*
 * tools are what an outside worker needs to take and report project jobs.
 *
 * No schema here has an agent, session, worker, engine or credential field:
 * the caller's agentcoord identity comes from the authenticated principal,
 * and zod strips unknown keys, so a caller sending `agent: "someone-else"` is
 * simply ignored.
 */

const projectArg = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'an agentcoord project name such as "oakhaven"')
  .describe('agentcoord project: the repository name for file claims, or the plan name for jobs. Not a path.');

const claimsArg = z.array(claimArg).max(COORD_LIMITS.claimsPerCall);
const taskArg = z.string().min(1).max(COORD_LIMITS.taskChars);
const noteArg = z.string().min(1).max(COORD_LIMITS.noteChars);
const idArg = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

function obj(value: JsonValue | undefined): JsonObject {
  return (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as JsonObject;
}

function list(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function summariseBoard(view: JsonObject): string {
  const holders = list(view['holders']);
  const mine = list(view['mine']);
  const lines = [`File claims in ${String(view['project'])}: ${holders.length} holder(s); you hold ${mine.length} path(s).`];
  for (const raw of holders.slice(0, 20)) {
    const holder = obj(raw);
    const paths = list(holder['claims'])
      .map((claim) => {
        const c = obj(claim);
        return c['kind'] === 'tree' ? `${String(c['path'])}/**` : String(c['path']);
      })
      .join(', ');
    lines.push(`- ${String(holder['holder'] ?? holder['agent'] ?? '?')}: ${String(holder['task'] ?? '')}${paths ? ` - ${paths}` : ''}`);
  }
  return lines.join('\n');
}

export function agentcoordBoardTools(services: Services, principal: Principal): BoardToolDef[] {
  const coord = services.agentcoord;
  const who = 'Your Agent Coordination identity comes from your credential and cannot be changed.';

  return [
    defineBoardTool({
      name: 'code_coordination_board',
      title: 'Read the file claims of a repository',
      description:
        'Show the live file claims of a repository on the Agent Coordination service: who edits what, ' +
        `their task and expiry, and your own claims. Read it before editing; other agents edit the same repositories. ${who}`,
      inputSchema: z.object({
        project: projectArg,
        include_history: z.boolean().optional().describe('Also list expired (stale) claims.'),
      }),
      run: async (args) => {
        const view = await coord.board(principal, {
          project: args.project,
          ...(args.include_history !== undefined ? { includeHistory: args.include_history } : {}),
        });
        return { text: summariseBoard(view), structured: view };
      },
    }),
    defineBoardTool({
      name: 'post_code_task',
      title: 'Post a task and claim files',
      description:
        'Say what you are changing and claim the files or directories you will edit, replacing your earlier ' +
        'claims in that repository. All or nothing: a conflict names the owner; message them, never edit through a claim.',
      inputSchema: z.object({
        project: projectArg,
        task: taskArg.describe('One line: what you are changing.'),
        claims: claimsArg.default([]).describe('Files or directories you will modify (at least one).'),
      }),
      run: async (args) => {
        const result = await coord.postTask(principal, { project: args.project, task: args.task, claims: args.claims });
        return { text: `Posted your task on ${args.project} and claimed ${args.claims.length} path(s).`, structured: result };
      },
    }),
    defineBoardTool({
      name: 'claim_code_files',
      title: 'Claim more files',
      description:
        'Claim additional files or directory trees for your current task, keeping the ones you hold. ' +
        'A first claim in a repository needs `task`. Pass `job` to link the claim to the project job it serves.',
      inputSchema: z.object({
        project: projectArg,
        claims: claimsArg.min(1),
        task: taskArg.optional(),
        job: idArg.optional().describe('Project-plan job this claim serves.'),
        ack_jobs: z.array(idArg).max(50).optional().describe('Other open jobs listing these files whose owners you coordinated with.'),
        read_only: z.boolean().optional().describe('You only read or test these paths: the claim blocks nobody.'),
      }),
      run: async (args) => {
        const result = await coord.claim(principal, {
          project: args.project,
          claims: args.claims,
          ...(args.task !== undefined ? { task: args.task } : {}),
          ...(args.job !== undefined ? { job: args.job } : {}),
          ...(args.ack_jobs !== undefined ? { ackJobs: args.ack_jobs } : {}),
          ...(args.read_only !== undefined ? { readOnly: args.read_only } : {}),
        });
        return { text: `Claimed ${args.claims.length} more path(s) on ${args.project}.`, structured: result };
      },
    }),
    defineBoardTool({
      name: 'release_code_files',
      title: 'Release claimed files',
      description: 'Release some of your claims in a repository while keeping the others.',
      inputSchema: z.object({ project: projectArg, claims: claimsArg.min(1) }),
      run: async (args) => {
        const result = await coord.release(principal, { project: args.project, claims: args.claims });
        return { text: `Released ${list(result['released']).length} claim(s) on ${args.project}.`, structured: result };
      },
    }),
    defineBoardTool({
      name: 'heartbeat_code_task',
      title: 'Keep your claims and jobs alive',
      description:
        'Extend your file claims (they expire after 4 hours without a heartbeat) and refresh the jobs you hold. ' +
        'Call it every so often during long work.',
      inputSchema: z.object({ project: projectArg.optional() }),
      run: async (args) => {
        const result = await coord.heartbeat(principal, args.project !== undefined ? { project: args.project } : {});
        return {
          text: `Extended ${String(result['file_claims'])} file claim(s) and ${list(result['jobs']).length} job(s).`,
          structured: result,
        };
      },
    }),
    defineBoardTool({
      name: 'message_code_agents',
      title: 'Message other agents',
      description:
        'Send a message through Agent Coordination: to one agent by its id (host/name, e.g. the holder in a ' +
        'claim conflict without the #worker part), or to all agents when no recipient is given (use sparingly).',
      inputSchema: z.object({
        project: projectArg,
        body: z.string().min(1).max(COORD_LIMITS.messageChars),
        to: z.string().min(3).max(130).optional().describe('Recipient agent id, host/name. Omit to send to all agents.'),
        recipient_session_id: z.string().min(3).max(130).optional().describe('Older name for `to`.'),
      }),
      run: async (args) => {
        const to = args.to ?? args.recipient_session_id;
        const result = await coord.message(principal, { project: args.project, body: args.body, ...(to !== undefined ? { to } : {}) });
        return { text: to !== undefined ? `Message sent to ${to}.` : 'Message sent to all agents.', structured: result };
      },
    }),
    defineBoardTool({
      name: 'finish_code_task',
      title: 'Release all your claims',
      description:
        'Release all of your claims in a repository, or in every repository with all_projects. Always call ' +
        'this when you stop working, so your claims do not block others.',
      inputSchema: z.object({
        project: projectArg.optional(),
        all_projects: z.boolean().optional().describe('Release your claims in every repository.'),
        result: z.string().max(500).optional().describe('Outcome note, briefly.'),
        canceled: z.boolean().optional(),
      }),
      run: async (args) => {
        const result = await coord.finish(principal, {
          ...(args.project !== undefined ? { project: args.project } : {}),
          ...(args.all_projects !== undefined ? { allProjects: args.all_projects } : {}),
          ...(args.result !== undefined ? { result: args.result } : {}),
          ...(args.canceled !== undefined ? { canceled: args.canceled } : {}),
        });
        return { text: `Released ${String(result['count'])} claim(s).`, structured: result };
      },
    }),
    defineBoardTool({
      name: 'coord_attention',
      title: 'What needs you',
      description:
        'Everything that needs you on Agent Coordination, in one call: unacknowledged messages, tasks assigned to ' +
        'you, and agents you are waiting on. Call it at the start and after every step. Fetching is not ' +
        'acknowledging: coord_ack each message once handled.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional().describe('Most messages to return.') }),
      run: async (args) => {
        const result = await coord.attention(principal, args.limit !== undefined ? { limit: args.limit } : {});
        const messages = list(result['messages']).length;
        const tasks = list(result['tasks']).length;
        return { text: `${messages} message(s) and ${tasks} task(s) need you.`, structured: result };
      },
    }),
    defineBoardTool({
      name: 'coord_ack',
      title: 'Acknowledge messages',
      description: 'Acknowledge messages you have handled, by id (from coord_attention).',
      inputSchema: z.object({
        ids: z.array(idArg).min(1).max(COORD_LIMITS.ackIdsPerCall),
        applied: z.string().min(1).max(1000).optional().describe('What you did about them, briefly.'),
      }),
      run: async (args) => {
        const result = await coord.ack(principal, { ids: args.ids, ...(args.applied !== undefined ? { applied: args.applied } : {}) });
        return { text: `Acknowledged ${list(result['acknowledged']).length} message(s).`, structured: result };
      },
    }),
    defineBoardTool({
      name: 'coord_read',
      title: 'Read one message',
      description: 'Read one message in full (coord_attention shows previews of long ones).',
      inputSchema: z.object({ id: idArg }),
      run: async (args) => {
        const message = await coord.read(principal, { id: args.id });
        return { text: `Message ${args.id} from ${String(message['sender'] ?? '?')}.`, structured: message };
      },
    }),
    defineBoardTool({
      name: 'coord_project_list',
      title: 'List projects and vision swarms',
      description:
        'List the coordination projects you can reach, with job counts, and which are vision swarms ' +
        '(shared projects every agent works on). Start here, then read one with coord_project_show.',
      inputSchema: z.object({
        swarms_only: z.boolean().optional().describe('Only vision swarms.'),
        include_done: z.boolean().optional().describe('Also list finished projects.'),
      }),
      run: async (args) => {
        const result = await coord.projectList(principal, {
          ...(args.swarms_only !== undefined ? { swarmsOnly: args.swarms_only } : {}),
          ...(args.include_done !== undefined ? { includeDone: args.include_done } : {}),
        });
        const rows = list(result['projects']).map((row) => (typeof row === 'object' && row !== null && !Array.isArray(row) ? row : {}) as JsonObject);
        const lines = rows.map((row) =>
          `- ${String(row['name'])}${row['swarm'] === true ? ' [swarm]' : ''} [${String(row['status'] ?? '?')}]: ` +
          `${String(row['open'] ?? 0)} open, ${String(row['done'] ?? 0)} done`);
        return { text: [`${rows.length} project(s) you can reach:`, ...lines].join('\n'), structured: result };
      },
    }),
    defineBoardTool({
      name: 'coord_project_show',
      title: 'Show a project plan',
      description:
        "A project's plan: its vision, the ordered jobs with their status and owner, and the next open job. " +
        'Read it before taking a job.',
      inputSchema: z.object({
        project: projectArg,
        include_done: z.boolean().optional().describe('Also list finished jobs.'),
      }),
      run: async (args) => {
        const result = await coord.projectShow(principal, {
          project: args.project,
          ...(args.include_done !== undefined ? { includeDone: args.include_done } : {}),
        });
        const next = result['next_open'];
        return {
          text: `${args.project}: ${list(result['jobs']).length} job(s) shown${next !== null && next !== undefined ? `; next open job ${String(next)}` : ''}.`,
          structured: result,
        };
      },
    }),
    defineBoardTool({
      name: 'coord_job_take',
      title: 'Take a project job',
      description:
        'Become the agent working on a job (exclusive). The service may refuse a job outside the kinds of work ' +
        'your identity is allowed; pick another job then. Claim the job\'s files before editing.',
      inputSchema: z.object({
        project: projectArg,
        id: idArg.describe('Job id from coord_project_show.'),
        note: noteArg.optional(),
      }),
      run: async (args) => {
        const result = await coord.jobTake(principal, {
          project: args.project,
          id: args.id,
          ...(args.note !== undefined ? { note: args.note } : {}),
        });
        const warnings = list(result['warnings']);
        return {
          text: `You hold job ${args.id}.${warnings.length > 0 ? ` ${warnings.length} warning(s): read them before editing.` : ''}`,
          structured: result,
        };
      },
    }),
    defineBoardTool({
      name: 'coord_job_update',
      title: 'Report on your job',
      description:
        'Report on a job you hold: progress (a note), block (say what blocks it), done (what was finished and how ' +
        'it was verified: commit, test, link), or release (give it back unfinished).',
      inputSchema: z.object({
        id: idArg,
        action: z.enum(['progress', 'block', 'done', 'release']),
        note: noteArg.optional(),
      }),
      run: async (args) => {
        const result = await coord.jobUpdate(principal, {
          id: args.id,
          action: args.action,
          ...(args.note !== undefined ? { note: args.note } : {}),
        });
        return { text: `Job ${args.id}: ${args.action} recorded.`, structured: result };
      },
    }),
    defineBoardTool({
      name: 'coord_my_jobs',
      title: 'Your jobs',
      description: 'The jobs you hold (in progress or blocked), and recent ones others closed for you. Resume your own first.',
      inputSchema: z.object({}),
      run: async () => {
        const result = await coord.myJobs(principal);
        return { text: `You hold ${list(result['jobs']).length} job(s).`, structured: result };
      },
    }),
  ];
}
