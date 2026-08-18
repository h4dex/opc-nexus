import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

import { ArtifactRefService, isAuthorizedArtifactUrl } from '../src/main/services/artifactRef.js';
import { Database } from '../src/main/services/database.js';
import { DeliverableManager } from '../src/main/services/deliverableManager.js';
import { fixedRoutePolicy, DSH_LAN_RUNTIME_ID } from '../src/main/services/dshLanGatewayComposition.js';
import { DshQuestGovernanceService } from '../src/main/services/dshQuestGovernance.js';
import { DshSessionService } from '../src/main/services/dshSessionService.js';
import { DshSessionWriteCoordinator } from '../src/main/services/dshSessionWriteCoordinator.js';
import { ProjectManager } from '../src/main/services/projectManager.js';
import { ProjectWorkbenchService } from '../src/main/services/projectWorkbench.js';
import { SecretaryPlanningRepository } from '../src/main/services/secretaryPlanningAdapters.js';
import {
  hashCanonicalJson,
  type CompanyExecutionPlan,
  type DispatchPort,
  type DispatchWorkOrder,
  type IrreversibleOperation,
  type PlanningComplexitySignals,
  type PlanningQuestion
} from '../src/main/services/secretaryPlanning.js';
import { VisionService } from '../src/main/services/visionService.js';
import type { ArtifactKind, QuestSandbox } from '../src/shared/types.js';

const require = createRequire(import.meta.url);
let SQL: Awaited<ReturnType<typeof initSqlJs>>;
type SqlDatabase = InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>;
type TestDatabase = Database & { inner: SqlDatabase; scheduleSave: () => void };
const openDatabases: SqlDatabase[] = [];
const temporaryDirectories: string[] = [];
const encoder = new TextEncoder();

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
});

afterEach(() => {
  while (openDatabases.length) openDatabases.pop()!.close();
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

interface Scenario {
  key: 'novel' | 'video' | 'stock' | 'xianyu';
  name: string;
  objective: string;
  workerName: string;
  workerEngineType: string;
  sandbox: QuestSandbox;
  pluginIds: string[];
  artifactKind: ArtifactKind;
  artifactFilename: string;
  question: string;
  recommendation: string;
  irreversibleOperations: IrreversibleOperation[];
}

const SCENARIOS: readonly Scenario[] = [
  {
    key: 'novel',
    name: '小说创作 OPC',
    objective: '完成一章可连载、可复核的小说稿件',
    workerName: 'Hermes Writer',
    workerEngineType: 'hermes-cli',
    sandbox: 'workspace',
    pluginIds: ['markdown', 'vision'],
    artifactKind: 'markdown',
    artifactFilename: 'chapter.md',
    question: '本章优先推进情节还是人物弧光？',
    recommendation: 'character',
    irreversibleOperations: ['write_files']
  },
  {
    key: 'video',
    name: '自媒体影视制作 OPC',
    objective: '完成一条经过画面复核的短视频成片',
    workerName: 'Codex Producer',
    workerEngineType: 'codex-cli',
    sandbox: 'workspace',
    pluginIds: ['vision', 'video'],
    artifactKind: 'video',
    artifactFilename: 'final.mp4',
    question: '成片优先竖屏转化还是横屏叙事？',
    recommendation: 'vertical',
    irreversibleOperations: ['publish']
  },
  {
    key: 'stock',
    name: '股票分析 OPC',
    objective: '形成有来源、有风险声明的研究简报',
    workerName: 'Pi Analyst',
    workerEngineType: 'pi-cli',
    sandbox: 'strict',
    pluginIds: ['data', 'vision', 'chart'],
    artifactKind: 'chart',
    artifactFilename: 'risk.chart.json',
    question: '研究结论采用保守基准还是进取假设？',
    recommendation: 'conservative',
    irreversibleOperations: ['write_files']
  },
  {
    key: 'xianyu',
    name: '闲鱼回收和营销 OPC',
    objective: '完成回收线索筛选、商品图复核和营销交付',
    workerName: 'Hermes Operator',
    workerEngineType: 'hermes-cli',
    sandbox: 'workspace',
    pluginIds: ['browser', 'vision', 'marketing'],
    artifactKind: 'image',
    artifactFilename: 'listing.png',
    question: '首轮营销优先高毛利还是高周转？',
    recommendation: 'turnover',
    irreversibleOperations: ['send_external_message']
  }
] as const;

function wrapDatabase(bytes?: Uint8Array): TestDatabase {
  const inner = bytes ? new SQL.Database(bytes) : new SQL.Database();
  openDatabases.push(inner);
  const db = Reflect.construct(Database as unknown as new () => Database, []) as TestDatabase;
  db.inner = inner;
  db.scheduleSave = () => {};
  (db as unknown as { flush: () => void }).flush = () => {};
  if (!bytes) (db as unknown as { migrate: () => void }).migrate();
  return db;
}

function tempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function signals(scenario: Scenario): PlanningComplexitySignals {
  return {
    departmentIds: ['cordis', scenario.key, 'quality'],
    hasCrossTeamDependencies: true,
    ambiguousObjective: false,
    ambiguousScope: true,
    ambiguousAcceptance: true,
    estimatedDurationMinutes: 240,
    estimatedCost: 8,
    estimatedTokenCount: 80_000,
    requiresNewTeam: true,
    irreversibleOperations: scenario.irreversibleOperations,
    compareAlternatives: true,
    phasedExecution: true,
    confirmBeforeExecution: true,
    estimatedTaskCount: 5
  };
}

function question(scenario: Scenario): PlanningQuestion {
  return {
    id: `question-${scenario.key}-posture`,
    kind: 'single',
    prompt: scenario.question,
    options: [
      { id: scenario.recommendation, label: '推荐方案', impact: '保留独立验收并控制返工成本' },
      { id: 'alternative', label: '备选方案', impact: '缩短首轮交付时间但增加后续复核' }
    ],
    recommendedOptionId: scenario.recommendation,
    recommendationReason: 'Cordis 根据项目目标、风险和跨团队依赖给出该建议。',
    allowOther: true
  };
}

function executionPlan(
  scenario: Scenario,
  agentIds: { cordis: string; worker: string },
  visionAttachmentUri: string
): CompanyExecutionPlan {
  const node = (
    sequence: number,
    suffix: string,
    ownerAgentId: string,
    dependencies: string[],
    permissionProfile: 'readonly' | 'standard',
    requiredPermissions: string[],
    workOrder: string
  ): CompanyExecutionPlan['dag'][number] => ({
    nodeId: `node-${scenario.key}-${String(sequence).padStart(2, '0')}-${suffix}`,
    organizationId: 'org-local',
    ownerAgentId,
    dependencies,
    workOrder,
    expectedArtifacts: [`${scenario.key}-${suffix}.md`],
    acceptanceCriteria: [`${suffix} 满足已批准的 ${scenario.name} 项目边界`],
    permissionProfile,
    requiredPermissions,
    budget: { timeMinutes: 20, tokenLimit: 4_000, costLimit: 1 },
    retryPolicy: { maxAttempts: 2, backoff: 'linear' }
  });
  const ids = {
    brief: `node-${scenario.key}-01-brief`,
    plan: `node-${scenario.key}-02-plan`,
    execute: `node-${scenario.key}-03-execute`,
    accept: `node-${scenario.key}-04-accept`,
    deliver: `node-${scenario.key}-05-deliver`
  };
  return {
    schemaVersion: 1,
    organizationId: 'org-local',
    objective: scenario.objective,
    assumptions: ['项目工作区可用', `视觉输入使用不暴露宿主路径的 ${visionAttachmentUri}`],
    scope: { included: ['需求确认', '执行', '独立验收', '共同交付物'], excluded: ['未经老板批准的发布或交易'] },
    team: [{
      teamId: `team-${scenario.key}`,
      organizationId: 'org-local',
      leadAgentId: agentIds.cordis,
      memberAgentIds: [agentIds.worker],
      proposedEphemeralRoles: [`${scenario.key}-reviewer`]
    }],
    // DSH sends the canonical node-id order used by the durable hash projection.
    dag: [
      node(1, 'brief', agentIds.cordis, [], 'readonly', ['read'], `Cordis 明确边界并检查视觉输入 ${visionAttachmentUri}`),
      node(2, 'plan', agentIds.worker, [ids.brief], 'standard', ['read', 'write'], '固定数字员工整理可执行素材和计划。'),
      node(3, 'execute', agentIds.worker, [ids.plan], 'standard', ['read', 'write'], '固定数字员工执行主体工作。'),
      node(4, 'accept', agentIds.worker, [ids.execute], 'standard', ['read', 'write'], '弹性审阅角色复核阶段产物。'),
      node(5, 'deliver', agentIds.worker, [ids.accept], 'standard', ['read', 'write'], '汇总固定员工和弹性子 Agent 的共同交付物。')
    ],
    risks: [{ risk: '产物缺少可追溯依据', mitigation: '保留视觉输入、计划 hash 和验收记录', ownerAgentId: agentIds.cordis }],
    overallBudget: { timeMinutes: 120, tokenLimit: 30_000, costLimit: 8 },
    acceptanceCriteria: ['五个交付节点均可在项目看板追踪', '共同交付物经过老板验收']
  };
}

function artifactInput(scenario: Scenario): { kind: ArtifactKind; mediaType: string; filename: string; data: Uint8Array } {
  switch (scenario.artifactKind) {
    case 'markdown':
      return { kind: 'markdown', mediaType: 'text/markdown', filename: scenario.artifactFilename, data: encoder.encode(`# ${scenario.name}\n\nApproved shared output.`) };
    case 'video':
      return { kind: 'video', mediaType: 'video/mp4', filename: scenario.artifactFilename, data: new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109]) };
    case 'chart':
      return { kind: 'chart', mediaType: 'application/vnd.aibox.chart+json', filename: scenario.artifactFilename, data: encoder.encode('{"type":"bar","data":{"labels":["risk"],"datasets":[]}}') };
    case 'image':
      return { kind: 'image', mediaType: 'image/png', filename: scenario.artifactFilename, data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]) };
    default:
      throw new Error(`Unsupported scenario artifact kind: ${scenario.artifactKind}`);
  }
}

function seedScenario(scenario: Scenario) {
  const db = wrapDatabase();
  const now = Date.UTC(2026, 7, 17, 12, 0, 0);
  const agentIds = { cordis: `agent-${scenario.key}-cordis`, worker: `agent-${scenario.key}-worker` };
  const engineIds = { cordis: `engine-${scenario.key}-cordis`, worker: `engine-${scenario.key}-worker` };
  db.raw.prepare('INSERT INTO engines(id, type, name, status) VALUES(?, ?, ?, ?)')
    .run(engineIds.cordis, 'dsh-managed', 'DSH / Cordis', 'HEALTHY');
  db.raw.prepare('INSERT INTO engines(id, type, name, status) VALUES(?, ?, ?, ?)')
    .run(engineIds.worker, scenario.workerEngineType, scenario.workerName, 'HEALTHY');
  db.raw.prepare(`
    INSERT INTO agents(
      id, organization_id, name, role, engine_id, lifecycle, workspace,
      permission_mode, capabilities_json, created_at, updated_at
    ) VALUES(?, 'org-local', ?, ?, ?, 'READY', ?, 'standard', ?, ?, ?)
  `).run(agentIds.cordis, 'Cordis', 'Quest lead', engineIds.cordis, `E:/opc/${scenario.key}/cordis`, '{}', now, now);
  db.raw.prepare(`
    INSERT INTO agents(
      id, organization_id, name, role, engine_id, lifecycle, workspace,
      permission_mode, capabilities_json, created_at, updated_at
    ) VALUES(?, 'org-local', ?, ?, ?, 'READY', ?, 'standard', ?, ?, ?)
  `).run(agentIds.worker, scenario.workerName, 'Fixed project worker', engineIds.worker, `E:/opc/${scenario.key}/worker`, '{"write":true}', now, now);

  const projects = new ProjectManager(db);
  const project = projects.create({ name: scenario.name, objective: scenario.objective, status: 'active', color: '#4d6bfe' });
  const deliverables = new DeliverableManager(db);
  const workbench = new ProjectWorkbenchService(db, { now: () => now, listDeliverables: () => deliverables.list() });
  workbench.saveSettings(project.id, {
    mode: 'quest',
    sandbox: scenario.sandbox,
    permissionMode: 'standard',
    model: 'vision-model',
    workerAgentIds: [agentIds.worker],
    pluginIds: scenario.pluginIds,
    maxParallel: 4,
    autoApproveLowRisk: false
  });

  const sessions = new DshSessionService(db, { now: () => now });
  const profileId = `profile-${scenario.key}-cordis`;
  const runtimeId = `runtime-${scenario.key}-cordis`;
  const rootSessionId = `session-${scenario.key}-root`;
  const childSessionId = `session-${scenario.key}-child`;
  sessions.upsertProfile({ id: profileId, engineId: engineIds.cordis, version: 1, policy: { preset: 'cordis' } });
  sessions.upsertRuntimeInstance({
    id: runtimeId,
    agentId: agentIds.cordis,
    profileId,
    processState: 'READY',
    endpoint: 'http://127.0.0.1:3101',
    protocolVersion: '0.1.0-rc.6',
    capabilities: { goals: true, jobs: true, subagents: true }
  });
  sessions.upsertSession({
    id: rootSessionId,
    upstreamSessionId: `upstream-${scenario.key}-root`,
    runtimeInstanceId: runtimeId,
    agentId: agentIds.cordis,
    workspace: `E:/opc/${scenario.key}`,
    controlMode: 'NEXUS_MANAGED'
  });
  sessions.upsertSession({
    id: childSessionId,
    upstreamSessionId: `upstream-${scenario.key}-child`,
    runtimeInstanceId: runtimeId,
    agentId: agentIds.cordis,
    parentSessionId: rootSessionId,
    delegationDepth: 1,
    workspace: `E:/opc/${scenario.key}`,
    controlMode: 'DELEGATED'
  });

  const createTask = vi.fn((order: DispatchWorkOrder) => {
    const taskId = `task-${scenario.key}-${order.nodeId}`;
    db.raw.prepare(`
      INSERT INTO tasks(id, agent_id, project_id, title, content, source, source_key, status, progress, created_at)
      VALUES(?, ?, ?, ?, ?, 'dsh', ?, 'QUEUED', 0, ?)
      ON CONFLICT(source, source_key) WHERE source_key IS NOT NULL DO NOTHING
    `).run(taskId, order.ownerAgentId, project.id, order.workOrder, order.workOrder, order.idempotencyKey, now);
    const existing = db.raw.prepare("SELECT id FROM tasks WHERE source = 'dsh' AND source_key = ?")
      .get(order.idempotencyKey) as { id?: string } | undefined;
    return { taskId: String(existing?.id ?? taskId) };
  });
  const repository = new SecretaryPlanningRepository(db);
  const governance = new DshQuestGovernanceService({
    db,
    repository,
    dispatchPort: { createTask },
    workbench,
    now: () => now
  });
  return {
    db,
    now,
    project,
    deliverables,
    workbench,
    sessions,
    repository,
    governance,
    createTask,
    agentIds,
    rootSessionId,
    childSessionId
  };
}

async function createVisionEvidence(scenario: Scenario, db: TestDatabase) {
  const fetchVision = vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { content: `${scenario.key} visual evidence accepted` } }]
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const vision = new VisionService({
    attachmentRoot: tempDirectory(`aibox-${scenario.key}-vision-`),
    settings: db,
    providers: {
      resolveForAgentWithIdentity: (providerId, model) => providerId === 'provider-vision' && model === 'vision-model'
        ? { providerId, model, baseUrl: 'https://vision.example/v1', key: 'main-process-only-key' }
        : null
    },
    fetch: fetchVision,
    now: () => Date.UTC(2026, 7, 17, 12, 5, 0),
    imageInspector: { inspect: () => ({ width: 1, height: 1 }) }
  });
  vision.configureBinding({ providerId: 'provider-vision', model: 'vision-model' });
  const attachmentRef = await vision.putAttachment({
    data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]),
    mimeType: 'image/png',
    filename: `${scenario.key}-input.png`
  });
  const result = await vision.describe({ attachmentRef, prompt: `Review the visual input for ${scenario.key}.` });
  expect(result).toMatchObject({ ok: true, attachmentId: attachmentRef.id, providerId: 'provider-vision', model: 'vision-model' });
  expect(result.text).toContain(scenario.key);
  expect(attachmentRef.uri).toBe(`aibox-vision://attachment/${attachmentRef.id}`);
  return attachmentRef;
}

function createSharedArtifact(scenario: Scenario) {
  const root = tempDirectory(`aibox-${scenario.key}-artifact-`);
  const service = new ArtifactRefService({
    root,
    now: () => Date.UTC(2026, 7, 17, 12, 10, 0),
    randomToken: () => `${'A'.repeat(40)}${scenario.key}`
  });
  const ref = service.put(artifactInput(scenario));
  expect(isAuthorizedArtifactUrl(ref.uri)).toBe(true);
  expect(JSON.stringify(ref)).not.toContain(root);
  expect(service.resolveAuthorizedUrl(ref.uri).data).toEqual(Buffer.from(artifactInput(scenario).data));
  return ref;
}

function mobileRespondPolicy() {
  return fixedRoutePolicy(DSH_LAN_RUNTIME_ID, {
    runtimeId: DSH_LAN_RUNTIME_ID,
    method: 'POST',
    pathname: '/api/respond',
    search: '',
    websocket: false
  });
}

describe('v2.0 DSH/Cordis OPC scenario acceptance', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: Cordis governs a durable project delivery with fixed and elastic workers`, async () => {
      const fixture = seedScenario(scenario);
      const visionAttachment = await createVisionEvidence(scenario, fixture.db);
      const sharedArtifact = createSharedArtifact(scenario);
      const planningSessionId = `quest-${scenario.key}`;
      const questionSetId = `dsh-${scenario.key}-questions-v1`;
      const dshPlanId = `dsh-${scenario.key}-plan-v1`;

      let quest = fixture.governance.openQuest({
        planningSessionId,
        projectId: fixture.project.id,
        dshSessionId: fixture.rootSessionId,
        principalId: 'principal-local-admin',
        request: scenario.objective,
        signals: signals(scenario)
      });
      quest = fixture.governance.projectQuestionSet({
        planningSessionId,
        dshSessionId: fixture.rootSessionId,
        expectedRevision: quest.session.revision,
        questionSet: { id: questionSetId, version: 1, questions: [question(scenario)] }
      });
      expect(quest.session.status).toBe('NEEDS_INPUT');
      expect(quest.questionProjections[0]).toMatchObject({ dshQuestionSetId: questionSetId, dshVersion: 1 });

      // The official DSH mobile Web UI can answer server questions only as an
      // authenticated operator. A viewer cannot cross this approval boundary.
      const respond = mobileRespondPolicy();
      expect(respond).toMatchObject({ kind: 'rpc', methods: ['POST'], roles: ['operator'] });
      expect(respond?.kind === 'rpc' ? respond.rpc?.methods.respond.roles : []).toEqual(['operator']);
      quest = fixture.governance.answerQuestions({
        planningSessionId,
        principalId: 'principal-local-admin',
        expectedRevision: quest.session.revision,
        dshQuestionSetId: questionSetId,
        dshVersion: 1,
        answers: [{
          questionId: `question-${scenario.key}-posture`,
          selectedOptionIds: [scenario.recommendation],
          text: null
        }]
      });
      expect(quest.activeQuestionSet).toMatchObject({ answeredBy: 'principal-local-admin' });

      const plan = executionPlan(scenario, fixture.agentIds, visionAttachment.uri);
      const planHash = hashCanonicalJson(plan);
      quest = fixture.governance.projectPlan({
        planningSessionId,
        dshSessionId: fixture.rootSessionId,
        expectedRevision: quest.session.revision,
        plan: { id: dshPlanId, version: 1, hash: planHash, value: plan }
      });
      const projectedPlan = quest.planProjections[0]!;
      expect(projectedPlan).toMatchObject({ dshPlanId, dshVersion: 1, planHash });
      await expect(fixture.governance.dispatchPlan({
        planningSessionId,
        principalId: 'principal-local-admin',
        expectedRevision: quest.session.revision,
        dshPlanId,
        dshVersion: 1,
        hash: planHash
      })).rejects.toMatchObject({ code: 'PLAN_NOT_APPROVED' });
      expect(() => fixture.governance.approvePlan({
        planningSessionId,
        principalId: 'principal-local-admin',
        expectedRevision: quest.session.revision,
        dshPlanId,
        dshVersion: 1,
        hash: '0'.repeat(64)
      })).toThrowError(expect.objectContaining({ code: 'PLAN_HASH_MISMATCH' }));

      quest = fixture.governance.approvePlan({
        planningSessionId,
        principalId: 'principal-local-admin',
        expectedRevision: quest.session.revision,
        dshPlanId,
        dshVersion: 1,
        hash: planHash
      });
      expect(quest.session.approvedPlanHash).toBe(planHash);
      expect(quest.planVersions[0]).toMatchObject({ status: 'APPROVED', approvedBy: 'principal-local-admin' });
      quest = await fixture.governance.dispatchPlan({
        planningSessionId,
        principalId: 'principal-local-admin',
        expectedRevision: quest.session.revision,
        dshPlanId,
        dshVersion: 1,
        hash: planHash
      });
      expect(quest.session.status).toBe('DISPATCHED');
      expect(quest.dispatchReceipts).toHaveLength(5);
      expect(fixture.createTask).toHaveBeenCalledTimes(5);

      const receiptByNode = new Map(quest.dispatchReceipts.map((receipt) => [receipt.nodeId, receipt]));
      const taskStates = [
        { suffix: '01-brief', status: 'DRAFT', progress: 0, quality: null },
        { suffix: '02-plan', status: 'QUEUED', progress: 15, quality: null },
        { suffix: '03-execute', status: 'RUNNING', progress: 55, quality: null },
        { suffix: '04-accept', status: 'WAITING_APPROVAL', progress: 90, quality: null },
        { suffix: '05-deliver', status: 'COMPLETED', progress: 100, quality: 'accepted' }
      ] as const;
      for (const [index, state] of taskStates.entries()) {
        const receipt = receiptByNode.get(`node-${scenario.key}-${state.suffix}`)!;
        fixture.db.raw.prepare(`
          UPDATE tasks SET status = ?, progress = ?, quality = ?,
            started_at = ?, ended_at = ? WHERE id = ?
        `).run(
          state.status,
          state.progress,
          state.quality,
          state.status === 'DRAFT' || state.status === 'QUEUED' ? null : fixture.now + index,
          state.status === 'COMPLETED' ? fixture.now + index + 1 : null,
          receipt.taskId
        );
        fixture.db.raw.prepare(`
          INSERT INTO usage_records(id, task_id, agent_id, model, input_tokens, output_tokens, total_tokens, created_at)
          SELECT ?, id, agent_id, 'scenario-model', ?, ?, ?, ? FROM tasks WHERE id = ?
        `).run(`usage-${scenario.key}-${index}`, 100 + index, 150 + index, 250 + index * 10, fixture.now + index, receipt.taskId);
      }

      const teamId = `team-${scenario.key}-delivery`;
      const teamRunId = `team-run-${scenario.key}-delivery`;
      fixture.db.raw.prepare(`
        INSERT INTO teams(id, name, coordinator_id, member_ids, mode, workspace, created_at)
        VALUES(?, ?, ?, ?, 'coordinate', ?, ?)
      `).run(
        teamId,
        `${scenario.name} delivery team`,
        fixture.agentIds.cordis,
        JSON.stringify([fixture.agentIds.worker, fixture.childSessionId]),
        `E:/opc/${scenario.key}`,
        fixture.now
      );
      fixture.db.raw.prepare(`
        INSERT INTO team_runs(
          id, team_id, project_id, task_text, phase, current_step, total_steps,
          subtasks_json, events_json, final_result, created_at, ended_at
        ) VALUES(?, ?, ?, ?, 'done', 5, 5, '[]', '[]', ?, ?, ?)
      `).run(
        teamRunId,
        teamId,
        fixture.project.id,
        `${scenario.name} shared delivery`,
        JSON.stringify({
          artifactRef: sharedArtifact,
          contributors: [fixture.agentIds.cordis, fixture.agentIds.worker, fixture.childSessionId],
          approvedPlanHash: planHash
        }),
        fixture.now,
        fixture.now + 10
      );

      const executeTaskId = receiptByNode.get(`node-${scenario.key}-03-execute`)!.taskId;
      const acceptTaskId = receiptByNode.get(`node-${scenario.key}-04-accept`)!.taskId;
      fixture.sessions.upsertRun({
        id: `run-${scenario.key}-root`,
        sessionId: fixture.rootSessionId,
        nexusTaskId: executeTaskId,
        upstreamState: 'RUNNING',
        checkpointRef: `checkpoint://${scenario.key}/root`
      });
      fixture.sessions.upsertRun({
        id: `run-${scenario.key}-child`,
        sessionId: fixture.childSessionId,
        nexusTaskId: acceptTaskId,
        teamRunId,
        upstreamState: 'RUNNING',
        checkpointRef: `checkpoint://${scenario.key}/child`
      });

      const writes = new DshSessionWriteCoordinator(fixture.sessions, 'LAN');
      const cancelClaim = writes.claim({
        clientSessionId: `mobile-${scenario.key}-owner`,
        agentId: fixture.agentIds.cordis,
        method: 'session.cancel',
        payload: {
          type: 'client-request',
          rpcId: `rpc-${scenario.key}-cancel`,
          method: 'session.cancel',
          payload: { sessionId: `upstream-${scenario.key}-root` }
        }
      });
      writes.completeClaim(cancelClaim, { cancelled: true });
      fixture.sessions.upsertRun({
        id: `run-${scenario.key}-root`,
        sessionId: fixture.rootSessionId,
        nexusTaskId: executeTaskId,
        commandId: cancelClaim.commandId,
        upstreamState: 'CANCELLED',
        checkpointRef: `checkpoint://${scenario.key}/root`
      });
      const failedClaim = writes.claim({
        clientSessionId: `mobile-${scenario.key}-reviewer`,
        agentId: fixture.agentIds.cordis,
        method: 'session.prompt',
        payload: {
          type: 'client-request',
          rpcId: `rpc-${scenario.key}-failed`,
          method: 'session.prompt',
          payload: { sessionId: `upstream-${scenario.key}-child`, mode: 'queue', content: [] }
        }
      });
      writes.failClaim(failedClaim, 'scenario worker failed after retry budget');
      fixture.sessions.upsertRun({
        id: `run-${scenario.key}-child`,
        sessionId: fixture.childSessionId,
        nexusTaskId: acceptTaskId,
        teamRunId,
        commandId: failedClaim.commandId,
        upstreamState: 'FAILED',
        checkpointRef: `checkpoint://${scenario.key}/child`
      });
      writes.releaseAll();
      expect(fixture.sessions.getCommandReceipt(`rpc-${scenario.key}-cancel`)).toMatchObject({ status: 'COMPLETED', result: { cancelled: true } });
      expect(fixture.sessions.getCommandReceipt(`rpc-${scenario.key}-failed`)).toMatchObject({ status: 'FAILED', error: 'scenario worker failed after retry budget' });

      const synced = fixture.deliverables.list();
      expect(synced).toHaveLength(1);
      expect(synced[0]).toMatchObject({ sourceType: 'team_run', sourceId: teamRunId, projectId: fixture.project.id });
      const reviewed = fixture.deliverables.review(synced[0]!.id, { status: 'accepted', note: 'Boss accepted shared delivery.' });
      expect(reviewed?.deliverable.reviewStatus).toBe('accepted');
      expect(fixture.deliverables.packageForProject(fixture.project.id).summary).toMatchObject({ total: 1, accepted: 1 });

      const workbench = fixture.workbench.get(fixture.project.id);
      expect(workbench.rootSession?.sessionId).toBe(fixture.rootSessionId);
      expect(workbench.settings).toMatchObject({ mode: 'quest', sandbox: scenario.sandbox, workerAgentIds: [fixture.agentIds.worker] });
      expect(workbench.team.fixed.map((member) => member.agentId)).toEqual(expect.arrayContaining([fixture.agentIds.cordis, fixture.agentIds.worker]));
      expect(workbench.team.elastic.map((member) => member.agentId)).toContain(fixture.agentIds.cordis);
      expect(workbench.sessions.find((session) => session.sessionId === fixture.childSessionId)).toMatchObject({ kind: 'elastic-worker', depth: 1 });
      expect(workbench.deliveryBoard.columns.map((column) => column.items.length)).toEqual([1, 1, 1, 1, 2]);
      expect(workbench.deliverables[0]).toMatchObject({ sourceId: teamRunId, reviewStatus: 'accepted' });
      expect(workbench.usage).toMatchObject({ totalTasks: 5, usageCount: 5 });
      expect(workbench.usage.totalTokens).toBeGreaterThan(0);
      expect(fixture.workbench.getWorkspacePath(fixture.project.id)).toBe(`E:/opc/${scenario.key}`);

      const snapshot = fixture.db.inner.export();
      const reopenedDb = wrapDatabase(snapshot);
      const reopenedDeliverables = new DeliverableManager(reopenedDb);
      const reopenedWorkbench = new ProjectWorkbenchService(reopenedDb, {
        now: () => fixture.now,
        listDeliverables: () => reopenedDeliverables.list()
      });
      const replayCreateTask = vi.fn((order: DispatchWorkOrder) => ({ taskId: `unexpected-${order.nodeId}` }));
      const reopenedGovernance = new DshQuestGovernanceService({
        db: reopenedDb,
        repository: new SecretaryPlanningRepository(reopenedDb),
        dispatchPort: { createTask: replayCreateTask } satisfies DispatchPort,
        workbench: reopenedWorkbench,
        now: () => fixture.now + 20
      });
      const reopenedSessions = new DshSessionService(reopenedDb, { now: () => fixture.now + 20 });
      const restoredQuest = reopenedGovernance.getQuest(planningSessionId);
      expect(restoredQuest).toMatchObject({
        binding: { projectId: fixture.project.id, dshSessionId: fixture.rootSessionId },
        session: { status: 'DISPATCHED', approvedPlanHash: planHash },
        questionProjections: [{ dshQuestionSetId: questionSetId, dshVersion: 1 }],
        planProjections: [{ dshPlanId, dshVersion: 1, planHash }]
      });
      expect(restoredQuest.dispatchReceipts).toHaveLength(5);
      expect(reopenedSessions.getRun(`run-${scenario.key}-root`)).toMatchObject({ upstreamState: 'CANCELLED', checkpointRef: `checkpoint://${scenario.key}/root` });
      expect(reopenedSessions.getRun(`run-${scenario.key}-child`)).toMatchObject({ upstreamState: 'FAILED', checkpointRef: `checkpoint://${scenario.key}/child` });
      expect(reopenedSessions.getCommandReceipt(`rpc-${scenario.key}-cancel`).status).toBe('COMPLETED');
      expect(reopenedSessions.getCommandReceipt(`rpc-${scenario.key}-failed`).status).toBe('FAILED');
      expect(reopenedWorkbench.get(fixture.project.id).deliveryBoard.columns.map((column) => column.items.length)).toEqual([1, 1, 1, 1, 2]);

      const replayed = await reopenedGovernance.dispatchPlan({
        planningSessionId,
        principalId: 'principal-local-admin',
        expectedRevision: restoredQuest.session.revision,
        dshPlanId,
        dshVersion: 1,
        hash: planHash
      });
      expect(replayed.dispatchReceipts).toHaveLength(5);
      expect(replayCreateTask).not.toHaveBeenCalled();
      const taskCount = reopenedDb.raw.prepare('SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?')
        .get(fixture.project.id) as { count: number };
      expect(Number(taskCount.count)).toBe(5);
    });
  }
});
