import { describe, expect, it, vi } from 'vitest';
import { KernelRouter } from '../src/main/services/kernel/kernelRouter.js';
import type { ControlKernel, DispatchPlanDraft, KernelRequest, MemoryProposal } from '../src/main/services/kernel/types.js';

function request(overrides: Partial<KernelRequest> = {}): KernelRequest {
  return {
    requestId: 'request-policy',
    source: 'desktop',
    organizationId: 'org-local',
    principalId: 'principal-local',
    channelId: null,
    conversationId: 'conversation-local',
    inputMessageId: 'message-local',
    message: 'Do the task',
    preferredAgentId: 'agent-1',
    projectId: null,
    workers: [{ agentId: 'agent-1', name: 'Worker', role: 'worker', engineId: 'engine-1', capabilities: [] }],
    memories: [],
    ...overrides
  };
}

function draft(memoryProposals: MemoryProposal[] = []): DispatchPlanDraft {
  return {
    workerAgentId: 'agent-1',
    title: 'Task',
    objective: 'Complete the task',
    rationale: 'Worker match',
    priority: 0,
    expectedOutputs: ['result'],
    requiresHumanApproval: false,
    memoryProposals,
    taskScheduleProposals: []
  };
}

function kernel(id: 'cordis' | 'local-cli', output: DispatchPlanDraft): ControlKernel {
  return { id, isReady: () => true, plan: vi.fn(async () => output) };
}

describe('memory proposal kernel policy', () => {
  it.each([
    ['channel', { operation: 'remember', kind: 'fact', content: 'Channel fact', scope: 'channel', importance: 0.5 }],
    ['project', { operation: 'remember', kind: 'fact', content: 'Project fact', scope: 'project', importance: 0.5 }]
  ] as const)('rejects %s scope before dispatch when its context is absent', async (_name, proposal) => {
    const direct = kernel('local-cli', draft());
    const router = new KernelRouter(kernel('cordis', draft([proposal])), direct);
    await expect(router.plan(request())).rejects.toThrow();
    expect(direct.plan).not.toHaveBeenCalled();
  });

  it('normalizes valid kinds before the plan becomes durable', async () => {
    const router = new KernelRouter(kernel('cordis', draft([{
      operation: 'remember', kind: 'Preference', content: 'Use concise replies',
      scope: 'conversation', importance: 0.8
    }])), kernel('local-cli', draft()));

    const plan = await router.plan(request());
    expect(plan.leaderKernel).toBe('cordis');
    expect(plan.memoryProposals[0].kind).toBe('preference');
  });
});
