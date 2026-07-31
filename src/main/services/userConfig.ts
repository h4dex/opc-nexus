/**
 * 用户配置文件（P4 需求）：程序运行目录/user/config.yaml，不存在则自动生成模板。
 * - 打包环境：<exe 所在目录>/user/config.yaml；开发环境：<项目根>/user/config.yaml；
 *   目录不可写时回退 userData/user/config.yaml（Program Files 安装场景）
 * - 内容：企微机器人凭据（启动时导入 safeStorage，见 index.ts）、企微 webhook 通知地址、
 *   引擎策略（辅助引擎/执行模式）、任务看门狗参数
 * - 解析：内置 YAML 子集解析器（两级映射 + 标量 + 注释），零新增依赖
 * - 安全：文件含凭据，模板头部注明勿入仓库；Secret 导入系统密钥库后运行期不再读明文
 * - executionMode 默认 production：引擎不可用时任务转 FAILED，绝不用模拟结果冒充完成
 *
 * @author liyingjie <y@senke.com>
 */
import { app } from 'electron';
import { dirname, join } from 'node:path';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export interface UserConfig {
  wecom: {
    /** 智能机器人 BotID（长连接对话渠道） */
    botId: string;
    /** 智能机器人 Secret（启动时导入 safeStorage） */
    secret: string;
    /** 群机器人 webhook 地址（仅推送任务完成结果；空 = 不推送） */
    webhookUrl: string;
  };
  engine: {
    /** 辅助引擎：主引擎不可用时的回退引擎 ID */
    fallbackEngineId: string;
    /** production（默认）= 引擎不可用任务直接失败；demo = 回退演示模式（生成虚构产物，仅演示用） */
    executionMode: 'production' | 'demo';
  };
  task: {
    /** 单任务最长运行分钟数（看门狗；0 = 不限制） */
    maxRunMinutes: number;
  };
  /**
   * 模型供应商（OpenAI 兼容）。填在此处即可同时供内置 Nexus Agent 与第三方 CLI 引擎使用：
   * 启动时导入 providers 表与 safeStorage，第三方引擎 spawn 时按各家约定注入环境变量。
   */
  provider: {
    /** API Key（启动时导入系统密钥库，导入后可改为占位符） */
    apiKey: string;
    /** 接口地址，如 https://api.deepseek.com/v1 */
    baseUrl: string;
    /** 默认模型名，如 deepseek-chat */
    model: string;
  };
}

export const USER_CONFIG_DEFAULTS: UserConfig = {
  wecom: { botId: '', secret: '', webhookUrl: '' },
  engine: { fallbackEngineId: 'eng-opencode', executionMode: 'production' },
  task: { maxRunMinutes: 30 },
  provider: { apiKey: '', baseUrl: '', model: '' }
};

const TEMPLATE = `# =====================================================
# OPC-Nexus 用户配置文件（user/config.yaml）
# 首次启动自动生成；修改后重启应用生效。
# 注意：此文件可能包含凭据，请勿提交到代码仓库或分享。
# =====================================================

# 企业微信智能机器人（长连接，支持对话下发任务 / 审批 / 指令控制）
wecom:
  botId: ""            # BotID（企微管理后台「API 模式 · 长连接」获取）
  secret: ""           # Secret（启动时导入系统密钥库，之后可留空占位）
  webhookUrl: ""       # 群机器人 webhook 地址（仅推送任务完成结果；留空不推送）

# 引擎策略
engine:
  fallbackEngineId: "eng-opencode"   # 辅助引擎：主引擎不可用时回退（eng-opencode / eng-codex / eng-hermes-cli / eng-hermes）
  executionMode: "production"        # production(默认) = 引擎不可用任务直接失败；demo = 回退演示模式(仅演示用，会生成虚构产物)

# 任务保护（防长任务卡死 / 死循环）
task:
  maxRunMinutes: 30    # 单任务最长运行分钟数，超时自动中断；0 = 不限制

# 模型供应商（OpenAI 兼容）
# 填在这里即可，内置 Nexus Agent 与第三方 CLI 引擎（Hermes / OpenCode / Codex）共用：
#  - 启动时导入系统密钥库与 providers 表（设置页会显示为已配置）
#  - 第三方引擎启动时按各家约定注入环境变量（如 DeepSeek 注入 DEEPSEEK_API_KEY），
#    无需再去改各引擎自己的配置文件
# 导入成功后可把 apiKey 改为 "***"（占位符不会覆盖已存密钥），避免明文长期留在文件里。
provider:
  apiKey: ""           # 如 sk-xxxxxxxx
  baseUrl: ""          # 如 https://api.deepseek.com/v1
  model: ""            # 如 deepseek-chat
`;

let cached: UserConfig | null = null;
let cachedPath: string | null = null;

/** 配置目录：exe 同级 user/（打包）或项目根 user/（开发）；不可写回退 userData/user/ */
function resolveUserDir(): string {
  const base = app.isPackaged ? dirname(app.getPath('exe')) : app.getAppPath();
  const dir = join(base, 'user');
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return dir;
  } catch {
    const fallback = join(app.getPath('userData'), 'user');
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

export function userConfigPath(): string {
  if (!cachedPath) cachedPath = join(resolveUserDir(), 'config.yaml');
  return cachedPath;
}

/** 去除行内注释：'#' 前必须是空白（YAML 规则），带引号的值不受影响 */
function stripComment(line: string): string {
  const trimmed = line;
  const quote = trimmed.trimStart().match(/^[\w.-]+:\s*(["'])/)?.[1];
  if (quote) {
    // 值以引号开头：注释只能出现在闭合引号之后
    const start = trimmed.indexOf(quote, trimmed.indexOf(':') + 1);
    const end = trimmed.indexOf(quote, start + 1);
    if (end > start) return trimmed.slice(0, end + 1);
    return trimmed;
  }
  const idx = trimmed.search(/(^|\s)#/);
  return idx >= 0 ? trimmed.slice(0, idx) : trimmed;
}

function parseScalar(raw: string): unknown {
  const v = raw.trim();
  if (!v) return '';
  const quoted = v.match(/^"(.*)"$/s) ?? v.match(/^'(.*)'$/s);
  if (quoted) return quoted[1];
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/** YAML 子集解析：顶层 section + 两空格缩进的 key: value（满足本配置文件结构即可） */
export function parseSimpleYaml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let section: Record<string, unknown> | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine.replace(/\t/g, '  '));
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const m = line.trim().match(/^([\w.-]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    if (indent === 0) {
      if (rawVal.trim() === '') {
        section = {};
        root[key] = section;
      } else {
        root[key] = parseScalar(rawVal);
        section = null;
      }
    } else if (section) {
      section[key] = parseScalar(rawVal);
    }
  }
  return root;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v.trim() : fallback;
}

/** 解析结果 → 类型安全配置（非法值回退默认） */
export function mergeUserConfig(parsed: Record<string, unknown>): UserConfig {
  const d = USER_CONFIG_DEFAULTS;
  const wecom = (parsed.wecom ?? {}) as Record<string, unknown>;
  const engine = (parsed.engine ?? {}) as Record<string, unknown>;
  const task = (parsed.task ?? {}) as Record<string, unknown>;
  const provider = (parsed.provider ?? {}) as Record<string, unknown>;
  const mode = str(engine.executionMode, d.engine.executionMode);
  const maxRun = typeof task.maxRunMinutes === 'number' && task.maxRunMinutes >= 0 ? task.maxRunMinutes : d.task.maxRunMinutes;
  return {
    wecom: {
      botId: str(wecom.botId, ''),
      secret: str(wecom.secret, ''),
      webhookUrl: sanitizeWebhookUrl(str(wecom.webhookUrl, ''))
    },
    engine: {
      fallbackEngineId: str(engine.fallbackEngineId, d.engine.fallbackEngineId),
      executionMode: mode === 'production' ? 'production' : 'demo'
    },
    task: { maxRunMinutes: maxRun },
    provider: {
      apiKey: str(provider.apiKey, ''),
      baseUrl: sanitizeProviderBaseUrl(str(provider.baseUrl, '')),
      model: str(provider.model, '')
    }
  };
}

/**
 * 供应商接口地址校验：仅接受 http/https，并去掉尾部斜杠。
 * 允许 http 是因为本地模型服务（Ollama / LM Studio / vLLM）通常只提供 http。
 */
export function sanitizeProviderBaseUrl(value: string): string {
  if (!value) return '';
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/** webhook 地址校验：仅接受 https 的企微 webhook，防误配任意地址外发数据 */
export function sanitizeWebhookUrl(value: string): string {
  if (!value) return '';
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:') return '';
    return u.toString();
  } catch {
    return '';
  }
}

/** 读取配置（首次生成模板；解析失败回退默认值，不覆盖用户文件） */
export function loadUserConfig(force = false): UserConfig {
  if (cached && !force) return cached;
  const file = userConfigPath();
  if (!existsSync(file)) {
    try {
      writeFileSync(file, TEMPLATE, 'utf8');
    } catch {
      /* 只读环境下跳过生成，使用默认值 */
    }
    cached = { ...USER_CONFIG_DEFAULTS };
    return cached;
  }
  try {
    let raw = readFileSync(file, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // PowerShell 写 UTF-8 常带 BOM
    cached = mergeUserConfig(parseSimpleYaml(raw));
  } catch {
    cached = { ...USER_CONFIG_DEFAULTS };
  }
  return cached;
}
