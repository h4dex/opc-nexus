import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import initSqlJs from 'sql.js';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

import { DSH_MANAGED_ENGINE_ID } from '../src/shared/types.js';
import { Database } from '../src/main/services/database.js';
import { DshSessionService } from '../src/main/services/dshSessionService.js';
import { ProjectWorkbenchService } from '../src/main/services/projectWorkbench.js';
import {
  DshQuestSessionBindingService,
  type DshQuestRuntimeAuthority
} from '../src/main/services/dshQuestSessionBinding.js';
import type {
  DshControlPort,
  DshSessionSummary,
  DshWorkspaceSummary
} from '../src/main/services/dshControlClient.js';
import type { DshRuntimeStatus } from '../src/main/services/dshSupervisor.js';
import { dshManagedProjectProfileId } from '../src/main/services/deepseekHarnessManagedRuntime.js';

const require = createRequire(import.meta.url);
let SQL: Awaited<ReturnType<typeof initSqlJs>>;
const openDatabases: InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>[] = [];

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
});

afterEach(() => {
  while (openDatabases.length) openDatabases.pop()!.close();
});

function runtime(agentId: string): DshRuntimeStatus {
  return {
    agentId,
    profileId: 'opc-nexus-managed-web-v1',
    generation: 1,
    processState: 'READY',
    endpoint: 'http://127.0.0.1:3101',
    pid: 42,
    home: `C:/managed/${agentId}`,
    profileDirectory: `C:/managed/${agentId}/profiles/web`,
    workspace: `E:/projects/${agentId}`,
    startedAt: 1,
    readyAt: 2,
    lastHealthAt: 3,
    nextRestartAt: null,
    restartCount: 0,
    crashCount: 0,
    consecutiveFailures: 0,
    lastExit: null,
    lastError: null,
    recentLogs: []
  };
}

function fixture() {
  const inner = new SQL.Database();
  openDatabases.push(inner);
  const db = Reflect.construct(Database as unknown as new () => Database, []) as Database & {
    inner: typeof inner;
    scheduleSave: () => void;
  };
  db.inner = inner;
  db.scheduleSave = () => {};
  (db as unknown as { flush: () => void }).flush = () => {};
  (db as unknown as { migrate: () => void }).migrate();
  inner.exec(`
    INSERT INTO engines(id, type, name, status)
      VALUES('${DSH_MANAGED_ENGINE_ID}', 'dsh-managed', 'DSH', 'HEALTHY');
    INSERT INTO agents(
      id, organization_id, name, role, engine_id, lifecycle, workspace, created_at, updated_at
    ) VALUES
      ('agent-cordis', 'org-local', 'Cordis', 'Secretary', '${DSH_MANAGED_ENGINE_ID}', 'READY', 'E:/projects/cordis', 1, 1),
      ('agent-other', 'org-local', 'Other Cordis', 'Secretary', '${DSH_MANAGED_ENGINE_ID}', 'READY', 'E:/projects/other', 1, 1);
    INSERT INTO projects(id, organization_id, name, objective, status, created_at, updated_at)
      VALUES('project-quest', 'org-local', 'Quest', 'Deliver the project', 'active', 1, 1);
  `);
  const summaries: DshSessionSummary[] = [];
  const workspaces: DshWorkspaceSummary[] = [];
  const port = {
    listWorkspaces: vi.fn(async () => ({
      items: workspaces.map((item) => ({ ...item, sessionIds: [...item.sessionIds] })),
      archivedSessionIds: []
    })),
    createWorkspace: vi.fn(async (input: { path: string }) => {
      let workspace = workspaces.find((item) => item.path === input.path);
      const created = workspace === undefined;
      if (!workspace) {
        workspace = {
          workspaceId: `workspace-${workspaces.length + 1}`,
          path: input.path,
          title: input.path.split('/').at(-1) ?? input.path,
          sessionIds: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        };
        workspaces.push(workspace);
      }
      return { workspace: { ...workspace, sessionIds: [...workspace.sessionIds] }, created };
    }),
    listSessions: vi.fn(async () => summaries.map((item) => ({ ...item }))),
    createSession: vi.fn(async (input: {
      workspaceId?: string;
      cwd?: string;
      sessionId?: string;
      agentPreset?: string;
    }) => {
      const sessionId = String(input.sessionId);
      const workspace = workspaces.find((item) => item.workspaceId === input.workspaceId);
      const existing = summaries.find((item) => item.sessionId === sessionId);
      if (existing) {
        const requestedCwd = workspace?.path ?? input.cwd;
        if (existing.cwd !== requestedCwd) {
          throw new Error('DSH session root is immutable');
        }
      } else {
        summaries.push({
          sessionId,
          updatedAt: Date.now(),
          running: false,
          blank: true,
          ...(workspace?.path || input.cwd ? { cwd: workspace?.path ?? input.cwd } : {}),
          ...(input.agentPreset ? { agentPreset: input.agentPreset } : {})
        });
      }
      if (workspace && !workspace.sessionIds.includes(sessionId)) workspace.sessionIds.push(sessionId);
      return { sessionId, ...(input.agentPreset ? { agentPreset: input.agentPreset } : {}) };
    })
  };
  const supervisor = {
    start: vi.fn(async ({ agentId }: { agentId: string }) => runtime(agentId))
  };
  const sessions = new DshSessionService(db, { now: () => 1_000 });
  const workbench = new ProjectWorkbenchService(db, { now: () => 1_000 });
  workbench.setWorkspacePath('project-quest', 'E:/projects/project-specific');
  const service = new DshQuestSessionBindingService(
    db,
    sessions,
    supervisor as DshQuestRuntimeAuthority,
    workbench,
    { clientFactory: () => port as unknown as DshControlPort, sleep: async () => {} }
  );
  const agent = {
    id: 'agent-cordis',
    engineId: DSH_MANAGED_ENGINE_ID,
    workspace: 'E:/projects/cordis'
  };
  return { db, inner, summaries, workspaces, port, supervisor, sessions, workbench, service, agent };
}

describe('DshQuestSessionBindingService', () => {
  it('creates, persists, binds, and then reuses one deterministic Cordis root', async () => {
    const { inner, port, supervisor, workbench, service, agent } = fixture();
    workbench.setWorkspacePath('project-quest', 'E:/projects/project-specific');

    const first = await service.resolveOrCreate({
      projectId: 'project-quest', agent, requestedSessionId: null
    });

    expect(port.createSession).toHaveBeenCalledTimes(1);
    expect(port.createSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: first.upstreamSessionId,
      workspaceId: 'workspace-1',
      agentPreset: 'cordis'
    }), expect.stringMatching(/^dsh-quest-create-/));
    expect(port.createWorkspace).toHaveBeenCalledWith(
      { path: 'E:/projects/project-specific' },
      expect.stringMatching(/^dsh-quest-workspace-/)
    );
    expect(supervisor.start).toHaveBeenCalledWith({
      agentId: agent.id,
      profileId: dshManagedProjectProfileId('project-quest'),
      workspace: 'E:/projects/project-specific'
    });
    expect(workbench.get('project-quest').rootSession).toMatchObject({
      sessionId: first.localSessionId,
      agentId: agent.id
    });
    expect(inner.exec('SELECT COUNT(*) AS count FROM dsh_runtime_instances')[0]?.values[0]?.[0]).toBe(1);
    expect(inner.exec('SELECT COUNT(*) AS count FROM dsh_sessions')[0]?.values[0]?.[0]).toBe(1);

    const second = await service.resolveOrCreate({
      projectId: 'project-quest',
      agent,
      requestedSessionId: first.localSessionId
    });

    expect(second).toEqual(first);
    expect(port.createSession).toHaveBeenCalledTimes(1);
    expect(port.createWorkspace).toHaveBeenCalledTimes(2);
    expect(supervisor.start).toHaveBeenCalledTimes(2);
  });

  it('rebinds a project to a workspace-versioned root without reusing the old event cursor', async () => {
    const { inner, summaries, workspaces, port, sessions, workbench, service, agent } = fixture();
    workbench.setWorkspacePath('project-quest', 'E:/projects/original');
    const first = await service.resolveOrCreate({ projectId: 'project-quest', agent });
    const originalSummary = summaries.find((item) => item.sessionId === first.upstreamSessionId);
    sessions.upsertRun({
      id: 'run-original',
      sessionId: first.localSessionId,
      upstreamState: 'COMPLETED'
    });
    await sessions.projectEvent({
      sessionId: first.localSessionId,
      runId: 'run-original',
      seq: 0,
      type: 'assistant/message',
      protocolVersion: 'dsh-web/0.1.0-rc.6',
      payload: { data: 'original history' },
      createdAt: 1_000
    });

    workbench.setWorkspacePath('project-quest', 'E:/projects/moved');
    const migrated = await service.resolveOrCreate({
      projectId: 'project-quest',
      agent,
      requestedSessionId: first.localSessionId
    });

    expect(migrated.localSessionId).not.toBe(first.localSessionId);
    expect(migrated.upstreamSessionId).not.toBe(first.upstreamSessionId);
    expect(originalSummary).toMatchObject({
      sessionId: first.upstreamSessionId,
      cwd: 'E:/projects/original',
      agentPreset: 'cordis'
    });
    expect(summaries).toContainEqual(expect.objectContaining({
      sessionId: migrated.upstreamSessionId,
      cwd: 'E:/projects/moved',
      agentPreset: 'cordis'
    }));
    expect(workspaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'E:/projects/original', sessionIds: [first.upstreamSessionId] }),
      expect.objectContaining({ path: 'E:/projects/moved', sessionIds: [migrated.upstreamSessionId] })
    ]));
    expect(sessions.getSession(first.localSessionId)).toMatchObject({
      upstreamSessionId: first.upstreamSessionId,
      workspace: 'E:/projects/original',
      lastEventCursor: 0
    });
    expect(sessions.getSession(migrated.localSessionId)).toMatchObject({
      upstreamSessionId: migrated.upstreamSessionId,
      workspace: 'E:/projects/moved',
      lastEventCursor: -1
    });
    expect(workbench.get('project-quest').rootSession?.sessionId).toBe(migrated.localSessionId);
    expect(inner.exec('SELECT COUNT(*) AS count FROM dsh_sessions')[0]?.values[0]?.[0]).toBe(2);
    expect(inner.exec('SELECT COUNT(*) AS count FROM dsh_events')[0]?.values[0]?.[0]).toBe(1);
    expect(inner.exec("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'quest.root.bind'")[0]?.values[0]?.[0]).toBe(2);

    sessions.upsertRun({
      id: 'run-moved',
      sessionId: migrated.localSessionId,
      upstreamState: 'RUNNING'
    });
    await expect(sessions.projectEvent({
      sessionId: migrated.localSessionId,
      runId: 'run-moved',
      seq: 0,
      type: 'turn/start',
      protocolVersion: 'dsh-web/0.1.0-rc.6',
      payload: { data: 'moved history' },
      createdAt: 1_001
    })).resolves.toMatchObject({ duplicate: false });
    expect(inner.exec('SELECT COUNT(*) AS count FROM dsh_events')[0]?.values[0]?.[0]).toBe(2);

    const retried = await service.resolveOrCreate({
      projectId: 'project-quest',
      agent,
      requestedSessionId: migrated.localSessionId
    });

    expect(retried).toEqual(migrated);
    expect(port.createSession).toHaveBeenCalledTimes(2);
    expect(inner.exec('SELECT COUNT(*) AS count FROM dsh_sessions')[0]?.values[0]?.[0]).toBe(2);
    expect(inner.exec("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'quest.root.bind'")[0]?.values[0]?.[0]).toBe(2);
  });

  it('attaches a legacy cwd-created root to its official DSH workspace', async () => {
    const { workspaces, port, service, agent } = fixture();
    const first = await service.resolveOrCreate({ projectId: 'project-quest', agent });
    workspaces[0]!.sessionIds = [];

    const recovered = await service.resolveOrCreate({
      projectId: 'project-quest',
      agent,
      requestedSessionId: first.localSessionId
    });

    expect(recovered).toEqual(first);
    expect(port.createSession).toHaveBeenCalledTimes(2);
    expect(port.createSession).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceId: workspaces[0]!.workspaceId,
      sessionId: first.upstreamSessionId,
      agentPreset: 'cordis'
    }), expect.stringMatching(/^dsh-quest-create-/));
    expect(workspaces[0]!.sessionIds).toContain(first.upstreamSessionId);
  });

  it('recovers a missing upstream session from the durable project binding', async () => {
    const { summaries, port, service, agent } = fixture();
    const first = await service.resolveOrCreate({ projectId: 'project-quest', agent });
    summaries.length = 0;

    const recovered = await service.resolveOrCreate({
      projectId: 'project-quest',
      agent,
      requestedSessionId: first.localSessionId
    });

    expect(recovered).toEqual(first);
    expect(port.createSession).toHaveBeenCalledTimes(2);
    expect(summaries).toEqual([expect.objectContaining({
      sessionId: first.upstreamSessionId,
      agentPreset: 'cordis'
    })]);
  });

  it('reconciles an incomplete create receipt against an exact durable Cordis root', async () => {
    const { inner, summaries, workspaces, port, service, agent } = fixture();
    port.createSession.mockImplementationOnce(async (input) => {
      const sessionId = String(input.sessionId);
      const workspace = workspaces.find((item) => item.workspaceId === input.workspaceId)!;
      summaries.push({
        sessionId,
        updatedAt: Date.now(),
        running: false,
        blank: true,
        cwd: workspace.path,
        agentPreset: 'cordis'
      });
      workspace.sessionIds.push(sessionId);
      return { sessionId };
    });

    await expect(service.resolveOrCreate({
      projectId: 'project-quest', agent
    })).resolves.toMatchObject({
      localSessionId: expect.stringMatching(/^dsh-quest-/),
      upstreamSessionId: expect.stringMatching(/^dsh-quest-/)
    });

    expect(port.listSessions).toHaveBeenCalledTimes(2);
    expect(port.listWorkspaces).toHaveBeenCalledTimes(1);
    expect(inner.exec('SELECT COUNT(*) AS count FROM dsh_sessions')[0]?.values[0]?.[0]).toBe(1);
  });

  it('does not bind a newly created root whose durable preset is missing', async () => {
    const { inner, summaries, workspaces, port, workbench, service, agent } = fixture();
    port.createSession.mockImplementationOnce(async (input) => {
      const sessionId = String(input.sessionId);
      const workspace = workspaces.find((item) => item.workspaceId === input.workspaceId)!;
      summaries.push({
        sessionId,
        updatedAt: Date.now(),
        running: false,
        blank: true,
        cwd: workspace.path
      });
      workspace.sessionIds.push(sessionId);
      return { sessionId };
    });

    await expect(service.resolveOrCreate({
      projectId: 'project-quest', agent
    })).rejects.toThrow('Cordis preset');

    expect(workbench.get('project-quest').rootSession).toBeNull();
    expect(inner.exec('SELECT COUNT(*) AS count FROM dsh_sessions')[0]?.values[0]?.[0]).toBe(0);
  });

  it('rejects an existing project root when its Cordis preset is absent', async () => {
    const { summaries, port, service, agent } = fixture();
    const first = await service.resolveOrCreate({ projectId: 'project-quest', agent });
    delete summaries.find((item) => item.sessionId === first.upstreamSessionId)!.agentPreset;

    await expect(service.resolveOrCreate({
      projectId: 'project-quest',
      agent,
      requestedSessionId: first.localSessionId
    })).rejects.toThrow('Cordis preset');

    expect(port.createSession).toHaveBeenCalledTimes(1);
  });

  it('rejects a root owned by another employee before starting or mutating that runtime', async () => {
    const { port, supervisor, service, agent } = fixture();
    const first = await service.resolveOrCreate({ projectId: 'project-quest', agent });
    const other = {
      id: 'agent-other',
      engineId: DSH_MANAGED_ENGINE_ID,
      workspace: 'E:/projects/other'
    };

    await expect(service.resolveOrCreate({
      projectId: 'project-quest',
      agent: other,
      requestedSessionId: first.localSessionId
    })).rejects.toThrow('another employee');

    expect(supervisor.start).toHaveBeenCalledTimes(1);
    expect(port.createSession).toHaveBeenCalledTimes(1);
  });

  it('fails closed for a stale renderer session hint and a non-DSH employee', async () => {
    const { service, agent } = fixture();
    await expect(service.resolveOrCreate({
      projectId: 'project-quest',
      agent,
      requestedSessionId: 'stale-root'
    })).rejects.toThrow('current project root');
    await expect(service.resolveOrCreate({
      projectId: 'project-quest',
      agent: { ...agent, engineId: 'eng-local-cli' }
    })).rejects.toThrow('managed DSH');
  });
});
