import { describe, expect, it } from 'vitest';
import { contextAssemblyConfiguration } from '../../../src/context/config-adapter.js';
import { appConfigSchema } from '../../../src/config/schema.js';

describe('provider configuration adapter', () => {
  it('maps validated application profiles and provider settings without a provider switch', () => {
    const config = appConfigSchema.parse({
      memory: { enabled: false, provider: 'none' },
      initialContext: {
        maxTokens: 1800,
        maxConcurrency: 4,
        defaultProfile: 'default',
        providers: { computers: { enabled: true, cacheTtlMs: 10_000 } },
      },
      contextProfiles: {
        default: { providers: ['computers'] },
        coding: { providers: ['computers', 'memory'] },
        infrastructure: { providers: ['systemStatus'] },
      },
    });
    const context = contextAssemblyConfiguration(config);
    expect(context.defaultProfile).toBe('default');
    expect(context.profiles.coding?.providers).toContain('memory');
    expect(context.profiles.infrastructure?.providers).toContain('systemStatus');
    expect(context.providers.computers?.cacheTtlMs).toBe(10_000);
    expect(context.retrievalConcurrency).toBe(4);
  });
});
