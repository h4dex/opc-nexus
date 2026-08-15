import { describe, expect, it, vi } from 'vitest';
import { KernelRouter, KernelRoutingError, defaultShouldUsePlanningAdvisor } from '../src/main/services/kernel/kernelRouter.js';
import type {
  ControlKernel,
  DispatchPlanDraft,
  KernelAttemptRecord,
  KernelRequest,
  PlanningAdvisor
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
    preferredAgentId: 'agent-ops',
    projectId: null,
    workers: [
      { agentId: 'agent-ops', name: '运营员工', role: '运营', engineId: 'eng-codex', capabilities: ['files'] },
      { agentId: 'agent-dev', name: '开发员工', role: '开发', engineId: 'eng-pi', capabilities: ['code'] }
    ],
    memories: [],
    ...overrides
  };
}

function draft(overrides: Partial<DispatchPlanDraft> = {}): DispatchPlanDraft {
  return {
    workerAgentId: 'agent-ops',
    title: '整理客户反馈',
    objective: '整理全部客户反馈并输出结构化摘要',
    rationale: '运营员工与该任务的职责匹配',
    priority: 0,
    expectedOutputs: ['Markdown 摘要'],
    requiresHumanApproval: false,
    memoryProposals: [],
    taskScheduleProposals: [],
    ...overrides
  };
}

function kernel(id: 'hermes' | 'nexus', implementation: () => Promise<DispatchPlanDraft>, ready = true): ControlKernel {
  return { id, isReady: () => ready, plan: vi.fn(implementation) };
}

describe('KernelRouter', () => {
  it('uses Hermes as the only leader when its plan is valid', async () => {
    const hermes = kernel('hermes', async () => draft());
    const nexus = kernel('nexus', async () => draft({ workerAgentId: 'agent-dev' }));
    const plan = await new KernelRouter(hermes, nexus).plan(request());

    expect(plan).toMatchObject({ leaderKernel: 'hermes', workerAgentId: 'agent-ops', workerEngineId: 'eng-codex' });
    expect(hermes.plan).toHaveBeenCalledOnce();
    expect(nexus.plan).not.toHaveBeenCalled();
  });

  it('records the failed Hermes attempt before Nexus takes leadership', async () => {
    const attempts: KernelAttemptRecord[] = [];
    const hermes = kernel('hermes', async () => { throw new Error('HTTP 401'); });
    const nexus = kernel('nexus', async () => draft({ workerAgentId: 'agent-dev' }));
    const plan = await new KernelRouter(hermes, nexus, [], { record: (record) => { attempts.push(record); } }).plan(request());

    expect(plan.leaderKernel).toBe('nexus');
    expect(attempts.map((attempt) => [attempt.componentId, attempt.status])).toEqual([
      ['hermes', 'failed'],
      ['nexus', 'succeeded']
    ]);
  });

  it('keeps DSH from dispatching while escalating a rejected review to human approval', async () => {
    const advisor: PlanningAdvisor = {
      id: 'deepseek-harness',
      isReady: () => true,
      shouldAdvise: () => true,
      advise: vi.fn(async () => ({ advisorId: 'deepseek-harness', summary: '先分组，再汇总' })),
      review: vi.fn(async () => ({ advisorId: 'deepseek-harness', accepted: false, summary: '建议补充风险表' }))
    };
    const hermes = kernel('hermes', async () => draft());
    const nexus = kernel('nexus', async () => draft({ workerAgentId: 'agent-dev' }));
    const plan = await new KernelRouter(hermes, nexus, [advisor]).plan(request());

    expect(plan.leaderKernel).toBe('hermes');
    expect(plan.advisorAdvice[0].advisorId).toBe('deepseek-harness');
    expect(plan.advisorReviews[0]).toMatchObject({ advisorId: 'deepseek-harness', accepted: false });
    expect(plan.requiresHumanApproval).toBe(true);
    expect(nexus.plan).not.toHaveBeenCalled();
  });

  it('fails review closed to human approval when DSH is unavailable', async () => {
    const advisor: PlanningAdvisor = {
      id: 'deepseek-harness', isReady: () => true, shouldAdvise: () => true,
      advise: vi.fn(async () => ({ advisorId: 'deepseek-harness', summary: '先规划' })),
      review: vi.fn(async () => { throw new Error('review timeout'); })
    };
    const plan = await new KernelRouter(
      kernel('hermes', async () => draft()), kernel('nexus', async () => draft()), [advisor]
    ).plan(request());

    expect(plan.requiresHumanApproval).toBe(true);
    expect(plan.advisorReviews).toEqual([expect.objectContaining({
      advisorId: 'deepseek-harness', accepted: false, summary: expect.stringContaining('review timeout')
    })]);
  });

  it('fails review closed when an advisor becomes unready after giving advice', async () => {
    const attempts: KernelAttemptRecord[] = [];
    const ready = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const advisor: PlanningAdvisor = {
      id: 'deepseek-harness', isReady: ready, shouldAdvise: () => true,
      advise: vi.fn(async () => ({ advisorId: 'deepseek-harness', summary: '先规划' })),
      review: vi.fn(async () => ({ advisorId: 'deepseek-harness', accepted: true, summary: 'ok' }))
    };
    const plan = await new KernelRouter(
      kernel('hermes', async () => draft()),
      kernel('nexus', async () => draft()),
      [advisor],
      { record: (record) => { attempts.push(record); } }
    ).plan(request());

    expect(advisor.review).not.toHaveBeenCalled();
    expect(plan.requiresHumanApproval).toBe(true);
    expect(plan.advisorReviews).toEqual([expect.objectContaining({
      advisorId: 'deepseek-harness', accepted: false,
      summary: expect.stringContaining('变为不可用')
    })]);
    expect(attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ componentId: 'deepseek-harness', role: 'reviewer', status: 'skipped' })
    ]));
  });

  it('falls back when Hermes selects a worker outside the eligible catalog', async () => {
    const hermes = kernel('hermes', async () => draft({ workerAgentId: 'unknown-agent' }));
    const nexus = kernel('nexus', async () => draft());
    const plan = await new KernelRouter(hermes, nexus).plan(request());
    expect(plan.leaderKernel).toBe('nexus');
  });

  it('validates and normalizes task schedule suggestions', async () => {
    const hermes = kernel('hermes', async () => draft({
      taskScheduleProposals: [{
        operation: 'create_task_schedule', title: 'Daily report', content: 'Prepare the report',
        cronKind: 'interval', cronValue: '01.50'
      }]
    }));
    const plan = await new KernelRouter(hermes, kernel('nexus', async () => draft())).plan(request());
    expect(plan.taskScheduleProposals[0]).toMatchObject({ cronKind: 'interval', cronValue: '1.5' });
  });

  it('falls back when Hermes proposes an invalid task schedule', async () => {
    const hermes = kernel('hermes', async () => draft({
      taskScheduleProposals: [{
        operation: 'create_task_schedule', title: 'Daily report', content: 'Prepare the report',
        cronKind: 'daily', cronValue: '25:00'
      }]
    }));
    const plan = await new KernelRouter(hermes, kernel('nexus', async () => draft())).plan(request());
    expect(plan).toMatchObject({ leaderKernel: 'nexus', taskScheduleProposals: [] });
  });

  it('serializes leaders for one conversation while allowing other conversations to proceed', async () => {
    let releaseFirst!: () => void;
    let firstRunning = false;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const calls: string[] = [];
    const hermes: ControlKernel = {
      id: 'hermes',
      isReady: () => true,
      plan: vi.fn(async (input) => {
        calls.push(`start:${input.requestId}`);
        if (input.requestId === 'request-1') {
          firstRunning = true;
          await firstGate;
        }
        calls.push(`end:${input.requestId}`);
        return draft();
      })
    };
    const router = new KernelRouter(hermes, kernel('nexus', async () => draft()));

    const first = router.plan(request());
    await vi.waitFor(() => expect(firstRunning).toBe(true));
    const sameConversation = router.plan(request({ requestId: 'request-2', inputMessageId: 'message-2' }));
    const otherConversation = router.plan(request({ requestId: 'request-3', inputMessageId: 'message-3', conversationId: 'conversation-2' }));
    await otherConversation;
    expect(calls).not.toContain('start:request-2');
    expect(calls).toContain('end:request-3');

    releaseFirst();
    await Promise.all([first, sameConversation]);
    expect(calls.indexOf('end:request-1')).toBeLessThan(calls.indexOf('start:request-2'));
  });

  it('fails closed when neither control kernel produces a valid plan', async () => {
    const router = new KernelRouter(
      kernel('hermes', async () => { throw new Error('offline'); }),
      kernel('nexus', async () => draft({ priority: 99 }))
    );
    await expect(router.plan(request())).rejects.toBeInstanceOf(KernelRoutingError);
  });
});

describe('defaultShouldUsePlanningAdvisor', () => {
  it('uses DSH for complex tasks but not short routine messages', () => {
    expect(defaultShouldUsePlanningAdvisor(request())).toBe(false);
    expect(defaultShouldUsePlanningAdvisor(request({ message: '请规划并评审一个多阶段发布方案' }))).toBe(true);
  });
});
