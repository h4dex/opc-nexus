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

function kernel(id: 'hermes' | 'nexus', output: DispatchPlanDraft): ControlKernel {
  return { id, isReady: () => true, plan: vi.fn(async () => output) };
}

describe('memory proposal kernel policy', () => {
  it.each([
    ['channel', { operation: 'remember', kind: 'fact', content: 'Channel fact', scope: 'channel', importance: 0.5 }],
    ['project', { operation: 'remember', kind: 'fact', content: 'Project fact', scope: 'project', importance: 0.5 }]
  ] as const)('rejects %s scope before dispatch when its context is absent', async (_name, proposal) => {
    const router = new KernelRouter(kernel('hermes', draft([proposal])), kernel('nexus', draft()));
    const plan = await router.plan(request());

    expect(plan.leaderKernel).toBe('nexus');
    expect(plan.memoryProposals).toEqual([]);
  });

  it('normalizes valid kinds before the plan becomes durable', async () => {
    const router = new KernelRouter(kernel('hermes', draft([{
      operation: 'remember', kind: 'Preference', content: 'Use concise replies',
      scope: 'conversation', importance: 0.8
    }])), kernel('nexus', draft()));

    const plan = await router.plan(request());
    expect(plan.leaderKernel).toBe('hermes');
    expect(plan.memoryProposals[0].kind).toBe('preference');
  });
});
