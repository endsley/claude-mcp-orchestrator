import { describe, expect, it, vi } from 'vitest';
import { settledWithin } from '../../../src/services/claude/settled-within.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('settledWithin', () => {
  it('reports true when the work finishes first', async () => {
    await expect(settledWithin(sleep(5), 200)).resolves.toBe(true);
  });

  it('reports false when the work outlives the deadline', async () => {
    const started = Date.now();
    // A promise that never settles: the case the worker's interrupt hits when a
    // tool call hangs.
    await expect(settledWithin(new Promise(() => undefined), 60)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('counts a rejection as settled, because failing IS returning', async () => {
    await expect(settledWithin(Promise.reject(new Error('nope')), 200)).resolves.toBe(true);
  });

  it('does not leave an unhandled rejection when the work fails AFTER the deadline', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const late = sleep(40).then(() => {
        throw new Error('too late');
      });
      await expect(settledWithin(late, 10)).resolves.toBe(false);
      // Give the late rejection time to arrive and be noticed.
      await sleep(80);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('clears its timer so a fast settle leaves nothing pending', async () => {
    const clear = vi.spyOn(global, 'clearTimeout');
    try {
      await settledWithin(Promise.resolve(), 30_000);
      expect(clear).toHaveBeenCalled();
    } finally {
      clear.mockRestore();
    }
  });
});
