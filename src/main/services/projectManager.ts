/** 项目领域服务：经营目标与任务/成果之间的稳定归属层。 */
import { randomUUID } from 'node:crypto';
import type { Project, ProjectInput, ProjectPatch, ProjectStatus } from '../../shared/types.js';
import type { Database } from './database.js';

interface ProjectRow {
  id: string;
  name: string;
  objective: string;
  description: string;
  client_name: string;
  status: string;
  color: string;
  due_at: number | null;
  created_at: number;
  updated_at: number;
}

const STATUSES: ProjectStatus[] = ['planning', 'active', 'paused', 'completed', 'archived'];
const DEFAULT_COLOR = '#4d6bfe';

export class ProjectManager {
  constructor(private db: Database) {}

  list(): Project[] {
    return (this.db.raw.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as unknown as ProjectRow[])
      .map(this.mapRow);
  }

  get(id: string): Project | null {
    const row = this.db.raw.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as ProjectRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  create(input: ProjectInput): Project {
    const name = this.requiredText(input.name, '项目名称', 2, 60);
    const objective = this.text(input.objective, '项目目标', 500);
    const description = this.text(input.description, '项目说明', 2000);
    const clientName = this.text(input.clientName, '客户名称', 100);
    const status = this.status(input.status ?? 'active', false);
    const color = this.color(input.color);
    const dueAt = this.dueAt(input.dueAt);
    const now = Date.now();
    const id = `project-${randomUUID().slice(0, 8)}`;

    this.db.raw.prepare(
      'INSERT INTO projects(id, name, objective, description, client_name, status, color, due_at, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)'
    ).run(id, name, objective, description, clientName, status, color, dueAt, now, now);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'project.create', target: id, result: 'ok' });
    return this.get(id)!;
  }

  update(id: string, patch: ProjectPatch): Project | null {
    if (!this.get(id)) return null;
    const fields: string[] = [];
    const values: (string | number | null)[] = [];
    const add = (field: string, value: string | number | null) => { fields.push(`${field} = ?`); values.push(value); };

    if (patch.name !== undefined) add('name', this.requiredText(patch.name, '项目名称', 2, 60));
    if (patch.objective !== undefined) add('objective', this.text(patch.objective, '项目目标', 500));
    if (patch.description !== undefined) add('description', this.text(patch.description, '项目说明', 2000));
    if (patch.clientName !== undefined) add('client_name', this.text(patch.clientName, '客户名称', 100));
    if (patch.status !== undefined) add('status', this.status(patch.status, true));
    if (patch.color !== undefined) add('color', this.color(patch.color));
    if (patch.dueAt !== undefined) add('due_at', this.dueAt(patch.dueAt));
    if (fields.length === 0) return this.get(id);

    add('updated_at', Date.now());
    values.push(id);
    this.db.raw.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'project.update', target: id, result: 'ok' });
    return this.get(id);
  }

  archive(id: string): Project | null {
    const project = this.update(id, { status: 'archived' });
    if (project) this.db.audit({ id: randomUUID(), actor: 'admin', action: 'project.archive', target: id, result: 'ok' });
    return project;
  }

  private mapRow = (row: ProjectRow): Project => ({
    id: row.id,
    name: row.name,
    objective: row.objective ?? '',
    description: row.description ?? '',
    clientName: row.client_name ?? '',
    status: row.status as ProjectStatus,
    color: row.color || DEFAULT_COLOR,
    dueAt: row.due_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });

  private requiredText(value: unknown, label: string, min: number, max: number): string {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text.length < min || text.length > max) throw new Error(`${label}需为 ${min}-${max} 个字符`);
    return text;
  }

  private text(value: unknown, label: string, max: number): string {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text.length > max) throw new Error(`${label}不能超过 ${max} 个字符`);
    return text;
  }

  private status(value: unknown, allowArchived: boolean): ProjectStatus {
    if (!STATUSES.includes(value as ProjectStatus) || (!allowArchived && value === 'archived')) throw new Error('项目状态无效');
    return value as ProjectStatus;
  }

  private color(value: unknown): string {
    const color = typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : DEFAULT_COLOR;
    return color.toLowerCase();
  }

  private dueAt(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error('项目截止时间无效');
    return Math.floor(value);
  }
}
