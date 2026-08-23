/**
 * 连接中心（PRD 10.x）
 * 统一管理 OPC-Nexus 自有渠道适配器的图形化配置、状态监控、路由绑定和诊断。
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
  constructor(private db: Database) {
    this.db.raw.prepare(`
      CREATE TABLE IF NOT EXISTS hermes_channel_bindings (
        channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `).run();
  }

  ensureChannels() {
    const count = (this.db.raw.prepare('SELECT COUNT(*) c FROM channels').get() as { c: number }).c;
    if (count === 0) {
      const stmt = this.db.raw.prepare(
        'INSERT INTO channels(id, type, account_name, status, credential_ref, last_connected_at, limitation) VALUES(?, ?, ?, ?, NULL, NULL, ?)'
      );
      stmt.run('ch-weixin', 'weixin', '', 'UNCONFIGURED', CHANNEL_META.weixin.limitation);
      stmt.run('ch-wecom', 'wecom', '', 'UNCONFIGURED', CHANNEL_META.wecom.limitation);
      stmt.run('ch-feishu', 'feishu', '', 'UNCONFIGURED', CHANNEL_META.feishu.limitation);
      return;
    }
    // 存量库：限制文案随版本演进同步（真实接入方式变化后不留旧描述）
    const sync = this.db.raw.prepare('UPDATE channels SET limitation = ? WHERE type = ?');
    for (const [type, meta] of Object.entries(CHANNEL_META)) sync.run(meta.limitation, type);
    this.db.raw.prepare("UPDATE channels SET status = 'DISABLED', limitation = 'QQ Adapter 尚未实现，当前版本不可用' WHERE type = 'qq'").run();
  }

  list(): Channel[] {
    const rows = this.db.raw.prepare("SELECT * FROM channels WHERE type <> 'qq' ORDER BY rowid").all() as unknown as ChannelRow[];
    const routes = this.db.raw.prepare('SELECT channel_id, agent_id FROM channel_routes').all() as { channel_id: string; agent_id: string }[];
    const byChannel = new Map<string, string[]>();
    for (const r of routes) {
      if (!byChannel.has(r.channel_id)) byChannel.set(r.channel_id, []);
      byChannel.get(r.channel_id)!.push(r.agent_id);
    }
    const projectBindings = this.db.raw.prepare(
      'SELECT channel_id, project_id FROM hermes_channel_bindings'
    ).all() as Array<{ channel_id: string; project_id: string }>;
    const projectsByChannel = new Map(projectBindings.map((item) => [item.channel_id, [item.project_id]]));
    return rows.map((r) => ({
      id: r.id,
      type: r.type as ChannelType,
      accountName: r.account_name || CHANNEL_META[r.type as ChannelType].name,
      status: r.status as Channel['status'],
      boundAgentIds: byChannel.get(r.id) ?? [],
      boundProjectIds: projectsByChannel.get(r.id) ?? [],
      lastConnectedAt: r.last_connected_at,
      limitation: r.limitation
    }));
  }

  disconnect(id: string) {
    // 10.5：渠道撤销后立即停用路由、撤销凭据并终止尚未批准的远程任务
    this.db.transaction(() => {
      this.db.raw.prepare("UPDATE channels SET status = 'DISABLED' WHERE id = ?").run(id);
      this.db.raw.prepare('DELETE FROM channel_routes WHERE channel_id = ?').run(id);
      this.db.raw.prepare('DELETE FROM hermes_channel_bindings WHERE channel_id = ?').run(id);
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

  bindProject(channelId: string, projectId: string): void {
    const owned = this.db.raw.prepare(`
      SELECT c.id AS channel_id, p.id AS project_id
      FROM channels c JOIN projects p ON p.id = ? AND p.status <> 'archived'
      WHERE c.id = ? AND c.type <> 'qq' AND c.organization_id = p.organization_id
    `).get(projectId, channelId) as { channel_id?: string; project_id?: string } | undefined;
    if (owned?.channel_id !== channelId || owned.project_id !== projectId) {
      throw new Error('渠道和项目必须存在、可用且属于同一组织');
    }
    const now = Date.now();
    this.db.raw.prepare(`
      INSERT INTO hermes_channel_bindings(channel_id, project_id, created_at, updated_at)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET project_id = excluded.project_id, updated_at = excluded.updated_at
    `).run(channelId, projectId, now, now);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'channel.bind-project', target: `${channelId}->${projectId}`, result: 'ok' });
  }
}
