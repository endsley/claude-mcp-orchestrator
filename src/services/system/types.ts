export interface SystemStatus {
  hostname: string;
  loadAverage: number[];
  memory: { totalBytes: number; freeBytes: number; usedPercent: number };
  disk: { path: string; totalBytes: number; availableBytes: number; usedPercent: number };
  gpu?: { name: string; memoryTotalMiB: number; memoryUsedMiB?: number };
  capturedAt: string;
}
