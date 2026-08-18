import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import initSqlJs from 'sql.js';
import { createRequire } from 'node:module';
import { SecretaryPlanningRepository } from '../src/main/services/secretaryPlanningAdapters.js';
import { PlanningError } from '../src/main/services/secretaryPlanning.js';
import { SecretaryPlanningControlPlane } from '../src/main/services/secretaryPlanningControlPlane.js';

const require = createRequire(import.meta.url);
let SQL: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
});

type SqlJsDatabase = InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>;

function statement(db: SqlJsDatabase, sql: string) {
  return {
    run: (...params: unknown[]) => { db.run(sql, params); return { changes: db.getRowsModified() }; },
    get: (...params: unknown[]) => {
      const prepared = db.prepare(sql);
      try { prepared.bind(params); return prepared.step() ? prepared.getAsObject() : undefined; } finally { prepared.free(); }
    },
    all: (...params: unknown[]) => {
      const prepared = db.prepare(sql); const rows: Record<string, unknown>[] = [];
      try { prepared.bind(params); while (prepared.step()) rows.push(prepared.getAsObject()); return rows; } finally { prepared.free(); }
    }
  };
}

class TestDatabase {
  readonly inner: SqlJsDatabase;
  readonly raw: { prepare: (sql: string) => ReturnType<typeof statement> };
  readonly audit = vi.fn();
  constructor() {
    this.inner = new SQL.Database();
    this.inner.exec(`CREATE TABLE agents(
      id TEXT PRIMARY KEY, name TEXT, role TEXT, engine_id TEXT, organization_id TEXT,
      lifecycle TEXT, archived INTEGER, permission_mode TEXT, capabilities_json TEXT, created_at INTEGER
    )`);
    this.inner.run(`INSERT INTO agents VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      'agent-lead', '秘书负责人', '整合交付', 'eng-nexus', 'org-local', 'READY', 0, 'standard', '{"network":true}', 1
    ]);
    this.inner.run(`INSERT INTO agents VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      'agent-member', '研究负责人', '资料研究', 'eng-deepseek-harness-managed', 'org-local', 'READY', 0, 'standard', '{}', 2
    ]);
    this.raw = { prepare: (sql: string) => statement(this.inner, sql) };
  }
  transaction(operation: () => void): void { this.inner.exec('BEGIN'); try { operation(); this.inner.exec('COMMIT'); } catch (error) { this.inner.exec('ROLLBACK'); throw error; } }
  close(): void { this.inner.close(); }
}

function createControl(port: { createTask: (order: unknown) => { taskId: string } | Promise<{ taskId: string }> }) {
  const db = new TestDatabase();
  const repository = new SecretaryPlanningRepository(db as never);
  const control = new SecretaryPlanningControlPlane({ db: db as never, repository, dispatchPort: port, now: (() => { let n = 100; return () => ++n; })(), idFactory: (() => { let n = 0; return () => `id-${++n}`; })() });
  return { db, control };
}

const signals = {
  departmentIds: ['engineering', 'quality'], hasCrossTeamDependencies: true,
  ambiguousObjective: false, ambiguousScope: false, ambiguousAcceptance: false,
  estimatedDurationMinutes: 90, estimatedCost: 5, estimatedTokenCount: 80_000,
  requiresNewTeam: false, irreversibleOperations: ['write_files'] as const,
  compareAlternatives: false, phasedExecution: true, confirmBeforeExecution: true, estimatedTaskCount: 3
};

afterEach(() => vi.restoreAllMocks());

describe('SecretaryPlanningControlPlane', () => {
  it('creates a gated session with no task before questions and approval', () => {
    const createTask = vi.fn(() => ({ taskId: 'never-before-approval' }));
    const { db, control } = createControl({ createTask });
    const session = control.createSession({ request: '交付一份跨团队评估', signals });
    expect(session.status).toBe('NEEDS_INPUT');
    expect(session.questionSet?.questions.length).toBeGreaterThanOrEqual(1);
    expect(session.questionSet?.questions.length).toBeLessThanOrEqual(3);
    expect(session.dispatch.receipts).toHaveLength(0);
    expect(createTask).not.toHaveBeenCalled();
    db.close();
  });

  it('requires exact revision/hash and dispatches only after approval', async () => {
    const createTask = vi.fn((order: any) => ({ taskId: `task-${order.nodeId}` }));
    const { db, control } = createControl({ createTask });
    let session = control.createSession({ request: '交付一份跨团队评估', signals });
    const questionSet = session.questionSet!;
    session = control.answerQuestions({
      sessionId: session.id, expectedRevision: session.revision, questionSetVersion: questionSet.version,
      answers: questionSet.questions.map((question) => ({ questionId: question.id, selectedOptionIds: [question.options[0].id], text: null }))
    });
    session = control.proposePlan({ sessionId: session.id, expectedRevision: session.revision });
    const version = session.planVersions.at(-1)!;
    expect(session.status).toBe('PROPOSED');
    expect(() => control.approvePlan({ sessionId: session.id, expectedRevision: session.revision - 1, version: version.version, hash: version.hash })).toThrow('stale');
    session = control.approvePlan({ sessionId: session.id, expectedRevision: session.revision, version: version.version, hash: version.hash });
    expect(session.status).toBe('APPROVED');
    const result = await control.dispatchPlan({ sessionId: session.id, expectedRevision: session.revision, version: version.version, hash: version.hash });
    expect(result.ok).toBe(true);
    expect(result.view.status).toBe('DISPATCHED');
    expect(createTask).toHaveBeenCalled();
    db.close();
  });

  it('keeps partial receipts visible and allows retry', async () => {
    let fail = true;
    const createTask = vi.fn((order: any) => {
      if (fail && order.nodeId === 'node-02') throw new PlanningError('TEMPORARY', 'simulated node failure');
      return { taskId: `task-${order.nodeId}` };
    });
    const { db, control } = createControl({ createTask });
    let session = control.createSession({ request: '执行跨团队任务', signals });
    const questionSet = session.questionSet!;
    session = control.answerQuestions({ sessionId: session.id, expectedRevision: session.revision, questionSetVersion: questionSet.version, answers: questionSet.questions.map((q) => ({ questionId: q.id, selectedOptionIds: [q.id === 'execution-strategy' ? 'existing-team' : q.options[0].id], text: null })) });
    session = control.proposePlan({ sessionId: session.id, expectedRevision: session.revision });
    const version = session.planVersions.at(-1)!;
    session = control.approvePlan({ sessionId: session.id, expectedRevision: session.revision, version: version.version, hash: version.hash });
    let result = await control.dispatchPlan({ sessionId: session.id, expectedRevision: session.revision, version: version.version, hash: version.hash });
    expect(result.ok).toBe(false);
    expect(result.view.dispatch.receipts.length).toBeGreaterThan(0);
    fail = false;
    result = await control.dispatchPlan({ sessionId: result.view.id, expectedRevision: result.view.revision, version: version.version, hash: version.hash });
    expect(result.ok).toBe(true);
    expect(result.view.status).toBe('DISPATCHED');
    db.close();
  });

  it.each([
    {
      name: '软件工作室',
      request: '从零交付一个产品官网',
      questionId: 'acceptance-standard',
      optionId: 'runnable',
      expectedArtifact: 'README/启动命令',
      expectedCriterion: '项目目录内的启动命令返回 0，且本地预览可以访问。',
      answerText: '仅支持 Windows 11'
    },
    {
      name: '自媒体工作室',
      request: '制作 30 条短视频脚本和分镜',
      questionId: 'audience-channel',
      optionId: 'knowledge-professional',
      expectedArtifact: '事实核查记录',
      expectedCriterion: '关键事实可追溯到来源，术语和结论可由专业读者复核。',
      answerText: null
    },
    {
      name: '股票研究工作室',
      request: '分析三只股票并写风险报告',
      questionId: 'research-window',
      optionId: 'cross-market-3y',
      expectedArtifact: '跨市场 3 年对比数据表',
      expectedCriterion: '跨市场指标口径一致，数据、来源、采集时间和差异解释完整。',
      answerText: null
    },
    {
      name: '闲鱼运营工作室',
      request: '识别二手手机并估价和写商品文案',
      questionId: 'listing-boundary',
      optionId: 'draft-only',
      expectedArtifact: '闲鱼标题与详情草稿',
      expectedCriterion: '型号、成色假设和估价依据可复核；不发生任何外部发布或私信。',
      answerText: null
    }
  ])('projects $name clarification into artifacts and acceptance', ({
    request, questionId, optionId, expectedArtifact, expectedCriterion, answerText
  }) => {
    const { db, control } = createControl({ createTask: vi.fn(() => ({ taskId: 'unused' })) });
    let session = control.createSession({ request, signals });
    const questionSet = session.questionSet!;
    expect(questionSet.questions.some((question) => question.id === questionId)).toBe(true);
    session = control.answerQuestions({
      sessionId: session.id,
      expectedRevision: session.revision,
      questionSetVersion: questionSet.version,
      answers: questionSet.questions.map((question) => ({
        questionId: question.id,
        selectedOptionIds: [question.id === questionId ? optionId : question.options[0].id],
        text: question.id === questionId ? answerText : null
      }))
    });
    session = control.proposePlan({ sessionId: session.id, expectedRevision: session.revision });
    const plan = session.planVersions.at(-1)!.plan;
    expect(plan.dag.flatMap((node) => node.expectedArtifacts)).toContain(expectedArtifact);
    expect(plan.acceptanceCriteria).toContain(expectedCriterion);
    expect(plan.dag.at(-1)!.acceptanceCriteria).toContain(expectedCriterion);
    if (answerText) {
      expect(plan.assumptions).toContain(`老板补充边界（${questionId}）：${answerText}`);
      expect(plan.dag.at(-1)!.workOrder).toContain(answerText);
    }
    db.close();
  });
});
