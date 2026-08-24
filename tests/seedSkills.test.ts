import { describe, expect, it } from 'vitest';
import { ensureBuiltinSkills } from '../src/main/services/seed.js';

type SkillRow = { id: string; name: string; description: string; content: string; enabled: number; created_at: number };

function fakeDb(initial: SkillRow[] = []) {
  const rows = new Map(initial.map((row) => [row.id, { ...row }]));
  const db = {
    raw: {
      prepare(sql: string) {
        return {
          get(...args: unknown[]) {
            if (/SELECT id FROM skills WHERE id/i.test(sql)) {
              const row = rows.get(String(args[0]));
              return row ? { id: row.id } : undefined;
            }
            if (/SELECT id FROM skills WHERE name/i.test(sql)) {
              const row = [...rows.values()].find((item) => item.name === String(args[0]));
              return row ? { id: row.id } : undefined;
            }
            return undefined;
          },
          run(...args: unknown[]) {
            const [id, name, description, content, enabled, createdAt] = args as [string, string, string, string, number, number];
            rows.set(id, { id, name, description, content, enabled, created_at: createdAt });
            return { changes: 1 };
          }
        };
      }
    },
    transaction(fn: () => void) { fn(); },
    rows
  };
  return db;
}

describe('ensureBuiltinSkills', () => {
  it('adds the Office built-ins even when an upgraded database already has other skills', () => {
    const db = fakeDb([{ id: 'custom-skill', name: '我的技能', description: '', content: 'custom', enabled: 1, created_at: 1 }]);
    const result = ensureBuiltinSkills(db as never);
    expect(result.inserted).toEqual(expect.arrayContaining(['skill-office-docx', 'skill-office-xlsx', 'skill-office-pptx']));
    expect([...db.rows.values()].map((row) => row.name)).toEqual(expect.arrayContaining(['Word 文档生成', 'Excel 数据处理', 'PPT 演示制作']));
    expect(db.rows.get('custom-skill')?.content).toBe('custom');
  });

  it('does not duplicate or overwrite an existing user-customized Office skill', () => {
    const db = fakeDb([
      { id: 'legacy-office-word', name: 'Word 文档生成', description: '用户描述', content: 'user content', enabled: 0, created_at: 1 },
      { id: 'skill-office-xlsx', name: 'Excel 数据处理', description: 'old', content: 'old', enabled: 0, created_at: 1 }
    ]);
    const result = ensureBuiltinSkills(db as never);
    expect(result.inserted).toContain('skill-office-pptx');
    expect(result.inserted).not.toContain('skill-office-docx');
    expect(result.inserted).not.toContain('skill-office-xlsx');
    expect(db.rows.get('legacy-office-word')).toMatchObject({ content: 'user content', enabled: 0 });
    expect(db.rows.get('skill-office-xlsx')).toMatchObject({ content: 'old', enabled: 0 });
  });
});
