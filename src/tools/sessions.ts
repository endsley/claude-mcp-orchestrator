import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Services } from '../server/container.js';
import { orchestratorError } from '../types/errors.js';
import type { JsonValue } from '../types/json.js';
import { guarded, toolResult } from './result.js';

/**
 * Resolve "the session the user means".
 *
 * Order matters: an explicit id wins, then whatever the conversation last
 * referred to, then the most recent session that is still live. Falling
 * straight to "most recent" would let "how's it going?" report on yesterday's
 * finished work as though it were running.
 */
function resolveSessionId(services: Services, provided?: string): string {
  if (provided && provided.trim() !== '') return provided.trim();

  const active = services.activeContext.get().workSessionId;
  if (active && services.sessionStore.get(active)) return active;

  const recent = services.sessionStore.list({ limit: 10 });
  const live = recent.find(
    (session) =>
      session.status === 'working' ||
      session.status === 'idle' ||
      session.status === 'needs_input' ||
      session.status === 'awaiting_approval' ||
      session.status === 'interrupted',
  );
  if (live) return live.id;

  const latest = recent[0];
  if (latest) return latest.id;

  throw orchestratorError('SESSION_NOT_FOUND', 'There is no work session to act on.', {
    hint: 'Start one with start_work_session.',
  });
}

export function registerSessionTools(server: McpServer, services: Services): void {
  const { logger, sessions, sessionStore } = services;

  server.registerTool(
    'start_work_session',
    {
      title: 'Start a work session',
      description:
        'Hand a development task to Claude Code on the user\'s computer. Returns immediately with a ' +
        'session id; the work continues in the background. Use this for real work ("fix the mobile ' +
        'navigation", "add a test for X"). If a session is already running on the same thing, send a ' +
        'follow-up with send_work_session_instruction instead.',
      inputSchema: z.object({
        instruction: z.string().min(1).describe('What the user wants done, in their own words.'),
        project: z.string().optional().describe('Project name, alias or path.'),
        computer: z.string().optional().describe('Computer name or alias. Defaults to this machine.'),
        mode: z
          .enum(['work', 'plan', 'inspect'])
          .optional()
          .describe('"work" edits files, "plan" plans only, "inspect" is read-only.'),
        context: z.string().optional().describe('Extra context worth giving the worker verbatim.'),
      }),
    },
    guarded('start_work_session', logger, async (args) => {
      const output = await sessions.startSession({
        instruction: args.instruction,
        ...(args.project !== undefined ? { project: args.project } : {}),
        ...(args.computer !== undefined ? { computer: args.computer } : {}),
        ...(args.mode !== undefined ? { mode: args.mode } : {}),
        ...(args.context !== undefined ? { context: args.context } : {}),
      });
      return toolResult(output.summary, output as unknown as JsonValue);
    }),
  );

  const sendInstruction = guarded(
    'send_work_session_instruction',
    logger,
    async (args: { sessionId?: string; instruction: string }) => {
      const sessionId = resolveSessionId(services, args.sessionId);
      const result = await sessions.sendInstruction(sessionId, args.instruction);
      return toolResult(result.summary, { sessionId, ...result } as unknown as JsonValue);
    },
  );

  server.registerTool(
    'send_work_session_instruction',
    {
      title: 'Send an instruction to running work',
      description:
        'Add an instruction to work already in progress, keeping all the context the worker has built ' +
        'up. Use this for follow-ups and course corrections: "make it 20 percent smaller", "don\'t ' +
        'modify the backend", "run the full test suite". Works while the session is working OR idle. ' +
        'Omit sessionId to target the active session.',
      inputSchema: z.object({
        sessionId: z.string().optional(),
        instruction: z.string().min(1),
      }),
    },
    sendInstruction,
  );

  server.registerTool(
    'continue_work_session',
    {
      title: 'Continue a work session',
      description:
        'Alias of send_work_session_instruction, for when the user explicitly asks to continue earlier ' +
        'work. Preserves the existing Claude Code conversation.',
      inputSchema: z.object({
        sessionId: z.string().optional(),
        instruction: z.string().min(1),
      }),
    },
    sendInstruction,
  );

  server.registerTool(
    'get_work_session_status',
    {
      title: 'Get work session status',
      description:
        'Concise progress for running work: what it is doing now, what it has finished, and whether ' +
        'it is waiting on a question. Use this for "how is it going" or "what is Claude doing". ' +
        'Status "idle" means the last piece of work finished and the session is ready for another ' +
        'instruction - report what it did and stay ready, do not start a new session.',
      inputSchema: z.object({ sessionId: z.string().optional() }),
    },
    guarded('get_work_session_status', logger, async (args) => {
      const sessionId = resolveSessionId(services, args.sessionId);
      const view = sessions.getStatus(sessionId);

      const spoken: string[] = [];
      if (view.pendingQuestion) {
        spoken.push(`It is waiting on you: ${view.pendingQuestion.question}`);
        if (view.pendingQuestion.choices) spoken.push(`Options: ${view.pendingQuestion.choices.join(', ')}.`);
      } else {
        spoken.push(`${view.summary} (${view.status})`);
        if (view.currentStep) spoken.push(view.currentStep);
      }
      if (view.warnings.length > 0) spoken.push(`Warnings: ${view.warnings.join('; ')}`);

      return toolResult(spoken.join(' '), view as unknown as JsonValue);
    }),
  );

  server.registerTool(
    'get_work_session_result',
    {
      title: 'Get work session result',
      description:
        'What the work actually changed: files, test outcome, git state. Test results come from real ' +
        'command exit statuses, so trust them. Use for "what did it change" or "did the tests pass".',
      inputSchema: z.object({ sessionId: z.string().optional() }),
    },
    guarded('get_work_session_result', logger, async (args) => {
      const sessionId = resolveSessionId(services, args.sessionId);
      const result = sessions.getResult(sessionId);

      const spoken: string[] = [result.summary];
      if (result.filesChanged.length > 0) {
        spoken.push(
          `Changed ${result.filesChanged.length} file${result.filesChanged.length === 1 ? '' : 's'}: ` +
            `${result.filesChanged.slice(0, 5).join(', ')}${result.filesChanged.length > 5 ? ', and others' : ''}.`,
        );
      } else {
        spoken.push('No files were changed.');
      }
      if (result.tests) {
        if (result.tests.outcome === 'unknown') spoken.push('Tests were started but the outcome was unclear.');
        else if (result.tests.run !== undefined) {
          spoken.push(`Tests ${result.tests.outcome}: ${result.tests.passed ?? 0} of ${result.tests.run}.`);
        } else spoken.push(`Tests ${result.tests.outcome}.`);
      }
      if (result.git?.committed) spoken.push(result.git.pushed ? 'Changes were committed and pushed.' : 'Changes were committed but not pushed.');

      return toolResult(spoken.join(' '), { sessionId, ...result } as unknown as JsonValue);
    }),
  );

  server.registerTool(
    'respond_to_work_session',
    {
      title: 'Answer a question from running work',
      description:
        "Deliver the user's answer to a question or approval request raised by the worker, and let it " +
        'continue. Only call this when get_work_session_status reported a pending question.',
      inputSchema: z.object({
        sessionId: z.string().optional(),
        answer: z.string().min(1).describe("The user's answer, in their own words."),
        requestId: z.string().optional().describe('Specific request to answer, if known.'),
      }),
    },
    guarded('respond_to_work_session', logger, async (args) => {
      const sessionId = resolveSessionId(services, args.sessionId);
      const result = sessions.respond(
        sessionId,
        args.answer,
        args.requestId !== undefined ? args.requestId : undefined,
      );
      return toolResult(result.summary, { sessionId, ...result } as unknown as JsonValue);
    }),
  );

  server.registerTool(
    'cancel_work_session',
    {
      title: 'Cancel a work session',
      description:
        'Stop running work. Interrupts the worker gracefully so an in-flight edit is not torn in half. ' +
        'Use for "stop", "cancel that", "never mind".',
      inputSchema: z.object({
        sessionId: z.string().optional(),
        reason: z.string().optional(),
      }),
    },
    guarded('cancel_work_session', logger, async (args) => {
      const sessionId = resolveSessionId(services, args.sessionId);
      const result = await sessions.cancel(sessionId, args.reason ?? 'cancelled by user');
      return toolResult(result.summary, { sessionId, ...result } as unknown as JsonValue);
    }),
  );

  server.registerTool(
    'get_recent_activity',
    {
      title: 'Get recent activity',
      description:
        'Summarise recent work sessions and what they touched. Use for "what were we working on ' +
        'yesterday" or "what did Claude change earlier".',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).optional(),
        project: z.string().optional(),
      }),
    },
    guarded('get_recent_activity', logger, async (args) => {
      const list = sessionStore.list({
        limit: args.limit ?? 10,
        ...(args.project !== undefined ? { projectId: args.project } : {}),
      });
      if (list.length === 0) return toolResult('There is no recorded work yet.', { sessions: [] });

      const lines = list.map((session) => {
        const when = new Date(session.updatedAt).toLocaleString();
        const files = session.result?.filesChanged.length ?? 0;
        return `${session.id} (${session.status}, ${when}): ${session.currentSummary ?? session.initialInstruction}` +
          (files > 0 ? ` — ${files} file${files === 1 ? '' : 's'} changed` : '');
      });

      return toolResult(
        `${list.length} recent work session${list.length === 1 ? '' : 's'}.\n${lines.join('\n')}`,
        { sessions: list as unknown as JsonValue },
      );
    }),
  );
}
