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
import { getProviderSettings, readProviderKey } from './provider.js';

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
  if (b64 && safeStorage.isEncryptionAvailable()) {
    try {
      Object.assign(env, JSON.parse(safeStorage.decryptString(Buffer.from(b64, 'base64'))) as Record<string, string>);
    } catch {
      /* 解密失败视为无敏感变量 */
    }
  }

  // 供应商凭据下发：让第三方 CLI 复用应用内已配置的供应商，避免用户在
  // 每个引擎里重复配一遍 key。用户自定义的同名变量优先（上面已写入，此处不覆盖）。
  for (const [k, v] of Object.entries(providerEnvFor(db))) {
    if (env[k] === undefined) env[k] = v;
  }
  return env;
}

/**
 * 供应商 baseUrl 特征 → 该供应商专属的 API key 变量名。
 *
 * 【为什么需要按家区分】实测 Hermes v0.19.0：它从模型名推断供应商，然后只认该供应商
 * 专属的变量名，注入 OPENAI_API_KEY 无效 ——
 *   provider=auto + deepseek 模型 → "No usable credentials found for
 *                                    provider 'deepseek'. Set DEEPSEEK_API_KEY."
 *   --provider custom             → 仍去连 openrouter，报 HTTP 401
 * 因此必须同时注入专属名与 OpenAI 兼容名，才能覆盖不同 CLI 的取值习惯。
 *
 * 新增供应商时在此追加一行即可；未匹配的走纯 OpenAI 兼容变量。
 */
const PROVIDER_KEY_ALIASES: { test: RegExp; vars: string[] }[] = [
  { test: /deepseek/i, vars: ['DEEPSEEK_API_KEY'] },
  { test: /openrouter/i, vars: ['OPENROUTER_API_KEY'] },
  { test: /moonshot|kimi/i, vars: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'] },
  { test: /bigmodel|zhipu|\bz\.ai\b/i, vars: ['GLM_API_KEY', 'ZHIPUAI_API_KEY'] },
  { test: /dashscope|aliyun|qwen/i, vars: ['DASHSCOPE_API_KEY'] },
  { test: /anthropic/i, vars: ['ANTHROPIC_API_KEY'] },
  { test: /generativelanguage|googleapis/i, vars: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'] },
  { test: /minimax/i, vars: ['MINIMAX_API_KEY'] },
  { test: /siliconflow/i, vars: ['SILICONFLOW_API_KEY'] }
];

/**
 * 把应用内配置的默认供应商翻译成第三方 CLI 认识的环境变量。
 *
 * 【为什么需要】Hermes / OpenCode / Codex 都读自己的配置或环境变量取模型凭据。
 * 用户在本应用配好了供应商（如 DeepSeek），第三方引擎却一无所知，
 * 于是启动成功但一调用就 401（实测 Hermes 报 "HTTP 401: Missing Authentication header"）。
 *
 * 注入两组变量：① 供应商专属名（Hermes 等按供应商取值的 CLI 需要）；
 * ② OpenAI 兼容名（多数 CLI 的通用约定）。仅在用户未自行设置同名变量时生效，
 * 保证「引擎配置页里手填的值」始终优先。
 *
 * 注：凭据只出现在子进程 env 中，不落盘、不进日志、不回传 Renderer。
 */
export function providerEnvFor(db: Database): Record<string, string> {
  const settings = getProviderSettings(db);
  const key = readProviderKey(db);
  if (!key || !settings.baseUrl) return {};

  const baseUrl = settings.baseUrl.replace(/\/+$/, '');
  const env: Record<string, string> = {
    OPENAI_API_KEY: key,
    OPENAI_BASE_URL: baseUrl,
    OPENAI_API_BASE: baseUrl // 部分工具用旧名
  };
  if (settings.model) env.OPENAI_MODEL = settings.model;

  // 供应商专属变量名：按 baseUrl 特征匹配（Hermes 只认这组）
  for (const { test, vars } of PROVIDER_KEY_ALIASES) {
    if (!test.test(baseUrl)) continue;
    for (const v of vars) env[v] = key;
    break;
  }
  return env;
}
