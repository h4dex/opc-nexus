/**
 * 引擎中心（PRD 9.x）
 * 引擎目录：内置 Nexus Agent（自研 Runtime，直连 OpenAI 兼容 API）+ 真实 Hermes Agent CLI
 * + 5 个本机 CLI 引擎（Codex CLI / Claude Code / ZCode / OpenCode / Kimi Code）。
 * 注：引擎清单待收敛为四种（Nexus / Hermes / OpenCode / Codex CLI），见 docs/architecture-review.md E-1。
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
import { acpCommandFor, probeAcpEngine } from './executor/acpExecutor.js';
import { engineEnvSecretRef, resolveEngineEnv, splitSecretEnv, SECRET_PLACEHOLDER } from './engineEnv.js';
import { appendProcessOutput, createProcessOutputBuffer, finishProcessOutput } from './textEncoding.js';
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
}

/** 引擎目录：bin / npm 包名可被配置文件 engines[id] 覆写 */
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
 * 引擎目录（四引擎收敛，见 src/docs/architecture-review.md E-1）：
 * Nexus Agent（内置自研 Runtime）/ Hermes Agent（默认主引擎，真实 CLI）/
 * OpenCode（编码专家）/ Codex CLI（备选编码引擎）。
 * ZCode / Kimi Code / Claude Code 已下线：清单膨胀且缺乏验证，由 v26 迁移改绑到 Nexus。
 */
export const ENGINE_CATALOG: CatalogEntry[] = [
  {
    id: 'eng-hermes', type: 'hermes', name: 'Nexus Agent', bin: null, npmPackage: null,
    dataBoundary: '本地运行；模型请求发送至所配置模型提供商',
    guide: { guide: '内置引擎无需安装，在设置页完成模型供应商配置即可启用', url: null }
  },
  {
    id: 'eng-hermes-cli', type: 'hermes-cli', name: 'Hermes Agent', bin: 'hermes', npmPackage: null,
    dataBoundary: '本地 Hermes Agent Runtime；数据发送目标取决于 Hermes 自身配置',
    guide: { guide: '请按 Hermes Agent 官方方式安装 hermes CLI；如可执行名或运行参数不同，可在配置文件 engines["eng-hermes-cli"] 中覆写 bin/runArgs', url: null }
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
  }
];

/** 已下线引擎：v26 迁移把绑定它们的员工改绑 Nexus，并从 engines 表清理 */
export const RETIRED_ENGINE_IDS = ['eng-claude', 'eng-zcode', 'eng-kimi'] as const;

/** 外部 ACP 引擎（P2a）：配置文件 engines 中带 acpCommand 的非内置条目，新增即接入引擎中心 */
function externalAcpEntries(): { id: string; name: string; command: string[] }[] {
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

/** 配置覆写后的 bin / npm 包名 */
function effective(entry: CatalogEntry): { bin: string | null; npmPackage: string | null } {
  const override = loadConfig().engines[entry.id] ?? {};
  const bin = override.bin && /^[\w.-]+$/.test(override.bin) ? override.bin : entry.bin;
  const pkg = override.npmPackage && /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(override.npmPackage)
    ? override.npmPackage
    : entry.npmPackage;
  return { bin, npmPackage: pkg };
}

export class EngineManager {
  /** 正在安装的引擎（防重复触发） */
  private installing = new Set<string>();

  constructor(private db: Database) {}

  /** 目录中的引擎逐个补齐（旧库升级时新增引擎行不丢已有状态）；外部 ACP 引擎随配置文件同步 */
  ensureBuiltinEngines() {
    const stmt = this.db.raw.prepare(
      `INSERT INTO engines(id, type, name, version, path, status, auth_status, is_default, data_boundary)
       VALUES(?, ?, ?, NULL, NULL, ?, 'required', ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, data_boundary = excluded.data_boundary`
    );
    for (const e of ENGINE_CATALOG) {
      const initial = e.bin === null ? 'SETUP_REQUIRED' : 'NOT_INSTALLED';
      stmt.run(e.id, e.type, e.name, initial, e.id === 'eng-hermes' ? 1 : 0, e.dataBoundary);
    }
    for (const ext of externalAcpEntries()) {
      stmt.run(ext.id, 'external', ext.name, 'NOT_INSTALLED', 0, '外部 ACP 引擎；数据发送目标取决于该引擎自身配置');
    }
  }

  list(): Engine[] {
    const rows = this.db.raw.prepare('SELECT * FROM engines ORDER BY is_default DESC, name').all() as unknown as EngineRow[];
    const runCounts = this.db.raw
      .prepare("SELECT agent_id, COUNT(*) c FROM agent_runs WHERE ended_at IS NULL GROUP BY agent_id")
      .all() as { agent_id: string; c: number }[];
    const agentEngine = new Map(
      (this.db.raw.prepare('SELECT id, engine_id FROM agents').all() as { id: string; engine_id: string }[]).map((r) => [r.id, r.engine_id])
    );
    const perEngine = new Map<string, number>();
    for (const r of runCounts) {
      const eng = agentEngine.get(r.agent_id);
      if (eng) perEngine.set(eng, (perEngine.get(eng) ?? 0) + r.c);
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
    if (externalAcpEntries().some((e) => e.id === id)) {
      return { guide: '外部 ACP 引擎：请按该引擎官方方式安装，确保配置文件 acpCommand 可执行后点击重新检测', url: null };
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
    this.ensureBuiltinEngines(); // 配置文件新增的外部引擎随检测同步入库
    for (const entry of ENGINE_CATALOG) {
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
      const ver = await runCli(found, ['--version'], { timeoutMs: 15_000 });
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
    // 外部 ACP 引擎：spawn + initialize 握手成功 = HEALTHY（P2a）
    for (const ext of externalAcpEntries()) {
      const command = acpCommandFor(ext.id);
      if (!command) {
        this.db.raw.prepare("UPDATE engines SET status = 'NOT_INSTALLED' WHERE id = ?").run(ext.id);
        continue;
      }
      const probe = await probeAcpEngine(command);
      this.db.raw.prepare("UPDATE engines SET status = ?, version = ? WHERE id = ?")
        .run(probe.ok ? 'HEALTHY' : 'NOT_INSTALLED', probe.ok ? 'acp' : null, ext.id);
    }
    // Nexus Agent：供应商已配置 = HEALTHY；未配置 = SETUP_REQUIRED（演示模式，UI 必须标注）
    this.db.raw.prepare("UPDATE engines SET status = ? WHERE id = 'eng-hermes'").run(providerReady(this.db) ? 'HEALTHY' : 'SETUP_REQUIRED');
    return this.list();
  }

  /**
   * 自动安装：npm install -g <官方包> --registry <配置文件下载地址>
   * 安装来源固定为目录内官方包名（配置文件可覆写但需通过包名校验，9.3 供应链基线）。
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
      const r = await npmInstallGlobal(npmPackage, registry);
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
    if (!entry) return { ok: false, message: '未知引擎' };

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
    if (id === 'eng-hermes') {
      // Nexus Agent：重新检测供应商配置是否就绪
      this.db.raw.prepare("UPDATE engines SET status = ? WHERE id = 'eng-hermes'").run(providerReady(this.db) ? 'HEALTHY' : 'SETUP_REQUIRED');
      const ready = providerReady(this.db);
      return { ok: ready, message: ready ? 'Nexus Agent 引擎已重新加载，供应商配置生效' : 'Nexus Agent 引擎未就绪：请先在设置页完成模型供应商配置' };
    }
    if (!entry) {
      // 外部 ACP 引擎
      const ext = externalAcpEntries().find((e) => e.id === id);
      if (!ext) return { ok: false, message: '未知引擎' };
      const command = acpCommandFor(id);
      if (!command) return { ok: false, message: '引擎命令未配置' };
      const probe = await probeAcpEngine(command);
      this.db.raw.prepare('UPDATE engines SET status = ?, version = ? WHERE id = ?').run(probe.ok ? 'HEALTHY' : 'NOT_INSTALLED', probe.ok ? 'acp' : null, id);
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
    const { safe, secrets } = splitSecretEnv(config.env ?? {});
    const persisted = { ...config, env: safe };
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
    this.addLog(id, 'info', `配置已更新: ${JSON.stringify(persisted).slice(0, 100)}`);
  }

  /**
   * 获取引擎配置（供 Renderer 展示）。
   * 敏感环境变量以占位符形式返回，绝不返回明文。
   */
  getConfig(id: string): { runArgs?: string[]; env?: Record<string, string>; maxConcurrency?: number } | null {
    const row = this.db.raw.prepare('SELECT config_json FROM engines WHERE id = ?').get(id) as { config_json?: string } | undefined;
    if (!row?.config_json) return null;
    try { return JSON.parse(row.config_json); } catch { return null; }
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
      `SELECT ar.started_at, ar.ended_at, t.status FROM agent_runs ar JOIN tasks t ON ar.task_id = t.id JOIN agents a ON ar.agent_id = a.id WHERE a.engine_id = ? AND ar.ended_at IS NOT NULL ORDER BY ar.ended_at DESC LIMIT 200`
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
    const id = `eng-custom-${randomUUID().slice(0, 6)}`;
    this.db.raw.prepare(
      `INSERT INTO engines(id, type, name, version, path, status, auth_status, is_default, data_boundary) VALUES(?, 'external', ?, NULL, ?, 'NOT_INSTALLED', 'unknown', 0, ?)`
    ).run(id, input.name.trim(), input.command.trim(), input.dataBoundary || '自定义引擎；数据发送目标取决于配置');
    // 保存命令配置
    const config = { runArgs: input.args ? input.args.split(' ').filter(Boolean) : [] };
    this.db.raw.prepare('UPDATE engines SET config_json = ? WHERE id = ?').run(JSON.stringify(config), id);
    this.addLog(id, 'info', `自定义引擎「${input.name}」已注册，命令: ${input.command}`);
    return { ok: true, message: `已注册自定义引擎「${input.name}」`, id };
  }
}

/** npm 全局安装（Windows 下 npm 为 .cmd，须经 cmd.exe /c 拉起；参数均已白名单校验，无注入面） */
function npmInstallGlobal(pkg: string, registry: string): Promise<{ ok: boolean; message: string }> {
  return npmCommand(['install', '-g', pkg, '--registry', registry]);
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
  return engineId === 'eng-hermes-cli' && Boolean(env.HERMES_HOME?.trim()) ? 45_000 : 15_000;
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
async function probeCliAuth(
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
  const env = { ...process.env, ...resolveEngineEnv(db, engineId) };

  // 第 1 级：launchable —— 用 --version 验证进程真能起来（最轻量、不消耗额度）
  const ver = await runCli(binPath, ['--version'], { timeoutMs: cliLaunchProbeTimeoutMs(engineId, env), env });
  if (ver.error && !ver.stdout && !ver.stderr) {
    signals.detail = `进程无法启动：${ver.error}`;
    return {
      ok: false, status: 'ERROR', authStatus: 'unknown', signals,
      message: `已检测到可执行文件但无法启动：${ver.error}。`
        + '（Windows 上 npm 无扩展名 shim、.cmd 批处理与 Microsoft Store 应用均需经 cmd.exe 拉起）'
    };
  }
  signals.launchable = true;

  // 第 2、3 级：跑最小任务，同时验证凭据与产出
  const args = AUTH_PROBE_ARGS[engineId];
  if (!args) {
    signals.detail = '该引擎未定义最小任务探测参数';
    return {
      ok: false, status: 'DEGRADED', authStatus: 'unknown', signals,
      message: '进程可启动，但该引擎暂不支持自动最小任务验证，请在终端手工确认登录状态'
    };
  }

  // 60s：真实模型请求可能较慢
  const run = await runCli(binPath, args, { timeoutMs: 60_000, env });
  const detail = (run.stderr || run.stdout || run.error || '无输出').trim().slice(0, 300);

  if (run.error && run.code === null) {
    // 超时/启动异常：不确定，不可乐观判定为已登录
    signals.detail = detail;
    return {
      ok: false, status: 'DEGRADED', authStatus: 'unknown', signals,
      message: `最小任务未能完成：${run.error}。未能确认登录状态，请稍后重试或在终端手工验证`
    };
  }

  if (run.code === 0 && run.stdout.trim() && !CLI_FAILURE_BODY_PATTERN.test(detail)) {
    signals.authenticated = true;
    signals.taskVerified = true;
    signals.detail = run.stdout.trim().slice(0, 200);
    return { ok: true, status: 'HEALTHY', authStatus: 'authed', signals, message: '四级探活通过：可启动、凭据有效、最小任务已产出结果' };
  }

  if (AUTH_ERROR_PATTERN.test(detail)) {
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
