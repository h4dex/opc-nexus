import { randomUUID } from 'node:crypto';
import type { Database } from './database.js';
import type { ChannelIngressResult } from './channelIngressService.js';
import type { HermesGovernanceBridge } from './hermesGovernanceBridge.js';
import type { HermesServiceManager } from './hermesServiceManager.js';
import type { Orchestrator } from './orchestrator.js';
import type { HermesDeliveryGateResult } from './hermesDeliveryGate.js';

export interface HermesChannelConversationInput {
  ingress: ChannelIngressResult;
  message: string;
  preferredAgentId: string;
}

export interface HermesChannelConversationResult {
  content: string;
  taskIds?: string[];
}

type HermesChannelCommand =
  | { kind: 'status' }
  | { kind: 'cancel'; all: boolean }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'approve-plan'; dispatch: boolean }
  | { kind: 'dispatch-plan' }
  | { kind: 'help' };

const ACTIVE_TASKS = new Set(['RUNNING', 'QUEUED', 'WAITING_APPROVAL', 'PAUSED']);

export function parseHermesChannelCommand(message: string): HermesChannelCommand | null {
  const text = message.trim();
  if (/^[/#／]\s*(状态|status)$/i.test(text)) return { kind: 'status' };
  const cancel = /^[/#／]\s*(取消|停止|终止|cancel|stop)(?:\s+(全部|所有|all))?$/i.exec(text);
  if (cancel) return { kind: 'cancel', all: Boolean(cancel[2]) };
  if (/^[/#／]\s*(暂停|pause)$/i.test(text)) return { kind: 'pause' };
  if (/^[/#／]\s*(继续|恢复|resume)$/i.test(text)) return { kind: 'resume' };
  if (/^(批准并派工|批准并执行|approve and dispatch)$/i.test(text)) return { kind: 'approve-plan', dispatch: true };
  if (/^(批准计划|同意计划|批准|同意|approve plan)$/i.test(text)) return { kind: 'approve-plan', dispatch: false };
  if (/^(派工|开始执行|执行计划|dispatch plan)$/i.test(text)) return { kind: 'dispatch-plan' };
  if (/^[/#／]\s*(帮助|help|\?|？)$/i.test(text)) return { kind: 'help' };
  return null;
}

/** Routes one canonical channel conversation into its explicitly bound Hermes project. */
export class HermesChannelRouter {
  constructor(
    private readonly db: Database,
    private readonly services: HermesServiceManager,
    private readonly bridge: HermesGovernanceBridge,
    private readonly orchestrator: Orchestrator
  ) {}

  /** Exposes only the Main-owned delivery decision to channel adapters. */
  deliveryGate(taskId: string): HermesDeliveryGateResult {
    return this.bridge.getDeliveryGate(taskId);
  }

  async converse(input: HermesChannelConversationInput): Promise<HermesChannelConversationResult> {
    const binding = this.db.raw.prepare(`
      SELECT b.project_id, p.organization_id
      FROM hermes_channel_bindings b
      JOIN projects p ON p.id = b.project_id AND p.status <> 'archived'
      WHERE b.channel_id = ?
    `).get(input.ingress.channelId) as { project_id?: string; organization_id?: string } | undefined;
    if (!binding?.project_id || binding.organization_id !== input.ingress.organizationId) {
      throw new Error('该渠道尚未绑定可用项目，请在连接中心选择项目');
    }
    const changed = this.db.raw.prepare(`
      UPDATE conversations SET project_id = ?, updated_at = ?
      WHERE id = ? AND organization_id = ? AND principal_id = ?
        AND (project_id IS NULL OR project_id = ?)
    `).run(
      binding.project_id,
      Date.now(),
      input.ingress.conversationId,
      input.ingress.organizationId,
      input.ingress.principalId,
      binding.project_id
    ).changes;
    if (changed !== 1) throw new Error('渠道会话已绑定其他项目，拒绝跨项目路由');

    const command = parseHermesChannelCommand(input.message);
    if (command) {
      return await this.applyCommand(binding.project_id, input.ingress, command);
    }

    const pending = this.db.raw.prepare(`
      SELECT clarify_id FROM hermes_clarify_requests
      WHERE project_id = ? AND conversation_id = ? AND status = 'OPEN'
      ORDER BY created_at LIMIT 1
    `).get(binding.project_id, input.ingress.conversationId) as { clarify_id?: string } | undefined;
    if (pending?.clarify_id) {
      const answer = {
        clarifyId: pending.clarify_id,
        projectId: binding.project_id,
        principalId: input.ingress.principalId,
        answer: input.message
      };
      const status = this.services.getStatus(binding.project_id);
      if (status.state !== 'healthy') {
        await this.bridge.answerClarify(answer);
        return { content: '回答已保存到项目治理层；项目 Hermes 服务离线，服务恢复后会自动继续同一会话。' };
      }
      const resumed = await this.bridge.answerClarifyAndWait(answer);
      return { content: resumed.content ?? '回答已记录，Hermes 已恢复会话；后续计划或问题可继续在本渠道处理。' };
    }

    const status = this.services.getStatus(binding.project_id);
    if (status.state !== 'healthy') {
      throw new Error(`项目 Hermes 服务当前为 ${status.state}，请先在项目中心启动工作台`);
    }

    const result = await this.services.runProjectTurn(binding.project_id, {
      conversationId: input.ingress.conversationId,
      principalId: input.ingress.principalId,
      message: input.message,
      title: `Channel ${input.ingress.channelId}`
    });
    return { content: result.content };
  }

  private async applyCommand(
    projectId: string,
    ingress: ChannelIngressResult,
    command: HermesChannelCommand
  ): Promise<HermesChannelConversationResult> {
    if (command.kind === 'help') {
      return { content: [
        '项目控制指令：',
        '/状态 - 查看当前项目计划和任务',
        '/暂停 - 暂停当前执行任务',
        '/继续 - 恢复暂停任务',
        '/取消 - 取消当前任务；/取消 全部 取消全部活跃任务',
        '批准计划 - 批准最新 Hermes 计划',
        '派工 - 派发已批准计划',
        '批准并派工 - 批准并立即派发最新计划'
      ].join('\n') };
    }

    if (command.kind === 'approve-plan' || command.kind === 'dispatch-plan') {
      const allowedStatuses = command.kind === 'approve-plan' ? "('PROJECTED','APPROVED')" : "('APPROVED')";
      const row = this.db.raw.prepare(`
        SELECT p.draft_id, p.plan_version, p.plan_hash, p.status
        FROM hermes_plan_projections p
        JOIN hermes_plan_drafts d ON d.draft_id = p.draft_id AND d.project_id = p.project_id
        WHERE p.project_id = ? AND d.conversation_id = ? AND p.status IN ${allowedStatuses}
        ORDER BY p.updated_at DESC LIMIT 1
      `).get(projectId, ingress.conversationId) as {
        draft_id?: string;
        plan_version?: number;
        plan_hash?: string;
        status?: string;
      } | undefined;
      if (!row?.draft_id) {
        return { content: command.kind === 'approve-plan' ? '当前会话没有待批准的 Hermes 计划。' : '当前会话没有已批准且待派工的计划。' };
      }
      let projection = await this.bridge.approvePlan(row.draft_id, projectId, ingress.principalId);
      this.audit(ingress, projectId, 'hermes.channel.plan.approve', row.draft_id);
      if (command.kind === 'dispatch-plan' || command.dispatch) {
        projection = await this.bridge.dispatchPlan(row.draft_id, projectId, ingress.principalId);
        this.audit(ingress, projectId, 'hermes.channel.plan.dispatch', row.draft_id);
        const taskIds = (this.db.raw.prepare(`
          SELECT task_id AS id FROM hermes_plan_jobs WHERE draft_id = ? ORDER BY created_at, node_id
        `).all(row.draft_id) as Array<{ id: string }>).map((task) => task.id);
        if (taskIds.length === 0) throw new Error('OPC-Nexus reported dispatch success but created no project tasks');
        return {
          content: `计划已批准并派工：Hermes v${projection.version} · ${projection.hash.slice(0, 16)}…\n已创建 ${taskIds.length} 个受治理任务。`,
          taskIds
        };
      }
      return { content: `计划已批准：Hermes v${projection.version} · ${projection.hash.slice(0, 16)}…\n回复「派工」开始执行。` };
    }

    const tasks = this.db.raw.prepare(`
      SELECT id, title, status, progress, stage FROM tasks
      WHERE project_id = ? AND deleted_at IS NULL
        AND status IN ('RUNNING','QUEUED','WAITING_APPROVAL','PAUSED')
      ORDER BY created_at
    `).all(projectId) as Array<{ id: string; title: string; status: string; progress: number; stage: string }>;

    if (command.kind === 'status') {
      const projection = this.db.raw.prepare(`
        SELECT p.plan_version, p.plan_hash, p.status
        FROM hermes_plan_projections p
        JOIN hermes_plan_drafts d ON d.draft_id = p.draft_id AND d.project_id = p.project_id
        WHERE p.project_id = ? AND d.conversation_id = ?
        ORDER BY p.updated_at DESC LIMIT 1
      `).get(projectId, ingress.conversationId) as { plan_version?: number; plan_hash?: string; status?: string } | undefined;
      const lines = projection?.status
        ? [`计划：${projection.status} · Hermes v${projection.plan_version} · ${String(projection.plan_hash).slice(0, 16)}…`]
        : ['计划：当前会话尚无 Hermes 计划'];
      if (tasks.length === 0) lines.push('任务：当前项目没有执行中、排队、待审批或暂停的任务。');
      else lines.push(...tasks.map((task, index) => `${index + 1}. [${task.status}] ${task.title.slice(0, 100)}（${task.progress}% · ${task.stage}）`));
      return { content: lines.join('\n') };
    }

    if (command.kind === 'cancel') {
      if (tasks.length === 0) return { content: '当前项目没有可取消的任务。' };
      const targets = command.all ? tasks : [tasks[0]!];
      for (const task of targets) {
        if (ACTIVE_TASKS.has(task.status)) this.orchestrator.cancelTask(task.id);
      }
      this.audit(ingress, projectId, 'hermes.channel.task.cancel', targets.map((task) => task.id).join(','));
      return { content: command.all ? `已取消当前项目 ${targets.length} 个活跃任务。` : `已取消任务：${targets[0]!.title.slice(0, 100)}` };
    }

    if (command.kind === 'pause') {
      const task = tasks.find((candidate) => candidate.status === 'RUNNING');
      if (!task) return { content: '当前项目没有正在运行且可暂停的任务。' };
      this.orchestrator.pauseTask(task.id);
      this.audit(ingress, projectId, 'hermes.channel.task.pause', task.id);
      return { content: `已暂停任务：${task.title.slice(0, 100)}` };
    }

    const task = tasks.find((candidate) => candidate.status === 'PAUSED');
    if (!task) return { content: '当前项目没有已暂停且可恢复的任务。' };
    this.orchestrator.resumeTask(task.id);
    this.audit(ingress, projectId, 'hermes.channel.task.resume', task.id);
    return { content: `已恢复任务：${task.title.slice(0, 100)}` };
  }

  private audit(ingress: ChannelIngressResult, projectId: string, action: string, result: string): void {
    this.db.audit({
      id: randomUUID(),
      actor: ingress.principalId,
      action,
      target: projectId,
      result,
      source: `channel:${ingress.channelId}`
    });
  }
}
