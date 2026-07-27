import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/main/services/database.js';
import type { Orchestrator } from '../src/main/services/orchestrator.js';
import { computeNextRun, Scheduler } from '../src/main/services/scheduler.js';
import { createMockDb, seedAgent, seedProject } from './helpers/mockDb.js';

describe('Scheduler 自动计划调度', () => {
  it('计算间隔、每日、每周和每月的下一次运行时间', () => {
    const from = new Date(2026, 6, 27, 10, 30, 0).getTime();
    expect(computeNextRun('interval', '2', from)).toBe(from + 2 * 3_600_000);
    expect(new Date(computeNextRun('daily', '09:00', from)).getDate()).toBe(28);
    expect(new Date(computeNextRun('weekly', '1|09:00', from)).getDay()).toBe(1);
    expect(new Date(computeNextRun('monthly', '5|09:00', from)).getMonth()).toBe(7);
  });

  it('普通计划派发给数字员工并保留项目归属', () => {
    const db = createMockDb();
    const agentId = seedAgent(db); const projectId = seedProject(db);
    const createTask = vi.fn();
    const scheduler = new Scheduler(db as unknown as Database, { createTask } as unknown as Orchestrator);
    const schedule = scheduler.create({ automationKind: 'task', agentId, projectId, title: '自动整理日报', content: '输出重点事项', cronKind: 'daily', cronValue: '09:00' });
    db.tables.schedules.get(schedule.id)!.next_run_at = Date.now() - 1;

    scheduler.runDue(Date.now());
    expect(createTask).toHaveBeenCalledWith(agentId, '自动整理日报\n输出重点事项', 'schedule', { projectId });
    expect(db.tables.schedules.get(schedule.id)?.last_run_at).toEqual(expect.any(Number));
  });

  it('经营计划不依赖数字员工并调用报告处理器', () => {
    const db = createMockDb();
    const projectId = seedProject(db);
    const createTask = vi.fn(); const handler = vi.fn();
    const scheduler = new Scheduler(db as unknown as Database, { createTask } as unknown as Orchestrator);
    scheduler.setAutomationHandler(handler);
    const schedule = scheduler.create({ automationKind: 'weekly_report', projectId, title: '项目经营周报', cronKind: 'weekly', cronValue: '5|17:00' });
    expect(schedule.agentId).toBeNull();
    db.tables.schedules.get(schedule.id)!.next_run_at = Date.now() - 1;

    scheduler.runDue(Date.now());
    expect(handler).toHaveBeenCalledWith('weekly_report', projectId, schedule.id);
    expect(createTask).not.toHaveBeenCalled();
  });

  it('经营计划历史读取对应的自动化报告', () => {
    const db = createMockDb(); const projectId = seedProject(db);
    const scheduler = new Scheduler(db as unknown as Database, { createTask: vi.fn() } as unknown as Orchestrator);
    const schedule = scheduler.create({ automationKind: 'project_inspection', projectId, title: '每日巡检', cronKind: 'daily', cronValue: '09:00' });
    db.tables.automation_reports.set('report-1', { id: 'report-1', schedule_id: schedule.id, title: '每日巡检报告', created_at: Date.now() });

    expect(scheduler.getHistory(schedule.id)).toEqual([expect.objectContaining({ id: 'report-1', title: '每日巡检报告', status: 'COMPLETED' })]);
  });

  it('拒绝缺少执行目标的计划', () => {
    const db = createMockDb();
    const scheduler = new Scheduler(db as unknown as Database, { createTask: vi.fn() } as unknown as Orchestrator);
    expect(() => scheduler.create({ automationKind: 'task', title: '无员工任务', cronKind: 'daily', cronValue: '09:00' })).toThrow('选择数字员工');
    expect(() => scheduler.create({ automationKind: 'monthly_report', title: '无项目月报', cronKind: 'monthly', cronValue: '1|09:00' })).toThrow('选择项目');
  });

  it('拒绝异常周期格式和越界值', () => {
    const db = createMockDb(); const agentId = seedAgent(db);
    const scheduler = new Scheduler(db as unknown as Database, { createTask: vi.fn() } as unknown as Orchestrator);
    expect(() => scheduler.create({ agentId, title: '异常间隔', cronKind: 'interval', cronValue: '0' })).toThrow('0.5-168');
    expect(() => scheduler.create({ agentId, title: '异常时间', cronKind: 'daily', cronValue: '25:70' })).toThrow('时间格式');
    expect(() => scheduler.create({ agentId, title: '异常星期', cronKind: 'weekly', cronValue: '8|09:00' })).toThrow('每周执行周期');
  });
});
