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
  preflightChatMessage(message: string): Promise<unknown>;
  answerDshQuestQuestions(input: Record<string, unknown>): Promise<unknown>;
  approveDshQuestPlan(input: Record<string, unknown>): Promise<unknown>;
  rejectDshQuestPlan(input: Record<string, unknown>): Promise<unknown>;
  dispatchDshQuestPlan(input: Record<string, unknown>): Promise<unknown>;
  ocrRecognize(attachmentRef: Record<string, unknown>): Promise<unknown>;
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

  it('uses the explicit planning preflight channel with UTF-8 transport', async () => {
    const request = '请让产品与研发跨团队制定计划';
    await api.preflightChatMessage(request);

    expect(electron.invoke).toHaveBeenCalledTimes(1);
    const [channel, payload] = electron.invoke.mock.calls[0] as [string, { encoding: string; data: string }];
    expect(channel).toBe('aibox:preflightChatMessage');
    expect(payload.encoding).toBe('utf8-base64');
    expect(Buffer.from(payload.data, 'base64').toString('utf8')).toBe(request);
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

  it('exposes only explicit DSH Quest owner channels and encodes free-text answers', async () => {
    const identity = {
      planningSessionId: 'quest-1', projectId: 'project-1', dshSessionId: 'dsh-root-1',
      principalId: 'principal-1', expectedRevision: 2
    };
    const hash = 'a'.repeat(64);
    await api.answerDshQuestQuestions({
      ...identity, dshQuestionSetId: 'questions-1', dshVersion: 1,
      answers: [{ questionId: 'scope', selectedOptionIds: [], text: '老板补充范围' }]
    });
    await api.approveDshQuestPlan({ ...identity, dshPlanId: 'plan-1', dshVersion: 1, hash });
    await api.rejectDshQuestPlan({ ...identity, dshPlanId: 'plan-1', dshVersion: 1, hash });
    await api.dispatchDshQuestPlan({ ...identity, dshPlanId: 'plan-1', dshVersion: 1, hash });

    expect(electron.invoke.mock.calls.map((call) => call[0])).toEqual([
      'aibox:answerDshQuestQuestions',
      'aibox:approveDshQuestPlan',
      'aibox:rejectDshQuestPlan',
      'aibox:dispatchDshQuestPlan'
    ]);
    const answer = electron.invoke.mock.calls[0]?.[1] as {
      answers: Array<{ text: { encoding: string; data: string } }>;
    };
    expect(answer.answers[0]?.text.encoding).toBe('utf8-base64');
    expect(Buffer.from(answer.answers[0]!.text.data, 'base64').toString('utf8')).toBe('老板补充范围');
  });
});
