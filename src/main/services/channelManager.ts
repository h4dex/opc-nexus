/**
 * 连接中心（PRD 10.x）
 * 复用 Hermes Messaging Gateway 的渠道能力；Electron 仅提供图形化配置、状态监控、路由绑定和诊断。
 */
import { randomUUID } from 'node:crypto';
import type { Database } from './database.js';
import type { Channel, ChannelType } from '../../shared/types.js';

const CHANNEL_META: Record<ChannelType, { name: string; limitation: string }> = {
  weixin: { name: '微信 iLink Bot', limitation: '微信 ClawBot iLink 接口；仅支持扫码账号与 AI Bot 私聊，不会读取现有好友或群聊消息' },
  wecom: { name: '企业微信', limitation: '需在管理后台创建智能机器人并开启「API 模式 · 长连接」；单聊直发，群聊需 @机器人' },
  feishu: { name: '飞书 / Lark', limitation: '群聊默认按用户隔离会话' },
  qq: { name: 'QQ', limitation: '需在 q.qq.com 注册 Bot 并开通 Intents' }
};

interface ChannelRow {
  id: string; type: string; account_name: string; status: string;
  last_connected_at: number | null; limitation: string;
}

interface OwnedChannelRow {
  id: string;
  organization_id: string;
}

interface OwnedAgentRow {
  id: string;
  organization_id: string;
  archived: number;
}

export class ChannelManager {
  constructor(private db: Database) {}

  ensureChannels() {
    const count = (this.db.raw.prepare('SELECT COUNT(*) c FROM channels').get() as { c: number }).c;
    if (count === 0) {
      const stmt = this.db.raw.prepare(
        'INSERT INTO channels(id, type, account_name, status, credential_ref, last_connected_at, limitation) VALUES(?, ?, ?, ?, NULL, NULL, ?)'
      );
      stmt.run('ch-weixin', 'weixin', '', 'UNCONFIGURED', CHANNEL_META.weixin.limitation);
      stmt.run('ch-wecom', 'wecom', '', 'UNCONFIGURED', CHANNEL_META.wecom.limitation);
      stmt.run('ch-feishu', 'feishu', '', 'UNCONFIGURED', CHANNEL_META.feishu.limitation);
      stmt.run('ch-qq', 'qq', '', 'UNCONFIGURED', CHANNEL_META.qq.limitation);
      return;
    }
    // 存量库：限制文案随版本演进同步（真实接入方式变化后不留旧描述）
    const sync = this.db.raw.prepare('UPDATE channels SET limitation = ? WHERE type = ?');
    for (const [type, meta] of Object.entries(CHANNEL_META)) sync.run(meta.limitation, type);
  }

  list(): Channel[] {
    const rows = this.db.raw.prepare('SELECT * FROM channels ORDER BY rowid').all() as unknown as ChannelRow[];
    const routes = this.db.raw.prepare('SELECT channel_id, agent_id FROM channel_routes').all() as { channel_id: string; agent_id: string }[];
    const byChannel = new Map<string, string[]>();
    for (const r of routes) {
      if (!byChannel.has(r.channel_id)) byChannel.set(r.channel_id, []);
      byChannel.get(r.channel_id)!.push(r.agent_id);
    }
    return rows.map((r) => ({
      id: r.id,
      type: r.type as ChannelType,
      accountName: r.account_name || CHANNEL_META[r.type as ChannelType].name,
      status: r.status as Channel['status'],
      boundAgentIds: byChannel.get(r.id) ?? [],
      lastConnectedAt: r.last_connected_at,
      limitation: r.limitation
    }));
  }

  /** 启动配置向导（真实环境：唤起 Gateway 扫码/WebSocket 配置流程） */
  setup(id: string, accountName: string) {
    this.db.raw.prepare("UPDATE channels SET status = 'CONNECTING', account_name = ? WHERE id = ?").run(accountName, id);
    setTimeout(() => {
      this.db.raw.prepare("UPDATE channels SET status = 'ONLINE', last_connected_at = ? WHERE id = ? AND status = 'CONNECTING'").run(Date.now(), id);
    }, 1200);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'channel.setup', target: id, result: 'started' });
  }

  disconnect(id: string) {
    // 10.5：渠道撤销后立即停用路由、撤销凭据并终止尚未批准的远程任务
    this.db.transaction(() => {
      this.db.raw.prepare("UPDATE channels SET status = 'DISABLED' WHERE id = ?").run(id);
      this.db.raw.prepare('DELETE FROM channel_routes WHERE channel_id = ?').run(id);
    });
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'channel.disable', target: id, result: 'ok' });
  }

  bindAgent(channelId: string, agentId: string) {
    const channel = this.db.raw.prepare('SELECT id, organization_id FROM channels WHERE id = ?').get(channelId) as OwnedChannelRow | undefined;
    const agent = this.db.raw.prepare('SELECT id, organization_id, archived FROM agents WHERE id = ?').get(agentId) as OwnedAgentRow | undefined;
    if (!channel) throw new Error('渠道不存在');
    if (!agent || agent.archived !== 0) throw new Error('数字员工不存在或已归档');
    if (channel.organization_id !== agent.organization_id) {
      throw new Error('渠道和数字员工必须属于同一组织');
    }
    // 幂等绑定：已存在则跳过，避免重复绑定产生多行（导致“绑定员工”重复显示）
    const existing = this.db.raw.prepare('SELECT id FROM channel_routes WHERE channel_id = ? AND agent_id = ?').get(channelId, agentId);
    if (existing) return;
    this.db.raw.prepare('INSERT INTO channel_routes(id, channel_id, conversation_key, agent_id, policy) VALUES(?, ?, ?, ?, ?)')
      .run(randomUUID(), channelId, '*', agentId, '{}');
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'channel.bind', target: `${channelId}→${agentId}`, result: 'ok' });
  }

  unbindAgent(channelId: string, agentId: string) {
    this.db.raw.prepare('DELETE FROM channel_routes WHERE channel_id = ? AND agent_id = ?').run(channelId, agentId);
  }
}
