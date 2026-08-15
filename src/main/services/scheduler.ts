/**
 * 定时任务调度（P3a）：每 30s 扫描 schedules 表，到期创建 source='schedule' 的任务并推算下次运行。
 * cron_kind：interval（每 N 小时）/ daily（每天 HH:mm）/ weekly（每周几 D|HH:mm，0=周日）。
 * 启动时对过期项立即补跑一次（补跑后按当前时间推算下一次，不重复补历史）。
 */
import { randomUUID } from 'node:crypto';
import type { Database } from './database.js';
import type { Orchestrator } from './orchestrator.js';
import type { AutomationReportKind, Schedule, ScheduleInput } from '../../shared/types.js';

const SCAN_MS = 30_000;

interface ScheduleRow {
  id: string;
  agent_id: string | null;
  project_id: string | null;
  automation_kind: string;
  title: string;
  content: string;
  cron_kind: string;
  cron_value: string;
  enabled: number;
  last_run_at: number | null;
  next_run_at: number;
}

/** 计算下一次运行时间（从 from 起） */
export function computeNextRun(kind: Schedule['cronKind'], value: string, from: number): number {
  if (kind === 'interval') {
    const hours = Math.max(0.5, Number(value) || 24);
    return from + Math.round(hours * 3_600_000);
  }
  const [dayPart, timePart] = (kind === 'weekly' || kind === 'monthly') ? value.split('|') : [null, value];
  const [hh, mm] = (timePart || '09:00').split(':').map((n) => Number(n) || 0);
  const next = new Date(from);
  next.setHours(hh, mm, 0, 0);
  if (kind === 'daily') {
    if (next.getTime() <= from) next.setDate(next.getDate() + 1);
    return next.getTime();
  }
  if (kind === 'monthly') {
    const targetDate = Math.max(1, Math.min(28, Number(dayPart) || 1));
    next.setDate(targetDate);
    if (next.getTime() <= from) next.setMonth(next.getMonth() + 1);
    return next.getTime();
  }
  // weekly：推进到目标星期
  const targetDay = Math.max(0, Math.min(6, Number(dayPart) || 0));
  while (next.getDay() !== targetDay || next.getTime() <= from) next.setDate(next.getDate() + 1);
  return next.getTime();
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private automationHandler: ((kind: AutomationReportKind, projectId: string, scheduleId: string) => void) | null = null;

  constructor(private db: Database, private orchestrator: Orchestrator) {}

  setAutomationHandler(handler: (kind: AutomationReportKind, projectId: string, scheduleId: string) => void) {
    this.automationHandler = handler;
  }

  start() {
    if (this.timer) return;
    this.runDue();
    this.timer = setInterval(() => this.runDue(), SCAN_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private mapRow(r: ScheduleRow): Schedule {
    return {
      id: r.id, agentId: r.agent_id, projectId: r.project_id,
      automationKind: (r.automation_kind || 'task') as Schedule['automationKind'], title: r.title,
      content: r.content ?? '',
      cronKind: r.cron_kind as Schedule['cronKind'], cronValue: r.cron_value,
      enabled: r.enabled === 1, lastRunAt: r.last_run_at, nextRunAt: r.next_run_at
    };
  }

  list(): Schedule[] {
    const rows = this.db.raw.prepare('SELECT * FROM schedules ORDER BY next_run_at').all() as unknown as ScheduleRow[];
    return rows.map((r) => this.mapRow(r));
  }

  create(input: ScheduleInput): Schedule {
    return this.createWithCommit(input, 'admin', () => {});
  }

  /** Lets another Main-process service atomically commit state with schedule creation. */
  createWithCommit(input: ScheduleInput, actor: string, commit: (schedule: Schedule) => void): Schedule {
    let result!: Schedule;
    this.db.transaction(() => {
      result = this.createMutation(input, actor);
      commit(result);
    });
    return result;
  }

  private createMutation(input: ScheduleInput, actor: string): Schedule {
    const title = input.title.trim();
    const automationKind = input.automationKind ?? 'task';
    const agentId = input.agentId?.trim() || null;
    const projectId = input.projectId?.trim() || null;
    if (!title || title.length > 160) throw new Error('计划标题需为 1-160 字');
    if ((input.content ?? '').length > 4_000) throw new Error('任务指令不能超过 4000 字');
    this.validateTarget(automationKind, agentId, projectId);
    this.validateCron(input.cronKind, input.cronValue);
    const id = randomUUID();
    const next = computeNextRun(input.cronKind, input.cronValue, Date.now());
    this.db.raw
      .prepare('INSERT INTO schedules(id, agent_id, project_id, automation_kind, title, content, cron_kind, cron_value, enabled, last_run_at, next_run_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?)')
      .run(id, agentId, projectId, automationKind, title, input.content?.trim() ?? '', input.cronKind, input.cronValue, next);
    this.db.audit({ id: randomUUID(), actor, action: 'schedule.create', target: id, result: automationKind });
    return this.list().find((s) => s.id === id)!;
  }

  update(id: string, patch: Partial<ScheduleInput>) {
    const row = this.db.raw.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined;
    if (!row) throw new Error('自动计划不存在');
    const nextKind = patch.automationKind ?? (row.automation_kind as Schedule['automationKind']);
    const nextAgentId = patch.agentId === undefined ? row.agent_id : patch.agentId?.trim() || null;
    const nextProjectId = patch.projectId === undefined ? row.project_id : patch.projectId?.trim() || null;
    this.validateTarget(nextKind, nextAgentId, nextProjectId);
    const fields: string[] = [];
    const values: (string | number | null)[] = [];
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (!title || title.length > 160) throw new Error('计划标题需为 1-160 字');
      fields.push('title = ?'); values.push(title);
    }
    if (patch.content !== undefined) {
      if (patch.content.length > 4_000) throw new Error('任务指令不能超过 4000 字');
      fields.push('content = ?'); values.push(patch.content.trim());
    }
    if (patch.agentId !== undefined) { fields.push('agent_id = ?'); values.push(nextAgentId); }
    if (patch.projectId !== undefined) { fields.push('project_id = ?'); values.push(nextProjectId); }
    if (patch.automationKind !== undefined) { fields.push('automation_kind = ?'); values.push(nextKind); }
    if (patch.cronKind !== undefined) { fields.push('cron_kind = ?'); values.push(patch.cronKind); }
    if (patch.cronValue !== undefined) { fields.push('cron_value = ?'); values.push(patch.cronValue); }
    if (fields.length === 0) return;
    // 重新计算下次执行时间
    const kind = (patch.cronKind ?? row.cron_kind) as Schedule['cronKind'];
    const val = patch.cronValue ?? row.cron_value;
    this.validateCron(kind, val);
    const next = computeNextRun(kind, val, Date.now());
    fields.push('next_run_at = ?'); values.push(next);
    values.push(id);
    this.db.raw.prepare(`UPDATE schedules SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'schedule.update', target: id, result: nextKind });
  }

  toggle(id: string, enabled: boolean) {
    // 重新启用时从当前时间推算，避免立即补跑历史周期
    const row = this.db.raw.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined;
    if (!row) return;
    const next = enabled ? computeNextRun(row.cron_kind as Schedule['cronKind'], row.cron_value, Date.now()) : row.next_run_at;
    this.db.raw.prepare('UPDATE schedules SET enabled = ?, next_run_at = ? WHERE id = ?').run(enabled ? 1 : 0, next, id);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'schedule.toggle', target: id, result: enabled ? 'enabled' : 'disabled' });
  }

  remove(id: string) {
    this.db.raw.prepare('DELETE FROM schedules WHERE id = ?').run(id);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'schedule.delete', target: id, result: 'ok' });
  }

  /** 到期扫描：创建任务 + 推算下一次；员工不存在/停用时跳过本轮（不删除计划） */
  runDue(now = Date.now()) {
    const due = this.db.raw
      .prepare('SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ?')
      .all(now) as unknown as ScheduleRow[];
    for (const r of due) {
      const next = computeNextRun(r.cron_kind as Schedule['cronKind'], r.cron_value, now);
      this.db.raw.prepare('UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?').run(now, next, r.id);
      try {
        const automationKind = (r.automation_kind || 'task') as Schedule['automationKind'];
        if (automationKind === 'task') {
          if (!r.agent_id) throw new Error('计划未指定数字员工');
          const taskTitle = r.content ? `${r.title}\n${r.content}` : r.title;
          this.orchestrator.createTask(r.agent_id, taskTitle, 'schedule', { projectId: r.project_id ?? undefined });
        } else {
          if (!r.project_id) throw new Error('经营计划未指定项目');
          if (!this.automationHandler) throw new Error('经营自动化服务未就绪');
          this.automationHandler(automationKind, r.project_id, r.id);
        }
        this.db.audit({ id: randomUUID(), actor: 'scheduler', action: 'schedule.run', target: r.id, result: 'ok' });
      } catch (error) {
        this.db.audit({ id: randomUUID(), actor: 'scheduler', action: 'schedule.run', target: r.id, result: `error:${error instanceof Error ? error.message : String(error)}` });
      }
    }
  }

  /** 获取定时任务的执行历史（通过 source='schedule' 的任务查询） */
  getHistory(scheduleId: string): { id: string; title: string; status: string; createdAt: number }[] {
    const schedule = this.list().find((s) => s.id === scheduleId);
    if (!schedule) return [];
    if (schedule.automationKind !== 'task') {
      return (this.db.raw.prepare(
        'SELECT id, title, created_at FROM automation_reports WHERE schedule_id = ? ORDER BY created_at DESC LIMIT 20'
      ).all(scheduleId) as { id: string; title: string; created_at: number }[])
        .map((r) => ({ id: r.id, title: r.title, status: 'COMPLETED', createdAt: r.created_at }));
    }
    if (!schedule.agentId) return [];
    return (this.db.raw.prepare(
      "SELECT id, title, status, created_at FROM tasks WHERE agent_id = ? AND source = 'schedule' AND deleted_at IS NULL AND title LIKE ? ORDER BY created_at DESC LIMIT 20"
    ).all(schedule.agentId, `%${schedule.title}%`) as { id: string; title: string; status: string; created_at: number }[])
      .map((r) => ({ id: r.id, title: r.title, status: r.status, createdAt: r.created_at }));
  }

  private validateTarget(kind: Schedule['automationKind'], agentId: string | null, projectId: string | null) {
    if (!['task', 'project_inspection', 'weekly_report', 'monthly_report'].includes(kind)) throw new Error('计划类型无效');
    if (kind === 'task') {
      if (!agentId) throw new Error('普通任务计划必须选择数字员工');
      const agent = this.db.raw.prepare('SELECT id FROM agents WHERE id = ? AND archived = 0').get(agentId);
      if (!agent) throw new Error('数字员工不存在或已归档');
      return;
    }
    if (!projectId) throw new Error('经营自动化计划必须选择项目');
    const project = this.db.raw.prepare("SELECT id FROM projects WHERE id = ? AND status != 'archived'").get(projectId);
    if (!project) throw new Error('项目不存在或已归档');
  }

  private validateCron(kind: Schedule['cronKind'], value: string) {
    if (!['interval', 'daily', 'weekly', 'monthly'].includes(kind)) throw new Error('执行周期类型无效');
    if (kind === 'interval') {
      const hours = Number(value);
      if (!Number.isFinite(hours) || hours < 0.5 || hours > 168) throw new Error('间隔小时需为 0.5-168');
      return;
    }
    const validClock = (clock: string) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clock);
    if (kind === 'daily') {
      if (!validClock(value)) throw new Error('每日执行时间格式无效');
      return;
    }
    const [part, clock] = value.split('|');
    const number = Number(part);
    const validPart = Number.isInteger(number) && (kind === 'weekly' ? number >= 0 && number <= 6 : number >= 1 && number <= 28);
    if (!validPart || !validClock(clock ?? '')) throw new Error(kind === 'weekly' ? '每周执行周期无效' : '每月执行周期无效');
  }
}
