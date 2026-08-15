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
import type { Agent, EngineProviderMode, EngineRuntimeConfig, ProviderProtocol } from '../../shared/types.js';
import type { Database } from './database.js';
import { getProviderSettings, readProviderKey } from './provider.js';
import { ProviderManager, type ResolvedProvider } from './providerManager.js';

interface ProviderResolver {
  resolveForAgent(providerId: string | null, modelOverride: string | null): ResolvedProvider | null;
}

/** 敏感环境变量名匹配规则：命中则走 safeStorage，不落 config_json */
export const SECRET_ENV_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

/** config_json 中替代敏感值的占位符（Renderer 只能看到它；回传该值表示沿用已存密钥） */
export const SECRET_PLACEHOLDER = '***';

const PROVIDER_PROTOCOLS = new Set<ProviderProtocol>([
  'openai-chat',
  'openai-responses',
  'anthropic-messages'
]);

const REQUIRED_PROVIDER_PROTOCOL: Readonly<Record<string, ProviderProtocol>> = {
  'eng-nexus': 'openai-chat',
  'eng-hermes-cli': 'openai-chat',
  'eng-pi': 'openai-chat',
  'eng-deepseek-harness': 'openai-chat',
  'eng-opencode': 'openai-chat',
  'eng-codex': 'openai-responses',
  'eng-claude': 'anthropic-messages'
};

/** Codex, Claude and OpenCode may use their own local login only when the
 * user has not requested an OPC-managed Provider binding. */
const NATIVE_AUTH_ENGINES = new Set(['eng-codex', 'eng-claude', 'eng-opencode']);
const MANAGED_PROVIDER_ENGINES = new Set([
  'eng-nexus',
  'eng-hermes-cli',
  'eng-pi',
  'eng-deepseek-harness'
]);

export function engineSupportsNativeAuth(engineId: string): boolean {
  return NATIVE_AUTH_ENGINES.has(engineId);
}

export function engineRequiresManagedProvider(engineId: string): boolean {
  return MANAGED_PROVIDER_ENGINES.has(engineId);
}

export function requiredProviderProtocol(engineId: string): ProviderProtocol | null {
  return REQUIRED_PROVIDER_PROTOCOL[engineId] ?? null;
}

/** Host variables required to launch a child process without leaking ambient
 * model credentials or unrelated application secrets into third-party CLIs. */
export const CHILD_PROCESS_HOST_ENV_ALLOWLIST = new Set([
  'ALL_PROXY', 'APPDATA', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
  'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432', 'COMSPEC', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
  'HTTP_PROXY', 'HTTPS_PROXY', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE',
  'LOCALAPPDATA', 'NODE_EXTRA_CA_CERTS', 'NO_PROXY', 'NUMBER_OF_PROCESSORS',
  'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'SHELL',
  'SSL_CERT_DIR', 'SSL_CERT_FILE', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TERM',
  'TMP', 'TMPDIR', 'TZ', 'USER', 'USERNAME', 'USERPROFILE', 'WINDIR',
  'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'
]);

export interface SensitiveTextRedactor {
  push(text: string): string;
  finish(): string;
}

/** 引擎敏感环境变量在 settings 表中的存储键 */
export function engineEnvSecretRef(engineId: string): string {
  return `secret:engine:${engineId}:env`;
}

/** Parse only renderer-safe runtime fields from an engine row. */
export function readEngineRuntimeConfig(db: Database, engineId: string): EngineRuntimeConfig | null {
  const row = db.raw.prepare('SELECT config_json FROM engines WHERE id = ?').get(engineId) as
    | { config_json?: string | null }
    | undefined;
  if (!row?.config_json) return null;
  let value: unknown;
  try { value = JSON.parse(row.config_json) as unknown; } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.protocol !== undefined
    && (typeof raw.protocol !== 'string' || !PROVIDER_PROTOCOLS.has(raw.protocol as ProviderProtocol))) {
    throw new Error(`Invalid Provider protocol in engine configuration: ${String(raw.protocol)}`);
  }
  if (raw.providerMode !== undefined && raw.providerMode !== 'native' && raw.providerMode !== 'managed') {
    throw new Error(`Invalid Provider mode in engine configuration: ${String(raw.providerMode)}`);
  }
  return {
    ...(Array.isArray(raw.runArgs) && raw.runArgs.every((arg) => typeof arg === 'string')
      ? { runArgs: raw.runArgs as string[] }
      : {}),
    ...(raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)
      ? { env: raw.env as Record<string, string> }
      : {}),
    ...(typeof raw.maxConcurrency === 'number' ? { maxConcurrency: raw.maxConcurrency } : {}),
    ...(typeof raw.providerMode === 'string' ? { providerMode: raw.providerMode as EngineProviderMode } : {}),
    ...(typeof raw.providerId === 'string' && raw.providerId.trim()
      ? { providerId: raw.providerId.trim() }
      : {}),
    ...(typeof raw.modelOverride === 'string' && raw.modelOverride.trim()
      ? { modelOverride: raw.modelOverride.trim() }
      : {}),
    ...(typeof raw.protocol === 'string' ? { protocol: raw.protocol as ProviderProtocol } : {})
  };
}

/**
 * Resolve employee binding -> engine binding -> application default Provider.
 * An explicit missing/invalid Provider fails closed and never substitutes a
 * different credential domain. Legacy settings are used only when the
 * providers table is genuinely empty.
 */
export function resolveEngineProvider(
  db: Database,
  engineId: string,
  agent?: Pick<Agent, 'id' | 'modelOverride'> | null,
  manager: ProviderResolver = new ProviderManager(db)
): ResolvedProvider | null {
  const engine = readEngineRuntimeConfig(db, engineId);
  const engineRow = db.raw.prepare('SELECT type FROM engines WHERE id = ?').get(engineId) as
    | { type?: string }
    | undefined;
  const customExternal = engineRow?.type === 'external' && engineId !== 'eng-deepseek-harness';
  const supportsNative = engineSupportsNativeAuth(engineId) || customExternal;
  let providerId = engine?.providerId ?? null;
  let modelOverride = agent?.modelOverride?.trim() || engine?.modelOverride || null;
  // A legacy model/protocol field is not credential-sharing consent for an
  // arbitrary executable. Custom ACP runtimes opt in only through an explicit
  // Provider id or the new providerMode=managed flag.
  const legacyManagedBinding = customExternal
    ? Boolean(engine?.providerId)
    : Boolean(engine?.providerId || engine?.modelOverride || engine?.protocol);
  const agentModelRequestsManaged = !customExternal && Boolean(agent?.modelOverride?.trim());
  let explicitManagedBinding = engine?.providerMode === 'managed'
    || legacyManagedBinding
    || agentModelRequestsManaged;
  let agentManagedBinding = agentModelRequestsManaged;

  if (agent) {
    const row = db.raw.prepare('SELECT provider_id, model_override FROM agents WHERE id = ?').get(agent.id) as
      | { provider_id?: string | null; model_override?: string | null }
      | undefined;
    if (row?.provider_id) {
      providerId = row.provider_id;
      explicitManagedBinding = true;
      agentManagedBinding = true;
    }
    if (!agent.modelOverride?.trim() && row?.model_override?.trim()) {
      modelOverride = row.model_override.trim();
      if (!customExternal) {
        explicitManagedBinding = true;
        agentManagedBinding = true;
      }
    }
  }

  const required = requiredProviderProtocol(engineId);
  if (engine?.providerMode === 'native' && !supportsNative) {
    throw new Error(`${engineId} does not support native Provider authentication`);
  }
  const useNative = supportsNative
    && !agentManagedBinding
    && (engine?.providerMode === 'native'
      || (engine?.providerMode === undefined && !legacyManagedBinding));
  if (useNative) return null;
  // Unknown/custom runtimes never receive the application default credential
  // merely because they were registered. They must opt in through an engine
  // or employee Provider binding first.
  if (!engineRequiresManagedProvider(engineId) && !explicitManagedBinding) return null;

  const protocol = engine?.protocol ?? required ?? 'openai-chat';
  if (required && protocol !== required) {
    throw new Error(`${engineId} requires ${required}; configured Provider protocol is ${protocol}`);
  }

  const resolved = manager.resolveForAgent(providerId, modelOverride);
  if (resolved) return resolved;
  if (providerId) throw new Error(`Configured model Provider is unavailable: ${providerId}`);

  const count = (db.raw.prepare('SELECT COUNT(*) c FROM providers').get() as { c?: number } | undefined)?.c ?? 0;
  if (count > 0) {
    if (explicitManagedBinding) throw new Error('Configured model Provider is incomplete or has no usable credential');
    return null;
  }
  const legacy = getProviderSettings(db);
  const key = readProviderKey(db)?.trim() || '';
  const baseUrl = legacy.baseUrl.trim().replace(/\/+$/, '');
  const model = (modelOverride || legacy.model).trim();
  if (baseUrl && model && key) return { baseUrl, model, key };
  if (explicitManagedBinding) throw new Error('Configured model Provider is incomplete or has no usable credential');
  return null;
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
export function resolveConfiguredEngineEnv(db: Database, engineId: string): Record<string, string> {
  const env: Record<string, string> = {};
  const declaredSecretKeys: string[] = [];
  const row = db.raw.prepare('SELECT config_json FROM engines WHERE id = ?').get(engineId) as
    | { config_json?: string }
    | undefined;
  if (row?.config_json) {
    try {
      const parsed = JSON.parse(row.config_json) as { env?: Record<string, string> };
      for (const [k, v] of Object.entries(parsed.env ?? {})) {
        if (v === SECRET_PLACEHOLDER) declaredSecretKeys.push(k);
        else env[k] = v;
      }
    } catch {
      /* config_json 损坏时视为无自定义变量 */
    }
  }

  if (declaredSecretKeys.length === 0) return env;
  const b64 = db.getSetting<string>(engineEnvSecretRef(engineId), '');
  if (!b64 || !safeStorage.isEncryptionAvailable()) {
    throw new Error(`Configured engine credential is unavailable: ${declaredSecretKeys.join(', ')}`);
  }
  let secrets: Record<string, unknown>;
  try {
    secrets = JSON.parse(safeStorage.decryptString(Buffer.from(b64, 'base64'))) as Record<string, unknown>;
  } catch {
    throw new Error(`Configured engine credential cannot be decrypted: ${declaredSecretKeys.join(', ')}`);
  }
  for (const key of declaredSecretKeys) {
    const value = secrets[key];
    if (typeof value !== 'string' || !value) {
      throw new Error(`Configured engine credential is unavailable: ${key}`);
    }
    env[key] = value;
  }

  return env;
}

export function resolveEngineEnv(
  db: Database,
  engineId: string,
  agent?: Pick<Agent, 'id' | 'modelOverride'> | null
): Record<string, string> {
  const env = resolveConfiguredEngineEnv(db, engineId);
  const provider = resolveEngineProvider(db, engineId, agent);
  if (provider) applyManagedProviderEnvironment(env, provider);
  return env;
}

/** Claude Code uses Anthropic-specific names even when pointed at a gateway. */
export function resolveClaudeEngineEnv(
  db: Database,
  engineId: string,
  agent?: Pick<Agent, 'id' | 'modelOverride'> | null
): Record<string, string> {
  const env = resolveConfiguredEngineEnv(db, engineId);
  const provider = resolveEngineProvider(db, engineId, agent);
  if (!provider) return env;
  clearManagedProviderEnvironment(env);
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_CUSTOM_HEADERS;
  const managed: Record<string, string> = {
    ANTHROPIC_API_KEY: provider.key,
    ANTHROPIC_BASE_URL: provider.baseUrl.replace(/\/+$/, ''),
    ANTHROPIC_MODEL: provider.model
  };
  for (const [key, value] of Object.entries(managed)) env[key] = value;
  return env;
}

/** Build a minimal process environment, then overlay only explicitly resolved
 * runtime values. Keys such as API_KEY/TOKEN from the host are never inherited. */
export function childProcessEnv(
  runtimeEnv: Record<string, string | undefined>,
  hostEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(hostEnv)) {
    if (value !== undefined && CHILD_PROCESS_HOST_ENV_ALLOWLIST.has(key.toUpperCase())) env[key] = value;
  }
  for (const [key, value] of Object.entries(runtimeEnv)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function sensitiveValues(env: Record<string, string | undefined>): string[] {
  return [...new Set(Object.entries(env)
    .filter(([key, value]) => SECRET_ENV_PATTERN.test(key) && typeof value === 'string' && value.length >= 4)
    .map(([, value]) => value as string))]
    .sort((a, b) => b.length - a.length);
}

/** Redact exact task-scoped credential values before output reaches logs, IPC,
 * task results, or error messages. */
export function redactSensitiveText(text: string, env: Record<string, string | undefined>): string {
  let redacted = text;
  for (const secret of sensitiveValues(env)) redacted = redacted.split(secret).join('[REDACTED]');
  return redacted;
}

/** Streaming variant that retains a short suffix, covering a secret split
 * across adjacent stdout chunks. */
export function createSensitiveTextRedactor(env: Record<string, string | undefined>): SensitiveTextRedactor {
  const secrets = sensitiveValues(env);
  if (secrets.length === 0) return { push: (text) => text, finish: () => '' };
  const holdChars = Math.max(...secrets.map((secret) => secret.length)) - 1;
  let pending = '';
  return {
    push(text) {
      const combined = pending + text;
      let split = Math.max(0, combined.length - holdChars);
      for (const secret of secrets) {
        let start = combined.indexOf(secret);
        while (start >= 0) {
          const end = start + secret.length;
          if (start < split && end > split) split = start;
          start = combined.indexOf(secret, start + 1);
        }
      }
      const ready = combined.slice(0, split);
      pending = combined.slice(split);
      return redactSensitiveText(ready, env);
    },
    finish() {
      const ready = redactSensitiveText(pending, env);
      pending = '';
      return ready;
    }
  };
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

function clearManagedProviderEnvironment(env: Record<string, string>): void {
  for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_BASE', 'OPENAI_MODEL']) {
    delete env[key];
  }
  for (const { vars } of PROVIDER_KEY_ALIASES) {
    for (const variable of vars) delete env[variable];
  }
}

function applyManagedProviderEnvironment(env: Record<string, string>, provider: ResolvedProvider): void {
  clearManagedProviderEnvironment(env);
  for (const [key, value] of Object.entries(providerEnvironment(provider))) env[key] = value;
}

/** Translate one already-resolved Provider into OpenAI-compatible CLI env. */
export function providerEnvironment(provider: ResolvedProvider): Record<string, string> {
  const baseUrl = provider.baseUrl.replace(/\/+$/, '');
  const env: Record<string, string> = {
    OPENAI_API_KEY: provider.key,
    OPENAI_BASE_URL: baseUrl,
    OPENAI_API_BASE: baseUrl,
    OPENAI_MODEL: provider.model
  };
  for (const { test, vars } of PROVIDER_KEY_ALIASES) {
    if (!test.test(baseUrl)) continue;
    for (const variable of vars) env[variable] = provider.key;
    break;
  }
  return env;
}

/**
 * OpenCode does not consume OPENAI_MODEL and may otherwise select a user's
 * global model. Build an isolated config that names the OPC provider/model
 * explicitly while keeping the credential as an environment reference.
 */
export function openCodeConfigContent(provider: ResolvedProvider): string {
  return JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: {
      opcnexus: {
        npm: '@ai-sdk/openai-compatible',
        name: 'OPC-Nexus',
        options: {
          baseURL: provider.baseUrl.replace(/\/+$/, ''),
          apiKey: '{env:OPENAI_API_KEY}'
        },
        models: {
          [provider.model]: { name: provider.model }
        }
      }
    },
    model: `opcnexus/${provider.model}`
  });
}

/** Resolve an OpenCode environment with an explicit, isolated model route. */
export function resolveOpenCodeEngineEnv(
  db: Database,
  engineId: string,
  agent?: Pick<Agent, 'id' | 'modelOverride'> | null
): Record<string, string> {
  const env = resolveEngineEnv(db, engineId, agent);
  const provider = resolveEngineProvider(db, engineId, agent);
  if (provider) {
    env.OPENCODE_CONFIG_CONTENT = openCodeConfigContent(provider);
  }
  return env;
}

/**
 * 把应用内配置的默认供应商翻译成第三方 CLI 认识的环境变量。
 *
 * 【为什么需要】Hermes / OpenCode / Codex 都读自己的配置或环境变量取模型凭据。
 * 用户在本应用配好了供应商（如 DeepSeek），第三方引擎却一无所知，
 * 于是启动成功但一调用就 401（实测 Hermes 报 "HTTP 401: Missing Authentication header"）。
 *
 * 注入两组变量：① 供应商专属名（Hermes 等按供应商取值的 CLI 需要）；
 * ② OpenAI 兼容名（多数 CLI 的通用约定）。受管模式下 URL、模型与密钥作为
 * 一个原子绑定覆盖旧环境；原生模式才保留运行时自行管理的 Provider 变量。
 *
 * 注：凭据只出现在子进程 env 中，不落盘、不进日志、不回传 Renderer。
 */
export function providerEnvFor(db: Database): Record<string, string> {
  const settings = getProviderSettings(db);
  const key = readProviderKey(db);
  if (!key || !settings.baseUrl) return {};
  return providerEnvironment({ baseUrl: settings.baseUrl, model: settings.model, key });
}
