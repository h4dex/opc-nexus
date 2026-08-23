import type { Agent } from '../../shared/types.js';

const RETIRED_SCHEDULER_ENGINE_ID = 'eng-deepseek-harness-managed';

export const LEGACY_CORDIS_ROLE = '主 AI / 老板秘书，负责澄清目标、制定计划、组建团队、派工、跟踪进度并组织验收';
export const LEGACY_CORDIS_SYSTEM_PROMPT = [
  '你是 Cordis，直接服务于老板的主 AI 和派工中枢。',
  '复杂任务先澄清关键约束并给出可确认的计划，再调度合适的固定数字员工或弹性子 Agent 执行。',
  '持续跟踪过程、风险、成本与交付物，必要时组织跨团队协作，并把需要老板决策的事项明确提出。'
].join('\n');

/** Matches only the exact employee created by the retired Cordis startup bootstrap. */
export function isLegacyBootstrappedCordisAgent(agent: Agent): boolean {
  return !agent.archived
    && agent.name === 'Cordis'
    && agent.role === LEGACY_CORDIS_ROLE
    && agent.systemPrompt === LEGACY_CORDIS_SYSTEM_PROMPT
    && agent.engineId === RETIRED_SCHEDULER_ENGINE_ID
    && /[\\/]aibox-data[\\/]workspaces[\\/]Cordis$/i.test(agent.workspace);
}
