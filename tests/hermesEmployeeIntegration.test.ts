import { describe, expect, it, vi } from 'vitest';
import { AgentMentionResolver } from '../src/main/services/agentMentionResolver.js';
import { HermesEmployeeDispatcher } from '../src/main/services/hermesEmployeeDispatcher.js';
import { HermesProjectPluginBridge } from '../src/main/services/hermesProjectPluginBridge.js';

function statementDb() {
  const audit = vi.fn();
  const prepare = vi.fn((sql: string) => ({
    get: vi.fn((...args: unknown[]) => {
      if (sql.includes('FROM projects')) return { id: 'project-1', organization_id: 'org-1' };
      if (sql.includes('FROM hermes_session_bindings')) {
        return { conversation_id: 'conversation-1', principal_id: 'principal-1', organization_id: 'org-1' };
      }
      if (sql.includes('FROM agents WHERE id')) {
        const id = String(args[0]);
        return id === 'agent-builder'
          ? { id, engine_id: 'eng-codex', lifecycle: 'READY', archived: 0 }
          : id === 'agent-dsh'
            ? { id, engine_id: 'eng-deepseek-harness-managed', lifecycle: 'READY', archived: 0 }
            : undefined;
      }
      if (sql.includes('SELECT id, agent_id, status FROM tasks')) {
        return args[0] === 'task-implementation'
          ? { id: 'task-implementation', agent_id: 'agent-builder', status: 'COMPLETED' }
          : undefined;
      }
      return undefined;
    }),
    all: vi.fn(() => sql.includes('FROM agents') ? [
      { id: 'agent-builder', name: '开发', role: '工程师', engine_id: 'eng-codex', memory_mode: 'long_term' },
      { id: 'agent-writer', name: '文案', role: '内容', engine_id: 'eng-claude', memory_mode: 'none' },
      { id: 'agent-dsh', name: 'Cordis', role: '调度器', engine_id: 'eng-deepseek-harness-managed', memory_mode: 'short_term' }
    ] : []),
    run: vi.fn()
  }));
  return { raw: { prepare }, audit };
}

describe('Hermes employee and shared plugin boundaries', () => {
  it('resolves only project-authorized employees and rejects unknown mentions', () => {
    const db = statementDb();
    const resolver = new AgentMentionResolver(db as never, {
      getWorkerSelection: () => ({ mode: 'restricted', workerAgentIds: ['agent-builder'] })
    });
    expect(resolver.listEligible('project-1')).toEqual([expect.objectContaining({
      id: 'agent-builder', name: '开发', memoryMode: 'long_term'
    })]);
    const resolved = resolver.resolve('project-1', '请 @开发 完成官网');
    expect(resolved.mentioned.map((item) => item.id)).toEqual(['agent-builder']);
    expect(resolved.systemMessage).toContain('agent-builder');
    expect(db.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'hermes.employee.mention' }));
    expect(() => resolver.resolve('project-1', '请 @文案 发布')).toThrow('未授权或不可用');
    expect(() => resolver.resolve('project-1', '请 @Cordis 派工')).toThrow('未授权或不可用');
  });

  it('creates real Orchestrator tasks and allows DSH only as an authorized worker CLI', () => {
    const db = statementDb();
    const createTask = vi.fn(() => ({ id: 'task-real', status: 'QUEUED', deduplicated: false }));
    const dispatcher = new HermesEmployeeDispatcher(db as never, { createTask } as never, {
      getWorkerSelection: () => ({ mode: 'restricted', workerAgentIds: ['agent-builder', 'agent-dsh'] }),
      getExplicitWorkspacePath: () => 'E:/opc/project-1'
    });
    const result = dispatcher.dispatch('project-1', {
      requestId: 'request-1', hermesSessionId: 'session-1', workerAgentId: 'agent-builder',
      title: '实现官网', description: '创建并验证页面', intent: 'execution', relatedTaskIds: [],
      expectedArtifacts: ['dist/index.html']
    });
    expect(result).toMatchObject({ intent: 'execution', task: { id: 'task-real', status: 'QUEUED' } });
    expect(JSON.stringify(result)).not.toContain('"error"');
    expect(createTask).toHaveBeenCalledWith('agent-builder', '实现官网', 'team', expect.objectContaining({
      projectId: 'project-1', conversationId: 'conversation-1',
      sourceKey: expect.stringMatching(/^hermes:project-1:session-1:\d+:[a-f0-9]{40}$/),
      workspaceOverride: 'E:/opc/project-1'
    }));
    expect(db.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'hermes.employee.dispatch', target: 'task-real' }));
    const dshResult = dispatcher.dispatch('project-1', {
      requestId: 'request-2', hermesSessionId: 'session-1', workerAgentId: 'agent-dsh',
      title: 'CLI 执行', description: '作为 Hermes 分配的执行员工运行', intent: 'execution',
      relatedTaskIds: [], expectedArtifacts: []
    });
    expect(dshResult.task.status).toBe('QUEUED');
    expect(createTask).toHaveBeenLastCalledWith('agent-dsh', 'CLI 执行', 'team', expect.objectContaining({
      projectId: 'project-1', sourceKey: expect.stringMatching(/^hermes:project-1:session-1:\d+:[a-f0-9]{40}$/)
    }));
    expect(() => dispatcher.dispatch('project-1', {
      requestId: 'request-3', hermesSessionId: 'session-1', workerAgentId: 'agent-builder',
      title: '越界产物', description: '非法路径', intent: 'execution', relatedTaskIds: [],
      expectedArtifacts: ['../secret.txt']
    })).toThrow('project-relative');
    expect(() => dispatcher.dispatch('project-1', {
      requestId: 'request-4', hermesSessionId: 'session-1', workerAgentId: 'agent-builder',
      title: '询问进度', description: '只汇报当前状态', intent: 'status_inquiry', relatedTaskIds: [],
      expectedArtifacts: ['status.md']
    })).toThrow('status inquiry cannot require a new artifact');
  });

  it('uses one rolling semantic idempotency key when Hermes retries the same tool call', () => {
    const db = statementDb();
    const tasks = new Map<string, { id: string; status: 'QUEUED'; deduplicated?: boolean }>();
    const createTask = vi.fn((_agentId: string, _title: string, _source: string, options: { sourceKey: string }) => {
      const existing = tasks.get(options.sourceKey);
      if (existing) return { ...existing, deduplicated: true };
      const task = { id: 'task-once', status: 'QUEUED' as const };
      tasks.set(options.sourceKey, task);
      return task;
    });
    const dispatcher = new HermesEmployeeDispatcher(db as never, { createTask } as never, {
      getWorkerSelection: () => ({ mode: 'restricted', workerAgentIds: ['agent-builder'] }),
      getExplicitWorkspacePath: () => 'E:/opc/project-1'
    });
    const input = {
      requestId: 'first-random-call', hermesSessionId: 'session-1', workerAgentId: 'agent-builder',
      title: '实现官网', description: '创建并验证页面', intent: 'execution' as const,
      relatedTaskIds: [], expectedArtifacts: ['dist/index.html']
    };

    const first = dispatcher.dispatch('project-1', input);
    const retried = dispatcher.dispatch('project-1', { ...input, requestId: 'second-random-call' });

    expect(first.task.id).toBe('task-once');
    expect(retried).toMatchObject({ task: { id: 'task-once' }, deduplicated: true });
    expect(createTask.mock.calls[0]?.[3].sourceKey).toBe(createTask.mock.calls[1]?.[3].sourceKey);
  });

  it('requires the secretary to use a different employee for completed-work validation', () => {
    const db = statementDb();
    const createTask = vi.fn((agentId: string, title: string) => ({
      id: 'task-validation', agentId, projectId: 'project-1', title,
      status: 'RUNNING', deduplicated: false
    }));
    const dispatcher = new HermesEmployeeDispatcher(db as never, { createTask } as never, {
      getWorkerSelection: () => ({ mode: 'restricted', workerAgentIds: ['agent-builder', 'agent-dsh'] }),
      getExplicitWorkspacePath: () => 'E:/opc/project-1'
    });
    const validation = {
      requestId: 'validation-1', hermesSessionId: 'session-1',
      title: '独立验收官网', description: '核对老板澄清中的 CTA 和真实预览结果',
      intent: 'validation' as const, relatedTaskIds: ['task-implementation'], expectedArtifacts: []
    };

    expect(() => dispatcher.dispatch('project-1', {
      ...validation, workerAgentId: 'agent-builder'
    })).toThrow('independent employee');
    expect(() => dispatcher.dispatch('project-1', {
      ...validation, requestId: 'validation-without-work', workerAgentId: 'agent-dsh', relatedTaskIds: []
    })).toThrow('at least one related execution task');

    const result = dispatcher.dispatch('project-1', {
      ...validation, workerAgentId: 'agent-dsh'
    });
    expect(result).toMatchObject({ intent: 'validation', task: { id: 'task-validation', agentId: 'agent-dsh' } });
    expect(createTask).toHaveBeenCalledWith('agent-dsh', '独立验收官网', 'team', expect.objectContaining({
      requiresArtifacts: false,
      content: expect.any(String)
    }));
    const validationContent = String(createTask.mock.calls.at(-1)?.[3]?.content ?? '');
    expect(validationContent).toContain('PASS, FAIL, or BLOCKED');
    expect(validationContent).toContain('http_request');
    expect(validationContent).toContain('browser_navigate');
    expect(validationContent).toContain('browser_get_content');
  });

  it('lets the secretary retrieve a real employee verdict from the bound project conversation', async () => {
    const audit = vi.fn();
    const prepare = vi.fn((sql: string) => ({
      get: vi.fn(() => {
        if (sql.includes('FROM hermes_session_bindings')) {
          return { conversation_id: 'conversation-1', principal_id: 'principal-1', organization_id: 'org-1' };
        }
        if (sql.includes('FROM tasks') && sql.includes('conversation_id = ?')) {
          return {
            id: 'task-review', agent_id: 'agent-builder', project_id: 'project-1', title: '独立验收',
            content: 'Task intent: validation\n\n核对真实交付',
            status: 'COMPLETED', progress: 100, stage: '完成', result: 'FAIL: 移动端按钮被遮挡',
            error: null, artifacts_required: 0
          };
        }
        return undefined;
      })
    }));
    const dispatcher = new HermesEmployeeDispatcher({ raw: { prepare }, audit } as never, {
      createTask: vi.fn()
    } as never, {
      getWorkerSelection: vi.fn(), getExplicitWorkspacePath: vi.fn()
    } as never);

    await expect(dispatcher.status('project-1', {
      requestId: 'status-1', hermesSessionId: 'session-1', taskId: 'task-review', waitSeconds: 0
    })).resolves.toEqual({
      task: expect.objectContaining({
        id: 'task-review', status: 'COMPLETED', terminal: true,
        intent: 'validation', result: 'FAIL: 移动端按钮被遮挡',
        failureReason: null, validationVerdict: 'FAIL', requiresArtifacts: false
      })
    });
    const receipt = await dispatcher.status('project-1', {
      requestId: 'status-2', hermesSessionId: 'session-1', taskId: 'task-review', waitSeconds: 0
    });
    expect(JSON.stringify(receipt)).not.toContain('"error"');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'hermes.employee.status', target: 'task-review'
    }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'hermes.employee.validation.verdict', target: 'task-review', result: 'FAIL'
    }));
  });

  it('accepts a leading Markdown-wrapped verdict but never infers one from the body', async () => {
    let result = '**PASS**\n\n已检查真实预览、文件和截图。';
    const prepare = vi.fn((sql: string) => ({
      get: vi.fn(() => {
        if (sql.includes('FROM hermes_session_bindings')) {
          return { conversation_id: 'conversation-1', principal_id: 'principal-1', organization_id: 'org-1' };
        }
        if (sql.includes('FROM tasks') && sql.includes('conversation_id = ?')) {
          return {
            id: 'task-review', agent_id: 'agent-dsh', project_id: 'project-1', title: '独立验收',
            content: 'Task intent: validation\n\n核对真实交付', status: 'COMPLETED', progress: 100,
            stage: '完成', result, error: null, artifacts_required: 0
          };
        }
        return undefined;
      })
    }));
    const dispatcher = new HermesEmployeeDispatcher({ raw: { prepare }, audit: vi.fn() } as never, {
      createTask: vi.fn()
    } as never, {
      getWorkerSelection: vi.fn(), getExplicitWorkspacePath: vi.fn()
    } as never);

    await expect(dispatcher.status('project-1', {
      requestId: 'status-pass', hermesSessionId: 'session-1', taskId: 'task-review', waitSeconds: 0
    })).resolves.toEqual({ task: expect.objectContaining({ validationVerdict: 'PASS' }) });

    result = '已完成全部检查，正文中提到 PASS，但开头没有权威结论。';
    await expect(dispatcher.status('project-1', {
      requestId: 'status-blocked', hermesSessionId: 'session-1', taskId: 'task-review', waitSeconds: 0
    })).resolves.toEqual({ task: expect.objectContaining({ validationVerdict: 'BLOCKED' }) });
  });

  it('exposes only selected live global MCP tools and calls them through Main', async () => {
    const db = { audit: vi.fn() };
    const mcp = {
      list: vi.fn(() => [
        { id: 'live', name: 'Live MCP', enabled: true, running: true, scope: 'global' },
        { id: 'stopped', name: 'Stopped MCP', enabled: true, running: false, scope: 'global' }
      ]),
      allTools: vi.fn(() => [
        { serverId: 'live', name: 'search/run', description: 'Real search' },
        { serverId: 'stopped', name: 'fake/run', description: 'Unavailable' }
      ]),
      callTool: vi.fn(async () => ({ ok: true, result: { value: 42 } }))
    };
    const skills = { list: vi.fn(() => [
      { id: 'writer', name: '写作', enabled: true },
      { id: 'mock', name: '禁用技能', enabled: false }
    ]) };
    const bridge = new HermesProjectPluginBridge(db as never, {
      getSettings: () => ({ pluginIds: ['skill:writer', 'skill:mock', 'mcp:live', 'mcp:stopped'] })
    } as never, mcp as never, skills as never);

    expect(bridge.list('project-1')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'skill:writer', status: 'ready' }),
      expect.objectContaining({ id: 'skill:mock', status: 'blocked' }),
      expect.objectContaining({ id: 'mcp:live', status: 'ready' }),
      expect.objectContaining({ id: 'mcp:stopped', status: 'blocked' })
    ]));
    await expect(bridge.call('project-1', {
      serverId: 'live', toolName: 'search/run', args: { query: 'OPC' }
    })).resolves.toEqual({ ok: true, result: { value: 42 } });
    expect(mcp.callTool).toHaveBeenCalledWith('live', 'search/run', { query: 'OPC' });
    await expect(bridge.call('project-1', {
      serverId: 'stopped', toolName: 'fake/run', args: {}
    })).rejects.toThrow('not selected, running, global, or available');
  });
});
