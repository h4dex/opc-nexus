import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener
  }
}));

await import('../src/preload/index.js');

const api = electron.exposeInMainWorld.mock.calls.find(([key]) => key === 'aibox')?.[1] as {
  dispatchVoiceTask(agentId: string, title: string, messageKey: string): Promise<unknown>;
  ocrRecognize(attachmentRef: Record<string, unknown>): Promise<unknown>;
  [key: string]: unknown;
};

describe('preload voice dispatch boundary', () => {
  beforeEach(() => {
    electron.invoke.mockReset();
    electron.invoke.mockResolvedValue({ id: 'task-voice' });
  });

  it('forwards the confirmation attempt key unchanged across retries', async () => {
    await api.dispatchVoiceTask('agent-voice', '整理会议纪要', 'voice-confirm:attempt-1');
    await api.dispatchVoiceTask('agent-voice', '整理会议纪要', 'voice-confirm:attempt-1');

    expect(electron.invoke).toHaveBeenCalledTimes(2);
    expect(electron.invoke.mock.calls.map((call) => [call[0], call[1], call[3]])).toEqual([
      ['aibox:dispatchVoiceTask', 'agent-voice', 'voice-confirm:attempt-1'],
      ['aibox:dispatchVoiceTask', 'agent-voice', 'voice-confirm:attempt-1']
    ]);
  });

  it('forwards the opaque OCR attachment reference without a host path channel', async () => {
    const attachmentRef = {
      id: `vision-${'a'.repeat(64)}`,
      sha256: 'a'.repeat(64),
      bytes: 8,
      mimeType: 'image/png',
      filename: 'capture.png',
      uri: `aibox-vision://attachment/vision-${'a'.repeat(64)}`
    };
    await api.ocrRecognize(attachmentRef);

    expect(electron.invoke).toHaveBeenCalledWith('aibox:ocrRecognize', attachmentRef);
  });

  it('does not expose retired DSH Quest owner channels', () => {
    for (const method of [
      'answerDshQuestQuestions', 'approveDshQuestPlan',
      'rejectDshQuestPlan', 'dispatchDshQuestPlan',
      'bindProjectRootSession'
    ]) expect(api[method]).toBeUndefined();
    expect(electron.invoke).not.toHaveBeenCalled();
  });
});
