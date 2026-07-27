/** 全局搜索（Ctrl/Cmd+K 唤起）：跨员工 / 任务 / 团队快速定位并跳转 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, type RouteKey } from '../store';

interface SearchResult {
  key: string;
  type: '员工' | '任务' | '项目' | '团队';
  title: string;
  subtitle: string;
  route: RouteKey;
}

export function GlobalSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { snapshot, setRoute } = useApp();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  const results = useMemo<SearchResult[]>(() => {
    if (!snapshot) return [];
    const q = query.trim().toLowerCase();
    const list: SearchResult[] = [];

    for (const project of snapshot.projects ?? []) {
      if (!q || project.name.toLowerCase().includes(q) || project.objective.toLowerCase().includes(q) || project.clientName.toLowerCase().includes(q)) {
        list.push({ key: `pr-${project.id}`, type: '项目', title: project.name, subtitle: project.objective || project.status, route: 'projects' });
      }
    }

    for (const c of snapshot.agentCards) {
      if (!q || c.agent.name.toLowerCase().includes(q) || (c.agent.role ?? '').toLowerCase().includes(q)) {
        list.push({ key: `ag-${c.agent.id}`, type: '员工', title: c.agent.name, subtitle: c.agent.role || '数字员工', route: 'agents' });
      }
    }
    for (const t of snapshot.tasks) {
      if (!q || t.title.toLowerCase().includes(q)) {
        list.push({ key: `tk-${t.id}`, type: '任务', title: t.title, subtitle: t.status, route: 'tasks' });
      }
    }
    return list.slice(0, 30);
  }, [snapshot, query]);

  useEffect(() => { setActive(0); }, [query]);

  if (!open) return null;

  const go = (r: SearchResult) => {
    setRoute(r.route);
    onClose();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter' && results[active]) { e.preventDefault(); go(results[active]); }
    else if (e.key === 'Escape') { onClose(); }
  };

  const typeColor: Record<string, string> = { '员工': 'var(--accent)', '任务': 'var(--success)', '项目': 'var(--info)', '团队': 'var(--warning)' };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 2000, display: 'flex', justifyContent: 'center', paddingTop: '12vh' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card" style={{ width: 560, maxHeight: '60vh', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden', animation: 'toast-in .15s ease-out' }}
        onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontSize: 15, color: 'var(--text-3)' }}>🔍</span>
          <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey}
            placeholder="搜索项目 / 员工 / 任务…（↑↓ 选择，Enter 跳转，Esc 关闭）"
            style={{ flex: 1, border: 'none', background: 'transparent', color: 'var(--text-1)', fontSize: 14, outline: 'none' }} />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
          {results.length === 0 ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
              {query.trim() ? '没有匹配的结果' : '输入关键词开始搜索'}
            </div>
          ) : (
            results.map((r, i) => (
              <div key={r.key} onClick={() => go(r)} onMouseEnter={() => setActive(i)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 8, cursor: 'pointer', background: i === active ? 'var(--accent-soft)' : 'transparent' }}>
                <span style={{ fontSize: 10.5, fontWeight: 700, color: typeColor[r.type], padding: '1px 7px', borderRadius: 8, background: 'var(--input-bg)', flexShrink: 0 }}>{r.type}</span>
                <span style={{ fontSize: 13, color: 'var(--text-1)', fontWeight: 550, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
                <span style={{ fontSize: 11, color: 'var(--text-3)', flexShrink: 0 }}>{r.subtitle}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
