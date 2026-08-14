import { describe, expect, it } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

const { assertVoiceAudioChunk, MAX_VOICE_AUDIO_CHUNK_BYTES } = await import('../src/main/ipc.js');

describe('voice audio IPC validation', () => {
  it('accepts a bounded 16-bit PCM ArrayBuffer', () => {
    const chunk = new ArrayBuffer(1_280);
    expect(assertVoiceAudioChunk(chunk)).toBe(chunk);
  });

  it('rejects invalid types, odd PCM bytes, and oversized chunks', () => {
    expect(() => assertVoiceAudioChunk(new Uint8Array(8))).toThrow('ArrayBuffer');
    expect(() => assertVoiceAudioChunk(new ArrayBuffer(3))).toThrow('16-bit PCM');
    expect(() => assertVoiceAudioChunk(new ArrayBuffer(MAX_VOICE_AUDIO_CHUNK_BYTES + 2))).toThrow('16-bit PCM');
  });
});
