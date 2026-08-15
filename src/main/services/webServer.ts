/**
 * 本地 Web 管理服务器：支持局域网远程访问，用于工控机无人值守场景。
 * - 复用 renderer 构建产物作为前端页面（与桌面端完全一致的 UI）
 * - REST API 镜像关键 IPC 通道（供应商/员工/渠道/引擎/设置）
 * - Token 认证（Bearer token，首次启动安全生成并经 safeStorage 加密）
 * - 会话 Token 过期机制：登录后颁发 session token，默认 24h 过期
 * - 请求频率限制：单 IP 每分钟最多 120 次请求，认证接口每分钟 10 次
 * - 监听地址默认 127.0.0.1:PORT（默认 28889）；需局域网访问时显式开启 webExposeLan
 *   才绑 0.0.0.0，避免默认把管理界面暴露到局域网
 * - 访问 Token 不写入 console/日志，也不作为 IPC/REST 响应返回 Renderer
 *
 * @author liyingjie <y@senke.com>
 * - 主进程启动时自动开启，与桌面窗口并行运行
 */
import express from 'express';
import cors from 'cors';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { safeStorage } from 'electron';
import type { Database } from './database.js';
import type { Orchestrator } from './orchestrator.js';
import type { EngineManager } from './engineManager.js';
import type { ChannelManager } from './channelManager.js';
import type { ProviderManager } from './providerManager.js';
import type { McpManager } from './mcpManager.js';
import type { SkillManager } from './skillManager.js';
import type { TeamEngine } from './teamEngine.js';
import type { DesktopControlPlane } from './desktopControlPlane.js';
import { getProviderConfig, saveProviderConfig } from './provider.js';
import { loadConfig, saveConfig } from './config.js';
import { notify } from './notifier.js';
import { readRendererSetting, writeRendererSetting } from './rendererSettings.js';
import type { WebAdminStatus } from '../../shared/types.js';

export interface WebServerDeps {
  db: Database;
  orchestrator: Orchestrator;
  engines: EngineManager;
  channels: ChannelManager;
  providers: ProviderManager;
  mcp: McpManager;
  skills: SkillManager;
  teams: TeamEngine;
  desktopControlPlane: DesktopControlPlane;
}

const DEFAULT_PORT = 28889;
/** 历史默认弱口令：仅用于检测用户是否仍在使用它，不再作为新生成 Token 的来源 */
const LEGACY_DEFAULT_TOKEN = 'aibox-admin';
export const WEB_TOKEN_SECRET_REF = 'secret:webserver:token';
const LEGACY_WEB_TOKEN_SETTING = 'webToken';
/** 会话 Token 过期时间（默认 24 小时） */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** 通用接口频率限制：单 IP 每分钟最多请求数 */
const RATE_LIMIT_PER_MIN = 120;
/** 认证接口频率限制：单 IP 每分钟最多尝试次数 */
const AUTH_RATE_LIMIT_PER_MIN = 10;

export function webRendererDirectory(moduleUrl: string): string {
  return join(dirname(fileURLToPath(moduleUrl)), '../renderer');
}

interface SessionEntry { token: string; expiresAt: number; }
interface RateBucket { count: number; resetAt: number; }

/** 免认证白名单（精确匹配 + assets 前缀），判定前须先规范化路径 */
const PUBLIC_PATHS = new Set(['/', '/index.html', '/api/health', '/api/login']);

/**
 * 判定是否免认证路径。
 *
 * 安全要点：必须对**规范化后**的路径判断。裸 socket 请求可发送
 * `GET /assets/../api/snapshot`，此时 req.path 保持原样，
 * `startsWith('/assets/')` 会误判为公开资源而放行认证
 * （实测确认可绕过，仅因路由层未匹配才侥幸返回 404）。
 */
export function isPublicPath(rawPath: string): boolean {
  let p = rawPath;
  // 解码后再判断，避免 %2e%2e%2f 之类编码穿越
  try { p = decodeURIComponent(p); } catch { /* 非法编码按原样处理 */ }
  p = p.replace(/\\/g, '/');
  // 逐段消解 . 与 ..，得到规范路径
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  const norm = '/' + out.join('/');
  if (PUBLIC_PATHS.has(norm)) return true;
  return norm.startsWith('/assets/');
}

/** 定长比较，避免 Token 校验的时序侧信道 */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export class WebServer {
  private app: ReturnType<typeof express> | null = null;
  private server: ReturnType<ReturnType<typeof express>['listen']> | null = null;
  private pendingServer: ReturnType<ReturnType<typeof express>['listen']> | null = null;
  private startPromise: Promise<void> | null = null;
  private cancelPendingStart: (() => void) | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  /** 活跃会话 Token 池（内存，重启后失效需重新登录） */
  private sessions = new Map<string, SessionEntry>();
  /** 频率限制桶（key = ip 或 ip:auth） */
  private rateBuckets = new Map<string, RateBucket>();

  constructor(private deps: WebServerDeps) {}

  get port(): number {
    return this.deps.db.getSetting<number>('webPort', DEFAULT_PORT);
  }

  private decryptToken(encrypted: unknown): string {
    if (typeof encrypted !== 'string' || !encrypted || !safeStorage.isEncryptionAvailable()) {
      throw new Error('系统密钥库不可用，无法读取 Web 管理 Token');
    }
    try {
      const token = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      if (!token) throw new Error('empty token');
      return token;
    } catch {
      throw new Error('Web 管理 Token 无法解密，请重新生成');
    }
  }

  private storeToken(token: string, action: string, actor: 'admin' | 'system'): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥库不可用，无法保存 Web 管理 Token');
    const encrypted = safeStorage.encryptString(token).toString('base64');
    this.deps.db.transaction(() => {
      this.deps.db.setSetting(WEB_TOKEN_SECRET_REF, encrypted);
      this.deps.db.raw.prepare('DELETE FROM settings WHERE key = ?').run(LEGACY_WEB_TOKEN_SETTING);
      this.deps.db.audit({ id: randomUUID(), actor, action, target: WEB_TOKEN_SECRET_REF, result: 'ok' });
    });
  }

  private readStoredToken(): string | null {
    const encrypted = this.deps.db.getSetting<unknown>(WEB_TOKEN_SECRET_REF, null);
    if (encrypted !== null) {
      const token = this.decryptToken(encrypted);
      if (this.deps.db.getSetting<unknown>(LEGACY_WEB_TOKEN_SETTING, null) !== null) {
        this.deps.db.transaction(() => {
          this.deps.db.raw.prepare('DELETE FROM settings WHERE key = ?').run(LEGACY_WEB_TOKEN_SETTING);
          this.deps.db.audit({
            id: randomUUID(), actor: 'system', action: 'webserver.token.legacy_cleanup',
            target: LEGACY_WEB_TOKEN_SETTING, result: 'deleted'
          });
        });
      }
      return token;
    }

    const legacy = this.deps.db.getSetting<unknown>(LEGACY_WEB_TOKEN_SETTING, null);
    if (legacy === null) return null;
    if (typeof legacy !== 'string' || !legacy) throw new Error('旧版 Web 管理 Token 无效，请重新生成');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥库不可用，无法迁移 Web 管理 Token');
    const encryptedLegacy = safeStorage.encryptString(legacy).toString('base64');
    this.deps.db.transaction(() => {
      this.deps.db.setSetting(WEB_TOKEN_SECRET_REF, encryptedLegacy);
      this.deps.db.raw.prepare('DELETE FROM settings WHERE key = ?').run(LEGACY_WEB_TOKEN_SETTING);
      this.deps.db.audit({
        id: randomUUID(), actor: 'system', action: 'webserver.token.migrate',
        target: WEB_TOKEN_SECRET_REF, result: 'ok'
      });
    });
    return legacy;
  }

  get token(): string {
    const token = this.readStoredToken();
    if (!token) throw new Error('Web 管理 Token 尚未初始化');
    return token;
  }

  getStatus(): WebAdminStatus {
    let token: string | null = null;
    try {
      token = this.readStoredToken();
    } catch {
      // Keep status readable so the Renderer can offer credential rotation.
    }
    return {
      port: this.port,
      tokenConfigured: token !== null,
      weakToken: token === LEGACY_DEFAULT_TOKEN
    };
  }

  /** 确保存在强随机 Token：首次启动自动生成并持久化；若仍为历史弱口令则告警 */
  ensureToken(): void {
    const existing = this.readStoredToken();
    if (!existing) {
      const generated = randomBytes(16).toString('hex');
      this.storeToken(generated, 'webserver.token.generate', 'system');
      console.log('[WebServer] 已自动生成强随机访问 Token（设置页可复制/重新生成）');
    } else if (existing === LEGACY_DEFAULT_TOKEN) {
      this.deps.db.audit({ id: randomUUID(), actor: 'system', action: 'webserver.weak_token', target: WEB_TOKEN_SECRET_REF, result: 'warn' });
      console.warn('[WebServer] ⚠️ 检测到仍在使用默认弱口令「aibox-admin」，若开启局域网暴露将极不安全！请尽快在设置页重新生成 Token。');
      notify(this.deps.db, '安全提醒', 'Web 管理面板仍在使用默认弱口令，请尽快在设置页重新生成访问 Token');
    }
  }

  /** 重新生成访问 Token（设置页调用）：同时失效所有旧会话 */
  regenerateToken(): string {
    const generated = randomBytes(16).toString('hex');
    this.storeToken(generated, 'webserver.token.rotate', 'admin');
    this.sessions.clear();
    return generated;
  }

  /** 频率限制检查（滑动窗口简化为固定窗口） */
  private checkRate(key: string, limit: number): boolean {
    const now = Date.now();
    const bucket = this.rateBuckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      this.rateBuckets.set(key, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    bucket.count++;
    return bucket.count <= limit;
  }

  /** 清理过期会话和频率桶（每 5 分钟） */
  private startCleanup() {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.sessions) { if (now >= v.expiresAt) this.sessions.delete(k); }
      for (const [k, v] of this.rateBuckets) { if (now >= v.resetAt) this.rateBuckets.delete(k); }
    }, 5 * 60_000);
  }

  private stopCleanup(): void {
    if (!this.cleanupTimer) return;
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  start(): Promise<void> {
    if (this.server?.listening) return Promise.resolve();
    if (this.startPromise) return this.startPromise;

    const attempt = this.startOnce();
    this.startPromise = attempt;
    void attempt.finally(() => {
      if (this.startPromise === attempt) this.startPromise = null;
    }).catch(() => {
      // The caller observes the original attempt; suppress the finally-chain copy.
    });
    return attempt;
  }

  private async startOnce(): Promise<void> {
    const { db, orchestrator, engines, channels, providers, mcp, skills, teams, desktopControlPlane } = this.deps;
    this.ensureToken();
    const app = express();

    // CORS：不放行任意来源。管理面板由本服务自身托管（同源），
    // 无需跨源；开放 * 会让任意网页在用户浏览器里调用本 API（Token 若被读到即可控台）。
    app.use(cors({ origin: false }));
    // 请求体上限：管理接口无大 body 场景，限制以免被单请求打满内存
    app.use(express.json({ limit: '1mb' }));

    // 全局频率限制中间件
    app.use((req, res, next) => {
      const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
      if (!this.checkRate(ip, RATE_LIMIT_PER_MIN)) {
        return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
      }
      next();
    });

    // Token 认证中间件（静态资源、健康检查、登录接口免认证）
    app.use((req, res, next) => {
      if (isPublicPath(req.path)) return next();
      const auth = req.headers.authorization;
      const bearerToken = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
      // 支持永久 Token（设置页配置的原始 token）或会话 Token
      if (bearerToken && safeEqual(bearerToken, this.token)) return next();
      const session = bearerToken ? this.sessions.get(bearerToken) : null;
      if (session && Date.now() < session.expiresAt) return next();
      return res.status(401).json({ error: '未授权：请提供有效的 Access Token 或先登录获取会话 Token' });
    });

    // 静态文件：复用 renderer 构建产物
    const rendererDir = webRendererDirectory(import.meta.url);
    app.use(express.static(rendererDir));
    app.get('{*splat}', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(join(rendererDir, 'index.html'));
    });

    // ---------- REST API ----------

    // 健康检查（免认证）
    app.get('/api/health', (_req, res) => {
      res.json({ ok: true, version: '1.0.0', agents: orchestrator.listAgents().length });
    });

    // 登录：用永久 Token 换取有时效的会话 Token（防暴力破解）
    app.post('/api/login', (req, res) => {
      const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
      if (!this.checkRate(`${ip}:auth`, AUTH_RATE_LIMIT_PER_MIN)) {
        return res.status(429).json({ error: '登录尝试过于频繁，请 1 分钟后再试' });
      }
      const { token } = req.body as { token?: string };
      if (typeof token !== 'string' || !safeEqual(token, this.token)) {
        this.deps.db.audit({ id: randomUUID(), actor: 'web', action: 'webserver.login_failed', target: ip, result: 'invalid-token' });
        return res.status(401).json({ error: 'Token 无效' });
      }
      const sessionToken = randomBytes(32).toString('hex');
      this.sessions.set(sessionToken, { token: sessionToken, expiresAt: Date.now() + SESSION_TTL_MS });
      res.json({ ok: true, sessionToken, expiresAt: Date.now() + SESSION_TTL_MS });
    });

    // 快照（完整状态）
    app.get('/api/snapshot', (_req, res) => {
      res.json({
        agents: orchestrator.agentCards(),
        tasks: orchestrator.listTasks({ includeResult: false }),
        engines: engines.list(),
        channels: channels.list(),
        approvals: orchestrator.listApprovals()
      });
    });

    // 供应商管理
    app.get('/api/providers', (_req, res) => res.json(providers.list()));
    app.post('/api/providers', (req, res) => {
      const p = providers.create(req.body);
      res.json(p);
    });
    app.put('/api/providers/:id', (req, res) => {
      providers.update(req.params.id, req.body);
      res.json({ ok: true });
    });
    app.delete('/api/providers/:id', (req, res) => {
      providers.remove(req.params.id);
      res.json({ ok: true });
    });

    // 旧版供应商配置（兼容）
    app.get('/api/provider', (_req, res) => res.json(getProviderConfig(db)));
    app.post('/api/provider', (req, res) => {
      saveProviderConfig(db, req.body);
      engines.invalidateHarnessProviderVerification();
      res.json({ ok: true });
    });

    // 数字员工管理
    app.get('/api/agents', (_req, res) => res.json(orchestrator.listAgents()));
    app.post('/api/agents', (req, res) => {
      const a = orchestrator.createAgent(req.body);
      res.json(a);
    });
    app.put('/api/agents/:id/persona', (req, res) => {
      const a = orchestrator.updateAgentPersona(req.params.id, req.body);
      res.json(a);
    });
    app.post('/api/agents/:id/start', (req, res) => {
      orchestrator.startAgent(req.params.id);
      res.json({ ok: true });
    });
    app.post('/api/agents/:id/stop', (req, res) => {
      orchestrator.stopAgent(req.params.id);
      res.json({ ok: true });
    });

    // 任务
    app.get('/api/tasks', (_req, res) => res.json(orchestrator.listTasks({ includeResult: false })));
    app.post('/api/tasks', async (req, res) => {
      const suppliedKey = String(req.get('Idempotency-Key') ?? '').trim();
      if (suppliedKey.length > 100) {
        res.status(400).json({ error: 'Idempotency-Key is too long' });
        return;
      }
      const result = await desktopControlPlane.dispatch({
        preferredAgentId: String(req.body?.agentId ?? ''),
        message: String(req.body?.title ?? ''),
        projectId: req.body?.projectId ? String(req.body.projectId) : undefined,
        source: 'webhook',
        messageKey: suppliedKey || randomUUID()
      });
      res.json(result.task);
    });
    app.post('/api/tasks/:id/cancel', (req, res) => {
      orchestrator.cancelTask(req.params.id);
      res.json({ ok: true });
    });
    app.post('/api/approvals/:id/decide', (req, res) => {
      orchestrator.decideApproval(req.params.id, req.body.approve === true);
      res.json({ ok: true });
    });

    // 引擎
    app.get('/api/engines', (_req, res) => res.json(engines.list()));
    app.post('/api/engines/detect', async (_req, res) => {
      const list = await engines.detect();
      res.json(list);
    });

    // 渠道
    app.get('/api/channels', (_req, res) => res.json(channels.list()));

    // MCP
    app.get('/api/mcp', (_req, res) => res.json(mcp.list()));
    app.post('/api/mcp', (req, res) => res.json(mcp.create(req.body)));
    app.delete('/api/mcp/:id', (req, res) => { mcp.remove(req.params.id); res.json({ ok: true }); });

    // Skills
    app.get('/api/skills', (_req, res) => res.json(skills.list()));
    app.post('/api/skills', (req, res) => res.json(skills.create(req.body)));
    app.delete('/api/skills/:id', (req, res) => { skills.remove(req.params.id); res.json({ ok: true }); });

    // 专家团
    app.get('/api/teams', (_req, res) => res.json(teams.list()));
    app.post('/api/teams', (req, res) => res.json(teams.create(req.body)));
    app.post('/api/teams/:id/trigger', (req, res) => res.json(teams.trigger(req.params.id, req.body.task)));

    // 应用配置
    app.get('/api/config', (_req, res) => res.json(loadConfig()));
    app.put('/api/config', (req, res) => res.json(saveConfig(req.body)));

    // Only non-sensitive Renderer preferences are exposed through the remote UI.
    app.get('/api/settings/:key', (req, res) => {
      try {
        res.json({ value: readRendererSetting(db, req.params.key) });
      } catch {
        res.status(400).json({ error: 'Setting key is not allowed' });
      }
    });
    app.put('/api/settings/:key', (req, res) => {
      try {
        writeRendererSetting(db, req.params.key, req.body.value);
        res.json({ ok: true });
      } catch {
        res.status(400).json({ error: 'Setting value is invalid' });
      }
    });

    // 启动监听：默认仅绑本机回环，避免管理面板暴露到局域网；
    // 需要局域网访问时由用户显式开启 settings.webExposeLan（并强制使用强 Token）
    const port = this.port;
    const host = this.bindHost();
    const candidate = app.listen(port, host);
    this.pendingServer = candidate;
    let ownedCancel: (() => void) | null = null;

    try {
      await new Promise<void>((resolveStart, rejectStart) => {
        let settled = false;
        let cancelled = false;
        const cleanupStartup = () => {
          candidate.off('listening', onListening);
        };
        const rejectOnce = (error: Error) => {
          if (settled) return;
          settled = true;
          cleanupStartup();
          rejectStart(error);
        };
        const clearOwnedState = () => {
          if (this.pendingServer === candidate) this.pendingServer = null;
          if (this.server === candidate) {
            this.server = null;
            if (this.app === app) this.app = null;
            this.stopCleanup();
          }
        };
        const auditFailure = (result: string) => {
          try {
            this.deps.db.audit({
              id: randomUUID(), actor: 'system', action: 'webserver.runtime',
              target: 'web-admin', result
            });
          } catch {
            // Network failure handling must not throw from an EventEmitter callback.
          }
        };
        const onListening = () => {
          if (cancelled || this.pendingServer !== candidate) {
            if (!settled) rejectOnce(new Error('Web server startup was cancelled'));
            try { candidate.close(); } catch { /* The candidate never became active. */ }
            return;
          }
          if (settled) return;
          settled = true;
          cleanupStartup();
          this.pendingServer = null;
          this.server = candidate;
          this.app = app;
          this.startCleanup();
          resolveStart();
        };
        const onError = (error: Error) => {
          const owned = this.pendingServer === candidate || this.server === candidate;
          clearOwnedState();
          rejectOnce(error);
          if (owned) {
            console.error('[WebServer] 监听或运行失败:', error.message);
            auditFailure('error');
            try { candidate.close(); } catch { /* It may already be closed. */ }
          }
        };
        const onClose = () => {
          const wasPending = this.pendingServer === candidate;
          const wasActive = this.server === candidate;
          clearOwnedState();
          if (wasPending) rejectOnce(new Error('Web server closed before listening'));
          if (wasActive) auditFailure('closed');
        };
        candidate.once('listening', onListening);
        // Keep these listeners for the whole Server lifetime. A late 'error'
        // without a listener would otherwise terminate the Electron process.
        candidate.on('error', onError);
        candidate.on('close', onClose);
        ownedCancel = () => {
          cancelled = true;
          if (this.pendingServer === candidate) this.pendingServer = null;
          rejectOnce(new Error('Web server startup was cancelled'));
          try {
            candidate.close();
          } catch {
            // If listen has not allocated its handle yet, onListening will
            // observe the cancelled ownership and close it immediately.
          }
        };
        this.cancelPendingStart = ownedCancel;
      });

      // 不打印 Token：凭据不得进入日志，设置页可查看
      console.log(`[WebServer] 管理面板已启动: http://${host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1'}:${port}`);
      if (host === '0.0.0.0') {
        console.warn('[WebServer] ⚠️ 已监听所有网卡，局域网内可访问管理面板，请确认 Token 为强随机值');
      }
    } catch (error) {
      if (this.pendingServer === candidate) this.pendingServer = null;
      if (this.server === candidate) this.server = null;
      if (this.app === app) this.app = null;
      if (candidate.listening) candidate.close();
      throw error;
    } finally {
      if (this.cancelPendingStart === ownedCancel) this.cancelPendingStart = null;
    }
  }

  /** 监听地址：默认 127.0.0.1（仅本机）；settings.webExposeLan = true 时才绑 0.0.0.0 */
  private bindHost(): string {
    const expose = this.deps.db.getSetting<boolean>('webExposeLan', false);
    if (!expose) return '127.0.0.1';
    this.deps.db.audit({ id: randomUUID(), actor: 'system', action: 'webserver.expose_lan', target: 'webExposeLan', result: 'enabled' });
    return '0.0.0.0';
  }

  stop() {
    const cancelStart = this.cancelPendingStart;
    this.cancelPendingStart = null;
    this.startPromise = null;
    const pending = this.pendingServer;
    this.pendingServer = null;
    cancelStart?.();
    if (pending?.listening) {
      try { pending.close(); } catch { /* It may already be closing. */ }
    }
    this.server?.close();
    this.server = null;
    this.app = null;
    this.stopCleanup();
    this.sessions.clear();
    this.rateBuckets.clear();
  }
}
