import type { ContextProfile } from './schema.js';

/**
 * Built-in context profiles.
 *
 * These are MERGED UNDER operator config, so a profile of the same name in
 * config wins outright. They exist so a fresh install is useful immediately and
 * so the acceptance criteria hold before anyone writes a YAML file.
 *
 * `default` is deliberately small: it is what the live-voice path pays for on
 * every turn.
 */
export const BUILT_IN_CONTEXT_PROFILES: Record<string, ContextProfile> = {
  default: {
    description: 'Compact, responsive context for ordinary voice turns.',
    providers: ['computers', 'projects', 'workSessions', 'preferences'],
  },
  coding: {
    description: 'Everything relevant while actively working on code.',
    providers: ['computers', 'projects', 'workSessions', 'preferences', 'memory', 'git'],
  },
  infrastructure: {
    description: 'Machine and service health rather than code.',
    providers: ['computers', 'services', 'systemStatus'],
  },
  minimal: {
    description: 'Smallest useful payload: what machines exist and what is running.',
    providers: ['computers', 'workSessions'],
  },
  full: {
    description: 'Every available provider. Slow; use for diagnostics.',
    providers: [
      'computers',
      'projects',
      'workSessions',
      'preferences',
      'memory',
      'git',
      'services',
      'systemStatus',
    ],
  },
};

/** Default per-provider priorities when config does not override them. */
export const DEFAULT_PROVIDER_PRIORITIES: Record<string, number> = {
  workSessions: 100,
  computers: 95,
  projects: 90,
  preferences: 80,
  memory: 70,
  git: 60,
  services: 50,
  systemStatus: 40,
};
