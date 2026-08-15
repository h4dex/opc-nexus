/**
 * 专家团执行引擎（主Agent调度循环版）：
 * - coordinate（主专家协调）：主Agent拆解任务 → 并行分派给各成员 → 监控收集结果 → 决策（追加/重试/完成）→ 循环直到完成
 * - roundtable（专家圆桌）：各专家并行对同一问题发表观点 → 协调者总结
 * - 各成员经自己的 engineId 路由到对应引擎执行（支持多引擎混合分工）
 * - 团队共享工作空间 + MD 交接协议（_aibox/OUTLINE.md + handoffs/ + PROGRESS.md），消除信息孤岛
 * - 流水线状态持久化到 team_runs 表，UI 可轮询进度
 * - 失败重试：主Agent自动决策重试（受 maxRetries 配置约束）+ UI 手动点击重试
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { app } from 'electron';
import type { Database } from './database.js';
import type { Orchestrator } from './orchestrator.js';
import type { KnowledgeManager } from './knowledgeManager.js';
import type {
  Agent, DeliverableReviewStatus, TeamCollaborationOverview, TeamMemberContribution,
  TeamConfig, TeamRun, TeamRunPhase, TeamRunSubtask, TeamRunTrace, TeamTimelineEvent
} from '../../shared/types.js';

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
  project_id: string | null;
  task_text: string;
  phase: string;
  current_step: number;
  total_steps: number;
  subtasks_json: string;
  events_json: string;
  final_result: string | null;
  error: string | null;
  created_at: number;
  ended_at: number | null;
}

interface ProjectRefRow {
  id: string;
  name: string;
}

interface DeliverableRefRow {
  id: string;
  source_type: string;
  source_id: string;
  project_id: string | null;
  title: string;
  review_status: DeliverableReviewStatus;
}

/** 单步等待超时（10 分钟） */
const STEP_TIMEOUT_MS = 10 * 60_000;

const DEFAULT_TEAM_CONFIG: TeamConfig = { timeout: 600, maxRetries: 1, concurrency: 1 };

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim().length > 0
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

function normalizeTeamConfig(value: unknown): TeamConfig {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    timeout: boundedInteger(input.timeout, DEFAULT_TEAM_CONFIG.timeout, 60, 3600),
    maxRetries: boundedInteger(input.maxRetries, DEFAULT_TEAM_CONFIG.maxRetries, 0, 5),
    concurrency: boundedInteger(input.concurrency, DEFAULT_TEAM_CONFIG.concurrency, 1, 5)
  };
}

/** 运行中流水线的控制信号（UI 中途干预：取消/跳过/强制重试/注入指导） */
interface RunControl {
  cancel: boolean;          // 取消整个运行
  skip: Set<number>;        // 要跳过的子任务下标
  forceRetry: Set<number>;  // 要强制重试的失败子任务下标
  guidance: string[];       // 注入给主Agent的人类指导（决策时消费）
}

export class TeamEngine {
  /** 正在手动重试中的 run（防并发） */
  private retryingRuns = new Set<string>();
  /** 运行控制注册表：runId → 控制信号（流水线内存态，无需持久化） */
  private controls = new Map<string, RunControl>();

  constructor(private db: Database, private orchestrator: Orchestrator, private knowledge?: KnowledgeManager) {}

  /** 获取或创建 run 的控制信号（公开以供测试检验控制状态） */
  control(runId: string): RunControl {
    let c = this.controls.get(runId);
    if (!c) { c = { cancel: false, skip: new Set(), forceRetry: new Set(), guidance: [] }; this.controls.set(runId, c); }
    return c;
  }

  /**
   * A timeout is terminal for the team step. Releasing the child task here
   * keeps the orchestrator's agent-slot accounting honest; otherwise a timed
   * out child may keep running while the next round starts.
   */
  private async waitForTask(taskId: string, timeoutMs: number, reason = '团队子任务超时') {
    const done = await this.orchestrator.waitForTask(taskId, timeoutMs);
    if (done === null) {
      try { this.orchestrator.cancelTask(taskId, reason); } catch { /* child may have completed concurrently */ }
    }
    return done;
  }

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
    const rows = this.db.raw.prepare('SELECT * FROM team_runs WHERE team_id = ? ORDER BY created_at DESC LIMIT 20').all(teamId) as unknown as RunRow[];
    return this.mapRunsWithTrace(rows);
  }

  /** 列出需关注的团队运行（失败/取消），供收件箱聚合 */
  listAttentionRuns(limit = 20): (TeamRun & { teamName: string })[] {
    const rows = this.db.raw.prepare("SELECT * FROM team_runs WHERE phase IN ('failed','cancelled') ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as RunRow[];
    const teams = this.list();
    return this.mapRunsWithTrace(rows).map((run) => ({ ...run, teamName: teams.find((t) => t.id === run.teamId)?.name ?? '未知团队' }));
  }

  getCollaborationOverview(teamId: string): TeamCollaborationOverview {
    const team = this.list().find((item) => item.id === teamId);
    if (!team) throw new Error('团队不存在');

    const rows = this.db.raw.prepare('SELECT * FROM team_runs WHERE team_id = ? ORDER BY created_at DESC').all(teamId) as unknown as RunRow[];
    const runs = this.mapRunsWithTrace(rows);
    const agents = this.orchestrator.listAgents();
    const contribution = new Map<string, TeamMemberContribution & { durationTotal: number; durationCount: number }>();
    const memberIds = [team.coordinatorId, ...team.memberIds];
    for (const agentId of memberIds) {
      const agent = agents.find((item) => item.id === agentId);
      contribution.set(agentId, {
        agentId, name: agent?.name ?? '已归档成员', role: agent?.role ?? '',
        teamRole: agentId === team.coordinatorId ? 'coordinator' : 'expert',
        assigned: 0, completed: 0, failed: 0, skipped: 0, retries: 0, decisions: 0,
        completionRate: 0, avgDurationMs: 0, durationTotal: 0, durationCount: 0
      });
    }

    let interventionCount = 0;
    const recentDecisions: TeamCollaborationOverview['recentDecisions'] = [];
    for (const run of runs) {
      const hasStructuredInterventions = run.events.some((event) => event.type === 'intervention');
      for (const subtask of run.subtasks) {
        let item = contribution.get(subtask.agentId);
        if (!item) {
          item = {
            agentId: subtask.agentId, name: subtask.agent, role: '', teamRole: 'expert',
            assigned: 0, completed: 0, failed: 0, skipped: 0, retries: 0, decisions: 0,
            completionRate: 0, avgDurationMs: 0, durationTotal: 0, durationCount: 0
          };
          contribution.set(subtask.agentId, item);
        }
        item.assigned++;
        if (subtask.status === 'done') item.completed++;
        else if (subtask.status === 'failed') item.failed++;
        else if (subtask.status === 'skipped') item.skipped++;
        item.retries += subtask.retryCount ?? 0;
      }
      for (const event of run.events) {
        if (event.type === 'subtask_done') {
          const item = contribution.get(event.agentId);
          if (item) { item.durationTotal += event.durationMs; item.durationCount++; }
        } else if (event.type === 'decision') {
          const coordinator = contribution.get(team.coordinatorId);
          if (coordinator) coordinator.decisions++;
          recentDecisions.push({
            runId: run.id, taskText: run.taskText, round: event.round, action: event.action,
            summary: event.summary, reasoning: event.reasoning, createdAt: event.ts
          });
        } else if (event.type === 'intervention' || (!hasStructuredInterventions && (event.type === 'guidance' || event.type === 'skipped' || event.type === 'cancelled'))) {
          interventionCount++;
        }
      }
    }

    const members = [...contribution.values()].map(({ durationTotal, durationCount, ...item }) => ({
      ...item,
      completionRate: item.assigned ? Math.round((item.completed / item.assigned) * 100) : 0,
      avgDurationMs: durationCount ? Math.round(durationTotal / durationCount) : 0
    }));
    const projectMap = new Map(
      (this.db.raw.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as unknown as ProjectRefRow[])
        .map((project) => [project.id, project.name])
    );
    const deliverables = this.db.raw.prepare('SELECT * FROM deliverables ORDER BY updated_at DESC').all() as unknown as DeliverableRefRow[];
    const projects = [...new Set(runs.map((run) => run.projectId).filter((id): id is string => Boolean(id)))].map((projectId) => {
      const projectRuns = runs.filter((run) => run.projectId === projectId);
      const projectDeliverables = deliverables.filter((item) => item.project_id === projectId && item.source_type === 'team_run' && projectRuns.some((run) => run.id === item.source_id));
      return {
        projectId, projectName: projectMap.get(projectId) ?? '已归档项目', runCount: projectRuns.length,
        deliverableCount: projectDeliverables.length,
        acceptedDeliverables: projectDeliverables.filter((item) => item.review_status === 'accepted').length,
        lastRunAt: Math.max(...projectRuns.map((run) => run.createdAt))
      };
    }).sort((a, b) => b.lastRunAt - a.lastRunAt);
    const ended = runs.filter((run) => run.endedAt !== null);
    const terminal = runs.filter((run) => ['done', 'failed', 'cancelled'].includes(run.phase));
    const teamDeliverables = deliverables.filter((item) => item.source_type === 'team_run' && runs.some((run) => run.id === item.source_id));

    return {
      teamId,
      metrics: {
        totalRuns: runs.length,
        activeRuns: runs.filter((run) => ['clarify', 'decompose', 'execute', 'review'].includes(run.phase)).length,
        successRate: terminal.length ? Math.round((terminal.filter((run) => run.phase === 'done').length / terminal.length) * 100) : 0,
        avgDurationMs: ended.length ? Math.round(ended.reduce((sum, run) => sum + (run.durationMs ?? 0), 0) / ended.length) : 0,
        projectCount: projects.length,
        deliverableCount: teamDeliverables.length,
        acceptedDeliverables: teamDeliverables.filter((item) => item.review_status === 'accepted').length,
        interventionCount
      },
      members,
      projects,
      recentDecisions: recentDecisions.sort((a, b) => b.createdAt - a.createdAt).slice(0, 5)
    };
  }

  /** 崩溃恢复：检测中断的流水线并自动续跑（而非简单标记失败）。需在引擎就绪后调用。 */
  recoverOrResume() {
    const active = this.db.raw.prepare("SELECT id FROM team_runs WHERE phase IN ('clarify','decompose','execute','review')").all() as { id: string }[];
    if (active.length === 0) return;
    for (const r of active) {
      void this.resumePipeline(r.id); // 异步续跑，不阻塞启动
    }
  }

  /**
   * 从持久化状态续跑中断的流水线（可恢复状态机核心）：
   * - 澄清/拆解阶段：状态不完整，从头重启整个流水线
   * - 执行/验收阶段：从持久化的子任务状态续跑，将中断的 running/retrying 子任务重置为 pending 重新分派
   */
  private async resumePipeline(runId: string) {
    const row = this.db.raw.prepare('SELECT * FROM team_runs WHERE id = ?').get(runId) as RunRow | undefined;
    if (!row) return;

    const team = this.list().find((t) => t.id === row.team_id);
    if (!team) { this.updateRun(runId, { phase: 'failed', error: '团队已不存在，无法续跑', ended_at: Date.now() }); return; }
    const agents = this.orchestrator.listAgents();
    const coordinator = agents.find((a) => a.id === team.coordinatorId);
    if (!coordinator) { this.updateRun(runId, { phase: 'failed', error: '协调者不存在，无法续跑', ended_at: Date.now() }); return; }
    const members = team.memberIds.map((id) => agents.find((a) => a.id === id)).filter((a): a is Agent => !!a);

    const ws = this.ensureWorkspace(team);

    // 早期阶段（澄清/拆解）：状态不完整，从头重启整个流水线
    if (row.phase === 'clarify' || row.phase === 'decompose') {
      this.appendProgress(ws, `检测到中断的流水线（${row.phase} 阶段），从头重启`);
      this.controls.delete(runId);
      await this.runPipeline(runId, team, coordinator, members, row.task_text);
      return;
    }

    // 执行/验收阶段：从持久化子任务状态续跑
    this.prepareKnowledgeContext(runId, ws, row.task_text);
    this.appendProgress(ws, `检测到中断的流水线（${row.phase} 阶段，第 ${row.current_step} 轮），开始续跑`);
    let subtasks: TeamRunSubtask[] = [];
    try { subtasks = JSON.parse(row.subtasks_json) as TeamRunSubtask[]; } catch { subtasks = []; }
    let events: TeamTimelineEvent[] = [];
    try { events = JSON.parse(row.events_json ?? '[]') as TeamTimelineEvent[]; } catch { events = []; }

    // 将崩溃时遗留的 running/retrying 子任务重置为 pending 重新分派（已完成产出保留）
    let resetCount = 0;
    for (const st of subtasks) {
      if (st.status === 'running' || st.status === 'retrying') { st.status = 'pending'; st.taskId = null; resetCount++; }
    }
    if (resetCount > 0) this.appendProgress(ws, `已将 ${resetCount} 个中断的子任务重置为待执行`);

    // 重新初始化控制态（续跑不继承崩溃前的临时控制信号）
    this.controls.delete(runId);
    this.control(runId);
    this.updateRun(runId, { phase: 'execute', subtasks_json: JSON.stringify(subtasks) });

    try {
      const config = this.getConfig(team.id);
      const startRound = row.current_step || 0;
      const freshBudget = Math.max(2, (config.maxRetries ?? 1) + 3);
      const maxRounds = startRound + freshBudget; // 从当前轮次继续，给予全新预算
      const conclusion = await this.executeRounds(runId, team, coordinator, members, row.task_text, ws, subtasks, config, maxRounds, events, startRound);
      if (this.control(runId).cancel) { this.abortAsCancelled(runId, events, ws); return; }
      this.appendProgress(ws, '续跑完成｜最终结论已产出');
      this.updateRun(runId, { phase: 'done', final_result: conclusion, ended_at: Date.now() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.appendProgress(ws, `续跑异常：${message}`);
      this.updateRun(runId, { phase: 'failed', error: message, ended_at: Date.now() });
    } finally {
      this.controls.delete(runId);
    }
  }

  // ---------- 团队执行 ----------

  /**
   * 触发团队任务：创建流水线记录并异步启动，立即返回 runId 供 UI 轮询。
   * coordinate：主专家拆解 → 逐步分派 → 验收综合。
   * roundtable：各专家依次发表观点 → 协调者总结。
   */
  trigger(teamId: string, task: string, projectId?: string): { ok: boolean; message: string; runId?: string } {
    const team = this.list().find((t) => t.id === teamId);
    if (!team) return { ok: false, message: '团队不存在' };

    const agents = this.orchestrator.listAgents();
    const coordinator = agents.find((a) => a.id === team.coordinatorId);
    if (!coordinator) return { ok: false, message: '协调者助手不存在' };

    const members = team.memberIds
      .map((id) => agents.find((a) => a.id === id))
      .filter((a): a is Agent => !!a);
    if (members.length === 0) return { ok: false, message: '团队至少需要一位成员' };
    if (projectId) {
      const project = this.db.raw.prepare("SELECT id FROM projects WHERE id = ? AND status != 'archived'").get(projectId) as { id: string } | undefined;
      if (!project) return { ok: false, message: '项目不存在或已归档' };
    }

    const runId = `run-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    this.db.raw.prepare(
      "INSERT INTO team_runs(id, team_id, project_id, task_text, phase, current_step, total_steps, subtasks_json, created_at) VALUES(?,?,?,?,?,0,0,'[]',?)"
    ).run(runId, teamId, projectId ?? null, task, 'clarify', now);

    // 异步启动流水线（不阻塞 IPC 返回）
    void this.runPipeline(runId, team, coordinator, members, task);

    return {
      ok: true,
      message: team.mode === 'roundtable'
        ? `圆桌讨论已启动：主Agent 正在澄清问题并生成 Spec，随后 ${members.length} 位专家依次发言`
        : `团队「${team.name}」已启动：${coordinator.name} 正在澄清问题并生成 Spec`,
      runId
    };
  }

  // ---------- 执行干预控制（UI 中途介入） ----------

  /** 返回处于活跃阶段的 run 行，否则 null */
  private activeRunRow(runId: string): RunRow | null {
    const row = this.db.raw.prepare('SELECT * FROM team_runs WHERE id = ?').get(runId) as RunRow | undefined;
    if (!row) return null;
    if (!['clarify', 'decompose', 'execute', 'review'].includes(row.phase)) return null;
    return row;
  }

  /** 取消整个运行：中止在飞子任务，流水线检测到后标记 cancelled */
  cancelRun(runId: string): { ok: boolean; message: string } {
    const row = this.activeRunRow(runId);
    if (!row) return { ok: false, message: '该执行不存在或已结束，无法取消' };
    this.control(runId).cancel = true;
    this.persistEvents(runId, [{ type: 'intervention', action: 'cancel', message: '用户请求取消团队运行', ts: Date.now() }]);
    let subtasks: TeamRunSubtask[] = [];
    try { subtasks = JSON.parse(row.subtasks_json) as TeamRunSubtask[]; } catch { /* ignore */ }
    for (const st of subtasks) {
      if ((st.status === 'running' || st.status === 'retrying') && st.taskId) {
        try { this.orchestrator.cancelTask(st.taskId); } catch { /* ignore */ }
      }
    }
    return { ok: true, message: '已请求取消，正在停止执行…' };
  }

  /** 跳过指定子任务（在执行中则先中止其任务），流水线将标记为 skipped 并继续 */
  skipSubtask(runId: string, subtaskIndex: number): { ok: boolean; message: string } {
    const row = this.activeRunRow(runId);
    if (!row) return { ok: false, message: '该执行不存在或已结束' };
    let subtasks: TeamRunSubtask[] = [];
    try { subtasks = JSON.parse(row.subtasks_json) as TeamRunSubtask[]; } catch { /* ignore */ }
    const st = subtasks[subtaskIndex];
    if (!st) return { ok: false, message: '子任务不存在' };
    if (st.status === 'done' || st.status === 'skipped') return { ok: false, message: '该子任务无法跳过' };
    if ((st.status === 'running' || st.status === 'retrying') && st.taskId) {
      try { this.orchestrator.cancelTask(st.taskId); } catch { /* ignore */ }
    }
    this.control(runId).skip.add(subtaskIndex);
    this.persistEvents(runId, [{ type: 'intervention', action: 'skip', message: `用户请求跳过「${st.agent}」的子任务`, agent: st.agent, ts: Date.now() }]);
    return { ok: true, message: `已跳过「${st.agent}」` };
  }

  /** 强制重试失败子任务：标记为 pending，下一轮调度捡起 */
  forceRetrySubtask(runId: string, subtaskIndex: number): { ok: boolean; message: string } {
    const row = this.activeRunRow(runId);
    if (!row) return { ok: false, message: '该执行不存在或已结束' };
    let subtasks: TeamRunSubtask[] = [];
    try { subtasks = JSON.parse(row.subtasks_json) as TeamRunSubtask[]; } catch { /* ignore */ }
    const st = subtasks[subtaskIndex];
    if (!st) return { ok: false, message: '子任务不存在' };
    if (st.status !== 'failed') return { ok: false, message: '只能强制重试失败的子任务' };
    this.control(runId).forceRetry.add(subtaskIndex);
    this.persistEvents(runId, [{ type: 'intervention', action: 'force_retry', message: `用户请求重试「${st.agent}」的失败子任务`, agent: st.agent, ts: Date.now() }]);
    return { ok: true, message: `将在下一轮重试「${st.agent}」` };
  }

  /** 注入人类指导：主Agent 下次调度决策时优先考虑 */
  injectGuidance(runId: string, message: string): { ok: boolean; message: string } {
    const row = this.activeRunRow(runId);
    if (!row) return { ok: false, message: '该执行不存在或已结束' };
    const text = message.trim();
    if (!text) return { ok: false, message: '指导内容不能为空' };
    this.control(runId).guidance.push(text);
    this.persistEvents(runId, [{ type: 'intervention', action: 'guidance', message: text, ts: Date.now() }]);
    return { ok: true, message: '已注入指导，主Agent 将在下次决策时考虑' };
  }

  // ---------- 流水线核心 ----------

  private async runPipeline(runId: string, team: Team, coordinator: Agent, members: Agent[], task: string) {
    const ws = this.ensureWorkspace(team);
    this.prepareKnowledgeContext(runId, ws, task);
    this.appendProgress(ws, `流水线启动｜任务：${task}`);
    const events: TeamTimelineEvent[] = [];

    try {
      // Phase 0：问题澄清 + 生成 Spec（主Agent 内部 AI 先澄清问题，输出结构化规格说明）
      events.push({ type: 'phase', phase: 'clarify', ts: Date.now() });
      this.persistEvents(runId, events);
      const spec = await this.clarify(runId, team, coordinator, task, ws);
      if (this.control(runId).cancel) { this.abortAsCancelled(runId, events, ws); return; }

      // Phase 1：拆解（圆桌模式为固定视角分配，无需 LLM 拆解）
      events.push({ type: 'phase', phase: 'decompose', ts: Date.now() });
      this.updateRun(runId, { phase: 'decompose' });
      this.persistEvents(runId, events);
      let subtasks: TeamRunSubtask[];
      if (team.mode === 'roundtable') {
        subtasks = members.map((m) => ({
          agent: m.name, agentId: m.id,
          subtask: `请从你的专业角度（${m.role || '通用'}）分析以下问题并给出观点：${task}`,
          taskId: null, status: 'pending' as const
        }));
      } else {
        subtasks = await this.decompose(runId, team, coordinator, members, task, ws, spec);
      }
      if (this.control(runId).cancel) { this.abortAsCancelled(runId, events, ws); return; }

      this.writeOutline(ws, team, coordinator, task, subtasks);
      this.updateRun(runId, { phase: 'execute', total_steps: subtasks.length, subtasks_json: JSON.stringify(subtasks) });
      this.appendProgress(ws, `拆解完成，共 ${subtasks.length} 个子任务，进入主Agent调度循环（并行分派+持续监控）`);

      // Phase 2：主Agent调度循环（并行分派 → 监控收集 → 协调者决策 → 追加/重试/完成）
      const config = this.getConfig(team.id);
      const maxRounds = Math.max(2, (config.maxRetries ?? 1) + 3);
      const conclusion = await this.executeRounds(runId, team, coordinator, members, task, ws, subtasks, config, maxRounds, events);

      // 调度循环结束后检查是否被取消
      if (this.control(runId).cancel) { this.abortAsCancelled(runId, events, ws); return; }

      this.appendProgress(ws, '流水线完成｜最终结论已产出');
      this.updateRun(runId, { phase: 'done', final_result: conclusion, ended_at: Date.now() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.appendProgress(ws, `流水线异常：${message}`);
      this.updateRun(runId, { phase: 'failed', error: message, ended_at: Date.now() });
    } finally {
      this.controls.delete(runId); // 清理控制信号
    }
  }

  /** 将 run 标记为人工取消（保留已完成子任务的产出） */
  private abortAsCancelled(runId: string, events: TeamTimelineEvent[], ws: string) {
    events.push({ type: 'cancelled', ts: Date.now() });
    this.appendProgress(ws, '流水线已被用户取消');
    this.persistEvents(runId, events);
    this.updateRun(runId, { phase: 'cancelled', error: '用户取消', ended_at: Date.now() });
  }

  /** 持久化时间线事件流（供 UI 执行时间线可视化） */
  private persistEvents(runId: string, events: TeamTimelineEvent[]) {
    const row = this.db.raw.prepare('SELECT * FROM team_runs WHERE id = ?').get(runId) as RunRow | undefined;
    let persisted: TeamTimelineEvent[] = [];
    try { persisted = JSON.parse(row?.events_json ?? '[]') as TeamTimelineEvent[]; } catch { /* ignore */ }
    const known = new Set(persisted.map((event) => JSON.stringify(event)));
    for (const event of events) {
      const key = JSON.stringify(event);
      if (!known.has(key)) { persisted.push(event); known.add(key); }
    }
    persisted.sort((a, b) => a.ts - b.ts);
    events.splice(0, events.length, ...persisted);
    this.updateRun(runId, { events_json: JSON.stringify(persisted) });
  }

  /** Phase 0：问题澄清 + 生成 Spec（主Agent 内部 AI 先澄清问题边界、目标、约束，输出结构化规格说明） */
  private async clarify(runId: string, team: Team, coordinator: Agent, task: string, ws: string): Promise<string> {
    this.appendProgress(ws, '主Agent 开始问题澄清，生成执行规格说明 (Spec)');
    const knowledgeContext = this.readSafe(join(ws, '_aibox', 'KNOWLEDGE.md'));
    const knowledgeBlock = knowledgeContext
      ? `\n\n## 本项目既有知识（完整内容见 _aibox/KNOWLEDGE.md）\n${knowledgeContext.slice(0, 700)}`
      : '';

    const prompt = `你是团队「${team.name}」的主专家（协调者）。在开始分工之前，请先对以下任务进行问题澄清，输出一份结构化的执行规格说明（Spec）。

要求：
1. 明确任务的核心目标和预期产出
2. 澄清关键假设和约束条件
3. 定义验收标准（什么样算完成）
4. 识别潜在风险和注意事项

输出格式（Markdown）：
# 执行规格说明 (Spec)
## 核心目标
## 预期产出
## 关键假设与约束
## 验收标准
## 风险与注意事项

任务：${task}${knowledgeBlock}`;

    const clarifyTask = this.orchestrator.createTask(coordinator.id, prompt.slice(0, 2000), 'team', { workspaceOverride: ws, projectId: this.projectIdForRun(runId) });
    const done = await this.waitForTask(clarifyTask.id, STEP_TIMEOUT_MS, '团队澄清任务超时');

    let spec = '';
    if (done?.status === 'COMPLETED') {
      spec = this.orchestrator.taskResult(clarifyTask.id) ?? '';
      // 写入 SPEC.md 到共享工作空间
      try { writeFileSync(join(ws, '_aibox', 'SPEC.md'), spec, 'utf8'); } catch { /* ignore */ }
      this.appendProgress(ws, 'Spec 已生成（_aibox/SPEC.md），开始任务拆解');
    } else {
      spec = `（澄清阶段未完成，直接基于原始任务执行）\n任务：${task}`;
      this.appendProgress(ws, `澄清任务未完成（${done?.status ?? '超时'}），跳过 Spec 直接拆解`);
    }
    return spec;
  }

  /** Phase 1：协调者真实拆解（LLM 输出 JSON；解析失败则按成员均分降级） */
  private async decompose(runId: string, team: Team, coordinator: Agent, members: Agent[], task: string, ws: string, spec: string): Promise<TeamRunSubtask[]> {
    const memberDesc = members.map((m) => `${m.name}（${m.role || '通用职责'}）`).join('、');
    const specCtx = spec && !spec.startsWith('（澄清阶段未完成') ? `\n\n## 已生成的执行规格说明 (Spec)\n${spec.slice(0, 800)}` : '';
    const prompt = `你是团队「${team.name}」的主专家（协调者）。你的团队成员有：${memberDesc}。
请基于以下任务和 Spec，拆解为 ${members.length} 个互不重叠的子任务，每个子任务分配给最合适的一位成员，确保覆盖完整且无遗漏。
仅输出 JSON 数组，不要其他内容：[{"agent":"成员名","subtask":"具体子任务描述（含验收标准）"}]
${specCtx}
任务：${task}`;

    const decompTask = this.orchestrator.createTask(coordinator.id, prompt.slice(0, 2000), 'team', { workspaceOverride: ws, projectId: this.projectIdForRun(runId) });

    const done = await this.waitForTask(decompTask.id, STEP_TIMEOUT_MS, '团队拆解任务超时');
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
  parseDecomposition(result: string, members: Agent[]): TeamRunSubtask[] {
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

  /** Phase 2：成员提示词 = 原始任务 + 你的子任务 + 大纲 + 已完成成员的交接摘要 */
  private buildMemberPrompt(team: Team, task: string, subtask: string, ws: string, prevHandoffs: string[], step: number): string {
    const outline = this.readSafe(join(ws, '_aibox', 'OUTLINE.md'));
    const knowledge = this.readSafe(join(ws, '_aibox', 'KNOWLEDGE.md'));
    const knowledgeCtx = knowledge
      ? `\n\n## 项目知识库（完整内容见 _aibox/KNOWLEDGE.md）\n${knowledge.slice(0, 650)}`
      : '';
    const handoffCtx = prevHandoffs.length > 0
      ? `\n\n## 其他成员已完成的交接内容\n${prevHandoffs.map((n) => this.readSafe(join(ws, '_aibox', 'handoffs', n))).filter(Boolean).join('\n\n---\n\n')}`
      : '';
    return `你正在参与团队「${team.name}」的协作任务，工作目录已切换到团队共享空间，_aibox/ 目录下有大纲与交接文档可供参考。

## 团队总任务
${task}

## 你的子任务
${subtask}
${knowledgeCtx}

## 团队大纲
${outline || '（无）'}
${handoffCtx}

请完成你的子任务，产出写入工作目录，并在结果中说明：做了什么、产出文件、遗留问题。`;
  }

  // ---------- 主Agent调度循环（并行分派 + 监控 + 决策） ----------

  /**
   * 调度循环核心：
   * 1. 按 config.concurrency 受限并行分派当前 pending 子任务（各成员使用自己的引擎）
   * 2. 等待本轮全部完成，收集产出
   * 3. 向主Agent汇报全部结果，由主Agent决策：完成（输出结论）/ 继续（追加新任务或重试失败项）
   * 4. 循环直到主Agent判定完成或达到最大轮次
   */
  private async executeRounds(
    runId: string, team: Team, coordinator: Agent, members: Agent[],
    task: string, ws: string, subtasks: TeamRunSubtask[],
    config: { timeout: number; maxRetries: number; concurrency: number }, maxRounds: number,
    events: TeamTimelineEvent[], startRound = 0
  ): Promise<string> {
    let round = startRound;

    while (round < maxRounds) {
      const c = this.control(runId);
      if (c.cancel) break; // 已取消，退出调度循环
      round++;

      // 响应干预信号：强制重试（failed → pending，下一轮捡起）
      for (const idx of [...c.forceRetry]) {
        const st = subtasks[idx];
        if (st && st.status === 'failed') { st.status = 'pending'; st.retryCount = (st.retryCount ?? 0) + 1; this.appendProgress(ws, `用户强制重试「${st.agent}」`); }
        c.forceRetry.delete(idx);
      }
      // 响应干预信号：跳过待执行子任务
      for (const idx of [...c.skip]) {
        const st = subtasks[idx];
        if (st && st.status === 'pending') {
          st.status = 'skipped';
          events.push({ type: 'skipped', round, agent: st.agent, ts: Date.now() });
          this.appendProgress(ws, `「${st.agent}」被用户跳过`);
          c.skip.delete(idx);
        }
      }

      const pending = subtasks.filter((s) => s.status === 'pending');
      if (pending.length === 0) break;

      // ① 受限并发分派：每个 worker 持有一个执行槽，完成后再领取下一个子任务。
      // 不要在这里把所有任务预先标记为 running，否则 UI 和取消逻辑都会误以为
      // 它们已经占用了底层 Agent 的并发配额。
      events.push({ type: 'round_start', round, count: pending.length, ts: Date.now() });
      this.updateRun(runId, { current_step: round, total_steps: subtasks.length, subtasks_json: JSON.stringify(subtasks) });
      this.persistEvents(runId, events);
      this.appendProgress(ws, `══ 第 ${round} 轮调度 ══ 并行分派 ${pending.length} 个子任务：${pending.map((s) => s.agent).join('、')}`);

      const stepTimeout = Math.max(60_000, (config.timeout || 600) * 1000);
      const configuredConcurrency = Number(config.concurrency);
      const concurrency = Number.isFinite(configuredConcurrency)
        ? Math.max(1, Math.floor(configuredConcurrency))
        : 1;
      let nextPending = 0;

      const runSubtask = async (st: TeamRunSubtask) => {
        const idx = subtasks.indexOf(st);
        // A task can be skipped/cancelled while it waits for a worker slot.
        if (this.control(runId).cancel) return;
        if (this.control(runId).skip.has(idx)) {
          this.control(runId).skip.delete(idx);
          st.status = 'skipped';
          events.push({ type: 'skipped', round, agent: st.agent, ts: Date.now() });
          this.appendProgress(ws, `${st.agent} 被用户跳过（第 ${round} 轮）`);
          this.updateRun(runId, { subtasks_json: JSON.stringify(subtasks) });
          this.persistEvents(runId, events);
          return;
        }
        st.status = 'running';
        st.round = round;
        this.updateRun(runId, { subtasks_json: JSON.stringify(subtasks) });
        const member = members.find((m) => m.id === st.agentId);
        if (!member) {
          st.status = 'failed';
          st.output = '成员不存在';
          events.push({ type: 'subtask_done', round, agent: st.agent, agentId: st.agentId, status: 'failed', durationMs: 0, ts: Date.now() });
          this.appendProgress(ws, `${st.agent} 成员不存在，标记失败`);
          return;
        }
        // 上下文 = 大纲 + 所有已完成成员的交接文档
        const doneHandoffs = subtasks.filter((s) => s.status === 'done').map((s) => this.handoffNameFor(subtasks.indexOf(s), s.agent));
        const prompt = this.buildMemberPrompt(team, task, st.subtask, ws, doneHandoffs, idx);
        // title 即执行器 prompt，各成员经自己的 engineId 路由到对应引擎执行
        const startedAt = Date.now();
        const subTask = this.orchestrator.createTask(member.id, prompt.slice(0, 2000), 'team', { workspaceOverride: ws, projectId: this.projectIdForRun(runId) });
        st.taskId = subTask.id;
        this.updateRun(runId, { subtasks_json: JSON.stringify(subtasks) });

        const done = await this.waitForTask(subTask.id, stepTimeout);
        // 干预：若该子任务在执行中被标记跳过，则记为 skipped
        if (this.control(runId).skip.has(idx)) {
          this.control(runId).skip.delete(idx);
          st.status = 'skipped';
          events.push({ type: 'skipped', round, agent: st.agent, ts: Date.now() });
          this.appendProgress(ws, `${st.agent} 被用户跳过（第 ${round} 轮）`);
          this.updateRun(runId, { subtasks_json: JSON.stringify(subtasks) });
          this.persistEvents(runId, events);
          return;
        }
        const ok = done?.status === 'COMPLETED';
        st.status = ok ? 'done' : 'failed';
        st.output = ok
          ? (this.orchestrator.taskResult(subTask.id) ?? '（无产出）')
          : `执行失败：${done?.error ?? done?.status ?? '超时'}`;

        events.push({ type: 'subtask_done', round, agent: st.agent, agentId: st.agentId, status: st.status, durationMs: Date.now() - startedAt, ts: Date.now() });
        this.writeHandoff(ws, idx + 1, member.name, st.subtask, st.output, ok);
        this.appendProgress(ws, `${st.agent} ${ok ? '✓ 完成' : '✗ 失败'}（第 ${round} 轮）`);
        this.updateRun(runId, { subtasks_json: JSON.stringify(subtasks) });
        this.persistEvents(runId, events);
      };

      const worker = async () => {
        while (!this.control(runId).cancel) {
          const index = nextPending++;
          if (index >= pending.length) return;
          await runSubtask(pending[index]);
        }
      };
      const workerCount = Math.min(concurrency, pending.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));

      // 干预：本轮执行期间若请求了取消，直接退出
      if (this.control(runId).cancel) break;

      // ② 本轮全部结束，消费注入的人类指导并向主Agent汇报决策
      const ctl = this.control(runId);
      const guidance = [...ctl.guidance];
      ctl.guidance.length = 0;
      if (guidance.length > 0) this.appendProgress(ws, `人类监督者注入 ${guidance.length} 条指导`);

      this.appendProgress(ws, `第 ${round} 轮执行结束，向主Agent汇报结果并请求调度决策…`);
      const decision = await this.coordinatorDecide(runId, team, coordinator, members, task, ws, subtasks, round, maxRounds, config.maxRetries ?? 1, guidance);

      // 记录主Agent决策节点（含完整推理，供时间线透明展示）
      const decisionSummary = decision.action === 'finish'
        ? '任务完成，输出最终结论'
        : `继续调度：${decision.newTasks.length > 0 ? `追加 ${decision.newTasks.length} 个新子任务` : ''}${subtasks.some((s) => s.status === 'pending' && (s.retryCount ?? 0) > 0) ? '重试失败子任务' : ''}`;
      events.push({ type: 'decision', round, action: decision.action, summary: decisionSummary, reasoning: decision.reasoning, ts: Date.now() });
      this.persistEvents(runId, events);

      if (decision.action === 'finish') {
        const failed = subtasks.filter((subtask) => subtask.status === 'failed').length;
        events.push({
          type: 'review', status: failed > 0 ? 'partial' : 'passed',
          summary: failed > 0 ? `验收完成，${failed} 个子任务未成功，结论按现有产出汇总` : '验收通过，所有已分派子任务均已形成有效产出',
          ts: Date.now()
        });
        this.persistEvents(runId, events);
        return decision.conclusion ?? this.buildFallbackSummary(subtasks);
      }

      // ③ 主Agent决策继续：追加新任务 / 重试失败项
      if (decision.newTasks.length > 0) {
        for (const nt of decision.newTasks) {
          subtasks.push(nt);
        }
        this.appendProgress(ws, `主Agent追加 ${decision.newTasks.length} 个新子任务：${decision.newTasks.map((s) => `${s.agent}→${s.subtask.slice(0, 30)}`).join('；')}`);
      }
      const retried = subtasks.filter((s) => s.status === 'pending' && (s.retryCount ?? 0) > 0).length;
      if (retried > 0) this.appendProgress(ws, `主Agent决定重试 ${retried} 个失败子任务`);
      this.updateRun(runId, { total_steps: subtasks.length, subtasks_json: JSON.stringify(subtasks) });
    }

    // 达到最大轮次，降级汇总
    this.appendProgress(ws, `已达最大调度轮次（${maxRounds}），直接汇总产出`);
    const failed = subtasks.filter((subtask) => subtask.status === 'failed').length;
    events.push({
      type: 'review', status: failed > 0 ? 'failed' : 'partial',
      summary: failed > 0 ? `达到最大轮次，仍有 ${failed} 个失败子任务` : '达到最大轮次，系统按现有成员产出生成阶段性结论',
      ts: Date.now()
    });
    this.persistEvents(runId, events);
    return this.buildFallbackSummary(subtasks);
  }

  /** 向主Agent汇报全部子任务结果，由主Agent决策下一步调度（可携带人类注入的指导） */
  private async coordinatorDecide(
    runId: string, team: Team, coordinator: Agent, members: Agent[],
    task: string, ws: string, subtasks: TeamRunSubtask[],
    round: number, maxRounds: number, maxRetries: number, guidance: string[] = []
  ): Promise<{ action: 'finish' | 'continue'; conclusion?: string; newTasks: TeamRunSubtask[]; reasoning?: string }> {
    const memberDesc = members.map((m) => `${m.name}（${m.role || '通用'}）`).join('、');
    const report = this.buildRoundReport(subtasks);
    const isLastRound = round >= maxRounds;
    const guidanceBlock = guidance.length > 0
      ? `\n\n## ⚡ 人类监督者注入的指导（必须优先考虑）\n${guidance.map((g) => `- ${g}`).join('\n')}`
      : '';

    const prompt = `你是团队「${team.name}」的主Agent（总调度者），持续监控所有成员的任务执行情况。团队成员：${memberDesc}。

## 团队总任务
${task}

## 当前全部子任务执行状态（第 ${round}/${maxRounds} 轮）
${report}${guidanceBlock}

## 你的调度决策
请评估当前进度，做出决策。仅输出 JSON，不要其他内容：

情况A - 任务已全部完成（或已足够完整），输出：
{"action":"finish","conclusion":"最终综合结论（验收各成员产出、指出不足与风险、给出总结）"}

情况B - 仍需继续（有失败需重试、或需追加新子任务），输出：
{"action":"continue","newTasks":[{"agent":"成员名","subtask":"新子任务描述（重试任务请注明是重试）"}]}

规则：
- 失败的子任务最多重试 ${maxRetries} 次（已重试次数见状态），超过则跳过并在结论中说明
- 已完成的子任务不要重复分派
- ${isLastRound ? '这是最后一轮，必须输出 finish' : '如果所有子任务都已完成，直接输出 finish'}`;

    const decideTask = this.orchestrator.createTask(coordinator.id, prompt.slice(0, 2000), 'team', { workspaceOverride: ws, projectId: this.projectIdForRun(runId) });
      const done = await this.waitForTask(decideTask.id, STEP_TIMEOUT_MS, '团队决策任务超时');

    if (done?.status === 'COMPLETED') {
      const result = this.orchestrator.taskResult(decideTask.id) ?? '';
      const parsed = this.parseDecision(result, members, subtasks, maxRetries);
      if (parsed) return { ...parsed, reasoning: result.slice(0, 2000) };
      this.appendProgress(ws, '主Agent决策解析失败，视为完成');
      return { action: 'finish', newTasks: [], reasoning: result.slice(0, 2000) };
    } else {
      this.appendProgress(ws, `主Agent决策任务未完成（${done?.status ?? '超时'}），视为完成`);
    }
    return { action: 'finish', newTasks: [] };
  }

  /** 构建全部子任务状态报告（供主Agent决策） */
  buildRoundReport(subtasks: TeamRunSubtask[]): string {
    return subtasks.map((st, i) => {
      const statusText = st.status === 'done' ? '✓完成' : st.status === 'failed' ? '✗失败' : st.status === 'running' ? '执行中' : st.status === 'skipped' ? '⊘已跳过' : '待执行';
      const retryInfo = (st.retryCount ?? 0) > 0 ? `（已重试${st.retryCount}次）` : '';
      const output = st.status === 'done'
        ? `产出摘要：${(st.output ?? '').slice(0, 300)}`
        : st.status === 'failed'
          ? `失败原因：${(st.output ?? '未知').slice(0, 200)}`
          : '';
      return `${i + 1}. [${statusText}]${retryInfo} ${st.agent}：${st.subtask.slice(0, 120)}${output ? `\n   ${output}` : ''}`;
    }).join('\n');
  }

  /** 解析主Agent的调度决策 JSON（公开以供测试） */
  parseDecision(
    result: string, members: Agent[], subtasks: TeamRunSubtask[], maxRetries: number
  ): { action: 'finish' | 'continue'; conclusion?: string; newTasks: TeamRunSubtask[] } | null {
    const match = result.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const obj = JSON.parse(match[0]) as { action?: string; conclusion?: string; newTasks?: { agent?: string; subtask?: string }[] };
      if (obj.action === 'finish') {
        return { action: 'finish', conclusion: obj.conclusion || undefined, newTasks: [] };
      }
      if (obj.action === 'continue' && Array.isArray(obj.newTasks)) {
        const newTasks: TeamRunSubtask[] = [];
        for (const nt of obj.newTasks) {
          if (!nt.subtask) continue;
          const subtaskText = String(nt.subtask);
          const member = members.find((m) => m.name === nt.agent) ?? members[newTasks.length % members.length];
          // 检查是否为重试任务：同名成员+相似子任务已失败且未超过重试上限
          const existingFailed = subtasks.find((s) => s.agentId === member.id && s.status === 'failed' && (s.retryCount ?? 0) < maxRetries
            && (subtaskText.includes('重试') || s.subtask.slice(0, 40) === subtaskText.slice(0, 40)));
          if (existingFailed) {
            existingFailed.status = 'pending';
            existingFailed.retryCount = (existingFailed.retryCount ?? 0) + 1;
            existingFailed.subtask = subtaskText;
          } else {
            newTasks.push({ agent: member.name, agentId: member.id, subtask: subtaskText, taskId: null, status: 'pending' });
          }
        }
        return { action: 'continue', newTasks };
      }
      return null;
    } catch {
      return null;
    }
  }

  /** 交接文档文件名（与 writeHandoff 命名规则一致） */
  private handoffNameFor(index: number, agentName: string): string {
    const safeName = agentName.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 20);
    return `${String(index + 1).padStart(2, '0')}-${safeName}.md`;
  }

  /** 降级汇总（主Agent决策失败或达到轮次上限时） */
  private buildFallbackSummary(subtasks: TeamRunSubtask[]): string {
    const done = subtasks.filter((s) => s.status === 'done');
    const failed = subtasks.filter((s) => s.status === 'failed');
    let summary = `## 团队执行汇总（自动降级）\n\n完成 ${done.length} 项，失败 ${failed.length} 项\n`;
    for (const s of done) summary += `\n### ${s.agent}（完成）\n${(s.output ?? '').slice(0, 800)}\n`;
    for (const s of failed) summary += `\n### ${s.agent}（失败）\n${(s.output ?? '').slice(0, 200)}\n`;
    return summary;
  }

  // ---------- MD 交接协议 ----------

  private ensureWorkspace(team: Team): string {
    const ws = team.workspace || join(app.getPath('userData'), 'workspaces', team.id);
    mkdirSync(join(ws, '_aibox', 'handoffs'), { recursive: true });
    return ws;
  }

  private prepareKnowledgeContext(runId: string, ws: string, task: string) {
    const projectId = this.projectIdForRun(runId);
    if (!projectId || !this.knowledge) return;
    try {
      const content = this.knowledge.buildProjectContext(projectId, task);
      writeFileSync(join(ws, '_aibox', 'KNOWLEDGE.md'), content, 'utf8');
      this.appendProgress(ws, '已加载项目知识库上下文（_aibox/KNOWLEDGE.md）');
    } catch (error) {
      this.appendProgress(ws, `项目知识加载失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private writeOutline(ws: string, team: Team, coordinator: Agent, task: string, subtasks: TeamRunSubtask[]) {
    const content = `# 团队大纲 — ${team.name}

## 总任务
${task}

## 协调者
${coordinator.name}

## 分工（主Agent统一调度，并行执行）
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

  private updateRun(runId: string, patch: { phase?: TeamRunPhase; current_step?: number; total_steps?: number; subtasks_json?: string; events_json?: string; final_result?: string; error?: string; ended_at?: number }) {
    const fields: string[] = [];
    const values: (string | number)[] = [];
    if (patch.phase !== undefined) { fields.push('phase = ?'); values.push(patch.phase); }
    if (patch.current_step !== undefined) { fields.push('current_step = ?'); values.push(patch.current_step); }
    if (patch.total_steps !== undefined) { fields.push('total_steps = ?'); values.push(patch.total_steps); }
    if (patch.subtasks_json !== undefined) { fields.push('subtasks_json = ?'); values.push(patch.subtasks_json); }
    if (patch.events_json !== undefined) { fields.push('events_json = ?'); values.push(patch.events_json); }
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

  private mapRunsWithTrace(rows: RunRow[]): TeamRun[] {
    const projects = new Map(
      (this.db.raw.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as unknown as ProjectRefRow[])
        .map((project) => [project.id, project.name])
    );
    const deliverables = new Map(
      (this.db.raw.prepare('SELECT * FROM deliverables ORDER BY updated_at DESC').all() as unknown as DeliverableRefRow[])
        .filter((item) => item.source_type === 'team_run')
        .map((item) => [item.source_id, item])
    );
    return rows.map((row) => {
      const run = this.mapRun(row);
      const deliverable = deliverables.get(run.id);
      const trace: TeamRunTrace = {
        project: run.projectId ? { id: run.projectId, name: projects.get(run.projectId) ?? '已归档项目' } : null,
        tasks: run.subtasks.flatMap((subtask) => subtask.taskId ? [{ id: subtask.taskId, agentId: subtask.agentId, agentName: subtask.agent }] : []),
        deliverable: deliverable ? { id: deliverable.id, title: deliverable.title, reviewStatus: deliverable.review_status } : null
      };
      return { ...run, trace };
    });
  }

  private mapRun(r: RunRow): TeamRun {
    let subtasks: TeamRunSubtask[] = [];
    try { subtasks = JSON.parse(r.subtasks_json) as TeamRunSubtask[]; } catch { /* ignore */ }
    let events: TeamTimelineEvent[] = [];
    try { events = JSON.parse(r.events_json ?? '[]') as TeamTimelineEvent[]; } catch { /* ignore */ }
    return {
      id: r.id, teamId: r.team_id, projectId: r.project_id ?? null, taskText: r.task_text,
      phase: r.phase as TeamRunPhase, currentStep: r.current_step, totalSteps: r.total_steps,
      subtasks, events, trace: { project: null, tasks: [], deliverable: null }, finalResult: r.final_result, error: r.error,
      createdAt: r.created_at, endedAt: r.ended_at,
      durationMs: r.ended_at ? r.ended_at - r.created_at : null
    };
  }

  private projectIdForRun(runId: string): string | undefined {
    const row = this.db.raw.prepare('SELECT project_id FROM team_runs WHERE id = ?').get(runId) as { project_id: string | null } | undefined;
    return row?.project_id ?? undefined;
  }

  // ---------- 手动重试失败子任务 ----------

  /**
   * 手动重试指定 run 中某个失败的子任务（UI 点击「重试」触发）。
   * 立即返回，异步执行；重试成功后自动重新验收综合。
   */
  retrySubtask(runId: string, subtaskIndex: number): { ok: boolean; message: string } {
    const row = this.db.raw.prepare('SELECT * FROM team_runs WHERE id = ?').get(runId) as RunRow | undefined;
    if (!row) return { ok: false, message: '执行记录不存在' };
    if (['clarify', 'decompose', 'execute', 'review'].includes(row.phase)) {
      return { ok: false, message: '流水线仍在执行中，请等待完成后再重试' };
    }
    if (this.retryingRuns.has(runId)) return { ok: false, message: '该记录已有子任务正在重试中' };

    let subtasks: TeamRunSubtask[] = [];
    try { subtasks = JSON.parse(row.subtasks_json) as TeamRunSubtask[]; } catch { /* ignore */ }
    const st = subtasks[subtaskIndex];
    if (!st) return { ok: false, message: '子任务不存在' };
    if (st.status !== 'failed') return { ok: false, message: '只能重试失败的子任务' };

    const team = this.list().find((t) => t.id === row.team_id);
    if (!team) return { ok: false, message: '团队不存在' };
    const agents = this.orchestrator.listAgents();
    const coordinator = agents.find((a) => a.id === team.coordinatorId);
    if (!coordinator) return { ok: false, message: '协调者助手不存在' };
    const member = agents.find((a) => a.id === st.agentId);
    if (!member) return { ok: false, message: `成员「${st.agent}」不存在` };

    // 标记为重试中（UI 轮询可感知）
    st.status = 'retrying';
    this.updateRun(runId, { subtasks_json: JSON.stringify(subtasks), phase: 'execute', current_step: subtaskIndex + 1, error: '' });
    this.persistEvents(runId, [{
      type: 'intervention', action: 'manual_retry', message: `用户手动重试「${st.agent}」的失败子任务`, agent: st.agent, ts: Date.now()
    }]);
    this.retryingRuns.add(runId);
    void this.doRetrySubtask(runId, row, team, coordinator, member, subtasks, subtaskIndex)
      .finally(() => this.retryingRuns.delete(runId));

    return { ok: true, message: `正在重试「${st.agent}」的子任务…` };
  }

  private async doRetrySubtask(runId: string, row: RunRow, team: Team, coordinator: Agent, member: Agent, subtasks: TeamRunSubtask[], index: number) {
    const ws = this.ensureWorkspace(team);
    const st = subtasks[index];
    this.appendProgress(ws, `手动重试｜${st.agent}：${st.subtask.slice(0, 60)}`);

    try {
      // 重建已完成成员的交接文档列表（作为上下文）
      const doneHandoffs = subtasks
        .filter((s, j) => j !== index && s.status === 'done')
        .map((s) => this.handoffNameFor(subtasks.indexOf(s), s.agent));

      const prompt = this.buildMemberPrompt(team, row.task_text, st.subtask, ws, doneHandoffs, index);
      const task = this.orchestrator.createTask(member.id, prompt.slice(0, 2000), 'team', { workspaceOverride: ws, projectId: this.projectIdForRun(runId) });
      st.taskId = task.id;
      this.updateRun(runId, { subtasks_json: JSON.stringify(subtasks) });

      const done = await this.waitForTask(task.id, STEP_TIMEOUT_MS);
      const ok = done?.status === 'COMPLETED';
      st.status = ok ? 'done' : 'failed';
      st.retryCount = (st.retryCount ?? 0) + 1;

      const result = ok ? (this.orchestrator.taskResult(task.id) ?? '（无产出）') : `重试失败：${done?.error ?? '超时'}`;
      this.writeHandoff(ws, index + 1, member.name, st.subtask, result, ok);
      this.appendProgress(ws, `手动重试${ok ? '成功' : '失败'}｜${st.agent}`);
      this.updateRun(runId, { subtasks_json: JSON.stringify(subtasks) });

      if (!ok) {
        // 重试仍失败，恢复终态
        const anyFailed = subtasks.some((s) => s.status === 'failed');
        this.persistEvents(runId, [{
          type: 'review', status: 'failed', summary: `重试后仍未通过验收：「${st.agent}」的子任务执行失败`, ts: Date.now()
        }]);
        this.updateRun(runId, { phase: anyFailed ? 'failed' : 'done', error: anyFailed ? '部分子任务失败' : '', ended_at: Date.now() });
        return;
      }

      // 重试成功 → 主Agent重新验收综合
      this.updateRun(runId, { phase: 'review' });
      this.appendProgress(ws, '重试成功，主Agent重新验收综合');

      const report = this.buildRoundReport(subtasks);
      const reviewPrompt = `你是团队「${team.name}」的主Agent（总调度者）。以下是全部子任务的最新执行状态：

${report}

## 团队总任务
${row.task_text}

请验收各成员的产出：检查是否覆盖任务要求、指出不足与风险，然后给出最终综合结论。`;
      const reviewTask = this.orchestrator.createTask(coordinator.id, reviewPrompt.slice(0, 2000), 'team', { workspaceOverride: ws, projectId: this.projectIdForRun(runId) });
      const reviewDone = await this.waitForTask(reviewTask.id, STEP_TIMEOUT_MS, '团队验收任务超时');
      const finalResult = reviewDone?.status === 'COMPLETED'
        ? (this.orchestrator.taskResult(reviewTask.id) ?? '（无结论）')
        : `验收任务失败：${reviewDone?.error ?? '超时'}`;

      this.appendProgress(ws, '重新验收完成，最终结论已更新');
      this.persistEvents(runId, [{
        type: 'review', status: 'passed', summary: `重试成功，主Agent 已重新验收「${st.agent}」的产出`, ts: Date.now()
      }]);
      this.updateRun(runId, { phase: 'done', final_result: finalResult, error: '', ended_at: Date.now() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      st.status = 'failed';
      this.appendProgress(ws, `重试异常：${message}`);
      this.persistEvents(runId, [{
        type: 'review', status: 'failed', summary: `重试验收异常：${message}`, ts: Date.now()
      }]);
      this.updateRun(runId, { phase: 'failed', error: `重试异常：${message}`, subtasks_json: JSON.stringify(subtasks), ended_at: Date.now() });
    }
  }

  // ---------- 团队配置 / 统计 ----------

  /** 获取团队配置 */
  getConfig(teamId: string): TeamConfig {
    const row = this.db.raw.prepare('SELECT config_json FROM teams WHERE id = ?').get(teamId) as { config_json?: string } | undefined;
    if (!row?.config_json) return { ...DEFAULT_TEAM_CONFIG };
    try { return normalizeTeamConfig(JSON.parse(row.config_json)); } catch { return { ...DEFAULT_TEAM_CONFIG }; }
  }

  /** 保存团队配置 */
  saveConfig(teamId: string, config: TeamConfig) {
    this.db.raw.prepare('UPDATE teams SET config_json = ? WHERE id = ?').run(JSON.stringify(normalizeTeamConfig(config)), teamId);
  }

  /** 获取团队统计（累计执行次数/平均耗时/成功率） */
  getStats(teamId: string): { totalRuns: number; avgDurationMs: number; successRate: number } {
    const runs = this.db.raw.prepare('SELECT phase, created_at, ended_at FROM team_runs WHERE team_id = ? AND ended_at IS NOT NULL').all(teamId) as { phase: string; created_at: number; ended_at: number }[];
    if (runs.length === 0) return { totalRuns: 0, avgDurationMs: 0, successRate: 0 };
    const totalMs = runs.reduce((sum, r) => sum + (r.ended_at - r.created_at), 0);
    const done = runs.filter((r) => r.phase === 'done').length;
    return {
      totalRuns: runs.length,
      avgDurationMs: Math.round(totalMs / runs.length),
      successRate: Math.round((done / runs.length) * 100)
    };
  }

  /** 获取子任务输出（通过 taskId 查询任务结果） */
  getSubtaskOutput(taskId: string): string | null {
    const row = this.db.raw.prepare('SELECT result FROM tasks WHERE id = ?').get(taskId) as { result?: string } | undefined;
    return row?.result ?? null;
  }

  // ---------- 自定义模板 ----------

  /** 保存当前团队为自定义模板 */
  saveAsTemplate(teamId: string, name?: string): { ok: boolean; message: string; id?: string } {
    const team = this.list().find((t) => t.id === teamId);
    if (!team) return { ok: false, message: '团队不存在' };
    const id = `tpl-${randomUUID().slice(0, 8)}`;
    const members = [team.coordinatorId, ...team.memberIds].map((mid) => {
      const agent = this.orchestrator.listAgents().find((a) => a.id === mid);
      return agent ? { name: agent.name, role: agent.role, soulMd: agent.soulMd, agentsMd: agent.agentsMd, permissionMode: agent.permissionMode } : null;
    }).filter(Boolean);
    this.db.raw.prepare('INSERT INTO team_templates(id, name, description, mode, members_json, created_at) VALUES(?,?,?,?,?,?)')
      .run(id, name || team.name, `自定义模板（来自团队「${team.name}」）`, team.mode, JSON.stringify(members), Date.now());
    return { ok: true, message: `已保存为模板「${name || team.name}」`, id };
  }

  /** 列出自定义模板 */
  listTemplates(): { id: string; name: string; description: string; mode: string; members: unknown[]; createdAt: number }[] {
    return (this.db.raw.prepare('SELECT * FROM team_templates ORDER BY created_at DESC').all() as unknown as {
      id: string; name: string; description: string; mode: string; members_json: string; created_at: number;
    }[]).map((r) => {
      let members: unknown[] = [];
      try { members = JSON.parse(r.members_json); } catch { /* empty */ }
      return { id: r.id, name: r.name, description: r.description, mode: r.mode, members, createdAt: r.created_at };
    });
  }

  /** 删除自定义模板 */
  removeTemplate(id: string) {
    this.db.raw.prepare('DELETE FROM team_templates WHERE id = ?').run(id);
  }
}
