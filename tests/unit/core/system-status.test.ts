import { describe, expect, it } from 'vitest';
import { parseGpuCsv } from '../../../src/services/system/system-status-service.js';
import { TailscaleClient, type TailscaleCommandRunner } from '../../../src/services/tailscale/tailscale-client.js';
import { OrchestratorError } from '../../../src/types/errors.js';

describe('parseGpuCsv', () => {
  it('reads a single GPU', () => {
    const gpu = parseGpuCsv('NVIDIA RTX A5000, 24564, 1234\n');
    expect(gpu).toEqual({ name: 'NVIDIA RTX A5000', memoryTotalMiB: 24564, memoryUsedMiB: 1234 });
  });

  /**
   * nvidia-smi emits one line per GPU. Splitting the whole output on ','
   * made the third field "1234\nNVIDIA RTX A4000", so memory use came back
   * NaN and was silently dropped while the second card vanished.
   */
  it('does not lose memory use on a multi-GPU box', () => {
    const gpu = parseGpuCsv('NVIDIA RTX A5000, 24564, 1234\nNVIDIA RTX A4000, 16376, 567\n');
    expect(gpu?.memoryUsedMiB).toBe(1234);
    expect(gpu?.memoryTotalMiB).toBe(24564);
  });

  it('says how many GPUs there are rather than implying one', () => {
    const gpu = parseGpuCsv('NVIDIA RTX A5000, 24564, 1234\nNVIDIA RTX A4000, 16376, 567\n');
    expect(gpu?.name).toContain('2 GPUs');
  });

  it('returns nothing for empty or junk output', () => {
    expect(parseGpuCsv('')).toBeUndefined();
    expect(parseGpuCsv('   \n  ')).toBeUndefined();
    expect(parseGpuCsv('not,a,number\n')).toBeUndefined();
  });
});

function runnerThatThrows(error: unknown): TailscaleCommandRunner {
  return {
    run: async () => {
      throw error;
    },
  };
}

describe('TailscaleClient error shape', () => {
  /** A retry cannot conjure a binary that is not installed. */
  it('does not mark a missing binary retryable', async () => {
    const enoent = Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' });
    const client = new TailscaleClient(runnerThatThrows(enoent));

    const error = await client.status().catch((caught: unknown) => caught);

    expect(OrchestratorError.is(error)).toBe(true);
    expect((error as OrchestratorError).code).toBe('TAILSCALE_UNAVAILABLE');
    expect((error as OrchestratorError).retryable).toBe(false);
  });

  it('still marks a timeout retryable, because a retry can help', async () => {
    const timedOut = Object.assign(new Error('timed out'), { killed: true });
    const client = new TailscaleClient(runnerThatThrows(timedOut));

    const error = await client.status().catch((caught: unknown) => caught);

    expect((error as OrchestratorError).retryable).toBe(true);
  });
});
