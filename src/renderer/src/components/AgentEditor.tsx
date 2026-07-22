/** 助手编辑弹窗：权限快捷切换 + 人设配置（soul.md / agents.md / user.md）+ 预设模板 + 组合预览 */
import { useState } from 'react';
import { Modal } from '../components/common';
import type { Agent, PermissionMode } from '@shared/types';

const PERM_OPTIONS: { value: PermissionMode; label: string; desc: string; color: string }[] = [
  { value: 'readonly', label: '只读', desc: '仅允许读取操作，写入/删除一律禁止', color: 'var(--text-3)' },
  { value: 'standard', label: '标准审批', desc: '写入/删除操作需人工审批后执行', color: 'var(--warning)' },
  { value: 'trusted', label: '受信任', desc: '自动执行所有操作（渠道来源仍需审批）', color: 'var(--accent)' },
  { value: 'autonomous', label: '完全自主', desc: '无需任何审批，所有操作自动执行', color: 'var(--success)' }
];

/** 人设预设模板 */
const SOUL_PRESETS: { name: string; content: string }[] = [
  { name: '全栈工程师', content: '你是一位资深全栈工程师，名叫小明。\n性格严谨但友善，回答简洁有力。\n偏好 TypeScript 和函数式编程风格。\n代码注释用英文，与用户交流用中文。' },
  { name: '数据分析师', content: '你是一位数据分析师，擅长 SQL、Python 和可视化。\n回答时先给结论，再给依据。\n对数据质量严格，发现异常会主动提醒。' },
  { name: '产品经理', content: '你是一位产品经理，擅长需求分析和 PRD 撰写。\n思考问题从用户价值出发，善于拆解复杂需求。\n输出结构化文档，包含背景/目标/方案/风险。' },
  { name: '自定义', content: '' }
];

type TabKey = 'soul' | 'agents' | 'user' | 'basic';

export function AgentEditor({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [tab, setTab] = useState<TabKey>('soul');
  const [soulMd, setSoulMd] = useState(agent.soulMd);
  const [agentsMd, setAgentsMd] = useState(agent.agentsMd);
  const [userMd, setUserMd] = useState(agent.userMd);
  const [systemPrompt, setSystemPrompt] = useState(agent.systemPrompt);
  const [role, setRole] = useState(agent.role);
  const [permMode, setPermMode] = useState<PermissionMode>(agent.permissionMode);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const save = async () => {
    setBusy(true);
    setSaved(false);
    await window.aibox.updateAgentPersona(agent.id, {
      role, systemPrompt, soulMd, agentsMd, userMd, permissionMode: permMode
    });
    setBusy(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  // 组合预览：模拟执行器拼装 system prompt 的逻辑
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
    { key: 'basic', label: '基础 / 权限' }
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
            <label>职责描述</label>
            <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="例如：全栈开发助手" />
          </div>
          <div className="field">
            <label>基础 System Prompt（补充指令，与人设文件组合生效）</label>
            <textarea style={{ ...textareaStyle, minHeight: 100 }} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="额外的系统级指令…" />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.8, background: 'var(--input-bg)', padding: '10px 14px', borderRadius: 8 }}>
            权限模式已在顶部设置。当前：<b style={{ color: PERM_OPTIONS.find((p) => p.value === permMode)?.color }}>{PERM_OPTIONS.find((p) => p.value === permMode)?.label}</b>
          </div>
        </>
      )}
    </Modal>
  );
}
