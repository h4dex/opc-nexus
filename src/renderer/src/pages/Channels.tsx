/** 连接中心（PRD 10.x）：四渠道配置、状态监控、路由绑定 */
import { useState } from 'react';
import { useApp } from '../store';
import { Modal } from '../components/common';
import { IconMessage, IconPlug } from '../components/icons';
import type { Channel } from '@shared/types';

const STATUS_META: Record<Channel['status'], { label: string; tag: string }> = {
  UNCONFIGURED: { label: '未配置', tag: 'gray' },
  CONNECTING: { label: '连接中', tag: 'blue' },
  ONLINE: { label: '在线', tag: 'green' },
  RECONNECTING: { label: '重连中', tag: 'orange' },
  AUTH_EXPIRED: { label: '鉴权过期', tag: 'red' },
  DISABLED: { label: '已停用', tag: 'gray' },
  ERROR: { label: '异常', tag: 'red' }
};

const TYPE_LABEL: Record<Channel['type'], string> = {
  weixin: '微信', wecom: '企业微信', feishu: '飞书 / Lark', qq: 'QQ'
};

export function Channels() {
  const { snapshot } = useApp();
  const [setupTarget, setSetupTarget] = useState<Channel | null>(null);
  if (!snapshot) return null;
  const { channels, agentCards } = snapshot;

  return (
    <>
      <div className="page-head">
        <h2>连接中心</h2>
        <span className="desc">消息渠道网关；默认拒绝外部身份，需显式白名单（10.5）</span>
      </div>

      <div className="agent-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
        {channels.map((c) => {
          const meta = STATUS_META[c.status];
          return (
            <div className="card" key={c.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <div className="agent-avatar" style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--success-soft)', color: 'var(--success)' }}>
                  <IconMessage size={24} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 650, fontSize: 14.5, display: 'flex', gap: 8, alignItems: 'center' }}>
                    {TYPE_LABEL[c.type]}
                    {c.type === 'qq' && <span className="tag gray">演示</span>}
                    {c.type !== 'qq' && <span className="tag blue">真实接入</span>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>{c.accountName}</div>
                </div>
                <span className={`tag ${meta.tag}`}><span className={`dot ${meta.tag === 'green' ? 'green' : meta.tag === 'red' ? 'red' : meta.tag === 'gray' ? 'gray' : 'orange'}`} />{meta.label}</span>
              </div>

              <div style={{ fontSize: 12, color: 'var(--warning)', background: 'var(--warning-soft)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
                限制：{c.limitation}
              </div>

              {/* 重连策略可视化：RECONNECTING 状态显示重连信息 */}
              {c.status === 'RECONNECTING' && (
                <div style={{ fontSize: 12, color: 'var(--accent)', background: 'var(--accent-soft)', borderRadius: 8, padding: '8px 12px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="dot orange" style={{ animation: 'pulse 1s infinite' }} />
                  断线重连中…（指数退避策略：5s → 10s → 30s → 60s，最多重试 20 次后转入 ERROR）
                </div>
              )}
              {c.status === 'ERROR' && (
                <div style={{ fontSize: 12, color: 'var(--danger)', background: 'var(--danger-soft)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
                  连接异常，重连已耗尽。请检查凭据或网络后重新配置。
                </div>
              )}

              <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 12 }}>
                绑定员工：{c.boundAgentIds.length
                  ? [...new Set(c.boundAgentIds)].map((id) => agentCards.find((a) => a.agent.id === id)?.agent.name ?? id).join('、')
                  : '未绑定'}
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                {(c.status === 'UNCONFIGURED' || c.status === 'DISABLED' || c.status === 'ERROR' || c.status === 'AUTH_EXPIRED') && (
                  <button className="btn small primary" onClick={() => setSetupTarget(c)}>
                    <IconPlug size={13} />配置连接
                  </button>
                )}
                {c.status === 'ONLINE' && (
                  <button className="btn small danger" onClick={() => void window.aibox.disconnectChannel(c.id)}>停用</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {setupTarget && setupTarget.type === 'feishu' && <FeishuSetupModal channel={setupTarget} onClose={() => setSetupTarget(null)} />}
      {setupTarget && setupTarget.type === 'wecom' && (
        <CredentialSetupModal
          channel={setupTarget}
          title="配置渠道 · 企业微信智能机器人（真实接入）"
          field1={{ label: 'BotID（管理后台 · 智能机器人 · API 模式）', placeholder: 'AIBOTID' }}
          field2={{ label: 'Secret（长连接专用密钥，仅存入系统密钥库，留空表示沿用已存）', placeholder: '••••••••' }}
          hint="需在管理后台开启「API 模式 · 长连接」；无需公网回调地址，心跳与断线重连由本机自动维护。"
          onSubmit={(v1, v2) => window.aibox.configureWecom(v1, v2)}
          onClose={() => setSetupTarget(null)}
        />
      )}
      {setupTarget && setupTarget.type === 'weixin' && (
        <CredentialSetupModal
          channel={setupTarget}
          title="配置渠道 · 个人微信（本地 Bot 桥接）"
          field1={{ label: '桥接地址（本机 Bot 框架的 WebSocket 接口）', placeholder: 'ws://127.0.0.1:8080/ws' }}
          field2={{ label: '鉴权令牌（可选，仅存入系统密钥库，留空表示无需/沿用已存）', placeholder: '••••••••' }}
          hint="适配 WeChatFerry / wechaty 等本机框架；地址仅允许回环 ws:// 或加密 wss://。个人微信自动化存在账号风控风险，仅建议小范围自用。"
          onSubmit={(v1, v2) => window.aibox.configureWeixin(v1, v2)}
          onClose={() => setSetupTarget(null)}
        />
      )}
      {setupTarget && setupTarget.type === 'qq' && <ChannelSetupModal channel={setupTarget} onClose={() => setSetupTarget(null)} />}
    </>
  );
}

/** 飞书真实接入（P3c）：自建应用 App ID / App Secret，长连接模式无需公网回调 */
function FeishuSetupModal({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const { snapshot } = useApp();
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [bindId, setBindId] = useState(channel.boundAgentIds[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const confirm = async () => {
    setBusy(true);
    setMessage(null);
    try {
      if (bindId && !channel.boundAgentIds.includes(bindId)) await window.aibox.bindChannel(channel.id, bindId);
      const r = await window.aibox.configureFeishu(appId, appSecret);
      setMessage({ ok: r.ok, text: r.message });
      if (r.ok) setTimeout(onClose, 1200);
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="配置渠道 · 飞书（真实接入）" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy} onClick={() => void confirm()}>{busy ? '连接中…' : '保存并连接'}</button></>}>
      <div className="field">
        <label>App ID（飞书开放平台 · 企业自建应用）</label>
        <input value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="cli_xxxxxxxxxxxxxxxxx" />
      </div>
      <div className="field">
        <label>App Secret（仅存入系统密钥库，留空表示沿用已存）</label>
        <input type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder="••••••••" autoComplete="off" />
        <div className="hint">需开通长连接模式并订阅 im.message.receive_v1 事件；无需公网回调地址。</div>
      </div>
      <div className="field">
        <label>绑定数字员工（消息将路由到该员工执行）</label>
        <select value={bindId} onChange={(e) => setBindId(e.target.value)}>
          <option value="">暂不绑定</option>
          {snapshot?.agentCards.map((c) => (
            <option key={c.agent.id} value={c.agent.id}>{c.agent.name}</option>
          ))}
        </select>
      </div>
      {message && (
        <div style={{ fontSize: 12.5, color: message.ok ? 'var(--success)' : 'var(--danger)', marginBottom: 8, whiteSpace: 'pre-wrap' }}>{message.text}</div>
      )}
      <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.8, background: 'var(--input-bg)', padding: '10px 14px', borderRadius: 10 }}>
        安全基线（10.5）：渠道任务默认低权限，写入/删除类操作一律需在本机控制中心审批（不受受信任模式豁免）。
      </div>
    </Modal>
  );
}

/** 通用真实接入配置弹窗：两字段凭据 + 绑定员工（企微长连接 / 个微桥接复用） */
function CredentialSetupModal({ channel, title, field1, field2, hint, onSubmit, onClose }: {
  channel: Channel;
  title: string;
  field1: { label: string; placeholder: string };
  field2: { label: string; placeholder: string };
  hint: string;
  onSubmit: (value1: string, value2: string) => Promise<{ ok: boolean; message: string }>;
  onClose: () => void;
}) {
  const { snapshot } = useApp();
  const [value1, setValue1] = useState('');
  const [value2, setValue2] = useState('');
  const [bindId, setBindId] = useState(channel.boundAgentIds[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const confirm = async () => {
    setBusy(true);
    setMessage(null);
    try {
      if (bindId && !channel.boundAgentIds.includes(bindId)) await window.aibox.bindChannel(channel.id, bindId);
      const r = await onSubmit(value1, value2);
      setMessage({ ok: r.ok, text: r.message });
      if (r.ok) setTimeout(onClose, 1200);
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy} onClick={() => void confirm()}>{busy ? '连接中…' : '保存并连接'}</button></>}>
      <div className="field">
        <label>{field1.label}</label>
        <input value={value1} onChange={(e) => setValue1(e.target.value)} placeholder={field1.placeholder} />
      </div>
      <div className="field">
        <label>{field2.label}</label>
        <input type="password" value={value2} onChange={(e) => setValue2(e.target.value)} placeholder={field2.placeholder} autoComplete="off" />
        <div className="hint">{hint}</div>
      </div>
      <div className="field">
        <label>绑定数字员工（消息将路由到该员工执行）</label>
        <select value={bindId} onChange={(e) => setBindId(e.target.value)}>
          <option value="">暂不绑定</option>
          {snapshot?.agentCards.map((c) => (
            <option key={c.agent.id} value={c.agent.id}>{c.agent.name}</option>
          ))}
        </select>
      </div>
      {message && (
        <div style={{ fontSize: 12.5, color: message.ok ? 'var(--success)' : 'var(--danger)', marginBottom: 8, whiteSpace: 'pre-wrap' }}>{message.text}</div>
      )}
      <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.8, background: 'var(--input-bg)', padding: '10px 14px', borderRadius: 10 }}>
        安全基线（10.5）：渠道任务默认低权限，写入/删除类操作一律需在本机控制中心审批（不受受信任模式豁免）。
      </div>
    </Modal>
  );
}

function ChannelSetupModal({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const { snapshot } = useApp();
  const [account, setAccount] = useState(channel.accountName);
  const [bindId, setBindId] = useState('');

  const confirm = async () => {
    await window.aibox.setupChannel(channel.id, account || TYPE_LABEL[channel.type]);
    if (bindId) await window.aibox.bindChannel(channel.id, bindId);
    onClose();
  };

  return (
    <Modal title={`配置渠道 · ${TYPE_LABEL[channel.type]}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" onClick={() => void confirm()}>开始连接</button></>}>
      <div className="field">
        <label>账号 / Bot 名称</label>
        <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="例如：森科AI助手" />
        <div className="hint">真实环境将唤起 Gateway 扫码 / WebSocket 配置流程；凭据仅存入系统密钥库。</div>
      </div>
      <div className="field">
        <label>绑定数字员工（路由：精确会话绑定 &gt; 账号默认 &gt; 系统默认）</label>
        <select value={bindId} onChange={(e) => setBindId(e.target.value)}>
          <option value="">暂不绑定</option>
          {snapshot?.agentCards.map((c) => (
            <option key={c.agent.id} value={c.agent.id}>{c.agent.name}</option>
          ))}
        </select>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.8, background: 'var(--input-bg)', padding: '10px 14px', borderRadius: 10 }}>
        安全基线：渠道任务默认低权限；安装、提权、目录外访问、删除/覆盖和敏感数据上传只能在本机可信 UI 批准（10.5）。
      </div>
    </Modal>
  );
}
