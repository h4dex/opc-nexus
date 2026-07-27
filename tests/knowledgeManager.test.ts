import { describe, expect, it } from 'vitest';
import type { Database } from '../src/main/services/database.js';
import { KnowledgeManager } from '../src/main/services/knowledgeManager.js';
import type { DeliverableDetail } from '../src/shared/types.js';
import { createMockDb, seedProject } from './helpers/mockDb.js';

function createFixture() {
  const db = createMockDb();
  const projectId = seedProject(db, { name: '客户增长项目', status: 'active' });
  const otherProjectId = seedProject(db, { name: '交付质量项目', status: 'active' });
  const manager = new KnowledgeManager(db as unknown as Database);
  return { db, manager, projectId, otherProjectId };
}

function acceptedDeliverable(projectId: string, overrides: Partial<DeliverableDetail> = {}): DeliverableDetail {
  const now = Date.now();
  return {
    id: 'deliverable-research', sourceType: 'task', sourceId: 'task-research', projectId, projectName: '客户增长项目',
    ownerType: 'agent', ownerId: 'agent-research', ownerName: '市场研究员', ownerRole: '客户研究',
    title: '客户访谈研究结论', type: 'report', tags: ['客户', '增长'], reviewStatus: 'accepted', reviewNote: '通过',
    latestVersion: 1, versionCount: 1, preview: '首批客户关注交付周期', createdAt: now - 1000, updatedAt: now,
    sourceUpdatedAt: now, latestContent: '# 研究结论\n\n首批客户关注交付周期与响应速度。', versions: [], reviews: [],
    trace: {
      project: { id: projectId, name: '客户增长项目', status: 'active' },
      source: { type: 'task', id: 'task-research', title: '客户访谈', status: 'COMPLETED', createdAt: now - 2000 },
      owner: { type: 'agent', id: 'agent-research', name: '市场研究员', role: '客户研究' }
    },
    ...overrides
  };
}

describe('KnowledgeManager 项目知识库领域服务', () => {
  it('创建手动知识并通过新增版本保留不可变历史', () => {
    const { manager, projectId } = createFixture();
    const created = manager.create({
      projectId, title: '客户分层标准', category: 'decision', tags: ['客户', '客户', ' 规则 '],
      content: '# 分层标准\n\n优先服务高复购客户。', pinned: true
    });

    expect(created).toMatchObject({ projectId, category: 'decision', tags: ['客户', '规则'], pinned: true, latestVersion: 1, versionCount: 1 });
    const updated = manager.addVersion(created.id, { content: '# 分层标准 v2\n\n增加交付周期指标。', changeNote: '补充交付指标' })!;
    expect(updated.latestVersion).toBe(2);
    expect(updated.versions.map(version => version.version)).toEqual([2, 1]);
    expect(updated.versions[1].content).toContain('高复购客户');
    expect(updated.versions[0]).toMatchObject({ changeNote: '补充交付指标', origin: 'manual' });
  });

  it('支持项目、分类、来源、状态与正文全文检索', () => {
    const { manager, projectId, otherProjectId } = createFixture();
    manager.create({ projectId, title: '销售打法', category: 'playbook', content: '先验证重点渠道，再扩大投放。', tags: ['渠道'] });
    const archived = manager.create({ projectId, title: '旧版报价', category: 'reference', content: '历史价格策略。' });
    manager.update(archived.id, { status: 'archived' });
    manager.create({ projectId: otherProjectId, title: '测试规范', category: 'playbook', content: '覆盖回归测试。' });

    expect(manager.list({ projectId, category: 'playbook', search: '重点渠道' })).toHaveLength(1);
    expect(manager.list({ projectId, status: 'archived' })[0].title).toBe('旧版报价');
    expect(manager.list({ projectId, status: 'all' })).toHaveLength(2);
    expect(manager.list({ projectId, sourceType: 'deliverable' })).toHaveLength(0);
  });

  it('将已采纳成果幂等沉淀，并在重新采纳新内容时追加版本', () => {
    const { manager, projectId } = createFixture();
    const first = acceptedDeliverable(projectId);
    const ingested = manager.ingestDeliverable(first)!;
    expect(ingested).toMatchObject({ sourceType: 'deliverable', sourceId: first.id, category: 'research', latestVersion: 1 });

    expect(manager.ingestDeliverable(first)?.latestVersion).toBe(1);
    expect(manager.list({ sourceType: 'deliverable', status: 'all' })).toHaveLength(1);

    const next = acceptedDeliverable(projectId, {
      latestVersion: 2, versionCount: 2, sourceUpdatedAt: first.sourceUpdatedAt + 1000,
      latestContent: '# 研究结论 v2\n\n客户要求 24 小时内响应。'
    });
    const updated = manager.ingestDeliverable(next)!;
    expect(updated.latestVersion).toBe(2);
    expect(updated.versions[0]).toMatchObject({ origin: 'deliverable', changeNote: '重新采纳成果 v2' });
    expect(updated.versions[1].content).toContain('交付周期');
  });

  it('只选择当前项目有效知识生成上下文，并记录实际复用次数', () => {
    const { manager, projectId, otherProjectId } = createFixture();
    const relevant = manager.create({ projectId, title: '渠道验证手册', category: 'playbook', content: '先做小规模渠道验证。', pinned: true });
    const archived = manager.create({ projectId, title: '旧渠道规则', category: 'reference', content: '不再使用。' });
    manager.update(archived.id, { status: 'archived' });
    manager.create({ projectId: otherProjectId, title: '其他项目知识', category: 'reference', content: '不得跨项目注入。' });

    const context = manager.buildProjectContext(projectId, '制定渠道验证计划');
    expect(context).toContain('渠道验证手册');
    expect(context).not.toContain('旧渠道规则');
    expect(context).not.toContain('其他项目知识');
    expect(manager.get(relevant.id)).toMatchObject({ usageCount: 1 });
    expect(manager.get(relevant.id)?.lastUsedAt).not.toBeNull();
  });
});
