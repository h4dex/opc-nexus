/**
 * 微信 iLink Bot 渠道：扫码授权、HTTP 长轮询收信、文本回信。
 * Bot Token、游标和 context_token 均经 safeStorage 加密后持久化，绝不进入 Renderer。
 */
import { randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';
import type { Database } from '../database.js';
import type { Orchestrator } from '../orchestrator.js';
import type { ChannelIngressService } from '../channelIngressService.js';
import type { WeixinLoginState } from '../../../shared/types.js';
import { notify } from '../notifier.js';
import { dispatchChannelTask, type ChannelTaskPlanner } from './common.js';
import {
  ILinkClient,
  ILinkHttpError,
  ILinkProtocolError,
  ILINK_DEFAULT_BASE_URL,
  extractIlinkText,
  ilinkMessageKey,
  sanitizeIlinkBaseUrl,
  sanitizeIlinkRedirectHost,
  type ILinkMessage
} from './ilinkClient.js';

export const WEIXIN_SESSION_REF = 'secret:channel:weixin:ilink';
export const WEIXIN_POLL_STATE_REF = 'secret:channel:weixin:ilink:poll';
export const WEIXIN_PENDING_SESSION_REF = 'secret:channel:weixin:ilink:pending';
export const WEIXIN_OUTBOX_REF = 'secret:channel:weixin:ilink:outbox';
export const WEIXIN_LAST_ERROR_REF = 'channel:weixin:ilink:last-error';

const CHANNEL_ID = 'ch-weixin';
const MAX_REPLY_CHARS = 4000;
const MAX_SEEN_IDS = 500;
const MAX_CONTEXTS = 50;
const MAX_QR_REFRESHES = 3;
const QR_LOGIN_TIMEOUT_MS = 8 * 60_000;
const SESSION_COOLDOWN_MS = 60 * 60_000;
const OUTBOX_MAX_ATTEMPTS = 6;
const OUTBOX_RETRY_BASE_MS = 2_000;
const OUTBOX_RETRY_MAX_MS = 60_000;

interface ILinkCredentials {
  token: string;
  accountId: string;
  ownerUserId: string;
  baseUrl: string;
}

interface WeixinLoginDiagnostic {
  message: string;
  phase: WeixinLoginState['phase'];
  updatedAt: number;
}

interface PollState {
  cursor: string;
  contextTokens: Record<string, string>;
  seenIds: string[];
  cooldownUntil?: number;
}

type UpdateAcceptance = 'accepted' | 'cooldown' | 'retry';

interface OutboxEntry {
  id: string;
  generation: number;
  accountId: string;
  to: string;
  contextToken: string;
  content: string;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
}

type PendingReply = Pick<OutboxEntry, 'accountId' | 'to' | 'contextToken' | 'content'> & {
  generation: number;
};

function responseErrorCode(response: { ret?: number; errcode?: number }): number | null {
  const codes = [response.ret, response.errcode].filter((code): code is number => code != null && code !== 0);
  if (codes.includes(-14)) return -14;
  return codes[0] ?? null;
}

interface ChannelOptions {
  fetchImpl?: typeof fetch;
  qrToDataUrl?: (content: string) => Promise<string>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  ingressService?: Pick<ChannelIngressService, 'ingest' | 'linkTask' | 'recordOutbound'>;
  taskPlanner: ChannelTaskPlanner;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new Error('aborted'));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

function errorText(error: unknown, secrets: readonly string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, '[REDACTED]');
  }
  return message;
}

export class WeixinChannel {
  private generation = 0;
  private active = false;
  private monitorAbort: AbortController | null = null;
  private loginAbort: AbortController | null = null;
  private loginAttempt = 0;
  private loginCommittedAttempt = 0;
  private loginAttemptActive = false;
  private verifyCode: string | null = null;
  private stateListeners = new Set<() => void>();
  private outboxDrain: Promise<void> | null = null;
  private outboxDrainRequested = false;
  private loginState: WeixinLoginState = {
    phase: 'IDLE',
    qrDataUrl: null,
    message: '尚未开始扫码连接',
    updatedAt: Date.now()
  };
  private readonly fetchImpl: typeof fetch;
  private readonly qrToDataUrl: (content: string) => Promise<string>;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly ingressService?: Pick<ChannelIngressService, 'ingest' | 'linkTask' | 'recordOutbound'>;
  private readonly taskPlanner: ChannelTaskPlanner;
  private lastStatus = '';
  private activeClient: ILinkClient | null = null;
  private activeAccountId: string | null = null;
  private loginRestore: { active: boolean; status: string; state: WeixinLoginState } | null = null;
  private pendingActivation: (() => void) | null = null;
  private disposePromise: Promise<void> | null = null;

  constructor(
    private db: Database,
    private orchestrator: Orchestrator,
    options: ChannelOptions
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.qrToDataUrl = options.qrToDataUrl ?? (async (content) => {
      const QRCode = (await import('qrcode')).default;
      return QRCode.toDataURL(content, { width: 280, margin: 2, errorCorrectionLevel: 'M' });
    });
    this.sleep = options.sleep ?? sleepWithAbort;
    this.now = options.now ?? Date.now;
    this.ingressService = options.ingressService;
    this.taskPlanner = options.taskPlanner;
    const diagnostic = this.db.getSetting<WeixinLoginDiagnostic | null>(WEIXIN_LAST_ERROR_REF, null);
    if (this.hasPendingCredentials()) {
      this.loginState = {
        phase: 'IDLE',
        qrDataUrl: null,
        message: diagnostic?.message
          ? `上次微信授权已确认但未完成：${diagnostic.message}。重新生成二维码即可恢复。`
          : '检测到上次已确认的微信授权，重新生成二维码即可恢复。',
        updatedAt: diagnostic?.updatedAt ?? this.now()
      };
    }
  }

  isActive(): boolean {
    return this.active;
  }

  onStateChange(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  getLoginState(): WeixinLoginState {
    return { ...this.loginState };
  }

  /** 打开一个短期扫码会话；后台轮询结果通过 getLoginState 获取。 */
  async startLogin(onActivated?: () => void): Promise<WeixinLoginState> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥库不可用，无法保存微信凭据');
    this.loginAbort?.abort();
    const attempt = ++this.loginAttempt;
    this.loginCommittedAttempt = 0;
    this.loginAttemptActive = true;
    this.loginRestore ??= {
      active: this.active,
      status: this.lastStatus || (this.readCredentials() ? 'DISABLED' : 'UNCONFIGURED'),
      state: this.getLoginState()
    };
    const gen = this.generation;
    this.verifyCode = null;
    this.pendingActivation = onActivated ?? null;
    if (!this.active) this.setStatus('CONNECTING');
    this.updateLoginState('WAITING_SCAN', null, '正在生成微信授权二维码…');

    const abort = new AbortController();
    this.loginAbort = abort;
    const client = new ILinkClient(ILINK_DEFAULT_BASE_URL, undefined, this.fetchImpl);
    const pending = this.readPendingCredentials();
    const committed = this.readCredentials();
    const existing = pending ?? committed;
    const retainExistingPollState = pending == null && committed != null;

    try {
      const qr = await client.createQrCode(existing ? [existing.token] : [], abort.signal);
      if (gen !== this.generation || attempt !== this.loginAttempt || abort.signal.aborted) return this.getLoginState();
      if (!qr.qrcode || !qr.qrcode_img_content) throw new Error('微信未返回有效二维码');
      const dataUrl = await this.qrToDataUrl(qr.qrcode_img_content);
      if (gen !== this.generation || attempt !== this.loginAttempt || abort.signal.aborted) return this.getLoginState();
      this.updateLoginState('WAITING_SCAN', dataUrl, '请用手机微信扫描二维码并确认连接');
      void this.runLoginLoop(gen, attempt, client, qr.qrcode, existing, retainExistingPollState, 0, this.now() + QR_LOGIN_TIMEOUT_MS, abort.signal);
    } catch (error) {
      if (gen === this.generation && attempt === this.loginAttempt && !abort.signal.aborted) {
        this.failLogin(error, existing ? [existing.token] : []);
      }
    }
    return this.getLoginState();
  }

  submitVerifyCode(code: string): WeixinLoginState {
    if (this.loginState.phase !== 'VERIFY_REQUIRED') throw new Error('当前扫码流程不需要配对码');
    const normalized = code.trim();
    if (!/^\d{1,12}$/.test(normalized)) throw new Error('配对码只能包含 1-12 位数字');
    this.verifyCode = normalized;
    this.updateLoginState('SCANNED', this.loginState.qrDataUrl, '正在验证配对码…');
    return this.getLoginState();
  }

  cancelLogin() {
    if (this.loginState.phase === 'CONNECTED' || this.loginCommittedAttempt === this.loginAttempt) return;
    this.loginAttempt++;
    this.loginAbort?.abort();
    this.loginAbort = null;
    this.loginAttemptActive = false;
    this.verifyCode = null;
    this.pendingActivation = null;
    const restore = this.loginRestore;
    this.loginRestore = null;
    if (restore?.active && this.active) {
      this.updateLoginState(restore.state.phase, restore.state.qrDataUrl, restore.state.message);
    } else if (restore?.active) {
      this.updateLoginState('IDLE', null, '已取消扫码连接，原微信会话当前不可用');
    } else {
      this.updateLoginState('IDLE', null, this.hasPendingCredentials()
        ? '已暂停验证；微信授权已加密保存在本机，重新生成二维码即可恢复'
        : '已取消扫码连接');
      this.setStatus(this.readCredentials() ? 'DISABLED' : 'UNCONFIGURED');
    }
  }

  /** 应用启动时用已加密保存的会话恢复长轮询。 */
  async connect(): Promise<{ ok: boolean; message: string }> {
    const credentials = this.readCredentials();
    if (!credentials) {
      this.setStatus('UNCONFIGURED');
      return { ok: false, message: '请先扫码连接微信 iLink Bot' };
    }
    const gen = ++this.generation;
    this.stopWorkers();
    this.active = true;
    this.setStatus('CONNECTING');
    this.updateLoginState('CONNECTED', null, '正在恢复微信 iLink 连接…');
    const abort = new AbortController();
    this.monitorAbort = abort;
    const client = new ILinkClient(credentials.baseUrl, credentials.token, this.fetchImpl);
    this.activeClient = client;
    this.activeAccountId = credentials.accountId;
    const pollState = this.readPollState();

    try {
      if (pollState.cooldownUntil && pollState.cooldownUntil > this.now()) {
        this.setStatus('RECONNECTING');
        this.updateLoginState('CONNECTED', null, '微信 iLink 会话冷却中，将自动恢复');
        this.startMonitor(gen, credentials, client, pollState, false);
        return { ok: true, message: '微信 iLink 会话冷却中，将自动恢复' };
      }
      try { await client.notifyStart(abort.signal); } catch { /* 在线通知为 best-effort */ }
      if (abort.signal.aborted || gen !== this.generation || !this.active) return { ok: false, message: '微信 iLink 连接已取消' };
      const response = await client.getUpdates(pollState.cursor, 5_000, abort.signal);
      if (abort.signal.aborted || gen !== this.generation || !this.active) return { ok: false, message: '微信 iLink 连接已取消' };
      const acceptance = await this.acceptUpdateResponse(gen, credentials, client, pollState, response, abort.signal);
      if (acceptance !== 'accepted') {
        if (abort.signal.aborted || gen !== this.generation || !this.active) return { ok: false, message: '微信 iLink 连接已取消' };
        if (acceptance === 'retry') {
          this.setStatus('RECONNECTING');
          this.updateLoginState('CONNECTED', null, '微信消息处理暂未完成，将自动重试');
          this.startMonitor(gen, credentials, client, pollState, false);
          return { ok: true, message: '微信 iLink 已连接，消息处理将自动重试' };
        }
        this.startMonitor(gen, credentials, client, pollState, false);
        return { ok: true, message: '微信 iLink 会话冷却中，将自动恢复' };
      }
      this.setStatus('ONLINE');
      this.updateLoginState('CONNECTED', null, '微信 iLink Bot 已连接');
      this.startMonitor(gen, credentials, client, pollState, false);
      this.db.audit({ id: randomUUID(), actor: 'system', action: 'channel.weixin.ilink.connect', target: credentials.accountId, result: 'ok' });
      return { ok: true, message: '微信 iLink Bot 已连接' };
    } catch (error) {
      if (abort.signal.aborted || gen !== this.generation) return { ok: false, message: '微信 iLink 连接已取消' };
      this.active = false;
      this.stopMonitor();
      if (error instanceof ILinkHttpError && [401, 403].includes(error.status)) {
        this.setStatus('AUTH_EXPIRED');
        this.updateLoginState('ERROR', null, '微信授权已过期，请重新扫码连接');
        return { ok: false, message: '微信授权已过期，请重新扫码连接' };
      }
      this.setStatus('ERROR');
      const message = errorText(error, [credentials.token]);
      this.updateLoginState('ERROR', null, message);
      return { ok: false, message: `连接失败：${message}` };
    }
  }

  async disconnect(): Promise<void> {
    this.generation++;
    this.active = false;
    const client = this.activeClient;
    this.stopWorkers();
    this.db.raw.prepare('DELETE FROM settings WHERE key IN (?, ?, ?, ?, ?)').run(
      WEIXIN_SESSION_REF,
      WEIXIN_POLL_STATE_REF,
      WEIXIN_PENDING_SESSION_REF,
      WEIXIN_OUTBOX_REF,
      WEIXIN_LAST_ERROR_REF
    );
    this.db.flush();
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'channel.weixin.ilink.logout', target: CHANNEL_ID, result: 'ok' });
    this.verifyCode = null;
    this.loginRestore = null;
    this.pendingActivation = null;
    this.updateLoginState('IDLE', null, '微信 iLink Bot 已停用');
    this.setStatus('DISABLED');
    if (client) await client.notifyStop().catch(() => {});
  }

  /** 仅释放进程内 worker；保留授权、游标与数据库状态供下次启动恢复。 */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = (async () => {
      this.generation++;
      this.active = false;
      const client = this.activeClient;
      this.stopWorkers();
      if (client) await client.notifyStop().catch(() => {});
    })();
    return this.disposePromise;
  }

  private async runLoginLoop(
    gen: number,
    attempt: number,
    client: ILinkClient,
    initialQrCode: string,
    existing: ILinkCredentials | null,
    retainExistingPollState: boolean,
    refreshes: number,
    deadline: number,
    signal: AbortSignal
  ): Promise<void> {
    let qrCode = initialQrCode;
    let qrRefreshes = refreshes;
    let pollingBaseUrl = ILINK_DEFAULT_BASE_URL;

    while (gen === this.generation && attempt === this.loginAttempt && !signal.aborted) {
      if (this.now() >= deadline) {
        this.loginAbort = null;
        this.loginAttemptActive = false;
        this.updateLoginState('EXPIRED', null, '扫码连接已超时，请重新生成二维码');
        const restore = this.loginRestore;
        if (!restore?.active) this.setStatus(this.readCredentials() ? 'DISABLED' : 'UNCONFIGURED');
        return;
      }
      if (this.loginState.phase === 'VERIFY_REQUIRED' && !this.verifyCode) {
        try { await this.sleep(300, signal); } catch { return; }
        continue;
      }
      const code = this.verifyCode ?? undefined;
      try {
        client.setBaseUrl(pollingBaseUrl);
        const status = await client.pollQrCode(qrCode, code, signal);
        if (gen !== this.generation || attempt !== this.loginAttempt || signal.aborted) return;
        switch (status.status) {
          case 'wait':
            break;
          case 'scaned':
            this.verifyCode = null;
            this.updateLoginState('SCANNED', this.loginState.qrDataUrl, '二维码已扫描，请在手机微信中确认');
            break;
          case 'need_verifycode':
            this.verifyCode = null;
            this.updateLoginState('VERIFY_REQUIRED', this.loginState.qrDataUrl, code ? '配对码不正确，请重新输入' : '请输入手机微信中显示的数字配对码');
            continue;
          case 'scaned_but_redirect': {
            const redirected = sanitizeIlinkRedirectHost(status.redirect_host);
            if (!redirected) throw new Error('微信返回了不受信任的接入节点');
            pollingBaseUrl = redirected;
            this.updateLoginState('SCANNED', this.loginState.qrDataUrl, '已扫描，正在切换微信接入节点…');
            break;
          }
          case 'expired':
          case 'verify_code_blocked': {
            qrRefreshes++;
            if (qrRefreshes > MAX_QR_REFRESHES) {
              this.updateLoginState('EXPIRED', null, status.status === 'expired' ? '二维码多次过期，请重新开始' : '配对码错误次数过多，请稍后重试');
              const restore = this.loginRestore;
              if (!restore?.active) this.setStatus(this.readCredentials() ? 'DISABLED' : 'UNCONFIGURED');
              return;
            }
            client.setBaseUrl(ILINK_DEFAULT_BASE_URL);
            pollingBaseUrl = ILINK_DEFAULT_BASE_URL;
            const refreshed = await client.createQrCode(existing ? [existing.token] : [], signal);
            if (gen !== this.generation || attempt !== this.loginAttempt || signal.aborted) return;
            qrCode = refreshed.qrcode;
            this.verifyCode = null;
            const dataUrl = await this.qrToDataUrl(refreshed.qrcode_img_content);
            if (gen !== this.generation || attempt !== this.loginAttempt || signal.aborted) return;
            this.updateLoginState('WAITING_SCAN', dataUrl, '二维码已刷新，请重新扫描');
            break;
          }
          case 'binded_redirect':
            if (!existing) throw new Error('该微信已绑定，但本机没有可恢复的加密会话，请稍后重新扫码');
            await this.activateLogin(gen, attempt, existing, retainExistingPollState, signal);
            return;
          case 'confirmed': {
            const baseUrl = sanitizeIlinkBaseUrl(status.baseurl) ?? sanitizeIlinkBaseUrl(pollingBaseUrl);
            if (!status.bot_token || !status.ilink_bot_id || !status.ilink_user_id || !baseUrl) {
              throw new Error('微信授权成功，但返回的会话信息不完整');
            }
            const confirmedCredentials = {
              token: status.bot_token,
              accountId: status.ilink_bot_id,
              ownerUserId: status.ilink_user_id,
              baseUrl
            };
            // confirmed 表示服务端已完成绑定；先加密保存，取消或崩溃后可通过 binded_redirect 恢复。
            this.savePendingCredentials(confirmedCredentials);
            this.db.flush();
            await this.activateLogin(gen, attempt, confirmedCredentials, false, signal);
            return;
          }
        }
      } catch (error) {
        if (signal.aborted || gen !== this.generation || attempt !== this.loginAttempt) return;
        this.failLogin(error, existing ? [existing.token] : []);
        return;
      }
      try { await this.sleep(1000, signal); } catch { return; }
    }
  }

  private async activateLogin(
    gen: number,
    attempt: number,
    credentials: ILinkCredentials,
    retainPollState: boolean,
    signal: AbortSignal
  ) {
    if (gen !== this.generation || attempt !== this.loginAttempt || signal.aborted) return;
    this.updateLoginState('VERIFYING', null, '正在验证微信 iLink 会话…');
    const client = new ILinkClient(credentials.baseUrl, credentials.token, this.fetchImpl);
    const pollState: PollState = retainPollState
      ? this.readPollState()
      : { cursor: '', contextTokens: {}, seenIds: [] };
    let switched = false;

    try {
      try { await client.notifyStart(signal); } catch { /* 在线通知为 best-effort */ }
      const response = await client.getUpdates(pollState.cursor, 5_000, signal);
      if (signal.aborted || gen !== this.generation || attempt !== this.loginAttempt) return;
      const code = responseErrorCode(response);
      if (code != null && code !== -14) {
        throw new Error(`微信拉取消息失败：${response.errmsg ?? `ret=${code}`}`);
      }

      this.db.transaction(() => {
        this.pendingActivation?.();
        this.saveCredentials(credentials);
        this.deletePendingCredentials();
        this.clearLoginDiagnostic();
        this.savePollState(pollState, false);
        this.db.raw.prepare("UPDATE channels SET account_name = ? WHERE id = 'ch-weixin'").run('微信 iLink Bot');
        this.db.audit({ id: randomUUID(), actor: 'admin', action: 'channel.weixin.ilink.login', target: credentials.accountId, result: 'ok' });
      });
      this.loginCommittedAttempt = attempt;

      const monitorGen = ++this.generation;
      switched = true;
      this.stopMonitor();
      this.active = true;
      const abort = new AbortController();
      this.monitorAbort = abort;
      this.activeClient = client;
      this.activeAccountId = credentials.accountId;
      const acceptance = await this.acceptUpdateResponse(monitorGen, credentials, client, pollState, response, abort.signal);
      if (abort.signal.aborted || monitorGen !== this.generation || !this.active) return;

      this.loginAttemptActive = false;
      this.loginAbort = null;
      this.loginRestore = null;
      this.pendingActivation = null;
      if (acceptance === 'retry') this.setStatus('RECONNECTING');
      this.updateLoginState('CONNECTED', null, acceptance === 'accepted'
        ? '微信 iLink Bot 已连接，仅接收扫码账号的私聊消息'
        : acceptance === 'cooldown'
          ? '微信 iLink 会话冷却中，将自动恢复'
          : '微信消息处理暂未完成，将自动重试');
      this.startMonitor(monitorGen, credentials, client, pollState, false);
    } catch (error) {
      if ((signal.aborted || attempt !== this.loginAttempt) && this.loginCommittedAttempt !== attempt) return;
      if (!switched && gen !== this.generation) return;
      if (switched) {
        this.active = false;
        this.stopMonitor();
        this.loginRestore = null;
      }
      this.failLogin(error, [credentials.token]);
    }
  }

  private failLogin(error: unknown, secrets: readonly string[] = []) {
    const message = errorText(error, secrets);
    const auth = error instanceof ILinkHttpError && [401, 403].includes(error.status);
    this.loginAbort = null;
    this.loginAttemptActive = false;
    this.pendingActivation = null;
    const restore = this.loginRestore;
    if (!restore?.active) {
      this.active = false;
      this.setStatus(auth ? 'AUTH_EXPIRED' : 'ERROR');
    }
    this.updateLoginState('ERROR', null, message);
    this.db.setSetting(WEIXIN_LAST_ERROR_REF, {
      message: message.slice(0, 500),
      phase: 'ERROR',
      updatedAt: this.now()
    });
    this.db.audit({
      id: randomUUID(), actor: 'system', action: 'channel.weixin.ilink.login',
      target: CHANNEL_ID, result: auth ? 'failed:auth' : 'failed:activation'
    });
    notify(this.db, '微信 iLink 连接失败', message);
  }

  private startMonitor(
    gen: number,
    credentials: ILinkCredentials,
    client = new ILinkClient(credentials.baseUrl, credentials.token, this.fetchImpl),
    pollState = this.readPollState(),
    sendStart = true
  ) {
    let abort = this.monitorAbort;
    if (!abort || abort.signal.aborted) {
      abort = new AbortController();
      this.monitorAbort = abort;
    }
    this.activeClient = client;
    this.activeAccountId = credentials.accountId;
    this.discardOutboxForOtherAccounts(credentials.accountId);
    this.kickOutboxDrain();
    void (async () => {
      if (sendStart) {
        try { await client.notifyStart(abort.signal); } catch { /* 在线通知为 best-effort */ }
      }
      if (abort.signal.aborted || gen !== this.generation || !this.active) return;
      await this.monitorLoop(gen, credentials, client, pollState, abort.signal);
    })();
  }

  private async monitorLoop(gen: number, credentials: ILinkCredentials, client: ILinkClient, pollState: PollState, signal: AbortSignal) {
    let timeoutMs = 35_000;
    let failures = 0;

    while (this.active && gen === this.generation && !signal.aborted) {
      try {
        if (pollState.cooldownUntil && pollState.cooldownUntil > this.now()) {
          this.setStatus('RECONNECTING');
          try { await this.sleep(pollState.cooldownUntil - this.now(), signal); } catch { return; }
          continue;
        }
        const response = await client.getUpdates(pollState.cursor, timeoutMs, signal);
        if (signal.aborted || gen !== this.generation) return;
        const acceptance = await this.acceptUpdateResponse(gen, credentials, client, pollState, response, signal);
        if (acceptance === 'retry') throw new Error('微信渠道任务未持久化，将重试当前消息');
        if (acceptance === 'cooldown') {
          failures = 0;
          continue;
        }
        failures = 0;
        if (response.longpolling_timeout_ms && response.longpolling_timeout_ms > 0) {
          timeoutMs = Math.min(Math.max(response.longpolling_timeout_ms, 5_000), 60_000);
        }
      } catch (error) {
        if (signal.aborted || gen !== this.generation) return;
        if (error instanceof ILinkHttpError && [401, 403].includes(error.status)) {
          this.active = false;
          this.setStatus('AUTH_EXPIRED');
          if (!this.loginAttemptActive) this.updateLoginState('ERROR', null, '微信授权已过期，请重新扫码连接');
          return;
        }
        failures++;
        this.setStatus('RECONNECTING');
        if (failures === 3) notify(this.db, '微信 iLink 正在重连', '连续拉取消息失败，已进入退避重试。');
        const delay = failures >= 3 ? 30_000 : 2_000;
        try { await this.sleep(delay, signal); } catch { return; }
      }
    }
  }

  private async acceptUpdateResponse(
    gen: number,
    credentials: ILinkCredentials,
    client: ILinkClient,
    pollState: PollState,
    response: Awaited<ReturnType<ILinkClient['getUpdates']>>,
    signal: AbortSignal
  ): Promise<UpdateAcceptance> {
    const code = responseErrorCode(response);
    if (code != null) {
      if (code === -14) {
        pollState.cooldownUntil = this.now() + SESSION_COOLDOWN_MS;
        this.savePollState(pollState);
        this.setStatus('RECONNECTING');
        if (!this.loginAttemptActive) this.updateLoginState('CONNECTED', null, '微信 iLink 会话冷却中，将在一小时后自动恢复');
        notify(this.db, '微信 iLink 会话暂时冷却', '腾讯接口要求暂停一小时，届时将自动恢复，无需重新扫码。');
        return 'cooldown';
      }
      throw new Error(`微信拉取消息失败：${response.errmsg ?? `ret=${code}`}`);
    }

    if (response.longpolling_timeout_ms && response.longpolling_timeout_ms > 0) {
      // The monitor updates its own timeout after this response.
    }
    const requestCursor = pollState.cursor;
    const nextCursor = response.get_updates_buf || requestCursor;
    for (const message of response.msgs ?? []) {
      const accepted = await this.handleMessage(gen, client, credentials, pollState, message);
      if (signal.aborted || gen !== this.generation) return 'retry';
      if (accepted === false) return 'retry';
      if (!accepted) continue;
      const candidate = this.withAcceptedMessage(pollState, accepted.key, accepted.from, accepted.contextToken);
      const savedCandidate = this.savePollState(candidate);
      Object.assign(pollState, savedCandidate);
      if (!savedCandidate.cooldownUntil) delete pollState.cooldownUntil;
    }
    const committed = { ...pollState, cursor: nextCursor, cooldownUntil: undefined };
    const savedCommitted = this.savePollState(committed);
    Object.assign(pollState, savedCommitted);
    if (!savedCommitted.cooldownUntil) delete pollState.cooldownUntil;
    if (savedCommitted.cooldownUntil && savedCommitted.cooldownUntil > this.now()) {
      this.setStatus('RECONNECTING');
      if (!this.loginAttemptActive) this.updateLoginState('CONNECTED', null, '微信 iLink 会话冷却中，将在一小时后自动恢复');
      return 'cooldown';
    }
    this.setStatus('ONLINE');
    if (!this.loginAttemptActive) this.updateLoginState('CONNECTED', null, '微信 iLink Bot 已连接');
    return 'accepted';
  }

  private async handleMessage(
    gen: number,
    client: ILinkClient,
    credentials: ILinkCredentials,
    pollState: PollState,
    message: ILinkMessage
  ): Promise<{ key: string | null; from: string; contextToken: string } | null | false> {
    if (message.message_type !== 1 || message.group_id) return null;
    const from = String(message.from_user_id ?? '').trim();
    if (!from || from !== credentials.ownerUserId) return null;

    const key = ilinkMessageKey(message);
    // A durable upstream ID is required because the poll cursor is committed
    // after dispatch. Without one, a crash in that window can duplicate work.
    if (!key || pollState.seenIds.includes(key)) return null;

    const contextToken = String(message.context_token ?? '').trim();
    if (!contextToken) return null;

    const text = extractIlinkText(message);
    const send = (content: string, taskId?: string) => this.enqueueReply({
      generation: gen,
      accountId: credentials.accountId,
      to: from,
      contextToken,
      content
    });
    const pendingAcks: string[] = [];
    const durable = await dispatchChannelTask({
      db: this.db,
      orchestrator: this.orchestrator,
      taskPlanner: this.taskPlanner,
      channelId: CHANNEL_ID,
      text,
      externalIdentity: `${credentials.accountId}:${from}`,
      externalIdentityDisplayName: from,
      conversationKey: `direct:${from}`,
      sourceKey: `${credentials.accountId}:${key}`,
      metadata: { accountId: credentials.accountId, messageType: message.message_type ?? null },
      ingressService: this.ingressService,
      // A failed canonical dispatch keeps the upstream cursor unchanged and is
      // retried. Buffer synchronous acknowledgements so that retrying the same
      // message cannot enqueue an unbounded stream of failure notices.
      ack: (content) => { pendingAcks.push(content); },
      final: send
    });
    if (!durable) return false;
    for (const content of pendingAcks) send(content);
    return { key, from, contextToken };
  }

  private withAcceptedMessage(state: PollState, key: string | null, from: string, contextToken: string): PollState {
    const seenIds = key ? [...state.seenIds.filter((item) => item !== key), key].slice(-MAX_SEEN_IDS) : [...state.seenIds];
    const contexts = { ...state.contextTokens, [from]: contextToken };
    const contextEntries = Object.entries(contexts).slice(-MAX_CONTEXTS);
    return { ...state, seenIds, contextTokens: Object.fromEntries(contextEntries) };
  }

  private enqueueReply(reply: PendingReply) {
    if (!this.active || reply.generation !== this.generation || reply.accountId !== this.activeAccountId) return;
    const chunks: string[] = [];
    for (let i = 0; i < reply.content.length; i += MAX_REPLY_CHARS) chunks.push(reply.content.slice(i, i + MAX_REPLY_CHARS));
    if (chunks.length === 0) return;
    try {
      const appended = chunks.map((content) => ({
        id: randomUUID(),
        generation: reply.generation,
        accountId: reply.accountId,
        to: reply.to,
        contextToken: reply.contextToken,
        content,
        createdAt: this.now(),
        attempts: 0,
        nextAttemptAt: 0
      }));
      this.persistOutbox([...this.readOutbox(), ...appended]);
      this.kickOutboxDrain();
    } catch (error) {
      notify(this.db, '微信回复保存失败', errorText(error));
    }
  }

  private kickOutboxDrain() {
    if (!this.active || !this.activeClient || this.monitorAbort?.signal.aborted || this.readOutbox().length === 0) return;
    if (this.outboxDrain) {
      this.outboxDrainRequested = true;
      return;
    }
    this.outboxDrainRequested = false;
    const worker = this.drainOutbox().catch((error) => {
      notify(this.db, '微信消息发送失败', errorText(error));
    }).finally(() => {
      if (this.outboxDrain === worker) this.outboxDrain = null;
      const restart = this.outboxDrainRequested;
      this.outboxDrainRequested = false;
      if (restart || (this.active && this.readOutbox().length > 0)) this.kickOutboxDrain();
    });
    this.outboxDrain = worker;
  }

  private async drainOutbox() {
    while (this.active) {
      const gen = this.generation;
      const client = this.activeClient;
      const accountId = this.activeAccountId;
      const signal = this.monitorAbort?.signal;
      const entries = this.readOutbox();
      const entry = entries[0];
      if (!client || !accountId || !signal || signal.aborted || !entry) return;
      if (entry.accountId !== accountId) {
        this.persistOutbox(entries.filter((candidate) => candidate.id !== entry.id));
        notify(this.db, '微信回复已丢弃', '回复属于已切换的微信账号，未向当前账号发送。');
        continue;
      }

      const cooldownUntil = this.readPollState().cooldownUntil ?? 0;
      if (cooldownUntil > this.now()) {
        try { await this.sleep(cooldownUntil - this.now(), signal); } catch { return; }
        continue;
      }
      if (entry.nextAttemptAt > this.now()) {
        try { await this.sleep(entry.nextAttemptAt - this.now(), signal); } catch { return; }
        continue;
      }

      try {
        await client.sendText(entry.to, entry.content, entry.contextToken, signal, entry.id);
      } catch (error) {
        if (signal.aborted || gen !== this.generation || !this.active) return;

        if (error instanceof ILinkProtocolError && error.code === -14) {
          const pollState = this.readPollState();
          pollState.cooldownUntil = this.now() + SESSION_COOLDOWN_MS;
          this.savePollState(pollState);
          this.db.flush();
          this.setStatus('RECONNECTING');
          if (!this.loginAttemptActive) this.updateLoginState('CONNECTED', null, '微信 iLink 会话冷却中，将在一小时后自动恢复');
          notify(this.db, '微信 iLink 会话暂时冷却', '腾讯接口要求暂停一小时，已保留待发回复。');
          try { await this.sleep(SESSION_COOLDOWN_MS, signal); } catch { return; }
          continue;
        }

        if (error instanceof ILinkHttpError && [401, 403].includes(error.status)) {
          // Keep the durable reply for a future re-authorization. Treating an
          // auth failure as a permanent message error would silently lose it.
          this.active = false;
          this.setStatus('AUTH_EXPIRED');
          if (!this.loginAttemptActive) this.updateLoginState('ERROR', null, '微信授权已过期，请重新扫码连接');
          notify(this.db, '微信 iLink 授权已过期', '已保留待发回复，重新扫码连接后将继续发送。');
          this.stopMonitor();
          return;
        }

        const permanent = error instanceof ILinkProtocolError
          || (error instanceof ILinkHttpError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status));
        if (permanent) {
          this.persistOutbox(this.readOutbox().filter((candidate) => candidate.id !== entry.id));
          notify(this.db, '微信回复已丢弃', `发送遭到永久错误，已继续处理后续回复：${errorText(error)}`);
          continue;
        }

        const attempts = entry.attempts + 1;
        if (attempts >= OUTBOX_MAX_ATTEMPTS) {
          this.persistOutbox(this.readOutbox().filter((candidate) => candidate.id !== entry.id));
          notify(this.db, '微信回复已丢弃', `连续发送失败 ${attempts} 次，已继续处理后续回复：${errorText(error)}`);
          continue;
        }

        const delay = Math.min(OUTBOX_RETRY_BASE_MS * (2 ** (attempts - 1)), OUTBOX_RETRY_MAX_MS);
        const nextAttemptAt = this.now() + delay;
        this.persistOutbox(this.readOutbox().map((candidate) => candidate.id === entry.id
          ? { ...candidate, attempts, nextAttemptAt }
          : candidate));
        notify(this.db, '微信消息发送失败', `${errorText(error)}，将在 ${Math.ceil(delay / 1_000)} 秒后重试`);
        try { await this.sleep(Math.max(0, nextAttemptAt - this.now()), signal); } catch { return; }
        continue;
      }

      this.persistOutbox(this.readOutbox().filter((candidate) => candidate.id !== entry.id));
    }
  }

  private stopWorkers() {
    this.stopMonitor();
    this.loginAttempt++;
    this.loginAbort?.abort();
    this.loginAbort = null;
    this.loginAttemptActive = false;
    this.pendingActivation = null;
  }

  private stopMonitor() {
    this.monitorAbort?.abort();
    this.monitorAbort = null;
    this.activeClient = null;
    this.activeAccountId = null;
  }

  private setStatus(status: string) {
    if (status === this.lastStatus) return;
    this.lastStatus = status;
    if (status === 'ONLINE') {
      this.db.raw.prepare(`UPDATE channels SET status = ?, last_connected_at = ? WHERE id = '${CHANNEL_ID}'`).run(status, this.now());
    } else {
      this.db.raw.prepare(`UPDATE channels SET status = ? WHERE id = '${CHANNEL_ID}'`).run(status);
    }
    this.emitStateChange();
  }

  private updateLoginState(phase: WeixinLoginState['phase'], qrDataUrl: string | null, message: string) {
    this.loginState = { phase, qrDataUrl, message, updatedAt: this.now() };
    this.emitStateChange();
  }

  private emitStateChange() {
    for (const listener of this.stateListeners) listener();
  }

  private encryptSetting(key: string, value: unknown) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥库不可用');
    this.db.setSetting(key, safeStorage.encryptString(JSON.stringify(value)).toString('base64'));
  }

  private decryptSetting<T>(key: string): T | null {
    const encrypted = this.db.getSetting<string | null>(key, null);
    if (!encrypted || !safeStorage.isEncryptionAvailable()) return null;
    try {
      return JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64'))) as T;
    } catch {
      return null;
    }
  }

  private saveCredentials(credentials: ILinkCredentials) {
    this.encryptSetting(WEIXIN_SESSION_REF, credentials);
  }

  private savePendingCredentials(credentials: ILinkCredentials) {
    this.encryptSetting(WEIXIN_PENDING_SESSION_REF, credentials);
    this.db.audit({
      id: randomUUID(),
      actor: 'system',
      action: 'channel.weixin.ilink.pending.store',
      target: credentials.accountId,
      result: 'encrypted'
    });
  }

  private readPendingCredentials(): ILinkCredentials | null {
    return this.readEncryptedCredentials(WEIXIN_PENDING_SESSION_REF);
  }

  private hasPendingCredentials(): boolean {
    return Boolean(this.db.getSetting<string | null>(WEIXIN_PENDING_SESSION_REF, null));
  }

  private deletePendingCredentials() {
    this.db.raw.prepare('DELETE FROM settings WHERE key = ?').run(WEIXIN_PENDING_SESSION_REF);
  }

  private clearLoginDiagnostic() {
    this.db.raw.prepare('DELETE FROM settings WHERE key = ?').run(WEIXIN_LAST_ERROR_REF);
  }

  private readCredentials(): ILinkCredentials | null {
    return this.readEncryptedCredentials(WEIXIN_SESSION_REF);
  }

  private readEncryptedCredentials(key: string): ILinkCredentials | null {
    const value = this.decryptSetting<ILinkCredentials>(key);
    const baseUrl = sanitizeIlinkBaseUrl(value?.baseUrl);
    if (!value?.token || !value.accountId || !value.ownerUserId || !baseUrl) return null;
    return { ...value, baseUrl };
  }

  private persistOutbox(entries: OutboxEntry[]) {
    if (entries.length > 0) this.encryptSetting(WEIXIN_OUTBOX_REF, entries);
    else this.db.raw.prepare('DELETE FROM settings WHERE key = ?').run(WEIXIN_OUTBOX_REF);
    this.db.flush();
  }

  private discardOutboxForOtherAccounts(accountId: string) {
    const entries = this.readOutbox();
    const retained = entries.filter((entry) => entry.accountId === accountId);
    if (retained.length === entries.length) return;
    this.persistOutbox(retained);
    notify(this.db, '微信回复已丢弃', '未发送属于已切换微信账号的历史回复。');
  }

  private readOutbox(): OutboxEntry[] {
    const value = this.decryptSetting<unknown>(WEIXIN_OUTBOX_REF);
    if (!Array.isArray(value)) return [];
    const entries: OutboxEntry[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      const candidate = entry as Partial<OutboxEntry>;
      if (typeof candidate.id !== 'string' || candidate.id.length === 0
        || typeof candidate.generation !== 'number' || !Number.isFinite(candidate.generation)
        || typeof candidate.accountId !== 'string' || candidate.accountId.length === 0
        || typeof candidate.to !== 'string' || candidate.to.length === 0
        || typeof candidate.contextToken !== 'string' || candidate.contextToken.length === 0
        || typeof candidate.content !== 'string' || candidate.content.length === 0
        || typeof candidate.createdAt !== 'number' || !Number.isFinite(candidate.createdAt)) continue;
      entries.push({
        id: candidate.id,
        generation: candidate.generation,
        accountId: candidate.accountId,
        to: candidate.to,
        contextToken: candidate.contextToken,
        content: candidate.content,
        createdAt: candidate.createdAt,
        attempts: typeof candidate.attempts === 'number' && Number.isFinite(candidate.attempts) && candidate.attempts >= 0
          ? Math.floor(candidate.attempts)
          : 0,
        nextAttemptAt: typeof candidate.nextAttemptAt === 'number' && Number.isFinite(candidate.nextAttemptAt) && candidate.nextAttemptAt >= 0
          ? candidate.nextAttemptAt
          : 0
      });
    }
    return entries;
  }

  private savePollState(state: PollState, preserveActiveCooldown = true): PollState {
    const now = this.now();
    const persisted = preserveActiveCooldown
      ? this.decryptSetting<Partial<PollState>>(WEIXIN_POLL_STATE_REF)
      : null;
    const cooldownUntil = Math.max(
      typeof state.cooldownUntil === 'number' && state.cooldownUntil > now ? state.cooldownUntil : 0,
      typeof persisted?.cooldownUntil === 'number' && persisted.cooldownUntil > now ? persisted.cooldownUntil : 0
    );
    const saved = { ...state, cooldownUntil: cooldownUntil || undefined };
    if (!saved.cooldownUntil) delete saved.cooldownUntil;
    this.encryptSetting(WEIXIN_POLL_STATE_REF, saved);
    return saved;
  }

  private readPollState(): PollState {
    const value = this.decryptSetting<Partial<PollState>>(WEIXIN_POLL_STATE_REF);
    return {
      cursor: typeof value?.cursor === 'string' ? value.cursor : '',
      contextTokens: value?.contextTokens && typeof value.contextTokens === 'object' ? value.contextTokens : {},
      seenIds: Array.isArray(value?.seenIds) ? value.seenIds.filter((item): item is string => typeof item === 'string').slice(-MAX_SEEN_IDS) : [],
      cooldownUntil: typeof value?.cooldownUntil === 'number' && Number.isFinite(value.cooldownUntil) ? value.cooldownUntil : undefined
    };
  }
}
