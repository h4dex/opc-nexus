export interface RefreshOperation<T> {
  run: () => Promise<T>;
  accept: (value: T) => void;
  reject?: (error: unknown) => void;
}

export interface RefreshRequestOptions {
  immediate?: boolean;
  /** A changed key invalidates an in-flight result; repeated signals for the same query do not. */
  key?: unknown;
}

interface PendingRefresh<T> {
  generation: number;
  operation: RefreshOperation<T>;
  waiters: Array<() => void>;
}

/** Coalesces noisy refresh signals while keeping async work strictly single-flight. */
export class TrailingRefreshController<T> {
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: PendingRefresh<T> | null = null;
  private generation = 0;
  private inFlight = false;
  private ready = false;
  private hasKey = false;
  private latestKey: unknown;

  constructor(
    private readonly debounceMs = 600,
    private readonly maxWaitMs = 2_000
  ) {}

  request(operation: RefreshOperation<T>, options: RefreshRequestOptions = {}): Promise<void> {
    if (!this.hasKey || !Object.is(this.latestKey, options.key)) {
      this.generation += 1;
      this.latestKey = options.key;
      this.hasKey = true;
    }
    const generation = this.generation;
    const completion = new Promise<void>((resolve) => {
      const waiters = this.pending ? [...this.pending.waiters, resolve] : [resolve];
      this.pending = { generation, operation, waiters };
    });

    if (options.immediate) {
      this.markReady();
    } else {
      this.scheduleTrailingRun();
    }
    return completion;
  }

  /** Cancels queued work and invalidates the active result. The controller remains reusable. */
  cancel(): void {
    this.generation += 1;
    this.clearTimers();
    this.ready = false;
    this.pending?.waiters.forEach((resolve) => resolve());
    this.pending = null;
  }

  private scheduleTrailingRun(): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.markReady(), this.debounceMs);
    if (this.maxWaitTimer === null) {
      this.maxWaitTimer = setTimeout(() => this.markReady(), this.maxWaitMs);
    }
  }

  private markReady(): void {
    this.clearTimers();
    this.ready = true;
    this.drain();
  }

  private drain(): void {
    if (this.inFlight || !this.ready || !this.pending) return;
    const request = this.pending;
    this.pending = null;
    this.ready = false;
    this.clearTimers();
    this.inFlight = true;

    void request.operation.run()
      .then((value) => {
        if (request.generation === this.generation) request.operation.accept(value);
      })
      .catch((error: unknown) => {
        if (request.generation === this.generation) request.operation.reject?.(error);
      })
      .finally(() => {
        this.inFlight = false;
        if (request.generation !== this.generation && this.pending) {
          this.pending.waiters.unshift(...request.waiters);
        } else {
          request.waiters.forEach((resolve) => resolve());
        }
        this.drain();
      });
  }

  private clearTimers(): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer !== null) clearTimeout(this.maxWaitTimer);
    this.debounceTimer = null;
    this.maxWaitTimer = null;
  }
}
