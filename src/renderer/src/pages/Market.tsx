/** 数字员工市场：岗位模板浏览 + 一键录用（从模板创建助手） */
import { useState } from 'react';
import { useApp } from '../store';
import { MARKET_ROLES, DEPARTMENTS, type MarketRole } from '../data/marketRoles';
import { IconPlus, IconUser } from '../components/icons';
import { NEXUS_ENGINE_ID } from '../../../shared/types';

export function Market() {
  const { snapshot } = useApp();
  const [dept, setDept] = useState<string>('全部');
  const [search, setSearch] = useState('');
  const [hiring, setHiring] = useState<string | null>(null);
  const [hired, setHired] = useState<string | null>(null);

  const filtered = MARKET_ROLES.filter((r) => {
    if (dept !== '全部' && r.department !== dept) return false;
    if (search && !r.name.includes(search) && !r.role.includes(search) && !r.department.includes(search)) return false;
    return true;
  });

  const hire = async (role: MarketRole) => {
    setHiring(role.id);
    try {
      const engines = snapshot?.engines.filter((e) => ['HEALTHY', 'SETUP_REQUIRED', 'AUTH_REQUIRED'].includes(e.status)) ?? [];
      const engineId = engines[0]?.id ?? NEXUS_ENGINE_ID;
      await window.aibox.createAgent({
        name: role.name,
        role: role.role,
        systemPrompt: '',
        soulMd: role.soulMd,
        agentsMd: role.agentsMd,
        userMd: '',
        engineId,
        workspace: '',
        permissionMode: role.permissionMode,
        concurrencyLimit: 1,
        channelIds: []
      });
      setHired(role.id);
      setTimeout(() => setHired(null), 2000);
    } finally {
      setHiring(null);
    }
  };

  const permLabel = (m: string) => m === 'readonly' ? '只读' : m === 'standard' ? '标准' : m === 'trusted' ? '受信任' : '自主';
  const permColor = (m: string) => m === 'readonly' ? 'var(--text-3)' : m === 'standard' ? 'var(--warning)' : m === 'trusted' ? 'var(--accent)' : 'var(--success)';

  return (
    <>
      <div className="page-head">
        <h2>数字员工市场</h2>
        <span className="desc">{MARKET_ROLES.length} 个岗位模板 · 覆盖 {DEPARTMENTS.length - 1} 个部门 · 一键录用即刻上岗</span>
      </div>

      {/* 搜索 + 部门筛选 */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索岗位…"
          style={{ width: 200, padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-1)', fontSize: 13 }} />
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {DEPARTMENTS.map((d) => (
            <button key={d} onClick={() => setDept(d)}
              style={{
                padding: '5px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                background: dept === d ? 'var(--accent)' : 'var(--input-bg)',
                color: dept === d ? '#fff' : 'var(--text-2)'
              }}>
              {d}
            </button>
          ))}
        </div>
      </div>

      {/* 岗位卡片网格 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
        {filtered.map((role) => (
          <div key={role.id} className="card" style={{ padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <div style={{
                width: 38, height: 38, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: `${role.color}22`, color: role.color, fontSize: 16, fontWeight: 700
              }}>
                <IconUser size={20} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 650, fontSize: 14 }}>{role.name}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{role.department} · {role.role}</div>
              </div>
              <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: `1px solid ${permColor(role.permissionMode)}`, color: permColor(role.permissionMode) }}>
                {permLabel(role.permissionMode)}
              </span>
            </div>

            <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.7, marginBottom: 12, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
              {role.soulMd.split('\n').slice(0, 3).join(' ')}
            </div>

            <button onClick={() => void hire(role)} disabled={hiring === role.id}
              className="btn small primary" style={{ width: '100%', justifyContent: 'center' }}>
              {hired === role.id ? '✓ 已录用' : hiring === role.id ? '录用中…' : <><IconPlus size={13} />录用</>}
            </button>
          </div>
        ))}
      </div>

      {filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-3)' }}>未找到匹配的岗位模板</div>
      )}
    </>
  );
}
