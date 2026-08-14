import type { WeixinLoginState } from '@shared/types';

type TimerHandle = ReturnType<typeof setTimeout>;

interface TimerApi {
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export interface WeixinLoginPollingController {
  start(): void;
  accept(state: WeixinLoginState): void;
  dispose(): void;
}

interface WeixinLoginPollingOptions {
  readState: () => Promise<WeixinLoginState>;
  onState: (state: WeixinLoginState) => void;
  onConnected: () => void;
  pollDelayMs?: number;
  closeDelayMs?: number;
  timers?: TimerApi;
}

const DEFAULT_TIMERS: TimerApi = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle)
};

/** Serial polling and delayed close, with one owner for every modal timer. */
export function createWeixinLoginPollingController({
  readState,
  onState,
  onConnected,
  pollDelayMs = 700,
  closeDelayMs = 900,
  timers = DEFAULT_TIMERS
}: WeixinLoginPollingOptions): WeixinLoginPollingController {
  let disposed = false;
  let started = false;
  let inFlight = false;
  let connected = false;
  let revision = 0;
  let pollTimer: TimerHandle | null = null;
  let closeTimer: TimerHandle | null = null;

  const clearPollTimer = () => {
    if (pollTimer === null) return;
    timers.clearTimeout(pollTimer);
    pollTimer = null;
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearPollTimer();
    if (closeTimer !== null) {
      timers.clearTimeout(closeTimer);
      closeTimer = null;
    }
  };

  const applyState = (state: WeixinLoginState) => {
    if (disposed || connected) return;
    onState(state);
    if (state.phase !== 'CONNECTED') return;
    connected = true;
    clearPollTimer();
    closeTimer = timers.setTimeout(() => {
      closeTimer = null;
      if (disposed) return;
      dispose();
      onConnected();
    }, closeDelayMs);
  };

  const schedulePoll = () => {
    if (disposed || connected || pollTimer !== null) return;
    pollTimer = timers.setTimeout(() => {
      pollTimer = null;
      void poll();
    }, pollDelayMs);
  };

  const poll = async () => {
    if (disposed || connected || inFlight) return;
    inFlight = true;
    const startedAtRevision = revision;
    try {
      const state = await readState();
      if (startedAtRevision === revision) applyState(state);
    } catch {
      // The main process may be restarting; keep the last visible state.
    } finally {
      inFlight = false;
      schedulePoll();
    }
  };

  return {
    start() {
      if (started || disposed) return;
      started = true;
      void poll();
    },
    accept(state) {
      revision++;
      applyState(state);
    },
    dispose
  };
}
