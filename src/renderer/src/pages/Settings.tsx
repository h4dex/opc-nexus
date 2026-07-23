/** 设置（PRD 5：外观 / 供应商 / 下载源 / 通知 / 安全 / 数据 / 关于） */
import { useEffect, useState } from 'react';
import { useApp } from '../store';
import { IconMoon, IconSun } from '../components/icons';
import type { SystemInfo } from '@shared/types';

export function Settings() {
  const { theme, setTheme } = useApp();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [cpuAlert, setCpuAlert] = useState(85);
  const [memAlert, setMemAlert] = useState(85);
  const [gpuTempAlert, setGpuTempAlert] = useState(85);
  const [notifications, setNotifications] = useState(true);
  const [demoAutoTasks, setDemoAutoTasks] = useState(true);

  useEffect(() => {
    void window.aibox.getSystemInfo().then(setInfo);
    void window.aibox.getSetting('thresholds').then((v) => {
      const t = v as { cpu?: number; mem?: number; gpuTemp?: number } | null;
      if (t) {
        setCpuAlert(t.cpu ?? 85);
        setMemAlert(t.mem ?? 85);
        setGpuTempAlert(t.gpuTemp ?? 85);
      }
    });
    void window.aibox.getSetting('notifications').then((v) => setNotifications(v !== false));
    void window.aibox.getSetting('demoAutoTasks').then((v) => setDemoAutoTasks(v !== false));
  }, []);

  const saveThresholds = () => {
    void window.aibox.setSetting('thresholds', { cpu: cpuAlert, mem: memAlert, gpuTemp: gpuTempAlert });
  };

  return (
    <>
      <div className="page-head">
        <h2>设置</h2>
        <span className="desc">外观 · 模型供应商 · 下载源 · 资源阈值 · 关于</span>
      </div>

      <div className="dash-grid">
        <ProviderCard />
        <RegistryCard />
        <BridgeCard />

        <div className="card">
          <div className="card-title">外观</div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className={`btn ${theme === 'dark' ? 'primary' : ''}`} onClick={() => setTheme('dark')}>
              <IconMoon size={15} />暗色主题
            </button>
            <button className={`btn ${theme === 'light' ? 'primary' : ''}`} onClick={() => setTheme('light')}>
              <IconSun size={15} />白色主题
            </button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 10 }}>主题切换即时生效，无需重启（6.5 验收）。</div>
        </div>

        <div className="card">
          <div className="card-title">通知与演示</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={notifications}
                onChange={(e) => { setNotifications(e.target.checked); void window.aibox.setSetting('notifications', e.target.checked); }} />
              系统通知（审批到达 / 任务失败 / 引擎待登录 / 资源告警）
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={demoAutoTasks}
                onChange={(e) => { setDemoAutoTasks(e.target.checked); void window.aibox.setSetting('demoAutoTasks', e.target.checked); }} />
              演示自动派单（仅对演示模式员工自动补位；接入真实引擎后建议关闭）
            </label>
          </div>
        </div>

        <div className="card">
          <div className="card-title">资源告警阈值（产品默认值，管理员可调整）</div>
          <div className="field">
            <label>CPU 告警（持续 5 分钟 ≥ %）</label>
            <input type="number" min={50} max={100} value={cpuAlert} onChange={(e) => setCpuAlert(Number(e.target.value))} />
          </div>
          <div className="field">
            <label>内存告警（≥ %）</label>
            <input type="number" min={50} max={100} value={memAlert} onChange={(e) => setMemAlert(Number(e.target.value))} />
          </div>
          <div className="field">
            <label>GPU 温度告警（℃）</label>
            <input type="number" min={50} max={110} value={gpuTempAlert} onChange={(e) => setGpuTempAlert(Number(e.target.value))} />
          </div>
          <button className="btn primary" onClick={saveThresholds}>保存阈值</button>
        </div>

        <div className="card">
          <div className="card-title">安全与数据</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 2 }}>
            <div>· 凭据存储：{info?.platform === 'win32' ? 'Windows Credential Manager (DPAPI)' : 'Linux Secret Service (libsecret)'}，密钥不进入 Renderer / localStorage</div>
            <div>· 渲染进程：contextIsolation 开启、nodeIntegration 关闭，IPC 白名单</div>
            <div>· 资源明细保留 7 天；任务日志保留 90 天；审计索引保留 1 年</div>
            <div>· 高风险操作必须审批；渠道不可静默批准安装 / 提权 / 目录外写入</div>
          </div>
        </div>

        <div className="card">
          <div className="card-title">关于</div>
          <table className="table">
            <tbody>
              <tr><td style={{ color: 'var(--text-2)', width: 120 }}>产品</td><td>数字员工 AI Box 控制中心</td></tr>
              <tr><td style={{ color: 'var(--text-2)' }}>版本</td><td>v{info?.appVersion ?? '1.0.0'}</td></tr>
              <tr><td style={{ color: 'var(--text-2)' }}>平台</td><td>{info?.platform === 'win32' ? 'Windows' : info?.platform === 'linux' ? 'Ubuntu / Linux' : info?.platform} ({info?.osVersion})</td></tr>
              <tr><td style={{ color: 'var(--text-2)' }}>设备</td><td>{info?.hostname ?? '—'}</td></tr>
              <tr><td style={{ color: 'var(--text-2)' }}>数据目录</td><td style={{ fontSize: 12 }}>用户数据目录 / aibox-data（继承 OS 用户 ACL）</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/** 多供应商管理：列表 + 添加/编辑/删除/测试/设为默认 */
const MODEL_PRESETS = ['deepseek-chat', 'deepseek-reasoner', 'gpt-4o-mini', 'gpt-4o', 'qwen-plus', 'qwen-turbo', 'moonshot-v1-8k', 'llama3.1'];

interface ProviderItem { id: string; name: string; baseUrl: string; model: string; isDefault: boolean; hasKey: boolean }

function ProviderCard() {
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; msg: string }>>({});
  const [saved, setSaved] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);

  const load = () => { void window.aibox.listProviders().then(setProviders); };
  useEffect(() => { load(); }, []);

  const resetForm = () => { setName(''); setBaseUrl(''); setModel(''); setApiKey(''); setIsDefault(false); setEditId(null); setShowForm(false); };

  const startEdit = (p: ProviderItem) => {
    setEditId(p.id); setName(p.name); setBaseUrl(p.baseUrl); setModel(p.model); setApiKey(''); setIsDefault(p.isDefault); setShowForm(true);
  };

  const save = async () => {
    if (!name.trim() || !baseUrl.trim()) return;
    if (editId) {
      await window.aibox.updateProvider(editId, { name, baseUrl, model, apiKey: apiKey || undefined, isDefault });
    } else {
      await window.aibox.createProvider({ name, baseUrl, model, apiKey: apiKey || undefined, isDefault });
    }
    setSaved(true); setTimeout(() => setSaved(false), 2000);
    resetForm(); load();
  };

  const testConn = async (p: ProviderItem) => {
    setTesting(p.id);
    try {
      const r = await window.aibox.testProviderById(p.id);
      setTestResult((prev) => ({ ...prev, [p.id]: { ok: r.ok, msg: r.ok ? `连接成功 (${r.latencyMs}ms)` : r.error ?? '失败' } }));
    } finally { setTesting(null); }
  };

  const removeP = async (id: string) => { await window.aibox.removeProvider(id); load(); };
  const setDefault = async (id: string) => { await window.aibox.updateProvider(id, { isDefault: true }); load(); };

  const inputStyle: React.CSSProperties = { width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-1)', fontSize: 12.5, outline: 'none' };

  return (
    <div className="card" style={{ gridColumn: '1 / -1' }}>
      <div className="card-title">模型供应商管理<span className="sub">支持多供应商同时接入，员工可独立选择</span>
        <button className="btn small primary" style={{ marginLeft: 'auto' }} onClick={() => { resetForm(); setShowForm(true); }}>添加供应商</button>
      </div>

      {/* 供应商列表 */}
      {providers.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--text-3)', padding: '12px 0' }}>未配置任何供应商。点击「添加供应商」接入 DeepSeek/OpenAI/Ollama 等模型服务。</div>}
      <div style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
        {providers.map((p) => (
          <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 8, background: 'var(--input-bg)', border: `1px solid ${p.isDefault ? 'var(--accent)' : 'var(--border)'}` }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 650, fontSize: 13 }}>{p.name}</span>
                {p.isDefault && <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: 'var(--accent-soft)', color: 'var(--accent)', fontWeight: 650 }}>默认</span>}
                <span style={{ fontSize: 10.5, color: p.hasKey ? 'var(--success)' : 'var(--danger)' }}>{p.hasKey ? '已配置 Key' : '未配置 Key'}</span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.baseUrl} · {p.model}
              </div>
              {testResult[p.id] && <div style={{ fontSize: 11, marginTop: 2, color: testResult[p.id].ok ? 'var(--success)' : 'var(--danger)' }}>{testResult[p.id].msg}</div>}
            </div>
            <button className="btn small" disabled={testing === p.id} onClick={() => void testConn(p)}>{testing === p.id ? '测试中' : '测试'}</button>
            {!p.isDefault && <button className="btn small" onClick={() => void setDefault(p.id)}>设为默认</button>}
            <button className="btn small" onClick={() => startEdit(p)}>编辑</button>
            <button className="btn small danger" onClick={() => void removeP(p.id)}>删除</button>
          </div>
        ))}
      </div>

      {/* 添加/编辑表单 */}
      {showForm && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 10 }}>{editId ? '编辑供应商' : '添加供应商'}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div>
              <label style={{ fontSize: 11, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>名称 *</label>
              <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="DeepSeek / OpenAI / Ollama" />
            </div>
            <div>
              <label style={{ fontSize: 11, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>模型</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input style={{ ...inputStyle, flex: 1 }} value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-chat" list="model-presets" />
                {editId && <button className="btn small" disabled={fetchingModels} onClick={() => { setFetchingModels(true); void window.aibox.fetchProviderModels(editId).then((r) => { if (r.ok) setFetchedModels(r.models); setFetchingModels(false); }); }}>{fetchingModels ? '获取中' : '获取模型'}</button>}
              </div>
              <datalist id="model-presets">{(fetchedModels.length > 0 ? fetchedModels : MODEL_PRESETS).map((m) => <option key={m} value={m} />)}</datalist>
            </div>
          </div>
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 11, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>Base URL（OpenAI 兼容接口）*</label>
            <input style={inputStyle} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com/v1" />
          </div>
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 11, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>API Key{editId ? '（留空表示沿用已存）' : ''}</label>
            <input style={inputStyle} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." autoComplete="off" />
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, cursor: 'pointer' }}>
              <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
              设为默认供应商
            </label>
            <button className="btn primary" disabled={!name.trim() || !baseUrl.trim()} onClick={() => void save()}>{editId ? '保存修改' : '添加'}</button>
            <button className="btn" onClick={resetForm}>取消</button>
            {saved && <span style={{ fontSize: 12, color: 'var(--success)' }}>✓ 已保存</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/** 引擎下载源：写入配置文件 aibox.config.json（自动安装时作为 npm registry） */
function RegistryCard() {
  const [registry, setRegistry] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void window.aibox.getAppConfig().then((c) => setRegistry(c.npmRegistry));
  }, []);

  const save = async () => {
    setError('');
    const next = await window.aibox.setAppConfig({ npmRegistry: registry });
    setRegistry(next.npmRegistry);
    if (next.npmRegistry !== registry.trim().replace(/\/+$/, '')) {
      setError('地址不合法（仅支持 http/https URL），已保留原配置');
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div className="card">
      <div className="card-title">引擎下载源<span className="sub">存于配置文件 aibox.config.json，可直接编辑</span></div>
      <div className="field">
        <label>npm registry（引擎自动安装的默认下载地址）</label>
        <input value={registry} onChange={(e) => setRegistry(e.target.value)} placeholder="https://registry.npmjs.org" />
        <div className="hint">国内网络可改用镜像源，例如 https://registry.npmmirror.com</div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn primary" onClick={() => void save()}>保存</button>
        {saved && <span style={{ fontSize: 12, color: 'var(--success)' }}>✓ 已写入配置文件</span>}
        {error && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</span>}
      </div>
    </div>
  );
}

/** API Bridge 反向代理卡片 */
function BridgeCard() {
  const [status, setStatus] = useState<{ running: boolean; port: number; bridgeKey: string; enabled: boolean } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => { void window.aibox.getBridgeStatus().then(setStatus); }, []);

  const toggle = async (enabled: boolean) => {
    const s = await window.aibox.toggleBridge(enabled);
    setStatus(s);
  };

  const regen = async () => {
    const s = await window.aibox.regenerateBridgeKey();
    setStatus(s);
  };

  const copyKey = () => {
    if (!status) return;
    void navigator.clipboard.writeText(status.bridgeKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!status) return null;

  return (
    <div className="card" style={{ gridColumn: '1 / -1' }}>
      <div className="card-title">API Bridge（本地反向代理）<span className="sub">让 Claude Code / Codex / OpenCode 等引擎通过本地端点调用模型</span></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={status.enabled} onChange={(e) => void toggle(e.target.checked)} style={{ accentColor: 'var(--accent)', width: 16, height: 16 }} />
          启用 API Bridge
        </label>
        <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 4, background: status.running ? 'var(--success-soft, rgba(34,197,94,.1))' : 'var(--input-bg)', color: status.running ? 'var(--success)' : 'var(--text-3)' }}>
          {status.running ? `运行中 :${status.port}` : '已停止'}
        </span>
      </div>

      {status.enabled && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
            <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--input-bg)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>本地端点 (Base URL)</div>
              <code style={{ fontSize: 13, color: 'var(--accent)', fontWeight: 650 }}>http://127.0.0.1:{status.port}/v1</code>
            </div>
            <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--input-bg)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>Bridge API Key</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <code style={{ fontSize: 12, color: 'var(--text-1)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{status.bridgeKey.slice(0, 20)}...</code>
                <button className="btn small" onClick={copyKey}>{copied ? '✓ 已复制' : '复制'}</button>
                <button className="btn small" onClick={() => void regen()}>重新生成</button>
              </div>
            </div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.8, background: 'var(--input-bg)', padding: '10px 14px', borderRadius: 8 }}>
            <b>使用方法：</b>在 Claude Code / Codex / OpenCode 等工具中配置：<br />
            <code style={{ fontSize: 11.5 }}>OPENAI_BASE_URL=http://127.0.0.1:{status.port}/v1</code><br />
            <code style={{ fontSize: 11.5 }}>OPENAI_API_KEY={status.bridgeKey.slice(0, 16)}...</code><br />
            请求将自动转发到系统内配置的模型供应商（按 model 名路由）。
          </div>
        </>
      )}
    </div>
  );
}
