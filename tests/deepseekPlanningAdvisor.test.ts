import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));
vi.mock('../src/main/services/harnessProviderVerification.js', () => ({
  harnessProviderVerificationIsCurrent: () => true
}));

const { DeepSeekPlanningAdvisor } = await import('../src/main/services/kernel/deepseekPlanningAdvisor.js');

function db(status = 'HEALTHY') {
  return {
    raw: { prepare: () => ({ get: () => ({ status }), all: () => [], run: () => ({ changes: 1 }) }) },
    getSetting: (_key: string, fallback: unknown) => fallback
  };
}

function request(message = '请规划并评审一个复杂发布方案') {
  return {
    requestId: 'req-1', source: 'channel' as const, organizationId: 'org-1', principalId: 'principal-1', channelId: 'ch-weixin',
    conversationId: 'conv-1', inputMessageId: 'msg-1', message, preferredAgentId: null, projectId: null,
    workers: [{ agentId: 'agent-1', name: '开发', role: '开发', engineId: 'eng-pi', capabilities: ['code'] }],
    memories: []
  };
}

describe('DeepSeekPlanningAdvisor', () => {
  it('runs a managed, ephemeral ACP planning prompt without host tools', async () => {
    const probe = vi.fn(async (_command, _env, _cwd, _timeout, options) => ({
      ok: true, message: 'ok', initialized: true, sessionCreated: true,
      output: options.prompt.includes('Review this')
        ? '{"accepted":true,"summary":"补充回滚检查"}'
        : '先拆分发布阶段，再验证回滚路径。'
    }));
    const advisor = new DeepSeekPlanningAdvisor(
      db() as never,
      probe as never,
      () => ['node', 'opc-acp-entry.mjs'],
      () => ({ OPENAI_API_KEY: 'secret' }),
      () => 'C:/runtime/deepseek-harness'
    );

    expect(advisor.isReady()).toBe(true);
    expect(advisor.shouldAdvise(request())).toBe(true);
    await expect(advisor.advise(request())).resolves.toMatchObject({ advisorId: 'deepseek-harness' });
    await expect(advisor.review(request(), {
      workerAgentId: 'agent-1', title: '发布', objective: '执行发布', rationale: '匹配', priority: 0,
      expectedOutputs: ['报告'], requiresHumanApproval: true, memoryProposals: [], taskScheduleProposals: []
    })).resolves.toMatchObject({ accepted: true, summary: '补充回滚检查' });

    expect(probe).toHaveBeenCalledWith(
      ['node', 'opc-acp-entry.mjs'],
      { OPENAI_API_KEY: 'secret' },
      'C:/runtime/deepseek-harness',
      45_000,
      expect.objectContaining({ managedHarness: true, maxOutputChars: 8_000 })
    );
  });

  it('does not advise routine short messages', () => {
    const advisor = new DeepSeekPlanningAdvisor(db() as never, vi.fn() as never, () => ['node'], () => ({}), () => '.');
    expect(advisor.shouldAdvise(request('查询今天状态'))).toBe(false);
  });
});
