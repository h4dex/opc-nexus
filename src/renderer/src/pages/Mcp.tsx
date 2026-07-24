/** MCP 服务器管理：增删启停 + 工具发现 + 全局可用配置 */
import { useEffect, useState } from 'react';
import { Modal } from '../components/common';
import { IconPlus, IconPlay, IconStop, IconX } from '../components/icons';

interface McpServer {
  id: string; name: string; command: string; args: string[]; env: Record<string, string>; enabled: boolean; scope: string;
}
interface McpTool { name: string; description: string; serverId: string; serverName: string }

export function Mcp() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [tools, setTools] = useState<McpTool[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [msg, setMsg] = useState<Record<string, { ok: boolean; text: string }>>({});

  const load = () => {
    void window.aibox.listMcpServers().then(setServers);
    void window.aibox.getMcpTools().then(setTools);
  };
  useEffect(() => { load(); }, []);

  const toggle = async (id: string, enabled: boolean) => {
    await window.aibox.toggleMcpServer(id, enabled);
    load();
  };

  const start = async (id: string) => {
    const r = await window.aibox.startMcpServer(id);
    setMsg((prev) => ({ ...prev, [id]: { ok: r.ok, text: r.message } }));
    load();
  };

  const stop = async (id: string) => {
    await window.aibox.stopMcpServer(id);
    load();
  };

  const remove = async (id: string) => {
    await window.aibox.removeMcpServer(id);
    load();
  };

  return (
    <>
      <div className="page-head">
        <h2>MCP 管理</h2>
        <span className="desc">{servers.length} 个 MCP 服务器 · {tools.length} 个可用工具 · 所有数字员工共享已启用的 MCP 能力</span>
        <div className="right">
          <button className="btn small primary" onClick={() => setAddOpen(true)}><IconPlus size={13} />添加服务器</button>
        </div>
      </div>

      {/* 服务器列表 */}
      <div style={{ display: 'grid', gap: 12, marginBottom: 20 }}>
        {servers.map((s) => (
          <div className="card" key={s.id} style={{ padding: '14px 18px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 650, fontSize: 14 }}>{s.name}</span>
                  <span style={{ fontSize: 10.5, padding: '1px 7px', borderRadius: 4, background: s.enabled ? 'var(--success-soft, rgba(34,197,94,.1))' : 'var(--input-bg)', color: s.enabled ? 'var(--success)' : 'var(--text-3)' }}>
                    {s.enabled ? '已启用' : '已停用'}
                  </span>
                  <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>{s.scope === 'global' ? '全局共享' : s.scope}</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 3, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.command} {s.args.join(' ')}
                </div>
                {msg[s.id] && <div style={{ fontSize: 11.5, marginTop: 3, color: msg[s.id].ok ? 'var(--success)' : 'var(--danger)' }}>{msg[s.id].text}</div>}
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button className="btn small" onClick={() => void toggle(s.id, !s.enabled)}>{s.enabled ? '停用' : '启用'}</button>
                {s.enabled ? (
                  <button className="btn small" onClick={() => void stop(s.id)}><IconStop size={12} />停止</button>
                ) : (
                  <button className="btn small primary" onClick={() => void start(s.id)}><IconPlay size={12} />启动</button>
                )}
                <button className="btn small danger" onClick={() => void remove(s.id)}><IconX size={12} /></button>
              </div>
            </div>
            {/* 该服务器的工具列表 */}
            {tools.filter((t) => t.serverId === s.id).length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                {tools.filter((t) => t.serverId === s.id).map((t) => (
                  <span key={t.name} title={t.description} style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 4, background: 'var(--input-bg)', color: 'var(--text-2)', border: '1px solid var(--border)' }}>
                    {t.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
        {servers.length === 0 && (
          <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)' }}>
            还没有 MCP 服务器。点击「添加服务器」接入外部工具能力（文件系统/浏览器/数据库等）。
          </div>
        )}
      </div>

      {/* 已发现工具汇总 */}
      {tools.length > 0 && (
        <div className="card">
          <div className="card-title">已发现工具（{tools.length} 个）<span className="sub">已启用服务器的工具对所有数字员工可用</span></div>
          <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: 'var(--text-3)', textAlign: 'left' }}>
                <th style={{ padding: '6px 10px' }}>工具名</th>
                <th style={{ padding: '6px 10px' }}>所属服务器</th>
                <th style={{ padding: '6px 10px' }}>描述</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((t) => (
                <tr key={`${t.serverId}-${t.name}`} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '6px 10px', fontWeight: 600, fontFamily: 'monospace', fontSize: 11.5 }}>{t.name}</td>
                  <td style={{ padding: '6px 10px' }}>{t.serverName}</td>
                  <td style={{ padding: '6px 10px', color: 'var(--text-2)', maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {addOpen && <AddMcpModal onClose={() => setAddOpen(false)} onCreated={() => { setAddOpen(false); load(); }} />}
    </>
  );
}

function AddMcpModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!name.trim() || !command.trim()) return;
    setBusy(true);
    try {
      await window.aibox.createMcpServer({ name: name.trim(), command: command.trim(), args: args.split(' ').filter(Boolean) });
      onCreated();
    } finally { setBusy(false); }
  };

  return (
    <Modal title="添加 MCP 服务器" onClose={onClose} width={480}
      footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy || !name.trim() || !command.trim()} onClick={() => void create()}>{busy ? '添加中…' : '添加'}</button></>}>
      <div className="field">
        <label>名称 *</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：filesystem / browser / sqlite" />
      </div>
      <div className="field">
        <label>启动命令 *</label>
        <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="例如：npx 或 node" />
      </div>
      <div className="field">
        <label>参数（空格分隔）</label>
        <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="例如：-y @modelcontextprotocol/server-filesystem /path" />
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.7, background: 'var(--input-bg)', padding: '10px 14px', borderRadius: 8 }}>
        MCP 服务器启动后，其提供的工具将自动注册给所有数字员工使用。
      </div>
    </Modal>
  );
}
