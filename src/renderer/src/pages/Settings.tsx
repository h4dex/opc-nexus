/** 设置（PRD 5：外观 / 供应商 / 下载源 / 通知 / 安全 / 数据 / 关于） */
import { useEffect, useState } from 'react';
import { useApp } from '../store';
import { IconMoon, IconSun } from '../components/icons';
import type { ProviderTestResult, SystemInfo } from '@shared/types';

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

/** Hermes 模型供应商配置：密钥只上行到主进程 safeStorage，回显仅 hasKey 脱敏视图（15.1） */
function ProviderCard() {
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<ProviderTestResult | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void window.aibox.getProviderConfig().then((c) => {
      setBaseUrl(c.baseUrl);
      setModel(c.model);
      setHasKey(c.hasKey);
    });
  }, []);

  const save = async () => {
    const c = await window.aibox.saveProviderConfig({ baseUrl, model, apiKey: apiKey || undefined });
    setHasKey(c.hasKey);
    setApiKey('');
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const doTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await window.aibox.testProvider({ baseUrl, apiKey: apiKey || undefined }));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="card">
      <div className="card-title">模型供应商（Hermes 引擎）<span className="sub">配置完成后 Hermes 转为真实执行</span></div>
      <div className="field">
        <label>Base URL（OpenAI 兼容接口）</label>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
      </div>
      <div className="field">
        <label>模型</label>
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4o-mini" />
      </div>
      <div className="field">
        <label>API Key{hasKey ? '（已保存于系统密钥库，留空表示沿用）' : ' *'}</label>
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
          placeholder={hasKey ? '••••••••（已保存）' : 'sk-...'} autoComplete="off" />
        <div className="hint">密钥仅存入系统密钥库（safeStorage），不进入渲染进程 / localStorage。</div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn" disabled={testing} onClick={() => void doTest()}>{testing ? '测试中…' : '测试连接'}</button>
        <button className="btn primary" onClick={() => void save()}>保存配置</button>
        {saved && <span style={{ fontSize: 12, color: 'var(--success)' }}>✓ 已保存</span>}
        {test && (
          <span style={{ fontSize: 12, color: test.ok ? 'var(--success)' : 'var(--danger)' }}>
            {test.ok ? `✓ 连接成功（${test.latencyMs}ms）` : `✗ ${test.error}`}
          </span>
        )}
      </div>
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
