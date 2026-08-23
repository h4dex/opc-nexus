/** 设置（PRD 5：外观 / 供应商 / 下载源 / 通知 / 安全 / 数据 / 关于） */
import { useEffect, useState } from 'react';
import { useApp } from '../store';
import { IconMoon, IconSun } from '../components/icons';
import { toast } from '../components/Toast';
import type {
  ApiBridgeStatus,
  DebugLogStatus,
  VisionModelBindingView,
  SystemInfo,
  VoiceConfig,
  VoiceConfigInput
} from '@shared/types';

export function Settings() {
  const { theme, setTheme } = useApp();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [cpuAlert, setCpuAlert] = useState(85);
  const [memAlert, setMemAlert] = useState(85);
  const [gpuTempAlert, setGpuTempAlert] = useState(85);
  const [notifications, setNotifications] = useState(true);

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
    // 默认关闭：生产环境绝不自动造任务（与主进程 orchestrator 默认值保持一致）
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
        <VisionCard />
        <VoiceCard />
        <RegistryCard />
        <BridgeCard />
        <DebugLogCard />

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
          <div className="card-title">通知</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={notifications}
                onChange={(e) => { setNotifications(e.target.checked); void window.aibox.setSetting('notifications', e.target.checked); }} />
              系统通知（审批到达 / 任务失败 / 引擎待登录 / 资源告警）
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
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
            <button className="btn small" onClick={() => {
              void window.aibox.exportData().then((r) => {
                if (r.ok) toast.ok(r.message); else if (r.message !== '已取消') toast.err(r.message);
              });
            }}>📦 导出数据库备份</button>
            <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>本地优先：数据全量存于本机，可随时备份迁移</span>
          </div>
        </div>

        <OcrCard />

        <div className="card">
          <div className="card-title">关于</div>
          <table className="table">
            <tbody>
              <tr><td style={{ color: 'var(--text-2)', width: 120 }}>产品</td><td>数字员工 AI Box 控制中心</td></tr>
              <tr><td style={{ color: 'var(--text-2)' }}>版本</td><td>v{info?.appVersion ?? '2.0.0'}</td></tr>
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

function DebugLogCard() {
  const [status, setStatus] = useState<DebugLogStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try { setStatus(await window.aibox.getDebugLogStatus()); }
    catch (error) { toast.err(error instanceof Error ? error.message : '无法读取调试日志状态'); }
  };

  useEffect(() => { void load(); }, []);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      setStatus(await window.aibox.setDebugMode(enabled));
      toast.ok(enabled ? '调试模式已开启' : '调试模式已关闭');
    } catch (error) {
      toast.err(error instanceof Error ? error.message : '调试模式更新失败');
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ gridColumn: '1 / -1' }}>
      <div className="card-title">调试日志<span className="sub">仅在开启时写入，敏感凭据自动脱敏</span></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: busy ? 'wait' : 'pointer' }}>
          <input
            type="checkbox"
            checked={status?.enabled ?? false}
            disabled={busy || !status}
            onChange={(event) => void toggle(event.target.checked)}
          />
          启用调试模式
        </label>
        <span className={`tag ${status?.enabled ? 'green' : 'gray'}`}>{status?.enabled ? '正在记录' : '已关闭'}</span>
        <button className="btn small" type="button" disabled={!status} onClick={() => {
          void window.aibox.openDebugLogDirectory().catch((error) => {
            toast.err(error instanceof Error ? error.message : '无法打开日志目录');
          });
        }}>打开日志目录</button>
      </div>
      <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.8, wordBreak: 'break-all' }}>
        <div>目录：<code>{status?.logDirectory ?? '读取中'}</code></div>
        <div>当前文件：<code>{status?.currentFile ?? '尚未写入'}</code></div>
        <div>轮转：单文件最多 {status ? Math.round(status.maxFileBytes / 1024 / 1024) : 5} MB，当前保留 {status?.retainedFiles ?? 0} 个文件</div>
        {status?.lastError && <div style={{ color: 'var(--danger)' }}>写入错误：{status.lastError}</div>}
      </div>
    </div>
  );
}

/**
 * 语音任务下达配置：阿里云 NLS 凭据。
 * 凭据经 IPC 交给主进程走 safeStorage 加密，此处只显示是否已配置，不回显明文。
 */
function VoiceCard() {
  const [cfg, setCfg] = useState<VoiceConfig | null>(null);
  const [appKey, setAppKey] = useState('');
  const [keyId, setKeyId] = useState('');
  const [keySecret, setKeySecret] = useState('');
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => {
    void window.aibox.getVoiceConfig().then((c) => { setCfg(c); setAppKey(c.appKey); });
  };
  useEffect(() => { load(); }, []);
  if (!cfg) return null;

  const save = async (patch: VoiceConfigInput) => {
    const next = await window.aibox.saveVoiceConfig(patch);
    setCfg(next);
    setKeyId(''); setKeySecret(''); // 提交后清空输入框，避免明文停留在内存/界面
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const test = async () => {
    setTesting(true);
    try {
      const r = await window.aibox.testVoice();
      setTestMsg({
        ok: r.ok,
        text: r.ok ? `可用（阿里云 NLS，${r.latencyMs}ms）` : r.error ?? '不可用'
      });
    } finally { setTesting(false); }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)',
    background: 'var(--input-bg)', color: 'var(--text-1)', fontSize: 12.5, outline: 'none'
  };
  const labelStyle: React.CSSProperties = { fontSize: 11.5, color: 'var(--text-2)', display: 'block', marginBottom: 4 };

  return (
    <div className="card" style={{ gridColumn: '1 / -1' }}>
      <div className="card-title">
        语音任务下达<span className="sub">说话即可安排任务 · 识别结果需确认后才派发</span>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer', marginBottom: 12 }}>
        <input type="checkbox" checked={cfg.enabled} onChange={(e) => void save({ enabled: e.target.checked })} />
        启用语音任务下达
      </label>

      <label style={labelStyle}>识别通道</label>
      <div style={{ ...inputStyle, marginBottom: 12 }}>阿里云 NLS 实时识别</div>

      <div style={{ fontSize: 12, color: 'var(--text-2)', background: 'var(--input-bg)', borderRadius: 8, padding: '8px 12px', marginBottom: 12, lineHeight: 1.8 }}>
        云端凭据：AppKey {cfg.appKey ? '已填' : <span style={{ color: 'var(--danger)' }}>未填</span>} ·
        AccessKeyId {cfg.hasAccessKeyId ? '已配置' : <span style={{ color: 'var(--danger)' }}>未配置</span>} ·
        AccessKeySecret {cfg.hasAccessKeySecret ? '已配置' : <span style={{ color: 'var(--danger)' }}>未配置</span>}
      </div>

      <label style={labelStyle}>AppKey（阿里云智能语音交互项目 AppKey）</label>
      <input style={{ ...inputStyle, marginBottom: 10 }} value={appKey} onChange={(e) => setAppKey(e.target.value)} placeholder="项目 AppKey" />

      <label style={labelStyle}>AccessKeyId{cfg.hasAccessKeyId && '（留空则沿用已存值）'}</label>
      <input style={{ ...inputStyle, marginBottom: 10 }} type="password" value={keyId} onChange={(e) => setKeyId(e.target.value)}
        placeholder={cfg.hasAccessKeyId ? '••••••（已配置）' : 'LTAI...'} autoComplete="off" />

      <label style={labelStyle}>AccessKeySecret{cfg.hasAccessKeySecret && '（留空则沿用已存值）'}</label>
      <input style={{ ...inputStyle, marginBottom: 10 }} type="password" value={keySecret} onChange={(e) => setKeySecret(e.target.value)}
        placeholder={cfg.hasAccessKeySecret ? '••••••（已配置）' : 'AccessKeySecret'} autoComplete="off" />

      <label style={labelStyle}>静音判定（毫秒）：说完停顿多久算一句话结束</label>
      <input style={{ ...inputStyle, marginBottom: 14 }} type="number" min={300} max={5000} step={100}
        value={cfg.silenceMs} onChange={(e) => void save({ silenceMs: Number(e.target.value) })} />

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn primary" onClick={() => void save({ appKey, accessKeyId: keyId || undefined, accessKeySecret: keySecret || undefined })}>
          保存配置
        </button>
        <button className="btn" disabled={testing} onClick={() => void test()}>{testing ? '检测中…' : '检测可用性'}</button>
        <button className="btn small" onClick={() => void window.aibox.openExternal('https://nls-portal.console.aliyun.com/')}>
          获取凭据
        </button>
        {saved && <span style={{ fontSize: 12, color: 'var(--success)' }}>✓ 已保存</span>}
        {testMsg && <span style={{ fontSize: 12, color: testMsg.ok ? 'var(--success)' : 'var(--danger)' }}>{testMsg.text}</span>}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 8, lineHeight: 1.7 }}>
        凭据经系统密钥库加密存储，不会明文落库、不会回传界面。音频由主进程转发至识别服务，渲染进程不接触凭据。
      </div>
    </div>
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
  const [error, setError] = useState('');
  const [fetchingModels, setFetchingModels] = useState(false);

  const load = () => { void window.aibox.listProviders().then(setProviders); };
  useEffect(() => { load(); }, []);

  const resetForm = () => {
    setName(''); setBaseUrl(''); setModel(''); setApiKey(''); setIsDefault(false);
    setEditId(null); setShowForm(false); setError('');
  };

  const startEdit = (p: ProviderItem) => {
    setEditId(p.id); setName(p.name); setBaseUrl(p.baseUrl); setModel(p.model); setApiKey(''); setIsDefault(p.isDefault); setShowForm(true);
  };

  const save = async () => {
    if (!name.trim() || !baseUrl.trim() || !model.trim()) return;
    setError('');
    try {
      if (editId) {
        await window.aibox.updateProvider(editId, { name, baseUrl, model, apiKey: apiKey || undefined, isDefault });
      } else {
        await window.aibox.createProvider({ name, baseUrl, model, apiKey: apiKey || undefined, isDefault });
      }
      setSaved(true); setTimeout(() => setSaved(false), 2000);
      resetForm(); load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const testConn = async (p: ProviderItem) => {
    setTesting(p.id);
    try {
      const r = await window.aibox.testProviderById(p.id);
      setTestResult((prev) => ({ ...prev, [p.id]: { ok: r.ok, msg: r.ok ? `连接成功 (${r.latencyMs}ms)` : r.error ?? '失败' } }));
    } finally { setTesting(null); }
  };

  const removeP = async (id: string) => {
    setError('');
    try { await window.aibox.removeProvider(id); load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const setDefault = async (id: string) => {
    setError('');
    try { await window.aibox.updateProvider(id, { isDefault: true }); load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const inputStyle: React.CSSProperties = { width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-1)', fontSize: 12.5, outline: 'none' };

  return (
    <div className="card" style={{ gridColumn: '1 / -1' }}>
      <div className="card-title">模型供应商管理<span className="sub">支持多供应商同时接入，员工可独立选择</span>
        <button className="btn small primary" style={{ marginLeft: 'auto' }} onClick={() => { resetForm(); setShowForm(true); }}>添加供应商</button>
      </div>

      {/* 供应商列表 */}
      {providers.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--text-3)', padding: '12px 0' }}>未配置任何供应商。点击「添加供应商」接入 DeepSeek/OpenAI/Ollama 等模型服务。</div>}
      {error && <div style={{ fontSize: 12, color: 'var(--danger)', marginBottom: 10, lineHeight: 1.6 }}>{error}</div>}
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
              <label style={{ fontSize: 11, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>模型 *</label>
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
            <button className="btn primary" disabled={!name.trim() || !baseUrl.trim() || !model.trim()} onClick={() => void save()}>{editId ? '保存修改' : '添加'}</button>
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
  const [status, setStatus] = useState<ApiBridgeStatus | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => { void window.aibox.getBridgeStatus().then(setStatus); }, []);

  const toggle = async (enabled: boolean) => {
    try {
      const s = await window.aibox.toggleBridge(enabled);
      setStatus(s);
    } catch (error) {
      toast.err(error instanceof Error ? error.message : 'API Bridge 状态更新失败');
    }
  };

  const regen = async () => {
    try {
      const s = await window.aibox.regenerateBridgeKey();
      setStatus(s);
      toast.ok('Bridge API Key 已重新生成');
    } catch (error) {
      toast.err(error instanceof Error ? error.message : '重新生成 Bridge API Key 失败');
    }
  };

  const copyKey = async () => {
    if (!status) return;
    try {
      await window.aibox.copyBridgeKey();
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      toast.err(error instanceof Error ? error.message : '复制 Bridge API Key 失败');
    }
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
                <code style={{ fontSize: 12, color: 'var(--text-1)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{status.keyConfigured ? '已安全存储' : '未配置'}</code>
                <button className="btn small" onClick={copyKey} disabled={!status.keyConfigured}>{copied ? '✓ 已复制' : '复制'}</button>
                <button className="btn small" onClick={() => void regen()}>重新生成</button>
              </div>
            </div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.8, background: 'var(--input-bg)', padding: '10px 14px', borderRadius: 8 }}>
            <b>使用方法：</b>在 Claude Code / Codex / OpenCode 等工具中配置：<br />
            <code style={{ fontSize: 11.5 }}>OPENAI_BASE_URL=http://127.0.0.1:{status.port}/v1</code><br />
            <code style={{ fontSize: 11.5 }}>OPENAI_API_KEY=&lt;从 OPC-Nexus 复制&gt;</code><br />
            请求将自动转发到系统内配置的模型供应商（按 model 名路由）。
          </div>
        </>
      )}
    </div>
  );
}

/** OCR 文字识别服务卡片（PaddleOCR WASM） */
/** Configure the shared visual model without exposing provider secrets. */
function VisionCard() {
  const [providers, setProviders] = useState<{ id: string; name: string; model: string; hasKey: boolean }[]>([]);
  const [binding, setBinding] = useState<VisionModelBindingView | null>(null);
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');

  const load = async () => {
    const [nextProviders, nextBinding] = await Promise.all([window.aibox.listProviders(), window.aibox.getVisionBinding()]);
    setProviders(nextProviders);
    setBinding(nextBinding);
    if (nextBinding) {
      setProviderId(nextBinding.providerId);
      setModel(nextBinding.model);
    } else if (!providerId && nextProviders[0]) {
      setProviderId(nextProviders[0].id);
      setModel(nextProviders[0].model);
    }
  };
  useEffect(() => { void load().catch(() => undefined); }, []);

  const configure = async () => {
    if (!providerId || !model.trim()) return;
    setBusy(true);
    try {
      setBinding(await window.aibox.configureVisionBinding({ providerId, model: model.trim(), enabled: true }));
      toast.ok('视觉模型已配置');
    } catch (error) {
      toast.err(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };

  const sample = async () => {
    setBusy(true);
    try {
      const ref = await window.aibox.pickVisionAttachment();
      if (!ref) return;
      const answer = await window.aibox.describeVision({ attachmentRef: ref, prompt: '请简要描述图片内容，并列出需要注意的文字或视觉信息。' });
      setResult(answer.text);
    } catch (error) {
      toast.err(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ gridColumn: '1 / -1' }}>
      <div className="card-title">视觉模型<span className="sub">图片理解由主进程代理，凭据不会进入界面</span></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1fr) minmax(180px, 1fr)', gap: 10 }}>
        <div className="field"><label>Provider</label><select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
          <option value="">选择已配置 Provider</option>
          {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}{provider.hasKey ? '' : '（缺少 Key）'}</option>)}
        </select></div>
        <div className="field"><label>视觉模型</label><input value={model} onChange={(event) => setModel(event.target.value)} placeholder="例如 gpt-4o-mini 或 qwen-vl" /></div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
        <button className="btn primary" disabled={busy || !providerId || !model.trim()} onClick={() => void configure()}>保存视觉配置</button>
        <button className="btn" disabled={busy || !binding} onClick={() => void sample()}>选择图片测试</button>
        {binding && <span style={{ fontSize: 12, color: binding.enabled ? 'var(--success)' : 'var(--warning)' }}>{binding.enabled ? '已启用' : '已停用'} · {binding.model}</span>}
      </div>
      {result && <div style={{ marginTop: 10, padding: '9px 12px', background: 'var(--input-bg)', borderRadius: 6, fontSize: 12.5, whiteSpace: 'pre-wrap' }}>{result}</div>}
      <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.6 }}>支持 PNG、JPEG、WebP、GIF。精确文字抄录仍使用本地 OCR；图片外发前请确认 Provider 的数据策略。</div>
    </div>
  );
}

function OcrCard() {
  const [status, setStatus] = useState<{ enabled: boolean; ready: boolean; modelsExist: boolean; modelSize: string; version: string } | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadMsg, setDownloadMsg] = useState('');

  const load = () => { void window.aibox.getOcrStatus().then(setStatus); };
  useEffect(() => { load(); }, []);

  const toggle = async (enabled: boolean) => {
    const s = await window.aibox.toggleOcr(enabled);
    setStatus(s);
    if (enabled) toast.ok('OCR 服务已开启');
  };

  const download = async () => {
    setDownloading(true);
    setDownloadMsg('正在下载模型文件…');
    try {
      const r = await window.aibox.downloadOcrModels();
      setDownloadMsg(r.message);
      if (r.ok) toast.ok('模型下载完成');
      else toast.err(r.message);
      load();
    } finally {
      setDownloading(false);
    }
  };

  if (!status) return null;

  return (
    <div className="card">
      <div className="card-title">OCR 文字识别（{status.version}）</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={status.enabled} onChange={(e) => void toggle(e.target.checked)} />
          启用内置 OCR 服务（离线识别图片中的中英文文字）
        </label>
        <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.8 }}>
          <div>· 引擎：PaddleOCR PP-OCRv4 ONNX（WASM CPU 推理，无需 GPU）</div>
          <div>· 模型状态：{status.modelsExist ? `✅ 已就绪（${status.modelSize}）` : '⚠️ 未下载'}</div>
          <div>· 支持格式：PNG / JPG / BMP / WEBP</div>
          <div>· 用途：数字员工可通过 ocr_recognize 工具识别图片/截图/扫描件中的文字</div>
        </div>
        {!status.modelsExist && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button className="btn primary small" disabled={downloading} onClick={() => void download()}>
              {downloading ? '下载中…' : '⬇️ 下载 OCR 模型（约 15MB）'}
            </button>
            {downloadMsg && <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{downloadMsg}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
