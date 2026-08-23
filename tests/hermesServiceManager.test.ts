import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getAppPath: () => process.cwd(),
    isPackaged: false
  }
}));

import { Database } from '../src/main/services/database.js';
import {
  hermesRuntimeLaunchCandidates,
  HermesServiceManager
} from '../src/main/services/hermesServiceManager.js';
import { ProjectManager } from '../src/main/services/projectManager.js';

const require = createRequire(import.meta.url);
let SQL: Awaited<ReturnType<typeof initSqlJs>>;
const roots: string[] = [];
const databases: InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>[] = [];

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
});

afterEach(() => {
  while (databases.length) databases.pop()!.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

type TestDatabase = Database & {
  inner: InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>;
  scheduleSave: () => void;
};

function database(): TestDatabase {
  const inner = new SQL.Database();
  databases.push(inner);
  const db = Reflect.construct(Database as unknown as new () => Database, []) as TestDatabase;
  db.inner = inner;
  db.scheduleSave = () => {};
  (db as unknown as { flush: () => void }).flush = () => {};
  (db as unknown as { migrate: () => void }).migrate();
  return db;
}

function fixture() {
  const db = database();
  const root = mkdtempSync(join(tmpdir(), 'aibox-hermes-manager-'));
  const workspace = join(root, 'workspace');
  const homes = join(root, 'homes');
  mkdirSync(workspace);
  roots.push(root);
  const project = new ProjectManager(db).create({
    name: 'Managed Hermes',
    objective: 'Use only real project employees',
    description: 'Test project isolation'
  });
  const now = Date.UTC(2026, 7, 18, 12, 0, 0);
  db.raw.prepare(`
    INSERT INTO engines(id, type, name, status) VALUES('eng-real', 'codex', 'Real engine', 'HEALTHY')
  `).run();
  db.raw.prepare(`
    INSERT INTO agents(
      id, organization_id, name, role, engine_id, lifecycle, workspace,
      permission_mode, capabilities_json, concurrency_limit, created_at, updated_at
    ) VALUES(?, 'org-local', 'Builder', 'implementation', 'eng-real', 'READY', ?,
      'standard', ?, 2, ?, ?)
  `).run('agent-real', workspace, JSON.stringify({ shell: true, network: false }), now, now);
  db.raw.prepare(`
    INSERT INTO agents(
      id, organization_id, name, role, engine_id, lifecycle, workspace,
      permission_mode, capabilities_json, concurrency_limit, created_at, updated_at
    ) VALUES(?, 'org-local', 'Offline', 'unused', 'eng-real', 'DISABLED', ?,
      'standard', '{}', 1, ?, ?)
  `).run('agent-offline', workspace, now, now);
  const manager = new HermesServiceManager(db, {
    root: homes,
    resolveProjectWorkspace: () => workspace,
    resolveProviderEnvironment: () => ({
      OPENAI_API_KEY: 'must-not-enter-context',
      OPENAI_BASE_URL: 'https://provider.invalid/v1',
      HERMES_INFERENCE_MODEL: 'provider/model'
    })
  });
  return { db, manager, project, root, workspace };
}

function createConversation(
  f: ReturnType<typeof fixture>,
  conversationId: string
): { conversationId: string; principalId: string } {
  const principalId = 'principal-local-admin';
  const now = Date.UTC(2026, 7, 18, 12, 0, 0);
  f.db.raw.prepare(`
    INSERT INTO conversations(
      id, agent_id, project_id, organization_id, principal_id, title,
      last_message_at, message_count, created_at, updated_at
    ) VALUES(?, 'agent-real', ?, 'org-local', ?, 'Queue test', ?, 0, ?, ?)
  `).run(conversationId, f.project.id, principalId, now, now, now);
  return { conversationId, principalId };
}

function attachHealthyInstance(f: ReturnType<typeof fixture>) {
  const publishProjectEvent = vi.fn();
  const internal = f.manager as unknown as {
    instances: Map<string, {
      status: { state: string };
      proxy: { publishProjectEvent: (event: unknown) => void };
    }>;
  };
  internal.instances.set(f.project.id, {
    status: { state: 'healthy' },
    proxy: { publishProjectEvent }
  });
  return publishProjectEvent;
}

function turnResult(projectId: string, conversationId: string, content: string) {
  return {
    projectId,
    conversationId,
    hermesSessionId: `session-${conversationId}`,
    content,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    runtime: { provider: 'custom:opcnexus', model: 'provider/model' },
    createdAt: Date.UTC(2026, 7, 18, 12, 0, 1)
  };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('HermesServiceManager project isolation', () => {
  it('removes legacy DSH names from Hermes binding tables while preserving values', () => {
    const db = database();
    const root = mkdtempSync(join(tmpdir(), 'aibox-hermes-schema-'));
    roots.push(root);
    const now = Date.UTC(2026, 7, 22, 12, 0, 0);
    const project = new ProjectManager(db).create({ name: 'Schema migration', objective: 'Keep bindings', status: 'active' });
    db.raw.prepare("INSERT INTO engines(id, type, name, status) VALUES('eng-schema', 'codex', 'Schema', 'HEALTHY')").run();
    db.raw.prepare(`
      INSERT INTO agents(id, organization_id, name, role, engine_id, lifecycle, created_at, updated_at)
      VALUES('agent-schema', 'org-local', 'Schema', 'worker', 'eng-schema', 'READY', ?, ?)
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO conversations(
        id, agent_id, project_id, organization_id, principal_id, title,
        last_message_at, message_count, created_at, updated_at
      ) VALUES('conversation-schema', 'agent-schema', ?, 'org-local', 'principal-local-admin',
        'Schema', ?, 0, ?, ?)
    `).run(project.id, now, now, now);
    db.raw.prepare(`
      CREATE TABLE hermes_session_bindings (
        project_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        hermes_session_id TEXT NOT NULL,
        dsh_session_id TEXT,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY(project_id, conversation_id)
      )
    `).run();
    db.raw.prepare(`
      CREATE TABLE hermes_run_bindings (
        hermes_run_id TEXT PRIMARY KEY,
        dsh_job_id TEXT,
        dsh_run_id TEXT,
        project_id TEXT NOT NULL,
        plan_hash TEXT,
        status TEXT NOT NULL DEFAULT 'observed',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `).run();
    db.raw.prepare(`
      INSERT INTO hermes_session_bindings(
        project_id, principal_id, conversation_id, hermes_session_id, dsh_session_id, last_seen_at
      ) VALUES(?, 'principal-local-admin', 'conversation-schema', 'hermes-session-schema', 'unused-legacy', ?)
    `).run(project.id, now);
    db.raw.prepare(`
      INSERT INTO hermes_run_bindings(
        hermes_run_id, dsh_job_id, dsh_run_id, project_id, plan_hash, status, created_at, updated_at
      ) VALUES('hermes-run-schema', 'task-schema', 'worker-run-schema', ?, 'hash-schema', 'completed', ?, ?)
    `).run(project.id, now, now);

    new HermesServiceManager(db, { root: join(root, 'homes') });

    const sessionColumns = (db.raw.prepare('PRAGMA table_info(hermes_session_bindings)').all() as Array<{ name: string }>)
      .map((column) => column.name);
    const runColumns = (db.raw.prepare('PRAGMA table_info(hermes_run_bindings)').all() as Array<{ name: string }>)
      .map((column) => column.name);
    expect(sessionColumns).not.toContain('dsh_session_id');
    expect(sessionColumns).toContain('identity_key');
    expect(runColumns).toEqual(expect.arrayContaining(['nexus_task_id', 'worker_run_id']));
    expect(runColumns.some((name) => name.startsWith('dsh_'))).toBe(false);
    expect(db.raw.prepare(`
      SELECT hermes_session_id, identity_key FROM hermes_session_bindings
      WHERE project_id = ? AND conversation_id = 'conversation-schema'
    `).get(project.id)).toEqual({ hermes_session_id: 'hermes-session-schema', identity_key: null });
    expect(db.raw.prepare(`
      SELECT nexus_task_id, worker_run_id, plan_hash, status FROM hermes_run_bindings
      WHERE hermes_run_id = 'hermes-run-schema'
    `).get()).toEqual({
      nexus_task_id: 'task-schema', worker_run_id: 'worker-run-schema',
      plan_hash: 'hash-schema', status: 'completed'
    });
  });

  it('includes the prepared workspace runtime when Electron is not packaged', () => {
    const candidates = hermesRuntimeLaunchCandidates({
      appPath: join('E:', 'Develop', 'AiBoxDash'),
      resourcesPath: join('E:', 'Develop', 'AiBoxDash', 'node_modules', 'electron', 'dist', 'resources'),
      isPackaged: false,
      platform: 'win32'
    });
    expect(candidates).toContainEqual({
      sourcePath: join('E:', 'Develop', 'AiBoxDash', 'vendor', 'hermes-agent'),
      pythonPath: join('E:', 'Develop', 'AiBoxDash', 'runtime', 'hermes', 'python', 'python.exe'),
      webDistPath: join('E:', 'Develop', 'AiBoxDash', 'vendor', 'hermes-agent', 'hermes_cli', 'web_dist')
    });
  });

  it('creates host policy context from the approved workspace and READY employees only', () => {
    const f = fixture();
    const internal = f.manager as unknown as {
      prepareProjectHome(projectId: string, workspacePath: string): string;
    };
    const home = internal.prepareProjectHome(f.project.id, f.workspace);
    const context = readFileSync(join(home, 'NEXUS-CONTEXT.md'), 'utf8');
    const agents = readFileSync(join(home, 'AGENTS.md'), 'utf8');
    const config = JSON.parse(readFileSync(join(home, 'config.yaml'), 'utf8')) as {
      model: { provider: string; base_url: string; api_mode: string; max_tokens?: number };
      providers: { opcnexus: { base_url: string; key_env: string; api_mode: string; max_tokens?: number } };
      platform_toolsets: { api_server: string[] };
    };

    expect(context).toContain(f.project.id);
    expect(context).toContain(f.workspace.replace(/\\/g, '\\\\'));
    expect(context).toContain('agent-real');
    expect(context).not.toContain('agent-offline');
    expect(context).not.toContain('must-not-enter-context');
    expect(context).toContain('validatorMustDifferFromImplementationWorker');
    expect(context).toContain('Report delivery complete only when validationVerdict is PASS');
    expect(agents).toContain('nexus_submit_plan');
    expect(agents).toContain('Do not use native delegate_task');
    expect(config.model).toMatchObject({
      provider: 'custom:opcnexus',
      base_url: 'https://provider.invalid/v1',
      api_mode: 'chat_completions',
      max_tokens: 16_384
    });
    expect(config.providers.opcnexus).toMatchObject({
      base_url: 'https://provider.invalid/v1',
      key_env: 'OPENAI_API_KEY',
      api_mode: 'chat_completions',
      max_tokens: 16_384
    });
    expect(config.platform_toolsets.api_server).toEqual(['hermes-api-server', 'planning']);
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).not.toContain('must-not-enter-context');

    writeFileSync(join(home, 'MEMORY.md'), '# Owner memory\nkeep me\n');
    internal.prepareProjectHome(f.project.id, f.workspace);
    expect(readFileSync(join(home, 'MEMORY.md'), 'utf8')).toContain('keep me');
  });

  it('fails before launch when no Main-approved project directory exists', async () => {
    const f = fixture();
    f.manager.setProjectWorkspaceResolver(() => null);
    await expect(f.manager.start(f.project.id)).rejects.toThrow('approved project working directory');
  });

  it('persists an actionable preflight error when the Provider credential is missing', async () => {
    const f = fixture();
    const manager = new HermesServiceManager(f.db, {
      root: join(f.root, 'provider-missing-homes'),
      resolveProjectWorkspace: () => f.workspace,
      resolveProviderEnvironment: () => ({
        OPENAI_BASE_URL: 'https://provider.invalid/v1',
        HERMES_INFERENCE_MODEL: 'provider/model'
      })
    });

    await expect(manager.start(f.project.id)).rejects.toThrow('连接设置');
    expect(manager.getStatus(f.project.id)).toMatchObject({
      state: 'error',
      startupPhase: 'error',
      homePath: manager.projectHome(f.project.id)
    });
    const binding = manager.listBindings().find((item) => item.projectId === f.project.id);
    expect(binding?.status).toBe('error');
    expect(binding?.lastError).toContain('API Key');
    expect(binding?.lastError).not.toContain('provider.invalid');
  });

  it('coalesces concurrent starts for the same project into one runtime launch', async () => {
    const f = fixture();
    const gate = deferred<ReturnType<typeof f.manager.getStatus>>();
    const internal = f.manager as unknown as {
      startOnce(projectId: string): Promise<ReturnType<typeof f.manager.getStatus>>;
      startOperations: Map<string, Promise<ReturnType<typeof f.manager.getStatus>>>;
    };
    const startOnce = vi.spyOn(internal, 'startOnce').mockReturnValue(gate.promise);
    const first = f.manager.start(f.project.id);
    const second = f.manager.start(f.project.id);
    expect(startOnce).toHaveBeenCalledOnce();
    expect(internal.startOperations.size).toBe(1);

    const healthy = {
      ...f.manager.getStatus(f.project.id),
      state: 'healthy' as const,
      startupPhase: 'ready' as const,
      startupElapsedMs: 123
    };
    gate.resolve(healthy);
    await expect(first).resolves.toEqual(healthy);
    await expect(second).resolves.toEqual(healthy);
    expect(internal.startOperations.size).toBe(0);
  });

  it('does not reuse a healthy status after the Main-owned proxy has stopped', async () => {
    const f = fixture();
    const internal = f.manager as unknown as {
      instances: Map<string, unknown>;
      startOnce(projectId: string): Promise<ReturnType<typeof f.manager.getStatus>>;
    };
    const startOnce = vi.spyOn(internal, 'startOnce').mockResolvedValue({
      ...f.manager.getStatus(f.project.id),
      state: 'healthy',
      startupPhase: 'ready',
      startupElapsedMs: 42
    });
    internal.instances.set(f.project.id, {
      status: { ...f.manager.getStatus(f.project.id), state: 'healthy' },
      proxy: { getStatus: () => ({ running: false }) }
    });

    await expect(f.manager.start(f.project.id)).resolves.toMatchObject({ state: 'healthy' });
    expect(startOnce).toHaveBeenCalledOnce();
  });

  it('waits for replacement startup instead of surfacing the stale crash error', async () => {
    const f = fixture();
    const internal = f.manager as unknown as {
      instances: Map<string, unknown>;
      startOnce(projectId: string): Promise<ReturnType<typeof f.manager.getStatus>>;
    };
    const gate = deferred<void>();
    internal.instances.set(f.project.id, {
      status: { ...f.manager.getStatus(f.project.id), state: 'error', lastError: 'old dashboard crash' },
      proxy: { getStatus: () => ({ running: false }) }
    });
    const healthy = {
      ...f.manager.getStatus(f.project.id),
      state: 'healthy' as const,
      startupPhase: 'ready' as const,
      startupElapsedMs: 42
    };
    const startOnce = vi.spyOn(internal, 'startOnce').mockImplementation(async () => {
      await gate.promise;
      internal.instances.set(f.project.id, {
        status: healthy,
        dashboardReady: true,
        proxy: { getStatus: () => ({ running: true }) }
      });
      return healthy;
    });

    const result = f.manager.startForUi(f.project.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(startOnce).toHaveBeenCalledOnce();
    gate.resolve();
    await expect(result).resolves.toMatchObject({ state: 'healthy' });
  });

  it('allows the authenticated UI after dashboard readiness without claiming the gateway is healthy', async () => {
    const f = fixture();
    const createLease = vi.fn(() => ({
      leaseId: 'lease-dashboard-ready',
      projectId: f.project.id,
      url: 'http://127.0.0.1:43210/',
      expiresAt: Date.now() + 60_000
    }));
    const internal = f.manager as unknown as {
      instances: Map<string, unknown>;
    };
    internal.instances.set(f.project.id, {
      dashboardReady: true,
      gatewayReady: false,
      status: {
        ...f.manager.getStatus(f.project.id),
        state: 'starting',
        startupPhase: 'starting-gateway'
      },
      proxy: { createLease }
    });

    expect(f.manager.createUiLease(f.project.id)).toMatchObject({ leaseId: 'lease-dashboard-ready' });
    expect(createLease).toHaveBeenCalledOnce();
    const binding = createConversation(f, 'conversation-gateway-starting');
    expect(() => f.manager.enqueueProjectTurn(f.project.id, { ...binding, message: 'too early' }))
      .toThrow('not healthy');
  });

  it('rejects invalid and cross-project home identities', () => {
    const f = fixture();
    expect(() => f.manager.projectHome('../outside')).toThrow('projectId is invalid');
    expect(() => f.manager.projectHome('project-that-does-not-exist')).toThrow('does not exist');
  });

  it('locks new and restored project sessions to the Main-approved Provider model', async () => {
    const f = fixture();
    const conversationId = 'conversation-runtime-lock';
    const principalId = 'principal-local-admin';
    const now = Date.UTC(2026, 7, 18, 12, 0, 0);
    f.db.raw.prepare(`
      INSERT INTO conversations(
        id, agent_id, project_id, organization_id, principal_id, title,
        last_message_at, message_count, created_at, updated_at
      ) VALUES(?, 'agent-real', ?, 'org-local', ?, 'Runtime lock', ?, 0, ?, ?)
    `).run(conversationId, f.project.id, principalId, now, now, now);
    f.manager.setSessionBinder((projectId, hermesSessionId, requested) => {
      if (!requested) throw new Error('Expected a requested conversation');
      f.db.raw.prepare(`
        INSERT INTO hermes_session_bindings(
          project_id, principal_id, conversation_id, hermes_session_id, last_seen_at
        ) VALUES(?, ?, ?, ?, ?)
      `).run(projectId, requested.principalId, requested.conversationId, hermesSessionId, now);
      return requested;
    });
    const resolveConversationContext = vi.fn(() => [
      'You are the fixed employee named "Builder".',
      'An @Frontend mention is a delegation target and must not change your identity.'
    ].join('\n'));
    f.manager.setConversationContextResolver(resolveConversationContext);

    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const internal = f.manager as unknown as {
      instances: Map<string, unknown>;
      gatewayJson(instance: unknown, method: string, path: string, body?: unknown): Promise<unknown>;
    };
    internal.instances.set(f.project.id, {
      status: { state: 'healthy' },
      runtimeModel: 'provider/model'
    });
    internal.gatewayJson = vi.fn(async (_instance, method, path, body) => {
      calls.push({ method, path, body });
      if (path.endsWith('/chat')) {
        const sessionId = path.split('/')[3];
        return {
          session_id: sessionId,
          message: { role: 'assistant', content: '真实回复' },
          usage: {},
          runtime: { provider: 'custom:opcnexus', model: 'provider/model' }
        };
      }
      return { object: 'ok' };
    });

    await f.manager.runProjectTurn(f.project.id, {
      conversationId,
      principalId,
      message: 'first',
      systemMessage: 'Delegate the explicitly mentioned employee @Frontend through the governed tool.'
    });
    const createdSessionId = (calls[0].body as { id: string }).id;
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/api/sessions',
      body: {
        model: 'provider/model',
        provider: 'custom:opcnexus',
        require_model_lock: true
      }
    });
    expect((calls[0].body as { title: string }).title).toMatch(/^OPC-Nexus project · [a-f0-9]{8}$/);
    expect(calls[1].path).toBe(`/api/sessions/${createdSessionId}/chat`);
    expect(calls[1].body).toMatchObject({
      system_message: expect.stringContaining('You are the fixed employee named "Builder".')
    });
    expect((calls[1].body as { system_message: string }).system_message)
      .toContain('Delegate the explicitly mentioned employee @Frontend');

    calls.length = 0;
    await f.manager.runProjectTurn(f.project.id, {
      conversationId,
      principalId,
      message: 'second'
    });
    expect(calls[0]).toEqual({
      method: 'POST',
      path: `/api/sessions/${createdSessionId}/model`,
      body: {
        model: 'provider/model',
        provider: 'custom:opcnexus',
        require_model_lock: true
      }
    });
    expect(calls[1].path).toBe(`/api/sessions/${createdSessionId}/chat`);
    expect(calls[1].body).toMatchObject({
      system_message: expect.stringContaining('You are the fixed employee named "Builder".')
    });
    expect(resolveConversationContext).toHaveBeenCalledTimes(2);
    expect(resolveConversationContext).toHaveBeenNthCalledWith(2, f.project.id, conversationId);
  });

  it.each(['long_term', 'short_term', 'none'] as const)(
    'sends the real %s employee memory policy on session creation and every turn',
    async (memoryMode) => {
      const f = fixture();
      const conversation = createConversation(f, `hermes-conversation-memory-${memoryMode}`);
      const now = Date.UTC(2026, 7, 18, 12, 0, 0);
      f.db.raw.prepare('UPDATE agents SET memory_mode = ? WHERE id = ?')
        .run(memoryMode, 'agent-real');
      f.db.raw.prepare(`
        INSERT INTO hermes_conversation_profiles(
          conversation_id, project_id, employee_id, created_at, updated_at
        ) VALUES(?, ?, 'agent-real', ?, ?)
      `).run(conversation.conversationId, f.project.id, now, now);
      f.manager.setSessionBinder((projectId, hermesSessionId, requested) => {
        if (!requested) throw new Error('Expected a requested conversation');
        f.db.raw.prepare(`
          INSERT INTO hermes_session_bindings(
            project_id, principal_id, conversation_id, hermes_session_id, last_seen_at
          ) VALUES(?, ?, ?, ?, ?)
        `).run(projectId, requested.principalId, requested.conversationId, hermesSessionId, now);
        return requested;
      });
      f.manager.setConversationContextResolver(() => `employee memory=${memoryMode}`);

      const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
      const internal = f.manager as unknown as {
        instances: Map<string, unknown>;
        gatewayJson(
          instance: unknown,
          method: string,
          path: string,
          body?: Record<string, unknown>
        ): Promise<unknown>;
      };
      internal.instances.set(f.project.id, {
        status: { state: 'healthy' },
        runtimeModel: 'provider/model'
      });
      internal.gatewayJson = vi.fn(async (_instance, _method, path, body = {}) => {
        calls.push({ path, body });
        if (path.endsWith('/chat')) {
          return {
            session_id: path.split('/')[3],
            message: { role: 'assistant', content: 'memory policy accepted' },
            usage: {},
            runtime: {}
          };
        }
        return { object: 'ok' };
      });

      const result = await f.manager.runProjectTurn(f.project.id, {
        ...conversation,
        message: 'remember according to policy'
      });
      const createBody = calls.find((call) => call.path === '/api/sessions')?.body;
      const chatBody = calls.find((call) => call.path.endsWith('/chat'))?.body;
      const expectedScope = expect.stringMatching(/^employee-[a-f0-9]{32}$/);
      expect(createBody).toMatchObject({
        nexus_memory_mode: memoryMode,
        nexus_memory_scope: expectedScope
      });
      expect(chatBody).toMatchObject({
        nexus_memory_mode: memoryMode,
        nexus_memory_scope: expectedScope
      });
      expect(result.runtime).toMatchObject({
        memoryMode,
        memoryScope: expectedScope
      });
    }
  );

  it('rotates a legacy employee session before reusing its conversation', async () => {
    const f = fixture();
    const conversation = createConversation(f, 'conversation-legacy-identity');
    const now = Date.UTC(2026, 7, 18, 12, 0, 0);
    f.db.raw.prepare(`
      INSERT INTO hermes_session_bindings(
        project_id, principal_id, conversation_id, hermes_session_id, identity_key, last_seen_at
      ) VALUES(?, ?, ?, 'legacy-cordis-session', NULL, ?)
    `).run(f.project.id, conversation.principalId, conversation.conversationId, now);
    f.manager.setConversationContextResolver(() => 'You are the fixed employee named "Builder".');
    const internal = f.manager as unknown as {
      instances: Map<string, unknown>;
      gatewayJson(instance: unknown, method: string, path: string, body?: unknown): Promise<unknown>;
    };
    internal.instances.set(f.project.id, { status: { state: 'healthy' }, runtimeModel: 'provider/model' });
    const calls: string[] = [];
    internal.gatewayJson = vi.fn(async (_instance, _method, path, body) => {
      calls.push(path);
      if (path.endsWith('/chat')) {
        const sessionId = path.split('/')[3];
        return { session_id: sessionId, message: { role: 'assistant', content: '真实回复' }, usage: {}, runtime: {} };
      }
      return { object: 'ok', ...(body && typeof body === 'object' ? body : {}) };
    });

    const first = await f.manager.runProjectTurn(f.project.id, {
      conversationId: conversation.conversationId,
      principalId: conversation.principalId,
      message: 'first'
    });
    expect(first.hermesSessionId).not.toBe('legacy-cordis-session');
    expect(calls.some((path) => path === '/api/sessions')).toBe(true);
    const binding = f.db.raw.prepare(`
      SELECT hermes_session_id, identity_key FROM hermes_session_bindings
      WHERE project_id = ? AND conversation_id = ?
    `).get(f.project.id, conversation.conversationId) as { hermes_session_id?: string; identity_key?: string };
    expect(binding.hermes_session_id).toBe(first.hermesSessionId);
    expect(binding.identity_key).toMatch(/^[a-f0-9]{64}$/);

    calls.length = 0;
    const second = await f.manager.runProjectTurn(f.project.id, {
      conversationId: conversation.conversationId,
      principalId: conversation.principalId,
      message: 'second'
    });
    expect(second.hermesSessionId).toBe(first.hermesSessionId);
    expect(calls).not.toContain('/api/sessions');
    expect(calls).toContain(`/api/sessions/${first.hermesSessionId}/model`);
  });

  it('deduplicates concurrent project history reads for one Hermes session', async () => {
    const f = fixture();
    const conversation = createConversation(f, 'conversation-history-dedup');
    const now = Date.UTC(2026, 7, 18, 12, 0, 0);
    f.db.raw.prepare(`
      INSERT INTO hermes_session_bindings(
        project_id, principal_id, conversation_id, hermes_session_id, identity_key, last_seen_at
      ) VALUES(?, ?, ?, 'nexus-history-dedup', NULL, ?)
    `).run(f.project.id, conversation.principalId, conversation.conversationId, now);
    const internal = f.manager as unknown as {
      instances: Map<string, unknown>;
      gatewayJson(instance: unknown, method: string, path: string, body?: unknown, timeoutMs?: number): Promise<unknown>;
    };
    internal.instances.set(f.project.id, { status: { state: 'healthy' }, runtimeModel: 'provider/model' });
    const pending = deferred<unknown>();
    const gatewayJson = vi.fn(() => pending.promise);
    internal.gatewayJson = gatewayJson;

    const first = f.manager.projectChatHistory(f.project.id, conversation.conversationId);
    const second = f.manager.projectChatHistory(f.project.id, conversation.conversationId);
    expect(gatewayJson).toHaveBeenCalledOnce();
    expect(gatewayJson).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      '/api/sessions/nexus-history-dedup/messages',
      undefined,
      10_000
    );

    pending.resolve({ session_id: 'nexus-history-dedup', data: [] });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ conversationId: conversation.conversationId, messages: [] }),
      expect.objectContaining({ conversationId: conversation.conversationId, messages: [] })
    ]);
  });

  it('recreates a missing upstream session instead of failing project history', async () => {
    const f = fixture();
    const conversation = createConversation(f, 'conversation-history-recovery');
    const now = Date.UTC(2026, 7, 18, 12, 0, 0);
    f.db.raw.prepare(`
      INSERT INTO hermes_session_bindings(
        project_id, principal_id, conversation_id, hermes_session_id, identity_key, last_seen_at
      ) VALUES(?, ?, ?, 'nexus-history-missing', NULL, ?)
    `).run(f.project.id, conversation.principalId, conversation.conversationId, now);
    const audit = vi.spyOn(f.db, 'audit');
    const internal = f.manager as unknown as {
      instances: Map<string, unknown>;
      gatewayJson(instance: unknown, method: string, path: string, body?: unknown, timeoutMs?: number): Promise<unknown>;
    };
    internal.instances.set(f.project.id, { status: { state: 'healthy' }, runtimeModel: 'provider/model' });
    const calls: string[] = [];
    internal.gatewayJson = vi.fn(async (_instance, method, path) => {
      calls.push(`${method} ${path}`);
      if (path.endsWith('/messages')) throw new Error('Session not found: nexus-history-missing');
      return { object: 'session.created' };
    });

    const history = await f.manager.projectChatHistory(f.project.id, conversation.conversationId);
    expect(history).toMatchObject({
      conversationId: conversation.conversationId,
      messages: []
    });
    expect(history.hermesSessionId).toMatch(/^nexus_/);
    expect(calls).toEqual([
      'GET /api/sessions/nexus-history-missing/messages',
      'POST /api/sessions'
    ]);
    const binding = f.db.raw.prepare(`
      SELECT hermes_session_id FROM hermes_session_bindings
      WHERE project_id = ? AND conversation_id = ?
    `).get(f.project.id, conversation.conversationId) as { hermes_session_id?: string };
    expect(binding.hermes_session_id).toBe(history.hermesSessionId);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'hermes.project.session.recover',
      target: f.project.id
    }));
  });

  it('does not turn a terminal Hermes provider error into a successful project reply', async () => {
    const f = fixture();
    const conversation = createConversation(f, 'hermes-conversation-provider-failure');
    const internal = f.manager as unknown as {
      instances: Map<string, unknown>;
      gatewayJson(instance: unknown, method: string, path: string, body?: unknown): Promise<unknown>;
    };
    internal.instances.set(f.project.id, {
      status: { state: 'healthy' },
      runtimeModel: 'provider/model'
    });
    internal.gatewayJson = vi.fn(async (_instance, _method, path, body) => {
      if (path.endsWith('/chat')) {
        return {
          session_id: (body as { id?: string })?.id ?? 'nexus_provider_failure',
          message: { role: 'assistant', content: 'API call failed after 3 retries: upstream stream was empty.' },
          usage: {},
          runtime: { provider: 'custom:opcnexus', model: 'provider/model' }
        };
      }
      return { object: 'ok' };
    });
    f.manager.setSessionBinder((_projectId, _hermesSessionId) => ({
      conversationId: conversation.conversationId,
      principalId: conversation.principalId
    }));

    await expect(f.manager.runProjectTurn(f.project.id, { message: 'hello' }))
      .rejects.toThrow('API call failed after 3 retries');
  });

  it.each([
    'HTTP 400: 请求参数不合法，请检查参数后重试。',
    'HTTP 502: upstream unavailable',
    'Request payload too large (413). Cannot compress further.'
  ])('rejects terminal Hermes error text instead of persisting success: %s', async (content) => {
    const f = fixture();
    const conversation = createConversation(f, 'hermes-conversation-terminal-text');
    const internal = f.manager as unknown as {
      instances: Map<string, unknown>;
      gatewayJson(instance: unknown, method: string, path: string, body?: unknown): Promise<unknown>;
    };
    internal.instances.set(f.project.id, { status: { state: 'healthy' }, runtimeModel: 'provider/model' });
    internal.gatewayJson = vi.fn(async (_instance, _method, path) => path.endsWith('/chat')
      ? {
          session_id: 'nexus_terminal_text',
          message: { role: 'assistant', content },
          usage: {},
          runtime: { provider: 'custom:opcnexus', model: 'provider/model' }
        }
      : { object: 'ok' });
    f.manager.setSessionBinder(() => ({
      conversationId: conversation.conversationId,
      principalId: conversation.principalId
    }));

    await expect(f.manager.runProjectTurn(f.project.id, { message: 'hello' }))
      .rejects.toThrow(content);
  });

  it('returns queued turns immediately and preserves FIFO within one conversation', async () => {
    const f = fixture();
    const binding = createConversation(f, 'conversation-fifo');
    const publishProjectEvent = attachHealthyInstance(f);
    const firstGate = deferred();
    const calls: string[] = [];
    vi.spyOn(f.manager, 'runProjectTurn').mockImplementation(async (projectId, input, stream) => {
      calls.push(input.message);
      stream?.onDelta?.(`${input.message}-delta`);
      if (input.message === 'first') await firstGate.promise;
      return turnResult(projectId, binding.conversationId, `${input.message}-done`);
    });

    const first = f.manager.enqueueProjectTurn(f.project.id, { ...binding, message: 'first' });
    const second = f.manager.enqueueProjectTurn(f.project.id, { ...binding, message: 'second' });
    expect(first).toMatchObject({ status: 'QUEUED', queuePosition: 1 });
    expect(second).toMatchObject({ status: 'QUEUED', queuePosition: 2 });
    expect(second.createdAt).toBeGreaterThan(first.createdAt);

    await vi.waitFor(() => expect(calls).toEqual(['first']));
    expect(f.manager.listProjectChatQueue(f.project.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, status: 'RUNNING' }),
      expect.objectContaining({ id: second.id, status: 'QUEUED', queuePosition: 1 })
    ]));
    firstGate.resolve();
    await vi.waitFor(() => expect(calls).toEqual(['first', 'second']));
    await vi.waitFor(() => expect(f.manager.listProjectChatQueue(f.project.id)).toEqual([]));
    expect(publishProjectEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat.queue.delta', delta: 'first-delta'
    }));
  });

  it('cancels a queued turn before execution and continues the conversation FIFO', async () => {
    const f = fixture();
    const binding = createConversation(f, 'conversation-cancel-queued');
    attachHealthyInstance(f);
    const firstGate = deferred();
    const calls: string[] = [];
    vi.spyOn(f.manager, 'runProjectTurn').mockImplementation(async (projectId, input) => {
      calls.push(input.message);
      if (input.message === 'first') await firstGate.promise;
      return turnResult(projectId, binding.conversationId, `${input.message}-done`);
    });

    f.manager.enqueueProjectTurn(f.project.id, { ...binding, message: 'first' });
    const cancelled = f.manager.enqueueProjectTurn(f.project.id, { ...binding, message: 'never-run' });
    await vi.waitFor(() => expect(calls).toEqual(['first']));
    expect(f.manager.cancelProjectTurn(f.project.id, cancelled.id)).toMatchObject({ status: 'CANCELLED' });
    firstGate.resolve();
    await vi.waitFor(() => expect(f.manager.listProjectChatQueue(f.project.id)).toEqual([
      expect.objectContaining({ id: cancelled.id, status: 'CANCELLED' })
    ]));
    expect(calls).toEqual(['first']);
  });

  it('waits for running-turn settlement before confirming cancellation and draining the next instruction', async () => {
    const f = fixture();
    const binding = createConversation(f, 'conversation-cancel-running');
    attachHealthyInstance(f);
    const calls: string[] = [];
    let interrupted = false;
    vi.spyOn(f.manager, 'runProjectTurn').mockImplementation((projectId, input, stream) => {
      calls.push(input.message);
      if (input.message !== 'running') {
        return Promise.resolve(turnResult(projectId, binding.conversationId, `${input.message}-done`));
      }
      return new Promise((_, reject) => {
        stream?.signal?.addEventListener('abort', () => {
          interrupted = true;
          reject(stream.signal?.reason ?? new Error('cancelled'));
        }, { once: true });
      });
    });

    const running = f.manager.enqueueProjectTurn(f.project.id, { ...binding, message: 'running' });
    f.manager.enqueueProjectTurn(f.project.id, { ...binding, message: 'next' });
    await vi.waitFor(() => expect(calls).toEqual(['running']));
    const cancellationRequest = f.manager.cancelProjectTurn(f.project.id, running.id);
    expect(cancellationRequest).toMatchObject({
      status: 'RUNNING',
      cancelRequestedAt: expect.any(Number),
      completedAt: null
    });
    expect(f.manager.cancelProjectTurn(f.project.id, running.id)).toEqual(cancellationRequest);
    await vi.waitFor(() => expect(interrupted).toBe(true));
    await vi.waitFor(() => expect(calls).toEqual(['running', 'next']));
    await vi.waitFor(() => expect(f.manager.listProjectChatQueue(f.project.id)).toEqual([
      expect.objectContaining({ id: running.id, status: 'CANCELLED' })
    ]));
  });

  it('does not let a late successful response overwrite owner cancellation', async () => {
    const f = fixture();
    const binding = createConversation(f, 'conversation-cancel-race');
    attachHealthyInstance(f);
    const lateResult = deferred<ReturnType<typeof turnResult>>();
    vi.spyOn(f.manager, 'runProjectTurn').mockImplementation(() => lateResult.promise);

    const running = f.manager.enqueueProjectTurn(f.project.id, { ...binding, message: 'late-success' });
    await vi.waitFor(() => expect(f.manager.listProjectChatQueue(f.project.id)).toEqual([
      expect.objectContaining({ id: running.id, status: 'RUNNING' })
    ]));
    f.manager.cancelProjectTurn(f.project.id, running.id);
    expect(f.manager.listProjectChatQueue(f.project.id)).toEqual([
      expect.objectContaining({
        id: running.id,
        status: 'RUNNING',
        cancelRequestedAt: expect.any(Number)
      })
    ]);
    lateResult.resolve(turnResult(f.project.id, binding.conversationId, 'must-not-complete'));
    await vi.waitFor(() => {
      const row = f.db.raw.prepare('SELECT status FROM hermes_chat_queue WHERE id = ?').get(running.id) as { status?: string };
      expect(row.status).toBe('CANCELLED');
    });
  });

  it('fails only the active turn and closes the project proxy when a Hermes process crashes', async () => {
    const f = fixture();
    const binding = createConversation(f, 'conversation-runtime-crash');
    const publishProjectEvent = attachHealthyInstance(f);
    const active = deferred<ReturnType<typeof turnResult>>();
    vi.spyOn(f.manager, 'runProjectTurn').mockImplementation(() => active.promise);

    const running = f.manager.enqueueProjectTurn(f.project.id, { ...binding, message: 'active-on-crash' });
    const queued = f.manager.enqueueProjectTurn(f.project.id, { ...binding, message: 'wait-for-restart' });
    await vi.waitFor(() => expect(f.manager.listProjectChatQueue(f.project.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: running.id, status: 'RUNNING' }),
      expect.objectContaining({ id: queued.id, status: 'QUEUED' })
    ])));

    const proxyStop = vi.fn(async () => {});
    const sibling = {
      exitCode: null as number | null,
      kill: vi.fn(function kill() {
        sibling.exitCode = 0;
        return true;
      }),
      once: vi.fn((_event: string, callback: () => void) => {
        queueMicrotask(callback);
        return sibling;
      })
    };
    const internal = f.manager as unknown as {
      instances: Map<string, Record<string, unknown>>;
      handleUnexpectedProcessFailure(
        instance: Record<string, unknown>,
        component: 'dashboard' | 'gateway',
        error: Error
      ): void;
    };
    const instance = internal.instances.get(f.project.id)!;
    Object.assign(instance, {
      projectId: f.project.id,
      homePath: f.manager.projectHome(f.project.id),
      process: { exitCode: 1 },
      gatewayProcess: sibling,
      proxy: { publishProjectEvent, stop: proxyStop },
      status: { ...f.manager.getStatus(f.project.id), state: 'healthy' },
      log: '',
      healthTimer: null,
      expectedStop: false,
      crashCleanup: null
    });

    internal.handleUnexpectedProcessFailure(instance, 'dashboard', new Error('synthetic dashboard crash'));
    await (instance.crashCleanup as Promise<void>);

    expect(proxyStop).toHaveBeenCalledOnce();
    expect(sibling.kill).toHaveBeenCalledWith('SIGTERM');
    expect((instance.status as { state: string; lastError: string }).state).toBe('error');
    expect((instance.status as { state: string; lastError: string }).lastError).toContain('synthetic dashboard crash');
    expect(f.manager.listProjectChatQueue(f.project.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: running.id,
        status: 'FAILED',
        error: expect.stringContaining('runtime stopped')
      }),
      expect.objectContaining({ id: queued.id, status: 'QUEUED' })
    ]));
    expect(publishProjectEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat.queue.updated',
      queueId: running.id,
      item: expect.objectContaining({ status: 'FAILED' })
    }));
  });

  it('drains different conversation tabs concurrently', async () => {
    const f = fixture();
    const firstBinding = createConversation(f, 'conversation-parallel-a');
    const secondBinding = createConversation(f, 'conversation-parallel-b');
    attachHealthyInstance(f);
    const gates = new Map([['alpha', deferred()], ['beta', deferred()]]);
    const calls: string[] = [];
    vi.spyOn(f.manager, 'runProjectTurn').mockImplementation(async (projectId, input) => {
      calls.push(input.message);
      await gates.get(input.message)!.promise;
      return turnResult(projectId, input.conversationId!, `${input.message}-done`);
    });

    f.manager.enqueueProjectTurn(f.project.id, { ...firstBinding, message: 'alpha' });
    f.manager.enqueueProjectTurn(f.project.id, { ...secondBinding, message: 'beta' });
    await vi.waitFor(() => expect(new Set(calls)).toEqual(new Set(['alpha', 'beta'])));
    expect(f.manager.listProjectChatQueue(f.project.id).filter((item) => item.status === 'RUNNING')).toHaveLength(2);
    gates.get('alpha')!.resolve();
    gates.get('beta')!.resolve();
    await vi.waitFor(() => expect(f.manager.listProjectChatQueue(f.project.id)).toEqual([]));
  });

  it('continues after a failed turn and retries the failure at the queue tail', async () => {
    const f = fixture();
    const binding = createConversation(f, 'conversation-retry');
    attachHealthyInstance(f);
    const calls: string[] = [];
    let failFirst = true;
    vi.spyOn(f.manager, 'runProjectTurn').mockImplementation(async (projectId, input) => {
      calls.push(input.message);
      if (input.message === 'fails' && failFirst) {
        failFirst = false;
        throw new Error('real upstream failure');
      }
      return turnResult(projectId, binding.conversationId, `${input.message}-done`);
    });

    const failed = f.manager.enqueueProjectTurn(f.project.id, { ...binding, message: 'fails' });
    f.manager.enqueueProjectTurn(f.project.id, { ...binding, message: 'continues' });
    await vi.waitFor(() => expect(calls).toEqual(['fails', 'continues']));
    await vi.waitFor(() => expect(f.manager.listProjectChatQueue(f.project.id)).toEqual([
      expect.objectContaining({ id: failed.id, status: 'FAILED', error: 'real upstream failure', attempts: 1 })
    ]));

    expect(() => f.manager.retryProjectTurn(
      f.project.id,
      failed.id,
      undefined as unknown as 'retry-failed-turn'
    )).toThrow('explicit owner confirmation');

    const retried = f.manager.retryProjectTurn(f.project.id, failed.id, 'retry-failed-turn');
    expect(retried).toMatchObject({ status: 'QUEUED', queuePosition: 1, attempts: 1, error: null });
    await vi.waitFor(() => expect(calls).toEqual(['fails', 'continues', 'fails']));
    await vi.waitFor(() => expect(f.manager.listProjectChatQueue(f.project.id)).toEqual([]));
  });

  it('marks a stale running turn as failed after process restart', () => {
    const f = fixture();
    const binding = createConversation(f, 'conversation-stale');
    const now = Date.UTC(2026, 7, 18, 12, 0, 0);
    f.db.raw.prepare(`
      INSERT INTO hermes_chat_queue(
        id, project_id, conversation_id, principal_id, message, status,
        attempts, stream_text, created_at, started_at, updated_at
      ) VALUES('hermes-chat-stale', ?, ?, ?, 'unfinished', 'RUNNING', 1, 'partial', ?, ?, ?)
    `).run(f.project.id, binding.conversationId, binding.principalId, now, now, now);

    const restarted = new HermesServiceManager(f.db, {
      root: join(f.root, 'restarted-homes'),
      resolveProjectWorkspace: () => f.workspace
    });
    expect(restarted.listProjectChatQueue(f.project.id)).toEqual([
      expect.objectContaining({
        id: 'hermes-chat-stale', status: 'FAILED', partialContent: 'partial',
        error: expect.stringContaining('restarted')
      })
    ]);
  });

  it('parses Hermes SSE deltas and authoritative completion metadata', async () => {
    const f = fixture();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: run.started\r\ndata: {"session_id":"session-stream"}\r\n\r\nevent: assistant.delta\r\ndata: {"delta":"你"}\r\n'));
        controller.enqueue(encoder.encode('\r\nevent: assistant.delta\ndata: {"delta":"好"}\n\nevent: assistant.completed\ndata: {"session_id":"session-stream","content":"你好","runtime":{"model":"provider/model"}}\n\n'));
        controller.enqueue(encoder.encode('event: run.completed\ndata: {"session_id":"session-stream","usage":{"total_tokens":2}}\n\n'));
        controller.close();
      }
    });
    const fetchMock = vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' }
    }));
    vi.stubGlobal('fetch', fetchMock);
    const deltas: string[] = [];
    const internal = f.manager as unknown as {
      gatewaySse(
        instance: { gatewayUrl: string; gatewayToken: string },
        path: string,
        body: unknown,
        timeoutMs: number,
        headers: Record<string, string>,
        handlers: { onDelta(delta: string): void }
      ): Promise<Record<string, unknown>>;
    };
    const response = await internal.gatewaySse(
      { gatewayUrl: 'http://127.0.0.1:61400', gatewayToken: 'ephemeral' },
      '/api/sessions/session-stream/chat/stream',
      { message: 'hello' },
      5_000,
      { 'x-hermes-session-key': 'project:conversation' },
      { onDelta: (delta) => deltas.push(delta) }
    );
    expect(deltas).toEqual(['你', '好']);
    expect(response).toMatchObject({
      session_id: 'session-stream',
      message: { role: 'assistant', content: '你好' },
      usage: { total_tokens: 2 },
      runtime: { model: 'provider/model' }
    });
    expect(fetchMock).toHaveBeenCalledWith(new URL('http://127.0.0.1:61400/api/sessions/session-stream/chat/stream'), expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ accept: 'text/event-stream' })
    }));
  });
});
