/**
 * 系统通知（遗留修复）：审批到达 / 任务失败 / 引擎待登录 / 渠道掉线 / 资源告警
 * 开关存 settings `notifications`（默认开）；通知失败静默降级，不影响主流程。
 */
import { Notification } from 'electron';
import type { Database } from './database.js';

export function notify(db: Database, title: string, body: string) {
  try {
    if (!db.getSetting<boolean>('notifications', true)) return;
    if (!Notification.isSupported()) return;
    new Notification({ title, body: body.slice(0, 200), silent: false }).show();
  } catch {
    /* 通知异常不影响主流程 */
  }
}
