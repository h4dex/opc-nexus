import type { WeixinLoginState } from '../src/shared/types.js';
import { createWeixinLoginPollingController } from '../src/renderer/src/utils/weixinLoginPolling.js';

function state(phase: WeixinLoginState['phase'], updatedAt = Date.now()): WeixinLoginState {
  return { phase, qrDataUrl: null, message: phase, updatedAt };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('Weixin login polling controller', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('waits for an in-flight IPC read before scheduling the next poll', async () => {
    const first = deferred<WeixinLoginState>();
    const readState = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(state('WAITING_SCAN', 2));
    const controller = createWeixinLoginPollingController({
      readState,
      onState: vi.fn(),
      onConnected: vi.fn()
    });

    controller.start();
    controller.start();
    expect(readState).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(readState).toHaveBeenCalledTimes(1);

    first.resolve(state('WAITING_SCAN', 1));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(700);
    expect(readState).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('schedules one auto-close and stops polling after CONNECTED', async () => {
    const onConnected = vi.fn();
    const controller = createWeixinLoginPollingController({
      readState: vi.fn().mockResolvedValue(state('WAITING_SCAN')),
      onState: vi.fn(),
      onConnected
    });

    controller.start();
    await Promise.resolve();
    controller.accept(state('CONNECTED', 2));
    controller.accept(state('CONNECTED', 3));
    expect(onConnected).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(900);
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops an in-flight result and all callbacks after dispose', async () => {
    const pending = deferred<WeixinLoginState>();
    const onState = vi.fn();
    const onConnected = vi.fn();
    const controller = createWeixinLoginPollingController({
      readState: () => pending.promise,
      onState,
      onConnected
    });

    controller.start();
    controller.dispose();
    pending.resolve(state('CONNECTED'));
    await Promise.resolve();
    await vi.runAllTimersAsync();

    expect(onState).not.toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not let an older poll overwrite a newer action response', async () => {
    const pending = deferred<WeixinLoginState>();
    const onState = vi.fn();
    const controller = createWeixinLoginPollingController({
      readState: () => pending.promise,
      onState,
      onConnected: vi.fn()
    });

    controller.start();
    controller.accept(state('WAITING_SCAN', 2));
    pending.resolve(state('IDLE', 1));
    await Promise.resolve();

    expect(onState).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'WAITING_SCAN' }));
    controller.dispose();
  });

  it('cancels a queued auto-close when disposed', async () => {
    const onConnected = vi.fn();
    const controller = createWeixinLoginPollingController({
      readState: vi.fn().mockResolvedValue(state('CONNECTED')),
      onState: vi.fn(),
      onConnected
    });

    controller.start();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);
    controller.dispose();
    await vi.runAllTimersAsync();
    expect(onConnected).not.toHaveBeenCalled();
  });
});
