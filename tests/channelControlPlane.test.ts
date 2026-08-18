import { describe, expect, it, vi } from 'vitest';
import { ChannelControlPlane } from '../src/main/services/channelControlPlane.js';

function ingress() {
  return {
    organizationId: 'org-1', organizationKey: 'local', principalId: 'principal-1',
    channelId: 'ch-weixin', channelIdentityId: 'identity-1', externalIdentity: 'wx-user-1',
    conversationId: 'conversation-1', conversationKey: 'direct:wx-user-1',
    messageId: 'message-1', messageKey: 'upstream-1', dedupeKey: 'dedupe-1',
    taskId: null, deduplicated: false
  };
}

function plan() {
  return {
    schemaVersion: 1 as const, requestId: 'kernel:message-1', conversationId: 'conversation-1',
    leaderKernel: 'cordis' as const, workerAgentId: 'agent-cordis', workerEngineId: 'eng-deepseek-harness-managed',
    title: '整理反馈', objective: '整理完整反馈并生成报告', rationale: 'Cordis 根会话', priority: 0,
    expectedOutputs: ['报告'], requiresHumanApproval: false, memoryProposals: [], taskScheduleProposals: [],
    advisorAdvice: [], advisorReviews: []
  };
}

function setup(workerRows: Record<string, unknown>[] = [
  {
    id: 'agent-cordis', name: 'Cordis', role: '主 AI', engine_id: 'eng-deepseek-harness-managed',
    capabilities_json: '{}', tags_json: '[]'
  },
  {
    id: 'agent-pi', name: '运营员工', role: '运营', engine_id: 'eng-pi',
    capabilities_json: '{"files":true,"shell":false}', tags_json: '["reporting"]'
  }
], persistedWorker: Record<string, unknown> | null = workerRows[0] ?? null) {
  const workerAll = vi.fn(() => workerRows);
  const workerGet = vi.fn(() => persistedWorker ?? undefined);
  const db = { raw: { prepare: vi.fn(() => ({ all: workerAll, get: workerGet })) }, audit: vi.fn() };
  const router = { plan: vi.fn(async () => plan()) };
  const memory = { recall: vi.fn(() => [{
    id: 'memory-1', kind: 'preference', content: '使用中文', importance: 0.8, scopes: []
  }]) };
  const state = { findPlan: vi.fn(() => null) };
  const task = { id: 'task-1', status: 'RUNNING' };
  const orchestrator = { applyDispatchPlan: vi.fn(() => task) };
  const memoryProposals = { capture: vi.fn() };
  const scheduleProposals = { capture: vi.fn() };
  const service = new ChannelControlPlane(
    db as never, orchestrator as never, router as never, memory as never, state as never,
    memoryProposals as never, scheduleProposals as never
  );
  return { service, db, workerAll, workerGet, router, memory, state, orchestrator, task, memoryProposals, scheduleProposals };
}

describe('ChannelControlPlane', () => {
  it('builds one scoped request, recalls canonical memory and commits through Orchestrator', async () => {
    const { service, db, workerAll, router, memory, orchestrator, task, memoryProposals, scheduleProposals } = setup();
    const result = await service.dispatch({ ingress: ingress(), message: '请整理今天的客户反馈', preferredAgentId: 'agent-pi' });

    expect(result).toBe(task);
    expect(memory.recall).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1', principalId: 'principal-1', channelId: 'ch-weixin',
      conversationId: 'conversation-1', agentId: 'agent-pi', query: '请整理今天的客户反馈'
    }));
    const request = router.plan.mock.calls[0][0];
    expect(request).toMatchObject({
      requestId: 'kernel:message-1', inputMessageId: 'message-1', preferredAgentId: 'agent-pi',
      routingMode: 'cordis',
      memories: [{ id: 'memory-1', content: '使用中文' }]
    });
    expect(request.workers).toEqual([
      { agentId: 'agent-cordis', name: 'Cordis', role: '主 AI', engineId: 'eng-deepseek-harness-managed', capabilities: [] },
      { agentId: 'agent-pi', name: '运营员工', role: '运营', engineId: 'eng-pi', capabilities: ['files', 'tag:reporting'] }
    ]);
    expect(workerAll).toHaveBeenCalledWith('org-1');
    expect(String(db.raw.prepare.mock.calls[0][0])).toContain('a.organization_id = ?');
    expect(orchestrator.applyDispatchPlan).toHaveBeenCalledWith(request, plan(), expect.anything());
    expect(memoryProposals.capture).toHaveBeenCalledWith(request, plan());
    expect(scheduleProposals.capture).toHaveBeenCalledWith(request, plan());
  });

  it('reuses a durable plan after restart instead of calling a kernel again', async () => {
    const context = setup();
    context.state.findPlan.mockReturnValue({ status: 'planned', taskId: null, plan: plan() });
    await context.service.dispatch({ ingress: ingress(), message: '请整理今天的客户反馈', preferredAgentId: 'agent-pi' });
    expect(context.router.plan).not.toHaveBeenCalled();
    expect(context.memory.recall).not.toHaveBeenCalled();
    expect(context.workerGet).toHaveBeenCalledWith('org-1', 'agent-cordis', 'eng-deepseek-harness-managed');
    expect(String(context.db.raw.prepare.mock.calls[0][0])).toContain('a.organization_id = ?');
    expect(context.orchestrator.applyDispatchPlan).toHaveBeenCalledWith(expect.anything(), plan(), expect.anything());
  });

  it('rejects a persisted plan when its worker is outside the organization or no longer healthy', async () => {
    const context = setup([], null);
    context.state.findPlan.mockReturnValue({ status: 'planned', taskId: null, plan: plan() });

    await expect(context.service.dispatch({
      ingress: ingress(), message: 'replay', preferredAgentId: 'agent-pi'
    })).rejects.toThrow('Persisted dispatch worker is no longer eligible');

    expect(context.workerGet).toHaveBeenCalledWith('org-1', 'agent-cordis', 'eng-deepseek-harness-managed');
    expect(context.router.plan).not.toHaveBeenCalled();
    expect(context.orchestrator.applyDispatchPlan).not.toHaveBeenCalled();
  });

  it('single-flights concurrent redelivery and reuses the first durable plan', async () => {
    const context = setup();
    let stored: { status: 'committed'; taskId: string; plan: ReturnType<typeof plan> } | null = null;
    let releasePlan!: () => void;
    const planning = new Promise<void>((resolve) => { releasePlan = resolve; });
    context.state.findPlan.mockImplementation(() => stored);
    context.router.plan.mockImplementation(async () => {
      await planning;
      return plan();
    });
    context.orchestrator.applyDispatchPlan.mockImplementation((_request, dispatchPlan) => {
      stored = { status: 'committed', taskId: context.task.id, plan: dispatchPlan };
      return context.task;
    });

    const input = { ingress: ingress(), message: '请整理今天的客户反馈', preferredAgentId: 'agent-pi' };
    const first = context.service.dispatch(input);
    const replay = context.service.dispatch(input);
    await vi.waitFor(() => expect(context.router.plan).toHaveBeenCalledOnce());
    releasePlan();

    await expect(Promise.all([first, replay])).resolves.toEqual([context.task, context.task]);
    expect(context.router.plan).toHaveBeenCalledOnce();
    expect(context.orchestrator.applyDispatchPlan).toHaveBeenCalledTimes(2);
  });

  it('fails before planning when no healthy worker is eligible', async () => {
    const context = setup([]);
    await expect(context.service.dispatch({ ingress: ingress(), message: '任务', preferredAgentId: 'agent-pi' }))
      .rejects.toThrow('没有已就绪且引擎健康的执行员工');
    expect(context.router.plan).not.toHaveBeenCalled();
    expect(context.memory.recall).not.toHaveBeenCalled();
  });

  it('marks an explicit desktop employee selection as direct-worker without changing channel ownership', async () => {
    const context = setup();
    await context.service.dispatchCanonical({
      source: 'desktop', organizationId: 'org-1', principalId: 'principal-1', channelId: null,
      conversationId: 'conversation-1', inputMessageId: 'message-1', message: '直接询问运营员工',
      preferredAgentId: 'agent-pi'
    });
    expect(context.router.plan.mock.calls[0][0]).toMatchObject({
      routingMode: 'direct-worker', preferredAgentId: 'agent-pi'
    });
  });
});
