const MESSAGE_KEY_PREFIX = 'voice-confirm:';

type AttemptIdFactory = () => string;

function createAttemptId(): string {
  return globalThis.crypto.randomUUID();
}

/** One confirmation screen owns one stable idempotency key across retries. */
export class VoiceDispatchAttempt {
  readonly messageKey: string;
  private submitting = false;

  constructor(createId: AttemptIdFactory = createAttemptId) {
    const id = createId().trim();
    if (!id || id.length > 64) throw new Error('voice dispatch attempt id is invalid');
    this.messageKey = `${MESSAGE_KEY_PREFIX}${id}`;
  }

  get isSubmitting(): boolean {
    return this.submitting;
  }

  /** Returns null for a duplicate click while the current submission is pending. */
  tryStart(): string | null {
    if (this.submitting) return null;
    this.submitting = true;
    return this.messageKey;
  }

  finish(): void {
    this.submitting = false;
  }
}
