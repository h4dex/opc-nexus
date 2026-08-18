/**
 * Skills 管理：可复用的指令模板（markdown），按助手绑定后注入 system prompt。
 * CRUD + 绑定/解绑；支持从 ~/.hermes/skills/ 同步导入。
 */
import { randomUUID } from 'node:crypto';
import type { Database } from './database.js';

const BROWSER_SKILL_ID = 'skill-browser-operator';
const BROWSER_SKILL_CONTENT = `# 浏览器操作规范

- 开始操作前先获取当前页面快照，确认页面、账号和目标对象。
- 优先使用页面快照中的可访问角色、名称或稳定引用定位元素，不猜测选择器。
- 每次导航、点击或填写后重新观察页面，验证操作确实生效。
- 不读取、输出或保存 Cookie、密码、Token、localStorage 等认证材料。
- 涉及提交、发送、发布、购买、删除、授权或其他外部副作用时，遵循任务审批结果。
- 遇到登录、验证码、双因素认证或浏览器连接授权时暂停，等待用户完成后继续。
- 完成后汇报实际操作结果；无法确认成功时明确说明当前页面状态。`;

export const VISION_UNDERSTANDING_SKILL_ID = 'skill-vision-understanding';
const VISION_UNDERSTANDING_SKILL_CONTENT = `# 图片理解

## 使用方式
- 需要理解截图、照片、界面或图表时，调用 DSH/Cordis 工具 \`vision.describe\`。
- 需要精确抄录图片文字时，调用本地工具 \`vision.ocr\`；它与图片理解共用同一个 \`attachmentRef\`。
- 工具只接受宿主生成的 \`attachmentRef\`，不要传入文件路径、网络 URL、Base64 或凭据。
- 根据任务给出明确提示词，例如：识别界面状态、解释图表趋势、提取关键字段或检查视觉异常。

## 能力边界
- \`vision.describe\` 适合语义理解，\`vision.ocr\` 适合精确文字抄录；两者结果可组合但不要互相冒充。
- 不根据图片猜测身份、密钥或不可见信息；低置信度内容必须明确标注。
- 支持 PNG、JPEG、WebP 和 GIF，单图大小与像素数由宿主策略限制。

## 输出
- 先给结论，再列证据和不确定项。
- 涉及图表时说明指标、趋势、异常点和时间/坐标范围。
- 涉及界面时说明当前状态、可见控件和建议的下一步，不虚构已完成的操作。`;

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

  /** Ensure the built-in browser operating rules exist and are bound to one agent. */
  ensureBrowserOperator(agentId: string): Skill {
    const existing = this.db.raw.prepare('SELECT id FROM skills WHERE id = ?').get(BROWSER_SKILL_ID) as { id: string } | undefined;
    if (!existing) {
      this.db.raw.prepare('INSERT INTO skills(id, name, description, content, enabled, created_at) VALUES(?,?,?,?,1,?)')
        .run(BROWSER_SKILL_ID, '浏览器操作', '通过快照、验证和审批约束安全地操作网页', BROWSER_SKILL_CONTENT, Date.now());
    } else {
      this.db.raw.prepare('UPDATE skills SET name = ?, description = ?, content = ?, enabled = 1 WHERE id = ?')
        .run('浏览器操作', '通过快照、验证和审批约束安全地操作网页', BROWSER_SKILL_CONTENT, BROWSER_SKILL_ID);
    }
    this.bindAgent(agentId, BROWSER_SKILL_ID);
    return this.list().find((skill) => skill.id === BROWSER_SKILL_ID)!;
  }

  /** Ensure the DSH-owned image-understanding skill exists with a stable id. */
  ensureVisionUnderstanding(): Skill {
    const existing = this.db.raw.prepare('SELECT id FROM skills WHERE id = ?').get(VISION_UNDERSTANDING_SKILL_ID) as
      | { id: string }
      | undefined;
    const name = '图片理解';
    const description = '通过受控视觉模型理解图片，并用同一 attachmentRef 调用本地 OCR 精确识字';
    if (!existing) {
      this.db.raw.prepare('INSERT INTO skills(id, name, description, content, enabled, created_at) VALUES(?,?,?,?,1,?)')
        .run(VISION_UNDERSTANDING_SKILL_ID, name, description, VISION_UNDERSTANDING_SKILL_CONTENT, Date.now());
    } else {
      this.db.raw.prepare('UPDATE skills SET name = ?, description = ?, content = ?, enabled = 1 WHERE id = ?')
        .run(name, description, VISION_UNDERSTANDING_SKILL_CONTENT, VISION_UNDERSTANDING_SKILL_ID);
    }
    return this.list().find((skill) => skill.id === VISION_UNDERSTANDING_SKILL_ID)!;
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
