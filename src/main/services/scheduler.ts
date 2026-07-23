/**
 * 定时任务调度（P3a）：每 30s 扫描 schedules 表，到期创建 source='schedule' 的任务并推算下次运行。
 * cron_kind：interval（每 N 小时）/ daily（每天 HH:mm）/ weekly（每周几 D|HH:mm，0=周日）。
 * 启动时对过期项立即补跑一次（补跑后按当前时间推算下一次，不重复补历史）。
 */
import { randomUUID } from 'node:crypto';
import type { Database } from './database.js';
import type { Orchestrator } from './orchestrator.js';
import type { Schedule, ScheduleInput } from '../../shared/types.js';

const SCAN_MS = 30_000;

interface ScheduleRow {
  id: string;
  agent_id: string;
  title: string;
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

  constructor(private db: Database, private orchestrator: Orchestrator) {}

  start() {
    if (this.timer) return;
    this.scan();
    this.timer = setInterval(() => this.scan(), SCAN_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private mapRow(r: ScheduleRow): Schedule {
    return {
      id: r.id, agentId: r.agent_id, title: r.title,
      content: (r as unknown as { content?: string }).content ?? '',
      cronKind: r.cron_kind as Schedule['cronKind'], cronValue: r.cron_value,
      enabled: r.enabled === 1, lastRunAt: r.last_run_at, nextRunAt: r.next_run_at
    };
  }

  list(): Schedule[] {
    const rows = this.db.raw.prepare('SELECT * FROM schedules ORDER BY next_run_at').all() as unknown as ScheduleRow[];
    return rows.map((r) => this.mapRow(r));
  }

  create(input: ScheduleInput): Schedule {
    if (!input.title.trim()) throw new Error('请填写任务标题');
    const id = randomUUID();
    const next = computeNextRun(input.cronKind, input.cronValue, Date.now());
    this.db.raw
      .prepare('INSERT INTO schedules(id, agent_id, title, content, cron_kind, cron_value, enabled, last_run_at, next_run_at) VALUES(?, ?, ?, ?, ?, ?, 1, NULL, ?)')
      .run(id, input.agentId, input.title.trim(), input.content ?? '', input.cronKind, input.cronValue, next);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'schedule.create', target: input.title, result: 'ok' });
    return this.list().find((s) => s.id === id)!;
  }

  update(id: string, patch: { title?: string; content?: string; cronKind?: Schedule['cronKind']; cronValue?: string }) {
    const fields: string[] = [];
    const values: (string | number)[] = [];
    if (patch.title !== undefined) { fields.push('title = ?'); values.push(patch.title); }
    if (patch.content !== undefined) { fields.push('content = ?'); values.push(patch.content); }
    if (patch.cronKind !== undefined) { fields.push('cron_kind = ?'); values.push(patch.cronKind); }
    if (patch.cronValue !== undefined) { fields.push('cron_value = ?'); values.push(patch.cronValue); }
    if (fields.length === 0) return;
    // 重新计算下次执行时间
    const row = this.db.raw.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined;
    if (row) {
      const kind = (patch.cronKind ?? row.cron_kind) as Schedule['cronKind'];
      const val = patch.cronValue ?? row.cron_value;
      const next = computeNextRun(kind, val, Date.now());
      fields.push('next_run_at = ?'); values.push(next);
    }
    values.push(id);
    this.db.raw.prepare(`UPDATE schedules SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  toggle(id: string, enabled: boolean) {
    // 重新启用时从当前时间推算，避免立即补跑历史周期
    const row = this.db.raw.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined;
    if (!row) return;
    const next = enabled ? computeNextRun(row.cron_kind as Schedule['cronKind'], row.cron_value, Date.now()) : row.next_run_at;
    this.db.raw.prepare('UPDATE schedules SET enabled = ?, next_run_at = ? WHERE id = ?').run(enabled ? 1 : 0, next, id);
  }

  remove(id: string) {
    this.db.raw.prepare('DELETE FROM schedules WHERE id = ?').run(id);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'schedule.delete', target: id, result: 'ok' });
  }

  /** 到期扫描：创建任务 + 推算下一次；员工不存在/停用时跳过本轮（不删除计划） */
  private scan() {
    const now = Date.now();
    const due = this.db.raw
      .prepare('SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ?')
      .all(now) as unknown as ScheduleRow[];
    for (const r of due) {
      const next = computeNextRun(r.cron_kind as Schedule['cronKind'], r.cron_value, now);
      this.db.raw.prepare('UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?').run(now, next, r.id);
      try {
        const content = (r as unknown as { content?: string }).content;
        const taskTitle = content ? `${r.title}\n${content}` : r.title;
        this.orchestrator.createTask(r.agent_id, taskTitle, 'schedule');
      } catch {
        /* 员工不存在或已停用：跳过本轮，保留计划 */
      }
    }
  }

  /** 获取定时任务的执行历史（通过 source='schedule' 的任务查询） */
  getHistory(scheduleId: string): { id: string; title: string; status: string; createdAt: number }[] {
    const schedule = this.list().find((s) => s.id === scheduleId);
    if (!schedule) return [];
    return (this.db.raw.prepare(
      "SELECT id, title, status, created_at FROM tasks WHERE agent_id = ? AND source = 'schedule' AND title LIKE ? ORDER BY created_at DESC LIMIT 20"
    ).all(schedule.agentId, `%${schedule.title}%`) as { id: string; title: string; status: string; created_at: number }[])
      .map((r) => ({ id: r.id, title: r.title, status: r.status, createdAt: r.created_at }));
  }
}
