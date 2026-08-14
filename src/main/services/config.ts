/**
 * 应用配置文件：userData/aibox-data/aibox.config.json
 * 管理员可直接编辑文件或在设置页修改：
 *  - npmRegistry：引擎自动安装的默认下载地址（npm registry）
 *  - engines：按引擎覆写可执行名 / npm 包名 / 非交互运行参数
 * 配置文件不存密钥（15.1），密钥仍走 safeStorage。
 */
import { app } from 'electron';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AppConfig } from '../../shared/types.js';

const DEFAULTS: AppConfig = {
  npmRegistry: 'https://registry.npmmirror.com',
  engines: {}
};

let cached: AppConfig | null = null;

function configPath(): string {
  return join(app.getPath('userData'), 'aibox-data', 'aibox.config.json');
}

/** 读取配置（首次生成默认文件；解析失败回退默认值，不吞掉用户文件） */
export function loadConfig(): AppConfig {
  if (cached) return cached;
  const file = configPath();
  if (!existsSync(file)) {
    mkdirSync(join(app.getPath('userData'), 'aibox-data'), { recursive: true });
    writeFileSync(file, JSON.stringify(DEFAULTS, null, 2), 'utf8');
    cached = { ...DEFAULTS, engines: {} };
    return cached;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppConfig>;
    cached = {
      npmRegistry: sanitizeRegistry(parsed.npmRegistry) ?? DEFAULTS.npmRegistry,
      engines: parsed.engines && typeof parsed.engines === 'object' ? parsed.engines : {}
    };
  } catch {
    cached = { ...DEFAULTS, engines: {} };
  }
  return cached;
}

/**
 * 保存来自 Renderer/Web 的应用配置。外部 ACP 命令只能经 EngineManager 注册并落库；
 * 这里保留磁盘中已有的 engines，避免远程配置接口变成任意进程启动入口。
 */
export function saveConfig(patch: Partial<AppConfig>): AppConfig {
  const current = loadConfig();
  const next: AppConfig = {
    npmRegistry: sanitizeRegistry(patch.npmRegistry) ?? current.npmRegistry,
    engines: current.engines
  };
  writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
  cached = next;
  return next;
}

/** registry 合法性校验：仅接受 http/https，且不含 cmd 特殊字符（Windows 下经 cmd.exe 拉起 npm） */
export function sanitizeRegistry(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  if (/[\s&|<>^%!"'`]/.test(raw)) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}
