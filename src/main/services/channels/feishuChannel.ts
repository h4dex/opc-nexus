/**
 * 飞书真实渠道（P3c）：官方长连接 WSClient（无需公网回调，契合本地优先架构）。
 * - 凭据：app_id 存 settings；app_secret 经 safeStorage 加密存 settings（secret:channel:feishu）
 * - 收到私聊/群聊消息 → 按 channel_routes 路由到绑定员工 → createTask(source='channel')
 *   → 轮询任务终态后回复消息（结果截断 2000 字）
 * - 状态真实驱动：连接成功 ONLINE / SDK 自动重连 RECONNECTING / 鉴权失败 AUTH_EXPIRED
 * - 渠道来源任务的权限收紧（10.5）由执行器层统一实施（trusted 降级 + 写类工具强制审批）
 */
import { randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';
import type { Client as LarkClient, WSClient as LarkWSClient } from '@larksuiteoapi/node-sdk';
import type { Database } from '../database.js';
import type { Orchestrator } from '../orchestrator.js';
import { notify } from '../notifier.js';
import { dispatchChannelTask, type ChannelTaskPlanner } from './common.js';

export const FEISHU_APPID_SETTING = 'channel:feishu:appId';
export const FEISHU_SECRET_REF = 'secret:channel:feishu';

const MAX_REPLY_CHARS = 2000;

interface FeishuMessageEvent {
  sender?: {
    sender_id?: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
    tenant_key?: string;
  };
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
  };
}

export class FeishuChannel {
  /** 连接代际：disconnect 或新连接后，旧连接的异步结果和事件全部忽略。 */
  private generation = 0;
  private active = false;
  private wsClient: LarkWSClient | null = null;

  constructor(private db: Database, private orchestrator: Orchestrator, private taskPlanner: ChannelTaskPlanner) {}

  isActive(): boolean {
    return this.active;
  }

  /** 保存凭据（secret 走 safeStorage，15.1） */
  saveCredentials(appId: string, appSecret: string) {
    if (!appId.trim()) throw new Error('请填写 App ID');
    this.db.setSetting(FEISHU_APPID_SETTING, appId.trim());
    if (appSecret.trim()) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥库不可用');
      this.db.setSetting(FEISHU_SECRET_REF, safeStorage.encryptString(appSecret.trim()).toString('base64'));
    }
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'channel.feishu.credentials', target: appId.trim(), result: 'ok' });
  }

  private readCredentials(): { appId: string; appSecret: string } | null {
    const appId = this.db.getSetting<string>(FEISHU_APPID_SETTING, '');
    const b64 = this.db.getSetting<string | null>(FEISHU_SECRET_REF, null);
    if (!appId || !b64 || !safeStorage.isEncryptionAvailable()) return null;
    try {
      return { appId, appSecret: safeStorage.decryptString(Buffer.from(b64, 'base64')) };
    } catch {
      return null;
    }
  }

  private setStatus(status: string) {
    const patch = status === 'ONLINE'
      ? this.db.raw.prepare("UPDATE channels SET status = ?, last_connected_at = ? WHERE id = 'ch-feishu'")
      : this.db.raw.prepare("UPDATE channels SET status = ? WHERE id = 'ch-feishu'");
    if (status === 'ONLINE') patch.run(status, Date.now());
    else patch.run(status);
  }

  /** 建立长连接（SDK 动态加载：未配置时不引入依赖开销） */
  async connect(): Promise<{ ok: boolean; message: string }> {
    const gen = ++this.generation;
    this.closeWsClient();
    this.active = false;
    const creds = this.readCredentials();
    if (!creds) {
      this.setStatus('UNCONFIGURED');
      return { ok: false, message: '请先保存飞书自建应用的 App ID 与 App Secret' };
    }
    this.setStatus('CONNECTING');

    let ws: LarkWSClient | null = null;
    try {
      const Lark = await import('@larksuiteoapi/node-sdk');
      if (gen !== this.generation) return { ok: false, message: '飞书连接已取消' };
      const client = new Lark.Client({ appId: creds.appId, appSecret: creds.appSecret });

      // 先做一次真实鉴权探测（获取 tenant_access_token），失败如实标 AUTH_EXPIRED
      try {
        await client.im.v1.chat.list({ params: { page_size: 1 } });
      } catch (err) {
        if (gen !== this.generation) return { ok: false, message: '飞书连接已取消' };
        this.setStatus('AUTH_EXPIRED');
        return { ok: false, message: `飞书鉴权失败：${err instanceof Error ? err.message : String(err)}` };
      }
      if (gen !== this.generation) return { ok: false, message: '飞书连接已取消' };

      const dispatcher = new Lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: FeishuMessageEvent) => {
          if (gen !== this.generation) return; // 旧代际连接的事件忽略
          await this.handleMessage(client, data);
        }
      });

      ws = new Lark.WSClient({ appId: creds.appId, appSecret: creds.appSecret, loggerLevel: Lark.LoggerLevel.error });
      this.wsClient = ws;
      await ws.start({ eventDispatcher: dispatcher });
      // SDK 的 start() 只安排连接流程，不等待 WebSocket 握手；生命周期由实例持有并在停用时显式关闭。
      if (gen !== this.generation || this.wsClient !== ws) {
        this.closeClient(ws);
        return { ok: false, message: '飞书连接已取消' };
      }
      this.active = true;
      this.setStatus('ONLINE');
      this.db.audit({ id: randomUUID(), actor: 'system', action: 'channel.feishu.connect', target: creds.appId, result: 'ok' });
      return { ok: true, message: '飞书长连接已建立' };
    } catch (err) {
      if (ws) this.closeClient(ws);
      if (this.wsClient === ws) this.wsClient = null;
      if (gen !== this.generation) return { ok: false, message: '飞书连接已取消' };
      this.active = false;
      this.setStatus('ERROR');
      notify(this.db, '飞书渠道连接失败', err instanceof Error ? err.message : String(err));
      return { ok: false, message: `连接失败：${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** 停用：立即释放 WebSocket、心跳/重连定时器和 SDK 消息缓存。 */
  disconnect() {
    this.generation++;
    this.active = false;
    this.closeWsClient();
    this.setStatus('DISABLED');
  }

  /** 进程退出时释放连接，但保留数据库状态以便下次启动自动重连。 */
  dispose(): void {
    this.generation++;
    this.active = false;
    this.closeWsClient();
  }

  private closeWsClient(): void {
    const ws = this.wsClient;
    this.wsClient = null;
    if (!ws) return;
    this.closeClient(ws);
  }

  private closeClient(ws: LarkWSClient): void {
    try {
      ws.close({ force: true });
    } catch {
      /* 关闭失败不阻塞状态切换 */
    }
  }

  /** 消息 → 路由绑定员工 → 创建渠道任务 → 终态后回帖 */
  private async handleMessage(client: LarkClient, data: FeishuMessageEvent) {
    const chatId = data.message?.chat_id;
    if (!chatId) return;
    let text = '';
    try {
      text = String((JSON.parse(data.message?.content ?? '{}') as { text?: string }).text ?? '').trim();
    } catch {
      /* 非文本消息 */
    }
    // @xxx 提及占位清理
    text = text.replace(/@_user_\d+\s*/g, '').trim();

    const reply = async (content: string) => {
      try {
        await client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: content.slice(0, MAX_REPLY_CHARS) }) }
        });
      } catch {
        /* 回帖失败不中断渠道 */
      }
    };

    if (!text) {
      await reply('暂只支持文本消息，请用文字描述任务。');
      return;
    }
    const sender = data.sender?.sender_id;
    const externalIdentity = sender?.open_id?.trim()
      || sender?.union_id?.trim()
      || sender?.user_id?.trim()
      || `chat:${chatId}`;
    void dispatchChannelTask({
      db: this.db,
      orchestrator: this.orchestrator,
      taskPlanner: this.taskPlanner,
      channelId: 'ch-feishu',
      text,
      externalIdentity,
      externalIdentityDisplayName: sender?.user_id?.trim() || sender?.open_id?.trim(),
      conversationKey: `chat:${chatId}`,
      sourceKey: data.message?.message_id?.trim(),
      metadata: {
        chatType: data.message?.chat_type ?? null,
        messageType: data.message?.message_type ?? null,
        senderType: data.sender?.sender_type ?? null,
        tenantKey: data.sender?.tenant_key ?? null
      },
      ack: (message) => void reply(message),
      final: (message, taskId) => void reply(message)
    });
  }
}
