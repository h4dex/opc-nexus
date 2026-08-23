/**
 * 成果领域服务：同步任务/专家团终稿，并维护版本、验收与项目成果包。
 *
 * **B.7 — 兼容投影层，不再作为交付权威。** v2.0.0 起，真实产物由
 * `ProjectArtifactManifestService` 验证并持久化为 `task_events` 中的
 * `artifact_manifest`；本服务维持文本包装与已有验收流程向后兼容。
 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  DeliverableDetail, DeliverableMetaPatch, DeliverableReviewEvent, DeliverableReviewInput,
  DeliverableReviewStatus, DeliverableSourceType, DeliverableSummary, DeliverableType,
  DeliverableVersion, DeliverableVersionInput, Project, ProjectDeliverablePackage, ProjectStatus,
  TaskQuality
} from '../../shared/types.js';
import type { Database } from './database.js';

type Row = Record<string, unknown>;

interface DeliverableRow {
  id: string;
  source_type: DeliverableSourceType;
  source_id: string;
  project_id: string | null;
  owner_type: 'agent' | 'team';
  owner_id: string;
  owner_name: string;
  owner_role: string;
  title: string;
  type: DeliverableType;
  tags_json: string;
  review_status: DeliverableReviewStatus;
  review_note: string;
  source_hash: string;
  source_updated_at: number;
  created_at: number;
  updated_at: number;
}

interface VersionRow {
  id: string;
  deliverable_id: string;
  version: number;
  content: string;
  change_note: string;
  origin: DeliverableVersion['origin'];
  created_by: string;
  created_at: number;
}

interface ReviewRow {
  id: string;
  deliverable_id: string;
  status: DeliverableReviewStatus;
  note: string;
  reviewer: string;
  rework_ref: string | null;
  created_at: number;
}

interface SourceRecord {
  sourceType: DeliverableSourceType;
  sourceId: string;
  projectId: string | null;
  ownerType: 'agent' | 'team';
  ownerId: string;
  ownerName: string;
  ownerRole: string;
  title: string;
  content: string;
  reviewStatus: DeliverableReviewStatus;
  createdAt: number;
  updatedAt: number;
}

const TYPES: DeliverableType[] = ['document', 'report', 'code', 'data', 'design', 'other'];
const REVIEW_STATUSES: DeliverableReviewStatus[] = ['unmarked', 'accepted', 'rejected', 'rework'];

export class DeliverableManager {
  constructor(private db: Database) {}

  list(): DeliverableSummary[] {
    this.syncSources();
    const rows = this.db.raw.prepare('SELECT * FROM deliverables ORDER BY updated_at DESC').all() as unknown as DeliverableRow[];
    const versions = this.db.raw.prepare('SELECT * FROM deliverable_versions ORDER BY deliverable_id, version DESC').all() as unknown as VersionRow[];
    const projectNames = new Map(
      (this.db.raw.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as unknown as Row[])
        .map((row) => [String(row.id), String(row.name)])
    );
    const grouped = new Map<string, VersionRow[]>();
    for (const version of versions) {
      const current = grouped.get(version.deliverable_id) ?? [];
      current.push(version);
      grouped.set(version.deliverable_id, current);
    }
    return rows.map((row) => this.mapSummary(row, grouped.get(row.id) ?? [], projectNames.get(row.project_id ?? '') ?? null));
  }

  get(id: string): DeliverableDetail | null {
    this.syncSources();
    const row = this.db.raw.prepare('SELECT * FROM deliverables WHERE id = ?').get(id) as unknown as DeliverableRow | undefined;
    if (!row) return null;
    const versions = this.versionRows(id);
    const reviews = this.db.raw.prepare('SELECT * FROM deliverable_reviews WHERE deliverable_id = ? ORDER BY created_at DESC, rowid DESC').all(id) as unknown as ReviewRow[];
    const project = row.project_id
      ? this.db.raw.prepare('SELECT * FROM projects WHERE id = ?').get(row.project_id) as unknown as Row | undefined
      : undefined;
    const latest = versions[0];
    const summary = this.mapSummary(row, versions, project ? String(project.name) : null);
    return {
      ...summary,
      latestContent: latest?.content ?? '',
      versions: versions.map(this.mapVersion),
      reviews: reviews.map(this.mapReview),
      trace: {
        project: project ? { id: String(project.id), name: String(project.name), status: project.status as ProjectStatus } : null,
        source: this.sourceTrace(row),
        owner: { type: row.owner_type, id: row.owner_id, name: row.owner_name, role: row.owner_role }
      }
    };
  }

  updateMeta(id: string, patch: DeliverableMetaPatch): DeliverableDetail | null {
    const current = this.get(id);
    if (!current) return null;
    const type = patch.type === undefined ? current.type : this.type(patch.type);
    const tags = patch.tags === undefined ? current.tags : this.tags(patch.tags);
    const now = Date.now();
    this.db.raw.prepare('UPDATE deliverables SET type = ?, tags_json = ?, updated_at = ? WHERE id = ?')
      .run(type, JSON.stringify(tags), now, id);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'deliverable.meta', target: id, result: 'ok' });
    return this.get(id);
  }

  addVersion(id: string, input: DeliverableVersionInput): DeliverableDetail | null {
    const current = this.get(id);
    if (!current) return null;
    const content = this.text(input.content, '版本内容', 1, 200_000);
    const changeNote = this.text(input.changeNote, '版本说明', 2, 500);
    const origin = input.origin === 'rework' ? 'rework' : 'manual';
    const nextVersion = (current.versions[0]?.version ?? 0) + 1;
    const now = Date.now();
    this.db.transaction(() => {
      this.insertVersion(id, nextVersion, content, changeNote, origin, 'admin', now);
      this.db.raw.prepare("UPDATE deliverables SET review_status = 'unmarked', review_note = '', updated_at = ? WHERE id = ?")
        .run(now, id);
      this.db.raw.prepare(
        'INSERT INTO deliverable_reviews(id, deliverable_id, status, note, reviewer, rework_ref, created_at) VALUES(?,?,?,?,?,?,?)'
      ).run(randomUUID(), id, 'unmarked', `新增 v${nextVersion}，等待重新验收`, 'admin', null, now);
      if (current.sourceType === 'task') this.db.raw.prepare('UPDATE tasks SET quality = ? WHERE id = ?').run(null, current.sourceId);
    });
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'deliverable.version', target: id, result: `v${nextVersion}` });
    return this.get(id);
  }

  review(
    id: string,
    input: DeliverableReviewInput,
    reworkRef: string | null = null
  ): { deliverable: DeliverableDetail; review: DeliverableReviewEvent } | null {
    const current = this.get(id);
    if (!current) return null;
    const status = this.reviewStatus(input.status);
    const note = this.text(input.note, '验收说明', status === 'rejected' || status === 'rework' ? 2 : 0, 1_000);
    const now = Date.now();
    const reviewId = randomUUID();
    this.db.transaction(() => {
      this.db.raw.prepare('UPDATE deliverables SET review_status = ?, review_note = ?, updated_at = ? WHERE id = ?')
        .run(status, note, now, id);
      this.db.raw.prepare(
        'INSERT INTO deliverable_reviews(id, deliverable_id, status, note, reviewer, rework_ref, created_at) VALUES(?,?,?,?,?,?,?)'
      ).run(reviewId, id, status, note, 'admin', reworkRef, now);
      if (current.sourceType === 'task') {
        const quality: TaskQuality = status === 'unmarked' ? null : status;
        this.db.raw.prepare('UPDATE tasks SET quality = ? WHERE id = ?').run(quality, current.sourceId);
      }
    });
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'deliverable.review', target: id, result: status });
    return {
      deliverable: this.get(id)!,
      review: { id: reviewId, deliverableId: id, status, note, reviewer: 'admin', reworkRef, createdAt: now }
    };
  }

  packageForProject(projectId: string): ProjectDeliverablePackage {
    const projectRow = this.db.raw.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as unknown as Row | undefined;
    if (!projectRow) throw new Error('项目不存在');
    const summaries = this.list().filter((item) => item.projectId === projectId);
    const deliverables = summaries.map((item) => {
      const detail = this.get(item.id)!;
      return { ...item, latestContent: detail.latestContent };
    });
    const summary = { total: deliverables.length, accepted: 0, rejected: 0, rework: 0, unmarked: 0 };
    for (const item of deliverables) summary[item.reviewStatus] += 1;
    return { project: this.mapProject(projectRow), generatedAt: Date.now(), summary, deliverables };
  }

  renderMarkdown(detail: DeliverableDetail): string {
    const review = detail.reviewStatus === 'unmarked' ? '未验收' : detail.reviewStatus === 'accepted' ? '已采纳' : detail.reviewStatus === 'rejected' ? '已驳回' : '需返工';
    const tags = detail.tags.length ? detail.tags.join('、') : '无';
    return `# ${detail.title}\n\n` +
      `- 成果 ID：${detail.id}\n- 当前版本：v${detail.latestVersion}\n- 类型：${detail.type}\n- 标签：${tags}\n` +
      `- 验收状态：${review}\n- 项目：${detail.projectName ?? '未归项目'}\n- 负责人：${detail.ownerName}${detail.ownerRole ? `（${detail.ownerRole}）` : ''}\n` +
      `- 来源：${detail.sourceType === 'task' ? '任务' : '专家团运行'} ${detail.sourceId}\n- 更新时间：${new Date(detail.updatedAt).toLocaleString('zh-CN', { hour12: false })}\n\n` +
      `${detail.reviewNote ? `> 验收说明：${detail.reviewNote}\n\n` : ''}## 成果正文\n\n${detail.latestContent}\n`;
  }

  renderPackageReadme(pkg: ProjectDeliverablePackage): string {
    const lines = [
      `# ${pkg.project.name} · 项目成果包`, '',
      pkg.project.objective ? `> ${pkg.project.objective}` : '> 未设置项目目标', '',
      `生成时间：${new Date(pkg.generatedAt).toLocaleString('zh-CN', { hour12: false })}`, '',
      '## 验收概览', '',
      `- 成果总数：${pkg.summary.total}`,
      `- 已采纳：${pkg.summary.accepted}`,
      `- 需返工：${pkg.summary.rework}`,
      `- 已驳回：${pkg.summary.rejected}`,
      `- 未验收：${pkg.summary.unmarked}`, '',
      '## 成果目录', ''
    ];
    pkg.deliverables.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.title} · ${item.ownerName} · v${item.latestVersion} · ${item.reviewStatus}`);
    });
    return `${lines.join('\n')}\n`;
  }

  private syncSources() {
    const agents = new Map(
      (this.db.raw.prepare('SELECT * FROM agents').all() as unknown as Row[])
        .map((row) => [String(row.id), row])
    );
    const teams = new Map(
      (this.db.raw.prepare('SELECT * FROM teams ORDER BY created_at DESC').all() as unknown as Row[])
        .map((row) => [String(row.id), row])
    );
    const sources: SourceRecord[] = [];
    const tasks = this.db.raw.prepare("SELECT * FROM tasks WHERE status = 'COMPLETED' ORDER BY created_at DESC").all() as unknown as Row[];
    for (const task of tasks) {
      const content = typeof task.result === 'string' ? task.result.trim() : '';
      if (!content) continue;
      const owner = agents.get(String(task.agent_id));
      sources.push({
        sourceType: 'task', sourceId: String(task.id), projectId: task.project_id ? String(task.project_id) : null,
        ownerType: 'agent', ownerId: String(task.agent_id), ownerName: owner ? String(owner.name) : '已归档数字员工',
        ownerRole: owner ? String(owner.role ?? '') : '', title: String(task.title), content,
        reviewStatus: (task.quality as DeliverableReviewStatus | null) ?? 'unmarked',
        createdAt: Number(task.created_at), updatedAt: Number(task.ended_at ?? task.created_at)
      });
    }
    const runs = this.db.raw.prepare("SELECT * FROM team_runs WHERE phase = 'done' ORDER BY created_at DESC").all() as unknown as Row[];
    for (const run of runs) {
      const content = typeof run.final_result === 'string' ? run.final_result.trim() : '';
      if (!content) continue;
      const team = teams.get(String(run.team_id));
      sources.push({
        sourceType: 'team_run', sourceId: String(run.id), projectId: run.project_id ? String(run.project_id) : null,
        ownerType: 'team', ownerId: String(run.team_id), ownerName: team ? String(team.name) : '已归档专家团',
        ownerRole: '专家团终稿', title: String(run.task_text), content, reviewStatus: 'unmarked',
        createdAt: Number(run.created_at), updatedAt: Number(run.ended_at ?? run.created_at)
      });
    }
    for (const source of sources) this.syncSource(source);
  }

  private syncSource(source: SourceRecord) {
    const existing = this.db.raw.prepare('SELECT * FROM deliverables WHERE source_type = ? AND source_id = ?')
      .get(source.sourceType, source.sourceId) as unknown as DeliverableRow | undefined;
    const hash = createHash('sha256').update(source.content).digest('hex');
    const now = Date.now();
    if (!existing) {
      const id = `deliverable-${randomUUID().slice(0, 12)}`;
      this.db.transaction(() => {
        this.db.raw.prepare(
          'INSERT INTO deliverables(id, source_type, source_id, project_id, owner_type, owner_id, owner_name, owner_role, title, type, tags_json, review_status, review_note, source_hash, source_updated_at, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
        ).run(id, source.sourceType, source.sourceId, source.projectId, source.ownerType, source.ownerId, source.ownerName, source.ownerRole, source.title,
          this.inferType(source.title, source.content), '[]', source.reviewStatus, '', hash, source.updatedAt, source.createdAt, source.updatedAt);
        this.insertVersion(id, 1, source.content, '来源成果首次同步', 'source', source.ownerName, source.updatedAt);
      });
      return;
    }

    if (existing.source_hash !== hash) {
      const versions = this.versionRows(existing.id);
      const nextVersion = (versions[0]?.version ?? 0) + 1;
      this.db.transaction(() => {
        this.insertVersion(existing.id, nextVersion, source.content, '来源成果更新', 'source', source.ownerName, now);
        this.db.raw.prepare(
          "UPDATE deliverables SET project_id = ?, owner_id = ?, owner_name = ?, owner_role = ?, title = ?, review_status = 'unmarked', review_note = '', source_hash = ?, source_updated_at = ?, updated_at = ? WHERE id = ?"
        ).run(source.projectId, source.ownerId, source.ownerName, source.ownerRole, source.title, hash, source.updatedAt, now, existing.id);
        this.db.raw.prepare(
          'INSERT INTO deliverable_reviews(id, deliverable_id, status, note, reviewer, rework_ref, created_at) VALUES(?,?,?,?,?,?,?)'
        ).run(randomUUID(), existing.id, 'unmarked', `来源更新为 v${nextVersion}，等待重新验收`, 'system', null, now);
        if (source.sourceType === 'task') {
          this.db.raw.prepare('UPDATE tasks SET quality = ? WHERE id = ?').run(null, source.sourceId);
        }
      });
      return;
    }

    const metadataChanged = existing.project_id !== source.projectId ||
      existing.owner_id !== source.ownerId || existing.owner_name !== source.ownerName ||
      existing.owner_role !== source.ownerRole || existing.title !== source.title ||
      existing.source_updated_at !== source.updatedAt;
    if (metadataChanged) {
      this.db.raw.prepare(
        'UPDATE deliverables SET project_id = ?, owner_id = ?, owner_name = ?, owner_role = ?, title = ?, source_updated_at = ?, updated_at = ? WHERE id = ?'
      ).run(source.projectId, source.ownerId, source.ownerName, source.ownerRole, source.title, source.updatedAt, now, existing.id);
    }
  }

  private mapSummary(row: DeliverableRow, versions: VersionRow[], projectName: string | null): DeliverableSummary {
    const latest = versions[0];
    return {
      id: row.id, sourceType: row.source_type, sourceId: row.source_id, projectId: row.project_id, projectName,
      ownerType: row.owner_type, ownerId: row.owner_id, ownerName: row.owner_name, ownerRole: row.owner_role,
      title: row.title, type: row.type, tags: this.parseTags(row.tags_json), reviewStatus: row.review_status,
      reviewNote: row.review_note, latestVersion: latest?.version ?? 0, versionCount: versions.length,
      preview: (latest?.content ?? '').slice(0, 320), createdAt: row.created_at, updatedAt: row.updated_at,
      sourceUpdatedAt: row.source_updated_at
    };
  }

  private mapVersion = (row: VersionRow): DeliverableVersion => ({
    id: row.id, deliverableId: row.deliverable_id, version: row.version, content: row.content,
    changeNote: row.change_note, origin: row.origin, createdBy: row.created_by, createdAt: row.created_at
  });

  private mapReview = (row: ReviewRow): DeliverableReviewEvent => ({
    id: row.id, deliverableId: row.deliverable_id, status: row.status, note: row.note,
    reviewer: row.reviewer, reworkRef: row.rework_ref, createdAt: row.created_at
  });

  private sourceTrace(row: DeliverableRow): DeliverableDetail['trace']['source'] {
    if (row.source_type === 'task') {
      const source = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(row.source_id) as unknown as Row | undefined;
      return { type: 'task', id: row.source_id, title: source ? String(source.title) : row.title, status: source ? String(source.status) : 'archived', createdAt: source ? Number(source.created_at) : row.created_at };
    }
    const source = this.db.raw.prepare('SELECT * FROM team_runs WHERE id = ?').get(row.source_id) as unknown as Row | undefined;
    return { type: 'team_run', id: row.source_id, title: source ? String(source.task_text) : row.title, status: source ? String(source.phase) : 'archived', createdAt: source ? Number(source.created_at) : row.created_at };
  }

  private versionRows(deliverableId: string): VersionRow[] {
    return this.db.raw.prepare('SELECT * FROM deliverable_versions WHERE deliverable_id = ? ORDER BY version DESC')
      .all(deliverableId) as unknown as VersionRow[];
  }

  private insertVersion(id: string, version: number, content: string, note: string, origin: DeliverableVersion['origin'], createdBy: string, createdAt: number) {
    this.db.raw.prepare(
      'INSERT INTO deliverable_versions(id, deliverable_id, version, content, change_note, origin, created_by, created_at) VALUES(?,?,?,?,?,?,?,?)'
    ).run(randomUUID(), id, version, content, note, origin, createdBy, createdAt);
  }

  private inferType(title: string, content: string): DeliverableType {
    const value = `${title}\n${content.slice(0, 500)}`.toLowerCase();
    if (/```|\.tsx?|\.jsx?|\.py\b|代码|脚本|接口/.test(value)) return 'code';
    if (/数据|csv|json|指标|分析表|统计/.test(value)) return 'data';
    if (/设计|原型|视觉|交互|ui|ux/.test(value)) return 'design';
    if (/报告|总结|复盘|调研|方案/.test(value)) return 'report';
    return 'document';
  }

  private type(value: unknown): DeliverableType {
    if (!TYPES.includes(value as DeliverableType)) throw new Error('成果类型无效');
    return value as DeliverableType;
  }

  private reviewStatus(value: unknown): DeliverableReviewStatus {
    if (!REVIEW_STATUSES.includes(value as DeliverableReviewStatus)) throw new Error('验收状态无效');
    return value as DeliverableReviewStatus;
  }

  private tags(value: unknown): string[] {
    if (!Array.isArray(value)) throw new Error('成果标签无效');
    const tags = [...new Set(value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean))];
    if (tags.length > 10 || tags.some((tag) => tag.length > 24)) throw new Error('成果标签最多 10 个，每个不超过 24 个字符');
    return tags;
  }

  private parseTags(value: string): string[] {
    try { return this.tags(JSON.parse(value)); } catch { return []; }
  }

  private text(value: unknown, label: string, min: number, max: number): string {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text.length < min || text.length > max) throw new Error(`${label}需 ${min}-${max} 个字符`);
    return text;
  }

  private mapProject(row: Row): Project {
    return {
      id: String(row.id), name: String(row.name), objective: String(row.objective ?? ''), description: String(row.description ?? ''),
      clientName: String(row.client_name ?? ''), status: row.status as ProjectStatus, color: String(row.color ?? '#4d6bfe'),
      dueAt: row.due_at === null || row.due_at === undefined ? null : Number(row.due_at), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at)
    };
  }
}
