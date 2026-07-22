/**
 * Hermes 同步：与本地 ~/.hermes/ 目录双向同步 MCP 配置和 Skills。
 * - 导入：读取 ~/.hermes/mcp_servers.json → 合并到 mcp_servers 表
 *          读取 ~/.hermes/skills/*.md → 合并到 skills 表
 * - 导出：将本应用 MCP 配置写入 ~/.hermes/mcp_servers.json
 *          将 skills 写入 ~/.hermes/skills/ 目录
 * 同步策略：按 name 去重，冲突时以本应用为准（覆盖远端）。
 */
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import type { McpManager } from './mcpManager.js';
import type { SkillManager } from './skillManager.js';

function hermesDir(): string {
  return join(homedir(), '.hermes');
}

export interface SyncResult {
  imported: { mcp: number; skills: number };
  exported: { mcp: number; skills: number };
  errors: string[];
}

/** 从 ~/.hermes/ 导入到本应用 */
export function importFromHermes(mcp: McpManager, skills: SkillManager): { mcp: number; skills: number; errors: string[] } {
  const errors: string[] = [];
  let mcpCount = 0;
  let skillCount = 0;
  const dir = hermesDir();

  // MCP 配置导入
  const mcpFile = join(dir, 'mcp_servers.json');
  if (existsSync(mcpFile)) {
    try {
      const data = JSON.parse(readFileSync(mcpFile, 'utf8')) as Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
      const existing = new Set(mcp.list().map((s) => s.name));
      for (const [name, cfg] of Object.entries(data)) {
        if (!cfg.command || existing.has(name)) continue;
        mcp.create({ name, command: cfg.command, args: cfg.args ?? [], env: cfg.env ?? {} });
        mcpCount++;
      }
    } catch (err) {
      errors.push(`MCP 配置解析失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Skills 导入（~/.hermes/skills/*.md）
  const skillsDir = join(dir, 'skills');
  if (existsSync(skillsDir)) {
    try {
      const files = readdirSync(skillsDir).filter((f) => f.endsWith('.md'));
      const existing = new Set(skills.list().map((s) => s.name));
      for (const file of files) {
        const name = file.replace(/\.md$/, '');
        if (existing.has(name)) continue;
        const content = readFileSync(join(skillsDir, file), 'utf8');
        skills.create({ name, description: `从 Hermes 导入`, content });
        skillCount++;
      }
    } catch (err) {
      errors.push(`Skills 导入失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { mcp: mcpCount, skills: skillCount, errors };
}

/** 从本应用导出到 ~/.hermes/ */
export function exportToHermes(mcp: McpManager, skills: SkillManager): { mcp: number; skills: number; errors: string[] } {
  const errors: string[] = [];
  const dir = hermesDir();
  let mcpCount = 0;
  let skillCount = 0;

  try {
    mkdirSync(dir, { recursive: true });

    // MCP 配置导出
    const servers = mcp.list();
    const mcpData: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};
    for (const s of servers) {
      mcpData[s.name] = { command: s.command, args: s.args, env: s.env };
    }
    writeFileSync(join(dir, 'mcp_servers.json'), JSON.stringify(mcpData, null, 2), 'utf8');
    mcpCount = servers.length;

    // Skills 导出
    const skillsDir = join(dir, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    for (const sk of skills.list()) {
      if (!sk.enabled) continue;
      writeFileSync(join(skillsDir, `${sk.name}.md`), sk.content, 'utf8');
      skillCount++;
    }
  } catch (err) {
    errors.push(`导出失败：${err instanceof Error ? err.message : String(err)}`);
  }

  return { mcp: mcpCount, skills: skillCount, errors };
}
