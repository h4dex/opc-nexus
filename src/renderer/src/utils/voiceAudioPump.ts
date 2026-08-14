export const VOICE_AUDIO_BATCH_BYTES = 1_280;
export const VOICE_AUDIO_MAX_BUFFERED_BYTES = 16_000;

type AudioChunkSender = (sessionId: string, chunk: ArrayBuffer) => Promise<void>;

interface VoiceAudioPumpOptions {
  batchBytes?: number;
  maxBufferedBytes?: number;
  onError?: (error: unknown) => void;
}

/**
 * Coalesces tiny AudioWorklet frames while keeping at most one IPC request in
 * flight. When the sender stalls, old queued audio is discarded so capture
 * remains bounded and close to real time.
 */
export class VoiceAudioPump {
  private readonly batchBytes: number;
  private readonly maxBufferedBytes: number;
  private readonly queue: Uint8Array[] = [];
  private bufferedBytes = 0;
  private inFlight = false;
  private disposed = false;

  constructor(
    private readonly sessionId: string,
    private readonly send: AudioChunkSender,
    options: VoiceAudioPumpOptions = {}
  ) {
    this.batchBytes = normalizeEvenBytes(options.batchBytes ?? VOICE_AUDIO_BATCH_BYTES);
    this.maxBufferedBytes = Math.max(
      this.batchBytes,
      normalizeEvenBytes(options.maxBufferedBytes ?? VOICE_AUDIO_MAX_BUFFERED_BYTES)
    );
    this.onError = options.onError;
  }

  private readonly onError?: (error: unknown) => void;

  push(chunk: ArrayBuffer): void {
    if (this.disposed || chunk.byteLength === 0) return;

    const usableBytes = chunk.byteLength - (chunk.byteLength % 2);
    if (usableBytes === 0) return;
    let bytes = new Uint8Array(chunk, 0, usableBytes);
    if (bytes.byteLength > this.maxBufferedBytes) {
      const start = bytes.byteLength - this.maxBufferedBytes;
      bytes = bytes.slice(start);
    }

    while (this.bufferedBytes + bytes.byteLength > this.maxBufferedBytes && this.queue.length > 0) {
      const dropped = this.queue.shift()!;
      this.bufferedBytes -= dropped.byteLength;
    }

    this.queue.push(bytes);
    this.bufferedBytes += bytes.byteLength;
    this.drain();
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    this.bufferedBytes = 0;
  }

  private drain(): void {
    if (this.disposed || this.inFlight || this.bufferedBytes < this.batchBytes) return;

    const batch = this.take(this.batchBytes);
    this.inFlight = true;
    let request: Promise<void>;
    try {
      request = this.send(this.sessionId, batch);
    } catch (error) {
      this.inFlight = false;
      this.onError?.(error);
      return;
    }

    void request
      .catch((error) => this.onError?.(error))
      .finally(() => {
        this.inFlight = false;
        this.drain();
      });
  }

  private take(size: number): ArrayBuffer {
    const output = new Uint8Array(size);
    let offset = 0;

    while (offset < size) {
      const first = this.queue[0];
      const count = Math.min(first.byteLength, size - offset);
      output.set(first.subarray(0, count), offset);
      offset += count;
      this.bufferedBytes -= count;

      if (count === first.byteLength) this.queue.shift();
      else this.queue[0] = first.subarray(count);
    }

    return output.buffer;
  }
}

function normalizeEvenBytes(value: number): number {
  if (!Number.isFinite(value)) return 2;
  return Math.max(2, Math.floor(value / 2) * 2);
}
