import { describe, expect, it } from 'vitest';
import { summarizeAppMemory } from '../src/main/services/appMemory.js';

describe('application memory summary', () => {
  it('uses private bytes consistently when every Electron process reports it', () => {
    const result = summarizeAppMemory([
      { pid: 1, type: 'Browser', memory: { privateBytes: 100, workingSetSize: 140, peakWorkingSetSize: 160 } },
      { pid: 2, type: 'GPU', name: 'GPU', memory: { privateBytes: 200, workingSetSize: 250, peakWorkingSetSize: 270 } }
    ], { heapUsed: 10, heapTotal: 20, external: 3 }, 123);

    expect(result.basis).toBe('private');
    expect(result.totalBytes).toBe(300 * 1024);
    expect(result.processes.map((item) => item.pid)).toEqual([2, 1]);
    expect(result.mainHeapUsedBytes).toBe(10);
    expect(result.timestamp).toBe(123);
  });

  it('falls back to working sets for every process when private bytes are unavailable', () => {
    const result = summarizeAppMemory([
      { pid: 1, type: 'Browser', memory: { privateBytes: 100, workingSetSize: 140, peakWorkingSetSize: 160 } },
      { pid: 2, type: 'Tab', memory: { workingSetSize: 60, peakWorkingSetSize: 80 } }
    ], { heapUsed: 0, heapTotal: 0, external: 0 });

    expect(result.basis).toBe('working-set');
    expect(result.totalBytes).toBe(200 * 1024);
  });
});
