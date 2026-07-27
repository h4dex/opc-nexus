/**
 * 企业微信群机器人 webhook 通知（P4 需求：仅推送任务完成结果）。
 * 地址来自 user/config.yaml wecom.webhookUrl（https 校验后使用；留空即禁用）。
 * 与长连接渠道（wecomChannel）互不依赖：webhook 只出不进，是纯通知通道。
 * 官方限制：单机器人 20 条/分钟 → 本端队列节流 3.2s/条,超限丢弃并记日志。
 */
import { createLogger } from './logger.js';
import { loadUserConfig } from './userConfig.js';

const log = createLogger('wecomWebhook');

/** 企微 markdown 消息上限 4096 字节,留余量 */
const MAX_CONTENT_BYTES = 4000;
/** 队列发送间隔（官方 20 条/分钟 = 3s/条,加余量） */
const SEND_INTERVAL_MS = 3200;
/** 队列上限,防死循环任务刷爆通知 */
const MAX_QUEUE = 50;

export class WecomWebhookNotifier {
  private queue: string[] = [];
  private timer: NodeJS.Timeout | null = null;

  /** 是否已配置(config.yaml webhookUrl 非空且合法) */
  isEnabled(): boolean {
    return !!loadUserConfig().wecom.webhookUrl;
  }

  /**
   * 推送任务完成通知（仅 COMPLETED 调用;失败/取消不推,避免噪音——
   * 失败等状态由长连接渠道回复发起人,webhook 面向的是结果播报群）。
   */
  notifyTaskCompleted(taskTitle: string, agentName: string, result: string | null) {
    if (!this.isEnabled()) return;
    const body = (result ?? '（无文本产物）').trim();
    const content = truncateBytes(
      `## ✅ 任务完成\n**任务**：${taskTitle}\n**执行**：${agentName}\n\n${body}`,
      MAX_CONTENT_BYTES
    );
    this.enqueue(content);
  }

  private enqueue(content: string) {
    if (this.queue.length >= MAX_QUEUE) {
      log.warn('通知队列已满，丢弃一条任务完成通知');
      return;
    }
    this.queue.push(content);
    if (!this.timer) this.drain();
  }

  private drain() {
    const content = this.queue.shift();
    if (content === undefined) {
      this.timer = null;
      return;
    }
    void this.send(content);
    this.timer = setTimeout(() => this.drain(), SEND_INTERVAL_MS);
  }

  private async send(content: string) {
    const url = loadUserConfig().wecom.webhookUrl;
    if (!url) return;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
        signal: AbortSignal.timeout(10_000)
      });
      if (!res.ok) {
        log.warn(`webhook 推送失败 HTTP ${res.status}`);
        return;
      }
      const data = await res.json().catch(() => null) as { errcode?: number; errmsg?: string } | null;
      if (data && data.errcode !== 0) log.warn(`webhook 推送被拒 errcode=${data.errcode}: ${data.errmsg ?? ''}`);
    } catch (err) {
      log.warn(`webhook 推送异常: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** 按 UTF-8 字节数截断（企微限制按字节算） */
export function truncateBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes - 3; // 预留省略号
  // 避免截断在多字节字符中间
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8') + '…';
}
