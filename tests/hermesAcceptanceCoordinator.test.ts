import { describe, expect, it, vi } from 'vitest';
import { HermesAcceptanceCoordinator, type HermesAcceptanceReviewer } from '../src/main/services/hermesAcceptanceCoordinator.js';

const waitForCoordinator = () => new Promise<void>((resolve) => setTimeout(resolve, 1_650));

interface FixtureOptions {
  employeeId?: string | null;
  validation?: Array<{ id: string; agent_id: string; content: string; status: string }>;
  runtimeState?: string;
  runtimeUrl?: string;
  reviewers?: HermesAcceptanceReviewer[];
  failedTask?: { id: string; project_id: string; conversation_id: string; agent_id: string; title: string; status: string; content: string; error?: string };
}

function fixture(options: FixtureOptions = {}) {
  const planTasks = [
    { task_id: 'task-a', agent_id: 'agent-a', status: 'COMPLETED' },
    { task_id: 'task-b', agent_id: 'agent-b', status: 'COMPLETED' }
  ];
  const validation = options.validation ?? [];
  let statusFollowupQueued = false;
  let failureFollowupQueued = false;
  const prepare = vi.fn((sql: string) => ({
    get: vi.fn((...args: unknown[]) => {
      if (sql.includes("content LIKE 'Task intent: validation%'") && validation[0]) {
        return { ...validation[0], project_id: 'project-1', conversation_id: 'conversation-root' };
      }
      // The real draft remains PROJECTED; only the governance projection is
      // APPROVED/DISPATCHED. Keep this fixture from accepting the old filter.
      if (sql.includes("d.status IN ('APPROVED', 'DISPATCHED')")) return undefined;
      if (sql.includes('SELECT d.draft_id')) {
        if (args[0] === 'task-review') return undefined;
        return { draft_id: 'draft-1', conversation_id: 'conversation-root', principal_id: 'owner-1', employee_id: options.employeeId ?? null };
      }
      if (sql.includes('SELECT project_id FROM tasks')) return { project_id: 'project-1' };
      if (sql.includes('SELECT project_id FROM hermes_plan_drafts')) return { project_id: 'project-1' };
      if (sql.includes('SELECT id FROM hermes_chat_queue')) {
        return statusFollowupQueued && String(args[2] ?? '').includes('AUTO-VALIDATION-STATUS')
          ? { id: 'hermes-chat-validation-status-1' }
          : failureFollowupQueued && String(args[2] ?? '').includes('AUTO-FOLLOWUP')
            ? { id: 'hermes-chat-followup-1' }
            : undefined;
      }
      if (sql.includes('SELECT id, project_id, conversation_id, agent_id, title, status, content, result, error')) {
        return options.failedTask;
      }
      void args;
      return undefined;
    }),
    all: vi.fn((...args: unknown[]) => {
      if (sql.includes('SELECT DISTINCT d.draft_id')) {
        return [{ draft_id: 'draft-1', conversation_id: 'conversation-root', principal_id: 'owner-1' }];
      }
      if (sql.includes("WHERE t.status = 'COMPLETED'")) return planTasks;
      if (sql.includes('SELECT j.task_id, t.agent_id, t.status')) return planTasks;
      if (sql.includes('content LIKE \'Task intent: validation%\'')) return validation;
      if (sql.includes("event_type = 'artifact_runtime'")) {
        return options.runtimeUrl
          ? [{ task_id: 'task-b', payload: JSON.stringify({ runtime: { state: 'RUNNING', url: options.runtimeUrl } }) }]
          : [];
      }
      void args;
      return [];
    })
  }));
  const db = { raw: { prepare }, audit: vi.fn() };
  const enqueueProjectTurn = vi.fn((_projectId: string, input: { title?: string }) => {
    if (input.title === '主秘书读取独立验收结果') statusFollowupQueued = true;
    if (input.title === '主秘书追问失败员工') failureFollowupQueued = true;
    return {
      id: input.title === '主秘书读取独立验收结果'
        ? 'hermes-chat-validation-status-1'
        : input.title === '主秘书追问失败员工'
          ? 'hermes-chat-followup-1'
          : 'hermes-chat-validation-1'
    };
  });
  const runtime = {
    getStatus: vi.fn(() => ({ state: options.runtimeState ?? 'healthy' })),
    enqueueProjectTurn
  };
  return {
    db,
    runtime,
    enqueueProjectTurn,
    coordinator: new HermesAcceptanceCoordinator(
      db as never,
      runtime,
      () => options.reviewers ?? [{ id: 'agent-reviewer', name: '验收校对员', role: '独立验收' }]
    )
  };
}

describe('HermesAcceptanceCoordinator', () => {
  it('automatically asks the primary secretary to validate completed plan work', async () => {
    const f = fixture({ runtimeUrl: 'http://127.0.0.1:43123/' });
    f.coordinator.onTaskFinished({ taskId: 'task-b', agentId: 'agent-b', status: 'COMPLETED' });
    await waitForCoordinator();

    expect(f.enqueueProjectTurn).toHaveBeenCalledOnce();
    const input = f.enqueueProjectTurn.mock.calls[0]?.[1];
    expect(input).toMatchObject({
      conversationId: 'conversation-root',
      principalId: 'owner-1',
      title: '主秘书独立验收'
    });
    expect(input?.message).toContain('[OPC-NEXUS-AUTO-VALIDATION] plan=draft-1');
    expect(input?.message).toContain('task-a, task-b');
    expect(input?.message).toContain('intent 必须为 validation');
    expect(input?.message).toContain('验收校对员 (agent-reviewer)');
    expect(input?.message).toContain('http_request');
    expect(input?.message).toContain('browser_navigate');
    expect(input?.message).toContain('browser_get_content');
    expect(input?.message).toContain('任一工具不可用或检查失败都必须返回 BLOCKED');
    expect(f.db.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'hermes.acceptance.auto-request',
      result: 'draft-1:queue=hermes-chat-validation-1'
    }));
    const planQuery = f.db.raw.prepare.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes('SELECT d.draft_id'));
    expect(planQuery).toContain('hermes_plan_projections');
    expect(planQuery).not.toContain("d.status IN ('APPROVED', 'DISPATCHED')");
    expect(f.db.raw.prepare.mock.calls.some(([sql]) => sql.includes('SELECT project_id FROM tasks'))).toBe(true);
  });

  it('deduplicates repeated completion events for the same plan', async () => {
    const f = fixture();
    f.coordinator.onTaskFinished({ taskId: 'task-a', agentId: 'agent-a', status: 'COMPLETED' });
    f.coordinator.onTaskFinished({ taskId: 'task-b', agentId: 'agent-b', status: 'COMPLETED' });
    await waitForCoordinator();
    expect(f.enqueueProjectTurn).toHaveBeenCalledOnce();
  });

  it('passes only a real recorded preview URL to the secretary', async () => {
    const f = fixture({ runtimeUrl: 'http://127.0.0.1:43123/' });
    f.coordinator.onTaskFinished({ taskId: 'task-b', agentId: 'agent-b', status: 'COMPLETED' });
    await waitForCoordinator();

    const input = f.enqueueProjectTurn.mock.calls[0]?.[1];
    expect(input?.message).toContain('http://127.0.0.1:43123/');
    expect(input?.message).toContain('禁止猜测端口');
    expect(input?.message).not.toContain('127.0.0.1:0');
  });

  it('does not let a pinned employee conversation create primary acceptance', async () => {
    const f = fixture({ employeeId: 'agent-a' });
    f.coordinator.onTaskFinished({ taskId: 'task-b', agentId: 'agent-b', status: 'COMPLETED' });
    await waitForCoordinator();
    expect(f.enqueueProjectTurn).not.toHaveBeenCalled();
  });

  it('does not enqueue another request when an independent validation already exists', async () => {
    const f = fixture({
      validation: [{
        id: 'task-review', agent_id: 'agent-reviewer', status: 'RUNNING',
        content: 'Task intent: validation\n\nRelated project tasks:\ntask-a\ntask-b\n\n独立检查真实结果。'
      }]
    });
    f.coordinator.scanProject('project-1');
    await waitForCoordinator();
    expect(f.enqueueProjectTurn).not.toHaveBeenCalled();
  });

  it('asks the primary secretary to read the authoritative validation result after completion', async () => {
    const f = fixture({
      validation: [{
        id: 'task-review', agent_id: 'agent-reviewer', status: 'COMPLETED',
        content: 'Task intent: validation\n\nRelated project tasks:\ntask-a\ntask-b\n\n独立检查真实结果。'
      }]
    });
    f.coordinator.onTaskFinished({ taskId: 'task-review', agentId: 'agent-reviewer', status: 'COMPLETED' });
    await waitForCoordinator();

    expect(f.enqueueProjectTurn).toHaveBeenCalledOnce();
    const input = f.enqueueProjectTurn.mock.calls[0]?.[1];
    expect(input).toMatchObject({ title: '主秘书读取独立验收结果' });
    expect(input?.message).toContain('[OPC-NEXUS-AUTO-VALIDATION-STATUS] plan=draft-1 validation=task-review');
    expect(input?.message).toContain('nexus_task_status');
    expect(input?.message).toContain('validationVerdict');
    expect(f.db.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'hermes.acceptance.auto-status-request',
      result: 'draft-1:task-review:queue=hermes-chat-validation-status-1'
    }));
  });

  it('recovers a completed validation follow-up during a project rescan', async () => {
    const f = fixture({
      validation: [{
        id: 'task-review', agent_id: 'agent-reviewer', status: 'COMPLETED',
        content: 'Task intent: validation\n\nRelated project tasks:\ntask-a\ntask-b\n\n独立检查真实结果。'
      }]
    });
    f.coordinator.scanProject('project-1');
    await waitForCoordinator();

    expect(f.enqueueProjectTurn).toHaveBeenCalledOnce();
    expect(f.enqueueProjectTurn.mock.calls[0]?.[1]).toMatchObject({ title: '主秘书读取独立验收结果' });
  });

  it('fails closed when Hermes is not healthy', async () => {
    const f = fixture({ runtimeState: 'stopped' });
    f.coordinator.onTaskFinished({ taskId: 'task-b', agentId: 'agent-b', status: 'COMPLETED' });
    await waitForCoordinator();
    expect(f.enqueueProjectTurn).not.toHaveBeenCalled();
    expect(f.db.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'hermes.acceptance.auto-blocked' }));
  });

  it('fails closed when no independent READY reviewer exists', async () => {
    const f = fixture({ reviewers: [] });
    f.coordinator.onTaskFinished({ taskId: 'task-b', agentId: 'agent-b', status: 'COMPLETED' });
    await waitForCoordinator();
    expect(f.enqueueProjectTurn).not.toHaveBeenCalled();
    expect(f.db.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'hermes.acceptance.auto-blocked',
      result: 'draft-1:no-independent-ready-reviewer'
    }));
  });

  it('wakes the primary secretary when an implementation worker has no real output', async () => {
    const f = fixture({
      failedTask: {
        id: 'task-b', project_id: 'project-1', conversation_id: 'conversation-root',
        agent_id: 'agent-b', title: '章节写手', status: 'FAILED',
        content: 'Task intent: execution\n\n写入 draft/chapter-01.md', error: '上游 Provider 返回 502'
      }
    });
    f.coordinator.onTaskFinished({ taskId: 'task-b', agentId: 'agent-b', status: 'FAILED' });
    await waitForCoordinator();

    expect(f.enqueueProjectTurn).toHaveBeenCalledOnce();
    const input = f.enqueueProjectTurn.mock.calls[0]?.[1];
    expect(input).toMatchObject({ conversationId: 'conversation-root', principalId: 'owner-1', title: '主秘书追问失败员工' });
    expect(input?.message).toContain('[OPC-NEXUS-AUTO-FOLLOWUP] plan=draft-1 task=task-b');
    expect(input?.message).toContain('nexus_task_status');
    expect(input?.message).toContain('intent=status_inquiry');
    expect(input?.message).toContain('502');
    expect(f.db.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'hermes.followup.auto-request',
      result: 'draft-1:task-b:queue=hermes-chat-followup-1'
    }));
  });
});
