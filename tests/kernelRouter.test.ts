import { describe, expect, it, vi } from 'vitest';
import { KernelRouter, KernelRoutingError } from '../src/main/services/kernel/kernelRouter.js';
import type {
  ControlKernel,
  DispatchPlanDraft,
  KernelAttemptRecord,
  KernelRequest
} from '../src/main/services/kernel/types.js';

function request(overrides: Partial<KernelRequest> = {}): KernelRequest {
  return {
    requestId: 'request-1',
    source: 'channel',
    organizationId: 'org-default',
    principalId: 'principal-1',
    channelId: 'ch-weixin',
    conversationId: 'conversation-1',
    inputMessageId: 'message-1',
    message: '请整理今天的客户反馈并生成摘要',
    routingMode: 'cordis',
    preferredAgentId: 'agent-cordis',
    projectId: null,
    workers: [
      { agentId: 'agent-cordis', name: 'Cordis', role: '主 AI', engineId: 'eng-deepseek-harness-managed', capabilities: [] },
      { agentId: 'agent-ops', name: '运营员工', role: '运营', engineId: 'eng-codex', capabilities: ['files'] }
    ],
    memories: [],
    ...overrides
  };
}

function draft(overrides: Partial<DispatchPlanDraft> = {}): DispatchPlanDraft {
  return {
    workerAgentId: 'agent-cordis',
    title: '整理客户反馈',
    objective: '整理全部客户反馈并输出结构化摘要',
    rationale: '交给 Cordis 根会话',
    priority: 0,
    expectedOutputs: ['Markdown 摘要'],
    requiresHumanApproval: false,
    memoryProposals: [],
    taskScheduleProposals: [],
    ...overrides
  };
}

function kernel(
  id: 'cordis' | 'local-cli',
  implementation: (input: KernelRequest) => Promise<DispatchPlanDraft>,
  ready = true
): ControlKernel {
  return { id, isReady: () => ready, plan: vi.fn(implementation) };
}

function directAdapter(output: DispatchPlanDraft = draft({ workerAgentId: 'agent-ops' })): ControlKernel {
  return kernel('local-cli', async () => output);
}

describe('KernelRouter', () => {
  it('uses Cordis as the only owner-facing leader', async () => {
    const cordis = kernel('cordis', async () => draft());
    const direct = directAdapter();
    const plan = await new KernelRouter(cordis, direct).plan(request());

    expect(plan).toMatchObject({
      leaderKernel: 'cordis', workerAgentId: 'agent-cordis',
      workerEngineId: 'eng-deepseek-harness-managed'
    });
    expect(cordis.plan).toHaveBeenCalledOnce();
    expect(direct.plan).not.toHaveBeenCalled();
  });

  it('fails closed instead of promoting the direct adapter when Cordis fails', async () => {
    const attempts: KernelAttemptRecord[] = [];
    const cordis = kernel('cordis', async () => { throw new Error('runtime unavailable'); });
    const direct = directAdapter();
    const router = new KernelRouter(cordis, direct, { record: (record) => { attempts.push(record); } });

    await expect(router.plan(request())).rejects.toBeInstanceOf(KernelRoutingError);
    expect(direct.plan).not.toHaveBeenCalled();
    expect(attempts).toEqual([
      expect.objectContaining({ componentId: 'cordis', status: 'failed' })
    ]);
  });

  it('uses Local CLI only for an explicitly marked direct-worker route', async () => {
    const cordis = kernel('cordis', async () => draft());
    const direct = directAdapter();
    const plan = await new KernelRouter(cordis, direct).plan(request({
      routingMode: 'direct-worker', preferredAgentId: 'agent-ops'
    }));

    expect(plan).toMatchObject({ leaderKernel: 'local-cli', workerAgentId: 'agent-ops', workerEngineId: 'eng-codex' });
    expect(direct.plan).toHaveBeenCalledOnce();
    expect(cordis.plan).not.toHaveBeenCalled();
  });

  it('does not fall back when Cordis selects a worker outside the eligible catalog', async () => {
    const direct = directAdapter();
    const router = new KernelRouter(
      kernel('cordis', async () => draft({ workerAgentId: 'unknown-agent' })), direct
    );
    await expect(router.plan(request())).rejects.toBeInstanceOf(KernelRoutingError);
    expect(direct.plan).not.toHaveBeenCalled();
  });

  it('validates and normalizes Cordis task schedule projections', async () => {
    const plan = await new KernelRouter(
      kernel('cordis', async () => draft({
        taskScheduleProposals: [{
          operation: 'create_task_schedule', title: 'Daily report', content: 'Prepare the report',
          cronKind: 'interval', cronValue: '01.50'
        }]
      })),
      directAdapter()
    ).plan(request());
    expect(plan.taskScheduleProposals[0]).toMatchObject({ cronKind: 'interval', cronValue: '1.5' });
  });

  it('fails closed when Cordis proposes an invalid projection', async () => {
    const direct = directAdapter();
    const router = new KernelRouter(
      kernel('cordis', async () => draft({
        taskScheduleProposals: [{
          operation: 'create_task_schedule', title: 'Daily report', content: 'Prepare the report',
          cronKind: 'daily', cronValue: '25:00'
        }]
      })),
      direct
    );
    await expect(router.plan(request())).rejects.toBeInstanceOf(KernelRoutingError);
    expect(direct.plan).not.toHaveBeenCalled();
  });

  it('serializes one conversation while allowing another to proceed', async () => {
    let releaseFirst!: () => void;
    let firstRunning = false;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const calls: string[] = [];
    const cordis = kernel('cordis', async (input) => {
      calls.push(`start:${input.requestId}`);
      if (input.requestId === 'request-1') {
        firstRunning = true;
        await firstGate;
      }
      calls.push(`end:${input.requestId}`);
      return draft();
    });
    const router = new KernelRouter(cordis, directAdapter());

    const first = router.plan(request());
    await vi.waitFor(() => expect(firstRunning).toBe(true));
    const same = router.plan(request({ requestId: 'request-2', inputMessageId: 'message-2' }));
    const other = router.plan(request({ requestId: 'request-3', inputMessageId: 'message-3', conversationId: 'conversation-2' }));
    await other;
    expect(calls).not.toContain('start:request-2');
    expect(calls).toContain('end:request-3');

    releaseFirst();
    await Promise.all([first, same]);
    expect(calls.indexOf('end:request-1')).toBeLessThan(calls.indexOf('start:request-2'));
  });

  it('rejects construction with a legacy Nexus fallback', () => {
    const nexus = { id: 'nexus', isReady: () => true, plan: vi.fn(async () => draft()) } as ControlKernel;
    expect(() => new KernelRouter(kernel('cordis', async () => draft()), nexus))
      .toThrow('explicit Local CLI dispatch adapter');
  });
});
