import { writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { HermesControlKernel } from '../src/main/services/kernel/hermesControlKernel.js';
import { NexusControlKernel } from '../src/main/services/kernel/nexusControlKernel.js';
import { buildPlanningPrompt, parseDispatchPlanDraft } from '../src/main/services/kernel/planningPrompt.js';

function request() {
  return {
    requestId: 'req-1', source: 'channel' as const, organizationId: 'org-1', principalId: 'principal-1', channelId: 'ch-weixin',
    conversationId: 'conv-1', inputMessageId: 'msg-1', message: '生成客户反馈摘要', preferredAgentId: null,
    projectId: null,
    workers: [{ agentId: 'agent-1', name: '运营', role: '运营', engineId: 'eng-pi', capabilities: ['files'] }],
    memories: [{ id: 'mem-1', kind: 'preference', content: '使用中文', importance: 0.8 }]
  };
}

const validPlan = JSON.stringify({
  workerAgentId: 'agent-1', title: '客户反馈摘要', objective: '整理客户反馈并生成摘要', rationale: '职责匹配',
  priority: 0, expectedOutputs: ['Markdown'], requiresHumanApproval: false, memoryProposals: [], taskScheduleProposals: []
});

function statusDb(statuses: Record<string, string>) {
  return {
    raw: { prepare: () => ({ get: (id: string) => ({ status: statuses[id] }), all: () => [], run: () => ({ changes: 1 }) }) },
    getSetting: (_key: string, fallback: unknown) => fallback,
    audit: vi.fn()
  };
}

describe('planning prompt and parser', () => {
  it('treats channel content as data and exposes only eligible worker ids', () => {
    const prompt = buildPlanningPrompt(request(), []);
    expect(prompt).toContain('untrusted data');
    expect(prompt).toContain('agent-1');
    expect(prompt).toContain('使用中文');
    expect(prompt).toContain('do not execute');
    expect(prompt).toContain('Scheduler is the only component allowed to create it');
  });

  it('parses a fenced JSON plan without evaluating surrounding text', () => {
    expect(parseDispatchPlanDraft(`prefix\n\`\`\`json\n${validPlan}\n\`\`\``)).toMatchObject({ workerAgentId: 'agent-1' });
    expect(() => parseDispatchPlanDraft('{"workerAgentId":')).toThrow('Invalid kernel JSON');
    expect(() => parseDispatchPlanDraft('{"error":{"message":"HTTP 403 Forbidden"}}')).toThrow('workerAgentId must be a string');
  });

  it('parses task schedule suggestions but rejects malformed or target-bearing items', () => {
    const scheduled = JSON.stringify({
      ...JSON.parse(validPlan),
      taskScheduleProposals: [{
        operation: 'create_task_schedule', title: 'Daily summary', content: 'Prepare a summary',
        cronKind: 'daily', cronValue: '09:00'
      }]
    });
    expect(parseDispatchPlanDraft(scheduled).taskScheduleProposals[0]).toMatchObject({
      operation: 'create_task_schedule', cronKind: 'daily', cronValue: '09:00'
    });
    expect(() => parseDispatchPlanDraft(JSON.stringify({
      ...JSON.parse(validPlan), taskScheduleProposals: 'daily'
    }))).toThrow('taskScheduleProposals must be an array');
    expect(() => parseDispatchPlanDraft(JSON.stringify({
      ...JSON.parse(validPlan),
      taskScheduleProposals: [{
        operation: 'create_task_schedule', agentId: 'agent-2', title: 'x', content: 'x',
        cronKind: 'daily', cronValue: '09:00'
      }]
    }))).toThrow('unsupported field agentId');
    expect(() => parseDispatchPlanDraft(JSON.stringify({
      ...JSON.parse(validPlan),
      taskScheduleProposals: [{
        operation: 'create_task_schedule', title: 123, content: 'x', cronKind: 'daily', cronValue: '09:00'
      }]
    }))).toThrow('title must be a string');
  });
});

describe('HermesControlKernel', () => {
  it('uses resumable one-shot mode, the detected binary and a usage-file session anchor', async () => {
    const home = 'C:/opc/controller';
    const profiles = { ensureController: vi.fn(() => ({
      home, model: 'deepseek-chat', provider: 'opcnexus',
      env: { HERMES_HOME: home, OPENAI_API_KEY: 'secret-key' }
    })) };
    const sessions = { get: vi.fn(() => 'native-session-1'), set: vi.fn(), clear: vi.fn() };
    const db = statusDb({ 'eng-hermes-cli': 'HEALTHY' });
    db.raw.prepare = (sql: string) => ({
      get: (id: string) => /SELECT path/.test(sql)
        ? { path: 'C:/tools/hermes.cmd' }
        : { status: { 'eng-hermes-cli': 'HEALTHY' }[id] },
      all: () => [], run: () => ({ changes: 1 })
    });
    const runner = vi.fn(async () => ({
      ok: true, code: 0, stdout: validPlan, stderr: '\nsession_id: native-session-2\n'
    }));
    const kernel = new HermesControlKernel(db as never, profiles as never, sessions, runner as never);

    const plan = await kernel.plan(request(), []);
    const [bin, args, opts] = runner.mock.calls[0];
    expect(plan.workerAgentId).toBe('agent-1');
    expect(bin).toBe('C:/tools/hermes.cmd');
    expect(args).toEqual(expect.arrayContaining(['chat', '-Q', '-q', '-t', 'todo', '-m', 'deepseek-chat', '--provider', 'opcnexus', '--resume', 'native-session-1', '--no-restore-cwd']));
    expect(args).not.toContain('--usage-file');
    expect(args).not.toContain('-z');
    expect(args).not.toContain('--max-turns');
    expect(args).not.toContain('--source');
    expect(args.join(' ')).not.toContain('secret-key');
    expect(opts.env.OPENAI_API_KEY).toBe('secret-key');
    expect(profiles.ensureController).toHaveBeenCalledWith('org-1', 'principal-1', 'conv-1');
    expect(sessions.set).toHaveBeenCalledWith('conv-1', 'hermes', 'native-session-2');
  });

  it('accepts a valid plan whose task text mentions an HTTP auth failure', async () => {
    const planWithAuthText = JSON.stringify({
      ...JSON.parse(validPlan),
      objective: 'Investigate why the integration reports HTTP 403 Forbidden'
    });
    const profiles = { ensureController: () => ({
      home: 'C:/opc/controller', model: 'deepseek-chat', provider: 'opcnexus', env: { HERMES_HOME: 'C:/opc/controller' }
    }) };
    const health = { reportAuthenticationFailure: vi.fn() };
    const runner = vi.fn(async () => ({
      ok: true,
      code: 0,
      stdout: planWithAuthText,
      stderr: 'warning: previous provider attempt returned HTTP 403 Forbidden'
    }));
    const kernel = new HermesControlKernel(
      statusDb({ 'eng-hermes-cli': 'HEALTHY' }) as never,
      profiles as never,
      undefined,
      runner as never,
      health
    );

    await expect(kernel.plan(request(), [])).resolves.toMatchObject({
      objective: 'Investigate why the integration reports HTTP 403 Forbidden'
    });
    expect(health.reportAuthenticationFailure).not.toHaveBeenCalled();
  });

  it('serializes concurrent controller calls that share one Hermes profile', async () => {
    const home = 'C:/opc/controller';
    const profiles = { ensureController: () => ({
      home, model: 'deepseek-chat', provider: 'opcnexus', env: { HERMES_HOME: home }
    }) };
    let active = 0;
    let peak = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const runner = vi.fn(async (_bin: string, args: string[]) => {
      active += 1;
      peak = Math.max(peak, active);
      if (runner.mock.calls.length === 1) await firstGate;
      active -= 1;
      writeFileSync(args[args.indexOf('--usage-file') + 1], JSON.stringify({ session_id: 'session-next' }));
      return { ok: true, code: 0, stdout: validPlan, stderr: '' };
    });
    const kernel = new HermesControlKernel(statusDb({ 'eng-hermes-cli': 'HEALTHY' }) as never, profiles as never, undefined, runner as never);

    const first = kernel.plan(request(), []);
    await vi.waitFor(() => expect(active).toBe(1));
    const second = kernel.plan({ ...request(), requestId: 'req-2', conversationId: 'conv-2', inputMessageId: 'msg-2' }, []);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runner).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(peak).toBe(1);
  });

  it('does not persist a failed Hermes session reported through the usage file', async () => {
    const home = 'C:/opc/controller';
    const profiles = { ensureController: () => ({
      home, model: 'deepseek-chat', provider: 'opcnexus', env: { HERMES_HOME: home }
    }) };
    const sessions = { get: vi.fn(() => null), set: vi.fn(), clear: vi.fn() };
    const health = { reportAuthenticationFailure: vi.fn() };
    const runner = vi.fn(async (_bin: string, args: string[]) => {
      const usageFile = args[args.indexOf('--usage-file') + 1];
      writeFileSync(usageFile, JSON.stringify({
        session_id: 'failed-session', failed: true, failure: 'HTTP 403 Forbidden'
      }));
      return { ok: true, code: 0, stdout: validPlan, stderr: '' };
    });
    const kernel = new HermesControlKernel(
      statusDb({ 'eng-hermes-cli': 'HEALTHY' }) as never,
      profiles as never,
      sessions,
      runner as never,
      health
    );

    await expect(kernel.plan(request(), [])).rejects.toThrow('HTTP 403 Forbidden');
    expect(sessions.set).not.toHaveBeenCalled();
    expect(health.reportAuthenticationFailure).toHaveBeenCalledWith('eng-hermes-cli', 'HTTP 403 Forbidden');
  });

  it('treats a zero-exit JSON 403 error envelope as auth failure before saving a session', async () => {
    const home = 'C:/opc/controller';
    const profiles = { ensureController: () => ({
      home, model: 'deepseek-chat', provider: 'opcnexus', env: { HERMES_HOME: home }
    }) };
    const sessions = { get: vi.fn(() => null), set: vi.fn(), clear: vi.fn() };
    const health = { reportAuthenticationFailure: vi.fn() };
    const runner = vi.fn(async (_bin: string, args: string[]) => {
      const usageFile = args[args.indexOf('--usage-file') + 1];
      writeFileSync(usageFile, JSON.stringify({ session_id: 'invalid-session' }));
      return { ok: true, code: 0, stdout: '{"error":{"message":"HTTP 403 Forbidden"}}', stderr: '' };
    });
    const kernel = new HermesControlKernel(
      statusDb({ 'eng-hermes-cli': 'HEALTHY' }) as never,
      profiles as never,
      sessions,
      runner as never,
      health
    );

    await expect(kernel.plan(request(), [])).rejects.toThrow('Hermes planning failed');
    expect(health.reportAuthenticationFailure).toHaveBeenCalledWith('eng-hermes-cli', expect.stringContaining('HTTP 403 Forbidden'));
    expect(sessions.set).not.toHaveBeenCalled();
  });

  it('revokes Hermes health when the managed controller profile cannot be prepared', async () => {
    const profiles = {
      ensureController: vi.fn(() => { throw new Error('Configured model Provider credential cannot be decrypted'); })
    };
    const health = { reportAuthenticationFailure: vi.fn() };
    const runner = vi.fn();
    const kernel = new HermesControlKernel(
      statusDb({ 'eng-hermes-cli': 'HEALTHY' }) as never,
      profiles as never,
      undefined,
      runner as never,
      health
    );

    await expect(kernel.plan(request(), [])).rejects.toThrow('Hermes controller profile unavailable');
    expect(health.reportAuthenticationFailure).toHaveBeenCalledWith(
      'eng-hermes-cli',
      'Configured model Provider credential cannot be decrypted'
    );
    expect(runner).not.toHaveBeenCalled();
  });

  it('reports local controller profile I/O failures as runtime degradation, not authentication failure', async () => {
    const profiles = {
      ensureController: vi.fn(() => { throw new Error('EACCES: permission denied, rename config.yaml'); })
    };
    const health = { reportAuthenticationFailure: vi.fn(), reportRuntimeFailure: vi.fn() };
    const kernel = new HermesControlKernel(
      statusDb({ 'eng-hermes-cli': 'HEALTHY' }) as never,
      profiles as never,
      undefined,
      vi.fn() as never,
      health
    );

    await expect(kernel.plan(request(), [])).rejects.toThrow('EACCES');
    expect(health.reportRuntimeFailure).toHaveBeenCalledWith(
      'eng-hermes-cli',
      'EACCES: permission denied, rename config.yaml'
    );
    expect(health.reportAuthenticationFailure).not.toHaveBeenCalled();
  });

  it('clears a stale native session and retries exactly once with a fresh one-shot request', async () => {
    const home = 'C:/opc/controller';
    const profiles = { ensureController: () => ({
      home, model: 'deepseek-chat', provider: 'opcnexus', env: { HERMES_HOME: home }
    }) };
    const sessions = { get: vi.fn(() => 'stale-session'), set: vi.fn(), clear: vi.fn() };
    const runner = vi.fn(async (_bin: string, args: string[]) => {
      if (runner.mock.calls.length === 1) {
        return { ok: false, code: 1, stdout: '', stderr: 'Session not found: stale-session' };
      }
      const usageFile = args[args.indexOf('--usage-file') + 1];
      writeFileSync(usageFile, JSON.stringify({ session_id: 'fresh-session' }));
      return { ok: true, code: 0, stdout: validPlan, stderr: '' };
    });
    const kernel = new HermesControlKernel(
      statusDb({ 'eng-hermes-cli': 'HEALTHY' }) as never,
      profiles as never,
      sessions,
      runner as never
    );

    await expect(kernel.plan(request(), [])).resolves.toMatchObject({ workerAgentId: 'agent-1' });
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[0][1]).toEqual(expect.arrayContaining(['--resume', 'stale-session']));
    expect(runner.mock.calls[1][1]).toEqual(expect.arrayContaining(['-z', '--usage-file']));
    expect(runner.mock.calls[1][1]).not.toContain('--resume');
    expect(sessions.clear).toHaveBeenCalledOnce();
    expect(sessions.clear).toHaveBeenCalledWith('conv-1', 'hermes');
    expect(sessions.set).toHaveBeenCalledWith('conv-1', 'hermes', 'fresh-session');
  });
});

describe('NexusControlKernel', () => {
  it('routes locally without a Provider and honors the channel-bound employee', async () => {
    const kernel = new NexusControlKernel();
    const plan = await kernel.plan({
      ...request(),
      preferredAgentId: 'agent-2',
      workers: [
        ...request().workers,
        { agentId: 'agent-2', name: '财务', role: '财务', engineId: 'eng-claude', capabilities: ['spreadsheets'] }
      ]
    }, []);

    expect(kernel.isReady()).toBe(true);
    expect(plan).toMatchObject({
      workerAgentId: 'agent-2',
      objective: '生成客户反馈摘要',
      requiresHumanApproval: false,
      memoryProposals: [],
      taskScheduleProposals: []
    });
  });

  it('uses deterministic role matching and gates high-risk fallback plans', async () => {
    const kernel = new NexusControlKernel();
    const plan = await kernel.plan({
      ...request(),
      message: '请财务员工删除付款记录',
      workers: [
        { agentId: 'agent-ops', name: '运营', role: '运营', engineId: 'eng-pi', capabilities: [] },
        { agentId: 'agent-finance', name: '财务员工', role: '财务', engineId: 'eng-claude', capabilities: [] }
      ]
    }, []);

    expect(plan.workerAgentId).toBe('agent-finance');
    expect(plan.requiresHumanApproval).toBe(true);
  });

  it('requires approval for unknown or destructive fallback intent', async () => {
    const kernel = new NexusControlKernel();
    const destructive = await kernel.plan({ ...request(), message: 'TRUNCATE TABLE customers' }, []);
    const unknown = await kernel.plan({ ...request(), message: 'Run the quarterly workflow' }, []);

    expect(destructive.requiresHumanApproval).toBe(true);
    expect(unknown.requiresHumanApproval).toBe(true);
  });
});
