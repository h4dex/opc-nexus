/**
 * Skills 管理：可复用的指令模板（markdown），按助手绑定后注入 system prompt。
 * CRUD + 绑定/解绑；支持从 ~/.hermes/skills/ 同步导入。
 */
import { randomUUID } from 'node:crypto';
import type { Database } from './database.js';

export interface Skill {
  id: string;
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  createdAt: number;
}

export class SkillManager {
  constructor(private db: Database) {}

  list(): Skill[] {
    return (this.db.raw.prepare('SELECT * FROM skills ORDER BY created_at DESC').all() as unknown as {
      id: string; name: string; description: string; content: string; enabled: number; created_at: number;
    }[]).map((r) => ({
      id: r.id, name: r.name, description: r.description, content: r.content,
      enabled: r.enabled === 1, createdAt: r.created_at
    }));
  }

  create(input: { name: string; description?: string; content?: string }): Skill {
    const id = `skill-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    this.db.raw.prepare('INSERT INTO skills(id, name, description, content, enabled, created_at) VALUES(?,?,?,?,1,?)')
      .run(id, input.name, input.description ?? '', input.content ?? '', now);
    return { id, name: input.name, description: input.description ?? '', content: input.content ?? '', enabled: true, createdAt: now };
  }

  update(id: string, patch: { name?: string; description?: string; content?: string; enabled?: boolean }) {
    const fields: string[] = [];
    const values: (string | number)[] = [];
    if (patch.name !== undefined) { fields.push('name = ?'); values.push(patch.name); }
    if (patch.description !== undefined) { fields.push('description = ?'); values.push(patch.description); }
    if (patch.content !== undefined) { fields.push('content = ?'); values.push(patch.content); }
    if (patch.enabled !== undefined) { fields.push('enabled = ?'); values.push(patch.enabled ? 1 : 0); }
    if (fields.length === 0) return;
    values.push(id);
    this.db.raw.prepare(`UPDATE skills SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  remove(id: string) {
    this.db.raw.prepare('DELETE FROM agent_skills WHERE skill_id = ?').run(id);
    this.db.raw.prepare('DELETE FROM skills WHERE id = ?').run(id);
  }

  // ---------- 助手绑定 ----------

  bindAgent(agentId: string, skillId: string) {
    this.db.raw.prepare('INSERT OR IGNORE INTO agent_skills(agent_id, skill_id) VALUES(?, ?)').run(agentId, skillId);
  }

  unbindAgent(agentId: string, skillId: string) {
    this.db.raw.prepare('DELETE FROM agent_skills WHERE agent_id = ? AND skill_id = ?').run(agentId, skillId);
  }

  /** 获取助手绑定的 skills */
  forAgent(agentId: string): Skill[] {
    return (this.db.raw.prepare(
      'SELECT s.* FROM skills s JOIN agent_skills as2 ON s.id = as2.skill_id WHERE as2.agent_id = ?'
    ).all(agentId) as unknown as { id: string; name: string; description: string; content: string; enabled: number; created_at: number }[])
      .map((r) => ({ id: r.id, name: r.name, description: r.description, content: r.content, enabled: r.enabled === 1, createdAt: r.created_at }));
  }
}
