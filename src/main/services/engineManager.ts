/**
 * 引擎中心（PRD 9.x）
 * 引擎目录：内置 Hermes（直连 OpenAI 兼容 API）+ 5 个本机 CLI 引擎
 * （Codex CLI / Claude Code / ZCode / OpenCode / Kimi Code）。
 * 检测：where/which 定位可执行文件 + --version 取版本 → NOT_INSTALLED / HEALTHY，不做假安装。
 * 自动安装：存在官方 npm 包的引擎支持 npm -g 真实安装（下载地址取配置文件 npmRegistry）；
 * ZCode 为桌面应用无公开 npm 包，仅提供官方指引。
 * Hermes 状态按供应商配置派生：已配置 = HEALTHY，未配置 = SETUP_REQUIRED（演示模式）。
 */
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import type { Database } from './database.js';
import { providerReady } from './provider.js';
import { loadConfig, sanitizeRegistry } from './config.js';
import { acpCommandFor, probeAcpEngine } from './executor/acpExecutor.js';
import type { Engine, EngineInstallGuide, EngineInstallResult, EngineType } from '../../shared/types.js';

const INSTALL_TIMEOUT_MS = 10 * 60_000;

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

export const ENGINE_CATALOG: CatalogEntry[] = [
  {
    id: 'eng-hermes', type: 'hermes', name: 'Hermes Runtime', bin: null, npmPackage: null,
    dataBoundary: '本地运行；模型请求发送至所配置模型提供商',
    guide: { guide: '内置引擎无需安装，在设置页完成模型供应商配置即可启用', url: null }
  },
  {
    id: 'eng-codex', type: 'codex', name: 'OpenAI Codex CLI', bin: 'codex', npmPackage: '@openai/codex',
    dataBoundary: '数据将发送至 OpenAI API',
    guide: { guide: 'npm install -g @openai/codex，安装后运行 codex 完成登录', url: 'https://github.com/openai/codex' }
  },
  {
    id: 'eng-claude', type: 'claude-code', name: 'Claude Code', bin: 'claude', npmPackage: '@anthropic-ai/claude-code',
    dataBoundary: '数据将发送至 Anthropic API',
    guide: { guide: 'npm install -g @anthropic-ai/claude-code，安装后运行 claude 完成登录', url: 'https://docs.anthropic.com/zh-CN/docs/claude-code/overview' }
  },
  {
    id: 'eng-zcode', type: 'zcode', name: 'ZCode (Z.ai)', bin: 'zcode', npmPackage: null,
    dataBoundary: '数据将发送至 Z.ai / 智谱 BigModel API',
    guide: { guide: 'ZCode 为桌面应用，请前往官网下载安装包安装', url: 'https://zcode.z.ai/cn' }
  },
  {
    id: 'eng-opencode', type: 'opencode', name: 'OpenCode', bin: 'opencode', npmPackage: 'opencode-ai',
    dataBoundary: '数据发送目标取决于 OpenCode 内所配置的模型提供商',
    guide: { guide: 'npm install -g opencode-ai，安装后运行 opencode auth login 配置提供商', url: 'https://opencode.ai/docs' }
  },
  {
    id: 'eng-kimi', type: 'kimicode', name: 'Kimi Code CLI', bin: 'kimi', npmPackage: '@moonshot-ai/kimi-code',
    dataBoundary: '数据将发送至 Moonshot AI API',
    guide: { guide: 'npm install -g @moonshot-ai/kimi-code，安装后在 CLI 内执行 /login 登录', url: 'https://github.com/MoonshotAI/kimi-code' }
  }
];

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
        installable: !!(entry && effective(entry).npmPackage)
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

  /** 真实检测：where/which 定位 CLI + --version 取版本；外部 ACP 引擎握手探测；Hermes 按供应商配置派生状态 */
  async detect(): Promise<Engine[]> {
    this.ensureBuiltinEngines(); // 配置文件新增的外部引擎随检测同步入库
    for (const entry of ENGINE_CATALOG) {
      if (!entry.bin) continue;
      if (this.installing.has(entry.id)) continue; // 安装中不覆盖 INSTALLING 状态
      const { bin } = effective(entry);
      const found = bin ? await locateBin(bin) : null;
      if (!found) {
        this.db.raw.prepare("UPDATE engines SET status = 'NOT_INSTALLED', version = NULL, path = NULL WHERE id = ?").run(entry.id);
        continue;
      }
      const version = await binVersion(found);
      this.db.raw.prepare("UPDATE engines SET status = 'HEALTHY', version = ?, path = ? WHERE id = ?").run(version ?? 'unknown', found, entry.id);
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
    // Hermes：供应商已配置 = HEALTHY；未配置 = SETUP_REQUIRED（演示模式，UI 必须标注）
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

  markAuthed(id: string) {
    this.db.raw.prepare("UPDATE engines SET auth_status = 'authed', status = 'HEALTHY' WHERE id = ?").run(id);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'engine.auth', target: id, result: 'authed' });
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
      // Hermes：重新检测供应商配置是否就绪
      this.db.raw.prepare("UPDATE engines SET status = ? WHERE id = 'eng-hermes'").run(providerReady(this.db) ? 'HEALTHY' : 'SETUP_REQUIRED');
      const ready = providerReady(this.db);
      return { ok: ready, message: ready ? 'Hermes 引擎已重新加载，供应商配置生效' : 'Hermes 引擎未就绪：请先在设置页完成模型供应商配置' };
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
        let stderr = '';
        child.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
        const timer = setTimeout(() => { child.kill(); resolve({ ok: false, message: '安装超时（5分钟）' }); }, 5 * 60_000);
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve(code === 0 ? { ok: true, message: `${name} 安装成功，请重新检测` } : { ok: false, message: `安装失败（退出码 ${code}）：${stderr.slice(0, 200)}` });
        });
        child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, message: `无法启动安装程序：${err.message}` }); });
      } catch (err) {
        resolve({ ok: false, message: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  // ---------- 配置 / 日志 / 指标 / 自定义注册 ----------

  /** 保存引擎运行配置 */
  saveConfig(id: string, config: { runArgs?: string[]; env?: Record<string, string>; maxConcurrency?: number }) {
    this.db.raw.prepare('UPDATE engines SET config_json = ? WHERE id = ?').run(JSON.stringify(config), id);
    this.addLog(id, 'info', `配置已更新: ${JSON.stringify(config).slice(0, 100)}`);
  }

  /** 获取引擎配置 */
  getConfig(id: string): { runArgs?: string[]; env?: Record<string, string>; maxConcurrency?: number } | null {
    const row = this.db.raw.prepare('SELECT config_json FROM engines WHERE id = ?').get(id) as { config_json?: string } | undefined;
    if (!row?.config_json) return null;
    try { return JSON.parse(row.config_json); } catch { return null; }
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
    let stderr = '';
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
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      done(false, `无法启动 npm：${err.message}（请确认已安装 Node.js 且 npm 在 PATH 中）`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) done(true, 'ok');
      else done(false, `npm 退出码 ${code ?? 'null'}：${(stderr || '无错误输出').slice(0, 400)}`);
    });
  });
}

/** where（Windows）/ which（Linux）定位可执行文件；优先 .exe（Node 对 .cmd 禁止 shell:false 直启） */
function locateBin(bin: string): Promise<string | null> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    try {
      execFile(cmd, [bin], { shell: false, timeout: 10_000 }, (err, stdout) => {
        if (err) return resolve(null);
        const lines = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        resolve(lines.find((l) => /\.exe$/i.test(l)) ?? lines[0] ?? null);
      });
    } catch { resolve(null); }
  });
}

/** --version 探测（10s 超时；部分 CLI 把版本写到 stderr） */
function binVersion(binPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(binPath, ['--version'], { shell: false, timeout: 10_000 }, (_err, stdout, stderr) => {
        const out = (stdout || stderr || '').trim().split(/\r?\n/)[0]?.slice(0, 80);
        resolve(out || null);
      });
    } catch { resolve(null); }
  });
}
