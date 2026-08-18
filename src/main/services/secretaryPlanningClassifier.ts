import type { IrreversibleOperation, PlanningComplexitySignals } from './secretaryPlanning.js';

export const SECRETARY_PLANNING_CLASSIFIER_LIMITS = Object.freeze({
  analyzedCharacters: 20_000,
  durationMinutes: 1_440,
  estimatedCost: 100,
  estimatedTokenCount: 250_000,
  estimatedTaskCount: 16
});

const INFORMATIONAL_PREFIX = /^(?:(?:请|请你|麻烦你?)\s*)?(?:什么是|为什么|如何理解|怎么理解|解释(?:一下)?|介绍(?:一下)?|说明(?:一下)?|告诉我)|^(?:what\s+is|why\b|explain\b|describe\b|how\s+does)\b/i;
const EXECUTION_INTENT = /(?:实现|开发|构建|创建|搭建|设计|执行|实施|完成|交付|集成|迁移|部署|上线|投产|发布|重构|改造|制定|规划|协调|组织|安排|安装|删除|清空|覆盖|写入|发送|通知|支付|付款|转账|购买|评估)|\b(?:build|implement|create|design|execute|deliver|integrate|migrate|deploy|publish|release|refactor|coordinate|organize|install|delete|remove|overwrite|send|notify|pay|purchase|plan|evaluate)\b/i;
const DIRECTIVE_CUE = /(?:请|帮我|替我|给我|需要|希望|我要|我们要|务必)|\b(?:please|i\s+need|we\s+need|i\s+want)\b/i;

const CROSS_TEAM = /(?:跨团队|跨部门|多部门|多个团队|多团队|部门协同|团队协同|各部门)|\b(?:cross[- ]team|cross[- ]department|multi[- ]team|multiple\s+teams?|company[- ]wide)\b/i;
const NEW_TEAM = /(?:新团队|临时团队|组建团队|新建团队|生成新的?团队|新增数字员工)|\b(?:new\s+team|temporary\s+team|build\s+a\s+team|staff\s+a\s+team)\b/i;
const PHASED = /(?:分阶段|分期执行|阶段性交付|里程碑|先.{0,30}再.{0,30}(?:最后|然后)?|第一阶段|第二阶段)|\b(?:phased|in\s+phases|milestones?|phase\s+one|first.{0,30}then.{0,30}finally)\b/i;
const COMPARE_ALTERNATIVES = /(?:(?:比较|对比|权衡).{0,24}(?:方案|路线|架构|选型)|(?:方案|路线|架构|选型).{0,24}(?:比较|对比|权衡)|多个方案|多种方案|三种方案|备选方案)|\b(?:compare|evaluate|weigh).{0,40}\b(?:approaches|plans|options|architectures|solutions|alternatives)\b|\btrade[- ]offs?\b/i;
const CONFIRM_FIRST = /(?:先确认|确认后再|等我确认|老板确认|批准后再|先.{0,24}(?:给出|制定|提交).{0,24}(?:计划|方案)|不要直接执行)|\b(?:confirm\s+before|approval\s+before|wait\s+for\s+(?:my\s+)?approval|plan\s+first)\b/i;
const LONG_TASK = /(?:长任务|长期任务|长时间运行|持续.{0,12}(?:分钟|小时|天|周)|耗时.{0,12}(?:分钟|小时|天|周))|\b(?:long[- ]running|long[- ]term|long\s+task|overnight|multi[- ]day)\b/i;
const GENERIC_COMPLEXITY = /(?:复杂任务|大型项目|整体集成|端到端|全流程|完整(?:系统|平台|项目)|系统架构|从零(?:开始)?(?:搭建|构建)|多(?:个)?\s*agent|多智能体)|\b(?:complex\s+task|large[- ]scale|end[- ]to[- ]end|full\s+(?:system|platform|project)|system\s+architecture|multi[- ]agent)\b/i;
const AMBIGUOUS_OBJECTIVE = /(?:随便做|看着办|你决定做什么|目标还不明确)|\b(?:whatever\s+you\s+think|unclear\s+objective)\b/i;
const AMBIGUOUS_SCOPE = /(?:全部都做|所有内容都|全面优化|尽可能多|范围还不明确)|\b(?:everything|full\s+scope|unclear\s+scope)\b/i;
const AMBIGUOUS_ACCEPTANCE = /(?:差不多就行|做到最好|尽量做好|验收标准还不明确)|\b(?:as\s+good\s+as\s+possible|good\s+enough|unclear\s+acceptance)\b/i;
const STRUCTURE_MARKER = /(?:并且|同时|然后|随后|以及|再由|分别)|\b(?:and\s+then|followed\s+by|in\s+parallel|respectively)\b/gi;
const NUMBERED_STEP = /(?:^|\n)\s*(?:\d{1,2}[.)、]|[-*])\s+/g;

const IRREVERSIBLE_PATTERNS: ReadonlyArray<readonly [IrreversibleOperation, RegExp]> = [
  ['write_files', /(?:(?:覆盖|批量(?:修改|改写)|写入|修改(?:这些|所有|项目)?).{0,12}(?:文件|代码|配置)|(?:文件|代码|配置).{0,12}(?:覆盖|批量修改|写入))|\b(?:overwrite|write|bulk[- ]edit).{0,24}\b(?:files?|code|config)\b/i],
  ['install_software', /(?:安装(?:软件|依赖|包|插件|服务))|\binstall\s+(?:software|dependencies|packages?|plugins?|services?)\b/i],
  ['send_external_message', /(?:(?:发送|群发).{0,12}(?:邮件|消息|通知)|通知(?:客户|用户|供应商))|\b(?:send|email|notify).{0,24}\b(?:customers?|users?|clients?|vendors?)\b/i],
  ['production_change', /(?:生产环境|线上环境|正式环境|上线|投产)|\b(?:production\s+(?:change|deploy)|deploy\s+to\s+production|go\s+live)\b/i],
  ['payment', /(?:支付|付款|转账|购买(?:服务|订阅|商品))|\b(?:pay|payment|transfer\s+money|purchase)\b/i],
  ['delete_data', /(?:删除(?:(?:旧|历史|所有|这些|项目中的?|数据库中的?){0,3})(?:数据|记录|文件|账户|项目)|清空(?:数据库|数据)|删库|永久删除)|\b(?:delete\s+(?:old\s+|all\s+)?(?:data|records?|files?|accounts?|projects?)|drop\s+(?:the\s+)?database|permanently\s+delete)\b/i],
  ['publish', /(?:公开发布|发布(?:文章|版本|公告|内容))|\b(?:publish|public\s+release)\b/i]
];

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function analysisText(request: string): { normalized: string; analyzed: string } | null {
  if (typeof request !== 'string') return null;
  const normalized = request.normalize('NFKC').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return null;
  const limit = SECRETARY_PLANNING_CLASSIFIER_LIMITS.analyzedCharacters;
  if (normalized.length <= limit) return { normalized, analyzed: normalized };
  const half = Math.floor(limit / 2);
  return { normalized, analyzed: `${normalized.slice(0, half)}\n${normalized.slice(-half)}` };
}

function countMatches(text: string, pattern: RegExp, maximum: number): number {
  pattern.lastIndex = 0;
  let count = 0;
  while (count < maximum && pattern.exec(text)) count += 1;
  pattern.lastIndex = 0;
  return count;
}

function explicitDurationMinutes(text: string): number {
  const pattern = /(\d{1,4})\s*(分钟|小时|天|周|minutes?|mins?|hours?|hrs?|days?|weeks?)/gi;
  let maximum = 0;
  for (const match of text.matchAll(pattern)) {
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const multiplier = /周|week/.test(unit) ? 10_080 : /天|day/.test(unit) ? 1_440 : /小时|hour|hr/.test(unit) ? 60 : 1;
    maximum = Math.max(maximum, amount * multiplier);
  }
  return clamp(maximum, 0, SECRETARY_PLANNING_CLASSIFIER_LIMITS.durationMinutes);
}

/**
 * Deterministically classifies a user request for the secretary-planning gate.
 * It performs no model, network, clock, workspace, or employee lookups.
 */
export function classifySecretaryPlanningRequest(request: string): PlanningComplexitySignals | null {
  const text = analysisText(request);
  if (!text) return null;
  const analyzed = text.analyzed;
  const informational = INFORMATIONAL_PREFIX.test(analyzed);
  const crossTeam = CROSS_TEAM.test(analyzed);
  const requiresNewTeam = NEW_TEAM.test(analyzed);
  const phasedExecution = PHASED.test(analyzed);
  const compareAlternatives = COMPARE_ALTERNATIVES.test(analyzed);
  const confirmBeforeExecution = CONFIRM_FIRST.test(analyzed);
  const explicitlyLong = LONG_TASK.test(analyzed) || explicitDurationMinutes(analyzed) >= 60;
  const genericComplexity = GENERIC_COMPLEXITY.test(analyzed);
  const irreversibleOperations = IRREVERSIBLE_PATTERNS
    .filter(([, pattern]) => pattern.test(analyzed))
    .map(([operation]) => operation);
  const structureCount = countMatches(analyzed, STRUCTURE_MARKER, 8)
    + countMatches(analyzed, NUMBERED_STEP, 8);
  const hasComplexSignal = crossTeam
    || requiresNewTeam
    || phasedExecution
    || compareAlternatives
    || confirmBeforeExecution
    || explicitlyLong
    || genericComplexity
    || irreversibleOperations.length > 0
    || structureCount >= 2
    || text.normalized.length >= 600;
  const executionIntent = EXECUTION_INTENT.test(analyzed)
    || (DIRECTIVE_CUE.test(analyzed) && hasComplexSignal);
  if (informational || !executionIntent || !hasComplexSignal) return null;

  const ambiguousObjective = AMBIGUOUS_OBJECTIVE.test(analyzed);
  const ambiguousScope = AMBIGUOUS_SCOPE.test(analyzed);
  const ambiguousAcceptance = AMBIGUOUS_ACCEPTANCE.test(analyzed);
  const estimatedTaskCount = clamp(
    2
      + (crossTeam ? 2 : 0)
      + (requiresNewTeam ? 1 : 0)
      + (phasedExecution ? 2 : 0)
      + (compareAlternatives ? 1 : 0)
      + (genericComplexity ? 2 : 0)
      + irreversibleOperations.length
      + Math.min(4, structureCount),
    2,
    SECRETARY_PLANNING_CLASSIFIER_LIMITS.estimatedTaskCount
  );
  const explicitMinutes = explicitDurationMinutes(analyzed);
  const estimatedDurationMinutes = clamp(
    Math.max(
      60,
      explicitMinutes,
      20 + estimatedTaskCount * 12 + (crossTeam ? 30 : 0) + (phasedExecution ? 30 : 0) + (explicitlyLong ? 120 : 0)
    ),
    60,
    SECRETARY_PLANNING_CLASSIFIER_LIMITS.durationMinutes
  );
  const estimatedTokenCount = clamp(
    4_000 + Math.min(text.normalized.length, 20_000) * 8 + estimatedTaskCount * 6_000,
    4_000,
    SECRETARY_PLANNING_CLASSIFIER_LIMITS.estimatedTokenCount
  );
  const estimatedCost = clamp(
    Math.round((estimatedTaskCount * 0.25 + irreversibleOperations.length * 0.5) * 100) / 100,
    0,
    SECRETARY_PLANNING_CLASSIFIER_LIMITS.estimatedCost
  );

  return {
    departmentIds: crossTeam ? ['primary', 'collaborating'] : ['primary'],
    hasCrossTeamDependencies: crossTeam,
    ambiguousObjective,
    ambiguousScope,
    ambiguousAcceptance,
    estimatedDurationMinutes,
    estimatedCost,
    estimatedTokenCount,
    requiresNewTeam,
    irreversibleOperations,
    compareAlternatives,
    phasedExecution,
    confirmBeforeExecution,
    estimatedTaskCount
  };
}
