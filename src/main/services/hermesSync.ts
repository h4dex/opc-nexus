/**
 * Hermes 同步：与真实 hermes-agent 的配置目录双向同步 MCP 配置和 Skills。
 *
 * 【目录归属边界 — 重要】
 * hermes-agent (NousResearch) 使用同一配置目录存放它自己的 config.yaml / .env /
 * skills/ / 会话数据库。本模块必须与之共存，绝不能破坏其文件，因此约定：
 *  - 只读不写：config.yaml、.env（.env 内含 API 密钥，任何情况下不得读取或导出）
 *  - 我方导出的 MCP 配置写入独立文件 mcp_servers.json（不改 config.yaml 的 mcp_servers 段）
 *  - 我方导出的 Skills 写入 skills/ 下的独立子目录 opc-nexus/，不与用户/官方 skills 混放
 *  - 导入时同时扫描 skills/ 根目录与 opc-nexus/ 子目录
 *
 * 目录解析优先级：HERMES_HOME 环境变量 > 平台默认
 *  - Windows: %LOCALAPPDATA%\hermes
 *  - Linux/macOS: ~/.hermes
 *
 * 同步策略：按 name 去重；导入时已存在的条目跳过（不覆盖本地），导出仅覆盖我方子目录。
 *
 * @author liyingjie <y@senke.com>
 */
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import type { McpManager } from './mcpManager.js';
import type { SkillManager } from './skillManager.js';

/** 我方导出的 Skills 子目录名，避免覆盖 hermes-agent 自身或用户手写的 skills */
const OWNED_SKILLS_SUBDIR = 'opc-nexus';

/**
 * 解析 hermes-agent 配置目录（与其安装脚本的行为保持一致）。
 * 允许通过 HERMES_HOME 覆盖，便于多 profile 与测试。
 */
function hermesDir(): string {
  const override = process.env.HERMES_HOME?.trim();
  if (override) return override;
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) return join(localAppData, 'hermes');
  }
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

  // Skills 导入：扫描 skills/ 根目录 + 我方 skills/opc-nexus/ 子目录
  const skillsRoot = join(dir, 'skills');
  const existingSkills = new Set(skills.list().map((s) => s.name));
  for (const skillsDir of [skillsRoot, join(skillsRoot, OWNED_SKILLS_SUBDIR)]) {
    if (!existsSync(skillsDir)) continue;
    try {
      const files = readdirSync(skillsDir).filter((f) => f.endsWith('.md'));
      for (const file of files) {
        const name = file.replace(/\.md$/, '');
        if (existingSkills.has(name)) continue;
        const content = readFileSync(join(skillsDir, file), 'utf8');
        skills.create({ name, description: '从 Hermes 导入', content });
        existingSkills.add(name); // 防止根目录与子目录同名重复导入
        skillCount++;
      }
    } catch (err) {
      errors.push(`Skills 导入失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { mcp: mcpCount, skills: skillCount, errors };
}

/**
 * 从本应用导出到 hermes-agent 配置目录。
 * 仅写入我方拥有的路径：mcp_servers.json 与 skills/opc-nexus/；
 * 绝不触碰 config.yaml、.env 或用户自有的 skills 文件。
 */
export function exportToHermes(mcp: McpManager, skills: SkillManager): { mcp: number; skills: number; errors: string[] } {
  const errors: string[] = [];
  const dir = hermesDir();
  let mcpCount = 0;
  let skillCount = 0;

  try {
    mkdirSync(dir, { recursive: true });

    // MCP 配置导出：独立文件，不合并进 hermes-agent 的 config.yaml
    const servers = mcp.list();
    const mcpData: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};
    for (const s of servers) {
      mcpData[s.name] = { command: s.command, args: s.args, env: s.env };
    }
    writeFileSync(join(dir, 'mcp_servers.json'), JSON.stringify(mcpData, null, 2), 'utf8');
    mcpCount = servers.length;

    // Skills 导出：写入我方专属子目录，避免覆盖 hermes-agent / 用户 skills
    const ownedSkillsDir = join(dir, 'skills', OWNED_SKILLS_SUBDIR);
    mkdirSync(ownedSkillsDir, { recursive: true });
    for (const sk of skills.list()) {
      if (!sk.enabled) continue;
      writeFileSync(join(ownedSkillsDir, `${sk.name}.md`), sk.content, 'utf8');
      skillCount++;
    }
  } catch (err) {
    errors.push(`导出失败：${err instanceof Error ? err.message : String(err)}`);
  }

  return { mcp: mcpCount, skills: skillCount, errors };
}
