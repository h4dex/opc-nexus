/**
 * SkillManager.composeAgentDraft 测试:Skills 组合 → 数字员工人设草案
 */
// @ts-nocheck
/* eslint-disable */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

import { SkillManager } from '../src/main/services/skillManager.js';

/** 最小 db mock:内存 skills 表 */
function makeDb() {
  const skills = new Map();
  return {
    skills,
    raw: {
      prepare: (sql: string) => ({
        get: () => undefined,
        all: () => {
          if (/SELECT \* FROM skills ORDER BY created_at DESC/.test(sql)) {
            return [...skills.values()].sort((a, b) => b.created_at - a.created_at);
          }
          return [];
        },
        run: (...args: unknown[]) => {
          if (/INSERT INTO skills/.test(sql)) {
            const [id, name, description, content, now] = args;
            skills.set(id, { id, name, description, content, enabled: 1, created_at: now });
          }
          return { changes: 1 };
        }
      })
    },
    transaction: (fn: () => void) => fn(),
    audit: vi.fn(),
    getSetting: (_k: string, fb: unknown) => fb,
    setSetting: vi.fn()
  };
}

describe('composeAgentDraft', () => {
  it('单技能:名称含技能名,systemPrompt 注入技能正文', () => {
    const db = makeDb();
    const mgr = new SkillManager(db as never);
    const s = mgr.create({ name: '代码审查', description: '审查代码质量', content: '## 审查要点\n- 安全漏洞\n- 性能问题' });
    const draft = mgr.composeAgentDraft([s.id]);
    expect(draft.name).toContain('代码审查');
    expect(draft.systemPrompt).toContain('## 审查要点');
    expect(draft.systemPrompt).toContain('拆分为有序子步骤');
    expect(draft.role).toContain('代码审查');
    expect(draft.skillIds).toEqual([s.id]);
  });

  it('多技能:全部技能正文注入,名称含数量', () => {
    const db = makeDb();
    const mgr = new SkillManager(db as never);
    const s1 = mgr.create({ name: '日报生成', content: '按模板汇总当日进展' });
    const s2 = mgr.create({ name: '数据分析', content: '输出图表与结论' });
    const draft = mgr.composeAgentDraft([s1.id, s2.id]);
    expect(draft.systemPrompt).toContain('按模板汇总当日进展');
    expect(draft.systemPrompt).toContain('输出图表与结论');
    expect(draft.role).toContain('日报生成');
    expect(draft.role).toContain('数据分析');
    expect(draft.skillIds).toHaveLength(2);
  });

  it('自定义名称优先', () => {
    const db = makeDb();
    const mgr = new SkillManager(db as never);
    const s = mgr.create({ name: '翻译', content: '中英互译' });
    const draft = mgr.composeAgentDraft([s.id], '专属翻译官');
    expect(draft.name).toBe('专属翻译官');
  });

  it('停用技能被排除;全部无效时抛错', () => {
    const db = makeDb();
    const mgr = new SkillManager(db as never);
    const s = mgr.create({ name: '废弃技能', content: 'x' });
    db.skills.get(s.id).enabled = 0;
    expect(() => mgr.composeAgentDraft([s.id])).toThrow('至少选择一个');
    expect(() => mgr.composeAgentDraft(['skill-nonexist'])).toThrow('至少选择一个');
  });

  it('工作流引用技能只注入名称说明,不注入 workflow: 原文', () => {
    const db = makeDb();
    const mgr = new SkillManager(db as never);
    const s = mgr.create({ name: '发布流程', description: '触发发布工作流', content: 'workflow:wf-123' });
    const draft = mgr.composeAgentDraft([s.id]);
    expect(draft.systemPrompt).toContain('工作流技能');
    expect(draft.systemPrompt).not.toContain('workflow:wf-123');
  });
});
