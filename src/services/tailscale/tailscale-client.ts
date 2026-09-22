import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { orchestratorError } from '../../types/errors.js';
import type { TailscaleStatusRaw } from './types.js';

const execFile = promisify(execFileCallback);

export interface TailscaleCommandRunner {
  run(command: string, args: string[], timeoutMs: number): Promise<string>;
}

export class LocalTailscaleCommandRunner implements TailscaleCommandRunner {
  async run(command: string, args: string[], timeoutMs: number): Promise<string> {
    const result = await execFile(command, args, {
      timeout: timeoutMs,
      maxBuffer: 1_000_000,
      windowsHide: true,
      encoding: 'utf8',
    });
    return result.stdout;
  }
}

/** Isolates the only external Tailscale command behind a small, mockable API. */
export class TailscaleClient {
  constructor(
    private readonly runner: TailscaleCommandRunner = new LocalTailscaleCommandRunner(),
    private readonly executable = 'tailscale',
    private readonly timeoutMs = 2_500,
  ) {}

  async status(): Promise<TailscaleStatusRaw> {
    let stdout: string;
    try {
      stdout = await this.runner.run(this.executable, ['status', '--json'], this.timeoutMs);
    } catch (error) {
      // A timeout or a busy daemon is worth retrying. A missing binary is not:
      // ENOENT will be ENOENT next time too, and advertising it as retryable
      // invites a caller to loop on something that can never succeed.
      const missingBinary = (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
      throw orchestratorError('TAILSCALE_UNAVAILABLE', 'Tailscale status is unavailable.', {
        retryable: !missingBinary,
        cause: error,
      });
    }
    try {
      const parsed: unknown = JSON.parse(stdout);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('status was not an object');
      }
      return parsed as TailscaleStatusRaw;
    } catch (error) {
      throw orchestratorError('TAILSCALE_UNAVAILABLE', 'Tailscale returned malformed status JSON.', {
        retryable: true,
        cause: error,
      });
    }
  }

  async health(): Promise<boolean> {
    try {
      const status = await this.status();
      return typeof status.Self?.HostName === 'string' && status.Self.HostName.length > 0;
    } catch {
      return false;
    }
  }
}
