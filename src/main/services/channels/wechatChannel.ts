/**
 * 个人微信渠道：本地 Bot 桥接接口（个人微信无官方 Bot API，通过本机 bot 框架桥接）。
 * - 适配 WeChatFerry / wechaty 等本机框架暴露的 WebSocket 桥：地址仅允许
 *   回环 ws://127.0.0.1|localhost（本地优先，杜绝消息明文出网）或 wss://（自建加密网关）
 * - 桥接协议（通用 JSON，各框架可用轻量脚本适配）：
 *   下行收消息 { "type": "message", "from": "会话标识", "text": "内容" }
 *   上行回消息 { "type": "send_text", "to": "会话标识", "text": "内容", "token"?: "鉴权令牌" }
 *   可选鉴权：建连后先发 { "type": "auth", "token": "..." }，桥端回 { "type": "auth_result", "ok": bool }
 * - 令牌经 safeStorage 加密存储；断线指数退避自动重连
 * - 合规提示：个人微信自动化存在账号风控风险，仅建议小范围自用（限制文案随渠道卡片展示）
 */
import { randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';
import type { Database } from '../database.js';
import type { Orchestrator } from '../orchestrator.js';
import { notify } from '../notifier.js';
import { dispatchChannelTask, createWs, tryChannelApproval, type WsLike } from './common.js';
import type { ApprovalBroker } from '../approvalBroker.js';

export const WEIXIN_URL_SETTING = 'channel:weixin:bridgeUrl';
export const WEIXIN_TOKEN_REF = 'secret:channel:weixin';

const CHANNEL_ID = 'ch-weixin';
const AUTH_TIMEOUT_MS = 8000;
const MAX_REPLY_CHARS = 2000;

/** 桥接帧（下行） */
interface BridgeFrame {
  type?: string;
  ok?: boolean;
  from?: string;
  text?: string;
}

/** 桥接地址校验：仅允许回环 ws:// 或任意 wss:// */
export function sanitizeBridgeUrl(value: string): string | null {
  try {
    const u = new URL(value.trim());
    if (u.protocol === 'wss:') return u.toString();
    if (u.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return u.toString();
    return null;
  } catch {
    return null;
  }
}

export class WeixinChannel {
  /** 连接代际：disconnect/重建后旧连接的事件与定时器全部失效 */
  private generation = 0;
  private active = false;
  private ws: WsLike | null = null;
  private reconnectAttempts = 0;

  constructor(private db: Database, private orchestrator: Orchestrator, private broker: ApprovalBroker) {}

  isActive(): boolean {
    return this.active;
  }

  /** 保存桥接配置（令牌走 safeStorage，15.1） */
  saveCredentials(bridgeUrl: string, token: string) {
    const url = sanitizeBridgeUrl(bridgeUrl);
    if (!url) throw new Error('桥接地址仅允许本机 ws://127.0.0.1|localhost 或加密 wss://');
    this.db.setSetting(WEIXIN_URL_SETTING, url);
    if (token.trim()) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥库不可用');
      this.db.setSetting(WEIXIN_TOKEN_REF, safeStorage.encryptString(token.trim()).toString('base64'));
    }
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'channel.weixin.credentials', target: url, result: 'ok' });
  }

  private readConfig(): { url: string; token: string | null } | null {
    const url = this.db.getSetting<string>(WEIXIN_URL_SETTING, '');
    if (!url) return null;
    const b64 = this.db.getSetting<string | null>(WEIXIN_TOKEN_REF, null);
    let token: string | null = null;
    if (b64 && safeStorage.isEncryptionAvailable()) {
      try {
        token = safeStorage.decryptString(Buffer.from(b64, 'base64'));
      } catch {
        token = null;
      }
    }
    return { url, token };
  }

  private setStatus(status: string) {
    if (status === 'ONLINE') {
      this.db.raw.prepare(`UPDATE channels SET status = ?, last_connected_at = ? WHERE id = '${CHANNEL_ID}'`).run(status, Date.now());
    } else {
      this.db.raw.prepare(`UPDATE channels SET status = ? WHERE id = '${CHANNEL_ID}'`).run(status);
    }
  }

  /** 连接本地桥接（可选 auth 握手） */
  async connect(): Promise<{ ok: boolean; message: string }> {
    const cfg = this.readConfig();
    if (!cfg) {
      this.setStatus('UNCONFIGURED');
      return { ok: false, message: '请先保存本地 Bot 桥接地址（如 ws://127.0.0.1:8080/ws）' };
    }
    this.generation++;
    this.reconnectAttempts = 0;
    this.setStatus('CONNECTING');
    const r = await this.openOnce(this.generation, cfg);
    if (r.ok) {
      this.active = true;
      this.setStatus('ONLINE');
      this.db.audit({ id: randomUUID(), actor: 'system', action: 'channel.weixin.connect', target: cfg.url, result: 'ok' });
    }
    return r;
  }

  /** 停用：代际递增使旧连接回调失效，并关闭底层连接 */
  disconnect() {
    this.generation++;
    this.active = false;
    this.teardown();
    this.setStatus('DISABLED');
  }

  private teardown() {
    try {
      this.ws?.close();
    } catch {
      /* 已断开 */
    }
    this.ws = null;
  }

  /** 单次建连；配置了令牌则等待 auth_result，未配置则 open 即视为就绪 */
  private openOnce(gen: number, cfg: { url: string; token: string | null }): Promise<{ ok: boolean; message: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (ok: boolean, message: string) => {
        if (!settled) {
          settled = true;
          resolve({ ok, message });
        }
      };

      let ws: WsLike;

      createWs(cfg.url).then((socket) => {
        if (gen !== this.generation) { socket.close(); return; }
        ws = socket;
        this.ws = ws;

        const timeout = setTimeout(() => {
          settle(false, '连接超时：请确认本地 Bot 框架已启动且地址正确');
          try { ws.close(); } catch { /* 忽略 */ }
        }, AUTH_TIMEOUT_MS);

        ws.on('open', () => {
          if (gen !== this.generation) return;
          if (cfg.token) {
            ws.send(JSON.stringify({ type: 'auth', token: cfg.token }));
          } else {
            clearTimeout(timeout);
            this.reconnectAttempts = 0;
            settle(true, '个人微信桥接已连接');
          }
        });

        ws.on('message', (raw) => {
          if (gen !== this.generation) return;
          let frame: BridgeFrame;
          try {
            frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')) as BridgeFrame;
          } catch {
            return;
          }
          if (!settled && frame.type === 'auth_result') {
            clearTimeout(timeout);
            if (frame.ok) {
              this.reconnectAttempts = 0;
              settle(true, '个人微信桥接已连接（鉴权通过）');
            } else {
              this.setStatus('AUTH_EXPIRED');
              settle(false, '桥接鉴权失败：令牌不正确');
              try { ws.close(); } catch { /* 忽略 */ }
            }
            return;
          }
          if (frame.type === 'message') this.handleMessage(gen, ws, cfg.token, frame);
        });

        ws.on('close', () => {
          if (gen !== this.generation) return;
          clearTimeout(timeout);
          if (!settled) {
            settle(false, '连接被关闭：请确认本地 Bot 框架已启动');
            return;
          }
          if (this.active) this.scheduleReconnect(gen, cfg);
        });

        ws.on('error', () => {
          /* close 事件统一处理重连 */
        });
      }).catch((err) => {
        settle(false, `连接失败：${err instanceof Error ? err.message : String(err)}`);
      });
    });
  }

  /** 断线重连：指数退避（5s→10s→…→60s 封顶），期间状态 RECONNECTING */
  private scheduleReconnect(gen: number, cfg: { url: string; token: string | null }) {
    this.teardown();
    this.setStatus('RECONNECTING');
    const delay = Math.min(5000 * 2 ** this.reconnectAttempts, 60_000);
    this.reconnectAttempts++;
    setTimeout(() => {
      if (gen !== this.generation || !this.active) return;
      void this.openOnce(gen, cfg).then((r) => {
        if (gen !== this.generation) return;
        if (r.ok) this.setStatus('ONLINE');
        else if (this.active) {
          if (this.reconnectAttempts >= 5) {
            // 连续失败提醒一次（不刷屏），继续退避重试
            if (this.reconnectAttempts === 5) notify(this.db, '个人微信桥接持续重连中', '本地 Bot 框架可能已退出，请检查后重新连接。');
          }
          this.scheduleReconnect(gen, cfg);
        }
      });
    }, delay);
  }

  /** 收消息 → 公共渠道任务链路；回执与终态均通过 send_text 回发到来源会话 */
  private handleMessage(gen: number, ws: WsLike, token: string | null, frame: BridgeFrame) {
    const from = String(frame.from ?? '').trim();
    if (!from) return;
    const text = String(frame.text ?? '').trim();
    const send = (message: string) => {
      if (gen !== this.generation) return;
      try {
        const payload: Record<string, string> = { type: 'send_text', to: from, text: message.slice(0, MAX_REPLY_CHARS) };
        if (token) payload.token = token;
        ws.send(JSON.stringify(payload));
      } catch {
        /* 回发失败不中断渠道 */
      }
    };
    // 渠道审批拦截：回复“批准/拒绝”触发审批决策
    if (tryChannelApproval(this.db, this.broker, CHANNEL_ID, text, send)) return;
    dispatchChannelTask({
      db: this.db,
      orchestrator: this.orchestrator,
      channelId: CHANNEL_ID,
      text,
      ack: send,
      final: send
    });
  }
}
