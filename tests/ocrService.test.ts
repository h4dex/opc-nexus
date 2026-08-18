import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ size: 3 * 1024 * 1024 })),
  readFileSync: vi.fn((_path: string, encoding?: string) => (
    encoding === 'utf8' ? '你\nA\n' : Buffer.from([1, 2, 3])
  )),
  sharp: vi.fn(() => ({ metadata: vi.fn().mockResolvedValue({ width: 100, height: 40 }) }))
}));

vi.mock('electron', async () => await import('./__mocks__/electron.js'));
vi.mock('node:fs', () => ({
  existsSync: mocks.existsSync,
  mkdirSync: vi.fn(),
  readFileSync: mocks.readFileSync,
  statSync: mocks.statSync,
  writeFileSync: vi.fn()
}));
vi.mock('sharp', () => ({ default: mocks.sharp }));
vi.mock('onnxruntime-node', () => ({
  InferenceSession: { create: mocks.createSession },
  Tensor: class {}
}));

const { MAX_OCR_IMAGE_BYTES, OCR_SESSION_IDLE_MS, OcrService } = await import('../src/main/services/ocrService.js');

interface FakeSession {
  inputNames: string[];
  outputNames: string[];
  run: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

function makeDb(initiallyEnabled = true) {
  let enabled = initiallyEnabled;
  return {
    getSetting: vi.fn((_key: string, fallback: unknown) => enabled ?? fallback),
    setSetting: vi.fn((_key: string, value: unknown) => { enabled = value === true; })
  };
}

function arrangeSessions(): FakeSession[] {
  const sessions: FakeSession[] = [];
  mocks.createSession.mockImplementation(async () => {
    const session: FakeSession = {
      inputNames: ['input'],
      outputNames: ['output'],
      run: vi.fn(),
      release: vi.fn().mockResolvedValue(undefined)
    };
    sessions.push(session);
    return session;
  });
  return sessions;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.existsSync.mockReturnValue(true);
  mocks.readFileSync.mockImplementation((_path: string, encoding?: string) => (
    encoding === 'utf8' ? '你\nA\n' : Buffer.from([1, 2, 3])
  ));
  mocks.sharp.mockImplementation(() => ({ metadata: vi.fn().mockResolvedValue({ width: 100, height: 40 }) }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OcrService session lifecycle', () => {
  it('recognizes trusted attachment bytes without requiring a host path', async () => {
    arrangeSessions();
    const service = new OcrService(makeDb() as never);
    const detect = vi.spyOn(service as any, 'detectText').mockResolvedValue([]);
    const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

    await expect(service.recognizeBytes(image)).resolves.toMatchObject({
      ok: true,
      text: '（未检测到文字）',
      boxes: []
    });
    expect(detect).toHaveBeenCalledWith(expect.anything(), expect.anything(), Buffer.from(image), 100, 40);
    service.dispose();
    await flushPromises();
  });

  it('rejects empty and oversized attachment bytes before loading OCR models', async () => {
    const service = new OcrService(makeDb() as never);

    await expect(service.recognizeBytes(new Uint8Array())).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('大小限制')
    });
    await expect(service.recognizeBytes(new Uint8Array(MAX_OCR_IMAGE_BYTES + 1))).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('大小限制')
    });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('reads model sizes from metadata without loading model buffers', () => {
    const service = new OcrService(makeDb() as never);

    expect(service.getStatus()).toMatchObject({ modelSize: '6.0 MB' });
    expect(mocks.statSync).toHaveBeenCalledTimes(2);
    expect(mocks.readFileSync).not.toHaveBeenCalled();
  });

  it('releases idle sessions, never releases during inference, and reloads on demand', async () => {
    const sessions = arrangeSessions();
    const service = new OcrService(makeDb() as never);
    const detect = vi.spyOn(service as any, 'detectText');
    detect.mockResolvedValueOnce([]);

    await expect(service.recognize('/tmp/image.png')).resolves.toMatchObject({ ok: true });
    expect(mocks.createSession).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(OCR_SESSION_IDLE_MS - 1);
    let finishDetection!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    detect.mockImplementationOnce(() => new Promise((resolve) => {
      markStarted();
      finishDetection = () => resolve([]);
    }));

    const inFlight = service.recognize('/tmp/image.png');
    await started;
    await vi.advanceTimersByTimeAsync(10);
    expect(sessions[0].release).not.toHaveBeenCalled();
    expect(sessions[1].release).not.toHaveBeenCalled();

    finishDetection();
    await expect(inFlight).resolves.toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(OCR_SESSION_IDLE_MS);
    expect(sessions[0].release).toHaveBeenCalledTimes(1);
    expect(sessions[1].release).toHaveBeenCalledTimes(1);
    expect(service.getStatus()).toMatchObject({ enabled: true, ready: false });

    detect.mockResolvedValueOnce([]);
    await expect(service.recognize('/tmp/image.png')).resolves.toMatchObject({ ok: true });
    expect(mocks.createSession).toHaveBeenCalledTimes(4);
    expect(service.getStatus()).toMatchObject({ enabled: true, ready: true });
    expect(vi.getTimerCount()).toBe(1);
    service.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await flushPromises();
    expect(sessions[2].release).toHaveBeenCalledTimes(1);
    expect(sessions[3].release).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent first-use initialization into one session pair', async () => {
    arrangeSessions();
    const service = new OcrService(makeDb() as never);
    let modelsReady = false;
    vi.spyOn(service, 'modelsExist').mockImplementation(() => modelsReady);
    let finishDownload!: () => void;
    const downloadModels = vi.spyOn(service, 'downloadModels').mockImplementation(() => new Promise((resolve) => {
      finishDownload = () => {
        modelsReady = true;
        resolve({ ok: true, message: 'ok' });
      };
    }));

    const first = service.ensureReady();
    const second = service.ensureReady();
    expect(downloadModels).toHaveBeenCalledTimes(1);
    finishDownload();
    await Promise.all([first, second]);

    expect(mocks.createSession).toHaveBeenCalledTimes(2);
    expect(service.getStatus()).toMatchObject({ enabled: true, ready: true });
    service.dispose();
    await flushPromises();
  });

  it('defers disabling cleanup until active inference finishes and blocks new work', async () => {
    const sessions = arrangeSessions();
    const db = makeDb();
    const service = new OcrService(db as never);
    const detect = vi.spyOn(service as any, 'detectText');
    detect.mockResolvedValueOnce([]);
    await service.recognize('/tmp/image.png');

    let finishDetection!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    detect.mockImplementationOnce(() => new Promise((resolve) => {
      markStarted();
      finishDetection = () => resolve([]);
    }));
    const inFlight = service.recognize('/tmp/image.png');
    await started;

    service.setEnabled(false);
    expect(service.getStatus()).toMatchObject({ enabled: false, ready: true });
    expect(sessions[0].release).not.toHaveBeenCalled();
    await expect(service.recognize('/tmp/image.png')).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('未启用')
    });
    expect(detect).toHaveBeenCalledTimes(2);

    finishDetection();
    await expect(inFlight).resolves.toMatchObject({ ok: true });
    await flushPromises();
    expect(sessions[0].release).toHaveBeenCalledTimes(1);
    expect(sessions[1].release).toHaveBeenCalledTimes(1);
    expect(service.getStatus()).toMatchObject({ enabled: false, ready: false });
  });

  it('releases a partially initialized model when the second model fails to load', async () => {
    const firstSession: FakeSession = {
      inputNames: ['input'], outputNames: ['output'], run: vi.fn(),
      release: vi.fn().mockResolvedValue(undefined)
    };
    mocks.createSession
      .mockResolvedValueOnce(firstSession)
      .mockRejectedValueOnce(new Error('recognition model failed'));
    const service = new OcrService(makeDb() as never);

    await expect(service.recognize('/tmp/image.png')).resolves.toMatchObject({
      ok: false,
      error: 'recognition model failed'
    });
    expect(firstSession.release).toHaveBeenCalledTimes(1);
    expect(service.getStatus()).toMatchObject({ enabled: true, ready: false });
  });
});
