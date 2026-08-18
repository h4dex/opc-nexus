/** 技能管理：创建/编辑/删除 Skill + 绑定到数字员工 + 组合技能一键生成数字员工 */
import { useEffect, useState } from 'react';
import { useApp } from '../store';
import { Modal } from '../components/common';
import { IconPlus, IconX } from '../components/icons';
import { isUserVisibleEngine } from '../utils/engineVisibility';

interface Skill { id: string; name: string; description: string; content: string; enabled: boolean; createdAt: number }

export function Skills() {
  const { snapshot } = useApp();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [editTarget, setEditTarget] = useState<Skill | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [bindTarget, setBindTarget] = useState<Skill | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);

  const load = () => { void window.aibox.listSkills().then(setSkills); };
  useEffect(() => { load(); }, []);

  if (!snapshot) return null;

  const toggleEnabled = async (s: Skill) => {
    await window.aibox.updateSkill(s.id, { enabled: !s.enabled });
    load();
  };

  const remove = async (id: string) => {
    await window.aibox.removeSkill(id);
    load();
  };

  return (
    <>
      <div className="page-head">
        <h2>技能管理</h2>
        <span className="desc">{skills.length} 个技能 · 技能可绑定给数字员工，或组合成新员工</span>
        <div className="right">
          <button className="btn small" onClick={() => setComposeOpen(true)} disabled={skills.filter((s) => s.enabled).length === 0}>组合成员工</button>
          <button className="btn small primary" onClick={() => setCreateOpen(true)}><IconPlus size={13} />新建技能</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
        {skills.map((s) => (
          <div className="card" key={s.id} style={{ padding: 16, opacity: s.enabled ? 1 : 0.6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontWeight: 650, fontSize: 14, flex: 1 }}>{s.name}</span>
              <span style={{ fontSize: 10.5, padding: '1px 7px', borderRadius: 4, background: s.enabled ? 'var(--success-soft, rgba(34,197,94,.1))' : 'var(--input-bg)', color: s.enabled ? 'var(--success)' : 'var(--text-3)' }}>
                {s.enabled ? '已启用' : '已停用'}
              </span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 10, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
              {s.description || '暂无描述'}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn small" onClick={() => setBindTarget(s)}>绑定员工</button>
              <button className="btn small" onClick={() => setEditTarget(s)}>编辑</button>
              <button className="btn small" onClick={() => void toggleEnabled(s)}>{s.enabled ? '停用' : '启用'}</button>
              <button className="btn small danger" onClick={() => void remove(s.id)}><IconX size={12} /></button>
            </div>
          </div>
        ))}
        {skills.length === 0 && (
          <div style={{ gridColumn: '1 / -1', padding: 40, textAlign: 'center', color: 'var(--text-3)' }}>
            还没有技能。技能是可复用的专项能力描述（如"代码审查"/"日报生成"），绑定后员工执行任务时自动加载。
          </div>
        )}
      </div>

      {(createOpen || editTarget) && (
        <SkillFormModal skill={editTarget ?? undefined} onClose={() => { setCreateOpen(false); setEditTarget(null); }} onSaved={() => { setCreateOpen(false); setEditTarget(null); load(); }} />
      )}
      {bindTarget && <BindSkillModal skill={bindTarget} onClose={() => setBindTarget(null)} />}
      {composeOpen && <ComposeAgentModal skills={skills.filter((s) => s.enabled)} onClose={() => setComposeOpen(false)} />}
    </>
  );
}

/** 组合技能 → 数字员工：多选技能,一键生成可真实执行任务的员工 */
function ComposeAgentModal({ skills, onClose }: { skills: Skill[]; onClose: () => void }) {
  const { snapshot } = useApp();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [engineId, setEngineId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<string | null>(null);

  const engines = (snapshot?.engines ?? []).filter((e) =>
    isUserVisibleEngine(e) && ['HEALTHY', 'SETUP_REQUIRED', 'AUTH_REQUIRED'].includes(e.status)
  );

  const toggle = (id: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const agent = await window.aibox.createAgentFromSkills({
        skillIds: [...selected],
        name: name.trim() || undefined,
        engineId: engineId || undefined
      });
      setDone(agent.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="组合技能 → 数字员工" onClose={onClose} width={520}
      footer={done
        ? <button className="btn primary" onClick={onClose}>完成</button>
        : <><button className="btn" onClick={onClose}>取消</button>
            <button className="btn primary" disabled={busy || selected.size === 0} onClick={() => void create()}>{busy ? '创建中…' : `创建员工（已选 ${selected.size} 项技能）`}</button></>}>
      {done ? (
        <div style={{ padding: 20, textAlign: 'center', fontSize: 13 }}>
          ✅ 数字员工「{done}」已创建并绑定所选技能。<br />
          <span style={{ color: 'var(--text-3)', fontSize: 12 }}>到「数字员工」页即可下发任务：员工将按技能库拆解规划并真实执行。</span>
        </div>
      ) : (
        <>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 10 }}>
            选择一个或多个技能组合成新员工。技能内容将注入员工人设，任务执行时自动运用（拆分规划 → 执行 → 产出结果）。
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, maxHeight: 220, overflowY: 'auto', marginBottom: 12 }}>
            {skills.map((s) => (
              <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 6, cursor: 'pointer', border: `1px solid ${selected.has(s.id) ? 'var(--accent)' : 'var(--border)'}`, background: selected.has(s.id) ? 'var(--accent-soft)' : 'transparent', fontSize: 12.5 }}>
                <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} style={{ accentColor: 'var(--accent)', width: 15, height: 15 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.description || s.name}>{s.name}</span>
              </label>
            ))}
          </div>
          <div className="field">
            <label>员工名称（留空自动生成）</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：数据分析专员" maxLength={30} />
          </div>
          <div className="field">
            <label>执行引擎（留空用默认引擎）</label>
            <select value={engineId} onChange={(e) => setEngineId(e.target.value)}
              style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-1)', fontSize: 13 }}>
              <option value="">默认引擎</option>
              {engines.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </div>
          {error && <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>{error}</div>}
        </>
      )}
    </Modal>
  );
}

function SkillFormModal({ skill, onClose, onSaved }: { skill?: Skill; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(skill?.name ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [content, setContent] = useState(skill?.content ?? '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      if (skill) await window.aibox.updateSkill(skill.id, { name: name.trim(), description, content });
      else await window.aibox.createSkill({ name: name.trim(), description, content });
      onSaved();
    } finally { setBusy(false); }
  };

  return (
    <Modal title={skill ? '编辑技能' : '新建技能'} onClose={onClose} width={520}
      footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button></>}>
      <div className="field">
        <label>技能名称 *</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：代码审查、日报生成、数据分析" />
      </div>
      <div className="field">
        <label>描述</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="一句话说明该技能的用途" />
      </div>
      <div className="field">
        <label>技能内容（Markdown 格式的指令模板）</label>
        <textarea value={content} onChange={(e) => setContent(e.target.value)}
          placeholder={'例如：\n## 代码审查技能\n- 检查安全漏洞和性能问题\n- 输出结构化审查报告\n- 按严重程度排序'}
          style={{ width: '100%', minHeight: 140, resize: 'vertical', fontFamily: 'monospace', fontSize: 12.5, lineHeight: 1.7, padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-1)' }} />
      </div>
    </Modal>
  );
}

function BindSkillModal({ skill, onClose }: { skill: Skill; onClose: () => void }) {
  const { snapshot } = useApp();
  const [bound, setBound] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  if (!snapshot) return null;
  const agents = snapshot.agentCards.map((c) => c.agent);

  // 加载已绑定状态
  if (!loaded) {
    setLoaded(true);
    void Promise.all(agents.map((a) => window.aibox.getAgentSkills(a.id).then((skills) => ({ id: a.id, has: skills.some((s) => s.id === skill.id) }))))
      .then((results) => setBound(new Set(results.filter((r) => r.has).map((r) => r.id))));
  }

  const toggleBind = async (agentId: string) => {
    if (bound.has(agentId)) {
      await window.aibox.unbindSkill(agentId, skill.id);
      setBound((prev) => { const n = new Set(prev); n.delete(agentId); return n; });
    } else {
      await window.aibox.bindSkill(agentId, skill.id);
      setBound((prev) => new Set(prev).add(agentId));
    }
  };

  return (
    <Modal title={`绑定技能 · ${skill.name}`} onClose={onClose} width={460}
      footer={<button className="btn primary" onClick={onClose}>完成</button>}>
      <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 12 }}>勾选需要使用该技能的数字员工：</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, maxHeight: 300, overflowY: 'auto' }}>
        {agents.map((a) => (
          <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 6, cursor: 'pointer', border: `1px solid ${bound.has(a.id) ? 'var(--accent)' : 'var(--border)'}`, background: bound.has(a.id) ? 'var(--accent-soft)' : 'transparent', fontSize: 12.5 }}>
            <input type="checkbox" checked={bound.has(a.id)} onChange={() => void toggleBind(a.id)} style={{ accentColor: 'var(--accent)', width: 15, height: 15 }} />
            {a.name}
          </label>
        ))}
      </div>
    </Modal>
  );
}
