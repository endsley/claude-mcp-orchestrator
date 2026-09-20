import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Work-session and SQLite tests touch shared temp state; keep files isolated
    // but allow parallelism across files via separate forks.
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    restoreMocks: true,
  },
});
