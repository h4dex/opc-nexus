/** Unified plugin surface. MCP and Skills keep their existing CRUD owners,
 * while this page provides one inventory and safe enable/disable controls. */
import { useEffect, useMemo, useState } from 'react';
import type { EnvironmentDiagnosticsView, PluginCatalogItemView, PluginCatalogSource, PluginCatalogView, PluginLifecycleStatus } from '../../../shared/types';
import { IconCheck, IconPlug, IconRefresh, IconShield, IconX } from '../components/icons';

const SOURCES: Array<PluginCatalogSource | 'all'> = ['all', 'host', 'dsh', 'mcp', 'skill', 'cli', 'acp', 'a2a'];
const LIFECYCLES: Array<PluginLifecycleStatus | 'all'> = ['all', 'missing', 'installed', 'disabled', 'review', 'live', 'restart', 'broken'];

const sourceLabel: Record<PluginCatalogSource | 'all', string> = {
  all: '全部', host: '宿主插件', dsh: 'DSH/Cordis', mcp: 'MCP', skill: '技能', cli: 'CLI Worker', acp: 'ACP', a2a: 'A2A'
};
const lifecycleLabel: Record<PluginLifecycleStatus | 'all', string> = {
  all: '全部状态', missing: '未安装', installed: '已安装', disabled: '已停用', review: '待审核', live: '运行中', restart: '待重启', broken: '故障'
};

export function Plugins() {
  const [catalog, setCatalog] = useState<PluginCatalogView | null>(null);
  const [environment, setEnvironment] = useState<EnvironmentDiagnosticsView | null>(null);
  const [source, setSource] = useState<PluginCatalogSource | 'all'>('all');
  const [lifecycle, setLifecycle] = useState<PluginLifecycleStatus | 'all'>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    setError('');
    try {
      const [nextCatalog, nextEnvironment] = await Promise.all([
        window.aibox.getPluginCatalog(),
        window.aibox.getEnvironmentDiagnostics()
      ]);
      setCatalog(nextCatalog);
      setEnvironment(nextEnvironment);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useEffect(() => { void load(); }, []);

  const filtered = useMemo(() => (catalog?.items ?? []).filter((item) =>
    (source === 'all' || item.source === source) && (lifecycle === 'all' || item.lifecycle === lifecycle)
  ), [catalog, source, lifecycle]);

  const toggle = async (item: PluginCatalogItemView) => {
    if (!['host', 'mcp', 'skill'].includes(item.source) || item.lifecycle === 'broken' || item.lifecycle === 'missing') return;
    setBusy(item.id);
    setError('');
    try {
      setCatalog(await window.aibox.setPluginEnabled(item.id, !item.enabled));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="page-head">
        <h2>插件中心</h2>
        <span className="desc">DSH/Cordis、治理插件、MCP、技能与 Worker Adapter 统一目录</span>
        <div className="right">
          <button className="btn small" onClick={() => void load()} disabled={busy !== null} title="刷新插件目录"><IconRefresh size={13} />刷新</button>
        </div>
      </div>

      <div className="card" style={{ padding: 14, marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ color: 'var(--text-3)', fontSize: 12 }}>来源</span>
          {SOURCES.map((item) => <button key={item} className={`btn small ${source === item ? 'primary' : ''}`} onClick={() => setSource(item)}>{sourceLabel[item]}</button>)}
          <span style={{ color: 'var(--text-3)', fontSize: 12, marginLeft: 8 }}>状态</span>
          <select value={lifecycle} onChange={(event) => setLifecycle(event.target.value as PluginLifecycleStatus | 'all')} style={{ padding: '6px 9px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-1)' }}>
            {LIFECYCLES.map((item) => <option key={item} value={item}>{lifecycleLabel[item]}</option>)}
          </select>
          <span style={{ marginLeft: 'auto', color: 'var(--text-3)', fontSize: 12 }}>{filtered.length} / {catalog?.items.length ?? 0}</span>
        </div>
      </div>

      {error && <div className="card" style={{ padding: 12, color: 'var(--danger)', marginBottom: 14 }}>{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: 12 }}>
        {filtered.map((item) => <PluginCard key={item.id} item={item} busy={busy === item.id} onToggle={() => void toggle(item)} />)}
        {filtered.length === 0 && <div className="empty" style={{ gridColumn: '1 / -1' }}>暂无匹配插件</div>}
      </div>

      <EnvironmentPanel environment={environment} />
    </>
  );
}

function PluginCard({ item, busy, onToggle }: { item: PluginCatalogItemView; busy: boolean; onToggle: () => void }) {
  const canToggle = ['host', 'mcp', 'skill'].includes(item.source) && item.lifecycle !== 'broken' && item.lifecycle !== 'missing';
  const statusColor = item.lifecycle === 'live' ? 'var(--success)' : item.lifecycle === 'broken' ? 'var(--danger)' : item.lifecycle === 'review' || item.lifecycle === 'restart' ? 'var(--warning)' : 'var(--text-3)';
  return (
    <div className="card" style={{ padding: 14, opacity: item.status === 'disabled' ? 0.72 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ width: 34, height: 34, borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent)', display: 'grid', placeItems: 'center' }}><IconPlug size={17} /></div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.name}>{item.name}</div>
          <div style={{ color: 'var(--text-3)', fontSize: 11, marginTop: 3 }}>{item.source} · {item.kind}{item.version ? ` · v${item.version}` : ''}</div>
        </div>
        <span style={{ color: statusColor, fontSize: 11, whiteSpace: 'nowrap' }}>{lifecycleLabel[item.lifecycle]}</span>
      </div>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', margin: '12px 0 10px' }}>
        {item.capabilities.slice(0, 5).map((capability) => <span key={capability} style={{ padding: '2px 6px', borderRadius: 4, background: 'var(--input-bg)', color: 'var(--text-2)', fontSize: 10.5 }}>{capability}</span>)}
        {item.safety !== 'trusted' && <span style={{ padding: '2px 6px', borderRadius: 4, background: 'var(--warning-soft, rgba(234,179,8,.12))', color: 'var(--warning)', fontSize: 10.5 }}><IconShield size={10} /> {item.safety === 'blocked' ? '阻止' : '需审核'}</span>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{item.owner}</span>
        {canToggle && <button className={`btn small ${item.enabled ? '' : 'primary'}`} disabled={busy} onClick={onToggle}>{busy ? '处理中...' : item.enabled ? <><IconX size={12} />停用</> : <><IconCheck size={12} />启用</>}</button>}
      </div>
    </div>
  );
}

function EnvironmentPanel({ environment }: { environment: EnvironmentDiagnosticsView | null }) {
  if (!environment) return null;
  return (
    <div className="card" style={{ padding: 14, marginTop: 16 }}>
      <div className="card-title" style={{ display: 'flex', justifyContent: 'space-between' }}><span>运行环境</span><span style={{ color: environment.ready ? 'var(--success)' : 'var(--warning)', fontSize: 12 }}>{environment.ready ? '可运行' : '需要处理'}</span></div>
      <div style={{ color: 'var(--text-3)', fontSize: 11, marginBottom: 10 }}>{environment.platform} · {environment.architecture} · Electron {environment.electronVersion} · Node {environment.nodeVersion}</div>
      <div style={{ color: environment.runtimeSelection.fallbackUsed ? 'var(--warning)' : 'var(--text-2)', fontSize: 11, marginBottom: 10 }}>
        运行时：{environment.runtimeSelection.selected === 'bundled' ? '内置' : '本机'}
        {environment.runtimeSelection.fallbackUsed ? ` · 已从本机环境回退（${environment.runtimeSelection.reason ?? '不可用'}）` : ''}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
        {environment.components.map((component) => <div key={component.id} style={{ borderTop: '1px solid var(--border)', paddingTop: 8, fontSize: 12 }}><div style={{ display: 'flex', justifyContent: 'space-between' }}><span>{component.name}</span><span style={{ color: component.ready ? 'var(--success)' : 'var(--warning)' }}>{component.ready ? '就绪' : '缺失'}</span></div><div style={{ color: 'var(--text-3)', fontSize: 10.5, marginTop: 3 }}>{component.version ?? component.selectedAdapter ?? component.reason ?? '未检测'} · {component.kind}</div></div>)}
      </div>
    </div>
  );
}
