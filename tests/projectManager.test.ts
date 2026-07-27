import { describe, expect, it } from 'vitest';
import type { Database } from '../src/main/services/database.js';
import { ProjectManager } from '../src/main/services/projectManager.js';
import { createMockDb } from './helpers/mockDb.js';

describe('ProjectManager 项目领域服务', () => {
  it('创建、更新和归档项目时保留完整经营信息', () => {
    const db = createMockDb();
    const manager = new ProjectManager(db as unknown as Database);
    const dueAt = Date.now() + 86_400_000;

    const project = manager.create({
      name: '新品发布', objective: '完成首批客户验证', description: '覆盖发布前准备',
      clientName: '内部业务方', color: '#22C1A3', dueAt
    });

    expect(project.name).toBe('新品发布');
    expect(project.color).toBe('#22c1a3');
    expect(project.status).toBe('active');
    expect(manager.list()).toHaveLength(1);

    const updated = manager.update(project.id, { status: 'completed', objective: '已完成首批验证' });
    expect(updated?.status).toBe('completed');
    expect(updated?.objective).toBe('已完成首批验证');

    expect(manager.archive(project.id)?.status).toBe('archived');
  });

  it('拒绝过短项目名称和非法截止时间', () => {
    const db = createMockDb();
    const manager = new ProjectManager(db as unknown as Database);

    expect(() => manager.create({ name: 'A' })).toThrow('项目名称');
    expect(() => manager.create({ name: '合法项目', dueAt: -1 })).toThrow('截止时间');
  });
});
