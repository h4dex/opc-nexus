/** 引擎中心：检测、安装、登录、默认引擎、健康状态 + 配置面板 + 日志 + 指标 + 自定义注册 */
import { useState } from 'react';
import { useApp } from '../store';
import { IconAlert, IconChip, IconRefresh, IconPlus } from '../components/icons';
import type { Engine } from '@shared/types';

const STATUS_META: Record<Engine['status'], { label: string; tag: string }> = {
  NOT_INSTALLED: { label: '未安装', tag: 'gray' },
  INSTALLING: { label: '安装中', tag: 'blue' },
  SETUP_REQUIRED: { label: '待配置（演示模式）', tag: 'orange' },
  AUTH_REQUIRED: { label: '待登录', tag: 'orange' },
  HEALTHY: { label: '健康', tag: 'green' },
  DEGRADED: { label: '降级', tag: 'orange' },
  ERROR: { label: '异常', tag: 'red' }
};

export function Engines() {
  const { snapshot } = useApp();
  const [detecting, setDetecting] = useState(false);
  const [installMsg, setInstallMsg] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [configEngine, setConfigEngine] = useState<Engine | null>(null);
  const [logsEngine, setLogsEngine] = useState<Engine | null>(null);
  const [showRegister, setShowRegister] = useState(false);
  if (!snapshot) return null;
  const { engines, executorAvailable } = snapshot;

  const redetect = async () => {
    setDetecting(true);
    try { await window.aibox.detectEngines(); } finally { setDetecting(false); }
  };

  const install = async (id: string) => {
    setInstallMsg((m) => ({ ...m, [id]: { ok: true, message: '正在下载安装…' } }));
    const r = await window.aibox.installEngine(id);
    setInstallMsg((m) => ({ ...m, [id]: r }));
  };

  const showGuide = async (id: string) => {
    const g = await window.aibox.getInstallGuide(id);
    if (!g) return;
    setInstallMsg((m) => ({ ...m, [id]: { ok: true, message: `手工安装指引：${g.guide}` } }));
    if (g.url) void window.aibox.openExternal(g.url);
  };

  const restart = async (id: string) => {
    setInstallMsg((m) => ({ ...m, [id]: { ok: true, message: '正在重新检测引擎…' } }));
    const r = await window.aibox.restartEngine(id);
    setInstallMsg((m) => ({ ...m, [id]: r }));
  };

  return (
    <>
      <div className="page-head">
        <h2>引擎中心</h2>
        <span className="desc">检测、安装、配置、监控执行引擎 · 支持自定义引擎注册</span>
        <div className="right">
          <button className="btn small" onClick={() => setShowRegister(true)}><IconPlus size={13} />注册引擎</button>
          <button className="btn small" disabled={detecting} onClick={() => void redetect()}>
            <IconRefresh size={13} />{detecting ? '检测中…' : '重新检测'}
          </button>
        </div>
      </div>

      {!executorAvailable && (
        <div className="card" style={{ marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center', color: 'var(--warning)', background: 'var(--warning-soft)' }}>
          <IconAlert size={18} />
          <div style={{ fontSize: 12.5, lineHeight: 1.8 }}>
            <b>未检测到可用执行引擎，系统当前以演示模式运行。</b>
            请安装下方任一 CLI 引擎，或在设置页完成模型供应商配置。
          </div>
        </div>
      )}

      <div className="agent-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}>
        {engines.map((e) => {
          const meta = STATUS_META[e.status];
          const msg = installMsg[e.id];
          return (
            <div className="card" key={e.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <div className="agent-avatar" style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                  <IconChip size={24} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 650, fontSize: 14.5, display: 'flex', gap: 8, alignItems: 'center' }}>
                    {e.name}
                    {e.isDefault && <span className="tag blue">默认</span>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>
                    {e.version ? `v${e.version}` : '—'} · 运行实例 {e.runningInstances}
                  </div>
                </div>
                <span className={`tag ${meta.tag}`}>{meta.label}</span>
              </div>

              <div style={{ fontSize: 12, color: 'var(--text-2)', background: 'var(--input-bg)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
                数据边界：{e.dataBoundary}
              </div>

              {e.path && (
                <div style={{ fontSize: 12, color: 'var(--text-2)', background: 'var(--input-bg)', borderRadius: 8, padding: '8px 12px', marginBottom: 12, wordBreak: 'break-all' }}>
                  安装路径：<code style={{ fontSize: 11.5 }}>{e.path}</code>
                </div>
              )}

              {/* 性能指标 */}
              <EngineMetrics engineId={e.id} />

              {msg && (
                <div style={{ fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap', color: msg.ok ? 'var(--text-2)' : 'var(--danger)', background: 'var(--input-bg)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
                  {msg.message}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {e.status === 'NOT_INSTALLED' && e.installable && (
                  <button className="btn small primary" onClick={() => void install(e.id)}>自动安装</button>
                )}
                {e.status === 'NOT_INSTALLED' && (
                  <button className="btn small" onClick={() => void showGuide(e.id)}>安装指引</button>
                )}
                {e.status === 'INSTALLING' && (
                  <button className="btn small" disabled><IconRefresh size={13} />安装中…</button>
                )}
                {e.status === 'SETUP_REQUIRED' && (
                  <span style={{ fontSize: 12, color: 'var(--warning)', alignSelf: 'center' }}>请在设置页完成模型供应商配置</span>
                )}
                {e.status === 'AUTH_REQUIRED' && (
                  <button className="btn small primary" onClick={() => void window.aibox.authEngine(e.id)}>登录授权</button>
                )}
                {(e.status === 'HEALTHY' || e.status === 'DEGRADED' || e.status === 'SETUP_REQUIRED') && (
                  <button className="btn small" onClick={() => void restart(e.id)} title="重新检测引擎状态">
                    <IconRefresh size={13} />重启
                  </button>
                )}
                {e.status === 'HEALTHY' && !e.isDefault && (
                  <button className="btn small" onClick={() => void window.aibox.setDefaultEngine(e.id)}>设为默认</button>
                )}
                <button className="btn small" onClick={() => setConfigEngine(e)}>配置</button>
                <button className="btn small" onClick={() => setLogsEngine(e)}>日志</button>
              </div>
            </div>
          );
        })}
      </div>

      {/* 配置面板 */}
      {configEngine && <EngineConfigPanel engine={configEngine} onClose={() => setConfigEngine(null)} />}
      {/* 日志面板 */}
      {logsEngine && <EngineLogsPanel engine={logsEngine} onClose={() => setLogsEngine(null)} />}
      {/* 自定义引擎注册 */}
      {showRegister && <RegisterEngineModal onClose={() => setShowRegister(false)} />}
    </>
  );
}

/** 引擎性能指标（异步加载） */
function EngineMetrics({ engineId }: { engineId: string }) {
  const [metrics, setMetrics] = useState<{ avgLatencyMs: number; successRate: number; totalRuns: number } | null>(null);
  const [loaded, setLoaded] = useState(false);
  if (!loaded) {
    void window.aibox.getEngineMetrics(engineId).then((m) => { setMetrics(m); setLoaded(true); });
    return null;
  }
  if (!metrics || metrics.totalRuns === 0) return null;
  return (
    <div style={{ display: 'flex', gap: 12, fontSize: 11.5, color: 'var(--text-2)', background: 'var(--input-bg)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
      <span>平均响应: <b style={{ color: 'var(--accent)' }}>{metrics.avgLatencyMs}ms</b></span>
      <span>成功率: <b style={{ color: metrics.successRate >= 80 ? 'var(--success)' : 'var(--danger)' }}>{metrics.successRate}%</b></span>
      <span>总执行: <b>{metrics.totalRuns}</b></span>
    </div>
  );
}

/** 引擎配置面板弹窗 */
function EngineConfigPanel({ engine, onClose }: { engine: Engine; onClose: () => void }) {
  const [runArgs, setRunArgs] = useState('');
  const [envText, setEnvText] = useState('');
  const [maxConcurrency, setMaxConcurrency] = useState(2);
  const [saved, setSaved] = useState(false);
  const [loaded, setLoaded] = useState(false);

  if (!loaded) {
    void window.aibox.getEngineConfig(engine.id).then((c) => {
      if (c) {
        setRunArgs((c.runArgs ?? []).join(' '));
        setEnvText(Object.entries(c.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'));
        setMaxConcurrency(c.maxConcurrency ?? 2);
      }
      setLoaded(true);
    });
    return null;
  }

  const save = async () => {
    const env: Record<string, string> = {};
    envText.split('\n').filter(Boolean).forEach((line) => {
      const idx = line.indexOf('=');
      if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });
    await window.aibox.saveEngineConfig(engine.id, {
      runArgs: runArgs.split(' ').filter(Boolean),
      env: Object.keys(env).length > 0 ? env : undefined,
      maxConcurrency
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)',
    background: 'var(--input-bg)', color: 'var(--text-1)', fontSize: 12.5, outline: 'none'
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div className="card" style={{ width: 480, maxHeight: '70vh', overflowY: 'auto', padding: 20 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>引擎配置 · {engine.name}</h3>
          <button className="btn small" onClick={onClose}>关闭</button>
        </div>
        <label style={{ fontSize: 11.5, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>运行参数（空格分隔）</label>
        <input style={{ ...inputStyle, marginBottom: 12 }} value={runArgs} onChange={(e) => setRunArgs(e.target.value)} placeholder="--model gpt-4o --verbose" />
        <label style={{ fontSize: 11.5, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>环境变量（每行 KEY=VALUE）</label>
        <textarea style={{ ...inputStyle, minHeight: 80, resize: 'vertical', marginBottom: 12, fontFamily: 'monospace' }} value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder={'API_KEY=sk-...\nDEBUG=1'} />
        <label style={{ fontSize: 11.5, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>最大并发数</label>
        <input style={{ ...inputStyle, marginBottom: 16 }} type="number" min={1} max={10} value={maxConcurrency} onChange={(e) => setMaxConcurrency(Number(e.target.value))} />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn primary" onClick={() => void save()}>保存配置</button>
          {saved && <span style={{ fontSize: 12, color: 'var(--success)' }}>✓ 已保存</span>}
        </div>
      </div>
    </div>
  );
}

/** 引擎日志面板弹窗 */
function EngineLogsPanel({ engine, onClose }: { engine: Engine; onClose: () => void }) {
  const [logs, setLogs] = useState<{ id: string; level: string; message: string; timestamp: number }[] | null>(null);

  if (!logs) {
    void window.aibox.getEngineLogs(engine.id).then(setLogs);
    return null;
  }

  const levelColor = (l: string) => l === 'error' ? 'var(--danger)' : l === 'warn' ? 'var(--warning)' : 'var(--text-2)';

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div className="card" style={{ width: 600, maxHeight: '70vh', overflowY: 'auto', padding: 20 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>引擎日志 · {engine.name}</h3>
          <button className="btn small" onClick={onClose}>关闭</button>
        </div>
        {logs.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: 12.5, padding: 20, textAlign: 'center' }}>暂无日志记录</div>}
        <div style={{ fontFamily: 'monospace', fontSize: 11.5, lineHeight: 2 }}>
          {logs.map((l) => (
            <div key={l.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
              <span style={{ color: 'var(--text-3)', minWidth: 70, flexShrink: 0 }}>
                {new Date(l.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}
              </span>
              <span style={{ color: levelColor(l.level), fontWeight: 650, minWidth: 40, flexShrink: 0, textTransform: 'uppercase' }}>{l.level}</span>
              <span style={{ color: 'var(--text-1)', wordBreak: 'break-all' }}>{l.message}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 自定义引擎注册弹窗 */
function RegisterEngineModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [dataBoundary, setDataBoundary] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const register = async () => {
    setBusy(true);
    const r = await window.aibox.registerCustomEngine({ name, command, args: args || undefined, dataBoundary: dataBoundary || undefined });
    setMsg(r.message);
    setBusy(false);
    if (r.ok) setTimeout(onClose, 1500);
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)',
    background: 'var(--input-bg)', color: 'var(--text-1)', fontSize: 12.5, outline: 'none'
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div className="card" style={{ width: 460, padding: 20 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>注册自定义引擎</h3>
          <button className="btn small" onClick={onClose}>关闭</button>
        </div>
        <label style={{ fontSize: 11.5, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>引擎名称 *</label>
        <input style={{ ...inputStyle, marginBottom: 12 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如: My Custom LLM" />
        <label style={{ fontSize: 11.5, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>可执行命令 *</label>
        <input style={{ ...inputStyle, marginBottom: 12 }} value={command} onChange={(e) => setCommand(e.target.value)} placeholder="例如: my-llm-cli 或 /usr/local/bin/my-engine" />
        <label style={{ fontSize: 11.5, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>默认参数（可选）</label>
        <input style={{ ...inputStyle, marginBottom: 12 }} value={args} onChange={(e) => setArgs(e.target.value)} placeholder="--mode chat --output json" />
        <label style={{ fontSize: 11.5, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>数据边界说明（可选）</label>
        <input style={{ ...inputStyle, marginBottom: 16 }} value={dataBoundary} onChange={(e) => setDataBoundary(e.target.value)} placeholder="数据发送至自建服务器" />
        {msg && <div style={{ fontSize: 12.5, marginBottom: 10, color: msg.includes('已注册') ? 'var(--success)' : 'var(--danger)' }}>{msg}</div>}
        <button className="btn primary" disabled={busy || !name.trim() || !command.trim()} onClick={() => void register()}>
          {busy ? '注册中…' : '注册引擎'}
        </button>
      </div>
    </div>
  );
}
