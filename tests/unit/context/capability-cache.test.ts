import { describe, expect, it } from 'vitest';
import { cachedCapabilities, type CapabilitySource } from '../../../src/tools/capability-cache.js';

/**
 * These count real probes rather than measuring elapsed time. A stopwatch
 * assertion passes whether or not the cache works when the providers under
 * test are cheap, which is how a broken cache survived in this repo.
 */

function countingSource(delayMs = 0): CapabilitySource<string[]> & { calls: number } {
  return {
    calls: 0,
    async capabilities(): Promise<string[]> {
      this.calls += 1;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return ['memory', 'projects'];
    },
  };
}

function failingSource(): CapabilitySource<string[]> & { calls: number } {
  return {
    calls: 0,
    async capabilities(): Promise<string[]> {
      this.calls += 1;
      throw new Error('mem0 unreachable');
    },
  };
}

describe('cachedCapabilities', () => {
  it('probes once and serves the cache afterwards', async () => {
    const source = countingSource();
    expect(await cachedCapabilities(source, 5_000)).toEqual(['memory', 'projects']);
    await cachedCapabilities(source, 5_000);
    await cachedCapabilities(source, 5_000);
    expect(source.calls).toBe(1);
  });

  /**
   * The actual bug: registerContextTools runs per request, so the memo must
   * outlive any single caller. Two unrelated call sites sharing one source is
   * exactly the per-request shape.
   */
  it('is shared across callers, not per caller', async () => {
    const source = countingSource();
    const requestOne = async (): Promise<string[]> => cachedCapabilities(source, 5_000);
    const requestTwo = async (): Promise<string[]> => cachedCapabilities(source, 5_000);
    await requestOne();
    await requestTwo();
    expect(source.calls).toBe(1);
  });

  it('collapses concurrent callers onto a single probe', async () => {
    const source = countingSource(30);
    await Promise.all([
      cachedCapabilities(source, 5_000),
      cachedCapabilities(source, 5_000),
      cachedCapabilities(source, 5_000),
    ]);
    expect(source.calls).toBe(1);
  });

  it('re-probes once the TTL has passed', async () => {
    const source = countingSource();
    await cachedCapabilities(source, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await cachedCapabilities(source, 1);
    expect(source.calls).toBe(2);
  });

  it('keeps separate sources separate', async () => {
    const first = countingSource();
    const second = countingSource();
    await cachedCapabilities(first, 5_000);
    await cachedCapabilities(second, 5_000);
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(1);
  });

  it('does not cache a failure, so a transient outage is retried', async () => {
    const source = failingSource();
    await expect(cachedCapabilities(source, 5_000)).rejects.toThrow('mem0 unreachable');
    await expect(cachedCapabilities(source, 5_000)).rejects.toThrow('mem0 unreachable');
    expect(source.calls).toBe(2);
  });
});
