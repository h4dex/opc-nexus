/** 项目知识库：沉淀已验收成果，维护不可变版本，并为专家团提供可追溯上下文。 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  DeliverableDetail, KnowledgeCategory, KnowledgeDetail, KnowledgeInput, KnowledgePatch,
  KnowledgeQuery, KnowledgeSourceType, KnowledgeStatus, KnowledgeSummary, KnowledgeVersion,
  KnowledgeVersionInput, ProjectStatus
} from '../../shared/types.js';
import type { Database } from './database.js';
import type { DeliverableManager } from './deliverableManager.js';

interface EntryRow {
  id: string;
  project_id: string;
  source_type: KnowledgeSourceType;
  source_id: string;
  title: string;
  category: KnowledgeCategory;
  tags_json: string;
  pinned: number;
  status: KnowledgeStatus;
  usage_count: number;
  last_used_at: number | null;
  source_updated_at: number;
  created_at: number;
  updated_at: number;
}

interface VersionRow {
  id: string;
  knowledge_id: string;
  version: number;
  content: string;
  change_note: string;
  origin: KnowledgeVersion['origin'];
  created_by: string;
  created_at: number;
}

interface ProjectRow {
  id: string;
  name: string;
  status: ProjectStatus;
}

const CATEGORIES: KnowledgeCategory[] = ['decision', 'playbook', 'research', 'reference', 'lesson', 'other'];
const STATUSES: KnowledgeStatus[] = ['active', 'archived'];

export class KnowledgeManager {
  constructor(private db: Database) {}

  list(query: KnowledgeQuery = {}): KnowledgeSummary[] {
    const entries = this.entryRows();
    const versions = this.versionRows();
    const projects = this.projectMap();
    const grouped = this.groupVersions(versions);
    const search = query.search?.trim().toLocaleLowerCase('zh-CN') ?? '';
    return entries
      .filter((entry) => !query.projectId || entry.project_id === query.projectId)
      .filter((entry) => !query.category || entry.category === query.category)
      .filter((entry) => !query.sourceType || entry.source_type === query.sourceType)
      .filter((entry) => query.status === 'all' || entry.status === (query.status ?? 'active'))
      .filter((entry) => {
        if (!search) return true;
        const latest = grouped.get(entry.id)?.[0]?.content ?? '';
        return `${entry.title}\n${entry.tags_json}\n${latest}`.toLocaleLowerCase('zh-CN').includes(search);
      })
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at - a.updated_at)
      .map((entry) => this.mapSummary(entry, grouped.get(entry.id) ?? [], projects.get(entry.project_id)?.name ?? '已归档项目'));
  }

  get(id: string): KnowledgeDetail | null {
    const entry = this.db.raw.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(id) as unknown as EntryRow | undefined;
    if (!entry) return null;
    const versions = this.db.raw.prepare('SELECT * FROM knowledge_versions WHERE knowledge_id = ? ORDER BY version DESC').all(id) as unknown as VersionRow[];
    const project = this.db.raw.prepare('SELECT * FROM projects WHERE id = ?').get(entry.project_id) as unknown as ProjectRow | undefined;
    if (!project) return null;
    const latest = versions[0];
    return {
      ...this.mapSummary(entry, versions, project.name),
      latestContent: latest?.content ?? '',
      versions: versions.map(this.mapVersion),
      trace: {
        project: { id: project.id, name: project.name, status: project.status },
        source: {
          type: entry.source_type,
          id: entry.source_id,
          title: entry.source_type === 'deliverable' ? entry.title : '手动创建',
          deliverableId: entry.source_type === 'deliverable' ? entry.source_id : null
        }
      }
    };
  }

  create(input: KnowledgeInput): KnowledgeDetail {
    const projectId = this.text(input.projectId, '项目', 1, 100);
    const project = this.db.raw.prepare("SELECT id FROM projects WHERE id = ? AND status != 'archived'").get(projectId) as { id: string } | undefined;
    if (!project) throw new Error('项目不存在或已归档');
    const title = this.text(input.title, '标题', 2, 160);
    const content = this.text(input.content, '知识正文', 1, 200_000);
    const category = this.category(input.category ?? 'other');
    const tags = this.tags(input.tags ?? []);
    const id = `knowledge-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    this.db.transaction(() => {
      this.db.raw.prepare(`INSERT INTO knowledge_entries(
        id, project_id, source_type, source_id, title, category, tags_json, pinned, status,
        usage_count, last_used_at, source_updated_at, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,0,NULL,?,?,?)`).run(
        id, projectId, 'manual', id, title, category, JSON.stringify(tags), input.pinned ? 1 : 0,
        'active', now, now, now
      );
      this.insertVersion(id, 1, content, '创建知识条目', 'manual', 'admin', now);
    });
    this.audit('knowledge.create', id);
    return this.required(id);
  }

  update(id: string, patch: KnowledgePatch): KnowledgeDetail | null {
    const current = this.get(id);
    if (!current) return null;
    const title = patch.title === undefined ? current.title : this.text(patch.title, '标题', 2, 160);
    const category = patch.category === undefined ? current.category : this.category(patch.category);
    const tags = patch.tags === undefined ? current.tags : this.tags(patch.tags);
    const pinned = patch.pinned === undefined ? current.pinned : Boolean(patch.pinned);
    const status = patch.status === undefined ? current.status : this.status(patch.status);
    this.db.raw.prepare('UPDATE knowledge_entries SET title = ?, category = ?, tags_json = ?, pinned = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(title, category, JSON.stringify(tags), pinned ? 1 : 0, status, Date.now(), id);
    this.audit('knowledge.meta', id);
    return this.get(id);
  }

  addVersion(id: string, input: KnowledgeVersionInput): KnowledgeDetail | null {
    const current = this.get(id);
    if (!current) return null;
    const content = this.text(input.content, '知识正文', 1, 200_000);
    const changeNote = this.text(input.changeNote, '版本说明', 2, 500);
    const now = Date.now();
    this.db.transaction(() => {
      this.insertVersion(id, current.latestVersion + 1, content, changeNote, 'manual', 'admin', now);
      this.db.raw.prepare('UPDATE knowledge_entries SET updated_at = ? WHERE id = ?').run(now, id);
    });
    this.audit('knowledge.version', id);
    return this.get(id);
  }

  /** 已验收成果按成果 ID 去重；内容变化时追加知识版本，历史版本保持不可变。 */
  ingestDeliverable(deliverable: DeliverableDetail): KnowledgeDetail | null {
    if (deliverable.reviewStatus !== 'accepted' || !deliverable.projectId || !deliverable.latestContent.trim()) return null;
    const existing = this.db.raw.prepare('SELECT * FROM knowledge_entries WHERE source_type = ? AND source_id = ?')
      .get('deliverable', deliverable.id) as unknown as EntryRow | undefined;
    const now = Date.now();
    if (!existing) {
      const id = `knowledge-${randomUUID().slice(0, 8)}`;
      const category = this.categoryForDeliverable(deliverable.type);
      const tags = this.tags(deliverable.tags);
      this.db.transaction(() => {
        this.db.raw.prepare(`INSERT INTO knowledge_entries(
          id, project_id, source_type, source_id, title, category, tags_json, pinned, status,
          usage_count, last_used_at, source_updated_at, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,0,NULL,?,?,?)`).run(
          id, deliverable.projectId, 'deliverable', deliverable.id, deliverable.title, category,
          JSON.stringify(tags), 0, 'active', deliverable.sourceUpdatedAt, now, now
        );
        this.insertVersion(id, 1, deliverable.latestContent, `采纳成果 v${deliverable.latestVersion}`, 'deliverable', deliverable.ownerName, now);
      });
      this.audit('knowledge.ingest', id);
      return this.required(id);
    }

    const current = this.get(existing.id);
    if (!current) return null;
    if (this.digest(current.latestContent) === this.digest(deliverable.latestContent)) {
      this.db.raw.prepare('UPDATE knowledge_entries SET project_id = ?, source_updated_at = ? WHERE id = ?')
        .run(deliverable.projectId, deliverable.sourceUpdatedAt, existing.id);
      return this.get(existing.id);
    }
    this.db.transaction(() => {
      this.insertVersion(existing.id, current.latestVersion + 1, deliverable.latestContent,
        `重新采纳成果 v${deliverable.latestVersion}`, 'deliverable', deliverable.ownerName, now);
      this.db.raw.prepare('UPDATE knowledge_entries SET project_id = ?, source_updated_at = ?, updated_at = ? WHERE id = ?')
        .run(deliverable.projectId, deliverable.sourceUpdatedAt, now, existing.id);
    });
    this.audit('knowledge.ingest.version', existing.id);
    return this.get(existing.id);
  }

  syncAcceptedDeliverables(deliverables: DeliverableManager): number {
    let changed = 0;
    for (const summary of deliverables.list()) {
      if (summary.reviewStatus !== 'accepted' || !summary.projectId) continue;
      const detail = deliverables.get(summary.id);
      if (!detail) continue;
      const before = this.db.raw.prepare('SELECT * FROM knowledge_entries WHERE source_type = ? AND source_id = ?')
        .get('deliverable', detail.id) as unknown as EntryRow | undefined;
      const beforeVersion = before ? this.get(before.id)?.latestVersion ?? 0 : 0;
      const ingested = this.ingestDeliverable(detail);
      if (ingested && ingested.latestVersion !== beforeVersion) changed++;
    }
    return changed;
  }

  /** 选择项目内相关知识并登记实际使用，返回可直接写入共享工作区的 Markdown。 */
  buildProjectContext(projectId: string, task: string, limit = 6): string {
    const candidates = this.list({ projectId, status: 'active' }).map((summary) => this.get(summary.id)).filter((item): item is KnowledgeDetail => Boolean(item));
    const terms = this.searchTerms(task);
    const ranked = candidates.map((item) => ({ item, score: this.relevance(item, terms) }))
      .sort((a, b) => b.score - a.score || Number(b.item.pinned) - Number(a.item.pinned) || b.item.updatedAt - a.item.updatedAt)
      .slice(0, Math.max(1, Math.min(limit, 12)));
    if (ranked.length === 0) return '# 项目知识上下文\n\n当前项目暂无可用知识条目。\n';

    const now = Date.now();
    for (const { item } of ranked) {
      this.db.raw.prepare('UPDATE knowledge_entries SET usage_count = usage_count + 1, last_used_at = ? WHERE id = ?').run(now, item.id);
    }
    this.db.audit({ id: randomUUID(), actor: 'team-engine', action: 'knowledge.context.use', target: projectId, result: `${ranked.length}` });
    return `# 项目知识上下文\n\n> 以下内容来自本项目知识库，请核验来源与版本后复用。\n\n${ranked.map(({ item }) =>
      `## ${item.title}\n\n- 知识编号：${item.id}\n- 分类：${item.category}\n- 来源：${item.sourceType === 'deliverable' ? `已验收成果 ${item.sourceId}` : '手动记录'}\n- 版本：v${item.latestVersion}\n\n${item.latestContent.slice(0, 2400)}`
    ).join('\n\n---\n\n')}\n`;
  }

  private entryRows(): EntryRow[] {
    return this.db.raw.prepare('SELECT * FROM knowledge_entries ORDER BY pinned DESC, updated_at DESC').all() as unknown as EntryRow[];
  }

  private versionRows(): VersionRow[] {
    return this.db.raw.prepare('SELECT * FROM knowledge_versions ORDER BY knowledge_id, version DESC').all() as unknown as VersionRow[];
  }

  private projectMap(): Map<string, ProjectRow> {
    const rows = this.db.raw.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as unknown as ProjectRow[];
    return new Map(rows.map((project) => [project.id, project]));
  }

  private groupVersions(rows: VersionRow[]): Map<string, VersionRow[]> {
    const grouped = new Map<string, VersionRow[]>();
    for (const row of rows) grouped.set(row.knowledge_id, [...(grouped.get(row.knowledge_id) ?? []), row]);
    return grouped;
  }

  private mapSummary(entry: EntryRow, versions: VersionRow[], projectName: string): KnowledgeSummary {
    const latest = versions[0];
    const content = latest?.content ?? '';
    return {
      id: entry.id, projectId: entry.project_id, projectName, sourceType: entry.source_type, sourceId: entry.source_id,
      title: entry.title, category: entry.category, tags: this.parseTags(entry.tags_json), pinned: Boolean(entry.pinned),
      status: entry.status, latestVersion: latest?.version ?? 0, versionCount: versions.length,
      preview: content.replace(/\s+/g, ' ').trim().slice(0, 220), usageCount: entry.usage_count,
      lastUsedAt: entry.last_used_at, sourceUpdatedAt: entry.source_updated_at,
      createdAt: entry.created_at, updatedAt: entry.updated_at
    };
  }

  private mapVersion(row: VersionRow): KnowledgeVersion {
    return {
      id: row.id, knowledgeId: row.knowledge_id, version: row.version, content: row.content,
      changeNote: row.change_note, origin: row.origin, createdBy: row.created_by, createdAt: row.created_at
    };
  }

  private insertVersion(knowledgeId: string, version: number, content: string, changeNote: string,
    origin: KnowledgeVersion['origin'], createdBy: string, createdAt: number) {
    this.db.raw.prepare(`INSERT INTO knowledge_versions(
      id, knowledge_id, version, content, change_note, origin, created_by, created_at
    ) VALUES(?,?,?,?,?,?,?,?)`).run(
      `knowledge-version-${randomUUID().slice(0, 8)}`, knowledgeId, version, content, changeNote, origin, createdBy, createdAt
    );
  }

  private required(id: string): KnowledgeDetail {
    const value = this.get(id);
    if (!value) throw new Error('知识条目创建失败');
    return value;
  }

  private text(value: unknown, label: string, min: number, max: number): string {
    if (typeof value !== 'string') throw new Error(`${label}无效`);
    const normalized = value.trim();
    if (normalized.length < min || normalized.length > max) throw new Error(`${label}需为 ${min}-${max} 个字符`);
    return normalized;
  }

  private category(value: unknown): KnowledgeCategory {
    if (!CATEGORIES.includes(value as KnowledgeCategory)) throw new Error('知识分类无效');
    return value as KnowledgeCategory;
  }

  private status(value: unknown): KnowledgeStatus {
    if (!STATUSES.includes(value as KnowledgeStatus)) throw new Error('知识状态无效');
    return value as KnowledgeStatus;
  }

  private tags(values: unknown[]): string[] {
    if (!Array.isArray(values)) throw new Error('知识标签无效');
    return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].slice(0, 10).map((value) => value.slice(0, 30));
  }

  private parseTags(value: string): string[] {
    try { return this.tags(JSON.parse(value) as unknown[]); } catch { return []; }
  }

  private categoryForDeliverable(type: DeliverableDetail['type']): KnowledgeCategory {
    if (type === 'report' || type === 'data') return 'research';
    if (type === 'code') return 'playbook';
    if (type === 'document' || type === 'design') return 'reference';
    return 'other';
  }

  private digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private searchTerms(value: string): string[] {
    const chunks = value.toLocaleLowerCase('zh-CN').split(/[\s,，。；;：:、!?！？()（）]+/).map((item) => item.trim()).filter((item) => item.length >= 2);
    const terms = new Set<string>(chunks);
    for (const chunk of chunks) {
      if (!/[\u3400-\u9fff]/.test(chunk)) continue;
      for (const size of [2, 3, 4]) {
        for (let index = 0; index <= chunk.length - size; index++) terms.add(chunk.slice(index, index + size));
      }
    }
    return [...terms].slice(0, 60);
  }

  private relevance(item: KnowledgeDetail, terms: string[]): number {
    const title = item.title.toLocaleLowerCase('zh-CN');
    const tags = item.tags.join(' ').toLocaleLowerCase('zh-CN');
    const content = item.latestContent.toLocaleLowerCase('zh-CN');
    return (item.pinned ? 20 : 0) + terms.reduce((score, term) =>
      score + (title.includes(term) ? 12 : 0) + (tags.includes(term) ? 8 : 0) + (content.includes(term) ? 3 : 0), 0);
  }

  private audit(action: string, target: string) {
    this.db.audit({ id: randomUUID(), actor: 'admin', action, target, result: 'ok' });
  }
}
