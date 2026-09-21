import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Services } from '../server/container.js';
import { orchestratorError } from '../types/errors.js';
import type { JsonValue } from '../types/json.js';
import type { Project } from '../types/projects.js';
import { guarded, toolResult } from './result.js';

function describe(project: Project): string {
  const bits: string[] = [project.displayName];
  if (project.language) bits.push(project.language);
  if (project.git?.branch) bits.push(`on ${project.git.branch}${project.git.dirty ? ' (uncommitted changes)' : ''}`);
  return bits.join(' — ');
}

export function registerProjectTools(server: McpServer, services: Services): void {
  const { logger, projects, sessionStore, activeContext } = services;

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: "List the user's known development projects, most recently active first.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional(),
        refresh: z.boolean().optional().describe('Force a rescan of the project roots.'),
      }),
    },
    guarded('list_projects', logger, async (args) => {
      const all = await projects.list(args.refresh ?? false);
      const list = all.slice(0, args.limit ?? 25);
      const text =
        list.length === 0
          ? 'No projects are configured. Add project roots to the orchestrator config.'
          : `${all.length} projects known. ${list.map((p) => p.displayName).join(', ')}.`;
      return toolResult(text, { total: all.length, projects: list as unknown as JsonValue });
    }),
  );

  server.registerTool(
    'find_project',
    {
      title: 'Find a project',
      description:
        'Resolve a spoken project name or alias ("my transit app", "home tab") to a specific project. ' +
        'Returns candidates rather than guessing when ambiguous. Never invent a project.',
      inputSchema: z.object({
        query: z.string().min(1).describe('The name or description the user used.'),
        computer: z.string().optional().describe('Restrict to a specific computer id.'),
      }),
    },
    guarded('find_project', logger, async (args) => {
      const resolution = await projects.resolve(args.query, args.computer);

      if (resolution.kind === 'ambiguous') {
        throw orchestratorError('PROJECT_AMBIGUOUS', `"${args.query}" matches more than one project.`, {
          details: { candidates: resolution.candidates.map((p) => p.displayName) },
          hint: `Ask whether they mean ${resolution.candidates.map((p) => p.displayName).join(' or ')}.`,
        });
      }
      if (resolution.kind === 'not_found' || !resolution.project) {
        // The shared error log records only the code, which makes a failed
        // lookup undiagnosable after the fact: the phrase that missed is the
        // one piece of information needed to fix the matching.
        logger.warn('project lookup found nothing', { tool: 'find_project', query: args.query });
        throw orchestratorError('PROJECT_NOT_FOUND', `No project matches "${args.query}".`, {
          details: { query: args.query },
          hint: 'Call list_projects to see what exists.',
        });
      }

      activeContext.update({ projectId: resolution.project.id });
      return toolResult(describe(resolution.project), resolution.project as unknown as JsonValue);
    }),
  );

  server.registerTool(
    'get_project_context',
    {
      title: 'Get project context',
      description:
        'Detail for one project: language, git branch and cleanliness, whether it has a CLAUDE.md, ' +
        'and any work session currently running against it.',
      inputSchema: z.object({
        project: z.string().min(1).describe('Project id, path, name or alias.'),
      }),
    },
    guarded('get_project_context', logger, async (args) => {
      let project: Project;
      try {
        project = await projects.get(args.project);
      } catch {
        const resolution = await projects.resolve(args.project);
        if (resolution.kind !== 'match' || !resolution.project) {
          logger.warn('project lookup found nothing', { tool: 'get_project_context', query: args.project });
          throw orchestratorError('PROJECT_NOT_FOUND', `No project matches "${args.project}".`, {
            details: { query: args.project },
          });
        }
        project = resolution.project;
      }

      const holder = sessionStore.getProjectWriteLockHolder(project.id);
      activeContext.update({ projectId: project.id });

      const lines: string[] = [describe(project)];
      lines.push(`Path: ${project.path}`);
      if (project.hasClaudeMd) lines.push('Has a CLAUDE.md, so Claude Code already knows this project.');
      if (holder) lines.push(`Work session ${holder} is currently working on it.`);
      else lines.push('No work session is running against it.');

      return toolResult(lines.join(' '), {
        ...(project as unknown as Record<string, JsonValue>),
        activeWorkSessionId: holder ?? null,
      });
    }),
  );
}
