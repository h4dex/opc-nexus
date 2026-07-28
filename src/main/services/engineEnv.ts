/**
 * 引擎环境变量的密钥隔离工具
 *
 * 背景：引擎中心允许用户为 CLI 引擎配置自定义环境变量，其中常含 API_KEY / TOKEN 等凭据。
 * 早期实现把整份 env 明文写入 engines.config_json，并把内容截断后写进 engine_logs，
 * 违反项目安全基线（密钥须经 safeStorage，绝不进入 Renderer 与日志）。
 *
 * 本模块提供统一的拆分/解析逻辑：
 * - 敏感项（按变量名匹配）经 safeStorage 加密后存入 settings 表，config_json 中仅留占位符
 * - 主进程 spawn 时通过 resolveEngineEnv 还原完整 env，Renderer 侧只能看到占位符
 *
 * 独立成模块以避免 engineManager 与 cliExecutor 之间的循环依赖。
 *
 * @author liyingjie <y@senke.com>
 */
import { safeStorage } from 'electron';
import type { Database } from './database.js';

/** 敏感环境变量名匹配规则：命中则走 safeStorage，不落 config_json */
export const SECRET_ENV_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

/** config_json 中替代敏感值的占位符（Renderer 只能看到它；回传该值表示沿用已存密钥） */
export const SECRET_PLACEHOLDER = '***';

/** 引擎敏感环境变量在 settings 表中的存储键 */
export function engineEnvSecretRef(engineId: string): string {
  return `secret:engine:${engineId}:env`;
}

/**
 * 按变量名把环境变量拆成「可明文保存」与「须加密保存」两部分。
 * safe 中的敏感项被替换为占位符，以便 UI 知道该项已配置但拿不到值。
 */
export function splitSecretEnv(env: Record<string, string>): {
  safe: Record<string, string>;
  secrets: Record<string, string>;
} {
  const safe: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_ENV_PATTERN.test(key)) {
      // 占位符表示「保持原值不变」，不应覆盖已存密钥
      if (value !== SECRET_PLACEHOLDER) secrets[key] = value;
      safe[key] = SECRET_PLACEHOLDER;
    } else {
      safe[key] = value;
    }
  }
  return { safe, secrets };
}

/**
 * 解析引擎完整环境变量（含解密后的敏感项）。
 * **仅供主进程执行器 spawn 时使用，禁止经 IPC 暴露给 Renderer。**
 */
export function resolveEngineEnv(db: Database, engineId: string): Record<string, string> {
  const env: Record<string, string> = {};
  const row = db.raw.prepare('SELECT config_json FROM engines WHERE id = ?').get(engineId) as
    | { config_json?: string }
    | undefined;
  if (row?.config_json) {
    try {
      const parsed = JSON.parse(row.config_json) as { env?: Record<string, string> };
      for (const [k, v] of Object.entries(parsed.env ?? {})) {
        if (v !== SECRET_PLACEHOLDER) env[k] = v;
      }
    } catch {
      /* config_json 损坏时视为无自定义变量 */
    }
  }

  const b64 = db.getSetting<string>(engineEnvSecretRef(engineId), '');
  if (!b64 || !safeStorage.isEncryptionAvailable()) return env;
  try {
    Object.assign(env, JSON.parse(safeStorage.decryptString(Buffer.from(b64, 'base64'))) as Record<string, string>);
  } catch {
    /* 解密失败视为无敏感变量 */
  }
  return env;
}
