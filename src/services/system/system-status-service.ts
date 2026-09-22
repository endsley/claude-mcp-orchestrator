import { execFile as execFileCallback } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { hostname, loadavg, totalmem, freemem } from 'node:os';
import { promisify } from 'node:util';
import type { SystemStatus } from './types.js';

const execFile = promisify(execFileCallback);

interface CacheEntry { value: SystemStatus; expiresAt: number }

/**
 * Parse `nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv,noheader,nounits`.
 *
 * nvidia-smi emits ONE LINE PER GPU. Splitting the whole output on ',' made
 * the third field of a two-GPU box "1234\nNVIDIA RTX A4000", so Number() gave
 * NaN, memory use was silently dropped, and GPU 2+ vanished entirely.
 *
 * Pure and exported so the multi-GPU case can be tested without a GPU.
 */
export function parseGpuCsv(stdout: string): SystemStatus['gpu'] | undefined {
  const lines = stdout.trim().split('\n').map((line) => line.trim()).filter(Boolean);
  const first = lines[0];
  if (first === undefined) return undefined;
  const [name, total, used] = first.split(',').map((item) => item.trim());
  if (!name || !total || !Number.isFinite(Number(total))) return undefined;
  const result: NonNullable<SystemStatus['gpu']> = { name, memoryTotalMiB: Number(total) };
  if (used !== undefined && Number.isFinite(Number(used))) result.memoryUsedMiB = Number(used);
  // The shape reports a single GPU. Say which, rather than let a multi-GPU
  // box look like a single-GPU one - "the GPU machine" is a thing people ask
  // about, and a silent undercount is worse than an awkward name.
  if (lines.length > 1) result.name = `${name} (1 of ${lines.length} GPUs)`;
  return result;
}

export class SystemStatusService {
  private cache: CacheEntry | undefined;

  constructor(private readonly diskPath = '/', private readonly cacheTtlMs = 5_000) {}

  async get(forceRefresh = false): Promise<SystemStatus> {
    if (!forceRefresh && this.cache !== undefined && this.cache.expiresAt > Date.now()) return structuredClone(this.cache.value);
    const [disk, gpu] = await Promise.all([this.disk(), this.gpu()]);
    const total = totalmem();
    const free = freemem();
    const result: SystemStatus = {
      hostname: hostname(),
      loadAverage: loadavg().map((entry) => Number(entry.toFixed(2))),
      memory: { totalBytes: total, freeBytes: free, usedPercent: Number((((total - free) / total) * 100).toFixed(1)) },
      disk,
      capturedAt: new Date().toISOString(),
    };
    if (gpu !== undefined) result.gpu = gpu;
    this.cache = { value: result, expiresAt: Date.now() + this.cacheTtlMs };
    return structuredClone(result);
  }

  private async disk(): Promise<SystemStatus['disk']> {
    const stats = await statfs(this.diskPath);
    const total = Number(stats.blocks) * Number(stats.bsize);
    const available = Number(stats.bavail) * Number(stats.bsize);
    return {
      path: this.diskPath,
      totalBytes: total,
      availableBytes: available,
      usedPercent: total === 0 ? 0 : Number((((total - available) / total) * 100).toFixed(1)),
    };
  }

  private async gpu(): Promise<SystemStatus['gpu'] | undefined> {
    try {
      const { stdout } = await execFile('nvidia-smi', ['--query-gpu=name,memory.total,memory.used', '--format=csv,noheader,nounits'], {
        timeout: 1_500,
        maxBuffer: 8_000,
        encoding: 'utf8',
      });
      return parseGpuCsv(stdout);
    } catch {
      return undefined;
    }
  }
}
