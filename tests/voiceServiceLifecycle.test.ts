// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

const wsMock = vi.hoisted(() => ({ instances: [] as any[] }));

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');

  class MockWebSocket extends EventEmitter {
    readyState = 0;
    send = vi.fn();
    close = vi.fn(() => {
      this.readyState = 3;
      this.emit('close');
    });

    constructor(readonly url: string) {
      super();
      wsMock.instances.push(this);
    }
  }

  return { WebSocket: MockWebSocket };
});

await import('ws');
const { VoiceService, VoiceSession } = await import('../src/main/services/voiceService.js');

function makeSession(): InstanceType<typeof VoiceSession> {
  return new VoiceSession('voice-test', 'cloud', vi.fn(), vi.fn());
}

function encrypted(value: string): string {
  return Buffer.from(`enc:${value}`).toString('base64');
}

function makeCloudDb() {
  const settings: Record<string, unknown> = {
    'voice:config': { enabled: true, provider: 'cloud', appKey: 'app-key', silenceMs: 800 },
    'secret:voice:accessKeyId': encrypted('access-key-id'),
    'secret:voice:accessKeySecret': encrypted('access-key-secret')
  };
  return {
    audit: vi.fn(),
    getSetting: (key: string, fallback: unknown) => key in settings ? settings[key] : fallback,
    setSetting: (key: string, value: unknown) => { settings[key] = value; }
  } as never;
}

async function waitForSocket(): Promise<any> {
  await vi.dynamicImportSettled();
  expect(wsMock.instances).toHaveLength(1);
  return wsMock.instances[0];
}

beforeEach(() => {
  wsMock.instances.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('VoiceSession cloud connection lifecycle', () => {
  it('closes the WebSocket when the handshake times out', async () => {
    vi.useFakeTimers();
    const connecting = makeSession().connectCloud('wss://nls.example/ws', 'app-key', 'token');
    const failure = connecting.catch((error: unknown) => error);
    const socket = await waitForSocket();

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(failure).resolves.toMatchObject({ message: expect.stringContaining('连接超时') });
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it('closes the WebSocket when the connection emits an error', async () => {
    const connecting = makeSession().connectCloud('wss://nls.example/ws', 'app-key', 'token');
    const failure = connecting.catch((error: unknown) => error);
    const socket = await waitForSocket();

    socket.emit('error', new Error('connection refused'));

    await expect(failure).resolves.toMatchObject({ message: 'connection refused' });
    expect(socket.close).toHaveBeenCalledTimes(1);
  });
});

describe('VoiceService failed session startup', () => {
  it('closes the session when provider startup rejects', async () => {
    vi.spyOn(VoiceSession.prototype, 'connectCloud').mockRejectedValueOnce(new Error('handshake failed'));
    const close = vi.spyOn(VoiceSession.prototype, 'close');
    const service = new VoiceService(makeCloudDb());
    vi.spyOn(service as any, 'fetchNlsToken').mockResolvedValue('token');

    const result = await service.start();

    expect(result).toMatchObject({ ok: false, sessionId: null, provider: 'cloud' });
    expect(result.message).toContain('handshake failed');
    expect(close).toHaveBeenCalledTimes(1);
  });
});
