/** 唤起数字员工向导（PRD 7.1 创建流程 / 7.2 配置字段校验） */
import { useEffect, useState } from 'react';
import { useApp } from '../store';
import { Modal } from '../components/common';
import { IconFolder } from '../components/icons';
import { MobileToolPolicy } from '../components/MobileToolPolicy';
import { DSH_MANAGED_ENGINE_ID, type AgentKind, type CreateAgentInput, type MobileDevice, type MobileToolCatalog, type PermissionMode } from '@shared/types';
import { isSelectableLocalEngine, selectDefaultLocalEngineId } from './runtimeMode';

const TEMPLATES = [
  { key: 'blank', name: '空白创建', role: '', prompt: '' },
  {
    key: 'finance', name: '财务助手',
    role: '负责企业财务流程自动化，包括发票审核、费用报销初审、应收应付对账与财务报表汇总，保障数据准确合规。',
    prompt: '你是一名严谨的企业财务助手。处理发票、报销和对账任务时必须核对金额与单据一致性，发现异常及时上报，不得修改原始凭证。'
  },
  {
    key: 'ops', name: '运维助手',
    role: '负责内部系统运行监控、常见运维工单处理、例行巡检执行与健康检查报告输出，保障系统稳定运行。',
    prompt: '你是一名企业 IT 运维助手。执行巡检与工单处理时优先使用只读命令，涉及重启、删除等高风险操作必须请求人工审批。'
  },
  {
    key: 'doc', name: '文档助手',
    role: '负责企业文档的整理、归类与归档，识别重要文件变更，维护知识库索引，确保资料有序且可追溯。',
    prompt: '你是一名文档管理助手。整理归档时保留原始文件，仅在确认后执行移动或重命名，为每份文档维护来源与版本记录。'
  }
];

const STEPS = ['基本信息', '引擎与目录', '渠道绑定', '确认创建'];

export function CreateAgentWizard({ onClose }: { onClose: () => void }) {
  const { snapshot } = useApp();
  const defaultLocalEngineId = selectDefaultLocalEngineId(snapshot?.engines ?? []);
  const [step, setStep] = useState(0);
  const [error, setError] = useState('');
  const [aiDesc, setAiDesc] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [runtimeMode, setRuntimeModeState] = useState<'local' | 'dsh'>('local');
  const [mobileCatalog, setMobileCatalog] = useState<MobileToolCatalog | null>(null);
  const [mobileDevices, setMobileDevices] = useState<MobileDevice[]>([]);
  const [form, setForm] = useState<CreateAgentInput>({
    name: '',
    role: '',
    systemPrompt: '',
    soulMd: '',
    agentsMd: '',
    userMd: '',
    engineId: defaultLocalEngineId,
    workspace: '',
    permissionMode: 'autonomous',
    concurrencyLimit: 1,
    channelIds: []
  });

  useEffect(() => {
    void Promise.all([window.aibox.getMobileToolCatalog(), window.aibox.listMobileDevices()]).then(([catalog, devices]) => {
      setMobileCatalog(catalog);
      setMobileDevices(devices);
      setForm((current) => ({ ...current, mobileAllowedTools: current.mobileAllowedTools ?? catalog.tools.map((tool) => tool.name) }));
    }).catch(() => {});
  }, []);

  // 待配置引擎可先绑定，但不会在就绪前执行任务。
  const selectableEngines = snapshot?.engines.filter(isSelectableLocalEngine) ?? [];
  const managedDshEngine = snapshot?.engines.find((engine) => engine.id === DSH_MANAGED_ENGINE_ID);
  const onlineChannels = snapshot?.channels.filter((c) => c.status === 'ONLINE') ?? [];
  const androidOperator = form.kind === 'android_operator';

  const setKind = (kind: AgentKind) => {
    if (kind === 'android_operator') setRuntimeModeState('local');
    setForm((current) => ({
      ...current,
      kind,
      engineId: kind === 'android_operator'
        ? 'eng-hermes-cli'
        : runtimeMode === 'dsh'
          ? DSH_MANAGED_ENGINE_ID
          : defaultLocalEngineId,
      concurrencyLimit: kind === 'android_operator' ? 1 : current.concurrencyLimit,
      deviceId: kind === 'android_operator' ? current.deviceId : null,
      mobileAuthorizationConfirmed: kind === 'android_operator' ? current.mobileAuthorizationConfirmed : false
    }));
  };

  const setRuntimeMode = (mode: 'local' | 'dsh') => {
    setRuntimeModeState(mode);
    setForm((current) => ({
      ...current,
      engineId: mode === 'dsh'
        ? DSH_MANAGED_ENGINE_ID
        : defaultLocalEngineId
    }));
  };

  const applyTemplate = (key: string) => {
    const t = TEMPLATES.find((x) => x.key === key)!;
    setForm((f) => ({ ...f, role: t.role || f.role, systemPrompt: t.prompt || f.systemPrompt }));
  };

  /** AI 辅助生成人设 */
  const generateWithAI = async () => {
    if (!aiDesc.trim() || aiBusy) return;
    setAiBusy(true);
    setError('');
    try {
      const r = await window.aibox.generatePersona(aiDesc.trim());
      setForm((f) => ({
        ...f,
        name: r.name || f.name,
        role: r.role || f.role,
        systemPrompt: r.systemPrompt || f.systemPrompt,
        soulMd: r.soulMd || f.soulMd,
        agentsMd: r.agentsMd || f.agentsMd,
        permissionMode: (r.permissionMode as PermissionMode) || f.permissionMode
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AI 生成失败');
    } finally {
      setAiBusy(false);
    }
  };

  const next = () => {
    setError('');
    if (step === 0) {
      if (form.name.length < 2 || form.name.length > 30) return setError('名称需为 2—30 字，且本机唯一');
      if (form.role.length < 20 || form.role.length > 500) return setError('职责描述需为 20—500 字');
      if (!form.systemPrompt.trim()) return setError('请填写系统提示词');
    }
    if (step === 1) {
      if (!form.engineId) return setError('请选择已安装且健康的默认引擎');
      if (runtimeMode === 'dsh' && !managedDshEngine) return setError('DSH 工作台 Runtime 尚未安装');
      if (runtimeMode === 'dsh' && managedDshEngine?.status === 'NOT_INSTALLED') return setError('请先准备 DSH 工作台 Runtime');
      if (!androidOperator && !form.workspace) return setError('必须选择工作目录（进入允许列表）');
      if (androidOperator && form.deviceId && !form.mobileAuthorizationConfirmed) return setError('首次绑定设备前必须确认完整手机工具授权');
      if (androidOperator && (form.mobileAllowedTools?.length ?? 0) < 1) return setError('Android 手机操作员至少需要启用一个工具');
    }
    if (step < STEPS.length - 1) return setStep(step + 1);
    void submit();
  };

  const submit = async () => {
    try {
      await window.aibox.createAgent(form);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal title="唤起数字员工" onClose={onClose} width={680}
      footer={
        <>
          {step > 0 && <button className="btn" onClick={() => setStep(step - 1)}>上一步</button>}
          <button className="btn primary" onClick={next}>{step === STEPS.length - 1 ? '创建并启动' : '下一步'}</button>
        </>
      }>
      <div className="steps">
        {STEPS.map((s, i) => <div key={s} className={`step-dot ${i <= step ? 'on' : ''}`} />)}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 14 }}>第 {step + 1} / {STEPS.length} 步 · {STEPS[step]}</div>

      {step === 0 && (
        <>
          <div className="field">
            <label>数字员工身份</label>
            <div className="chip-row">
              <button className={`chip ${!androidOperator ? 'on' : ''}`} onClick={() => setKind('general')}>通用数字员工</button>
              <button className={`chip ${androidOperator ? 'on' : ''}`} onClick={() => setKind('android_operator')}>Android 手机操作员</button>
            </div>
            {androidOperator && <div className="hint">固定使用 Hermes Agent、并发 1；只开放所选 Android 工具，其他系统能力关闭。</div>}
          </div>
          {/* AI 辅助生成人设 */}
          <div className="field" style={{ background: 'var(--accent-soft)', padding: '14px 16px', borderRadius: 10, marginBottom: 16 }}>
            <label style={{ color: 'var(--accent)', fontWeight: 650 }}>✨ AI 辅助生成（描述你想要的助手，AI 自动填写全部配置）</label>
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <input value={aiDesc} onChange={(e) => setAiDesc(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void generateWithAI(); }}
                placeholder="例如：一个擅长写营销文案的助手，语气活泼，熟悉小红书风格…"
                style={{ flex: 1, padding: '9px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-1)', fontSize: 13 }} />
              <button className="btn primary" disabled={aiBusy || !aiDesc.trim()} onClick={() => void generateWithAI()}>
                {aiBusy ? '生成中…' : 'AI 生成'}
              </button>
            </div>
          </div>

          <div className="field">
            <label>从模板开始</label>
            <div className="chip-row">
              {TEMPLATES.map((t) => <button key={t.key} className="chip" onClick={() => applyTemplate(t.key)}>{t.name}</button>)}
            </div>
          </div>
          <div className="field">
            <label>名称（2—30 字，本机唯一）*</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如：CRM助手" />
          </div>
          <div className="field">
            <label>职责描述（20—500 字）*</label>
            <textarea rows={3} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} placeholder="说明这个数字员工负责什么、服务谁、产出什么" />
            <div className="hint">{form.role.length} / 500</div>
          </div>
          <div className="field">
            <label>系统提示词 *</label>
            <textarea rows={4} value={form.systemPrompt} onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })} placeholder="定义角色边界、输出格式与安全约束" />
          </div>
        </>
      )}

      {step === 1 && (
        <>
          {!androidOperator && <div className="field">
            <label>运行模式</label>
            <div className="automation-segmented" role="group" aria-label="数字员工运行模式">
              <button type="button" className={runtimeMode === 'local' ? 'active' : ''} aria-pressed={runtimeMode === 'local'} onClick={() => setRuntimeMode('local')}>本地 CLI</button>
              <button type="button" className={runtimeMode === 'dsh' ? 'active' : ''} aria-pressed={runtimeMode === 'dsh'} onClick={() => setRuntimeMode('dsh')}>DSH</button>
            </div>
          </div>}
          <div className="field">
            <label>{androidOperator ? '执行引擎（手机操作员固定）' : runtimeMode === 'dsh' ? 'DSH Runtime' : '默认执行引擎（需配置并检测为健康后才能执行）*'}</label>
            {androidOperator
              ? <>
                  <div className="chip-row"><button className="chip on" disabled>Hermes Agent CLI</button></div>
                  <div className="hint">手机工具仅通过 Hermes Agent 的受管插件接入；DeepSeek Harness 和其他 Runtime 当前不能操控 Android 设备。</div>
                </>
              : runtimeMode === 'dsh'
                ? <div className="chip-row">
                    <button className="chip on" disabled>DSH / Cordis</button>
                    {managedDshEngine?.status === 'NOT_INSTALLED' && <span style={{ color: 'var(--warning)', fontSize: 12 }}>Runtime 未准备</span>}
                  </div>
                : <div className="chip-row">
                {selectableEngines.map((e) => (
                  <button key={e.id} className={`chip ${form.engineId === e.id ? 'on' : ''}`} onClick={() => setForm({ ...form, engineId: e.id })}>
                    {e.name} {e.status !== 'HEALTHY' ? '（待就绪）' : e.version ? `v${e.version}` : ''}
                  </button>
                ))}
                {selectableEngines.length === 0 && <span style={{ color: 'var(--warning)', fontSize: 12 }}>暂无可用引擎，请先到引擎中心安装</span>}
              </div>}
          </div>
          {!androidOperator && <div className="field">
            <label>工作目录（必须由用户选择并进入允许列表）*</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input readOnly value={form.workspace} placeholder="点击右侧按钮选择目录" />
              <button className="btn" onClick={() => void window.aibox.pickDirectory().then((d) => d && setForm((f) => ({ ...f, workspace: d })))}>
                <IconFolder size={14} />选择
              </button>
            </div>
          </div>}
          <div className="field">
            <label>权限模式</label>
            <div className="chip-row">
              {(['autonomous', 'readonly', 'standard'] as PermissionMode[]).map((m) => (
                <button key={m} className={`chip ${form.permissionMode === m ? 'on' : ''}`} onClick={() => setForm({ ...form, permissionMode: m })}>
                  {m === 'autonomous' ? '项目自主（默认）' : m === 'readonly' ? '只读' : '逐步审批'}
                </button>
              ))}
            </div>
            <div className="hint">项目自主：计划确认后在所选项目目录内持续执行；目录外访问直接拒绝，发布、付款等不可逆外部动作仍需确认。</div>
          </div>
          {!androidOperator && <div className="field">
            <label>并发上限（默认 1，受系统资源策略限制）</label>
            <input type="number" min={1} max={10} value={form.concurrencyLimit}
              onChange={(e) => setForm({ ...form, concurrencyLimit: Math.max(1, Math.min(10, Number(e.target.value))) })} />
          </div>}
          {androidOperator && <>
            <div className="field">
              <label>绑定设备</label>
              <select value={form.deviceId ?? ''} onChange={(event) => setForm((current) => ({ ...current, deviceId: event.target.value || null, mobileAuthorizationConfirmed: false }))}>
                <option value="">暂不绑定，稍后在手机控制台配对</option>
                {mobileDevices.map((device) => <option key={device.id} value={device.id} disabled={!!device.boundAgentId}>{device.name || device.model} · {device.status}{device.boundAgentId ? '（已绑定）' : ''}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Android 工具策略</label>
              <MobileToolPolicy catalog={mobileCatalog} selected={form.mobileAllowedTools ?? []} onChange={(mobileAllowedTools) => setForm((current) => ({ ...current, mobileAllowedTools, mobileAuthorizationConfirmed: false }))} />
            </div>
            {form.deviceId && <label className="mobile-auth-confirm">
              <input type="checkbox" checked={form.mobileAuthorizationConfirmed === true} onChange={(event) => setForm((current) => ({ ...current, mobileAuthorizationConfirmed: event.target.checked }))} />
              <span><b>确认向该数字员工授予以上 {form.mobileAllowedTools?.length ?? 0} 个手机工具</b><small>工具可能读取界面、隐私数据或执行短信、电话、录音等操作；所有调用将进入审计日志。</small></span>
            </label>}
          </>}
        </>
      )}

      {step === 2 && (
        <div className="field">
          <label>绑定消息渠道（可多选；仅显示在线渠道，可稍后在连接中心配置）</label>
          <div className="chip-row">
            {onlineChannels.map((c) => (
              <button key={c.id}
                className={`chip ${form.channelIds.includes(c.id) ? 'on' : ''}`}
                onClick={() => setForm((f) => ({
                  ...f,
                  channelIds: f.channelIds.includes(c.id) ? f.channelIds.filter((x) => x !== c.id) : [...f.channelIds, c.id]
                }))}>
                {c.accountName}
              </button>
            ))}
            {onlineChannels.length === 0 && <span style={{ color: 'var(--text-2)', fontSize: 12 }}>暂无在线渠道，可在创建后前往连接中心绑定</span>}
          </div>
        </div>
      )}

      {step === 3 && (
        <table className="table">
          <tbody>
            <tr><td style={{ color: 'var(--text-2)', width: 110 }}>名称</td><td>{form.name}</td></tr>
            <tr><td style={{ color: 'var(--text-2)' }}>职责</td><td>{form.role}</td></tr>
            <tr><td style={{ color: 'var(--text-2)' }}>身份</td><td>{androidOperator ? 'Android 手机操作员' : '通用数字员工'}</td></tr>
            <tr><td style={{ color: 'var(--text-2)' }}>运行模式</td><td>{androidOperator || runtimeMode === 'local' ? '本地 CLI' : 'DSH'}</td></tr>
            <tr><td style={{ color: 'var(--text-2)' }}>引擎</td><td>{androidOperator ? 'Hermes Agent CLI' : runtimeMode === 'dsh' ? managedDshEngine?.name : selectableEngines.find((e) => e.id === form.engineId)?.name}</td></tr>
            <tr><td style={{ color: 'var(--text-2)' }}>{androidOperator ? '设备' : '工作目录'}</td><td style={{ fontFamily: 'monospace', fontSize: 12 }}>{androidOperator ? (mobileDevices.find((device) => device.id === form.deviceId)?.name ?? '暂未绑定') : form.workspace}</td></tr>
            {androidOperator && <tr><td style={{ color: 'var(--text-2)' }}>手机工具</td><td>{form.mobileAllowedTools?.length ?? 0} / {mobileCatalog?.tools.length ?? 42} 个</td></tr>}
            <tr><td style={{ color: 'var(--text-2)' }}>权限模式</td><td>{form.permissionMode === 'autonomous' ? '项目自主' : form.permissionMode === 'readonly' ? '只读' : form.permissionMode === 'trusted' ? '受信任（兼容）' : '逐步审批'}</td></tr>
            <tr><td style={{ color: 'var(--text-2)' }}>渠道</td><td>{form.channelIds.length ? `${form.channelIds.length} 个` : '未绑定'}</td></tr>
          </tbody>
        </table>
      )}

      {error && <div style={{ color: 'var(--danger)', fontSize: 12.5, marginTop: 10 }}>{error}</div>}
    </Modal>
  );
}
