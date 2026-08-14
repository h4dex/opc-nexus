import { describe, expect, it } from 'vitest';
import type { ResourceSample, ServiceHealth } from '../src/shared/types.js';
import { appendResourceUpdate, MAX_RESOURCE_HISTORY, mergeResourceHistory } from '../src/renderer/src/utils/resourceHistory.js';

const health: ServiceHealth = { runtime: 'healthy', gateway: 'healthy', database: 'healthy' };

function sample(timestamp: number): ResourceSample {
  return {
    timestamp,
    cpu: timestamp,
    cpuCores: 8,
    memoryUsed: 1,
    memoryTotal: 2,
    memoryPercent: 50,
    gpu: null,
    diskFree: 1,
    diskTotal: 2,
    networkOnline: true
  };
}

describe('renderer resource history', () => {
  it('keeps only the newest 300 incremental samples', () => {
    let state = { history: [] as ResourceSample[], health };
    for (let timestamp = 1; timestamp <= MAX_RESOURCE_HISTORY + 25; timestamp++) {
      state = appendResourceUpdate(state, { sample: sample(timestamp), health });
    }

    expect(state.history).toHaveLength(MAX_RESOURCE_HISTORY);
    expect(state.history[0].timestamp).toBe(26);
    expect(state.history.at(-1)?.timestamp).toBe(325);
  });

  it('replaces a duplicate timestamp instead of growing the history', () => {
    const state = appendResourceUpdate(
      { history: [sample(1), sample(2)], health },
      { sample: { ...sample(2), cpu: 99 }, health }
    );

    expect(state.history).toHaveLength(2);
    expect(state.history.at(-1)?.cpu).toBe(99);
  });

  it('merges startup history with samples received during initialization', () => {
    const state = mergeResourceHistory(
      { history: [sample(1), sample(2)], health },
      { history: [{ ...sample(2), cpu: 99 }, sample(3)], health: { ...health, gateway: 'degraded' } }
    );

    expect(state.history.map((item) => item.timestamp)).toEqual([1, 2, 3]);
    expect(state.history[1].cpu).toBe(99);
    expect(state.health.gateway).toBe('degraded');
  });
});
