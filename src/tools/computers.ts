import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Services } from '../server/container.js';
import type { Computer } from '../types/computers.js';
import { orchestratorError } from '../types/errors.js';
import type { JsonValue } from '../types/json.js';
import { guarded, toolResult } from './result.js';

/** Speech-friendly one-liner for a machine. */
function describe(computer: Computer): string {
  const state = computer.tailscale.online === true ? 'online' : computer.tailscale.online === false ? 'offline' : 'status unknown';
  const role = computer.role ? ` — ${computer.role}` : '';
  return `${computer.displayName}${role} — ${state}`;
}

export function registerComputerTools(server: McpServer, services: Services): void {
  const { logger, computers, activeContext } = services;

  server.registerTool(
    'list_computers',
    {
      title: 'List computers',
      description:
        "List the user's known machines with their roles and current online status. Use this for " +
        '"what computers do I have", "what is online", or before referring to a specific machine.',
      inputSchema: z.object({
        onlineOnly: z.boolean().optional().describe('Only return machines currently online.'),
        refresh: z.boolean().optional().describe('Bypass the short status cache.'),
      }),
    },
    guarded('list_computers', logger, async (args) => {
      const all = await computers.list(args.refresh ?? false);
      const list = args.onlineOnly ? all.filter((c) => c.tailscale.online === true) : all;
      const online = all.filter((c) => c.tailscale.online === true);

      const text =
        `${all.length} computers are known. ${online.length} are online.` +
        (online.length > 0
          ? ` Online: ${online.map((c) => c.displayName).join(', ')}.`
          : '');

      return toolResult(`${text}\n\n${list.map(describe).join('\n')}`, {
        total: all.length,
        online: online.length,
        computers: list as unknown as JsonValue,
      });
    }),
  );

  server.registerTool(
    'get_computer',
    {
      title: 'Get a computer',
      description:
        'Resolve a spoken machine name or alias ("the GPU machine", "my web server", "the 24 gig box") ' +
        'to a specific computer. Returns candidates instead of guessing when the phrase is ambiguous.',
      inputSchema: z.object({
        query: z.string().min(1).max(512).describe('The name, alias, role or description the user used.'),
      }),
    },
    guarded('get_computer', logger, async (args) => {
      const resolution = await computers.resolve(args.query);

      if (resolution.kind === 'ambiguous') {
        throw orchestratorError('COMPUTER_AMBIGUOUS', `"${args.query}" matches more than one computer.`, {
          details: { candidates: resolution.candidates.map((c) => c.displayName) },
          hint: `Ask the user whether they mean ${resolution.candidates.map((c) => c.displayName).join(' or ')}.`,
        });
      }
      if (resolution.kind === 'not_found' || !resolution.computer) {
        throw orchestratorError('COMPUTER_NOT_FOUND', `No computer matches "${args.query}".`, {
          details: { query: args.query },
          hint: 'Call list_computers to see the known machines.',
        });
      }

      const computer = resolution.computer;
      activeContext.update({ computerId: computer.id });

      const detail: string[] = [describe(computer)];
      if (computer.aliases.length > 0) detail.push(`Also called: ${computer.aliases.join(', ')}.`);
      if (computer.capabilities?.gpu) {
        detail.push(
          `GPU: ${computer.capabilities.gpu}${computer.capabilities.vramGb ? ` (${computer.capabilities.vramGb} GB)` : ''}.`,
        );
      }
      if (computer.tailscale.connectionType && computer.tailscale.connectionType !== 'unknown') {
        detail.push(`Connection: ${computer.tailscale.connectionType}.`);
      }
      if (computer.notes && computer.notes.length > 0) detail.push(...computer.notes);

      return toolResult(detail.join(' '), computer as unknown as JsonValue);
    }),
  );
}
