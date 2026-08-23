import { describe, expect, it } from 'vitest';
import { LocalCliDispatchAdapter } from '../src/main/services/kernel/localCliDispatchAdapter.js';
import type { KernelRequest } from '../src/main/services/kernel/types.js';

function request(overrides: Partial<KernelRequest> = {}): KernelRequest {
  return {
    requestId: 'request-local', source: 'desktop', organizationId: 'org-local',
    principalId: 'owner', channelId: null, conversationId: 'conversation-local',
    inputMessageId: 'message-local', message: '总结本周反馈', routingMode: 'direct-worker',
    preferredAgentId: 'agent-codex', projectId: null,
    workers: [
      { agentId: 'agent-codex', name: 'Codex', role: '开发', engineId: 'eng-codex', capabilities: ['code'] },
      { agentId: 'agent-pi', name: 'Pi', role: '研究', engineId: 'eng-pi', capabilities: [] }
    ],
    memories: [], ...overrides
  };
}

describe('LocalCliDispatchAdapter', () => {
  it('dispatches only to the explicitly selected employee', async () => {
    const plan = await new LocalCliDispatchAdapter().plan(request());
    expect(plan).toMatchObject({ workerAgentId: 'agent-codex', requiresHumanApproval: false });
    expect(plan.rationale).toContain('不参与规划或选人');
  });

  it('does not become an implicit fallback selector', async () => {
    const adapter = new LocalCliDispatchAdapter();
    await expect(adapter.plan(request({ routingMode: 'legacy' as never }))).rejects.toThrow('direct-worker');
    await expect(adapter.plan(request({ preferredAgentId: null }))).rejects.toThrow('explicitly selected');
  });

  it('keeps destructive direct commands behind host approval', async () => {
    const plan = await new LocalCliDispatchAdapter().plan(request({ message: '删除全部发布记录' }));
    expect(plan.requiresHumanApproval).toBe(true);
  });
});
