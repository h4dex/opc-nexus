import type { AppMemorySnapshot } from '../../shared/types.js';

const KIB = 1024;

export interface RawAppProcessMetric {
  pid: number;
  type: string;
  name?: string;
  serviceName?: string;
  memory: {
    privateBytes?: number;
    workingSetSize: number;
    peakWorkingSetSize: number;
  };
}

export interface RawHeapUsage {
  heapUsed: number;
  heapTotal: number;
  external: number;
}

function kibToBytes(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.round((value ?? 0) * KIB) : 0;
}

export function summarizeAppMemory(
  metrics: RawAppProcessMetric[],
  heap: RawHeapUsage,
  timestamp = Date.now()
): AppMemorySnapshot {
  const basis = metrics.length > 0 && metrics.every((metric) => Number.isFinite(metric.memory.privateBytes))
    ? 'private'
    : 'working-set';
  const processes = metrics.map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    name: metric.name || metric.serviceName || null,
    memoryBytes: kibToBytes(basis === 'private' ? metric.memory.privateBytes : metric.memory.workingSetSize),
    workingSetBytes: kibToBytes(metric.memory.workingSetSize),
    peakWorkingSetBytes: kibToBytes(metric.memory.peakWorkingSetSize)
  })).sort((left, right) => right.memoryBytes - left.memoryBytes);

  return {
    timestamp,
    basis,
    totalBytes: processes.reduce((sum, metric) => sum + metric.memoryBytes, 0),
    mainHeapUsedBytes: heap.heapUsed,
    mainHeapTotalBytes: heap.heapTotal,
    mainExternalBytes: heap.external,
    processes
  };
}
