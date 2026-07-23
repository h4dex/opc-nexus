/**
 * 专家团执行引擎（流水线版）：
 * - coordinate（主专家协调）：主专家拆解任务 → 逐步分派子任务给不同成员 → 验收综合
 * - roundtable（专家圆桌）：各专家依次对同一问题发表观点 → 协调者总结
 * - 团队共享工作空间 + MD 交接协议（_aibox/OUTLINE.md + handoffs/ + PROGRESS.md），消除信息孤岛
 * - 流水线状态持久化到 team_runs 表，UI 可轮询进度
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { app } from 'electron';
import type { Database } from './database.js';
import type { Orchestrator } from './orchestrator.js';
import type { Agent, TeamRun, TeamRunPhase, TeamRunSubtask } from '../../shared/types.js';

export interface Team {
  id: string;
  name: string;
  coordinatorId: string;
  memberIds: string[];
  mode: 'coordinate' | 'roundtable';
  workspace: string;
  createdAt: number;
}

interface TeamRow {
  id: string;
  name: string;
  coordinator_id: string;
  member_ids: string;
  mode: string;
  workspace: string;
  created_at: number;
}

interface RunRow {
  id: string;
  team_id: string;
  task_text: string;
  phase: string;
  current_step: number;
  total_steps: number;
  subtasks_json: string;
  final_result: string | null;
  error: string | null;
  created_at: number;
  ended_at: number | null;
}

/** 单步等待超时（10 分钟） */
const STEP_TIMEOUT_MS = 10 * 60_000;

export class TeamEngine {
  constructor(private db: Database, private orchestrator: Orchestrator) {}

  // ---------- CRUD ----------

  list(): Team[] {
    return (this.db.raw.prepare('SELECT * FROM teams ORDER BY created_at DESC').all() as unknown as TeamRow[]).map(this.mapRow);
  }

  create(input: { name: string; coordinatorId: string; memberIds: string[]; mode?: 'coordinate' | 'roundtable'; workspace?: string }): Team {
    const id = `team-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const workspace = input.workspace?.trim() || join(app.getPath('userData'), 'workspaces', id);
    this.db.raw.prepare('INSERT INTO teams(id, name, coordinator_id, member_ids, mode, workspace, created_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, input.name, input.coordinatorId, JSON.stringify(input.memberIds), input.mode ?? 'coordinate', workspace, now);
    return { id, name: input.name, coordinatorId: input.coordinatorId, memberIds: input.memberIds, mode: input.mode ?? 'coordinate', workspace, createdAt: now };
  }

  update(id: string, patch: { name?: string; coordinatorId?: string; memberIds?: string[]; mode?: 'coordinate' | 'roundtable'; workspace?: string }) {
    const fields: string[] = [];
    const values: (string | number)[] = [];
    if (patch.name !== undefined) { fields.push('name = ?'); values.push(patch.name); }
    if (patch.coordinatorId !== undefined) { fields.push('coordinator_id = ?'); values.push(patch.coordinatorId); }
    if (patch.memberIds !== undefined) { fields.push('member_ids = ?'); values.push(JSON.stringify(patch.memberIds)); }
    if (patch.mode !== undefined) { fields.push('mode = ?'); values.push(patch.mode); }
    if (patch.workspace !== undefined) { fields.push('workspace = ?'); values.push(patch.workspace); }
    if (fields.length === 0) return;
    values.push(id);
    this.db.raw.prepare(`UPDATE teams SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  remove(id: string) {
    this.db.raw.prepare('DELETE FROM team_runs WHERE team_id = ?').run(id);
    this.db.raw.prepare('DELETE FROM teams WHERE id = ?').run(id);
  }

  // ---------- 执行记录 ----------

  listRuns(teamId: string): TeamRun[] {
    return (this.db.raw.prepare('SELECT * FROM team_runs WHERE team_id = ? ORDER BY created_at DESC LIMIT 20').all(teamId) as unknown as RunRow[]).map(this.mapRun);
  }

  /** 崩溃恢复：启动时把未完成的流水线标记为 failed */
  recoverRuns() {
    const active = this.db.raw.prepare("SELECT id FROM team_runs WHERE phase IN ('decompose','execute','review')").all() as { id: string }[];
    if (active.length === 0) return;
    const now = Date.now();
    for (const r of active) {
      this.db.raw.prepare("UPDATE team_runs SET phase = 'failed', error = '客户端异常退出，流水线中断', ended_at = ? WHERE id = ?").run(now, r.id);
    }
  }

  // ---------- 团队执行 ----------

  /**
   * 触发团队任务：创建流水线记录并异步启动，立即返回 runId 供 UI 轮询。
   * coordinate：主专家拆解 → 逐步分派 → 验收综合。
   * roundtable：各专家依次发表观点 → 协调者总结。
   */
  trigger(teamId: string, task: string): { ok: boolean; message: string; runId?: string } {
    const team = this.list().find((t) => t.id === teamId);
    if (!team) return { ok: false, message: '团队不存在' };

    const agents = this.orchestrator.listAgents();
    const coordinator = agents.find((a) => a.id === team.coordinatorId);
    if (!coordinator) return { ok: false, message: '协调者助手不存在' };

    const members = team.memberIds
      .map((id) => agents.find((a) => a.id === id))
      .filter((a): a is Agent => !!a);
    if (members.length === 0) return { ok: false, message: '团队至少需要一位成员' };

    const runId = `run-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    this.db.raw.prepare(
      "INSERT INTO team_runs(id, team_id, task_text, phase, current_step, total_steps, subtasks_json, created_at) VALUES(?,?,?,?,0,0,'[]',?)"
    ).run(runId, teamId, task, 'decompose', now);

    // 异步启动流水线（不阻塞 IPC 返回）
    void this.runPipeline(runId, team, coordinator, members, task);

    return {
      ok: true,
      message: team.mode === 'roundtable'
        ? `圆桌讨论已启动：${members.length} 位专家依次发言，${coordinator.name} 最后总结`
        : `团队「${team.name}」已启动：${coordinator.name} 正在拆解任务`,
      runId
    };
  }

  // ---------- 流水线核心 ----------

  private async runPipeline(runId: string, team: Team, coordinator: Agent, members: Agent[], task: string) {
    const ws = this.ensureWorkspace(team);
    this.appendProgress(ws, `流水线启动｜任务：${task}`);

    try {
      // Phase 1：拆解（圆桌模式为固定视角分配，无需 LLM 拆解）
      let subtasks: TeamRunSubtask[];
      if (team.mode === 'roundtable') {
        subtasks = members.map((m) => ({
          agent: m.name, agentId: m.id,
          subtask: `请从你的专业角度（${m.role || '通用'}）分析以下问题并给出观点：${task}`,
          taskId: null, status: 'pending' as const
        }));
      } else {
        subtasks = await this.decompose(runId, team, coordinator, members, task, ws);
      }

      this.writeOutline(ws, team, coordinator, task, subtasks);
      this.updateRun(runId, { phase: 'execute', total_steps: subtasks.length, subtasks_json: JSON.stringify(subtasks) });
      this.appendProgress(ws, `拆解完成，共 ${subtasks.length} 个子任务，开始逐步执行`);

      // Phase 2：逐步执行（顺序，前一个完成后才派发下一个）
      const handoffNames: string[] = [];
      for (let i = 0; i < subtasks.length; i++) {
        const st = subtasks[i];
        st.status = 'running';
        this.updateRun(runId, { current_step: i + 1, subtasks_json: JSON.stringify(subtasks) });
        this.appendProgress(ws, `[${i + 1}/${subtasks.length}] ${st.agent} 开始执行：${st.subtask.slice(0, 80)}`);

        const member = members.find((m) => m.id === st.agentId);
        if (!member) {
          st.status = 'failed';
          this.appendProgress(ws, `[${i + 1}/${subtasks.length}] 成员不存在，跳过`);
          continue;
        }

        const prompt = this.buildMemberPrompt(team, task, st.subtask, ws, handoffNames, i);
        // title 即执行器 prompt（cliExecutor/llmApiExecutor 直接读取 task.title），
        // 必须在创建时传入完整上下文，不能事后更新（dispatch 同步读取存在竞态）
        const subTask = this.orchestrator.createTask(member.id, prompt.slice(0, 2000), 'team', { workspaceOverride: ws });
        st.taskId = subTask.id;
        this.updateRun(runId, { subtasks_json: JSON.stringify(subtasks) });

        const done = await this.orchestrator.waitForTask(subTask.id, STEP_TIMEOUT_MS);
        const ok = done?.status === 'COMPLETED';
        st.status = ok ? 'done' : 'failed';

        const result = ok ? (this.orchestrator.taskResult(subTask.id) ?? '（无产出）') : `执行失败：${done?.error ?? '超时'}`;
        const handoffName = this.writeHandoff(ws, i + 1, member.name, st.subtask, result, ok);
        handoffNames.push(handoffName);
        this.appendProgress(ws, `[${i + 1}/${subtasks.length}] ${st.agent} ${ok ? '完成' : '失败'}，交接文档：${handoffName}`);
        this.updateRun(runId, { subtasks_json: JSON.stringify(subtasks) });
      }

      // Phase 3：验收综合
      this.updateRun(runId, { phase: 'review' });
      this.appendProgress(ws, '全部子任务结束，协调者开始验收综合');

      const reviewPrompt = this.buildReviewPrompt(team, task, ws, handoffNames);
      const reviewTask = this.orchestrator.createTask(coordinator.id, reviewPrompt.slice(0, 2000), 'team', { workspaceOverride: ws });

      const reviewDone = await this.orchestrator.waitForTask(reviewTask.id, STEP_TIMEOUT_MS);
      const finalResult = reviewDone?.status === 'COMPLETED'
        ? (this.orchestrator.taskResult(reviewTask.id) ?? '（无结论）')
        : `验收任务失败：${reviewDone?.error ?? '超时'}`;

      this.appendProgress(ws, `流水线完成｜最终结论已产出`);
      this.updateRun(runId, { phase: 'done', final_result: finalResult, ended_at: Date.now() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.appendProgress(ws, `流水线异常：${message}`);
      this.updateRun(runId, { phase: 'failed', error: message, ended_at: Date.now() });
    }
  }

  /** Phase 1：协调者真实拆解（LLM 输出 JSON；解析失败则按成员均分降级） */
  private async decompose(runId: string, team: Team, coordinator: Agent, members: Agent[], task: string, ws: string): Promise<TeamRunSubtask[]> {
    const memberDesc = members.map((m) => `${m.name}（${m.role || '通用职责'}）`).join('、');
    const prompt = `你是团队「${team.name}」的主专家（协调者）。你的团队成员有：${memberDesc}。
请分析以下任务，拆解为 ${members.length} 个互不重叠的子任务，每个子任务分配给最合适的一位成员，确保覆盖完整且无遗漏。
仅输出 JSON 数组，不要其他内容：[{"agent":"成员名","subtask":"具体子任务描述（含验收标准）"}]

任务：${task}`;

    const decompTask = this.orchestrator.createTask(coordinator.id, prompt.slice(0, 2000), 'team', { workspaceOverride: ws });

    const done = await this.orchestrator.waitForTask(decompTask.id, STEP_TIMEOUT_MS);
    if (done?.status === 'COMPLETED') {
      const result = this.orchestrator.taskResult(decompTask.id) ?? '';
      const parsed = this.parseDecomposition(result, members);
      if (parsed.length > 0) {
        this.appendProgress(ws, `协调者拆解出 ${parsed.length} 个子任务`);
        return parsed;
      }
      this.appendProgress(ws, '拆解结果解析失败，降级为按成员均分');
    } else {
      this.appendProgress(ws, `拆解任务未完成（${done?.status ?? '超时'}），降级为按成员均分`);
    }

    // 降级：按成员数均分
    return members.map((m, i) => ({
      agent: m.name, agentId: m.id,
      subtask: `完成任务的第 ${i + 1} 部分（共 ${members.length} 部分），结合你的职责「${m.role || '通用'}」：${task}`,
      taskId: null, status: 'pending' as const
    }));
  }

  /** 从协调者输出中提取 JSON 子任务数组，映射到真实成员 ID */
  private parseDecomposition(result: string, members: Agent[]): TeamRunSubtask[] {
    const match = result.match(/\[[\s\S]*\]/);
    if (!match) return [];
    try {
      const arr = JSON.parse(match[0]) as { agent?: string; subtask?: string }[];
      const out: TeamRunSubtask[] = [];
      for (const item of arr) {
        if (!item.subtask) continue;
        const member = members.find((m) => m.name === item.agent) ?? members[out.length % members.length];
        out.push({ agent: member.name, agentId: member.id, subtask: String(item.subtask), taskId: null, status: 'pending' });
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Phase 2：成员提示词 = 原始任务 + 你的子任务 + 大纲 + 前序交接摘要 */
  private buildMemberPrompt(team: Team, task: string, subtask: string, ws: string, prevHandoffs: string[], step: number): string {
    const outline = this.readSafe(join(ws, '_aibox', 'OUTLINE.md'));
    const handoffCtx = prevHandoffs.length > 0
      ? `\n\n## 前序成员交接内容\n${prevHandoffs.map((n) => this.readSafe(join(ws, '_aibox', 'handoffs', n))).join('\n\n---\n\n')}`
      : '';
    return `你正在参与团队「${team.name}」的协作任务，工作目录已切换到团队共享空间，_aibox/ 目录下有大纲与交接文档可供参考。

## 团队总任务
${task}

## 你的子任务（第 ${step + 1} 步）
${subtask}

## 团队大纲
${outline || '（无）'}
${handoffCtx}

请完成你的子任务，产出写入工作目录，并在结果中说明：做了什么、产出文件、遗留问题。`;
  }

  /** Phase 3：验收提示词 = 原始任务 + 全部交接文档 */
  private buildReviewPrompt(team: Team, task: string, ws: string, handoffNames: string[]): string {
    const handoffs = handoffNames.map((n) => this.readSafe(join(ws, '_aibox', 'handoffs', n))).join('\n\n---\n\n');
    return `你是团队「${team.name}」的主专家（协调者）。各成员已完成各自的子任务，以下是他们的交接文档：

${handoffs || '（无交接内容）'}

## 团队总任务
${task}

请验收各成员的产出：检查是否覆盖任务要求、指出不足与风险，然后给出最终综合结论。`;
  }

  // ---------- MD 交接协议 ----------

  private ensureWorkspace(team: Team): string {
    const ws = team.workspace || join(app.getPath('userData'), 'workspaces', team.id);
    mkdirSync(join(ws, '_aibox', 'handoffs'), { recursive: true });
    return ws;
  }

  private writeOutline(ws: string, team: Team, coordinator: Agent, task: string, subtasks: TeamRunSubtask[]) {
    const content = `# 团队大纲 — ${team.name}

## 总任务
${task}

## 协调者
${coordinator.name}

## 分工（按执行顺序）
${subtasks.map((s, i) => `${i + 1}. **${s.agent}**：${s.subtask}`).join('\n')}

## 协作规范
- 所有产出写入本工作目录（团队共享）
- 每步完成后引擎自动生成交接文档（_aibox/handoffs/）
- 后续成员可读取前序交接内容，避免信息孤岛
- 有冲突时以协调者大纲为准

_生成时间：${new Date().toLocaleString()}_
`;
    writeFileSync(join(ws, '_aibox', 'OUTLINE.md'), content, 'utf8');
  }

  private writeHandoff(ws: string, step: number, agentName: string, subtask: string, result: string, ok: boolean): string {
    const safeName = agentName.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 20);
    const filename = `${String(step).padStart(2, '0')}-${safeName}.md`;
    const content = `# 交接文档 — 第 ${step} 步｜${agentName}

## 状态
${ok ? '已完成' : '失败'}

## 子任务
${subtask}

## 产出与说明
${result.slice(0, 4000)}

_生成时间：${new Date().toLocaleString()}_
`;
    writeFileSync(join(ws, '_aibox', 'handoffs', filename), content, 'utf8');
    return filename;
  }

  private appendProgress(ws: string, message: string) {
    try {
      appendFileSync(join(ws, '_aibox', 'PROGRESS.md'), `- [${new Date().toLocaleString()}] ${message}\n`, 'utf8');
    } catch { /* 日志写入失败不阻塞流水线 */ }
  }

  private readSafe(path: string): string {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return '';
    }
  }

  // ---------- 内部工具 ----------

  private updateRun(runId: string, patch: { phase?: TeamRunPhase; current_step?: number; total_steps?: number; subtasks_json?: string; final_result?: string; error?: string; ended_at?: number }) {
    const fields: string[] = [];
    const values: (string | number)[] = [];
    if (patch.phase !== undefined) { fields.push('phase = ?'); values.push(patch.phase); }
    if (patch.current_step !== undefined) { fields.push('current_step = ?'); values.push(patch.current_step); }
    if (patch.total_steps !== undefined) { fields.push('total_steps = ?'); values.push(patch.total_steps); }
    if (patch.subtasks_json !== undefined) { fields.push('subtasks_json = ?'); values.push(patch.subtasks_json); }
    if (patch.final_result !== undefined) { fields.push('final_result = ?'); values.push(patch.final_result); }
    if (patch.error !== undefined) { fields.push('error = ?'); values.push(patch.error); }
    if (patch.ended_at !== undefined) { fields.push('ended_at = ?'); values.push(patch.ended_at); }
    if (fields.length === 0) return;
    values.push(runId);
    this.db.raw.prepare(`UPDATE team_runs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  private mapRow(r: TeamRow): Team {
    let memberIds: string[] = [];
    try { memberIds = JSON.parse(r.member_ids) as string[]; } catch { /* ignore */ }
    return {
      id: r.id, name: r.name, coordinatorId: r.coordinator_id,
      memberIds, mode: r.mode as Team['mode'], workspace: r.workspace ?? '', createdAt: r.created_at
    };
  }

  private mapRun(r: RunRow): TeamRun {
    let subtasks: TeamRunSubtask[] = [];
    try { subtasks = JSON.parse(r.subtasks_json) as TeamRunSubtask[]; } catch { /* ignore */ }
    return {
      id: r.id, teamId: r.team_id, taskText: r.task_text,
      phase: r.phase as TeamRunPhase, currentStep: r.current_step, totalSteps: r.total_steps,
      subtasks, finalResult: r.final_result, error: r.error,
      createdAt: r.created_at, endedAt: r.ended_at
    };
  }
}
