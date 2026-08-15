import { describe, expect, it } from 'vitest';
import { VoiceDispatchAttempt } from '../src/renderer/src/utils/voiceDispatchAttempt.js';

describe('VoiceDispatchAttempt', () => {
  it('keeps one message key and rejects a concurrent duplicate submission', () => {
    const attempt = new VoiceDispatchAttempt(() => 'attempt-1');

    expect(attempt.messageKey).toBe('voice-confirm:attempt-1');
    expect(attempt.tryStart()).toBe('voice-confirm:attempt-1');
    expect(attempt.isSubmitting).toBe(true);
    expect(attempt.tryStart()).toBeNull();
  });

  it('reuses the same key for a retry after the pending submission settles', () => {
    const attempt = new VoiceDispatchAttempt(() => 'attempt-retry');

    expect(attempt.tryStart()).toBe('voice-confirm:attempt-retry');
    attempt.finish();
    expect(attempt.isSubmitting).toBe(false);
    expect(attempt.tryStart()).toBe('voice-confirm:attempt-retry');
  });

  it('gives a new confirmation attempt a different key', () => {
    const ids = ['attempt-1', 'attempt-2'];
    const createId = () => ids.shift() ?? '';

    expect(new VoiceDispatchAttempt(createId).messageKey).toBe('voice-confirm:attempt-1');
    expect(new VoiceDispatchAttempt(createId).messageKey).toBe('voice-confirm:attempt-2');
  });
});
