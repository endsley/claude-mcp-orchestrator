import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Services } from '../server/container.js';
import type { JsonValue } from '../types/json.js';
import { guarded, toolResult } from './result.js';
import { cachedCapabilities } from './capability-cache.js';

/**
 * Capability listings are cached briefly.
 *
 * `capabilities()` probes every provider's `isAvailable()` and `health()`, and
 * for network-backed providers (Mem0) that is a live round-trip. Measured warm
 * p95 without this cache was ~940ms, which is far too slow for a call the voice
 * model makes to decide what it can ask for. Availability does not meaningfully
 * change second to second, so a short TTL is safe; a provider that goes down is
 * reflected within the TTL.
 */
const CAPABILITY_CACHE_TTL_MS = 5_000;

/** Environment/context tools: what the assistant knows before it acts. */
export function registerContextTools(server: McpServer, services: Services): void {
  const { logger, contextAssembler, activeContext } = services;

  // Deliberately NOT a closure local: this function runs once per request, so
  // a local cache would be new every time and the TTL would never survive a
  // request. See ./capability-cache.ts.
  const getCapabilities = async (): Promise<Awaited<ReturnType<typeof contextAssembler.capabilities>>> =>
    cachedCapabilities(contextAssembler, CAPABILITY_CACHE_TTL_MS);

  server.registerTool(
    'get_environment_context',
    {
      title: 'Get environment context',
      description:
        "Summarise the user's computers, projects, active work and preferences. Call this before " +
        'guessing what "my server", "that project" or "what we were working on" refers to. ' +
        'Use profile="coding" when the conversation is about code, "infrastructure" for machine health, ' +
        '"minimal" when you only need what exists and what is running.',
      inputSchema: z.object({
        profile: z.string().optional().describe('Named context profile. Defaults to the configured default.'),
        focus: z.string().optional().describe('What the user is asking about, to bias retrieval.'),
        include: z.array(z.string()).optional().describe('Extra provider ids to include.'),
        exclude: z.array(z.string()).optional().describe('Provider ids to leave out.'),
        maxTokens: z.number().int().min(100).max(8000).optional(),
      }),
    },
    guarded('get_environment_context', logger, async (args) => {
      const snapshot = activeContext.get();
      const assembled = await contextAssembler.assemble({
        ...(args.profile !== undefined ? { profile: args.profile } : {}),
        ...(args.focus !== undefined ? { focus: args.focus } : {}),
        ...(args.include !== undefined ? { include: args.include } : {}),
        ...(args.exclude !== undefined ? { exclude: args.exclude } : {}),
        ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
        activeContext: snapshot,
      });

      return toolResult(assembled.text, {
        profile: assembled.profile,
        estimatedTokens: assembled.estimatedTokens,
        warnings: assembled.warnings as unknown as JsonValue,
        sections: assembled.sections.map((section) => ({
          providerId: section.providerId,
          title: section.title,
          lines: section.lines,
          ...(section.data !== undefined ? { data: section.data } : {}),
        })),
      });
    }),
  );

  server.registerTool(
    'list_context_capabilities',
    {
      title: 'List context capabilities',
      description:
        'Discover what categories of environment information exist, whether each is currently ' +
        'available, and whether it is included by default. Use this when you suspect the user is ' +
        'asking about something not in the default context.',
      inputSchema: z.object({}),
    },
    guarded('list_context_capabilities', logger, async () => {
      const capabilities = await getCapabilities();
      const available = capabilities.filter((capability) => capability.available);
      const text =
        available.length === 0
          ? 'No context providers are currently available.'
          : `${available.length} of ${capabilities.length} context categories are available: ` +
            `${available.map((capability) => capability.id).join(', ')}.`;
      return toolResult(text, { capabilities: capabilities as unknown as JsonValue });
    }),
  );
}
