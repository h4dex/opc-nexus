import { isAbsolute } from 'node:path';
import { lstatSync, mkdirSync } from 'node:fs';
import type { Agent, CreateAgentInput } from '../../shared/types.js';
import { DSH_MANAGED_ENGINE_ID } from '../../shared/types.js';
import type { Orchestrator } from './orchestrator.js';

export const CORDIS_AGENT_NAME = 'Cordis';
export const CORDIS_AGENT_ROLE = '主 AI / 老板秘书，负责澄清目标、制定计划、组建团队、派工、跟踪进度并组织验收';

const CORDIS_SYSTEM_PROMPT = [
  '你是 Cordis，直接服务于老板的主 AI 和派工中枢。',
  '复杂任务先澄清关键约束并给出可确认的计划，再调度合适的固定数字员工或弹性子 Agent 执行。',
  '持续跟踪过程、风险、成本与交付物，必要时组织跨团队协作，并把需要老板决策的事项明确提出。'
].join('\n');

type CordisAgentPort = Pick<
  Orchestrator,
  'listAgents' | 'checkpointAgentCreation' | 'createAgent'
>;

export type CordisBootstrapResult =
  | { created: true; agent: Agent }
  | { created: false; agent: Agent };

export class CordisBootstrapConflictError extends Error {
  readonly code = 'CORDIS_NAME_CONFLICT';

  constructor() {
    super('无法创建 Cordis：该名称已被现有数字员工占用');
    this.name = 'CordisBootstrapConflictError';
  }
}

function createInput(workspace: string): CreateAgentInput {
  return {
    name: CORDIS_AGENT_NAME,
    role: CORDIS_AGENT_ROLE,
    systemPrompt: CORDIS_SYSTEM_PROMPT,
    engineId: DSH_MANAGED_ENGINE_ID,
    workspace,
    permissionMode: 'autonomous',
    concurrencyLimit: 1,
    channelIds: [],
    kind: 'general'
  };
}

function ensureWorkspace(workspace: string): void {
  if (!workspace.trim() || !isAbsolute(workspace)) {
    throw new Error('Cordis workspace must be an absolute app-data path');
  }
  mkdirSync(workspace, { recursive: true });
  const stat = lstatSync(workspace);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Cordis workspace must be a real directory');
  }
}

/** Ensure v2 has one durable managed-DSH leader without changing user-created employees. */
export function ensureCordisAgent(
  orchestrator: CordisAgentPort,
  workspace: string
): CordisBootstrapResult {
  const managedAgents = orchestrator.listAgents().filter((agent) => (
    !agent.archived && agent.engineId === DSH_MANAGED_ENGINE_ID
  ));
  const existing = managedAgents.find((agent) => agent.name === CORDIS_AGENT_NAME) ?? managedAgents[0];
  if (existing) return { created: false, agent: existing };

  const input = createInput(workspace);
  // createAgent intentionally reuses or revives a same-name row. Guard that
  // behavior here because bootstrap must never repurpose a user's employee.
  if (orchestrator.checkpointAgentCreation(input).existing) {
    throw new CordisBootstrapConflictError();
  }

  ensureWorkspace(workspace);
  const agent = orchestrator.createAgent(input);
  if (agent.archived || agent.engineId !== DSH_MANAGED_ENGINE_ID) {
    throw new Error('Cordis bootstrap did not create a managed DSH employee');
  }
  return { created: true, agent };
}
