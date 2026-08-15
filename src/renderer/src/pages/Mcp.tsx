import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../components/common';
import { IconPlus, IconPlay, IconStop, IconX } from '../components/icons';
import { useApp } from '../store';
import { NEXUS_ENGINE_ID } from '../../../shared/types';

interface McpServer {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  scope: string;
  capability: 'browser' | '';
  running: boolean;
  hasSecrets: boolean;
}

interface McpTool {
  name: string;
  description: string;
  serverId: string;
  serverName: string;
  capability: 'browser' | '';
}

export function Mcp() {
  const agentCards = useApp((state) => state.snapshot?.agentCards);
  const agents = useMemo(() => agentCards?.map((card) => card.agent) ?? [], [agentCards]);
  const browserAgents = useMemo(() => agents.filter((agent) => agent.engineId === NEXUS_ENGINE_ID), [agents]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [tools, setTools] = useState<McpTool[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [msg, setMsg] = useState<Record<string, { ok: boolean; text: string }>>({});
  const agentNames = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents]);

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
    const result = await window.aibox.startMcpServer(id);
    setMsg((previous) => ({ ...previous, [id]: { ok: result.ok, text: result.message } }));
    load();
  };

  const stop = async (id: string) => {
    await window.aibox.stopMcpServer(id);
    setMsg((previous) => ({ ...previous, [id]: { ok: true, text: '已停止' } }));
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
        <span className="desc">{servers.length} 个服务器 · {servers.filter((server) => server.running).length} 个运行中 · {tools.length} 个工具</span>
        <div className="right">
          <button className="btn small" title={browserAgents.length === 0 ? '目前仅支持 Nexus Agent' : '连接已登录浏览器'} onClick={() => setBrowserOpen(true)} disabled={browserAgents.length === 0}>
            <IconPlay size={13} />连接浏览器
          </button>
          <button className="btn small primary" onClick={() => setAddOpen(true)}><IconPlus size={13} />添加服务器</button>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 12, marginBottom: 20 }}>
        {servers.map((server) => {
          const serverTools = tools.filter((tool) => tool.serverId === server.id);
          const scopeLabel = server.scope === 'global' ? '全局共享' : agentNames.get(server.scope) ?? '员工已归档';
          return (
            <div className="card" key={server.id} style={{ padding: '14px 18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 650, fontSize: 14 }}>{server.name}</span>
                    <StatusBadge active={server.running} label={server.running ? '运行中' : server.enabled ? '待连接' : '已停用'} />
                    {server.capability === 'browser' && <span className="tag">浏览器</span>}
                    <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>{scopeLabel}</span>
                    {server.hasSecrets && <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>凭据已保存</span>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 3, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {server.command} {server.args.join(' ')}
                  </div>
                  {msg[server.id] && <div style={{ fontSize: 11.5, marginTop: 3, color: msg[server.id].ok ? 'var(--success)' : 'var(--danger)' }}>{msg[server.id].text}</div>}
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button className="btn small" onClick={() => void toggle(server.id, !server.enabled)}>{server.enabled ? '停用' : '启用'}</button>
                  {server.running ? (
                    <button className="btn small" onClick={() => void stop(server.id)}><IconStop size={12} />停止</button>
                  ) : (
                    <button className="btn small primary" disabled={!server.enabled} onClick={() => void start(server.id)}><IconPlay size={12} />启动</button>
                  )}
                  <button className="btn small danger" title="删除服务器" aria-label={`删除 ${server.name}`} onClick={() => void remove(server.id)}><IconX size={12} /></button>
                </div>
              </div>
              {serverTools.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                  {serverTools.map((tool) => (
                    <span key={tool.name} title={tool.description} style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 4, background: 'var(--input-bg)', color: 'var(--text-2)', border: '1px solid var(--border)' }}>
                      {tool.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {servers.length === 0 && <div className="empty">暂无 MCP 服务器</div>}
      </div>

      {tools.length > 0 && (
        <div className="card">
          <div className="card-title">已发现工具（{tools.length} 个）</div>
          <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
            <thead><tr style={{ color: 'var(--text-3)', textAlign: 'left' }}><th style={{ padding: '6px 10px' }}>工具名</th><th style={{ padding: '6px 10px' }}>服务器</th><th style={{ padding: '6px 10px' }}>描述</th></tr></thead>
            <tbody>{tools.map((tool) => (
              <tr key={`${tool.serverId}-${tool.name}`} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '6px 10px', fontWeight: 600, fontFamily: 'monospace', fontSize: 11.5 }}>{tool.name}</td>
                <td style={{ padding: '6px 10px' }}>{tool.serverName}</td>
                <td style={{ padding: '6px 10px', color: 'var(--text-2)', maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tool.description}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {browserOpen && <BrowserModal agents={browserAgents} onClose={() => setBrowserOpen(false)} onCreated={() => { setBrowserOpen(false); load(); }} />}
      {addOpen && <AddMcpModal agents={agents} onClose={() => setAddOpen(false)} onCreated={() => { setAddOpen(false); load(); }} />}
    </>
  );
}

function StatusBadge({ active, label }: { active: boolean; label: string }) {
  return <span style={{ fontSize: 10.5, padding: '1px 7px', borderRadius: 4, background: active ? 'var(--success-soft, rgba(34,197,94,.1))' : 'var(--input-bg)', color: active ? 'var(--success)' : 'var(--text-3)' }}>{label}</span>;
}

function BrowserModal({ agents, onClose, onCreated }: { agents: { id: string; name: string }[]; onClose: () => void; onCreated: () => void }) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const create = async () => {
    if (!agentId) return;
    setBusy(true);
    setError('');
    try {
      const result = await window.aibox.createPlaywrightBrowser({ agentId, extensionToken: token.trim() || undefined });
      if (!result.connection.ok) setError(result.connection.message);
      else onCreated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="连接已登录浏览器" onClose={onClose} width={500}
      footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy || !agentId} onClick={() => void create()}>{busy ? '连接中…' : '连接'}</button></>}>
      <div className="field">
        <label>数字员工</label>
        <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
          {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Playwright Extension Token</label>
        <input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="可选" />
      </div>
      <button className="btn small" onClick={() => void window.aibox.openExternal('https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm')}>安装 Playwright 扩展</button>
      {error && <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 12 }}>{error}</div>}
    </Modal>
  );
}

function AddMcpModal({ agents, onClose, onCreated }: { agents: { id: string; name: string }[]; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [scope, setScope] = useState('global');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!name.trim() || !command.trim()) return;
    setBusy(true);
    try {
      await window.aibox.createMcpServer({ name: name.trim(), command: command.trim(), args: args.split(' ').filter(Boolean), scope });
      onCreated();
    } finally { setBusy(false); }
  };

  return (
    <Modal title="添加 MCP 服务器" onClose={onClose} width={480}
      footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy || !name.trim() || !command.trim()} onClick={() => void create()}>{busy ? '添加中…' : '添加'}</button></>}>
      <div className="field"><label>名称</label><input value={name} onChange={(event) => setName(event.target.value)} /></div>
      <div className="field"><label>启动命令</label><input value={command} onChange={(event) => setCommand(event.target.value)} /></div>
      <div className="field"><label>参数</label><input value={args} onChange={(event) => setArgs(event.target.value)} /></div>
      <div className="field"><label>可用范围</label><select value={scope} onChange={(event) => setScope(event.target.value)}><option value="global">全局共享</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></div>
    </Modal>
  );
}
