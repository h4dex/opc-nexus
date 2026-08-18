import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import initSqlJs from 'sql.js';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

import { Database } from '../src/main/services/database.js';
import { ProjectWorkbenchService } from '../src/main/services/projectWorkbench.js';
import type { DeliverableSummary } from '../src/shared/types.js';

const require = createRequire(import.meta.url);
let SQL: Awaited<ReturnType<typeof initSqlJs>>;
const openDatabases: InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>[] = [];

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
});

afterEach(() => {
  while (openDatabases.length) openDatabases.pop()!.close();
});

function fixture() {
  const inner = new SQL.Database();
  openDatabases.push(inner);
  const db = Reflect.construct(Database as unknown as new () => Database, []) as Database & { inner: typeof inner; scheduleSave: () => void };
  db.inner = inner;
  db.scheduleSave = () => {};
  (db as unknown as { flush: () => void }).flush = () => {};
  (db as unknown as { migrate: () => void }).migrate();
  const now = Date.UTC(2026, 7, 17, 12, 0, 0);
  inner.exec(`
    INSERT INTO engines(id, type, name, status) VALUES
      ('eng-dsh', 'dsh-managed', 'DSH', 'HEALTHY'),
      ('eng-hermes', 'hermes-cli', 'Hermes', 'HEALTHY');
    INSERT INTO agents(id, organization_id, name, role, engine_id, lifecycle, workspace, created_at, updated_at) VALUES
      ('agent-lead', 'org-local', '主 AI', '规划负责人', 'eng-dsh', 'READY', 'E:/opc/lead', ${now}, ${now}),
      ('agent-writer', 'org-local', '小说编辑', '固定员工', 'eng-hermes', 'READY', 'E:/opc/writer', ${now}, ${now}),
      ('agent-vision', 'org-local', '视觉分析员', '弹性员工', 'eng-dsh', 'READY', 'E:/opc/vision', ${now}, ${now});
    INSERT INTO projects(id, organization_id, name, objective, status, created_at, updated_at)
      VALUES ('project-a', 'org-local', 'OPC 小说创作', '完成第一章', 'active', ${now - 10_000}, ${now});
    INSERT INTO projects(id, organization_id, name, objective, status, created_at, updated_at)
      VALUES ('project-b', 'org-local', '隔离项目', '不应混入', 'active', ${now - 10_000}, ${now});
    INSERT INTO dsh_profiles(id, engine_id, version, created_at, updated_at)
      VALUES ('profile-dsh', 'eng-dsh', 1, ${now}, ${now});
    INSERT INTO dsh_runtime_instances(id, agent_id, profile_id, process_state, endpoint, created_at, updated_at)
      VALUES ('runtime-lead', 'agent-lead', 'profile-dsh', 'READY', 'http://127.0.0.1:3001', ${now}, ${now});
    INSERT INTO dsh_sessions(id, upstream_session_id, runtime_instance_id, agent_id, workspace, control_mode, delegation_depth, created_at, updated_at)
      VALUES ('session-root', 'up-root', 'runtime-lead', 'agent-lead', 'E:/opc/novel', 'NEXUS_MANAGED', 0, ${now}, ${now});
    INSERT INTO dsh_sessions(id, upstream_session_id, runtime_instance_id, agent_id, parent_session_id, workspace, control_mode, delegation_depth, created_at, updated_at)
      VALUES ('session-child', 'up-child', 'runtime-lead', 'agent-vision', 'session-root', 'E:/opc/novel', 'DELEGATED', 1, ${now}, ${now});
    INSERT INTO dsh_sessions(id, upstream_session_id, runtime_instance_id, agent_id, parent_session_id, workspace, control_mode, delegation_depth, created_at, updated_at)
      VALUES ('session-leaf', 'up-leaf', 'runtime-lead', 'agent-vision', 'session-child', 'E:/opc/novel', 'DELEGATED', 2, ${now}, ${now});
    INSERT INTO dsh_sessions(id, upstream_session_id, runtime_instance_id, agent_id, workspace, control_mode, delegation_depth, created_at, updated_at)
      VALUES ('session-other', 'up-other', 'runtime-lead', 'agent-lead', 'E:/opc/other', 'NEXUS_MANAGED', 0, ${now}, ${now});
  `);
  const insertTask = (id: string, title: string, status: string, progress: number, agentId: string, projectId: string, quality: string | null, createdAt = now) => {
    inner.run(
      `INSERT INTO tasks(id, agent_id, project_id, title, content, status, progress, quality, created_at, started_at, ended_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [id, agentId, projectId, title, title, status, progress, quality, createdAt, createdAt, status === 'COMPLETED' ? createdAt + 100 : null]
    );
  };
  insertTask('task-new', '补充创作需求', 'DRAFT', 0, 'agent-writer', 'project-a', null, now - 4_000);
  insertTask('task-plan', '整理章节计划', 'QUEUED', 10, 'agent-writer', 'project-a', null, now - 3_000);
  insertTask('task-run', '生成章节草稿', 'RUNNING', 55, 'agent-lead', 'project-a', null, now - 2_000);
  insertTask('task-accept', '验收人物关系图', 'WAITING_APPROVAL', 90, 'agent-vision', 'project-a', null, now - 1_000);
  insertTask('task-done', '完成章节交付', 'COMPLETED', 100, 'agent-writer', 'project-a', 'accepted', now - 500);
  insertTask('task-other', '其他项目任务', 'RUNNING', 50, 'agent-writer', 'project-b', null, now - 500);
  inner.exec(`
    INSERT INTO dsh_runs(id, session_id, nexus_task_id, upstream_state, created_at, updated_at)
      VALUES ('run-root', 'session-root', 'task-run', 'RUNNING', ${now}, ${now});
    INSERT INTO dsh_runs(id, session_id, nexus_task_id, upstream_state, created_at, updated_at)
      VALUES ('run-child', 'session-child', 'task-done', 'COMPLETED', ${now}, ${now});
    INSERT INTO dsh_runs(id, session_id, upstream_state, created_at, updated_at)
      VALUES ('run-leaf', 'session-leaf', 'QUEUED', ${now}, ${now});
    INSERT INTO dsh_runs(id, session_id, nexus_task_id, upstream_state, created_at, updated_at)
      VALUES ('run-other', 'session-other', 'task-other', 'RUNNING', ${now}, ${now});
    INSERT INTO usage_records(id, task_id, agent_id, model, input_tokens, output_tokens, total_tokens, created_at)
      VALUES ('usage-1', 'task-run', 'agent-lead', 'dsh-model', 100, 200, 300, ${now - 2_000});
    INSERT INTO usage_records(id, task_id, agent_id, model, input_tokens, output_tokens, total_tokens, created_at)
      VALUES ('usage-2', 'task-done', 'agent-writer', 'hermes-model', 80, 120, 200, ${now - 500});
    INSERT INTO dsh_events(session_id, seq, run_id, type, payload_json, created_at)
      VALUES ('session-root', 0, 'run-root', 'turn/end', '{"summary":"done; api_key=secret-value"}', ${now});
  `);
  const deliverables: DeliverableSummary[] = [
    { id: 'del-accepted', sourceType: 'task', sourceId: 'task-done', projectId: 'project-a', projectName: 'OPC 小说创作', ownerType: 'agent', ownerId: 'agent-writer', ownerName: '小说编辑', ownerRole: '固定员工', title: '章节 Markdown', type: 'document', tags: [], reviewStatus: 'accepted', reviewNote: '', latestVersion: 1, versionCount: 1, preview: '# 第一章', createdAt: now - 500, updatedAt: now - 500, sourceUpdatedAt: now - 500 },
    { id: 'del-review', sourceType: 'task', sourceId: 'task-accept', projectId: 'project-a', projectName: 'OPC 小说创作', ownerType: 'agent', ownerId: 'agent-vision', ownerName: '视觉分析员', ownerRole: '弹性员工', title: '人物关系图', type: 'design', tags: ['mermaid'], reviewStatus: 'unmarked', reviewNote: '', latestVersion: 1, versionCount: 1, preview: 'graph TD', createdAt: now - 1_000, updatedAt: now - 1_000, sourceUpdatedAt: now - 1_000 }
  ];
  return { db, inner, now, service: new ProjectWorkbenchService(db, { now: () => now, listDeliverables: () => deliverables }) };
}

describe('ProjectWorkbenchService', () => {
  it('projects a five-column delivery board and usage statistics per project', () => {
    const { service } = fixture();
    const view = service.get('project-a');
    expect(view.deliveryBoard.columns.map((column) => [column.stage, column.items.map((item) => item.id)])).toEqual([
      ['new', ['task-new']],
      ['planned', ['task-plan']],
      ['executing', ['task-run']],
      ['accepting', ['task-accept', 'del-review']],
      ['completed', ['task-done', 'del-accepted']]
    ]);
    expect(view.deliveryBoard.total).toBe(7);
    expect(view.deliveryBoard.completed).toBe(2);
    expect(view.usage.totalTokens).toBe(500);
    expect(view.usage.usageCount).toBe(2);
    expect(view.usage.completedTasks).toBe(1);
    expect(view.sessions.map((session) => session.sessionId)).toEqual(['session-root', 'session-child', 'session-leaf']);
    expect(view.rootSession).toMatchObject({ sessionId: 'session-root', kind: 'root' });
    expect(view.sessionTree).toHaveLength(1);
    expect(view.sessionTree[0]?.children[0]?.children[0]?.session.sessionId).toBe('session-leaf');
    expect(view.runs.map((run) => run.runId)).toEqual(expect.arrayContaining(['run-root', 'run-child', 'run-leaf']));
    expect(view.activeRuns.map((run) => run.runId).sort()).toEqual(['run-leaf', 'run-root']);
    expect(view.risks.map((risk) => risk.kind)).toContain('waiting_approval');
    expect(view.team.elastic[0]?.agentId).toBe('agent-vision');
  });

  it('keeps project facts isolated and redacts event summaries', () => {
    const { service } = fixture();
    const view = service.get('project-a');
    expect(view.deliveryBoard.columns.flatMap((column) => column.items).every((item) => item.id !== 'task-other')).toBe(true);
    expect(view.runs.every((run) => run.taskId !== 'task-other')).toBe(true);
    expect(view.recentEvents[0]?.summary).toContain('api_key=[REDACTED]');
    expect(view.recentEvents[0]?.summary).not.toContain('secret-value');
  });

  it('validates and persists non-secret Quest settings', () => {
    const { service } = fixture();
    expect(service.get('project-a').settings).toMatchObject({
      sandbox: 'workspace', permissionMode: 'autonomous', autoApproveLowRisk: true
    });
    const saved = service.saveSettings('project-a', {
      mode: 'quest', sandbox: 'strict', permissionMode: 'readonly', maxParallel: 4,
      workerAgentIds: ['agent-writer'], pluginIds: ['vision'], autoApproveLowRisk: true
    });
    expect(saved.mode).toBe('quest');
    expect(service.resolveExecutionContext('project-a', 'agent-lead').agentPreset).toBe('cordis');
    expect(service.get('project-a').settings).toEqual(saved);
    expect(() => service.saveSettings('project-a', { maxParallel: 99 })).toThrow();
    expect(() => service.saveSettings('project-a', { sandbox: 'unsafe' as never })).toThrow();
    expect(() => service.saveSettings('project-a', { autoApproveLowRisk: 'yes' as never })).toThrow();
    expect(() => service.saveSettings('project-a', { hiddenSecret: 'nope' } as never)).toThrow('未知字段');
    expect(() => service.saveSettings('project-a', { pluginIds: [' leading-space'] })).toThrow('无效 ID');
  });

  it('migrates a legacy standard Quest once without changing explicit readonly settings', () => {
    const { db, service } = fixture();
    db.setSetting('project:workbench:project-a', {
      settings: {
        mode: 'quest', sandbox: 'workspace', permissionMode: 'standard', model: null,
        workerAgentIds: [], pluginIds: [], maxParallel: 3, autoApproveLowRisk: false
      },
      rootSessionId: null,
      workspacePath: null
    });

    expect(service.get('project-a').settings).toMatchObject({
      permissionMode: 'autonomous', autoApproveLowRisk: true
    });
    const migrated = db.getSetting<{ policyVersion?: number }>('project:workbench:project-a', {});
    expect(migrated.policyVersion).toBe(2);

    service.saveSettings('project-a', { permissionMode: 'readonly', autoApproveLowRisk: false });
    expect(service.get('project-a').settings).toMatchObject({
      permissionMode: 'readonly', autoApproveLowRisk: false
    });
  });

  it('normalizes legacy direct preferences and client saves to Quest/Cordis', () => {
    const { db, service } = fixture();
    db.setSetting('project:workbench:project-a', {
      settings: {
        mode: 'direct', sandbox: 'strict', permissionMode: 'readonly', model: null,
        workerAgentIds: ['agent-writer'], pluginIds: ['vision'], maxParallel: 2,
        autoApproveLowRisk: false
      },
      rootSessionId: null,
      workspacePath: null
    });

    expect(service.get('project-a').settings.mode).toBe('quest');
    expect(service.resolveExecutionContext('project-a', 'agent-lead')).toMatchObject({
      agentPreset: 'cordis',
      quest: { mode: 'quest' }
    });

    const saved = service.saveSettings('project-a', {
      mode: 'direct'
    } as unknown as Parameters<ProjectWorkbenchService['saveSettings']>[1]);
    expect(saved.mode).toBe('quest');
    const persisted = db.getSetting<{ settings?: { mode?: string } }>('project:workbench:project-a', {});
    expect(persisted.settings?.mode).toBe('quest');
    expect(() => service.saveSettings('project-a', {
      mode: 'invalid'
    } as unknown as Parameters<ProjectWorkbenchService['saveSettings']>[1])).toThrow('模式无效');
  });

  it('resolves a path-free Cordis execution context and fails closed across project boundaries', () => {
    const { service, inner, now } = fixture();
    inner.exec(`
      INSERT INTO organizations(id, slug, name, created_at, updated_at)
        VALUES ('org-other', 'other', 'Other', ${now}, ${now});
      INSERT INTO agents(id, organization_id, name, role, engine_id, lifecycle, workspace, created_at, updated_at)
        VALUES ('agent-other', 'org-other', '其他组织员工', 'worker', 'eng-dsh', 'READY', 'E:/secret/other', ${now}, ${now});
    `);
    service.saveSettings('project-a', {
      mode: 'quest', sandbox: 'host', permissionMode: 'trusted', model: 'vision-model',
      workerAgentIds: ['agent-writer', 'agent-other'], pluginIds: ['vision'], maxParallel: 5,
      autoApproveLowRisk: true
    });

    const context = service.resolveExecutionContext('project-a', 'agent-lead');
    expect(context).toMatchObject({
      schemaVersion: 1,
      project: { id: 'project-a', name: 'OPC 小说创作', objective: '完成第一章' },
      agentPreset: 'cordis',
      quest: {
        mode: 'quest', sandbox: 'host', permissionMode: 'trusted', model: 'vision-model',
        workerAgentIds: ['agent-writer'], pluginIds: ['vision'], maxParallel: 5,
        autoApproveLowRisk: true
      },
      enforcement: {
        policyOwner: 'opc-nexus-governance', capabilityBrokerRequired: true,
        credentialMode: 'opaque-proxy', runtimeToolCeiling: 'managed-workspace-write'
      }
    });
    expect(JSON.stringify(context)).not.toContain('E:/');
    expect(JSON.stringify(context)).not.toContain('agent-other');
    expect(() => service.resolveExecutionContext('project-a', 'agent-other')).toThrow('不属于同一组织');
    expect(() => service.resolveExecutionContext('project-a', 'agent-lead', 'session-other')).toThrow('其他项目');

    inner.run(
      "UPDATE settings SET value_json = ? WHERE key = 'project:workbench:project-a'",
      [JSON.stringify({ settings: { mode: 'invalid', sandbox: 'unsafe', permissionMode: 'root', model: 'bad\u0000model', maxParallel: 999, workerAgentIds: [42], pluginIds: 'bad', autoApproveLowRisk: 'yes' } })]
    );
    expect(service.resolveExecutionContext('project-a', 'agent-lead')).toMatchObject({
      agentPreset: 'cordis',
      quest: {
        mode: 'quest', sandbox: 'workspace', permissionMode: 'autonomous', model: null,
        workerAgentIds: [], pluginIds: [], maxParallel: 3, autoApproveLowRisk: true
      }
    });
  });

  it('resolves a bound root workspace and falls back to a task workspace', () => {
    const { service, inner } = fixture();
    expect(service.getWorkspacePath('project-a')).toBe('E:/opc/novel');
    service.bindRootSession('project-a', 'session-root');
    service.bindRootSession('project-a', 'session-root');
    expect(service.getWorkspacePath('project-a')).toBe('E:/opc/novel');
    expect(inner.exec("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'quest.root.bind'")[0]?.values[0]?.[0]).toBe(1);
    expect(() => service.bindRootSession('project-a', 'session-other')).toThrow('其他项目');
    expect(() => service.bindRootSession('project-b', 'session-root')).toThrow('其他项目');
    inner.run("UPDATE dsh_sessions SET workspace = '' WHERE id = 'session-root'");
    expect(service.getWorkspacePath('project-a')).toBe('E:/opc/writer');
  });

  it('persists an explicit project workspace and gives it precedence over DSH inference', () => {
    const { db, service, inner } = fixture();
    service.setWorkspacePath('project-a', 'E:/opc/projects/novel');
    expect(service.getWorkspacePath('project-a')).toBe('E:/opc/projects/novel');

    inner.run("UPDATE dsh_sessions SET workspace = '' WHERE id = 'session-root'");
    expect(service.getWorkspacePath('project-a')).toBe('E:/opc/projects/novel');

    const preference = db.getSetting<Record<string, unknown>>('project:workbench:project-a', {});
    expect(preference.workspacePath).toBe('E:/opc/projects/novel');
    expect(() => service.setWorkspacePath('project-a', 'bad\u0000path')).toThrow();
  });
});
