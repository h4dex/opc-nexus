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
  const db = Reflect.construct(Database as unknown as new () => Database, []) as Database & {
    inner: typeof inner;
    scheduleSave: () => void;
  };
  db.inner = inner;
  db.scheduleSave = () => {};
  (db as unknown as { flush: () => void }).flush = () => {};
  (db as unknown as { migrate: () => void }).migrate();
  const now = Date.UTC(2026, 7, 22, 12, 0, 0);
  inner.exec(`
    INSERT INTO engines(id, type, name, status) VALUES
      ('eng-nexus', 'nexus', 'Nexus API', 'HEALTHY'),
      ('eng-codex', 'codex', 'Codex CLI', 'HEALTHY'),
      ('eng-claude', 'claude', 'Claude Code', 'HEALTHY');
    INSERT INTO agents(id, organization_id, name, role, engine_id, lifecycle, workspace, created_at, updated_at) VALUES
      ('agent-lead', 'org-local', '主秘书', '调度负责人', 'eng-nexus', 'READY', 'E:/opc/lead', ${now}, ${now}),
      ('agent-writer', 'org-local', '小说编辑', '固定员工', 'eng-codex', 'READY', 'E:/opc/writer', ${now}, ${now}),
      ('agent-vision', 'org-local', '视觉分析员', '弹性员工', 'eng-claude', 'READY', 'E:/opc/vision', ${now}, ${now});
    INSERT INTO projects(id, organization_id, name, objective, status, created_at, updated_at)
      VALUES ('project-a', 'org-local', 'OPC 小说创作', '完成第一章', 'active', ${now - 10_000}, ${now});
    INSERT INTO projects(id, organization_id, name, objective, status, created_at, updated_at)
      VALUES ('project-b', 'org-local', '隔离项目', '不应混入', 'active', ${now - 10_000}, ${now});
  `);
  const insertTask = (
    id: string,
    title: string,
    status: string,
    progress: number,
    agentId: string,
    projectId: string,
    quality: string | null,
    createdAt = now
  ) => {
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
    INSERT INTO usage_records(id, task_id, agent_id, model, input_tokens, output_tokens, total_tokens, created_at)
      VALUES ('usage-1', 'task-run', 'agent-lead', 'scheduler-model', 100, 200, 300, ${now - 2_000});
    INSERT INTO usage_records(id, task_id, agent_id, model, input_tokens, output_tokens, total_tokens, created_at)
      VALUES ('usage-2', 'task-done', 'agent-writer', 'worker-model', 80, 120, 200, ${now - 500});
  `);
  const deliverables: DeliverableSummary[] = [
    { id: 'del-accepted', sourceType: 'task', sourceId: 'task-done', projectId: 'project-a', projectName: 'OPC 小说创作', ownerType: 'agent', ownerId: 'agent-writer', ownerName: '小说编辑', ownerRole: '固定员工', title: '章节 Markdown', type: 'document', tags: [], reviewStatus: 'accepted', reviewNote: '', latestVersion: 1, versionCount: 1, preview: '# 第一章', createdAt: now - 500, updatedAt: now - 500, sourceUpdatedAt: now - 500 },
    { id: 'del-review', sourceType: 'task', sourceId: 'task-accept', projectId: 'project-a', projectName: 'OPC 小说创作', ownerType: 'agent', ownerId: 'agent-vision', ownerName: '视觉分析员', ownerRole: '弹性员工', title: '人物关系图', type: 'design', tags: ['mermaid'], reviewStatus: 'unmarked', reviewNote: '', latestVersion: 1, versionCount: 1, preview: 'graph TD', createdAt: now - 1_000, updatedAt: now - 1_000, sourceUpdatedAt: now - 1_000 }
  ];
  return {
    db,
    inner,
    now,
    service: new ProjectWorkbenchService(db, { now: () => now, listDeliverables: () => deliverables })
  };
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
    expect(view.usage).toMatchObject({ totalTokens: 500, usageCount: 2, completedTasks: 1, uniqueWorkers: 3 });
    expect(view.risks.map((risk) => risk.kind)).toContain('waiting_approval');
    expect(view).not.toHaveProperty('sessions');
    expect(view).not.toHaveProperty('runs');
  });

  it('keeps project facts isolated', () => {
    const { service } = fixture();
    const view = service.get('project-a');
    expect(view.deliveryBoard.columns.flatMap((column) => column.items).every((item) => item.id !== 'task-other')).toBe(true);
    expect(JSON.stringify(view)).not.toContain('隔离项目');
  });

  it('holds a completed Hermes plan in acceptance until its validation task passes', () => {
    const { db, now } = fixture();
    const service = new ProjectWorkbenchService(db, {
      now: () => now,
      listDeliverables: () => [],
      getDeliveryGate: (taskId) => taskId === 'task-done'
        ? {
            taskId,
            projectId: 'project-a',
            required: true,
            allowed: false,
            reason: '独立验收任务仍在 RUNNING',
            validationTaskId: 'task-review',
            validationVerdict: null
          }
        : {
            taskId,
            projectId: 'project-a',
            required: false,
            allowed: true,
            reason: null,
            validationTaskId: null,
            validationVerdict: null
          }
    });
    const board = service.get('project-a').deliveryBoard;
    expect(board.columns.find((column) => column.stage === 'accepting')?.items.map((item) => item.id)).toContain('task-done');
    expect(board.columns.find((column) => column.stage === 'completed')?.items.map((item) => item.id)).not.toContain('task-done');
  });

  it('validates Hermes settings and treats an empty employee pool as dynamic staffing', () => {
    const { service } = fixture();
    expect(service.getWorkerSelection('project-a')).toEqual({ mode: 'dynamic', workerAgentIds: [] });
    const saved = service.saveSettings('project-a', {
      mode: 'quest',
      orchestrator: 'hermes',
      sandbox: 'strict',
      permissionMode: 'readonly',
      maxParallel: 4,
      workerAgentIds: ['agent-writer'],
      pluginIds: ['skill:vision'],
      autoApproveLowRisk: false
    });
    expect(service.get('project-a').settings).toEqual(saved);
    expect(service.getWorkerSelection('project-a')).toEqual({ mode: 'restricted', workerAgentIds: ['agent-writer'] });
    expect(() => service.saveSettings('project-a', { maxParallel: 99 })).toThrow();
    expect(() => service.saveSettings('project-a', { orchestrator: 'retired' } as never)).toThrow('只支持 Hermes');
    expect(() => service.saveSettings('project-a', { hiddenSecret: 'nope' } as never)).toThrow('未知字段');
    expect(() => service.saveSettings('project-a', { pluginIds: ['legacy:plugin'] })).toThrow('仅支持已接入 Hermes');
  });

  it('migrates a retired scheduler preference to Hermes once', () => {
    const { db, service } = fixture();
    db.setSetting('project:workbench:project-a', {
      settings: {
        mode: 'quest',
        orchestrator: 'dsh',
        sandbox: 'workspace',
        permissionMode: 'standard',
        model: null,
        workerAgentIds: [],
        pluginIds: [],
        maxParallel: 3,
        autoApproveLowRisk: false
      },
      rootSessionId: 'retired-session',
      workspacePath: null
    });
    expect(service.get('project-a').settings).toMatchObject({
      orchestrator: 'hermes',
      permissionMode: 'autonomous',
      autoApproveLowRisk: true
    });
    const migrated = db.getSetting<Record<string, unknown>>('project:workbench:project-a', {});
    expect(migrated.policyVersion).toBe(5);
    expect(migrated).not.toHaveProperty('rootSessionId');
  });

  it('normalizes the old direct preference to Quest and removes unsupported project plugins', () => {
    const { db, service } = fixture();
    db.setSetting('project:workbench:project-a', {
      settings: {
        mode: 'direct',
        sandbox: 'strict',
        permissionMode: 'readonly',
        model: null,
        workerAgentIds: ['agent-writer'],
        pluginIds: ['vision'],
        maxParallel: 2,
        autoApproveLowRisk: false
      },
      workspacePath: null
    });
    expect(service.get('project-a').settings).toMatchObject({ mode: 'quest', pluginIds: [] });
    const saved = service.saveSettings('project-a', {
      mode: 'direct'
    } as unknown as Parameters<ProjectWorkbenchService['saveSettings']>[1]);
    expect(saved.mode).toBe('quest');
  });

  it('rejects employee restrictions across organization boundaries', () => {
    const { service, inner, now } = fixture();
    inner.exec(`
      INSERT INTO organizations(id, slug, name, created_at, updated_at)
        VALUES ('org-other', 'other', 'Other', ${now}, ${now});
      INSERT INTO agents(id, organization_id, name, role, engine_id, lifecycle, workspace, created_at, updated_at)
        VALUES ('agent-other', 'org-other', '其他组织员工', 'worker', 'eng-codex', 'READY', 'E:/secret/other', ${now}, ${now});
    `);
    expect(() => service.saveSettings('project-a', {
      workerAgentIds: ['agent-writer', 'agent-other']
    })).toThrow('固定员工 agent-other');
  });

  it('uses a project task workspace until the owner selects an explicit project directory', () => {
    const { db, service } = fixture();
    expect(service.getWorkspacePath('project-a')).toBe('E:/opc/writer');
    service.setWorkspacePath('project-a', 'E:/opc/projects/novel');
    expect(service.getWorkspacePath('project-a')).toBe('E:/opc/projects/novel');
    const preference = db.getSetting<Record<string, unknown>>('project:workbench:project-a', {});
    expect(preference.workspacePath).toBe('E:/opc/projects/novel');
    expect(() => service.setWorkspacePath('project-a', 'bad\u0000path')).toThrow();
  });
});
