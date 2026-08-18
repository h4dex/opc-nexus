import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import initSqlJs from 'sql.js';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { DSH_MANAGED_ENGINE_ID, type Agent, type Task } from '../src/shared/types.js';
import { Database } from '../src/main/services/database.js';
import { DSH_MANAGED_PROFILE_ID } from '../src/main/services/deepseekHarnessManagedRuntime.js';
import { dshManagedProjectProfileId } from '../src/main/services/deepseekHarnessManagedRuntime.js';
import { DshSessionService } from '../src/main/services/dshSessionService.js';
import { ProjectWorkbenchService } from '../src/main/services/projectWorkbench.js';
import { DshAmbiguousTransportError, type DshControlPort, type DshSessionEvent } from '../src/main/services/dshControlClient.js';
import type { DshDelegationSyncService } from '../src/main/services/dshDelegationSyncService.js';
import type { DshTypedQuestBridge } from '../src/main/services/dshTypedQuestBridge.js';
import { DshManagedExecutor } from '../src/main/services/executor/dshManagedExecutor.js';
import type { DshRuntimeStatus } from '../src/main/services/dshSupervisor.js';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

const require = createRequire(import.meta.url);
let SQL: Awaited<ReturnType<typeof initSqlJs>>;
const openDatabases: InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>[] = [];

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
});

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()!.close();
});

function fixture(): {
  db: Database;
  inner: InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>;
  sessions: DshSessionService;
  task: Task;
  agent: Agent;
} {
  const inner = new SQL.Database();
  openDatabases.push(inner);
  const db = Reflect.construct(Database as unknown as new () => Database, []);
  db.inner = inner;
  db.scheduleSave = () => {};
  (db as unknown as { flush: () => void }).flush = () => {};
  (db as unknown as { migrate: () => void }).migrate();
  inner.exec(`
    INSERT INTO engines(id, type, name, status) VALUES('${DSH_MANAGED_ENGINE_ID}', 'dsh-managed', 'DSH', 'HEALTHY');
    INSERT INTO agents(
      id, organization_id, name, role, system_prompt, soul_md, agents_md, user_md,
      lifecycle, engine_id, workspace, permission_mode, concurrency_limit, archived,
      avatar_color, created_at, updated_at
    ) VALUES(
      'agent-dsh-exec', 'org-local', 'DSH Executor', 'worker', '', '', '', '',
      'READY', '${DSH_MANAGED_ENGINE_ID}', 'E:/workspace', 'standard', 1, 0, '#4d6bfe', 1, 1
    );
    INSERT INTO tasks(
      id, agent_id, title, content, source, status, priority, progress, stage, created_at, started_at
    ) VALUES(
      'task-dsh-exec', 'agent-dsh-exec', 'Executor test', 'Do the work', 'desktop', 'RUNNING', 0, 0, '', 1, 2
    );
  `);
  const sessions = new DshSessionService(db);
  const task: Task = {
    id: 'task-dsh-exec', agentId: 'agent-dsh-exec', title: 'Executor test', content: 'Do the work',
    source: 'desktop', parentId: null, status: 'RUNNING', priority: 0, progress: 0, stage: '', error: null,
    result: null, hasResult: false, quality: null, sessionId: null, conversationId: null, projectId: null,
    inputMessageId: null, workspaceOverride: null, engineOverride: null, createdAt: 1, startedAt: 2,
    endedAt: null
  };
  const agent: Agent = {
    id: 'agent-dsh-exec', name: 'DSH Executor', role: 'worker', kind: 'general', lifecycle: 'READY',
    engineId: DSH_MANAGED_ENGINE_ID, systemPrompt: '', soulMd: '', agentsMd: '', userMd: '',
    workspace: 'E:/workspace', permissionMode: 'standard', capabilities: {
      network: false, shell: false, install: false, browser: false, computer: false, mobile: false
    }, tags: [], archived: false, concurrencyLimit: 1, avatarColor: '#4d6bfe', createdAt: 1, updatedAt: 1
  };
  return { db, inner, sessions, task, agent };
}

interface FakePortOptions {
  sessionPresent?: boolean;
  sessionPreset?: string;
  modelProvider?: string;
  model?: string;
  modelSelectAmbiguous?: boolean;
  modelSelectUnconfirmed?: boolean;
  createAmbiguous?: boolean;
  promptAmbiguous?: boolean;
  promptUnconfirmed?: boolean;
  historyPageSize?: number;
  historySeedEvents?: number;
  observerEvents?: DshSessionEvent[];
  observerPayloads?: Array<{ rpcId: string; payload: Record<string, unknown> }>;
  deferTerminal?: boolean;
  cancelEvent?: DshSessionEvent;
}

class FakePort implements DshControlPort {
  readonly promptCalls: string[] = [];
  readonly promptTexts: string[] = [];
  readonly createCalls: string[] = [];
  readonly createInputs: Array<{ workspaceId?: string; cwd?: string; sessionId?: string; agentPreset?: string }> = [];
  readonly cancelCalls: string[] = [];
  readonly modelCalls: string[] = [];
  readonly modelSelectCalls: Array<{ sessionId: string; provider: string; model: string; rpcId: string }> = [];
  readonly events: DshSessionEvent[] = [];
  private present: boolean;
  private preset: string | undefined;
  private readonly options: FakePortOptions;
  private selectedModel: string;

  constructor(options: FakePortOptions = {}) {
    this.options = options;
    this.present = options.sessionPresent ?? false;
    this.preset = options.sessionPreset;
    this.selectedModel = options.model ?? 'deepseek-chat';
  }

  async listWorkspaces() {
    return { items: [], archivedSessionIds: [] };
  }

  async createWorkspace(input: { path: string }) {
    return {
      workspace: {
        workspaceId: 'workspace-test',
        path: input.path,
        title: 'test',
        sessionIds: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      },
      created: true
    };
  }

  async listSessions(): Promise<Array<{ sessionId: string; updatedAt: number; running: boolean; blank: boolean; agentPreset?: string }>> {
    return this.present ? [{
      sessionId: 'dsh-session-task-dsh-exec', updatedAt: Date.now(), running: false, blank: false,
      ...(this.preset ? { agentPreset: this.preset } : {})
    }] : [];
  }

  async createSession(input: {
    workspaceId?: string;
    cwd?: string;
    sessionId?: string;
    agentPreset?: string;
  }): Promise<{ sessionId: string; agentPreset?: string }> {
    const id = input.sessionId ?? 'dsh-session-task-dsh-exec';
    this.createCalls.push(id);
    this.createInputs.push({ ...input });
    this.present = true;
    this.preset = input.agentPreset;
    if (this.options.createAmbiguous) throw new DshAmbiguousTransportError('session.create', `dsh-create-${id}`, new Error('dropped'));
    return { sessionId: id, ...(input.agentPreset ? { agentPreset: input.agentPreset } : {}) };
  }

  async readHistory(input: { beforeSeq?: number; maxMessages?: number }): Promise<{ events: Array<{ event: DshSessionEvent }>; hasMore: boolean }> {
    const eligible = this.events
      .filter((event) => input.beforeSeq === undefined || event.seq < input.beforeSeq)
      .sort((a, b) => b.seq - a.seq);
    const pageSize = this.options.historyPageSize ?? input.maxMessages ?? eligible.length;
    const page = eligible.slice(0, pageSize);
    return { events: page.map((event) => ({ event })), hasMore: eligible.length > page.length };
  }

  async models(input: { sessionId: string }): Promise<{
    current: { provider: string; model: string };
    routable: boolean;
    groups: [];
    failures: [];
  }> {
    this.modelCalls.push(input.sessionId);
    return {
      current: { provider: this.options.modelProvider ?? 'deepseek-official', model: this.selectedModel },
      routable: true,
      groups: [],
      failures: []
    };
  }

  async selectModel(input: { sessionId: string; provider: string; model: string }, rpcId: string): Promise<{
    selected: { provider: string; model: string };
  }> {
    this.modelSelectCalls.push({ ...input, rpcId });
    if (!this.options.modelSelectUnconfirmed) this.selectedModel = input.model;
    if (this.options.modelSelectAmbiguous || this.options.modelSelectUnconfirmed) {
      throw new DshAmbiguousTransportError('session.selectModel', rpcId, new Error('dropped'));
    }
    return { selected: { provider: input.provider, model: input.model } };
  }

  async prompt(_input: { sessionId: string; mode: 'queue' | 'steer'; content: Array<{ type: 'text'; text: string }> }, rpcId: string): Promise<{ accepted: true }> {
    this.promptCalls.push(rpcId);
    this.promptTexts.push(_input.content.map((item) => item.text).join(''));
    if (!this.options.promptUnconfirmed) {
      this.events.push({
        type: 'user/message', seq: 0, time: 10,
        data: { source: { kind: 'user-rpc', rpcId }, content: [{ type: 'text', text: 'Do the work' }] }
      });
      if (this.options.deferTerminal) {
        // Keep the turn active until cancel() records its terminal boundary.
      } else if (!this.options.promptUnconfirmed && this.options.historySeedEvents) {
        for (let index = 1; index <= this.options.historySeedEvents; index += 1) {
          this.events.push({
            type: 'assistant/message', seq: index, time: 10 + index,
            data: { message: { content: [{ type: 'text', text: `part-${index}` }] } }
          });
        }
        this.events.push({
          type: 'turn/end', seq: this.options.historySeedEvents + 1, time: 20,
          data: { reason: { kind: 'completed' } }
        });
      } else if (!this.options.promptUnconfirmed) {
        this.events.push({
          type: 'assistant/message', seq: 1, time: 11,
          data: { message: { content: [{ type: 'text', text: 'Done' }] } }
        });
        this.events.push({
          type: 'turn/end', seq: 2, time: 12,
          data: { reason: { kind: 'completed' } }
        });
      }
    }
    if (this.options.promptAmbiguous || this.options.promptUnconfirmed) {
      throw new DshAmbiguousTransportError('session.prompt', rpcId, new Error('dropped'));
    }
    return { accepted: true };
  }

  async cancel(sessionId: string): Promise<{ accepted: true }> {
    this.cancelCalls.push(sessionId);
    if (this.options.cancelEvent) this.events.push(this.options.cancelEvent);
    return { accepted: true };
  }

  async observeMux(onEnvelope: (envelope: { rpcId: string; payload: Record<string, unknown> }) => void | Promise<void>, signal: AbortSignal): Promise<void> {
    for (const envelope of this.options.observerPayloads ?? []) await onEnvelope(envelope);
    for (const event of this.options.observerEvents ?? []) {
      await onEnvelope({
        rpcId: `push-${event.seq}`,
        payload: { type: 'session/event', sessionId: 'dsh-session-task-dsh-exec', event }
      });
    }
    await new Promise<void>((resolve) => {
      if (signal.aborted) { resolve(); return; }
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }
}

function runtime(overrides: Partial<DshRuntimeStatus> = {}): DshRuntimeStatus {
  return {
    agentId: 'agent-dsh-exec', profileId: DSH_MANAGED_PROFILE_ID, generation: 1, processState: 'READY',
    endpoint: 'http://127.0.0.1:3080', pid: 1, home: 'E:/dsh', profileDirectory: 'E:/dsh/profile',
    workspace: 'E:/workspace', startedAt: 1, readyAt: 1, lastHealthAt: 1, nextRestartAt: null,
    restartCount: 0, crashCount: 0, consecutiveFailures: 0, lastExit: null, lastError: null, recentLogs: [],
    ...overrides
  };
}

async function runOnce(options: FakePortOptions = {}, suppliedPort?: FakePort) {
  const { sessions, task, agent } = fixture();
  const port = suppliedPort ?? new FakePort(options);
  const supervisor = {
    start: vi.fn(async () => runtime()),
    getStatus: vi.fn(() => runtime()),
    authorizeModel: vi.fn(async () => undefined)
  };
  const done = new Promise<{ kind: 'done' | 'error'; value: string }>((resolve) => {
    const executor = new DshManagedExecutor(sessions, supervisor, {
      clientFactory: () => port,
      sleep: async (ms) => { await new Promise((r) => setTimeout(r, Math.min(ms, 2))); }
    });
    executor.start(task, agent, {
      onStage: vi.fn(), onProgress: vi.fn(), onOutput: vi.fn(), onSession: vi.fn(), onReleased: vi.fn(),
      onDone: (_id, value) => resolve({ kind: 'done', value }),
      onError: (_id, value) => resolve({ kind: 'error', value })
    });
  });
  return { result: await done, port, sessions, supervisor, task, agent };
}

describe('DshManagedExecutor', () => {
  it('creates a durable session, projects seq=0 events, and aggregates the assistant result', async () => {
    const run = await runOnce();
    expect(run.result).toEqual({ kind: 'done', value: 'Done' });
    expect(run.port.createCalls).toHaveLength(1);
    expect(run.port.createInputs[0]?.agentPreset).toBe('standard');
    expect(run.port.promptCalls).toHaveLength(1);
    expect(run.sessions.getSession('dsh-session-task-dsh-exec')).toMatchObject({ lastEventCursor: 2, lease: null });
    expect(run.sessions.getRun('dsh-run-task-dsh-exec-2')).toMatchObject({ upstreamState: 'COMPLETED', eventCursor: 2 });
  });

  it('uses the Cordis preset and passes the project-scoped Quest policy to DSH', async () => {
    const { db, inner, sessions, task, agent } = fixture();
    inner.exec(`
      INSERT INTO projects(id, organization_id, name, objective, status, created_at, updated_at)
        VALUES ('project-quest', 'org-local', '影视制作', '交付一条短片', 'active', 1, 1);
      UPDATE tasks SET project_id = 'project-quest' WHERE id = 'task-dsh-exec';
    `);
    task.projectId = 'project-quest';
    task.workspaceOverride = 'E:/projects/project-quest';
    const workbench = new ProjectWorkbenchService(db);
    workbench.saveSettings('project-quest', {
      mode: 'quest', sandbox: 'workspace', permissionMode: 'standard', model: 'vision-model',
      workerAgentIds: [agent.id], pluginIds: ['vision', 'video'], maxParallel: 4,
      autoApproveLowRisk: false
    });
    const port = new FakePort();
    const supervisor = {
      start: vi.fn(async () => runtime()),
      getStatus: vi.fn(() => runtime()),
      authorizeModel: vi.fn(async () => undefined)
    };
    const result = new Promise<{ kind: 'done' | 'error'; value: string }>((resolve) => {
      const executor = new DshManagedExecutor(sessions, supervisor, {
        clientFactory: () => port,
        sleep: async (ms) => { await new Promise((done) => setTimeout(done, Math.min(ms, 2))); },
        resolveQuestContext: (inputTask, inputAgent) => inputTask.projectId
          ? workbench.resolveExecutionContext(inputTask.projectId, inputAgent.id, inputTask.sessionId)
          : null
      });
      executor.start(task, agent, {
        onStage: vi.fn(), onProgress: vi.fn(), onOutput: vi.fn(), onSession: vi.fn(), onReleased: vi.fn(),
        onDone: (_id, value) => resolve({ kind: 'done', value }),
        onError: (_id, value) => resolve({ kind: 'error', value })
      });
    });

    await expect(result).resolves.toEqual({ kind: 'done', value: 'Done' });
    expect(port.createInputs[0]?.agentPreset).toBe('cordis');
    expect(port.promptTexts[0]).toContain('DSH / Cordis work order');
    expect(port.promptTexts[0]).toContain('opc-nexus-governance');
    expect(port.promptTexts[0]).toContain('"project":{"id":"project-quest","name":"影视制作"');
    expect(port.promptTexts[0]).toContain('"pluginIds":["vision","video"]');
    expect(port.promptTexts[0]).toContain('"workerAgentIds":["agent-dsh-exec"]');
    expect(port.promptTexts[0]).not.toContain('E:/workspace');
    expect(port.modelCalls).toEqual(['dsh-session-task-dsh-exec']);
    expect(port.modelSelectCalls).toEqual([{
      sessionId: 'dsh-session-task-dsh-exec', provider: 'deepseek-official', model: 'vision-model',
      rpcId: 'dsh-model-task-dsh-exec-2'
    }]);
    expect(supervisor.authorizeModel).toHaveBeenCalledWith(
      'agent-dsh-exec',
      dshManagedProjectProfileId('project-quest'),
      'vision-model'
    );
  });

  it('reconciles a lost session.selectModel response before submitting the prompt', async () => {
    const { db, inner, sessions, task, agent } = fixture();
    inner.exec(`
      INSERT INTO projects(id, organization_id, name, objective, status, created_at, updated_at)
        VALUES ('project-model', 'org-local', 'Model project', 'Select a model', 'active', 1, 1);
      UPDATE tasks SET project_id = 'project-model' WHERE id = 'task-dsh-exec';
    `);
    task.projectId = 'project-model';
    task.workspaceOverride = 'E:/projects/project-model';
    const workbench = new ProjectWorkbenchService(db);
    workbench.saveSettings('project-model', { model: 'vision-model' });
    const port = new FakePort({ modelSelectAmbiguous: true });
    const supervisor = {
      start: vi.fn(async () => runtime()),
      getStatus: vi.fn(() => runtime()),
      authorizeModel: vi.fn(async () => undefined)
    };
    const result = new Promise<{ kind: 'done' | 'error'; value: string }>((resolve) => {
      const executor = new DshManagedExecutor(sessions, supervisor, {
        clientFactory: () => port,
        sleep: async (ms) => { await new Promise((done) => setTimeout(done, Math.min(ms, 2))); },
        resolveQuestContext: (inputTask, inputAgent) => inputTask.projectId
          ? workbench.resolveExecutionContext(inputTask.projectId, inputAgent.id, inputTask.sessionId)
          : null
      });
      executor.start(task, agent, {
        onStage: vi.fn(), onProgress: vi.fn(), onOutput: vi.fn(), onSession: vi.fn(), onReleased: vi.fn(),
        onDone: (_id, value) => resolve({ kind: 'done', value }),
        onError: (_id, value) => resolve({ kind: 'error', value })
      });
    });
    await expect(result).resolves.toEqual({ kind: 'done', value: 'Done' });
    expect(port.modelSelectCalls).toHaveLength(1);
    expect(port.promptCalls).toHaveLength(1);
  });

  it('does not submit a prompt when a lost model selection cannot be reconciled', async () => {
    const { db, inner, sessions, task, agent } = fixture();
    inner.exec(`
      INSERT INTO projects(id, organization_id, name, objective, status, created_at, updated_at)
        VALUES ('project-model-fence', 'org-local', 'Model fence', 'Fence an uncertain route', 'active', 1, 1);
      UPDATE tasks SET project_id = 'project-model-fence' WHERE id = 'task-dsh-exec';
    `);
    task.projectId = 'project-model-fence';
    task.workspaceOverride = 'E:/projects/project-model-fence';
    const workbench = new ProjectWorkbenchService(db);
    workbench.saveSettings('project-model-fence', { model: 'vision-model' });
    const port = new FakePort({ modelSelectUnconfirmed: true });
    const supervisor = {
      start: vi.fn(async () => runtime()),
      getStatus: vi.fn(() => runtime()),
      authorizeModel: vi.fn(async () => undefined)
    };
    const result = new Promise<{ kind: 'done' | 'error'; value: string }>((resolve) => {
      const executor = new DshManagedExecutor(sessions, supervisor, {
        clientFactory: () => port,
        sleep: async (ms) => { await new Promise((done) => setTimeout(done, Math.min(ms, 2))); },
        resolveQuestContext: (inputTask, inputAgent) => inputTask.projectId
          ? workbench.resolveExecutionContext(inputTask.projectId, inputAgent.id, inputTask.sessionId)
          : null
      });
      executor.start(task, agent, {
        onStage: vi.fn(), onProgress: vi.fn(), onOutput: vi.fn(), onSession: vi.fn(), onReleased: vi.fn(),
        onDone: (_id, value) => resolve({ kind: 'done', value }),
        onError: (_id, value) => resolve({ kind: 'error', value })
      });
    });
    await expect(result).resolves.toMatchObject({ kind: 'error' });
    expect(port.modelSelectCalls).toHaveLength(1);
    expect(port.promptCalls).toHaveLength(0);
    expect(sessions.getRun('dsh-run-task-dsh-exec-2').upstreamState).toBe('NEEDS_RECONCILIATION');
  });

  it('reconciles an ambiguous session.create response by listing before retrying', async () => {
    const run = await runOnce({ createAmbiguous: true });
    expect(run.result.kind).toBe('done');
    expect(run.port.createCalls).toHaveLength(1);
  });

  it('rejects reusing a session whose preset conflicts with the requested mode', async () => {
    const run = await runOnce({ sessionPresent: true, sessionPreset: 'cordis' });
    expect(run.result.kind).toBe('error');
    expect(run.result.value).toContain('与当前执行模式要求的 standard 不一致');
    expect(run.port.promptCalls).toHaveLength(0);
  });

  it('reconciles an ambiguous prompt response through the exact user-message rpcId', async () => {
    const run = await runOnce({ promptAmbiguous: true });
    expect(run.result).toEqual({ kind: 'done', value: 'Done' });
    // The fake records the user event before dropping the response. No blind
    // second prompt is allowed; history reconciliation proves acceptance.
    expect(run.port.promptCalls).toHaveLength(1);
    expect(run.sessions.getRun('dsh-run-task-dsh-exec-2').upstreamState).toBe('COMPLETED');
  });

  it('fails closed when a prompt response and its history entry are both unavailable', async () => {
    const run = await runOnce({ promptUnconfirmed: true });
    expect(run.result.kind).toBe('error');
    expect(run.sessions.getRun('dsh-run-task-dsh-exec-2').upstreamState).toBe('NEEDS_RECONCILIATION');
    expect(run.port.promptCalls).toHaveLength(1);
  });

  it('reattaches after a database restart without recreating the session or resending the durable command', async () => {
    const { inner, sessions, task, agent } = fixture();
    const sessionId = 'dsh-session-task-dsh-exec';
    const runId = 'dsh-run-task-dsh-exec-2';
    const commandId = 'dsh-prompt-task-dsh-exec-2';
    const runtimeId = `dsh-runtime-agent-dsh-exec-${DSH_MANAGED_PROFILE_ID}`;
    sessions.upsertProfile({ id: DSH_MANAGED_PROFILE_ID, engineId: DSH_MANAGED_ENGINE_ID, version: 1 });
    sessions.upsertRuntimeInstance({
      id: runtimeId, agentId: agent.id, profileId: DSH_MANAGED_PROFILE_ID, processState: 'READY',
      endpoint: 'http://127.0.0.1:3080'
    });
    sessions.upsertSession({
      id: sessionId, upstreamSessionId: sessionId, runtimeInstanceId: runtimeId,
      agentId: agent.id, workspace: agent.workspace, controlMode: 'NEXUS_MANAGED'
    });
    sessions.upsertRun({
      id: runId, sessionId, nexusTaskId: task.id, commandId, upstreamState: 'RUNNING'
    });
    const lease = sessions.acquireLease({
      sessionId, controller: 'NEXUS', surface: 'INTERNAL', principal: `nexus:${task.id}`, expectedRevision: 0
    });
    const prompt = [
      'DSH / Cordis work order',
      'Host plugin: opc-nexus-governance',
      `Employee: ${agent.name}`,
      `Role: ${agent.role}`,
      `Task title: ${task.title}`,
      'Execute this work order in the managed DSH workspace. Return the final result in Markdown.',
      task.content
    ].join('\n');
    const receipt = sessions.claimCommand({
      commandId, sessionId, runId, commandType: 'session.prompt', principal: `nexus:${task.id}`,
      leaseToken: lease.token, expectedRevision: lease.status.revision,
      payload: { contentSha256: createHash('sha256').update(prompt, 'utf8').digest('hex'), mode: 'queue' }
    });
    sessions.completeCommand(commandId, { accepted: true });
    const initialEvents: DshSessionEvent[] = [
      {
        type: 'user/message', seq: 0, time: 10,
        data: { source: { kind: 'user-rpc', rpcId: commandId }, content: [{ type: 'text', text: task.content }] }
      },
      {
        type: 'assistant/message', seq: 1, time: 11,
        data: { message: { content: [{ type: 'text', text: 'Recovered work' }] } }
      }
    ];
    for (const event of initialEvents) {
      await sessions.projectEvent({
        sessionId, runId, seq: event.seq, type: event.type, protocolVersion: 'dsh-web/0.1.0-rc.6',
        payload: { data: event.data }, createdAt: event.time
      });
    }
    expect(receipt.receipt.status).toBe('ACCEPTED');
    expect(sessions.getRun(runId)).toMatchObject({ upstreamState: 'RUNNING', eventCursor: 1 });

    const reopenedInner = new SQL.Database(inner.export());
    openDatabases.push(reopenedInner);
    const reopenedDb = Reflect.construct(Database as unknown as new () => Database, []);
    reopenedDb.inner = reopenedInner;
    reopenedDb.scheduleSave = () => {};
    (reopenedDb as unknown as { flush: () => void }).flush = () => {};
    (reopenedDb as unknown as { migrate: () => void }).migrate();
    const reopenedSessions = new DshSessionService(reopenedDb);
    const port = new FakePort({ sessionPresent: true });
    port.events.push(...initialEvents, {
      type: 'turn/end', seq: 2, time: 12, data: { reason: { kind: 'completed' } }
    });
    const supervisor = {
      start: vi.fn(async () => runtime()),
      getStatus: vi.fn(() => runtime()),
      authorizeModel: vi.fn(async () => undefined)
    };
    const result = new Promise<{ kind: 'done' | 'error'; value: string }>((resolve) => {
      const executor = new DshManagedExecutor(reopenedSessions, supervisor, {
        clientFactory: () => port,
        sleep: async (ms) => { await new Promise((done) => setTimeout(done, Math.min(ms, 2))); }
      });
      executor.start(task, agent, {
        onStage: vi.fn(), onProgress: vi.fn(), onOutput: vi.fn(), onSession: vi.fn(), onReleased: vi.fn(),
        onDone: (_id, value) => resolve({ kind: 'done', value }),
        onError: (_id, value) => resolve({ kind: 'error', value })
      });
    });

    await expect(result).resolves.toEqual({ kind: 'done', value: 'Recovered work' });
    expect(port.createCalls).toEqual([]);
    expect(port.promptCalls).toEqual([]);
    expect(reopenedSessions.getSession(sessionId)).toMatchObject({ lastEventCursor: 2, lease: null });
    expect(reopenedSessions.getRun(runId)).toMatchObject({ upstreamState: 'COMPLETED', eventCursor: 2 });
    expect(reopenedSessions.getCommandReceipt(commandId)).toMatchObject({ status: 'COMPLETED' });
  });

  it('collects backwards history pages before projecting them in ascending seq order', async () => {
    const run = await runOnce({ historyPageSize: 2, historySeedEvents: 6 });
    expect(run.result.kind).toBe('done');
    expect(run.result.value).toContain('part-1');
    expect(run.result.value).toContain('part-6');
    expect(run.sessions.getSession('dsh-session-task-dsh-exec')).toMatchObject({ lastEventCursor: 7 });
  });

  it('buffers an observer tail event until reconcile supplies lower sequence numbers', async () => {
    const run = await runOnce({
      observerEvents: [{
        type: 'turn/end', seq: 2, time: 12,
        data: { reason: { kind: 'completed' } }
      }]
    });
    expect(run.result).toEqual({ kind: 'done', value: 'Done' });
    expect(run.sessions.getSession('dsh-session-task-dsh-exec')).toMatchObject({ lastEventCursor: 2 });
  });

  it('forwards typed question frames to the optional Quest bridge without replacing event folding', async () => {
    const { sessions, task, agent } = fixture();
    const questionEnvelope = {
      rpcId: 'question-rpc-1',
      payload: {
        type: 'question/requested',
        sessionId: 'dsh-session-task-dsh-exec',
        questions: [{
          id: 'plan-review', question: 'Approve?', detail: '# Plan',
          options: [{ label: 'Approve' }, { label: 'Keep planning' }],
          intent: { kind: 'plan-review', approve: 'Approve' }
        }]
      }
    };
    const port = new FakePort({ observerPayloads: [questionEnvelope] });
    const handleEnvelope = vi.fn(async () => null);
    const bridge = { handleEnvelope } as unknown as DshTypedQuestBridge;
    const supervisor = {
      start: vi.fn(async () => runtime()),
      getStatus: vi.fn(() => runtime()),
      authorizeModel: vi.fn(async () => undefined)
    };
    const settled = new Promise<{ kind: 'done' | 'error'; value: string }>((resolve) => {
      const executor = new DshManagedExecutor(sessions, supervisor, {
        clientFactory: () => port,
        typedQuestBridge: bridge,
        sleep: async (ms) => { await new Promise((done) => setTimeout(done, Math.min(ms, 2))); }
      });
      executor.start(task, agent, {
        onStage: vi.fn(), onProgress: vi.fn(), onOutput: vi.fn(), onSession: vi.fn(), onReleased: vi.fn(),
        onDone: (_id, value) => resolve({ kind: 'done', value }),
        onError: (_id, value) => resolve({ kind: 'error', value })
      });
    });

    await expect(settled).resolves.toEqual({ kind: 'done', value: 'Done' });
    expect(handleEnvelope).toHaveBeenCalledWith(questionEnvelope, expect.any(AbortSignal));
    expect(sessions.getSession('dsh-session-task-dsh-exec')).toMatchObject({ lastEventCursor: 2 });
  });

  it('confirms cancellation only after a durable turn/end(cancelled) event', async () => {
    const { sessions, task, agent } = fixture();
    const port = new FakePort({
      deferTerminal: true,
      cancelEvent: {
        type: 'turn/end', seq: 1, time: 11,
        data: { reason: { kind: 'cancelled' } }
      }
    });
    const supervisor = {
      start: vi.fn(async () => runtime()),
      getStatus: vi.fn(() => runtime()),
      authorizeModel: vi.fn(async () => undefined)
    };
    const executor = new DshManagedExecutor(sessions, supervisor, {
      clientFactory: () => port,
      sleep: async (ms) => { await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2))); }
    });
    const callbacks = {
      onStage: vi.fn(), onProgress: vi.fn(), onOutput: vi.fn(), onSession: vi.fn(), onReleased: vi.fn(),
      onDone: vi.fn(), onError: vi.fn()
    };
    executor.start(task, agent, callbacks);
    for (let attempt = 0; attempt < 100 && port.promptCalls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    await expect(executor.abort(task.id)).resolves.toMatchObject({
      status: 'CONFIRMED', reason: 'turn/end(cancelled)'
    });
    expect(sessions.getRun('dsh-run-task-dsh-exec-2').upstreamState).toBe('CANCELLED');
    expect(sessions.getSession('dsh-session-task-dsh-exec')).toMatchObject({ lastEventCursor: 1, lease: null });
    expect(callbacks.onDone).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it('fences cancellation to the current runtime generation', async () => {
    const { sessions, task, agent } = fixture();
    const firstPort = new FakePort({ deferTerminal: true });
    const secondPort = new FakePort({
      cancelEvent: { type: 'turn/end', seq: 1, time: 11, data: { reason: { kind: 'cancelled' } } }
    });
    let current = runtime();
    const supervisor = {
      start: vi.fn(async () => current),
      getStatus: vi.fn(() => current),
      authorizeModel: vi.fn(async () => undefined)
    };
    const executor = new DshManagedExecutor(sessions, supervisor, {
      clientFactory: (endpoint) => endpoint.endsWith(':3081') ? secondPort : firstPort,
      sleep: async (ms) => { await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2))); }
    });
    executor.start(task, agent, {
      onStage: vi.fn(), onProgress: vi.fn(), onOutput: vi.fn(), onSession: vi.fn(), onReleased: vi.fn(),
      onDone: vi.fn(), onError: vi.fn()
    });
    for (let attempt = 0; attempt < 100 && firstPort.promptCalls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    secondPort.events.push(...firstPort.events);
    current = runtime({ generation: 2, endpoint: 'http://127.0.0.1:3081', pid: 2, restartCount: 1 });

    await expect(executor.abort(task.id)).resolves.toMatchObject({ status: 'CONFIRMED' });
    expect(firstPort.cancelCalls).toHaveLength(0);
    expect(secondPort.cancelCalls).toEqual(['dsh-session-task-dsh-exec']);
  });

  it('settles a run for reconciliation when runtime death cannot be verified', async () => {
    const { sessions, task, agent } = fixture();
    const port = new FakePort({ deferTerminal: true });
    let current = runtime();
    const supervisor = {
      start: vi.fn(async () => current),
      getStatus: vi.fn(() => current),
      authorizeModel: vi.fn(async () => undefined)
    };
    const executor = new DshManagedExecutor(sessions, supervisor, {
      clientFactory: () => port,
      sleep: async (ms) => { await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2))); }
    });
    const settled = new Promise<{ kind: string; value: string }>((resolve) => {
      executor.start(task, agent, {
        onStage: vi.fn(), onProgress: vi.fn(), onOutput: vi.fn(), onSession: vi.fn(), onReleased: vi.fn(),
        onDone: (_id, value) => resolve({ kind: 'done', value }),
        onError: (_id, value) => resolve({ kind: 'error', value })
      });
    });
    for (let attempt = 0; attempt < 100 && port.promptCalls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    current = runtime({ processState: 'STOP_FAILED', endpoint: null });

    await expect(settled).resolves.toMatchObject({ kind: 'error' });
    expect(sessions.getRun('dsh-run-task-dsh-exec-2').upstreamState).toBe('NEEDS_RECONCILIATION');
  });

  it('runs optional child projection without turning a healthy root into an error', async () => {
    const { sessions, task, agent } = fixture();
    const port = new FakePort({
      deferTerminal: true,
      cancelEvent: { type: 'turn/end', seq: 1, time: 11, data: { reason: { kind: 'cancelled' } } }
    });
    const delegationSync = {
      syncRuntime: vi.fn(async () => { throw new Error('child projection temporarily unavailable'); })
    } as unknown as DshDelegationSyncService;
    const supervisor = {
      start: vi.fn(async () => runtime()),
      getStatus: vi.fn(() => runtime()),
      authorizeModel: vi.fn(async () => undefined)
    };
    const executor = new DshManagedExecutor(sessions, supervisor, {
      clientFactory: () => port,
      delegationSync,
      sleep: async (ms) => { await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2))); }
    });
    const callbacks = {
      onStage: vi.fn(), onProgress: vi.fn(), onOutput: vi.fn(), onSession: vi.fn(), onReleased: vi.fn(),
      onDone: vi.fn(), onError: vi.fn()
    };
    executor.start(task, agent, callbacks);
    for (let attempt = 0; attempt < 200 && delegationSync.syncRuntime.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(delegationSync.syncRuntime).toHaveBeenCalled();
    expect(delegationSync.syncRuntime).toHaveBeenCalledWith(expect.objectContaining({
      agentId: agent.id,
      rootSessionId: 'dsh-session-task-dsh-exec',
      projectHistory: true,
      client: port
    }));

    await expect(executor.abort(task.id)).resolves.toMatchObject({ status: 'CONFIRMED' });
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onDone).not.toHaveBeenCalled();
  });
});
