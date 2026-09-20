import type { InitialContextProvider, InitialContextRequest, InitialContextSection, ProviderHealth } from '../contracts.js';
import type { SystemStatusService } from '../../services/system/system-status-service.js';

function gibibytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

export class SystemStatusContextProvider implements InitialContextProvider {
  readonly id = 'systemStatus';
  readonly description = 'Local CPU load, RAM, disk, and inexpensive GPU status.';
  readonly priority = 40;
  readonly defaultEnabled = false;

  constructor(private readonly systemStatus: SystemStatusService) {}

  async isAvailable(): Promise<boolean> {
    try {
      await this.systemStatus.get();
      return true;
    } catch {
      return false;
    }
  }

  async getContext(_request: InitialContextRequest): Promise<InitialContextSection> {
    const status = await this.systemStatus.get();
    const gpu = status.gpu === undefined
      ? 'GPU: unavailable or no NVIDIA CLI.'
      : `GPU: ${status.gpu.name}, ${status.gpu.memoryUsedMiB ?? 0}/${status.gpu.memoryTotalMiB} MiB used.`;
    const lines = [
      `${status.hostname}: load ${status.loadAverage.join(' / ')}.`,
      `RAM: ${gibibytes(status.memory.totalBytes - status.memory.freeBytes)} used of ${gibibytes(status.memory.totalBytes)} (${status.memory.usedPercent}%).`,
      `Disk ${status.disk.path}: ${status.disk.usedPercent}% used.`,
      gpu,
    ];
    return {
      providerId: this.id,
      title: 'System Status',
      lines,
      minLines: 1,
      generatedAt: status.capturedAt,
    };
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    try {
      await this.systemStatus.get();
      return { status: 'ok', checkedAt };
    } catch {
      return { status: 'degraded', checkedAt, detail: 'One or more local resource probes failed.' };
    }
  }
}
