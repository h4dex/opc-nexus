import type { Database } from './database.js';
import {
  PlanningError,
  SecretaryPlanningService,
  type CompanyExecutionPlan,
  type DispatchPort,
  type PlanBudget,
  type PlanDagNode,
  type PlanValidationPolicy,
  type PlanningAgentSnapshot,
  type PlanningComplexitySignals,
  type PlanningQuestion,
  type PlanningQuestionAnswer,
  type PlanningRepository,
  type PlanningSession,
  type QuestionSet,
  type PlanVersionRecord
} from './secretaryPlanning.js';
import type {
  AnswerPlanningQuestionsInput,
  ApprovePlanningPlanInput,
  CreatePlanningSessionInput,
  DispatchPlanningPlanInput,
  PlanningAgentView,
  PlanningBudgetView,
  PlanningComplexitySignalsInput,
  PlanningDispatchReceiptView,
  PlanningDispatchResult,
  PlanningDispatchView,
  PlanningGateDecisionView,
  PlanningPlanVersionView,
  PlanningPlanView,
  PlanningQuestionAnswerInput,
  PlanningQuestionSetView,
  PlanningSessionListItem,
  PlanningSessionView,
  ProposePlanningPlanInput,
  RejectPlanningPlanInput
} from '../../shared/types.js';

export const LOCAL_PLANNING_ORGANIZATION_ID = 'org-local';
export const LOCAL_PLANNING_PRINCIPAL_ID = 'principal-local-admin';

type Row = Record<string, unknown>;
type PlanningDatabase = Pick<Database, 'raw' | 'audit'>;

type PlanningRepositoryWithLists = PlanningRepository & {
  listSessions?: (limit: number) => PlanningSession[];
  listPlanVersions?: (sessionId: string) => PlanVersionRecord[];
};

interface AgentRecord {
  id: string;
  name: string;
  role: string;
  engineId: string;
  organizationId: string;
  lifecycle: PlanningAgentSnapshot['lifecycle'];
  archived: boolean;
  permissionMode: string;
  capabilities: Record<string, boolean>;
  createdAt: number;
}

interface DispatchFailure {
  code: string;
  message: string;
}

interface ControlPlaneDependencies {
  db: PlanningDatabase;
  repository: PlanningRepository;
  dispatchPort: DispatchPort;
  now?: () => number;
  idFactory?: () => string;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_SESSION_LIST = 100;
const MAX_REQUEST_LENGTH = 20_000;
const PERMISSION_PROFILES = ['readonly', 'standard', 'trusted', 'autonomous'] as const;
const CAPABILITY_NAMES = ['network', 'shell', 'install', 'browser', 'computer', 'mobile'] as const;
const OPERATION_PERMISSION: Record<string, string> = {
  write_files: 'write',
  install_software: 'install',
  send_external_message: 'network',
  production_change: 'shell',
  payment: 'network',
  delete_data: 'write',
  publish: 'network'
};

function invalid(message: string): never {
  throw new PlanningError('INVALID_INPUT', message);
}

function assertText(value: unknown, field: string, max = MAX_REQUEST_LENGTH): string {
  if (typeof value !== 'string') invalid(`${field} must be text`);
  const text = value.trim();
  if (text.length === 0 || text.length > max) invalid(`${field} has an invalid length`);
  return text;
}

function assertRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid('expectedRevision must be a positive integer');
  return value as number;
}

function assertVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid('version must be a positive integer');
  return value as number;
}

function assertHash(value: unknown): string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) invalid('plan hash must be a lowercase SHA-256 value');
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function parseCapabilities(value: unknown): Record<string, boolean> {
  if (typeof value !== 'string' || value.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, boolean> = {};
    for (const [key, flag] of Object.entries(parsed)) if (typeof flag === 'boolean') result[key] = flag;
    return result;
  } catch {
    return {};
  }
}

function mapAgent(row: Row): AgentRecord {
  const lifecycle = typeof row.lifecycle === 'string' ? row.lifecycle : 'DISABLED';
  const permissionMode = typeof row.permission_mode === 'string' ? row.permission_mode : 'autonomous';
  return {
    id: String(row.id ?? ''),
    name: String(row.name ?? ''),
    role: String(row.role ?? ''),
    engineId: String(row.engine_id ?? ''),
    organizationId: String(row.organization_id ?? LOCAL_PLANNING_ORGANIZATION_ID),
    lifecycle: ['DISABLED', 'STARTING', 'READY', 'STOPPING', 'ERROR'].includes(lifecycle)
      ? lifecycle as PlanningAgentSnapshot['lifecycle']
      : 'ERROR',
    archived: asBoolean(row.archived),
    permissionMode,
    capabilities: parseCapabilities(row.capabilities_json),
    createdAt: typeof row.created_at === 'number' ? row.created_at : Number(row.created_at ?? 0)
  };
}

function budgetView(budget: PlanBudget): PlanningBudgetView {
  return { timeMinutes: budget.timeMinutes, tokenLimit: budget.tokenLimit, costLimit: budget.costLimit };
}

function gateView(session: PlanningSession): PlanningGateDecisionView {
  return {
    requiresPlanning: session.gateDecision.requiresPlanning,
    complexityScore: session.gateDecision.complexityScore,
    riskScore: session.gateDecision.riskScore,
    reasons: [...session.gateDecision.reasons]
  };
}

function questionSetView(questionSet: QuestionSet | null): PlanningQuestionSetView | null {
  if (!questionSet) return null;
  return {
    id: questionSet.id,
    version: questionSet.version,
    questions: clone(questionSet.questions),
    answers: questionSet.answers ? clone(questionSet.answers) : null,
    createdAt: questionSet.createdAt,
    answeredAt: questionSet.answeredAt
  };
}

function planView(plan: CompanyExecutionPlan): PlanningPlanView {
  return {
    objective: plan.objective,
    assumptions: [...plan.assumptions],
    scope: { included: [...plan.scope.included], excluded: [...plan.scope.excluded] },
    team: plan.team.map((team) => ({
      teamId: team.teamId,
      leadAgentId: team.leadAgentId,
      memberAgentIds: [...team.memberAgentIds],
      proposedEphemeralRoles: [...team.proposedEphemeralRoles]
    })),
    dag: plan.dag.map((node) => ({
      nodeId: node.nodeId,
      ownerAgentId: node.ownerAgentId,
      dependencies: [...node.dependencies],
      workOrder: node.workOrder,
      expectedArtifacts: [...node.expectedArtifacts],
      acceptanceCriteria: [...node.acceptanceCriteria],
      permissionProfile: node.permissionProfile,
      requiredPermissions: [...node.requiredPermissions],
      budget: budgetView(node.budget),
      retryPolicy: { ...node.retryPolicy }
    })),
    risks: plan.risks.map((risk) => ({ ...risk })),
    overallBudget: budgetView(plan.overallBudget),
    acceptanceCriteria: [...plan.acceptanceCriteria]
  };
}

function planVersionView(record: PlanVersionRecord): PlanningPlanVersionView {
  return {
    version: record.version,
    hash: record.hash,
    status: record.status,
    plan: planView(record.plan),
    createdAt: record.createdAt,
    approvedAt: record.approvedAt,
    rejectedAt: record.rejectedAt,
    supersedesVersion: record.supersedesVersion,
    supersededByVersion: record.supersededByVersion
  };
}

function agentView(agent: AgentRecord): PlanningAgentView {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    engineId: agent.engineId,
    lifecycle: agent.lifecycle,
    permissionMode: PERMISSION_PROFILES.includes(agent.permissionMode as typeof PERMISSION_PROFILES[number])
      ? agent.permissionMode as PlanningAgentView['permissionMode']
      : 'autonomous'
  };
}

function answerValue(questionSet: QuestionSet | null, questionId: string): string[] {
  const answer = questionSet?.answers?.find((item) => item.questionId === questionId);
  return answer ? [...answer.selectedOptionIds] : [];
}

function hasOption(questionSet: QuestionSet | null, questionId: string, optionId: string): boolean {
  return answerValue(questionSet, questionId).includes(optionId);
}

interface TaskPlanProjection {
  assumptions: string[];
  included: string[];
  excluded: string[];
  expectedArtifacts: string[];
  acceptanceCriteria: string[];
  workOrderNotes: string[];
}

function projectQuestionAnswers(questionSet: QuestionSet | null): TaskPlanProjection {
  const projection: TaskPlanProjection = {
    assumptions: [], included: [], excluded: [], expectedArtifacts: [], acceptanceCriteria: [], workOrderNotes: []
  };
  const add = (target: string[], ...values: string[]) => {
    for (const value of values) if (!target.includes(value)) target.push(value);
  };

  if (hasOption(questionSet, 'acceptance-standard', 'runnable')) {
    add(projection.assumptions, '软件交付按“可本地运行”验收。');
    add(projection.included, '提供可在项目目录内启动和复核的完整实现。');
    add(projection.expectedArtifacts, '源代码与依赖清单', 'README/启动命令', '自动化测试结果', '非空预览截图');
    add(projection.acceptanceCriteria, '项目目录内的启动命令返回 0，且本地预览可以访问。', '自动化测试通过，预览截图能够清楚显示实际界面。');
  } else if (hasOption(questionSet, 'acceptance-standard', 'reviewable')) {
    add(projection.assumptions, '软件交付按“可审查原型”验收，不承诺生产部署。');
    add(projection.included, '完成主要界面、核心交互和审查说明。');
    add(projection.excluded, '生产部署、容量保障和正式发布。');
    add(projection.expectedArtifacts, '可审查原型', '界面与交互说明', '原型预览截图');
    add(projection.acceptanceCriteria, '老板可打开原型并逐项审查主要界面和核心交互。');
  } else if (hasOption(questionSet, 'acceptance-standard', 'production-ready')) {
    add(projection.assumptions, '软件交付按“发布候选版”验收。');
    add(projection.included, '完成构建、回归测试、配置说明和发布风险复核。');
    add(projection.expectedArtifacts, '发布候选构建', '源代码与依赖锁定文件', '回归测试报告', '配置说明', '已知风险清单');
    add(projection.acceptanceCriteria, '生产构建成功，回归测试通过，配置与已知风险均可复核。');
  }

  if (hasOption(questionSet, 'audience-channel', 'short-video-mass')) {
    add(projection.assumptions, '目标渠道为大众短视频，优先适配移动端观看。');
    add(projection.included, '内容采用口语化短节奏，并设计前 3 秒吸引点。');
    add(projection.expectedArtifacts, '短视频受众与渠道简报', '脚本/分镜', '发布排期表');
    add(projection.acceptanceCriteria, '每条内容明确前 3 秒吸引点、主体节奏和移动端呈现方式。');
  } else if (hasOption(questionSet, 'audience-channel', 'knowledge-professional')) {
    add(projection.assumptions, '目标受众为专业知识用户。');
    add(projection.included, '内容保留来源、推理链路和必要术语。');
    add(projection.expectedArtifacts, '专业受众内容简报', '带来源的脚本/图文稿', '事实核查记录');
    add(projection.acceptanceCriteria, '关键事实可追溯到来源，术语和结论可由专业读者复核。');
  } else if (hasOption(questionSet, 'audience-channel', 'private-domain')) {
    add(projection.assumptions, '目标渠道为私域客户沟通。');
    add(projection.included, '内容强调信任、转化和稳健的行动引导。');
    add(projection.expectedArtifacts, '私域受众简报', '内容稿件', '转化路径与禁用表达清单');
    add(projection.acceptanceCriteria, '内容包含明确但不过度承诺的行动引导，并通过禁用表达复核。');
  }

  if (hasOption(questionSet, 'research-window', 'a-share-1y')) {
    add(projection.assumptions, '研究范围为 A 股近 1 年，不构成投资建议。');
    add(projection.included, '使用国内公开披露、行业政策和近期估值数据。');
    add(projection.expectedArtifacts, 'A 股近 1 年数据表', '来源与采集时间清单', '股票分析与风险报告');
    add(projection.acceptanceCriteria, '所有关键数据注明来源和采集时间，结论覆盖估值、风险与不确定性。');
  } else if (hasOption(questionSet, 'research-window', 'hk-us-1y')) {
    add(projection.assumptions, '研究范围为港美股近 1 年，不构成投资建议。');
    add(projection.included, '使用中英文公开披露，并考虑一致预期与汇率因素。');
    add(projection.expectedArtifacts, '港美股近 1 年数据表', '来源与采集时间清单', '股票分析与风险报告');
    add(projection.acceptanceCriteria, '关键数据可追溯，报告明确披露口径、汇率因素、风险与不确定性。');
  } else if (hasOption(questionSet, 'research-window', 'cross-market-3y')) {
    add(projection.assumptions, '研究范围为跨市场近 3 年，不构成投资建议。');
    add(projection.included, '按一致口径完成跨市场周期比较。');
    add(projection.expectedArtifacts, '跨市场 3 年对比数据表', '口径与来源说明', '周期比较与风险报告');
    add(projection.acceptanceCriteria, '跨市场指标口径一致，数据、来源、采集时间和差异解释完整。');
  }

  if (hasOption(questionSet, 'listing-boundary', 'draft-only')) {
    add(projection.assumptions, '闲鱼任务只交付可验收草稿。');
    add(projection.included, '完成商品识别、估价依据、标题和详情草稿。');
    add(projection.excluded, '自动发布、私信买家或确认成交。');
    add(projection.expectedArtifacts, '商品识别记录', '估价依据表', '闲鱼标题与详情草稿');
    add(projection.acceptanceCriteria, '型号、成色假设和估价依据可复核；不发生任何外部发布或私信。');
  } else if (hasOption(questionSet, 'listing-boundary', 'review-then-publish')) {
    add(projection.assumptions, '闲鱼草稿通过老板最终验收后才允许发布。');
    add(projection.included, '完成商品识别、估价、营销草稿和待发布素材。');
    add(projection.excluded, '老板最终验收前的发布、私信或成交承诺。');
    add(projection.expectedArtifacts, '商品识别与估价记录', '待发布文案与图片清单', '发布前检查表');
    add(projection.acceptanceCriteria, '发布材料可复核；任何发布动作必须在老板最终验收后单独执行。');
  } else if (hasOption(questionSet, 'listing-boundary', 'valuation-only')) {
    add(projection.assumptions, '闲鱼任务仅做商品识别与估价。');
    add(projection.included, '完成型号识别、成色假设和价格区间分析。');
    add(projection.excluded, '营销文案、发布、私信或成交操作。');
    add(projection.expectedArtifacts, '商品识别记录', '估价依据与价格区间报告');
    add(projection.acceptanceCriteria, '型号和价格区间均有可复核依据，不生成或发布营销内容。');
  }

  if (hasOption(questionSet, 'scope-boundary', 'mvp')) {
    add(projection.assumptions, '本轮按最小可验收范围执行。');
    add(projection.included, '优先完成老板请求的主链路。');
    add(projection.excluded, '不影响主链路的扩展需求，统一进入后续清单。');
  } else if (hasOption(questionSet, 'scope-boundary', 'full-request')) {
    add(projection.assumptions, '本轮覆盖老板已提出的完整需求范围。');
    add(projection.included, '覆盖请求中已明确提出的全部交付项。');
  } else if (hasOption(questionSet, 'scope-boundary', 'research-first')) {
    add(projection.assumptions, '本轮先调研再实施。');
    add(projection.included, '完成决策依据和下一阶段可执行计划。');
    add(projection.excluded, '未经下一阶段批准的正式实施。');
    add(projection.expectedArtifacts, '调研与决策报告', '下一阶段执行计划');
    add(projection.acceptanceCriteria, '报告给出可追溯依据、明确建议和可执行的下一阶段计划。');
  }

  for (const answer of questionSet?.answers ?? []) {
    const text = answer.text?.trim();
    if (!text) continue;
    add(projection.assumptions, `老板补充边界（${answer.questionId}）：${text}`);
    add(projection.included, `遵循老板补充要求：${text}`);
  }
  projection.workOrderNotes = [...projection.assumptions, ...projection.included, ...projection.excluded.map((item) => `禁止：${item}`)];
  return projection;
}

function choiceQuestion(
  id: string,
  prompt: string,
  options: Array<{ id: string; label: string; impact: string }>,
  recommendedOptionId: string,
  recommendationReason: string
): PlanningQuestion {
  return {
    id, kind: 'single', prompt, options,
    recommendedOptionId, recommendationReason, allowOther: true
  };
}

function includesAny(value: string, terms: readonly string[]): boolean {
  return terms.some((term) => value.includes(term));
}

function requestSpecificQuestions(session: PlanningSession): PlanningQuestion[] {
  const request = session.request.toLowerCase();
  const signals = session.signals;
  const questions: PlanningQuestion[] = [];
  const software = includesAny(request, ['网站', '官网', '系统', '软件', 'app', 'web', '代码', '小程序']);
  const media = includesAny(request, ['短视频', '视频', '自媒体', '脚本', '分镜', '小红书', '抖音', '微信公众号']);
  const finance = includesAny(request, ['股票', '股价', '行业研究', '证券', '财报', '估值', '风险报告']);
  const resale = includesAny(request, ['闲鱼', '二手', '回收', '估价', '商品文案']);

  if (software && (signals?.ambiguousAcceptance || !includesAny(request, ['验收', '测试', '可运行', '启动', '预览']))) {
    questions.push(choiceQuestion(
      'acceptance-standard', '本次交付以什么作为最终验收标准？',
      [
        { id: 'runnable', label: '可本地运行', impact: '需提供源码、启动命令、测试结果和预览截图。' },
        { id: 'reviewable', label: '可审查原型', impact: '以完整界面和交互说明为主，不承诺生产部署。' },
        { id: 'production-ready', label: '发布候选版', impact: '增加构建、回归测试、配置说明与风险清单。' }
      ],
      'runnable', '可运行产物最容易由老板独立复核。'
    ));
  }

  if (media && !includesAny(request, ['抖音', '快手', '小红书', '视频号', 'b站', '公众号', '受众', '用户'])) {
    questions.push(choiceQuestion(
      'audience-channel', '这批内容优先服务哪类受众和渠道？',
      [
        { id: 'short-video-mass', label: '大众短视频', impact: '强化前 3 秒吸引力、口语化和短节奏。' },
        { id: 'knowledge-professional', label: '专业知识受众', impact: '强化来源、逻辑、术语和可复核性。' },
        { id: 'private-domain', label: '私域客户', impact: '强化信任、转化和稳健的行动引导。' }
      ],
      'short-video-mass', '短视频任务默认以移动端大众观看场景优化。'
    ));
  }

  if (finance && !includesAny(request, ['a股', '港股', '美股', '近一年', '近三年', '本周', '本月', '季度'])) {
    questions.push(choiceQuestion(
      'research-window', '股票研究的市场与时间窗口如何界定？',
      [
        { id: 'a-share-1y', label: 'A 股近 1 年', impact: '侧重国内披露、行业政策与近期估值。' },
        { id: 'hk-us-1y', label: '港美股近 1 年', impact: '侧重英文披露、市场一致预期与汇率因素。' },
        { id: 'cross-market-3y', label: '跨市场近 3 年', impact: '数据量和核对成本更高，但更适合周期比较。' }
      ],
      'a-share-1y', '在未指定时先使用窄而可复核的数据窗口。'
    ));
  }

  if (resale && !includesAny(request, ['自动发布', '仅草稿', '人工确认', '私信', '成交价'])) {
    questions.push(choiceQuestion(
      'listing-boundary', '估价和商品文案做到哪一步？',
      [
        { id: 'draft-only', label: '只交付草稿', impact: '输出估价依据、标题和详情，不发布也不私信。' },
        { id: 'review-then-publish', label: '验收后发布', impact: '产出草稿并在老板最终验收后执行发布。' },
        { id: 'valuation-only', label: '仅识别与估价', impact: '不生成营销内容，优先确保型号和价格依据可复核。' }
      ],
      'draft-only', '外部发布属于不可逆动作，默认停在可验收草稿。'
    ));
  }

  if (signals?.ambiguousScope && questions.length < 3) {
    questions.push(choiceQuestion(
      'scope-boundary', '这次优先交付哪个范围？',
      [
        { id: 'mvp', label: '最小可验收范围', impact: '先完成主链路，其他需求进入后续清单。' },
        { id: 'full-request', label: '完整需求范围', impact: '覆盖已提出的所有交付项，时间和 token 上限更高。' },
        { id: 'research-first', label: '先调研再实施', impact: '本轮交付决策报告和可执行的下一阶段计划。' }
      ],
      'mvp', '范围尚不明确时，先建立可验收的最小交付面。'
    ));
  }
  return questions;
}

function normalizeSignals(input: PlanningComplexitySignalsInput): PlanningComplexitySignals {
  if (!input || typeof input !== 'object') invalid('signals are required');
  const boolFields = [
    'hasCrossTeamDependencies', 'ambiguousObjective', 'ambiguousScope', 'ambiguousAcceptance',
    'requiresNewTeam', 'compareAlternatives', 'phasedExecution', 'confirmBeforeExecution'
  ] as const;
  for (const field of boolFields) if (typeof input[field] !== 'boolean') invalid(`signals.${field} must be boolean`);
  const numericFields = ['estimatedDurationMinutes', 'estimatedCost', 'estimatedTokenCount'] as const;
  for (const field of numericFields) {
    const value = input[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid(`signals.${field} must be non-negative`);
  }
  if (input.estimatedTaskCount !== undefined
    && (!Number.isSafeInteger(input.estimatedTaskCount) || input.estimatedTaskCount < 0)) invalid('signals.estimatedTaskCount is invalid');
  if (!Array.isArray(input.departmentIds) || input.departmentIds.length > 32) invalid('signals.departmentIds is invalid');
  if (!Array.isArray(input.irreversibleOperations) || input.irreversibleOperations.length > 16) invalid('signals.irreversibleOperations is invalid');
  return {
    departmentIds: input.departmentIds.map((value, index) => assertText(value, `signals.departmentIds[${index}]`, 128)),
    hasCrossTeamDependencies: input.hasCrossTeamDependencies,
    ambiguousObjective: input.ambiguousObjective,
    ambiguousScope: input.ambiguousScope,
    ambiguousAcceptance: input.ambiguousAcceptance,
    estimatedDurationMinutes: input.estimatedDurationMinutes,
    estimatedCost: input.estimatedCost,
    estimatedTokenCount: input.estimatedTokenCount,
    requiresNewTeam: input.requiresNewTeam,
    irreversibleOperations: [...input.irreversibleOperations],
    compareAlternatives: input.compareAlternatives,
    phasedExecution: input.phasedExecution,
    confirmBeforeExecution: input.confirmBeforeExecution,
    estimatedTaskCount: input.estimatedTaskCount
  };
}

function questionSetFor(session: PlanningSession): PlanningQuestion[] {
  const reasons = new Set(session.gateDecision.reasons);
  const questions: PlanningQuestion[] = requestSpecificQuestions(session);
  const add = (question: PlanningQuestion) => {
    if (questions.length < 3 && !questions.some((item) => item.id === question.id)) questions.push(question);
  };
  if (reasons.has('CROSS_TEAM') || reasons.has('NEW_TEAM') || reasons.has('PHASED_EXECUTION')) {
    add({
      id: 'execution-strategy', kind: 'single',
      prompt: '这项工作采用哪种执行组织方式？',
      options: [
        { id: 'single', label: '单人负责', impact: '最省协调成本，适合边界清楚且可由一名员工完成的工作。' },
        { id: 'existing-team', label: '现有团队协同', impact: '允许并行拆解和复核，协调时间与 token 开销更高。' },
        { id: 'new-team', label: '临时扩展团队', impact: '允许秘书提出临时角色，适合跨领域但会增加治理和预算成本。' }
      ],
      recommendedOptionId: reasons.has('CROSS_TEAM') || reasons.has('NEW_TEAM') ? 'existing-team' : 'single',
      recommendationReason: '当前复杂度门禁检测到跨团队或分阶段因素。', allowOther: true
    });
  }
  if (session.gateDecision.riskScore >= 3 || reasons.has('IRREVERSIBLE_OPERATION') || reasons.has('HIGH_COST')) {
    add({
      id: 'risk-posture', kind: 'single',
      prompt: '你希望秘书采用哪种风险与复核策略？',
      options: [
        { id: 'fast', label: '快速推进', impact: '减少复核和重试，最快得到结果，但失败恢复空间较小。' },
        { id: 'balanced', label: '平衡', impact: '保留一次重试和关键节点复核，兼顾速度与可靠性。' },
        { id: 'conservative', label: '稳健审慎', impact: '最多三次重试并强化验收，时间和成本预算更高。' }
      ],
      recommendedOptionId: reasons.has('IRREVERSIBLE_OPERATION') ? 'conservative' : 'balanced',
      recommendationReason: reasons.has('IRREVERSIBLE_OPERATION') ? '计划包含不可逆操作，默认提高复核强度。' : '默认保留一次恢复机会。', allowOther: true
    });
  }
  if (session.gateDecision.complexityScore >= 2 || reasons.has('LONG_TASK') || reasons.has('HIGH_TOKEN_BUDGET')) {
    add({
      id: 'budget-profile', kind: 'single',
      prompt: '本轮计划使用哪档预算？',
      options: [
        { id: 'lean', label: '精简', impact: '压缩时间、token 与费用，超出预算时需要重新提案。' },
        { id: 'standard', label: '标准', impact: '按当前估算留出适度余量。' },
        { id: 'extended', label: '扩展', impact: '为长任务和多轮复核留出更多余量，消耗上限更高。' }
      ],
      recommendedOptionId: 'standard', recommendationReason: '按确定性估算提供 25% 左右的缓冲。', allowOther: true
    });
  }
  // The domain service enforces this invariant as well; keep the control plane deterministic.
  return questions.slice(0, 3);
}

function numberWithMinimum(value: number, minimum: number): number {
  return Math.max(minimum, Math.ceil(value));
}

function makeBudget(signals: PlanningComplexitySignals, profile: 'lean' | 'standard' | 'extended'): PlanBudget {
  const factor = profile === 'lean' ? 0.75 : profile === 'extended' ? 1.5 : 1.25;
  return {
    timeMinutes: Math.min(24 * 60, numberWithMinimum(Math.max(signals.estimatedDurationMinutes, 15) * factor, 15)),
    tokenLimit: Math.min(2_000_000, numberWithMinimum(Math.max(signals.estimatedTokenCount, 1_000) * factor, 1_000)),
    costLimit: Math.min(1_000, Math.max(0.01, Math.round(Math.max(signals.estimatedCost, 0.01) * factor * 100) / 100)),
  };
}

function allocateBudgets(total: PlanBudget, count: number): PlanBudget[] {
  const result: PlanBudget[] = [];
  let timeLeft = total.timeMinutes;
  let tokenLeft = total.tokenLimit;
  let costLeft = total.costLimit;
  for (let index = 0; index < count; index += 1) {
    const remaining = count - index;
    const time = index === count - 1 ? timeLeft : Math.max(1, Math.floor(timeLeft / remaining));
    const tokens = index === count - 1 ? tokenLeft : Math.max(1, Math.floor(tokenLeft / remaining));
    const cost = index === count - 1 ? costLeft : Math.max(0.01, Math.round((costLeft / remaining) * 100) / 100);
    result.push({ timeMinutes: time, tokenLimit: tokens, costLimit: cost });
    timeLeft -= time;
    tokenLeft -= tokens;
    costLeft = Math.round((costLeft - cost) * 100) / 100;
  }
  return result;
}

function requiredPermissions(signals: PlanningComplexitySignals): string[] {
  return [...new Set(['read', ...signals.irreversibleOperations.map((operation) => OPERATION_PERMISSION[operation]).filter(Boolean)])].sort();
}

export class SecretaryPlanningControlPlane {
  private readonly service: SecretaryPlanningService;
  private readonly repository: PlanningRepositoryWithLists;
  private readonly now: () => number;
  private readonly dispatchingSessions = new Set<string>();
  private readonly dispatchFailures = new Map<string, DispatchFailure>();

  constructor(private readonly dependencies: ControlPlaneDependencies) {
    this.repository = dependencies.repository as PlanningRepositoryWithLists;
    this.now = dependencies.now ?? Date.now;
    this.service = new SecretaryPlanningService(dependencies.repository, dependencies.dispatchPort, {
      now: this.now,
      idFactory: dependencies.idFactory
    });
  }

  listSessions(limit = 50): PlanningSessionListItem[] {
    const safeLimit = Math.min(MAX_SESSION_LIST, Math.max(1, Math.trunc(limit)));
    const sessions = this.repository.listSessions?.(safeLimit) ?? this.listSessionsFallback(safeLimit);
    return sessions
      .filter((session) => session.organizationId === LOCAL_PLANNING_ORGANIZATION_ID && session.principalId === LOCAL_PLANNING_PRINCIPAL_ID)
      .map((session) => this.sessionListItem(session));
  }

  getSession(sessionId: string): PlanningSessionView {
    const session = this.requireLocalSession(sessionId);
    return this.view(session);
  }

  createSession(input: CreatePlanningSessionInput): PlanningSessionView {
    if (!input || typeof input !== 'object') invalid('planning session input is required');
    const request = assertText(input.request, 'request');
    const signals = normalizeSignals(input.signals);
    const session = this.service.createSession({
      organizationId: LOCAL_PLANNING_ORGANIZATION_ID,
      principalId: LOCAL_PLANNING_PRINCIPAL_ID,
      request,
      signals
    });
    let current = session;
    if (session.gateDecision.requiresPlanning) {
      this.service.issueQuestionSet(session.id, questionSetFor(session));
      current = this.service.getSession(session.id);
    }
    this.audit('planning.session.create', current.id, `status=${current.status}`);
    return this.view(current);
  }

  answerQuestions(input: AnswerPlanningQuestionsInput): PlanningSessionView {
    const session = this.requireLocalSession(input?.sessionId);
    this.assertRevision(session, input.expectedRevision);
    const questionSetVersion = assertVersion(input.questionSetVersion);
    if (!Array.isArray(input.answers) || input.answers.length > 3) invalid('answers must be an array of at most three items');
    const answers = input.answers.map((answer, index): PlanningQuestionAnswer => {
      if (!answer || typeof answer !== 'object') invalid(`answers[${index}] is invalid`);
      return {
        questionId: assertText(answer.questionId, `answers[${index}].questionId`, 128),
        selectedOptionIds: this.stringList(answer.selectedOptionIds, `answers[${index}].selectedOptionIds`, 4),
        text: answer.text === null ? null : assertText(answer.text, `answers[${index}].text`, 4_000)
      };
    });
    this.service.answerQuestionSet(session.id, questionSetVersion, LOCAL_PLANNING_PRINCIPAL_ID, answers);
    this.audit('planning.questions.answer', session.id, `version=${questionSetVersion}`);
    return this.view(this.service.getSession(session.id));
  }

  proposePlan(input: ProposePlanningPlanInput): PlanningSessionView {
    const session = this.requireLocalSession(input?.sessionId);
    this.assertRevision(session, input.expectedRevision);
    const policy = this.validationPolicy(session);
    const questionSet = session.questionSetVersion > 0
      ? this.repository.getQuestionSet(session.id, session.questionSetVersion)
      : null;
    const plan = this.buildBaselinePlan(session, questionSet, policy);
    const record = this.service.proposePlan(session.id, plan, policy);
    this.audit('planning.plan.propose', session.id, `version=${record.version};hash=${record.hash}`);
    return this.view(this.service.getSession(session.id));
  }

  approvePlan(input: ApprovePlanningPlanInput): PlanningSessionView {
    const session = this.requireLocalSession(input?.sessionId);
    this.assertRevision(session, input.expectedRevision);
    const version = assertVersion(input.version);
    const hash = assertHash(input.hash);
    this.assertCurrentPlan(session, version, hash, 'PROPOSED');
    this.service.approvePlan(session.id, version, hash, LOCAL_PLANNING_PRINCIPAL_ID);
    this.audit('planning.plan.approve', session.id, `version=${version};hash=${hash}`);
    return this.view(this.service.getSession(session.id));
  }

  rejectPlan(input: RejectPlanningPlanInput): PlanningSessionView {
    const session = this.requireLocalSession(input?.sessionId);
    this.assertRevision(session, input.expectedRevision);
    const version = assertVersion(input.version);
    const hash = assertHash(input.hash);
    this.assertCurrentPlan(session, version, hash, 'PROPOSED');
    this.service.rejectPlan(session.id, version, hash, LOCAL_PLANNING_PRINCIPAL_ID);
    this.audit('planning.plan.reject', session.id, `version=${version};hash=${hash}`);
    return this.view(this.service.getSession(session.id));
  }

  async dispatchPlan(input: DispatchPlanningPlanInput): Promise<PlanningDispatchResult> {
    const session = this.requireLocalSession(input?.sessionId);
    this.assertRevision(session, input.expectedRevision);
    const version = assertVersion(input.version);
    const hash = assertHash(input.hash);
    if (session.approvedPlanVersion !== version || session.approvedPlanHash !== hash) {
      throw new PlanningError('PLAN_HASH_MISMATCH', 'dispatch must name the exact approved plan version and hash');
    }
    if (this.dispatchingSessions.has(session.id)) {
      return { ok: false, view: this.view(session), error: { code: 'DISPATCH_IN_PROGRESS', message: 'dispatch is already running' } };
    }
    this.dispatchingSessions.add(session.id);
    try {
      await this.service.dispatchApprovedPlan(session.id, this.validationPolicy(session));
      this.dispatchFailures.delete(session.id);
      this.audit('planning.plan.dispatch', session.id, `version=${version};hash=${hash}`);
      return { ok: true, view: this.view(this.service.getSession(session.id)), error: null };
    } catch (error) {
      const failure = this.errorView(error);
      this.dispatchFailures.set(session.id, failure);
      return { ok: false, view: this.view(this.service.getSession(session.id)), error: failure };
    } finally {
      this.dispatchingSessions.delete(session.id);
    }
  }

  private listSessionsFallback(limit: number): PlanningSession[] {
    const rows = this.dependencies.db.raw.prepare(
      'SELECT id FROM planning_sessions ORDER BY updated_at DESC, id DESC LIMIT ?'
    ).all(limit) as Row[];
    return rows.map((row) => this.repository.getSession(String(row.id))).filter((value): value is PlanningSession => value !== null);
  }

  private requireLocalSession(sessionId: unknown): PlanningSession {
    const id = assertText(sessionId, 'sessionId', 128);
    const session = this.service.getSession(id);
    if (session.organizationId !== LOCAL_PLANNING_ORGANIZATION_ID || session.principalId !== LOCAL_PLANNING_PRINCIPAL_ID) {
      throw new PlanningError('ORGANIZATION_BOUNDARY', 'planning session is outside the local control plane');
    }
    return session;
  }

  private sessionListItem(session: PlanningSession): PlanningSessionListItem {
    return {
      id: session.id,
      request: session.request,
      status: session.status,
      revision: session.revision,
      gateDecision: gateView(session),
      latestPlanVersion: session.latestPlanVersion,
      approvedPlanVersion: session.approvedPlanVersion,
      approvedPlanHash: session.approvedPlanHash,
      updatedAt: session.updatedAt
    };
  }

  private view(session: PlanningSession): PlanningSessionView {
    const questionSet = session.questionSetVersion > 0
      ? this.repository.getQuestionSet(session.id, session.questionSetVersion)
      : null;
    const versions = this.repository.listPlanVersions?.(session.id)
      ?? this.listPlanVersionsFallback(session);
    const agents = this.listAgents();
    const approved = session.approvedPlanVersion === null ? null : versions.find((record) => record.version === session.approvedPlanVersion) ?? null;
    const receipts = approved ? approved.plan.dag.map((node) => this.repository.getDispatchReceipt(session.id, approved.version, node.nodeId)).filter((value): value is NonNullable<typeof value> => value !== null) : [];
    const dispatch = this.dispatchView(session, approved, receipts);
    return {
      ...this.sessionListItem(session),
      questionSetVersion: session.questionSetVersion,
      activeQuestionSetVersion: session.activeQuestionSetVersion,
      questionSet: questionSetView(questionSet),
      planVersions: versions.map(planVersionView),
      agents: agents.map(agentView),
      dispatch,
      createdAt: session.createdAt
    };
  }

  private listPlanVersionsFallback(session: PlanningSession): PlanVersionRecord[] {
    const rows = this.dependencies.db.raw.prepare(
      'SELECT version FROM plan_versions WHERE session_id = ? ORDER BY version'
    ).all(session.id) as Row[];
    return rows.map((row) => this.repository.getPlanVersion(session.id, Number(row.version))).filter((value): value is PlanVersionRecord => value !== null);
  }

  private listAgents(): AgentRecord[] {
    const rows = this.dependencies.db.raw.prepare(
      `SELECT id, name, role, engine_id, organization_id, lifecycle, archived,
              permission_mode, capabilities_json, created_at
       FROM agents WHERE organization_id = ? ORDER BY archived, lifecycle DESC, created_at, id`
    ).all(LOCAL_PLANNING_ORGANIZATION_ID) as Row[];
    return rows.map(mapAgent).filter((agent) => agent.id.length > 0);
  }

  private validationPolicy(session: PlanningSession): PlanValidationPolicy {
    const allAgents = this.listAgents();
    const snapshots: PlanningAgentSnapshot[] = allAgents.map((agent) => {
      const permissions = new Set<string>(['read']);
      if (agent.permissionMode !== 'readonly') permissions.add('write');
      for (const capability of CAPABILITY_NAMES) if (agent.capabilities[capability] === true) permissions.add(capability);
      return {
        id: agent.id,
        organizationId: agent.organizationId,
        lifecycle: agent.lifecycle,
        archived: agent.archived,
        permissionProfiles: PERMISSION_PROFILES.includes(agent.permissionMode as typeof PERMISSION_PROFILES[number])
          ? [agent.permissionMode]
          : ['standard'],
        permissions: [...permissions].sort()
      };
    });
    const allowedPermissions = [...new Set(snapshots.flatMap((agent) => agent.permissions))].sort();
    const estimated = session.gateDecision.complexityScore + session.gateDecision.riskScore;
    return {
      organizationId: LOCAL_PLANNING_ORGANIZATION_ID,
      agents: snapshots,
      allowedPermissionProfiles: [...PERMISSION_PROFILES],
      allowedPermissions,
      maxBudget: {
        timeMinutes: Math.min(24 * 60, Math.max(60, estimated * 240)),
        tokenLimit: Math.min(2_000_000, Math.max(50_000, estimated * 100_000)),
        costLimit: Math.min(1_000, Math.max(10, estimated * 50))
      },
      maxRetryAttempts: 3,
      allowEphemeralTeams: true
    };
  }

  private buildBaselinePlan(session: PlanningSession, questionSet: QuestionSet | null, policy: PlanValidationPolicy): CompanyExecutionPlan {
    const signals = this.signalsFromSession(session);
    const taskProjection = projectQuestionAnswers(questionSet);
    const execution = hasOption(questionSet, 'execution-strategy', 'single')
      ? 'single'
      : hasOption(questionSet, 'execution-strategy', 'new-team') ? 'new-team' : 'existing-team';
    const risk = hasOption(questionSet, 'risk-posture', 'fast')
      ? 'fast'
      : hasOption(questionSet, 'risk-posture', 'conservative') ? 'conservative' : 'balanced';
    const budgetProfile = hasOption(questionSet, 'budget-profile', 'lean')
      ? 'lean'
      : hasOption(questionSet, 'budget-profile', 'extended') ? 'extended' : 'standard';
    const required = requiredPermissions(signals);
    const eligible = policy.agents
      .filter((agent) => agent.organizationId === LOCAL_PLANNING_ORGANIZATION_ID && !agent.archived && agent.lifecycle === 'READY')
      .filter((agent) => required.every((permission) => agent.permissions.includes(permission)))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (eligible.length === 0) throw new PlanningError('AGENT_NOT_ELIGIBLE', '没有 READY 且具备本计划所需权限的数字员工');
    const desiredCount = execution === 'single' ? 1 : Math.min(3, Math.max(2, eligible.length));
    const teamAgents = eligible.slice(0, desiredCount);
    const totalBudget = makeBudget(signals, budgetProfile);
    const nodeCount = teamAgents.length === 1 ? 1 : teamAgents.length;
    const budgets = allocateBudgets(totalBudget, nodeCount);
    const retryAttempts = risk === 'fast' ? 1 : risk === 'conservative' ? 3 : 2;
    const lead = teamAgents[0];
    const members = teamAgents.slice(1);
    const teamId = `team-secretary-${session.id}`;
    const dag: PlanDagNode[] = [];
    const projectedWorkOrder = taskProjection.workOrderNotes.length > 0
      ? `${session.request}\n\n已确认边界：\n${taskProjection.workOrderNotes.map((item) => `- ${item}`).join('\n')}`
      : session.request;
    if (teamAgents.length === 1) {
      dag.push(this.node('node-01', lead.id, [], projectedWorkOrder, budgets[0], retryAttempts, required,
        taskProjection.expectedArtifacts, ['完成老板请求并提交可验收成果。', ...taskProjection.acceptanceCriteria]));
    } else {
      members.forEach((agent, index) => {
        dag.push(this.node(`node-${String(index + 1).padStart(2, '0')}`, agent.id, [], `${projectedWorkOrder}\n\n负责领域：团队成员分工`, budgets[index], retryAttempts, required,
          [], ['提交领域分析、实施结果或风险清单。']));
      });
      const dependencies = dag.map((node) => node.nodeId);
      dag.push(this.node(`node-${String(dag.length + 1).padStart(2, '0')}`, lead.id, dependencies, `${projectedWorkOrder}\n\n负责整合团队结果、处理冲突并交付最终成果。`, budgets[budgets.length - 1], retryAttempts, required,
        taskProjection.expectedArtifacts, ['整合所有依赖节点，完成最终验收标准。', ...taskProjection.acceptanceCriteria]));
    }
    const risks = session.gateDecision.reasons.map((reason) => ({
      risk: `门禁原因：${reason}`,
      mitigation: risk === 'conservative' ? '在关键节点复核并保留重试预算。' : '在派工前由老板确认版本和哈希。',
      ownerAgentId: lead.id
    }));
    return {
      schemaVersion: 1,
      organizationId: LOCAL_PLANNING_ORGANIZATION_ID,
      objective: session.request,
      assumptions: [
        `执行策略：${execution}`,
        `风险策略：${risk}`,
        `预算档位：${budgetProfile}`,
        '只使用当前组织内 READY 且未归档的数字员工。',
        ...taskProjection.assumptions
      ],
      scope: {
        included: [session.request, ...taskProjection.included],
        excluded: ['超出批准预算、权限或组织边界的工作。', ...taskProjection.excluded]
      },
      team: [{
        teamId,
        organizationId: LOCAL_PLANNING_ORGANIZATION_ID,
        leadAgentId: lead.id,
        memberAgentIds: members.map((agent) => agent.id),
        proposedEphemeralRoles: execution === 'new-team' ? ['领域分析员', '质量审查员'] : []
      }],
      dag,
      risks,
      overallBudget: totalBudget,
      acceptanceCriteria: [
        '所有 DAG 节点完成并提交声明的成果。',
        '秘书复核依赖关系、权限和预算后汇报老板。',
        ...taskProjection.acceptanceCriteria
      ]
    };
  }

  private node(
    nodeId: string,
    ownerAgentId: string,
    dependencies: string[],
    workOrder: string,
    budget: PlanBudget,
    maxAttempts: number,
    requiredPermissionsList: string[],
    expectedArtifacts: string[],
    acceptanceCriteria: string[]
  ): PlanDagNode {
    const agent = this.listAgents().find((candidate) => candidate.id === ownerAgentId);
    return {
      nodeId,
      organizationId: LOCAL_PLANNING_ORGANIZATION_ID,
      ownerAgentId,
      dependencies,
      workOrder,
      expectedArtifacts: expectedArtifacts.length > 0 ? [...expectedArtifacts] : ['Markdown 工作成果或结构化结果'],
      acceptanceCriteria: [...acceptanceCriteria],
      permissionProfile: agent?.permissionMode && PERMISSION_PROFILES.includes(agent.permissionMode as typeof PERMISSION_PROFILES[number]) ? agent.permissionMode : 'autonomous',
      requiredPermissions: requiredPermissionsList,
      budget,
      retryPolicy: { maxAttempts, backoff: maxAttempts === 1 ? 'none' : maxAttempts === 2 ? 'linear' : 'exponential' }
    };
  }

  private signalsFromSession(session: PlanningSession): PlanningComplexitySignals {
    if (session.signals) {
      return {
        ...session.signals,
        departmentIds: [...session.signals.departmentIds],
        irreversibleOperations: [...session.signals.irreversibleOperations]
      };
    }
    // Gate signals are intentionally retained in the immutable decision only as
    // scores/reasons for sessions created before signal persistence. Reconstruct
    // conservative defaults rather than accepting a second mutable copy from Renderer.
    const reasons = new Set(session.gateDecision.reasons);
    return {
      departmentIds: reasons.has('CROSS_TEAM') ? ['department-a', 'department-b'] : ['department-a'],
      hasCrossTeamDependencies: reasons.has('CROSS_TEAM'),
      ambiguousObjective: reasons.has('AMBIGUOUS_OBJECTIVE'),
      ambiguousScope: reasons.has('AMBIGUOUS_SCOPE'),
      ambiguousAcceptance: reasons.has('AMBIGUOUS_ACCEPTANCE'),
      estimatedDurationMinutes: reasons.has('LONG_TASK') ? 90 : 30,
      estimatedCost: reasons.has('HIGH_COST') ? 20 : 1,
      estimatedTokenCount: reasons.has('HIGH_TOKEN_BUDGET') ? 150_000 : 10_000,
      requiresNewTeam: reasons.has('NEW_TEAM'),
      irreversibleOperations: reasons.has('IRREVERSIBLE_OPERATION') ? ['write_files'] : [],
      compareAlternatives: reasons.has('COMPARE_ALTERNATIVES'),
      phasedExecution: reasons.has('PHASED_EXECUTION'),
      confirmBeforeExecution: reasons.has('EXPLICIT_CONFIRMATION'),
      estimatedTaskCount: reasons.has('CROSS_TEAM') ? 3 : 1
    };
  }

  private assertRevision(session: PlanningSession, expected: unknown): void {
    if (session.revision !== assertRevision(expected)) throw new PlanningError('REVISION_CONFLICT', 'planning session revision is stale');
  }

  private assertCurrentPlan(session: PlanningSession, version: number, hash: string, status: PlanVersionRecord['status']): void {
    if (session.latestPlanVersion !== version) throw new PlanningError('STALE_PLAN_VERSION', 'plan version is not current');
    const record = this.repository.getPlanVersion(session.id, version);
    if (!record || record.status !== status || record.hash !== hash) throw new PlanningError('PLAN_HASH_MISMATCH', 'plan version and hash do not match the current record');
  }

  private dispatchView(session: PlanningSession, approved: PlanVersionRecord | null, receipts: Array<{ nodeId: string; taskId: string; idempotencyKey: string; createdAt: number }>): PlanningDispatchView {
    const totalNodes = approved?.plan.dag.length ?? 0;
    const receiptViews: PlanningDispatchReceiptView[] = receipts.map((receipt) => ({
      nodeId: receipt.nodeId, taskId: receipt.taskId, idempotencyKey: receipt.idempotencyKey, createdAt: receipt.createdAt
    }));
    let status: PlanningDispatchView['status'] = 'NOT_STARTED';
    if (session.status === 'DISPATCHED') status = 'DISPATCHED';
    else if (this.dispatchingSessions.has(session.id)) status = 'IN_PROGRESS';
    else if (receipts.length > 0) status = 'PARTIAL';
    else if (session.dispatchStartedAt !== null || this.dispatchFailures.has(session.id)) status = 'FAILED';
    return {
      status,
      planVersion: approved?.version ?? session.dispatchPlanVersion,
      planHash: approved?.hash ?? session.dispatchPlanHash,
      totalNodes,
      receipts: receiptViews,
      error: this.dispatchFailures.get(session.id) ?? null
    };
  }

  private errorView(error: unknown): DispatchFailure {
    if (error instanceof PlanningError) return { code: error.code, message: error.message };
    return { code: 'DISPATCH_FAILED', message: error instanceof Error ? error.message : String(error) };
  }

  private stringList(value: unknown, field: string, max: number): string[] {
    if (!Array.isArray(value) || value.length > max) invalid(`${field} is invalid`);
    const values = value.map((item, index) => assertText(item, `${field}[${index}]`, 128));
    if (new Set(values).size !== values.length) invalid(`${field} contains duplicates`);
    return values;
  }

  private audit(action: string, target: string, result: string): void {
    this.dependencies.db.audit({
      id: `planning-audit-${this.now()}-${Math.random().toString(36).slice(2, 10)}`,
      actor: LOCAL_PLANNING_PRINCIPAL_ID,
      action,
      target,
      result,
      source: 'desktop'
    });
  }
}
