/** 全局搜索（Ctrl/Cmd+K）：跨项目、员工、任务、团队、成果与知识定位。 */
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../store';
import { IconBook, IconFile, IconFolder, IconLayers, IconSearch, IconTask, IconUser } from './icons';
import type { GlobalSearchResult, SearchEntityType } from '../../../shared/types';

const ENTITY_META: Record<SearchEntityType, { label: string; tone: string; icon: React.ReactNode }> = {
  project: { label: '项目', tone: 'info', icon: <IconFolder size={14} /> },
  agent: { label: '员工', tone: 'accent', icon: <IconUser size={14} /> },
  task: { label: '任务', tone: 'success', icon: <IconTask size={14} /> },
  team: { label: '专家团', tone: 'warning', icon: <IconLayers size={14} /> },
  deliverable: { label: '成果', tone: 'success', icon: <IconFile size={14} /> },
  knowledge: { label: '知识', tone: 'info', icon: <IconBook size={14} /> }
};

export function GlobalSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { navigate } = useApp();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GlobalSearchResult[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(focusTimer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void window.aibox.globalSearch(query).then((value) => {
        if (!cancelled) { setResults(value); setActive(0); }
      }).catch(() => { if (!cancelled) setResults([]); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, query ? 140 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [open, query]);

  if (!open) return null;

  const go = (result: GlobalSearchResult) => {
    navigate(result.route, { entityType: result.entityType, entityId: result.entityId });
    onClose();
  };
  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((value) => Math.min(value + 1, results.length - 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((value) => Math.max(value - 1, 0)); }
    else if (event.key === 'Enter' && results[active]) { event.preventDefault(); go(results[active]); }
    else if (event.key === 'Escape') onClose();
  };

  return <div className="global-search-mask" onClick={(event) => event.target === event.currentTarget && onClose()}>
    <section className="global-search-panel" role="dialog" aria-label="全局搜索">
      <label className="global-search-input"><IconSearch size={17} /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKey} placeholder="搜索项目、员工、任务、专家团、成果或知识" /><span>Esc</span></label>
      <div className="global-search-results">
        {loading && results.length === 0 ? <div className="global-search-empty">正在检索</div> : results.length === 0 ? <div className="global-search-empty">没有匹配结果</div> : results.map((result, index) => {
          const meta = ENTITY_META[result.entityType];
          return <button key={result.key} className={index === active ? 'active' : ''} type="button" onClick={() => go(result)} onMouseEnter={() => setActive(index)}>
            <span className="global-search-icon" data-tone={meta.tone}>{meta.icon}</span>
            <span className="global-search-copy"><strong>{result.title}</strong><small>{result.subtitle}</small></span>
            <span className="global-search-type">{meta.label}</span>
          </button>;
        })}
      </div>
      <footer><span>↑↓ 选择</span><span>Enter 打开</span><span>{results.length} 项结果</span></footer>
    </section>
  </div>;
}
