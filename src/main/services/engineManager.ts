/**
 * 引擎中心（PRD 9.x）
 * 引擎目录：Nexus 与 Hermes 控制 Runtime，加上受管 Harness 和本机 Worker CLI
 *（Codex / Claude Code / Pi / OpenCode）。
 * 检测：where/which 定位可执行文件 + --version 取版本 → NOT_INSTALLED / HEALTHY，不做假安装。
 * 自动安装：存在官方 npm 包的引擎支持 npm -g 真实安装（下载地址取配置文件 npmRegistry）；
 * ZCode 为桌面应用无公开 npm 包，仅提供官方指引。
 * Nexus Agent 状态按供应商配置派生：已配置 = HEALTHY，未配置 = SETUP_REQUIRED（演示模式）。
 * 凭据：自定义环境变量中的敏感键经 engineEnv.ts 拆分加密，config_json 仅存占位符。
 *
 * @author liyingjie <y@senke.com>
 */
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { safeStorage } from 'electron';
import type { Database } from './database.js';
import { providerReady } from './provider.js';
import { loadConfig, sanitizeRegistry } from './config.js';
import { runCli } from './cliLauncher.js';
import { acpCommandFor, probeAcpEngine, probeAcpTask } from './executor/acpExecutor.js';
import {
  childProcessEnv,
  engineEnvSecretRef,
  redactSensitiveText,
  resolveConfiguredEngineEnv,
  resolveEngineEnv,
  splitSecretEnv,
  SECRET_PLACEHOLDER
} from './engineEnv.js';
import { appendProcessOutput, createProcessOutputBuffer, finishProcessOutput } from './textEncoding.js';
import { HermesRuntimeProfileService } from './hermesRuntimeProfile.js';
import { PI_ENGINE_ID, PiRuntimeProfileService } from './piRuntimeProfile.js';
import {
  buildPiAuthCheckArgs,
  buildPiProbeArgs,
  parsePiAuthCheck,
  parsePiProbeOutput,
  redactPiText
} from './executor/piAgentExecutor.js';
import {
  CLAUDE_ENGINE_ID,
  buildClaudeAuthCheckArgs,
  buildClaudeProbeArgs,
  parseClaudeAuthStatus,
  parseClaudeProbeOutput,
  redactClaudeText
} from './executor/cliExecutor.js';
import {
  DEEPSEEK_HARNESS_ENGINE_ID,
  DEEPSEEK_HARNESS_VERSION,
  deepseekHarnessCommand,
  deepseekHarnessProbeEnv,
  deepseekHarnessRuntimePaths
} from './deepseekHarnessRuntime.js';
import {
  harnessProviderFingerprint,
  harnessProviderVerificationIsCurrent,
  saveHarnessProviderFingerprint
} from './harnessProviderVerification.js';
import type { Engine, EngineHealthSignals, EngineInstallGuide, EngineInstallResult, EngineType } from '../../shared/types.js';

const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** 四级探活信号在 settings 中的存储键 */
function healthSignalsKey(engineId: string): string {
  return `engine:health:${engineId}`;
}

interface EngineRow {
  id: string;
  type: string;
  name: string;
  version: string | null;
  path: string | null;
  status: string;
  auth_status: string;
  is_default: number;
  data_boundary: string;
  config_json?: string | null;
}

/** 引擎目录：bin 可被配置文件 engines[id] 覆写；npm 包名固定为内置可信值 */
export interface CatalogEntry {
  id: string;
  type: EngineType;
  name: string;
  bin: string | null;         // null = 内置引擎，不做 CLI 检测
  npmPackage: string | null;  // null = 无公开 npm 包，不支持自动安装
  dataBoundary: string;
  guide: EngineInstallGuide;
}

/**
 * 引擎目录：Nexus Agent（内置自研 Runtime）/ DeepSeek Harness（受管 ACP sidecar）/
 * Hermes Agent（真实 CLI）/ Claude Code / OpenCode / Codex CLI。
 * ZCode / Kimi Code 已下线；Claude Code 以经过验证的无交互 Worker 重新接入。
 */
export const ENGINE_CATALOG: CatalogEntry[] = [
  {
    id: 'eng-hermes', type: 'hermes', name: 'Nexus Agent', bin: null, npmPackage: null,
    dataBoundary: '本地运行；模型请求发送至所配置模型提供商',
    guide: { guide: '内置引擎无需安装，在设置页完成模型供应商配置即可启用', url: null }
  },
  {
    id: DEEPSEEK_HARNESS_ENGINE_ID, type: 'external', name: 'DeepSeek Harness', bin: null, npmPackage: null,
    dataBoundary: 'Harness 与会话在本机 sidecar 运行；模型请求发送至所配置的 DeepSeek/OpenAI 兼容供应商',
    guide: { guide: 'DeepSeek Harness 随 OPC-Nexus 安装包分发；开发环境请运行 npm run harness:prepare', url: 'https://github.com/deepseek-ai/deepseek-harness' }
  },
  {
    id: 'eng-hermes-cli', type: 'hermes-cli', name: 'Hermes Agent', bin: 'hermes', npmPackage: null,
    dataBoundary: '本地 Hermes Agent Runtime；数据发送目标取决于 Hermes 自身配置',
    guide: { guide: '请按 Hermes Agent 官方方式安装 hermes CLI；如可执行名或运行参数不同，可在配置文件 engines["eng-hermes-cli"] 中覆写 bin/runArgs', url: null }
  },
  {
    id: PI_ENGINE_ID, type: 'pi', name: 'Pi Agent', bin: 'pi', npmPackage: '@earendil-works/pi-coding-agent',
    dataBoundary: 'Pi runs locally; model requests are sent to the provider configured in OPC-Nexus',
    guide: {
      guide: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent, then configure a model provider in OPC-Nexus',
      url: 'https://github.com/earendil-works/pi'
    }
  },
  {
    id: 'eng-opencode', type: 'opencode', name: 'OpenCode', bin: 'opencode', npmPackage: 'opencode-ai',
    dataBoundary: '数据发送目标取决于 OpenCode 内所配置的模型提供商',
    guide: { guide: 'npm install -g opencode-ai，安装后运行 opencode auth login 配置提供商', url: 'https://opencode.ai/docs' }
  },
  {
    id: 'eng-codex', type: 'codex', name: 'OpenAI Codex CLI', bin: 'codex', npmPackage: '@openai/codex',
    dataBoundary: '数据将发送至 OpenAI API',
    guide: { guide: 'npm install -g @openai/codex，安装后运行 codex 完成登录', url: 'https://github.com/openai/codex' }
  },
  {
    id: CLAUDE_ENGINE_ID, type: 'claude', name: 'Claude Code', bin: 'claude', npmPackage: '@anthropic-ai/claude-code',
    dataBoundary: 'Claude Code 在本机运行；提示词与必要文件内容发送至 Anthropic 或用户配置的企业模型提供商，会话保存在 Claude Code 本地数据目录',
    guide: { guide: 'npm install -g @anthropic-ai/claude-code，安装后运行 claude auth login 完成登录', url: 'https://docs.anthropic.com/en/docs/claude-code' }
  }
];

/** 已下线引擎：v26 迁移把绑定它们的员工改绑 Nexus，并从 engines 表清理 */
export const RETIRED_ENGINE_IDS = ['eng-zcode', 'eng-kimi'] as const;

interface ExternalAcpEntry {
  id: string;
  name: string;
  command: string[] | null;
}

const SENSITIVE_ARGUMENT_NAME_PATTERN =
  /(?:apikey|token|secret|secretkey|password|passwd|passphrase|credentials?|privatekey|accesskey|clientkey|consumerkey|signingkey|licensekey|authorization|bearer)$/;

function argumentName(arg: string): string | null {
  const value = arg.trim().replace(/^["']/, '');
  const option = value.match(/^-{1,2}([^=:\s]+)/)
    ?? value.match(/^\/([^/\\=:\s]+)(?:[=:\s]|$)/);
  const assignment = value.match(/^([A-Za-z_][A-Za-z0-9_.-]*)\s*=/);
  const name = option?.[1] ?? assignment?.[1];
  return name ? name.toLowerCase().replace(/[^a-z0-9]/g, '') : null;
}

function containsCredentialArgument(arg: string): boolean {
  const header = arg.match(/(?:^|[=\s])["']?([A-Za-z_][A-Za-z0-9_.-]*)\s*:/);
  if (header) {
    const headerName = header[1].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (SENSITIVE_ARGUMENT_NAME_PATTERN.test(headerName)) return true;
  }
  if (/^\s*["']?bearer\s+\S+/i.test(arg)) return true;
  const name = argumentName(arg);
  return name !== null && SENSITIVE_ARGUMENT_NAME_PATTERN.test(name);
}

function assertSafeEngineArguments(value: unknown, field: string): asserts value is string[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((arg) => typeof arg !== 'string')) {
    throw new Error(`Invalid ${field}: expected a string array`);
  }
  if (value.some(containsCredentialArgument)) {
    throw new Error(
      `Credential-bearing ${field} are not allowed; configure secrets through encrypted environment variables`
    );
  }
}

function assertSafePersistedEngineConfig(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const config = value as Record<string, unknown>;
  assertSafeEngineArguments(config.runArgs, 'runArgs');
  assertSafeEngineArguments(config.acpCommand, 'ACP arguments');
}

/** 旧配置文件中的 ACP 条目仅用于升级导入，运行时状态与命令以 SQLite 为准。 */
function legacyExternalAcpEntries(): { id: string; name: string; command: string[] }[] {
  const builtin = new Set(ENGINE_CATALOG.map((e) => e.id));
  const out: { id: string; name: string; command: string[] }[] = [];
  for (const [id, cfg] of Object.entries(loadConfig().engines)) {
    if (builtin.has(id)) continue;
    if (Array.isArray(cfg.acpCommand) && cfg.acpCommand.length > 0) {
      out.push({ id, name: cfg.name || id, command: cfg.acpCommand });
    }
  }
  return out;
}

/** 从 SQLite 枚举外部 ACP 引擎；命令解析会兼容旧 path/runArgs 和旧应用配置。 */
function externalAcpEntries(db: Database): ExternalAcpEntry[] {
  const builtin = new Set(ENGINE_CATALOG.map((e) => e.id));
  const rows = db.raw.prepare(
    "SELECT id, type, name, path, config_json, data_boundary FROM engines WHERE type = 'external'"
  ).all() as unknown as EngineRow[];
  return rows
    .filter((row) => row.type === 'external' && !builtin.has(row.id))
    .map((row) => ({ id: row.id, name: row.name, command: acpCommandFor(db, row.id) }));
}

/** 配置覆写后的可执行名；npm 包固定取可信内置目录值。 */
function effective(entry: CatalogEntry): { bin: string | null; npmPackage: string | null } {
  const override = loadConfig().engines[entry.id] ?? {};
  const bin = override.bin && /^[\w.-]+$/.test(override.bin) ? override.bin : entry.bin;
  return { bin, npmPackage: entry.npmPackage };
}

export class EngineManager {
  /** 正在安装的引擎（防重复触发） */
  private installing = new Set<string>();

  constructor(private db: Database) {}

  /** Provider mutations invalidate the real-task proof until a new probe succeeds. */
  invalidateHarnessProviderVerification(): void {
    const configured = providerReady(this.db);
    const commandAvailable = deepseekHarnessCommand() !== null;
    const previousSignals = this.getHealthSignals(DEEPSEEK_HARNESS_ENGINE_ID);
    this.db.raw.prepare('UPDATE engines SET status = ?, auth_status = ? WHERE id = ?').run(
      commandAvailable ? (configured ? 'AUTH_REQUIRED' : 'SETUP_REQUIRED') : 'NOT_INSTALLED',
      'required',
      DEEPSEEK_HARNESS_ENGINE_ID
    );
    this.saveHealthSignals(DEEPSEEK_HARNESS_ENGINE_ID, {
      detected: commandAvailable,
      launchable: commandAvailable && previousSignals?.launchable === true,
      authenticated: false,
      taskVerified: false,
      detail: configured
        ? '模型供应商配置已变化；请重新运行“验证登录”完成真实模型任务探测'
        : '请先配置可用的模型供应商和 API Key'
    });
    saveHarnessProviderFingerprint(this.db, null);
  }

  /** 目录中的引擎逐个补齐；旧配置文件里的 ACP 条目只在数据库尚无该 ID 时导入。 */
  ensureBuiltinEngines() {
    const stmt = this.db.raw.prepare(
      `INSERT INTO engines(id, type, name, version, path, status, auth_status, is_default, data_boundary)
       VALUES(?, ?, ?, NULL, NULL, ?, 'required', ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, data_boundary = excluded.data_boundary`
    );
    for (const e of ENGINE_CATALOG) {
      const initial = e.id === 'eng-hermes' ? 'SETUP_REQUIRED' : 'NOT_INSTALLED';
      stmt.run(e.id, e.type, e.name, initial, e.id === 'eng-hermes' ? 1 : 0, e.dataBoundary);
    }

    const legacyStmt = this.db.raw.prepare(
      `INSERT INTO engines(id, type, name, version, path, status, auth_status, is_default, data_boundary, config_json)
       VALUES(?, 'external', ?, NULL, ?, 'NOT_INSTALLED', 'unknown', 0, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    );
    for (const ext of legacyExternalAcpEntries()) {
      try {
        assertSafeEngineArguments(ext.command, 'ACP arguments');
      } catch {
        this.db.audit({
          id: randomUUID(),
          actor: 'system',
          action: 'engine.legacyConfig',
          target: ext.id,
          result: 'rejected: credential argument'
        });
        continue;
      }
      legacyStmt.run(
        ext.id,
        ext.name,
        ext.command[0],
        '外部 ACP 引擎；数据发送目标取决于该引擎自身配置',
        JSON.stringify({ acpCommand: ext.command })
      );
    }
  }

  list(): Engine[] {
    const rows = this.db.raw.prepare('SELECT * FROM engines ORDER BY is_default DESC, name').all() as unknown as EngineRow[];
    const runCounts = this.db.raw.prepare(
      `SELECT COALESCE(ar.resolved_engine_id, ar.requested_engine_id, a.engine_id) engine_id, COUNT(*) c
       FROM agent_runs ar JOIN agents a ON a.id = ar.agent_id
       WHERE ar.ended_at IS NULL
       GROUP BY COALESCE(ar.resolved_engine_id, ar.requested_engine_id, a.engine_id)`
    ).all() as { engine_id: string; c: number }[];
    const perEngine = new Map<string, number>();
    for (const r of runCounts) {
      if (r.engine_id) perEngine.set(r.engine_id, (perEngine.get(r.engine_id) ?? 0) + r.c);
    }
    return rows.map((r) => {
      const entry = ENGINE_CATALOG.find((e) => e.id === r.id);
      return {
        id: r.id,
        type: r.type as EngineType,
        name: r.name,
        version: r.version,
        path: r.path,
        status: r.status as Engine['status'],
        authStatus: r.auth_status as Engine['authStatus'],
        isDefault: r.is_default === 1,
        runningInstances: perEngine.get(r.id) ?? 0,
        dataBoundary: r.data_boundary,
        installable: !!(entry && effective(entry).npmPackage),
        healthSignals: this.getHealthSignals(r.id)
      };
    });
  }

  /** 官方安装指引（无法自动安装或安装失败时展示） */
  installGuide(id: string): EngineInstallGuide | null {
    const builtin = ENGINE_CATALOG.find((e) => e.id === id)?.guide;
    if (builtin) return builtin;
    if (externalAcpEntries(this.db).some((e) => e.id === id)) {
      return { guide: '外部 ACP 引擎：请按该引擎官方方式安装，确保已注册的 acpCommand 可执行后点击重新检测', url: null };
    }
    return null;
  }

  /** 至少一个可用执行器（PRD：系统正常运行的最低条件）：任一 CLI 健康 或 Hermes 供应商已配置 */
  hasUsableExecutor(): boolean {
    const healthy = (this.db.raw
      .prepare("SELECT COUNT(*) c FROM engines WHERE status = 'HEALTHY' AND id != 'eng-hermes'")
      .get() as { c: number }).c;
    return healthy > 0 || providerReady(this.db);
  }

  /**
   * 真实检测：where/which 定位 CLI + --version 验证可启动。
   *
   * 【状态语义（发布要求）】检测只能证明「找到了入口且进程能起来」，
   * 不能证明「凭据有效、能完成任务」。因此：
   *   定位失败            → NOT_INSTALLED
   *   定位到但起不来      → ERROR（Windows 上 npm shim / Store 应用即属此类）
   *   能起来但未验证任务  → AUTH_REQUIRED（提示用户点「验证登录」跑最小任务）
   *   四级探活全通过      → HEALTHY（仅由 probeAuth 写入）
   * 已 HEALTHY 的引擎重新检测时保留 HEALTHY，避免把验证过的引擎打回未验证。
   */
  async detect(): Promise<Engine[]> {
    this.ensureBuiltinEngines(); // 兼容导入旧配置后，外部引擎统一从数据库发现
    const harnessCommand = deepseekHarnessCommand();
    if (!harnessCommand) {
      this.db.raw.prepare("UPDATE engines SET status = 'NOT_INSTALLED', version = NULL, path = NULL WHERE id = ?")
        .run(DEEPSEEK_HARNESS_ENGINE_ID);
      this.db.setSetting(healthSignalsKey(DEEPSEEK_HARNESS_ENGINE_ID), {
        detected: false, launchable: false, authenticated: false, taskVerified: false,
        detail: '未找到已准备的 DeepSeek Harness sidecar；开发环境请运行 npm run harness:prepare', checkedAt: Date.now()
      });
      saveHarnessProviderFingerprint(this.db, null);
    } else {
      const probe = await probeAcpEngine(
        harnessCommand,
        deepseekHarnessProbeEnv(this.db),
        { managedHarness: true }
      );
      const configured = providerReady(this.db);
      const previous = this.db.raw.prepare('SELECT status FROM engines WHERE id = ?')
        .get(DEEPSEEK_HARNESS_ENGINE_ID) as { status: string } | undefined;
      const alreadyVerified = previous?.status === 'HEALTHY'
        && this.getHealthSignals(DEEPSEEK_HARNESS_ENGINE_ID)?.taskVerified === true
        && harnessProviderVerificationIsCurrent(this.db);
      const status = probe.ok
        ? (configured ? (alreadyVerified ? 'HEALTHY' : 'AUTH_REQUIRED') : 'SETUP_REQUIRED')
        : 'ERROR';
      this.db.raw.prepare('UPDATE engines SET status = ?, auth_status = ?, version = ?, path = ? WHERE id = ?').run(
        status,
        status === 'HEALTHY' ? 'authed' : 'required',
        probe.ok ? DEEPSEEK_HARNESS_VERSION : null,
        deepseekHarnessRuntimePaths().root,
        DEEPSEEK_HARNESS_ENGINE_ID
      );
      if (!alreadyVerified || status !== 'HEALTHY') {
        this.db.setSetting(healthSignalsKey(DEEPSEEK_HARNESS_ENGINE_ID), {
          detected: true,
          launchable: probe.ok,
          authenticated: false,
          taskVerified: false,
          detail: probe.ok
            ? (configured ? 'Harness 可启动；请运行“验证登录”完成真实模型任务探测' : 'Harness 可启动；请先配置模型供应商凭据')
            : `ACP 握手失败：${probe.message}`,
          checkedAt: Date.now()
        });
        saveHarnessProviderFingerprint(this.db, null);
      }
    }
    for (const entry of ENGINE_CATALOG) {
      if (entry.id === DEEPSEEK_HARNESS_ENGINE_ID) continue;
      if (!entry.bin) continue;
      if (this.installing.has(entry.id)) continue; // 安装中不覆盖 INSTALLING 状态
      const { bin } = effective(entry);
      const found = bin ? await locateBin(bin) : null;
      if (!found) {
        this.db.raw.prepare("UPDATE engines SET status = 'NOT_INSTALLED', version = NULL, path = NULL WHERE id = ?").run(entry.id);
        this.db.setSetting(healthSignalsKey(entry.id), {
          detected: false, launchable: false, authenticated: false, taskVerified: false,
          detail: `未在 PATH 中找到 ${bin}`, checkedAt: Date.now()
        });
        continue;
      }

      // 用 --version 验证「真能启动」：Windows 上 npm 无扩展名 shim（ENOENT）、
      // .cmd（EINVAL）、Store 应用（EPERM）都会在此暴露，而非等到派发任务才失败。
      const launchEnv = childProcessEnv({});
      const ver = await runCli(found, ['--version'], {
        timeoutMs: cliLaunchProbeTimeoutMs(entry.id, launchEnv),
        env: launchEnv
      });
      const version = (ver.stdout || ver.stderr || '').trim().split(/\r?\n/)[0]?.slice(0, 80) || null;
      const launchable = !(ver.error && !ver.stdout && !ver.stderr);

      if (!launchable) {
        this.db.raw.prepare("UPDATE engines SET status = 'ERROR', version = NULL, path = ? WHERE id = ?").run(found, entry.id);
        this.db.setSetting(healthSignalsKey(entry.id), {
          detected: true, launchable: false, authenticated: false, taskVerified: false,
          detail: `无法启动：${ver.error ?? '未知原因'}`, checkedAt: Date.now()
        });
        this.addLog(entry.id, 'error', `检测到 ${found} 但无法启动：${ver.error ?? '未知原因'}`);
        continue;
      }

      // 可启动但未跑最小任务：保守标 AUTH_REQUIRED，等用户点「验证登录」做四级探活。
      // 已经四级通过的引擎不回退状态。
      const prev = this.db.raw.prepare('SELECT status FROM engines WHERE id = ?').get(entry.id) as { status: string } | undefined;
      const verified = this.getHealthSignals(entry.id)?.taskVerified === true;
      const nextStatus = prev?.status === 'HEALTHY' && verified ? 'HEALTHY' : 'AUTH_REQUIRED';
      this.db.raw.prepare('UPDATE engines SET status = ?, version = ?, path = ? WHERE id = ?')
        .run(nextStatus, version ?? 'unknown', found, entry.id);
      if (nextStatus !== 'HEALTHY') {
        this.db.setSetting(healthSignalsKey(entry.id), {
          detected: true, launchable: true, authenticated: false, taskVerified: false,
          detail: '已确认可启动；请点「验证登录」跑最小任务以确认凭据与产出', checkedAt: Date.now()
        });
      }
    }
    // 外部 ACP 引擎：握手只证明可启动，不能证明凭据或真实任务可用。
    for (const ext of externalAcpEntries(this.db)) {
      if (!ext.command) {
        this.db.raw.prepare("UPDATE engines SET status = 'NOT_INSTALLED' WHERE id = ?").run(ext.id);
        continue;
      }
      const probe = await probeAcpEngine(ext.command, resolveEngineEnv(this.db, ext.id));
      const previous = this.db.raw.prepare('SELECT status FROM engines WHERE id = ?').get(ext.id) as { status: string } | undefined;
      const alreadyVerified = previous?.status === 'HEALTHY' && this.getHealthSignals(ext.id)?.taskVerified === true;
      const status = probe.ok ? (alreadyVerified ? 'HEALTHY' : 'AUTH_REQUIRED') : 'NOT_INSTALLED';
      this.db.raw.prepare("UPDATE engines SET status = ?, version = ? WHERE id = ?")
        .run(status, probe.ok ? 'acp' : null, ext.id);
      if (!alreadyVerified || status !== 'HEALTHY') {
        this.db.setSetting(healthSignalsKey(ext.id), {
          detected: true, launchable: probe.ok, authenticated: false, taskVerified: false,
          detail: probe.ok ? 'ACP 握手通过；请运行“验证登录”完成真实任务探测' : probe.message,
          checkedAt: Date.now()
        });
      }
    }
    // Nexus Agent：供应商已配置 = HEALTHY；未配置 = SETUP_REQUIRED（演示模式，UI 必须标注）
    const nexusReady = providerReady(this.db);
    this.db.raw.prepare('UPDATE engines SET status = ?, auth_status = ? WHERE id = ?')
      .run(nexusReady ? 'HEALTHY' : 'SETUP_REQUIRED', nexusReady ? 'authed' : 'required', 'eng-hermes');
    return this.list();
  }

  /**
   * 自动安装：npm install -g <官方包> --registry <配置文件下载地址>
   * 安装来源固定为目录内官方包名，配置文件不可覆写（9.3 供应链基线）。
   * 完成后重新检测该引擎，如实回写 HEALTHY / NOT_INSTALLED。
   */
  async install(id: string): Promise<EngineInstallResult> {
    const entry = ENGINE_CATALOG.find((e) => e.id === id);
    if (!entry) return { ok: false, message: '未知引擎' };
    const { npmPackage } = effective(entry);
    if (!npmPackage) {
      return { ok: false, message: `${entry.name} 不支持自动安装：${entry.guide.guide}` };
    }
    if (this.installing.has(id)) return { ok: false, message: '该引擎正在安装中' };

    const registry = sanitizeRegistry(loadConfig().npmRegistry) ?? 'https://registry.npmmirror.com';
    this.installing.add(id);
    this.db.raw.prepare("UPDATE engines SET status = 'INSTALLING' WHERE id = ?").run(id);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'engine.install.start', target: `${npmPackage} @ ${registry}`, result: 'ok' });

    try {
      const r = await npmInstallGlobal(npmPackage, registry, id === PI_ENGINE_ID);
      if (!r.ok) {
        this.db.raw.prepare("UPDATE engines SET status = 'NOT_INSTALLED' WHERE id = ?").run(id);
        this.db.audit({ id: randomUUID(), actor: 'admin', action: 'engine.install', target: npmPackage, result: `failed: ${r.message.slice(0, 120)}` });
        return { ok: false, message: `安装失败：${r.message}\n可手工安装：${entry.guide.guide}` };
      }
    } finally {
      this.installing.delete(id);
    }

    await this.detect();
    const status = (this.db.raw.prepare('SELECT status FROM engines WHERE id = ?').get(id) as { status: string } | undefined)?.status;
    const ok = status === 'HEALTHY';
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'engine.install', target: npmPackage, result: ok ? 'ok' : 'installed-but-not-detected' });
    return ok
      ? { ok: true, message: `${entry.name} 安装成功，已可用于任务调度（首次使用请先完成登录授权）` }
      : { ok: false, message: '安装命令已完成，但未检测到可执行文件；请检查 npm 全局 bin 目录是否在 PATH 中后点击"重新检测"' };
  }

  /**
   * 引擎鉴权探测（H-4）：真实验证凭据可用性，不再点一下就标 HEALTHY。
   *
   * 原实现直接把 auth_status 改 authed、status 改 HEALTHY，用户以为已登录，
   * 实际首次派发任务才会失败 —— 健康状态不可信。
   *
   * 探测方式按引擎类型区分：
   * - 内置 Nexus：供应商配置是否齐备（baseUrl + model + 可解密 Key）
   * - CLI 引擎：定位二进制 + 跑一次最小 headless 提示词，能拿到输出才算真的可用；
   *   鉴权类错误（401/unauthorized/login 等）如实标记 AUTH_REQUIRED
   */
  async probeAuth(id: string): Promise<EngineInstallResult> {
    const entry = ENGINE_CATALOG.find((e) => e.id === id);
    if (!entry) {
      const ext = externalAcpEntries(this.db).find((candidate) => candidate.id === id);
      if (!ext) return { ok: false, message: '未知引擎' };
      if (!ext.command) {
        this.db.raw.prepare("UPDATE engines SET status = 'NOT_INSTALLED', auth_status = 'unknown' WHERE id = ?").run(id);
        return { ok: false, message: '引擎命令未配置' };
      }

      const probe = await probeAcpTask(ext.command, resolveEngineEnv(this.db, id));
      const status = probe.ok ? 'HEALTHY' : (AUTH_ERROR_PATTERN.test(probe.message) ? 'AUTH_REQUIRED' : 'DEGRADED');
      const authStatus = probe.ok ? 'authed' : (status === 'AUTH_REQUIRED' ? 'required' : 'unknown');
      this.db.raw.prepare('UPDATE engines SET status = ?, auth_status = ? WHERE id = ?')
        .run(status, authStatus, id);
      this.saveHealthSignals(id, {
        detected: true,
        launchable: probe.initialized,
        authenticated: probe.ok,
        taskVerified: probe.ok,
        detail: probe.ok ? probe.output.slice(0, 200) : probe.message
      });
      this.db.audit({
        id: randomUUID(), actor: 'admin', action: 'engine.auth', target: id,
        result: probe.ok ? 'authed' : probe.message.slice(0, 80)
      });
      this.addLog(id, probe.ok ? 'info' : 'warn', `ACP 最小任务探测：${probe.message}`);
      return probe;
    }

    if (id === DEEPSEEK_HARNESS_ENGINE_ID) {
      const command = deepseekHarnessCommand();
      if (!command) return { ok: false, message: 'DeepSeek Harness sidecar 未准备，请先运行 harness:prepare 或重新安装应用' };
      if (!providerReady(this.db)) {
        this.db.raw.prepare("UPDATE engines SET status = 'SETUP_REQUIRED', auth_status = 'required' WHERE id = ?").run(id);
        this.saveHealthSignals(id, {
          detected: true, launchable: true, authenticated: false, taskVerified: false,
          detail: '请先配置可用的模型供应商和 API Key'
        });
        saveHarnessProviderFingerprint(this.db, null);
        return { ok: false, message: '请先配置可用的模型供应商和 API Key' };
      }
      const providerFingerprint = harnessProviderFingerprint(this.db);
      const probe = await probeAcpTask(
        command,
        deepseekHarnessProbeEnv(this.db),
        deepseekHarnessRuntimePaths().root,
        60_000,
        { managedHarness: true }
      );
      const providerUnchanged = providerFingerprint === harnessProviderFingerprint(this.db);
      const verified = probe.ok && providerUnchanged;
      const probeMessage = providerUnchanged
        ? probe.message
        : '模型供应商配置在验证过程中发生变化，请重新验证';
      const status = verified
        ? 'HEALTHY'
        : (!providerUnchanged || AUTH_ERROR_PATTERN.test(probeMessage) ? 'AUTH_REQUIRED' : 'DEGRADED');
      const authStatus = verified ? 'authed' : (status === 'AUTH_REQUIRED' ? 'required' : 'unknown');
      this.db.raw.prepare('UPDATE engines SET status = ?, auth_status = ? WHERE id = ?')
        .run(status, authStatus, id);
      this.saveHealthSignals(id, {
        detected: true,
        launchable: probe.initialized,
        authenticated: verified,
        taskVerified: verified,
        detail: verified ? probe.output.slice(0, 200) : probeMessage
      });
      saveHarnessProviderFingerprint(this.db, verified ? providerFingerprint : null);
      this.db.audit({
        id: randomUUID(), actor: 'admin', action: 'engine.auth', target: id,
        result: verified ? 'authed-and-task-verified' : probeMessage.slice(0, 80)
      });
      this.addLog(id, verified ? 'info' : 'warn', `Harness 最小任务探测：${probeMessage}`);
      return { ok: verified, message: verified ? 'DeepSeek Harness 已完成真实模型任务验证' : `DeepSeek Harness 最小任务失败：${probeMessage}` };
    }

    // 内置 Nexus：凭据即供应商配置
    if (entry.bin === null) {
      const ready = providerReady(this.db);
      this.db.raw.prepare("UPDATE engines SET status = ?, auth_status = ? WHERE id = ?")
        .run(ready ? 'HEALTHY' : 'SETUP_REQUIRED', ready ? 'authed' : 'required', id);
      this.db.audit({ id: randomUUID(), actor: 'admin', action: 'engine.auth', target: id, result: ready ? 'authed' : 'setup-required' });
      return ready
        ? { ok: true, message: `${entry.name} 供应商配置有效，引擎可用` }
        : { ok: false, message: `${entry.name} 未就绪：请先在设置页完成模型供应商配置` };
    }

    const { bin } = effective(entry);
    const found = bin ? await locateBin(bin) : null;
    if (!found) {
      this.db.raw.prepare("UPDATE engines SET status = 'NOT_INSTALLED', version = NULL, path = NULL WHERE id = ?").run(id);
      return { ok: false, message: `未检测到 ${entry.name} 可执行文件，请先完成安装` };
    }

    const probe = await probeCliAuth(id, found, this.db);
    this.db.raw.prepare('UPDATE engines SET status = ?, auth_status = ? WHERE id = ?')
      .run(probe.status, probe.authStatus, id);
    this.saveHealthSignals(id, probe.signals);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'engine.auth', target: id, result: probe.ok ? 'authed' : probe.message.slice(0, 80) });
    this.addLog(id, probe.ok ? 'info' : 'warn', `四级探活：${probe.message}`);
    return { ok: probe.ok, message: probe.message };
  }

  /** 四级探活信号存 settings（避免为诊断数据加 schema 迁移） */
  private saveHealthSignals(id: string, signals: EngineHealthSignals) {
    this.db.setSetting(healthSignalsKey(id), { ...signals, checkedAt: Date.now() });
  }

  /** 读取四级探活信号；未探活过返回 undefined */
  getHealthSignals(id: string): EngineHealthSignals | undefined {
    return this.db.getSetting<EngineHealthSignals | undefined>(healthSignalsKey(id), undefined);
  }

  /** Runtime 已经启动但 Provider 拒绝鉴权时，撤销之前的健康证明。
   * detail 必须由调用方先按该子进程环境完成脱敏。 */
  reportAuthenticationFailure(id: string, detail: string): void {
    const boundedDetail = detail.trim().slice(0, 2_000) || 'Provider authentication failed';
    let changed = false;
    this.db.transaction(() => {
      changed = this.db.raw.prepare(
        "UPDATE engines SET status = 'AUTH_REQUIRED', auth_status = 'required' WHERE id = ? AND status = 'HEALTHY'"
      ).run(id).changes === 1;
      if (!changed) return;
      const previous = this.getHealthSignals(id);
      this.saveHealthSignals(id, {
        detected: previous?.detected ?? true,
        launchable: true,
        authenticated: false,
        taskVerified: false,
        detail: boundedDetail
      });
      this.db.audit({
        id: randomUUID(), actor: 'system', action: 'engine.runtimeAuthFailure',
        target: id, result: 'AUTH_REQUIRED'
      });
    });
    if (changed) this.addLog(id, 'warn', `Runtime authentication failed: ${boundedDetail.slice(0, 500)}`);
  }

  setDefault(id: string) {
    this.db.transaction(() => {
      this.db.raw.prepare('UPDATE engines SET is_default = 0').run();
      this.db.raw.prepare('UPDATE engines SET is_default = 1 WHERE id = ?').run(id);
    });
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'engine.setDefault', target: id, result: 'ok' });
  }

  /** 引擎更新：npm update -g <pkg> */
  async update(id: string): Promise<EngineInstallResult> {
    const entry = ENGINE_CATALOG.find((e) => e.id === id);
    if (!entry) return { ok: false, message: '未知引擎' };
    const { npmPackage } = effective(entry);
    if (!npmPackage) return { ok: false, message: `${entry.name} 不支持自动更新` };
    const registry = sanitizeRegistry(loadConfig().npmRegistry) ?? 'https://registry.npmmirror.com';
    const r = await npmCommand(['update', '-g', npmPackage, '--registry', registry]);
    if (!r.ok) return { ok: false, message: `更新失败：${r.message}` };
    await this.detect();
    return { ok: true, message: `${entry.name} 已更新到最新版本` };
  }

  /** 引擎卸载：npm uninstall -g <pkg> */
  async uninstall(id: string): Promise<EngineInstallResult> {
    const entry = ENGINE_CATALOG.find((e) => e.id === id);
    if (!entry) return { ok: false, message: '未知引擎' };
    const { npmPackage } = effective(entry);
    if (!npmPackage) return { ok: false, message: `${entry.name} 不支持自动卸载` };
    const r = await npmCommand(['uninstall', '-g', npmPackage]);
    if (!r.ok) return { ok: false, message: `卸载失败：${r.message}` };
    this.db.raw.prepare("UPDATE engines SET status = 'NOT_INSTALLED', version = NULL, path = NULL WHERE id = ?").run(id);
    return { ok: true, message: `${entry.name} 已卸载` };
  }

  /** 重启引擎：重新检测指定引擎（Hermes 重新读取供应商配置，CLI 重新定位二进制 + 取版本）。
   *  用于修改配置后刷新引擎状态，无需重启整个应用。 */
  async restart(id: string): Promise<EngineInstallResult> {
    const entry = ENGINE_CATALOG.find((e) => e.id === id);
    if (id === DEEPSEEK_HARNESS_ENGINE_ID) {
      const command = deepseekHarnessCommand();
      if (!command) return { ok: false, message: 'DeepSeek Harness sidecar 未准备' };
      const probe = await probeAcpEngine(
        command,
        deepseekHarnessProbeEnv(this.db),
        { managedHarness: true }
      );
      const configured = providerReady(this.db);
      this.db.raw.prepare('UPDATE engines SET status = ?, auth_status = ?, version = ?, path = ? WHERE id = ?').run(
        probe.ok ? (configured ? 'AUTH_REQUIRED' : 'SETUP_REQUIRED') : 'ERROR',
        'required',
        probe.ok ? DEEPSEEK_HARNESS_VERSION : null,
        deepseekHarnessRuntimePaths().root,
        id
      );
      this.saveHealthSignals(id, {
        detected: true, launchable: probe.ok, authenticated: false, taskVerified: false,
        detail: probe.ok ? 'Harness 已重新加载；请运行“验证登录”完成真实模型任务探测' : probe.message
      });
      saveHarnessProviderFingerprint(this.db, null);
      return { ok: probe.ok, message: probe.ok ? 'DeepSeek Harness 已重新加载，请继续验证登录' : `DeepSeek Harness 连接失败：${probe.message}` };
    }
    if (id === 'eng-hermes') {
      // Nexus Agent：重新检测供应商配置是否就绪
      this.db.raw.prepare("UPDATE engines SET status = ? WHERE id = 'eng-hermes'").run(providerReady(this.db) ? 'HEALTHY' : 'SETUP_REQUIRED');
      const ready = providerReady(this.db);
      return { ok: ready, message: ready ? 'Nexus Agent 引擎已重新加载，供应商配置生效' : 'Nexus Agent 引擎未就绪：请先在设置页完成模型供应商配置' };
    }
    if (!entry) {
      // 外部 ACP 引擎
      const ext = externalAcpEntries(this.db).find((e) => e.id === id);
      if (!ext) return { ok: false, message: '未知引擎' };
      if (!ext.command) return { ok: false, message: '引擎命令未配置' };
      const probe = await probeAcpEngine(ext.command, resolveEngineEnv(this.db, id));
      this.db.raw.prepare('UPDATE engines SET status = ?, version = ? WHERE id = ?').run(probe.ok ? 'AUTH_REQUIRED' : 'NOT_INSTALLED', probe.ok ? 'acp' : null, id);
      this.db.audit({ id: randomUUID(), actor: 'admin', action: 'engine.restart', target: id, result: probe.ok ? 'ok' : probe.message.slice(0, 80) });
      return { ok: probe.ok, message: probe.ok ? `${ext.name} 重新连接成功` : `${ext.name} 连接失败，请检查引擎进程` };
    }
    // CLI 引擎：重新定位二进制 + 取版本
    const { bin } = effective(entry);
    if (!bin) return { ok: false, message: `${entry.name} 不支持重启操作` };
    const found = await locateBin(bin);
    if (!found) {
      this.db.raw.prepare("UPDATE engines SET status = 'NOT_INSTALLED', version = NULL, path = NULL WHERE id = ?").run(id);
      return { ok: false, message: `${entry.name} 未检测到可执行文件，请确认已安装并在 PATH 中` };
    }
    const version = await binVersion(found);
    this.db.raw.prepare("UPDATE engines SET status = 'HEALTHY', version = ?, path = ? WHERE id = ?").run(version ?? 'unknown', found, id);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'engine.restart', target: id, result: 'ok' });
    return { ok: true, message: `${entry.name} 已重新检测（v${version ?? 'unknown'}），配置已生效` };
  }

  /** 查询 npm registry 上的最新版本 */
  async latestVersion(id: string): Promise<string | null> {
    const entry = ENGINE_CATALOG.find((e) => e.id === id);
    if (!entry) return null;
    const { npmPackage } = effective(entry);
    if (!npmPackage) return null;
    try {
      const registry = sanitizeRegistry(loadConfig().npmRegistry) ?? 'https://registry.npmmirror.com';
      const res = await fetch(`${registry}/${npmPackage}/latest`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const data = await res.json() as { version?: string };
      return data.version ?? null;
    } catch { return null; }
  }

  /** 系统 Runtime 环境检测：Node.js / npm / Python / Git */
  async checkRuntime(): Promise<{ name: string; installed: boolean; version: string | null; path: string | null }[]> {
    const runtimes = [
      { name: 'Node.js', bin: 'node', args: ['--version'] },
      { name: 'npm', bin: 'npm', args: ['--version'] },
      { name: 'Python', bin: process.platform === 'win32' ? 'python' : 'python3', args: ['--version'] },
      { name: 'Git', bin: 'git', args: ['--version'] }
    ];
    const results: { name: string; installed: boolean; version: string | null; path: string | null }[] = [];
    for (const rt of runtimes) {
      const path = await locateBin(rt.bin);
      if (!path) {
        results.push({ name: rt.name, installed: false, version: null, path: null });
        continue;
      }
      const version = await new Promise<string | null>((resolve) => {
        execFile(path, rt.args, { shell: false, timeout: 8000 }, (_err, stdout, stderr) => {
          const out = (stdout || stderr || '').trim().split(/\r?\n/)[0]?.replace(/^v/, '') ?? null;
          resolve(out);
        });
      });
      results.push({ name: rt.name, installed: true, version, path });
    }
    return results;
  }

  /** 一键安装 Runtime（Windows: winget，Ubuntu: apt + 国内镜像源） */
  async installRuntime(name: string): Promise<{ ok: boolean; message: string }> {
    const isWin = process.platform === 'win32';
    const isLinux = process.platform === 'linux';
    let cmd: string, args: string[];

    if (name === 'Node.js') {
      if (isWin) {
        cmd = 'cmd.exe';
        args = ['/d', '/s', '/c', 'winget', 'install', 'OpenJS.NodeJS.LTS', '--accept-package-agreements', '--accept-source-agreements'];
      } else if (isLinux) {
        // Ubuntu: 使用 npmmirror 的 NodeSource 脚本安装 LTS
        cmd = '/bin/bash';
        args = ['-c', 'curl -fsSL https://npmmirror.com/mirrors/node/latest-v20.x/SHASUMS256.txt -o /dev/null && curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs'];
      } else {
        cmd = 'brew'; args = ['install', 'node'];
      }
    } else if (name === 'Python') {
      if (isWin) {
        cmd = 'cmd.exe';
        args = ['/d', '/s', '/c', 'winget', 'install', 'Python.Python.3.12', '--accept-package-agreements', '--accept-source-agreements'];
      } else if (isLinux) {
        // Ubuntu: apt 安装 + 清华镜像源 pip
        cmd = '/bin/bash';
        args = ['-c', 'sudo apt-get update && sudo apt-get install -y python3 python3-pip && pip3 config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple'];
      } else {
        cmd = 'brew'; args = ['install', 'python@3.12'];
      }
    } else if (name === 'npm') {
      return { ok: false, message: 'npm 随 Node.js 一起安装，请先安装 Node.js' };
    } else if (name === 'Git') {
      if (isWin) {
        cmd = 'cmd.exe';
        args = ['/d', '/s', '/c', 'winget', 'install', 'Git.Git', '--accept-package-agreements', '--accept-source-agreements'];
      } else if (isLinux) {
        cmd = '/bin/bash';
        args = ['-c', 'sudo apt-get update && sudo apt-get install -y git'];
      } else {
        cmd = 'brew'; args = ['install', 'git'];
      }
    } else {
      return { ok: false, message: `不支持自动安装 ${name}` };
    }

    return new Promise((resolve) => {
      try {
        const child = spawn(cmd, args, { shell: false, windowsHide: true });
        const stderrBuffer = createProcessOutputBuffer();
        child.stderr?.on('data', (c: Buffer) => appendProcessOutput(stderrBuffer, c));
        const timer = setTimeout(() => { child.kill(); resolve({ ok: false, message: '安装超时（5分钟）' }); }, 5 * 60_000);
        child.on('close', (code) => {
          clearTimeout(timer);
          const stderr = finishProcessOutput(stderrBuffer);
          resolve(code === 0 ? { ok: true, message: `${name} 安装成功，请重新检测` } : { ok: false, message: `安装失败（退出码 ${code}）：${stderr.slice(0, 200)}` });
        });
        child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, message: `无法启动安装程序：${err.message}` }); });
      } catch (err) {
        resolve({ ok: false, message: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  // ---------- 配置 / 日志 / 指标 / 自定义注册 ----------

  /**
   * 保存引擎运行配置。
   *
   * 【密钥处理】敏感环境变量（KEY/TOKEN/SECRET/PASSWORD 等）不写入 config_json，
   * 而是经 safeStorage 加密后存入 settings 表（key = secret:engine:{id}:env）。
   * config_json 中仅保留占位符，确保 Renderer 与日志都拿不到明文。
   * 与 providerManager 的密钥处理保持同一模式。
   */
  saveConfig(id: string, config: { runArgs?: string[]; env?: Record<string, string>; maxConcurrency?: number }) {
    assertSafeEngineArguments(config.runArgs, 'runArgs');
    assertSafeEngineArguments((config as Record<string, unknown>).acpCommand, 'ACP arguments');
    const { safe, secrets } = splitSecretEnv(config.env ?? {});
    const persisted = {
      runArgs: config.runArgs,
      env: safe,
      maxConcurrency: config.maxConcurrency
    };
    this.db.raw.prepare('UPDATE engines SET config_json = ? WHERE id = ?').run(JSON.stringify(persisted), id);

    const ref = engineEnvSecretRef(id);
    if (Object.keys(secrets).length > 0) {
      if (safeStorage.isEncryptionAvailable()) {
        this.db.setSetting(ref, safeStorage.encryptString(JSON.stringify(secrets)).toString('base64'));
        this.db.audit({ id: randomUUID(), actor: 'admin', action: 'engine.saveSecretEnv', target: id, result: `${Object.keys(secrets).length} keys` });
      } else {
        // 加密不可用时拒绝落盘，避免明文存储
        this.addLog(id, 'warn', '系统加密不可用，敏感环境变量未保存（请检查 OS 凭据服务）');
        this.db.audit({ id: randomUUID(), actor: 'admin', action: 'engine.saveSecretEnv', target: id, result: 'rejected: no encryption' });
      }
    } else if (!Object.values(safe).includes(SECRET_PLACEHOLDER)) {
      // 仅当本次配置完全不含敏感项时才清除；占位符表示「沿用已存密钥」
      this.db.raw.prepare('DELETE FROM settings WHERE key = ?').run(ref);
    }
    // 日志只记录非敏感部分，避免凭据进入 engine_logs
    this.addLog(
      id,
      'info',
      `Configuration updated: runArgs=${config.runArgs?.length ?? 0}, env=${Object.keys(safe).length}`
    );
  }

  /**
   * 获取引擎配置（供 Renderer 展示）。
   * 敏感环境变量以占位符形式返回，绝不返回明文。
   */
  getConfig(id: string): { runArgs?: string[]; env?: Record<string, string>; maxConcurrency?: number } | null {
    const row = this.db.raw.prepare('SELECT config_json FROM engines WHERE id = ?').get(id) as { config_json?: string } | undefined;
    if (!row?.config_json) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(row.config_json); } catch { return null; }
    assertSafePersistedEngineConfig(parsed);
    return parsed as { runArgs?: string[]; env?: Record<string, string>; maxConcurrency?: number };
  }

  /**
   * 解析引擎完整环境变量（含解密后的敏感项），**仅供主进程执行器 spawn 时使用**。
   * 禁止经 IPC 暴露给 Renderer。
   */
  resolveEnv(id: string): Record<string, string> {
    return resolveEngineEnv(this.db, id);
  }

  /** 添加引擎日志 */
  addLog(engineId: string, level: 'info' | 'warn' | 'error', message: string) {
    const id = `elog-${randomUUID().slice(0, 8)}`;
    this.db.raw.prepare('INSERT INTO engine_logs(id, engine_id, level, message, timestamp) VALUES(?,?,?,?,?)')
      .run(id, engineId, level, message, Date.now());
    // 保留最近 200 条
    this.db.raw.prepare('DELETE FROM engine_logs WHERE engine_id = ? AND id NOT IN (SELECT id FROM engine_logs WHERE engine_id = ? ORDER BY timestamp DESC LIMIT 200)')
      .run(engineId, engineId);
  }

  /** 获取引擎日志（最近 100 条） */
  getLogs(engineId: string): { id: string; engineId: string; level: string; message: string; timestamp: number }[] {
    return (this.db.raw.prepare('SELECT * FROM engine_logs WHERE engine_id = ? ORDER BY timestamp DESC LIMIT 100').all(engineId) as unknown as {
      id: string; engine_id: string; level: string; message: string; timestamp: number;
    }[]).map((r) => ({ id: r.id, engineId: r.engine_id, level: r.level, message: r.message, timestamp: r.timestamp }));
  }

  /** 获取引擎性能指标（从 agent_runs 统计） */
  getMetrics(engineId: string): { avgLatencyMs: number; successRate: number; totalRuns: number } {
    const runs = this.db.raw.prepare(
      `SELECT ar.started_at, ar.ended_at, t.status
       FROM agent_runs ar JOIN tasks t ON ar.task_id = t.id JOIN agents a ON ar.agent_id = a.id
       WHERE COALESCE(ar.resolved_engine_id, ar.requested_engine_id, a.engine_id) = ? AND ar.ended_at IS NOT NULL
       ORDER BY ar.ended_at DESC LIMIT 200`
    ).all(engineId) as { started_at: number; ended_at: number; status: string }[];
    if (runs.length === 0) return { avgLatencyMs: 0, successRate: 0, totalRuns: 0 };
    const totalMs = runs.reduce((sum, r) => sum + (r.ended_at - r.started_at), 0);
    const completed = runs.filter((r) => r.status === 'COMPLETED').length;
    return {
      avgLatencyMs: Math.round(totalMs / runs.length),
      successRate: Math.round((completed / runs.length) * 100),
      totalRuns: runs.length
    };
  }

  /** 注册自定义引擎 */
  registerCustom(input: { name: string; command: string; args?: string; dataBoundary?: string }): { ok: boolean; message: string; id?: string } {
    if (!input.name.trim() || !input.command.trim()) return { ok: false, message: '名称和命令不能为空' };
    const args = input.args?.split(/\s+/).filter(Boolean) ?? [];
    try {
      assertSafeEngineArguments(args, 'ACP arguments');
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Invalid ACP arguments' };
    }
    const id = `eng-custom-${randomUUID().slice(0, 6)}`;
    this.db.raw.prepare(
      `INSERT INTO engines(id, type, name, version, path, status, auth_status, is_default, data_boundary) VALUES(?, 'external', ?, NULL, ?, 'NOT_INSTALLED', 'unknown', 0, ?)`
    ).run(id, input.name.trim(), input.command.trim(), input.dataBoundary || '自定义引擎；数据发送目标取决于配置');
    // acpCommand 是外部引擎的完整可执行入口；path 保留给旧版本兼容读取。
    const command = input.command.trim();
    const config = { acpCommand: [command, ...args] };
    this.db.raw.prepare('UPDATE engines SET config_json = ? WHERE id = ?').run(JSON.stringify(config), id);
    this.addLog(id, 'info', `自定义引擎「${input.name}」已注册，命令: ${input.command}`);
    return { ok: true, message: `已注册自定义引擎「${input.name}」`, id };
  }
}

/** npm 全局安装（Windows 下 npm 为 .cmd，须经 cmd.exe /c 拉起；参数均已白名单校验，无注入面） */
function npmInstallGlobal(pkg: string, registry: string, ignoreScripts = false): Promise<{ ok: boolean; message: string }> {
  return npmCommand(['install', '-g', ...(ignoreScripts ? ['--ignore-scripts'] : []), pkg, '--registry', registry]);
}

/** 通用 npm 命令执行（install/update/uninstall） */
function npmCommand(npmArgs: string[]): Promise<{ ok: boolean; message: string }> {
  const isWin = process.platform === 'win32';
  const bin = isWin ? 'cmd.exe' : 'npm';
  const args = isWin ? ['/d', '/s', '/c', 'npm', ...npmArgs] : npmArgs;
  return new Promise((resolve) => {
    const stderrBuffer = createProcessOutputBuffer();
    let settled = false;
    const done = (ok: boolean, message: string) => {
      if (!settled) {
        settled = true;
        resolve({ ok, message });
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { shell: false, windowsHide: true, env: process.env });
    } catch (err) {
      done(false, err instanceof Error ? err.message : String(err));
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done(false, '安装超时（10 分钟），请检查网络或更换下载源');
    }, INSTALL_TIMEOUT_MS);
    child.stderr?.on('data', (c: Buffer) => appendProcessOutput(stderrBuffer, c));
    child.on('error', (err) => {
      clearTimeout(timer);
      done(false, `无法启动 npm：${err.message}（请确认已安装 Node.js 且 npm 在 PATH 中）`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) done(true, 'ok');
      else done(false, `npm 退出码 ${code ?? 'null'}：${(finishProcessOutput(stderrBuffer) || '无错误输出').slice(0, 400)}`);
    });
  });
}

/**
 * where（Windows）/ which（Linux）定位可执行文件。
 * Windows 上优先 .exe → .cmd → 其余（无扩展名 npm shim 排最后）：
 * .exe 可直接 spawn；.cmd 与无扩展名 shim 都需经 cmd.exe 拉起（见 cliLauncher），
 * 但 .cmd 语义明确，优先选它便于后续判定。
 */
function locateBin(bin: string): Promise<string | null> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    try {
      execFile(cmd, [bin], { shell: false, timeout: 10_000 }, (err, stdout) => {
        if (err) return resolve(null);
        const lines = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        if (lines.length === 0) return resolve(null);
        resolve(
          lines.find((l) => /\.exe$/i.test(l))
          ?? lines.find((l) => /\.cmd$/i.test(l))
          ?? lines[0]
        );
      });
    } catch { resolve(null); }
  });
}

/** --version 探测（10s 超时；部分 CLI 把版本写到 stderr；经 cliLauncher 兼容 .cmd/shim/Store 应用） */
async function binVersion(binPath: string): Promise<string | null> {
  const r = await runCli(binPath, ['--version'], { timeoutMs: 10_000 });
  const out = (r.stdout || r.stderr || '').trim().split(/\r?\n/)[0]?.slice(0, 80);
  return out || null;
}

/** 各 CLI 引擎的最小 headless 探测参数（跑一次真实请求，验证凭据而非仅验证二进制存在） */
const AUTH_PROBE_ARGS: Record<string, string[]> = {
  'eng-hermes-cli': ['-z', 'ping'],
  'eng-opencode': ['run', 'ping'],
  'eng-codex': ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', 'ping']
};

/** 鉴权失败特征：命中则判定为待登录，而非通用错误 */
const AUTH_ERROR_PATTERN = /401|403|unauthorized|forbidden|not\s*logged\s*in|login|auth|api[_\s-]?key|credential|token|鉴权|登录|未授权/i;

/** Some CLIs, including Hermes v0.19.0, can return exit code 0 while the
 * final response body is an upstream error. Do not promote that to HEALTHY. */
export const CLI_FAILURE_BODY_PATTERN = /HTTP\s+(?:400|401|403|408|409|422|429|5\d\d)\b|missing authentication header|no usable credentials|auth(?:entication)?[_\s-]?unavailable|invalid[_\s-]?(?:api[_\s-]?)?key|unauthorized|forbidden|rate limit|quota|billing|api call failed/i;

/** 参数/用法类错误特征：命中说明进程能起但调用方式不对（我方 bug，非用户凭据问题） */
const USAGE_ERROR_PATTERN = /unrecognized arguments|unknown (option|argument|flag)|invalid choice|did not contain any valid|usage:|no such option/i;

/** A newly-created Hermes profile may run config/plugin migrations on first use. */
export function cliLaunchProbeTimeoutMs(engineId: string, env: NodeJS.ProcessEnv): number {
  const managedProfile = (engineId === 'eng-hermes-cli' && Boolean(env.HERMES_HOME?.trim()))
    // Pi is exclusively integrated through an OPC-managed profile. Startup
    // detection runs before that profile is prepared, but needs the same cold
    // start allowance as the authenticated probe.
    || engineId === PI_ENGINE_ID;
  return managedProfile ? 45_000 : 15_000;
}

/**
 * CLI 引擎四级探活（发布要求）：把「健康」拆成可解释的独立信号，
 * 逐级递进，任一级失败即停在该级并如实回报，不再用单一 HEALTHY 掩盖。
 *
 *   detected      → 定位到可执行文件
 *   launchable    → 进程能真正启动（Windows 上 .cmd/npm shim/Store 应用各有坑）
 *   authenticated → 凭据有效（非 401/未登录）
 *   task_verified → 最小任务真的产出了结果
 *
 * 只有四级全通过才写 HEALTHY —— 此前只验证到 detected 就标 HEALTHY，
 * 导致引擎页显示健康但实际一跑就 ENOENT / EPERM / 参数错。
 */
export async function probeCliAuth(
  engineId: string,
  binPath: string,
  db: Database
): Promise<{ ok: boolean; status: string; authStatus: string; message: string; signals: EngineHealthSignals }> {
  const signals: EngineHealthSignals = {
    detected: true, // 调用方已 locateBin 成功
    launchable: false,
    authenticated: false,
    taskVerified: false,
    detail: ''
  };
  let hermesRuntime: ReturnType<HermesRuntimeProfileService['ensureProbe']> | null = null;
  let piRuntime: ReturnType<PiRuntimeProfileService['ensureProbe']> | null = null;
  if (engineId === 'eng-hermes-cli') {
    try {
      hermesRuntime = new HermesRuntimeProfileService(db).ensureProbe();
    } catch (error) {
      signals.launchable = true;
      signals.detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        status: 'AUTH_REQUIRED',
        authStatus: 'required',
        signals,
        message: `Hermes 需要 OPC-Nexus 模型供应商：${signals.detail}`
      };
    }
  }
  if (engineId === PI_ENGINE_ID) {
    try {
      piRuntime = new PiRuntimeProfileService(db).ensureProbe();
    } catch (error) {
      signals.launchable = true;
      signals.detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        status: 'AUTH_REQUIRED',
        authStatus: 'required',
        signals,
        message: `Pi requires an OPC-Nexus model provider: ${signals.detail}`
      };
    }
  }
  const engineEnv = engineId === CLAUDE_ENGINE_ID
    ? resolveConfiguredEngineEnv(db, engineId)
    : (hermesRuntime || piRuntime)
      ? {}
      : resolveEngineEnv(db, engineId);
  const env = childProcessEnv({ ...engineEnv, ...hermesRuntime?.env, ...piRuntime?.env });

  // 第 1 级：launchable —— 用 --version 验证进程真能起来（最轻量、不消耗额度）
  const ver = await runCli(binPath, ['--version'], { timeoutMs: cliLaunchProbeTimeoutMs(engineId, env), env });
  if (ver.error && !ver.stdout && !ver.stderr) {
    const safeError = redactSensitiveText(ver.error, env);
    signals.detail = `进程无法启动：${safeError}`;
    return {
      ok: false, status: 'ERROR', authStatus: 'unknown', signals,
      message: `已检测到可执行文件但无法启动：${safeError}。`
        + '（Windows 上 npm 无扩展名 shim、.cmd 批处理与 Microsoft Store 应用均需经 cmd.exe 拉起）'
    };
  }
  signals.launchable = true;

  if (piRuntime) {
    const auth = await runCli(binPath, buildPiAuthCheckArgs(piRuntime), { timeoutMs: 30_000, env });
    const parsed = parsePiAuthCheck(auth.stdout);
    if (!parsed.ready) {
      const rawDetail = auth.stderr || auth.stdout || auth.error || parsed.reason;
      const detail = redactPiText(rawDetail.trim().slice(0, 300), env);
      signals.detail = detail;
      const credentialsMissing = auth.code === 1 && /credential|auth|key|token/i.test(`${parsed.reason} ${detail}`);
      return {
        ok: false,
        status: credentialsMissing ? 'AUTH_REQUIRED' : 'DEGRADED',
        authStatus: credentialsMissing ? 'required' : 'unknown',
        signals,
        message: `Pi auth check failed: ${detail}`
      };
    }
    signals.authenticated = true;
  }

  if (engineId === CLAUDE_ENGINE_ID) {
    const auth = await runCli(binPath, buildClaudeAuthCheckArgs(), { timeoutMs: 15_000, env });
    const parsed = parseClaudeAuthStatus(auth.stdout);
    if (auth.code !== 0 || !parsed.loggedIn) {
      const commandDetail = auth.stderr || auth.stdout || auth.error || '';
      const rawDetail = USAGE_ERROR_PATTERN.test(commandDetail) ? commandDetail : parsed.detail;
      const detail = redactClaudeText(rawDetail.trim().slice(0, 300), env);
      signals.detail = detail || parsed.detail;
      const usageFailure = USAGE_ERROR_PATTERN.test(signals.detail);
      return {
        ok: false,
        status: usageFailure ? 'DEGRADED' : 'AUTH_REQUIRED',
        authStatus: usageFailure ? 'unknown' : 'required',
        signals,
        message: usageFailure
          ? `Claude Code auth probe is incompatible with this CLI version: ${signals.detail}`
          : `Claude Code needs login: ${signals.detail}`
      };
    }
  }

  // 第 2、3 级：跑最小任务，同时验证凭据与产出
  const args = hermesRuntime
    ? ['-z', 'ping', '-m', hermesRuntime.model, '--provider', hermesRuntime.provider]
    : piRuntime
      ? buildPiProbeArgs(piRuntime)
      : engineId === CLAUDE_ENGINE_ID
        ? buildClaudeProbeArgs()
        : AUTH_PROBE_ARGS[engineId];
  if (!args) {
    signals.detail = '该引擎未定义最小任务探测参数';
    return {
      ok: false, status: 'DEGRADED', authStatus: 'unknown', signals,
      message: '进程可启动，但该引擎暂不支持自动最小任务验证，请在终端手工确认登录状态'
    };
  }

  // 60s：真实模型请求可能较慢
  const run = await runCli(binPath, args, { timeoutMs: 60_000, env });
  const piProbe = piRuntime ? parsePiProbeOutput(run.stdout) : null;
  const claudeProbe = engineId === CLAUDE_ENGINE_ID ? parseClaudeProbeOutput(run.stdout) : null;
  const rawDetail = piProbe?.error || claudeProbe?.error || run.stderr || run.stdout || run.error || 'no output';
  const detail = piRuntime
    ? redactPiText(rawDetail.trim().slice(0, 300), env)
    : engineId === CLAUDE_ENGINE_ID
      ? redactClaudeText(rawDetail.trim().slice(0, 300), env)
      : redactSensitiveText(rawDetail.trim().slice(0, 300), env);

  if (run.error && run.code === null) {
    // 超时/启动异常：不确定，不可乐观判定为已登录
    signals.detail = detail;
    return {
      ok: false, status: 'DEGRADED', authStatus: 'unknown', signals,
      message: `最小任务未能完成：${run.error}。未能确认登录状态，请稍后重试或在终端手工验证`
    };
  }

  const producedOutput = piProbe ? piProbe.ok : claudeProbe ? claudeProbe.ok : Boolean(run.stdout.trim());
  if (run.code === 0 && producedOutput && !CLI_FAILURE_BODY_PATTERN.test(detail)) {
    signals.authenticated = true;
    signals.taskVerified = true;
    signals.detail = redactSensitiveText(
      (piProbe?.output || claudeProbe?.output || run.stdout.trim()).slice(0, 200),
      env
    );
    return { ok: true, status: 'HEALTHY', authStatus: 'authed', signals, message: '四级探活通过：可启动、凭据有效、最小任务已产出结果' };
  }

  if (AUTH_ERROR_PATTERN.test(detail)) {
    signals.authenticated = false;
    signals.detail = detail;
    return { ok: false, status: 'AUTH_REQUIRED', authStatus: 'required', signals, message: `需要登录：${detail}` };
  }

  if (USAGE_ERROR_PATTERN.test(detail)) {
    // 参数不被接受 = 本应用的调用方式与该 CLI 版本不匹配，属我方缺陷，如实说明
    signals.authenticated = true; // 能报参数错说明已越过鉴权阶段
    signals.detail = detail;
    return {
      ok: false, status: 'DEGRADED', authStatus: 'unknown', signals,
      message: `引擎可启动，但拒绝了本应用传入的参数（可能是 CLI 版本差异）：${detail}\n`
        + `可在配置文件 engines["${engineId}"].runArgs 中覆写运行参数`
    };
  }

  signals.detail = detail;
  return {
    ok: false, status: 'DEGRADED', authStatus: 'unknown', signals,
    message: `最小任务未通过（退出码 ${run.code ?? 'null'}）：${detail}`
  };
}
