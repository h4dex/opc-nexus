import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrailingRefreshController } from '../src/renderer/src/utils/trailingRefresh.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('TrailingRefreshController', () => {
  it('coalesces noisy signals with trailing debounce and a bounded max wait', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => 'latest');
    const accept = vi.fn();
    const refresh = new TrailingRefreshController<string>(600, 2_000);

    for (let elapsed = 0; elapsed < 2_000; elapsed += 400) {
      void refresh.request({ run, accept });
      await vi.advanceTimersByTimeAsync(400);
    }

    expect(run).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledOnce();
  });

  it('never overlaps requests and ignores a superseded result', async () => {
    vi.useFakeTimers();
    let finishFirst!: (value: string) => void;
    let active = 0;
    let peak = 0;
    const first = new Promise<string>((resolve) => { finishFirst = resolve; });
    const run = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      const value = run.mock.calls.length === 1 ? await first : 'new';
      active -= 1;
      return value;
    });
    const accepted: string[] = [];
    const refresh = new TrailingRefreshController<string>(100, 500);

    void refresh.request({ run, accept: (value) => accepted.push(value) }, { immediate: true, key: 'old-filter' });
    void refresh.request({ run, accept: (value) => accepted.push(value) }, { immediate: true, key: 'new-filter' });
    expect(run).toHaveBeenCalledTimes(1);

    finishFirst('old');
    await vi.advanceTimersByTimeAsync(0);

    expect(run).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
    expect(accepted).toEqual(['new']);
  });

  it('accepts a slow result for the same query while queuing one follow-up', async () => {
    let finishFirst!: (value: string) => void;
    const first = new Promise<string>((resolve) => { finishFirst = resolve; });
    const run = vi.fn(() => run.mock.calls.length === 1 ? first : Promise.resolve('follow-up'));
    const accepted: string[] = [];
    const refresh = new TrailingRefreshController<string>();

    void refresh.request({ run, accept: (value) => accepted.push(value) }, { immediate: true, key: 'same-query' });
    const followUp = refresh.request({ run, accept: (value) => accepted.push(value) }, { immediate: true, key: 'same-query' });
    finishFirst('slow');
    await followUp;

    expect(run).toHaveBeenCalledTimes(2);
    expect(accepted).toEqual(['slow', 'follow-up']);
  });

  it('invalidates an active result when cancelled', async () => {
    let finish!: (value: string) => void;
    const result = new Promise<string>((resolve) => { finish = resolve; });
    const accept = vi.fn();
    const refresh = new TrailingRefreshController<string>();

    void refresh.request({ run: () => result, accept }, { immediate: true });
    refresh.cancel();
    finish('stale');
    await result;
    await Promise.resolve();

    expect(accept).not.toHaveBeenCalled();
  });
});
