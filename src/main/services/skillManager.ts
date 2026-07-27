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

  /** 判断 skill 是否为工作流引用（content 以 "workflow:" 开头） */
  isWorkflowSkill(skill: Skill): boolean {
    return skill.content.startsWith('workflow:');
  }

  /** 提取工作流 ID（从 skill.content 中解析） */
  getWorkflowId(skill: Skill): string | null {
    if (!this.isWorkflowSkill(skill)) return null;
    return skill.content.slice('workflow:'.length);
  }

  // ---------- Skills 组合 → 数字员工（P4） ----------

  /**
   * 把单个/多个 Skills 组合成数字员工的人设草案：
   * systemPrompt 注入全部技能正文（工作流引用型技能只注入名称与说明），
   * 创建后由调用方（ipc）走 orchestrator.createAgent 真实建档并绑定 agent_skills，
   * 员工即具备真实执行链路（任务拆分规划 → 工具调用 → 产出结果）。
   */
  composeAgentDraft(skillIds: string[], nameOverride?: string): {
    name: string; role: string; systemPrompt: string; soulMd: string; agentsMd: string; skillIds: string[];
  } {
    const all = this.list().filter((s) => skillIds.includes(s.id) && s.enabled);
    if (all.length === 0) throw new Error('请至少选择一个已启用的技能');

    const name = (nameOverride?.trim() || (all.length === 1 ? `${all[0].name}专员` : `${all[0].name}等${all.length}项技能专员`)).slice(0, 30);
    const skillNames = all.map((s) => s.name).join('、');
    const role = `掌握「${skillNames}」的数字员工：接到任务后先拆解为可执行步骤，逐步调用技能与工具完成，并输出结构化结果。`.slice(0, 500);

    const skillSections = all.map((s) => {
      const body = this.isWorkflowSkill(s)
        ? `（工作流技能：执行时触发内部工作流「${s.name}」）\n${s.description}`
        : s.content;
      return `### 技能：${s.name}\n${s.description ? s.description + '\n' : ''}${body}`;
    }).join('\n\n');

    const systemPrompt = [
      `你是一名数字员工，精通以下 ${all.length} 项技能。处理任务时遵循：`,
      '1. 理解需求 → 拆分为有序子步骤（复杂任务先列计划）',
      '2. 按步骤执行，优先运用下列技能的方法与约定',
      '3. 产出结构化结果（markdown），说明做了什么、结论与后续建议',
      '',
      '## 技能库',
      skillSections
    ].join('\n');

    const soulMd = `# 身份\n以「${skillNames}」为核心能力的执行型数字员工。\n\n# 风格\n- 先规划后执行,步骤可追溯\n- 结果导向,产出即交付`;
    const agentsMd = [
      '# 行为准则',
      '- 任务开始时先输出执行计划（步骤列表）',
      '- 每步完成后简要汇报进展',
      '- 遇到超出技能范围的需求，明确说明并给出建议',
      '- 高风险操作（删除/外发）先申请审批',
      '- 最终输出包含：结果摘要、产物清单、遗留事项'
    ].join('\n');

    return { name, role, systemPrompt, soulMd, agentsMd, skillIds: all.map((s) => s.id) };
  }
}
