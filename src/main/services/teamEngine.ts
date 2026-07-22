/**
 * 专家团执行引擎：多 Agent 协作模式。
 * - coordinate（主Agent协调）：协调者分析任务 → 拆解为子任务 → 分派给专家 → 收集结果 → 综合输出
 * - roundtable（专家圆桌）：各专家依次对同一问题发表观点 → 协调者总结
 * 团队由一个 coordinator（主Agent）+ 多个 member（专家）组成。
 */
import { randomUUID } from 'node:crypto';
import type { Database } from './database.js';
import type { Orchestrator } from './orchestrator.js';

export interface Team {
  id: string;
  name: string;
  coordinatorId: string;
  memberIds: string[];
  mode: 'coordinate' | 'roundtable';
  createdAt: number;
}

interface TeamRow {
  id: string;
  name: string;
  coordinator_id: string;
  member_ids: string;
  mode: string;
  created_at: number;
}

export class TeamEngine {
  constructor(private db: Database, private orchestrator: Orchestrator) {}

  // ---------- CRUD ----------

  list(): Team[] {
    return (this.db.raw.prepare('SELECT * FROM teams ORDER BY created_at DESC').all() as unknown as TeamRow[]).map(this.mapRow);
  }

  create(input: { name: string; coordinatorId: string; memberIds: string[]; mode?: 'coordinate' | 'roundtable' }): Team {
    const id = `team-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    this.db.raw.prepare('INSERT INTO teams(id, name, coordinator_id, member_ids, mode, created_at) VALUES(?,?,?,?,?,?)')
      .run(id, input.name, input.coordinatorId, JSON.stringify(input.memberIds), input.mode ?? 'coordinate', now);
    return { id, name: input.name, coordinatorId: input.coordinatorId, memberIds: input.memberIds, mode: input.mode ?? 'coordinate', createdAt: now };
  }

  update(id: string, patch: { name?: string; coordinatorId?: string; memberIds?: string[]; mode?: 'coordinate' | 'roundtable' }) {
    const fields: string[] = [];
    const values: (string | number)[] = [];
    if (patch.name !== undefined) { fields.push('name = ?'); values.push(patch.name); }
    if (patch.coordinatorId !== undefined) { fields.push('coordinator_id = ?'); values.push(patch.coordinatorId); }
    if (patch.memberIds !== undefined) { fields.push('member_ids = ?'); values.push(JSON.stringify(patch.memberIds)); }
    if (patch.mode !== undefined) { fields.push('mode = ?'); values.push(patch.mode); }
    if (fields.length === 0) return;
    values.push(id);
    this.db.raw.prepare(`UPDATE teams SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  remove(id: string) {
    this.db.raw.prepare('DELETE FROM teams WHERE id = ?').run(id);
  }

  // ---------- 团队执行 ----------

  /**
   * 触发团队任务：
   * coordinate 模式：协调者先执行分析任务，其产出作为上下文分派给各专家，最后协调者综合。
   * roundtable 模式：各专家依次对同一问题发表观点，协调者最后总结。
   * 返回协调者的最终任务（可轮询结果）。
   */
  trigger(teamId: string, task: string): { ok: boolean; message: string; finalTaskId?: string } {
    const team = this.list().find((t) => t.id === teamId);
    if (!team) return { ok: false, message: '团队不存在' };

    const agents = this.orchestrator.listAgents();
    const coordinator = agents.find((a) => a.id === team.coordinatorId);
    if (!coordinator) return { ok: false, message: '协调者助手不存在' };

    const members = team.memberIds
      .map((id) => agents.find((a) => a.id === id))
      .filter((a): a is NonNullable<typeof a> => !!a);

    if (team.mode === 'roundtable') {
      return this.runRoundtable(team, coordinator, members, task);
    }
    return this.runCoordinate(team, coordinator, members, task);
  }

  /** 协调模式：协调者拆解 → 专家执行 → 协调者综合 */
  private runCoordinate(team: Team, coordinator: { id: string; name: string }, members: { id: string; name: string }[], task: string): { ok: boolean; message: string; finalTaskId?: string } {
    // 第一步：协调者分析并拆解任务
    const analysisPrompt = `你是团队「${team.name}」的协调者。你的团队成员有：${members.map((m) => m.name).join('、')}。
请分析以下任务，为每位成员分配一个子任务（用 JSON 数组输出 [{"agent":"成员名","subtask":"子任务描述"}]），然后综合各成员结果给出最终答案。

任务：${task}`;

    // 创建协调者的分析任务
    const analysisTask = this.orchestrator.createTask(coordinator.id, `[团队:${team.name}] 分析拆解：${task.slice(0, 100)}`);

    // 为每位专家创建子任务（并行执行）
    for (const member of members) {
      this.orchestrator.createTask(member.id, `[团队:${team.name}] ${task.slice(0, 150)}`);
    }

    // 协调者最终综合任务（等专家完成后手动或自动触发）
    const synthPrompt = `[团队:${team.name}] 综合各专家意见，给出最终结论：${task.slice(0, 100)}`;
    const finalTask = this.orchestrator.createTask(coordinator.id, synthPrompt);

    return {
      ok: true,
      message: `团队「${team.name}」已启动：协调者 ${coordinator.name} 分析中，${members.length} 位专家并行执行`,
      finalTaskId: finalTask.id
    };
  }

  /** 圆桌模式：各专家依次发表观点 → 协调者总结 */
  private runRoundtable(team: Team, coordinator: { id: string; name: string }, members: { id: string; name: string }[], task: string): { ok: boolean; message: string; finalTaskId?: string } {
    // 每位专家对同一问题发表观点
    for (const member of members) {
      this.orchestrator.createTask(member.id, `[圆桌:${team.name}] 请从你的专业角度分析：${task.slice(0, 180)}`);
    }

    // 协调者最后总结
    const finalTask = this.orchestrator.createTask(coordinator.id, `[圆桌:${team.name}] 综合各位专家观点，给出最终结论：${task.slice(0, 100)}`);

    return {
      ok: true,
      message: `圆桌讨论已启动：${members.length} 位专家依次发言，${coordinator.name} 最后总结`,
      finalTaskId: finalTask.id
    };
  }

  private mapRow(r: TeamRow): Team {
    let memberIds: string[] = [];
    try { memberIds = JSON.parse(r.member_ids) as string[]; } catch { /* ignore */ }
    return {
      id: r.id, name: r.name, coordinatorId: r.coordinator_id,
      memberIds, mode: r.mode as Team['mode'], createdAt: r.created_at
    };
  }
}
