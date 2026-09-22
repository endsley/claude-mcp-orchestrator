import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Services } from '../server/container.js';
import { orchestratorError } from '../types/errors.js';
import type { JsonValue } from '../types/json.js';
import type { MemoryResult } from '../types/memory.js';
import { guarded, toolResult } from './result.js';

/**
 * Collapse near-duplicate memories.
 *
 * Vector stores routinely return the same fact three times with different
 * wording; reading all three aloud is worse than useless. Normalised-prefix
 * matching is crude but cheap, and the cost of a false merge here is low.
 */
export function deduplicateMemories(results: MemoryResult[]): MemoryResult[] {
  const seen = new Set<string>();
  const out: MemoryResult[] = [];
  for (const result of results) {
    const normalised = result.text.toLowerCase().replace(/\s+/g, ' ').trim();
    const key = normalised.slice(0, 120);
    if (seen.has(key)) continue;
    // Also drop anything wholly contained in a memory we already kept.
    if (out.some((kept) => kept.text.toLowerCase().replace(/\s+/g, ' ').includes(normalised) && normalised.length > 0)) {
      continue;
    }
    seen.add(key);
    out.push(result);
  }
  return out;
}

export function registerMemoryTools(server: McpServer, services: Services): void {
  const { logger, memory, config } = services;

  server.registerTool(
    'recall_context',
    {
      title: 'Recall long-term context',
      description:
        "Search the user's long-term memory for facts relevant to the current request: durable " +
        'preferences, past technical decisions, project conventions. Use a specific query; this is ' +
        'not a dump of everything the user has ever said.',
      inputSchema: z.object({
        query: z.string().min(1).max(2_000).describe('What you need to know, phrased as a search.'),
        project: z.string().optional().describe('Bias results toward a project.'),
        limit: z.number().int().min(1).max(20).optional(),
      }),
    },
    guarded('recall_context', logger, async (args) => {
      if (!config.memory.enabled || config.memory.provider === 'none') {
        throw orchestratorError('MEMORY_UNAVAILABLE', 'Long-term memory is not configured on this server.', {
          retryable: false,
        });
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.memory.timeoutMs);
      let results: MemoryResult[];
      try {
        results = await memory.search({
          query: args.query,
          ...(args.project !== undefined ? { project: args.project } : {}),
          limit: args.limit ?? config.memory.maxResults,
          signal: controller.signal,
        });
      } catch (error) {
        throw orchestratorError('MEMORY_UNAVAILABLE', 'Long-term memory could not be reached.', {
          cause: error,
          retryable: true,
        });
      } finally {
        clearTimeout(timer);
      }

      const deduped = deduplicateMemories(results);
      if (deduped.length === 0) {
        return toolResult(`Nothing relevant to "${args.query}" is stored.`, { memories: [] });
      }

      const text = deduped.map((memoryResult, index) => `${index + 1}. ${memoryResult.text}`).join('\n');
      return toolResult(text, { count: deduped.length, memories: deduped as unknown as JsonValue });
    }),
  );
}
