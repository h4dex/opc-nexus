/** 助手编辑弹窗：权限快捷切换 + 能力开关 + 人设配置 + 引擎/模型选择 + 预设模板 + 组合预览 */
import { useEffect, useState } from 'react';
import { useApp } from '../store';
import { Modal } from '../components/common';
import { MobileToolPolicy } from './MobileToolPolicy';
import type {
  Agent, AgentCapabilities, AgentKind, AgentMemoryMode, MobileAgentConfig, MobileDevice, MobileToolCatalog, MobileToolName, PermissionMode
} from '@shared/types';
import { isUserVisibleEngine } from '../utils/engineVisibility';

const PERM_OPTIONS: { value: PermissionMode; label: string; desc: string; color: string }[] = [
  { value: 'readonly', label: '只读', desc: '仅允许读取操作，写入/删除一律禁止', color: 'var(--text-3)' },
  { value: 'standard', label: '标准审批', desc: '写入/删除操作需人工审批后执行', color: 'var(--warning)' },
  { value: 'trusted', label: '受信任（兼容）', desc: '兼容旧配置，仍受项目工作目录边界约束', color: 'var(--accent)' },
  { value: 'autonomous', label: '项目自主', desc: '项目目录内自动执行；目录外拒绝，不可逆外部动作单独确认', color: 'var(--success)' }
];

/** 人设预设模板 */
const SOUL_PRESETS: { name: string; content: string }[] = [
  { name: '全栈工程师', content: '你是一位资深全栈工程师，名叫小明。\n性格严谨但友善，回答简洁有力。\n偏好 TypeScript 和函数式编程风格。\n代码注释用英文，与用户交流用中文。' },
  { name: '数据分析师', content: '你是一位数据分析师，擅长 SQL、Python 和可视化。\n回答时先给结论，再给依据。\n对数据质量严格，发现异常会主动提醒。' },
  { name: '产品经理', content: '你是一位产品经理，擅长需求分析和 PRD 撰写。\n思考问题从用户价值出发，善于拆解复杂需求。\n输出结构化文档，包含背景/目标/方案/风险。' },
  { name: '自定义', content: '' }
];

type TabKey = 'soul' | 'agents' | 'user' | 'basic' | 'mobile' | 'model' | 'tags';

export function AgentEditor({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [tab, setTab] = useState<TabKey>('soul');
  const [soulMd, setSoulMd] = useState(agent.soulMd);
  const [agentsMd, setAgentsMd] = useState(agent.agentsMd);
  const [userMd, setUserMd] = useState(agent.userMd);
  const [systemPrompt, setSystemPrompt] = useState(agent.systemPrompt);
  const [role, setRole] = useState(agent.role);
  const [permMode, setPermMode] = useState<PermissionMode>(agent.permissionMode);
  const [memoryMode, setMemoryMode] = useState<AgentMemoryMode>(agent.memoryMode ?? 'short_term');
  const [caps, setCaps] = useState<AgentCapabilities>(agent.capabilities ?? { network: false, shell: false, install: false, browser: false, computer: false, mobile: false });
  const [tags, setTags] = useState<string[]>(agent.tags ?? []);
  const [tagInput, setTagInput] = useState('');
  const [modelOverrides, setModelOverrides] = useState<{ temperature?: number; topP?: number; maxTokens?: number }>(agent.modelOverrides ?? {});
  const [engineId, setEngineId] = useState(agent.engineId);
  const [modelOverride, setModelOverride] = useState(agent.modelOverride ?? '');
  const [kind, setKind] = useState<AgentKind>(agent.kind ?? 'general');
  const [mobileCatalog, setMobileCatalog] = useState<MobileToolCatalog | null>(null);
  const [mobileDevices, setMobileDevices] = useState<MobileDevice[]>([]);
  const [mobileConfig, setMobileConfig] = useState<MobileAgentConfig | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [mobileTools, setMobileTools] = useState<MobileToolName[]>([]);
  const [mobileAuthorizationConfirmed, setMobileAuthorizationConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([
      window.aibox.getMobileToolCatalog(),
      window.aibox.listMobileDevices(),
      window.aibox.getMobileAgentConfig(agent.id)
    ]).then(([catalog, devices, config]) => {
      if (!active) return;
      setMobileCatalog(catalog);
      setMobileDevices(devices);
      setMobileConfig(config);
      setDeviceId(config?.deviceId ?? null);
      setMobileTools(config?.allowedTools ?? catalog.tools.map((tool) => tool.name));
      setMobileAuthorizationConfirmed(!!config?.authorizationConfirmedAt);
    }).catch(() => {});
    return () => { active = false; };
  }, [agent.id]);

  const chooseKind = (next: AgentKind) => {
    setKind(next);
    if (next === 'android_operator') {
      setEngineId('eng-hermes-cli');
      setCaps({ network: false, shell: false, install: false, browser: false, computer: false, mobile: true });
    } else {
      setCaps((current) => ({ ...current, mobile: false }));
      if (tab === 'mobile') setTab('basic');
    }
  };

  const save = async () => {
    setBusy(true);
    setSaved(false);
    try {
      const deviceChanged = deviceId !== (mobileConfig?.deviceId ?? null);
      const toolsChanged = JSON.stringify(mobileTools) !== JSON.stringify(mobileConfig?.allowedTools ?? []);
      if (kind === 'android_operator' && deviceId && deviceChanged && !mobileAuthorizationConfirmed) {
        throw new Error('绑定新设备前必须确认完整手机工具授权');
      }
      const updated = await window.aibox.updateAgentPersona(agent.id, {
        role, systemPrompt, soulMd, agentsMd, userMd, permissionMode: permMode, memoryMode, capabilities: caps,
        tags, modelOverrides: Object.keys(modelOverrides).length > 0 ? modelOverrides : undefined,
        engineId: kind === 'android_operator' ? 'eng-hermes-cli' : engineId,
        modelOverride: modelOverride || undefined,
        kind,
        ...(kind === 'android_operator' && deviceChanged ? { deviceId } : {}),
        ...(kind === 'android_operator' && toolsChanged ? { mobileAllowedTools: mobileTools } : {}),
        ...(kind === 'android_operator' && (deviceChanged || toolsChanged) ? { mobileAuthorizationConfirmed } : {})
      });
      setKind(updated.kind);
      if (updated.kind === 'android_operator') {
        const nextConfig = await window.aibox.getMobileAgentConfig(agent.id);
        setMobileConfig(nextConfig);
        setDeviceId(nextConfig?.deviceId ?? null);
        setMobileTools(nextConfig?.allowedTools ?? mobileTools);
        setMobileAuthorizationConfirmed(!!nextConfig?.authorizationConfirmedAt);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setBusy(false);
    }
  };

  // 组合预览：与真实执行器相同的人设指令拼装逻辑
  const composedPreview = [
    soulMd && `# 身份与性格\n${soulMd}`,
    systemPrompt,
    agentsMd && `# 行为指令\n${agentsMd}`,
    userMd && `# 用户信息\n${userMd}`
  ].filter(Boolean).join('\n\n') || '你是一个智能助手。';

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'soul', label: 'soul.md' },
    { key: 'agents', label: 'agents.md' },
    { key: 'user', label: 'user.md' },
    { key: 'basic', label: '基础 / 权限' },
    ...(kind === 'android_operator' ? [{ key: 'mobile' as const, label: '手机 / 工具' }] : []),
    { key: 'model', label: '模型参数' },
    { key: 'tags', label: '标签' }
  ];

  const textareaStyle: React.CSSProperties = {
    width: '100%', minHeight: 200, resize: 'vertical', fontFamily: 'monospace', fontSize: 12.5,
    lineHeight: 1.7, padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border)',
    background: 'var(--input-bg)', color: 'var(--text-1)'
  };

  return (
    <Modal title={`编辑助手 · ${agent.name}`} onClose={onClose} width={680}
      footer={<>
        {saved && <span style={{ fontSize: 12, color: 'var(--success)', marginRight: 8 }}>✓ 已保存</span>}
        <button className="btn" onClick={() => setShowPreview(!showPreview)}>{showPreview ? '隐藏预览' : '组合预览'}</button>
        <button className="btn" onClick={onClose}>关闭</button>
        <button className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存配置'}</button>
      </>}>

      {/* 权限快捷切换（顶部显著位置） */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {PERM_OPTIONS.map((p) => (
          <button key={p.value} onClick={() => setPermMode(p.value)} title={p.desc}
            style={{
              padding: '6px 14px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
              border: `1.5px solid ${permMode === p.value ? p.color : 'var(--border)'}`,
              background: permMode === p.value ? 'var(--accent-soft)' : 'transparent',
              color: permMode === p.value ? p.color : 'var(--text-2)'
            }}>
            {p.label}
          </button>
        ))}
        <span style={{ fontSize: 11.5, color: 'var(--text-3)', alignSelf: 'center', marginLeft: 4 }}>
          {PERM_OPTIONS.find((p) => p.value === permMode)?.desc}
        </span>
      </div>

      {/* 组合预览 */}
      {showPreview && (
        <pre style={{ marginBottom: 14, padding: '12px 16px', background: 'var(--bg-1)', borderRadius: 8, fontSize: 11.5, lineHeight: 1.7, maxHeight: 160, overflowY: 'auto', whiteSpace: 'pre-wrap', color: 'var(--text-2)' }}>
          {composedPreview}
        </pre>
      )}
      {/* Tab 切换 */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 14 }}>
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{
              padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 600,
              background: tab === t.key ? 'var(--accent)' : 'var(--input-bg)',
              color: tab === t.key ? '#fff' : 'var(--text-2)'
            }}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'soul' && (
        <div className="field">
          <label>身份与性格（soul.md）— 定义助手的人设、语气、价值观</label>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            {SOUL_PRESETS.map((p) => (
              <button key={p.name} onClick={() => { if (p.content) setSoulMd(p.content); }}
                style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-2)', fontSize: 11.5, cursor: 'pointer' }}>
                {p.name}
              </button>
            ))}
          </div>
          <textarea style={textareaStyle} value={soulMd} onChange={(e) => setSoulMd(e.target.value)}
            placeholder={'例如：\n你是一位资深全栈工程师，名叫小明。\n性格严谨但友善，回答简洁有力。\n偏好 TypeScript 和函数式编程风格。'} />
        </div>
      )}

      {tab === 'agents' && (
        <div className="field">
          <label>行为指令（agents.md）— 工具使用规则、约束、工作流程</label>
          <textarea style={textareaStyle} value={agentsMd} onChange={(e) => setAgentsMd(e.target.value)}
            placeholder={'例如：\n- 修改代码前必须先读取相关文件\n- 每次修改后运行 typecheck 验证\n- 禁止删除用户未指定的文件\n- 输出结果使用 Markdown 格式'} />
        </div>
      )}

      {tab === 'user' && (
        <div className="field">
          <label>用户信息（user.md）— 用户画像、偏好、项目背景</label>
          <textarea style={textareaStyle} value={userMd} onChange={(e) => setUserMd(e.target.value)}
            placeholder={'例如：\n用户是技术团队负责人，熟悉 Electron/React。\n项目使用 TypeScript strict 模式。\n偏好中文交流，代码注释用英文。'} />
        </div>
      )}

      {tab === 'basic' && (
        <>
          <div className="field">
            <label>数字员工身份</label>
            <div className="chip-row">
              <button className={`chip ${kind === 'general' ? 'on' : ''}`} onClick={() => chooseKind('general')}>通用数字员工</button>
              <button className={`chip ${kind === 'android_operator' ? 'on' : ''}`} onClick={() => chooseKind('android_operator')}>Android 手机操作员</button>
            </div>
            {kind === 'android_operator' && <div className="hint">固定 Hermes Agent CLI、并发 1，关闭网络、Shell、安装、浏览器和桌面操控能力。其他执行 Runtime 当前没有 Android 工具桥接。</div>}
          </div>
          <div className="field">
            <label>职责描述</label>
            <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="例如：全栈开发助手" />
          </div>

          {/* 引擎选择 */}
          <div className="field">
            <label>执行引擎（该员工执行任务时使用的引擎）</label>
            {kind === 'android_operator'
              ? <input value="Hermes Agent CLI（手机操作员固定）" readOnly />
              : <EngineSelect value={engineId} onChange={setEngineId} />}
          </div>

          {/* 模型选择 */}
          <div className="field">
            <label>模型（留空则用供应商默认模型）</label>
            <ModelSelect value={modelOverride} onChange={setModelOverride} />
          </div>

          <div className="field">
            <label>基础 System Prompt（补充指令，与人设文件组合生效）</label>
            <textarea style={{ ...textareaStyle, minHeight: 100 }} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="额外的系统级指令…" />
          </div>

          <div className="field">
            <label>记忆策略</label>
            <div className="automation-segmented" role="group" aria-label="数字员工记忆策略">
              {([
                ['long_term', '长期记忆'],
                ['short_term', '当前会话'],
                ['none', '无记忆']
              ] as Array<[AgentMemoryMode, string]>).map(([mode, label]) => (
                <button key={mode} type="button" className={memoryMode === mode ? 'active' : ''}
                  aria-pressed={memoryMode === mode} onClick={() => setMemoryMode(mode)}>{label}</button>
              ))}
            </div>
            <div className="hint">
              {memoryMode === 'long_term'
                ? '跨会话召回该员工已接受的长期记忆，同时保留当前会话上下文。'
                : memoryMode === 'none'
                  ? '每次调用独立执行，不读取历史，也不保存可续接会话。'
                  : '只延续当前会话，不跨会话读取历史。'}
            </div>
          </div>

          {/* 能力开关 */}
          <div className="field">
            <label>能力开关（控制该员工可使用的工具类型，开启后即时生效）</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
              {([
                { key: 'network' as const, icon: '🌐', label: 'HTTP/HTTPS 网络请求', desc: '允许 web_search、http_request、MCP 远程调用等网络操作' },
                { key: 'shell' as const, icon: '⌨️', label: '系统命令执行', desc: '允许 run_command 工具，在工作目录内执行 shell 命令' },
                { key: 'install' as const, icon: '📦', label: '软件包安装', desc: '允许 install_package 工具，安装 npm/pip/apt 包（MCP 工具、Skills 依赖等）' },
                { key: 'browser' as const, icon: '🖥️', label: '浏览器自动化（Playwright/CDP）', desc: '允许网页导航、点击、输入、截图、JS执行、CDP直连 Chrome' },
                { key: 'computer' as const, icon: '🖱️', label: '桌面操控（Computer Use）', desc: '允许屏幕截图、鼠标点击、键盘输入、按键组合、滚轮操作' }
              ]).map((item) => (
                <label key={item.key} style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: kind === 'android_operator' ? 'not-allowed' : 'pointer', opacity: kind === 'android_operator' ? 0.55 : 1, padding: '8px 12px', borderRadius: 8, background: caps[item.key] ? 'var(--accent-soft)' : 'var(--input-bg)', border: `1px solid ${caps[item.key] ? 'var(--accent)' : 'var(--border)'}` }}>
                  <input type="checkbox" disabled={kind === 'android_operator'} checked={caps[item.key]} onChange={(e) => setCaps((c) => ({ ...c, [item.key]: e.target.checked }))}
                    style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
                  <span style={{ fontSize: 16 }}>{item.icon}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-1)' }}>{item.label}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>{item.desc}</div>
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 700, color: caps[item.key] ? 'var(--success)' : 'var(--text-3)' }}>
                    {caps[item.key] ? '已开启' : '关闭'}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.8, background: 'var(--input-bg)', padding: '10px 14px', borderRadius: 8 }}>
            权限模式已在顶部设置。当前：<b style={{ color: PERM_OPTIONS.find((p) => p.value === permMode)?.color }}>{PERM_OPTIONS.find((p) => p.value === permMode)?.label}</b>
            <br />能力开关独立于权限模式：即使权限为“完全自主”，未开启的能力对应工具也不会注册给模型。
          </div>
        </>
      )}

      {tab === 'mobile' && kind === 'android_operator' && (
        <>
          <div className="field">
            <label>绑定 Android 设备（一台设备只能绑定一个手机员工）</label>
            <select value={deviceId ?? ''} onChange={(event) => {
              setDeviceId(event.target.value || null);
              setMobileAuthorizationConfirmed(false);
            }}>
              <option value="">暂不绑定</option>
              {mobileDevices.map((device) => (
                <option key={device.id} value={device.id} disabled={!!device.boundAgentId && device.boundAgentId !== agent.id}>
                  {device.name || device.model} · {device.status}{device.boundAgentId && device.boundAgentId !== agent.id ? '（已绑定）' : ''}
                </option>
              ))}
            </select>
            <div className="hint">实体 Android Worker 的设备接入由“Android 执行设备”管理；它不属于手机对话。手机对话扫码入口只有 Quest 右上角的 Hermes 连接。</div>
          </div>
          <div className="field">
            <label>Hermes Profile</label>
            <input readOnly value={mobileConfig?.hermesProfile ?? `opcnexus-mobile-${agent.id.slice(0, 12)}`} />
          </div>
          <div className="field">
            <label>Android 工具策略</label>
            <MobileToolPolicy catalog={mobileCatalog} selected={mobileTools} onChange={(tools) => {
              setMobileTools(tools);
              setMobileAuthorizationConfirmed(false);
            }} />
          </div>
          {deviceId && <label className="mobile-auth-confirm">
            <input type="checkbox" checked={mobileAuthorizationConfirmed} onChange={(event) => setMobileAuthorizationConfirmed(event.target.checked)} />
            <span>
              <b>确认向该数字员工授予以上 {mobileTools.length} 个手机工具</b>
              <small>更换设备或工具策略后需要重新确认；短信、电话、输入、隐私读取和媒体操作均会写入审计。</small>
            </span>
          </label>}
        </>
      )}

      {tab === 'model' && (
        <>
          <div className="field">
            <label>模型参数覆盖（留空则用全局默认值）</label>
            <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginBottom: 12 }}>每个员工可独立设置模型参数，覆盖全局供应商配置。</div>
          </div>
          <div className="field">
            <label>Temperature: {modelOverrides.temperature ?? '默认'}</label>
            <input type="range" min="0" max="2" step="0.1" value={modelOverrides.temperature ?? 0.7}
              onChange={(e) => setModelOverrides((m) => ({ ...m, temperature: Number(e.target.value) }))} style={{ width: '100%' }} />
          </div>
          <div className="field">
            <label>Top P: {modelOverrides.topP ?? '默认'}</label>
            <input type="range" min="0" max="1" step="0.05" value={modelOverrides.topP ?? 1}
              onChange={(e) => setModelOverrides((m) => ({ ...m, topP: Number(e.target.value) }))} style={{ width: '100%' }} />
          </div>
          <div className="field">
            <label>Max Tokens</label>
            <input type="number" min={256} max={128000} step={256} value={modelOverrides.maxTokens ?? ''}
              onChange={(e) => setModelOverrides((m) => ({ ...m, maxTokens: e.target.value ? Number(e.target.value) : undefined }))}
              placeholder="默认 4096" />
          </div>
          <button className="btn small" onClick={() => setModelOverrides({})} style={{ marginTop: 8 }}>清除覆盖（用全局默认）</button>
        </>
      )}

      {tab === 'tags' && (
        <>
          <div className="field">
            <label>标签分组（用于筛选和分组管理）</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
              {tags.map((t) => (
                <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6, background: 'var(--accent-soft)', color: 'var(--accent)', fontSize: 12.5, fontWeight: 600 }}>
                  {t}
                  <button onClick={() => setTags((prev) => prev.filter((x) => x !== t))} style={{ border: 'none', background: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1 }}>×</button>
                </span>
              ))}
              {tags.length === 0 && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>未添加标签</span>}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={tagInput} onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && tagInput.trim()) { setTags((prev) => prev.includes(tagInput.trim()) ? prev : [...prev, tagInput.trim()]); setTagInput(''); } }}
                placeholder="输入标签名，Enter 添加" style={{ flex: 1 }} />
              <button className="btn small" onClick={() => { if (tagInput.trim()) { setTags((prev) => prev.includes(tagInput.trim()) ? prev : [...prev, tagInput.trim()]); setTagInput(''); } }}>添加</button>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 8 }}>例如：“前端组”、“运营组”、“数据分析”</div>
          </div>
        </>
      )}
    </Modal>
  );
}

/** 引擎选择下拉：从 snapshot.engines 中筛选可用引擎 */
function EngineSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { snapshot } = useApp();
  const engines = (snapshot?.engines ?? []).filter((e) =>
    isUserVisibleEngine(e) && ['HEALTHY', 'SETUP_REQUIRED', 'AUTH_REQUIRED'].includes(e.status)
  );
  const selectedIsMissing = Boolean(value) && !engines.some((engine) => engine.id === value);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-1)', fontSize: 13 }}>
      {selectedIsMissing && <option value={value} disabled>已移除的旧引擎，请重新选择</option>}
      {engines.map((e) => <option key={e.id} value={e.id}>{e.name}{e.isDefault ? ' (默认)' : ''}{e.status === 'SETUP_REQUIRED' ? ' [待配置]' : ''}</option>)}
      {engines.length === 0 && <option value="">无可用引擎</option>}
    </select>
  );
}

/** 模型选择下拉：从默认供应商获取模型列表 + 允许手动输入 */
function ModelSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { snapshot } = useApp();
  const [models, setModels] = useState<string[]>([]);
  const [fetched, setFetched] = useState(false);

  // 尝试从默认供应商获取模型列表
  if (!fetched) {
    setFetched(true);
    void window.aibox.listProviders().then((providers) => {
      const def = providers.find((p) => p.isDefault) ?? providers[0];
      if (def) void window.aibox.fetchProviderModels(def.id).then((r) => { if (r.ok) setModels(r.models); });
    });
  }

  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="默认模型（留空跟随供应商）" list="agent-model-presets"
        style={{ flex: 1, padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-1)', fontSize: 13 }} />
      <datalist id="agent-model-presets">
        {models.map((m) => <option key={m} value={m} />)}
        {models.length === 0 && <option value="deepseek-chat" />}
      </datalist>
    </div>
  );
}
