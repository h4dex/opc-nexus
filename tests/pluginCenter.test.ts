import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('插件中心用户边界', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'pages', 'Plugins.tsx'), 'utf8');

  it('不把 DSH/Cordis 内部包作为可见插件入口或计数分母', () => {
    expect(source).toContain('{filtered.length} / {visibleItems.length}');
    expect(source).not.toContain("'dsh'");
    expect(source).not.toContain('DSH/Cordis、治理插件');
    expect(source).not.toContain("dsh: '执行兼容层'");
  });

  it('将内部执行 owner 显示为非调度产品入口', () => {
    expect(source).toContain("item.owner === 'nexus-governance' ? '内置治理能力'");
  });
});
