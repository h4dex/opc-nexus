import { describe, expect, it, vi } from 'vitest';
import { VoiceAudioPump } from '../src/renderer/src/utils/voiceAudioPump.js';

function bytes(...values: number[]): ArrayBuffer {
  return Uint8Array.from(values).buffer;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

describe('VoiceAudioPump', () => {
  it('coalesces small PCM frames into one IPC batch', () => {
    const send = vi.fn(async () => {});
    const pump = new VoiceAudioPump('voice-1', send, { batchBytes: 8, maxBufferedBytes: 16 });

    pump.push(bytes(1, 2, 3, 4));
    expect(send).not.toHaveBeenCalled();

    pump.push(bytes(5, 6, 7, 8));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe('voice-1');
    expect([...new Uint8Array(send.mock.calls[0][1])]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('keeps one request in flight and drops the oldest queued audio when full', async () => {
    const requests: ReturnType<typeof deferred>[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const sent: number[][] = [];
    const send = vi.fn((_sessionId: string, chunk: ArrayBuffer) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      sent.push([...new Uint8Array(chunk)]);
      const request = deferred();
      requests.push(request);
      return request.promise.finally(() => { concurrent--; });
    });
    const pump = new VoiceAudioPump('voice-2', send, { batchBytes: 8, maxBufferedBytes: 16 });

    pump.push(bytes(1, 1, 1, 1, 1, 1, 1, 1));
    pump.push(bytes(2, 2, 2, 2, 2, 2, 2, 2));
    pump.push(bytes(3, 3, 3, 3, 3, 3, 3, 3));
    pump.push(bytes(4, 4, 4, 4, 4, 4, 4, 4));

    expect(send).toHaveBeenCalledTimes(1);
    expect(maxConcurrent).toBe(1);

    requests[0].resolve();
    await flushPromises();
    expect(send).toHaveBeenCalledTimes(2);
    expect(sent[1]).toEqual([3, 3, 3, 3, 3, 3, 3, 3]);
    expect(maxConcurrent).toBe(1);

    requests[1].resolve();
    await flushPromises();
    expect(send).toHaveBeenCalledTimes(3);
    expect(sent[2]).toEqual([4, 4, 4, 4, 4, 4, 4, 4]);
    expect(maxConcurrent).toBe(1);

    requests[2].resolve();
    await flushPromises();
  });

  it('discards queued audio on dispose', async () => {
    const first = deferred();
    const send = vi.fn(() => first.promise);
    const pump = new VoiceAudioPump('voice-3', send, { batchBytes: 8, maxBufferedBytes: 16 });

    pump.push(bytes(1, 1, 1, 1, 1, 1, 1, 1));
    pump.push(bytes(2, 2, 2, 2, 2, 2, 2, 2));
    pump.dispose();
    first.resolve();
    await flushPromises();

    expect(send).toHaveBeenCalledTimes(1);
    pump.push(bytes(3, 3, 3, 3, 3, 3, 3, 3));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reports asynchronous IPC failures without starting parallel sends', async () => {
    const onError = vi.fn();
    const send = vi.fn(async () => { throw new Error('IPC unavailable'); });
    const pump = new VoiceAudioPump('voice-4', send, { batchBytes: 8, maxBufferedBytes: 16, onError });

    pump.push(bytes(1, 2, 3, 4, 5, 6, 7, 8));
    await flushPromises();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({ message: 'IPC unavailable' });
  });
});
