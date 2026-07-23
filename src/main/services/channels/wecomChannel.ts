/**
 * 企业微信智能机器人真实渠道：官方「长连接 API 模式」（wss://openws.work.weixin.qq.com）。
 * - 无需公网回调，契合本地优先架构；凭据 BotID 存 settings、Secret 经 safeStorage 加密
 * - 协议：WebSocket 建连 → aibot_subscribe 订阅（BotID/Secret 校验）→ 30s ping 心跳保活
 *   → aibot_msg_callback 收文本消息 → aibot_respond_msg 即时回执（流式，finish=true）
 *   → 任务终态后 aibot_send_msg 主动推送结果（回执透传 req_id 有时效，结果推送不依赖回调）
 * - 断线自动重连（指数退避，RECONNECTING）；同 Bot 新连接建立时旧连接收到
 *   disconnected_event 被服务端踢下线，本端如实转 ERROR 不再自动抢线
 * - 频率约束（官方）：单会话 30 条/分钟；本端仅回执 + 终态两条，天然满足
 */
import { randomUUID, createDecipheriv } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { app, safeStorage } from 'electron';
import type { Database } from '../database.js';
import type { Orchestrator } from '../orchestrator.js';
import { notify } from '../notifier.js';
import { dispatchChannelTask, createWs, tryChannelApproval, type WsLike } from './common.js';
import type { ApprovalBroker } from '../approvalBroker.js';

export const WECOM_BOTID_SETTING = 'channel:wecom:botId';
export const WECOM_SECRET_REF = 'secret:channel:wecom';

const WS_URL = 'wss://openws.work.weixin.qq.com';
const CHANNEL_ID = 'ch-wecom';
const PING_MS = 30_000;
const SUBSCRIBE_TIMEOUT_MS = 10_000;
const MAX_REPLY_CHARS = 2000;

/** 长连接帧（下行回调 / 上行命令响应共用外层结构） */
interface WecomFrame {
  cmd?: string;
  headers?: { req_id?: string };
  errcode?: number;
  errmsg?: string;
  body?: {
    msgid?: string;
    aibotid?: string;
    chatid?: string;
    chattype?: string;
    from?: { userid?: string };
    msgtype?: string;
    text?: { content?: string };
    voice?: { url?: string; aeskey?: string; recognize?: string };
    file?: { url?: string; aeskey?: string; filename?: string; filesize?: number };
    image?: { url?: string; aeskey?: string };
    event?: { eventtype?: string };
  };
}

export class WecomChannel {
  /** 连接代际：disconnect/重建后旧连接的事件与定时器全部失效 */
  private generation = 0;
  private active = false;
  private ws: WsLike | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  /** 已处理 msgid 环形去重（官方要求按 msgid 排重） */
  private seenMsgIds: string[] = [];

  constructor(private db: Database, private orchestrator: Orchestrator, private broker: ApprovalBroker) {}

  isActive(): boolean {
    return this.active;
  }

  /** 保存凭据（Secret 走 safeStorage，15.1） */
  saveCredentials(botId: string, secret: string) {
    if (!botId.trim()) throw new Error('请填写 BotID');
    this.db.setSetting(WECOM_BOTID_SETTING, botId.trim());
    if (secret.trim()) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥库不可用');
      this.db.setSetting(WECOM_SECRET_REF, safeStorage.encryptString(secret.trim()).toString('base64'));
    }
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'channel.wecom.credentials', target: botId.trim(), result: 'ok' });
  }

  private readCredentials(): { botId: string; secret: string } | null {
    const botId = this.db.getSetting<string>(WECOM_BOTID_SETTING, '');
    const b64 = this.db.getSetting<string | null>(WECOM_SECRET_REF, null);
    if (!botId || !b64 || !safeStorage.isEncryptionAvailable()) return null;
    try {
      return { botId, secret: safeStorage.decryptString(Buffer.from(b64, 'base64')) };
    } catch {
      return null;
    }
  }

  private setStatus(status: string) {
    if (status === 'ONLINE') {
      this.db.raw.prepare(`UPDATE channels SET status = ?, last_connected_at = ? WHERE id = '${CHANNEL_ID}'`).run(status, Date.now());
    } else {
      this.db.raw.prepare(`UPDATE channels SET status = ? WHERE id = '${CHANNEL_ID}'`).run(status);
    }
  }

  /** 建立长连接并完成订阅（一次完整握手；重连由内部退避驱动） */
  async connect(): Promise<{ ok: boolean; message: string }> {
    const creds = this.readCredentials();
    if (!creds) {
      this.setStatus('UNCONFIGURED');
      return { ok: false, message: '请先保存企业微信智能机器人的 BotID 与 Secret（管理后台开启「API 模式 · 长连接」获取）' };
    }
    this.generation++;
    this.reconnectAttempts = 0;
    this.setStatus('CONNECTING');
    const r = await this.openOnce(this.generation, creds);
    if (r.ok) {
      this.active = true;
      this.setStatus('ONLINE');
      this.db.audit({ id: randomUUID(), actor: 'system', action: 'channel.wecom.connect', target: creds.botId, result: 'ok' });
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
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      /* 已断开 */
    }
    this.ws = null;
  }

  /** 单次建连 + 订阅；订阅失败区分鉴权错误（不重连）与网络错误（可重连） */
  private openOnce(gen: number, creds: { botId: string; secret: string }): Promise<{ ok: boolean; message: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (ok: boolean, message: string) => {
        if (!settled) {
          settled = true;
          resolve({ ok, message });
        }
      };

      const subReqId = randomUUID();
      let ws: WsLike;

      createWs(WS_URL).then((socket) => {
        if (gen !== this.generation) { socket.close(); return; }
        ws = socket;
        this.ws = ws;

        const timeout = setTimeout(() => {
          settle(false, '订阅超时：请检查网络或凭据');
          try { ws.close(); } catch { /* 忽略 */ }
        }, SUBSCRIBE_TIMEOUT_MS);

        ws.on('open', () => {
          if (gen !== this.generation) return;
          ws.send(JSON.stringify({ cmd: 'aibot_subscribe', headers: { req_id: subReqId }, body: { bot_id: creds.botId, secret: creds.secret } }));
        });

        ws.on('message', (raw) => {
          if (gen !== this.generation) return;
          let frame: WecomFrame;
          try {
            frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')) as WecomFrame;
          } catch {
            return;
          }
          // 订阅响应
          if (!settled && frame.headers?.req_id === subReqId) {
            clearTimeout(timeout);
            if (frame.errcode === 0) {
              this.reconnectAttempts = 0;
              this.startHeartbeat(gen, ws);
              settle(true, '企业微信长连接已建立');
            } else {
              this.setStatus('AUTH_EXPIRED');
              settle(false, `订阅失败（errcode=${frame.errcode}）：${frame.errmsg ?? '凭据校验未通过'}`);
              try { ws.close(); } catch { /* 忽略 */ }
            }
            return;
          }
          if (frame.cmd === 'aibot_msg_callback') this.handleMessage(gen, ws, frame);
          else if (frame.cmd === 'aibot_event_callback') this.handleEvent(gen, frame);
        });

        ws.on('close', () => {
          if (gen !== this.generation) return;
          clearTimeout(timeout);
          if (!settled) {
            settle(false, '连接被关闭：请检查网络或凭据');
            return;
          }
          if (this.active) this.scheduleReconnect(gen, creds);
        });

        ws.on('error', () => {
          /* close 事件统一处理重连 */
        });
      }).catch((err) => {
        settle(false, `连接失败：${err instanceof Error ? err.message : String(err)}`);
      });
    });
  }

  /** 心跳保活：官方建议 30s 一次 ping */
  private startHeartbeat(gen: number, ws: WsLike) {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (gen !== this.generation) return;
      try {
        ws.send(JSON.stringify({ cmd: 'ping', headers: { req_id: randomUUID() } }));
      } catch {
        /* 发送失败由 close 事件触发重连 */
      }
    }, PING_MS);
  }

  /** 断线重连：指数退避（5s→10s→…→60s 封顶），期间状态 RECONNECTING */
  private scheduleReconnect(gen: number, creds: { botId: string; secret: string }) {
    this.teardown();
    this.setStatus('RECONNECTING');
    const delay = Math.min(5000 * 2 ** this.reconnectAttempts, 60_000);
    this.reconnectAttempts++;
    setTimeout(() => {
      if (gen !== this.generation || !this.active) return;
      void this.openOnce(gen, creds).then((r) => {
        if (gen !== this.generation) return;
        if (r.ok) this.setStatus('ONLINE');
        else if (this.active) this.scheduleReconnect(gen, creds);
      });
    }, delay);
  }

  /** 事件回调：disconnected_event = 同 Bot 新连接抢线，本端如实下线不自动抢回 */
  private handleEvent(gen: number, frame: WecomFrame) {
    if (frame.body?.event?.eventtype === 'disconnected_event') {
      if (gen !== this.generation) return;
      this.generation++;
      this.active = false;
      this.teardown();
      this.setStatus('ERROR');
      notify(this.db, '企业微信渠道已断开', '同一机器人在其他位置建立了新连接，本机连接被踢下线。');
    }
  }

  /** 消息回调 → 支持文本/语音(ASR)/文件；即时回执透传 req_id，终态结果走主动推送 */
  private handleMessage(gen: number, ws: WsLike, frame: WecomFrame) {
    const body = frame.body ?? {};
    const reqId = frame.headers?.req_id;
    // msgid 排重（官方要求）
    const msgid = body.msgid;
    if (msgid) {
      if (this.seenMsgIds.includes(msgid)) return;
      this.seenMsgIds.push(msgid);
      if (this.seenMsgIds.length > 200) this.seenMsgIds.shift();
    }

    let text = '';
    const attachments: string[] = [];

    if (body.msgtype === 'text') {
      text = String(body.text?.content ?? '').replace(/^@\S+\s*/, '').trim();
    } else if (body.msgtype === 'voice') {
      // 语音消息：企微内置 ASR 转文字（recognize 字段）
      text = body.voice?.recognize?.trim() ?? '';
      if (!text) {
        this.respondStream(ws, reqId, '语音识别失败，请用文字描述任务。');
        return;
      }
      text = `[语音转文字] ${text}`;
    } else if (body.msgtype === 'file') {
      // 文件消息：下载 + AES 解密 → 存入 workspace
      const filePath = this.downloadAndDecrypt(body.file?.url, body.file?.aeskey, body.file?.filename);
      if (filePath) {
        attachments.push(filePath);
        text = `[文件已接收] ${body.file?.filename ?? '未知文件'}，已保存到工作目录。请处理该文件。`;
      } else {
        this.respondStream(ws, reqId, '文件下载失败，请重试。');
        return;
      }
    } else if (body.msgtype === 'image') {
      const filePath = this.downloadAndDecrypt(body.image?.url, body.image?.aeskey, `image_${Date.now()}.png`);
      if (filePath) {
        attachments.push(filePath);
        text = `[图片已接收] 已保存到工作目录：${filePath}`;
      } else {
        this.respondStream(ws, reqId, '图片下载失败，请重试。');
        return;
      }
    } else {
      this.respondStream(ws, reqId, '暂不支持该消息类型，请发送文本/语音/文件。');
      return;
    }

    if (!text) {
      this.respondStream(ws, reqId, '未识别到有效内容，请重试。');
      return;
    }

    // 渠道审批拦截：回复“批准/拒绝”触发审批决策
    if (tryChannelApproval(this.db, this.broker, CHANNEL_ID, text, (msg) => this.respondStream(ws, reqId, msg))) return;
    // 终态推送目标：群聊用 chatid（chat_type=2），单聊用发送者 userid（chat_type=1）
    const pushChatId = body.chattype === 'group' ? body.chatid : body.from?.userid;
    const pushChatType = body.chattype === 'group' ? 2 : 1;

    dispatchChannelTask({
      db: this.db,
      orchestrator: this.orchestrator,
      channelId: CHANNEL_ID,
      text,
      ack: (message) => this.respondStream(ws, reqId, message),
      final: (message) => {
        if (gen !== this.generation || !pushChatId) return;
        this.sendMarkdown(pushChatId, pushChatType, message);
      }
    });
  }

  /** 下载企微文件/图片并 AES-256-CBC 解密，存入应用数据目录 */
  private downloadAndDecrypt(url?: string, aeskey?: string, filename?: string): string | null {
    if (!url) return null;
    try {
      const tmpPath = join(app.getPath('userData'), 'aibox-data', 'downloads', filename ?? `file_${Date.now()}`);
      mkdirSync(join(app.getPath('userData'), 'aibox-data', 'downloads'), { recursive: true });
      execFileSync('curl', ['-sL', '-o', tmpPath, url], { timeout: 30_000 });
      if (aeskey) {
        const encrypted = readFileSync(tmpPath);
        const key = Buffer.from(aeskey, 'base64');
        const iv = key.subarray(0, 16);
        const decipher = createDecipheriv('aes-256-cbc', key, iv);
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        writeFileSync(tmpPath, decrypted);
      }
      return tmpPath;
    } catch {
      return null;
    }
  }

  /** 即时回执：aibot_respond_msg 流式消息一次完成（finish=true，透传回调 req_id） */
  private respondStream(ws: WsLike, reqId: string | undefined, content: string) {
    if (!reqId) return;
    try {
      ws.send(JSON.stringify({
        cmd: 'aibot_respond_msg',
        headers: { req_id: reqId },
        body: { msgtype: 'stream', stream: { id: randomUUID(), finish: true, content: content.slice(0, MAX_REPLY_CHARS) } }
      }));
    } catch {
      /* 回执失败不中断渠道 */
    }
  }

  /** 终态结果：aibot_send_msg 主动推送 markdown（不受回调 req_id 时效限制） */
  private sendMarkdown(chatId: string, chatType: number, content: string) {
    try {
      this.ws?.send(JSON.stringify({
        cmd: 'aibot_send_msg',
        headers: { req_id: randomUUID() },
        body: { chatid: chatId, chat_type: chatType, msgtype: 'markdown', markdown: { content: content.slice(0, MAX_REPLY_CHARS) } }
      }));
    } catch {
      /* 推送失败不中断渠道 */
    }
  }
}
