/** 项目知识库：成果沉淀、全文检索、不可变版本与执行复用记录。 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal } from '../components/common';
import { MarkdownView } from '../components/MarkdownView';
import { toast } from '../components/Toast';
import { useApp } from '../store';
import {
  IconArchive, IconBook, IconCheck, IconFile, IconHistory, IconPin, IconPlus, IconRefresh,
  IconSearch, IconTag
} from '../components/icons';
import type {
  KnowledgeCategory, KnowledgeDetail, KnowledgePatch, KnowledgeQuery, KnowledgeSourceType,
  KnowledgeStatus, KnowledgeSummary, Project
} from '../../../shared/types';

const CATEGORY_META: Record<KnowledgeCategory, string> = {
  decision: '关键决策', playbook: '执行手册', research: '研究洞察', reference: '参考资料', lesson: '经验复盘', other: '其他'
};

const SOURCE_META: Record<KnowledgeSourceType, string> = { manual: '手动记录', deliverable: '验收成果' };

type DetailTab = 'content' | 'versions' | 'trace';

export function Knowledge() {
  const { snapshot, setRoute } = useApp();
  const [items, setItems] = useState<KnowledgeSummary[]>([]);
  const [allItems, setAllItems] = useState<KnowledgeSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectId, setProjectId] = useState('all');
  const [category, setCategory] = useState<'all' | KnowledgeCategory>('all');
  const [sourceType, setSourceType] = useState<'all' | KnowledgeSourceType>('all');
  const [status, setStatus] = useState<KnowledgeStatus | 'all'>('active');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<KnowledgeDetail | null>(null);
  const [editing, setEditing] = useState<KnowledgeDetail | null>(null);
  const [versioning, setVersioning] = useState<KnowledgeDetail | null>(null);

  const load = useCallback(async () => {
    const query: KnowledgeQuery = {
      projectId: projectId === 'all' ? undefined : projectId,
      category: category === 'all' ? undefined : category,
      sourceType: sourceType === 'all' ? undefined : sourceType,
      status,
      search: search.trim() || undefined
    };
    try {
      const [filtered, complete] = await Promise.all([
        window.aibox.listKnowledge(query),
        window.aibox.listKnowledge({ status: 'all' })
      ]);
      setItems(filtered);
      setAllItems(complete);
    } catch (error) {
      toast.err(error instanceof Error ? error.message : '知识库加载失败');
    } finally {
      setLoading(false);
    }
  }, [category, projectId, search, sourceType, status]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 180);
    return () => window.clearTimeout(timer);
  }, [load, snapshot?.version]);

  const projects = snapshot?.projects ?? [];
  const activeProjects = projects.filter((project) => project.status !== 'archived');
  const metrics = useMemo(() => ({
    total: allItems.length,
    active: allItems.filter((item) => item.status === 'active').length,
    fromDeliverables: allItems.filter((item) => item.sourceType === 'deliverable').length,
    reused: allItems.reduce((sum, item) => sum + item.usageCount, 0)
  }), [allItems]);

  const openDetail = async (id: string) => {
    const value = await window.aibox.getKnowledge(id);
    if (value) setDetail(value);
  };
  const refreshDetail = async (id: string) => {
    await load();
    setDetail(await window.aibox.getKnowledge(id));
  };
  const patch = async (item: KnowledgeSummary, value: KnowledgePatch, message: string) => {
    try {
      await window.aibox.updateKnowledge(item.id, value);
      toast.ok(message);
      await load();
      if (detail?.id === item.id) setDetail(await window.aibox.getKnowledge(item.id));
    } catch (error) { toast.err(error instanceof Error ? error.message : '知识更新失败'); }
  };

  if (!snapshot) return null;

  return <div className="knowledge-page">
    <div className="page-head">
      <h2>项目知识库</h2>
      <span className="desc">{metrics.active} 条有效知识 · 累计复用 {metrics.reused} 次</span>
      <div className="right"><button className="btn small primary" type="button" disabled={activeProjects.length === 0} onClick={() => setCreating(true)}><IconPlus size={13} />新建知识</button></div>
    </div>

    <section className="knowledge-metrics" aria-label="知识库概览">
      <span><strong>{metrics.total}</strong><small>知识总数</small></span>
      <span><strong>{metrics.active}</strong><small>有效知识</small></span>
      <span><strong>{metrics.fromDeliverables}</strong><small>成果沉淀</small></span>
      <span><strong>{metrics.reused}</strong><small>执行复用</small></span>
    </section>

    <div className="knowledge-toolbar">
      <label className="knowledge-search"><IconSearch size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题、正文或标签" /></label>
      <select className="project-scope-select" value={projectId} onChange={(event) => setProjectId(event.target.value)} aria-label="按项目筛选知识"><option value="all">全部项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
      <select className="project-scope-select" value={category} onChange={(event) => setCategory(event.target.value as 'all' | KnowledgeCategory)} aria-label="按分类筛选知识"><option value="all">全部分类</option>{Object.entries(CATEGORY_META).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
      <select className="project-scope-select" value={sourceType} onChange={(event) => setSourceType(event.target.value as 'all' | KnowledgeSourceType)} aria-label="按来源筛选知识"><option value="all">全部来源</option>{Object.entries(SOURCE_META).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
      <div className="knowledge-status-switch" aria-label="按状态筛选知识">{([['active', '有效'], ['archived', '已归档'], ['all', '全部']] as const).map(([key, label]) => <button key={key} className={status === key ? 'active' : ''} type="button" onClick={() => setStatus(key)}>{label}</button>)}</div>
    </div>

    <div className="knowledge-results-head"><div><h3>知识条目</h3><span>{items.length} 条</span></div><span>{projectId === 'all' ? '专家团跨项目总览' : projects.find((project) => project.id === projectId)?.name}</span></div>
    {loading ? <div className="knowledge-empty"><strong>正在加载知识</strong></div> : items.length === 0 ? <div className="knowledge-empty"><span><IconBook size={27} /></span><strong>暂无匹配知识</strong><small>调整筛选条件或创建项目知识。</small></div> : <div className="knowledge-list">
      {items.map((item) => <article className="card knowledge-card" key={item.id}>
        <div className="knowledge-card-main">
          <span className="knowledge-card-icon" data-category={item.category}><IconBook size={18} /></span>
          <div className="knowledge-card-heading">
            <div><strong title={item.title}>{item.title}</strong>{item.pinned && <span className="knowledge-pinned"><IconPin size={11} />置顶</span>}</div>
            <div className="knowledge-card-meta"><span>{item.projectName}</span><span>{CATEGORY_META[item.category]}</span><span>{SOURCE_META[item.sourceType]}</span><span>v{item.latestVersion}</span></div>
          </div>
          <div className="knowledge-usage"><strong>{item.usageCount}</strong><small>复用</small></div>
        </div>
        {item.tags.length > 0 && <div className="knowledge-tags">{item.tags.map((tag) => <span key={tag}><IconTag size={10} />{tag}</span>)}</div>}
        <p className="knowledge-preview">{item.preview || '暂无正文摘要'}</p>
        <div className="knowledge-card-foot">
          <span>{item.lastUsedAt ? `最近复用 ${new Date(item.lastUsedAt).toLocaleDateString('zh-CN')}` : '尚未用于执行'} · 更新于 {new Date(item.updatedAt).toLocaleDateString('zh-CN')}</span>
          <div>
            <button className="btn small" type="button" onClick={() => void openDetail(item.id)}><IconFile size={12} />详情</button>
            <button className="btn small" type="button" aria-pressed={item.pinned} onClick={() => void patch(item, { pinned: !item.pinned }, item.pinned ? '已取消置顶' : '知识已置顶')}><IconPin size={12} />{item.pinned ? '取消置顶' : '置顶'}</button>
            <button className="btn small" type="button" onClick={() => void patch(item, { status: item.status === 'active' ? 'archived' : 'active' }, item.status === 'active' ? '知识已归档' : '知识已恢复')}><IconArchive size={12} />{item.status === 'active' ? '归档' : '恢复'}</button>
          </div>
        </div>
      </article>)}
    </div>}

    {creating && <KnowledgeEditor projects={activeProjects} onClose={() => setCreating(false)} onSaved={async (id) => { setCreating(false); await load(); await openDetail(id); }} />}
    {detail && <KnowledgeDetailModal detail={detail} onClose={() => setDetail(null)} onEdit={() => setEditing(detail)} onVersion={() => setVersioning(detail)} onOpenSource={() => { setDetail(null); setRoute('deliverables'); }} />}
    {editing && <KnowledgeMetaEditor detail={editing} onClose={() => setEditing(null)} onSaved={async (id) => { setEditing(null); await refreshDetail(id); }} />}
    {versioning && <KnowledgeVersionEditor detail={versioning} onClose={() => setVersioning(null)} onSaved={async (id) => { setVersioning(null); await refreshDetail(id); }} />}
  </div>;
}

function KnowledgeEditor({ projects, onClose, onSaved }: { projects: Project[]; onClose: () => void; onSaved: (id: string) => Promise<void> }) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<KnowledgeCategory>('reference');
  const [tags, setTags] = useState('');
  const [content, setContent] = useState('');
  const [pinned, setPinned] = useState(false);
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    try {
      const value = await window.aibox.createKnowledge({ projectId, title, category, content, pinned, tags: splitTags(tags) });
      toast.ok('项目知识已创建');
      await onSaved(value.id);
    } catch (error) { toast.err(error instanceof Error ? error.message : '创建失败'); }
    finally { setSaving(false); }
  };
  return <Modal title="新建项目知识" width={760} onClose={onClose} footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={saving || !projectId || title.trim().length < 2 || !content.trim()} onClick={() => void submit()}>{saving ? '保存中…' : '创建知识'}</button></>}>
    <div className="knowledge-form-grid"><div className="field"><label>所属项目 *</label><select value={projectId} onChange={(event) => setProjectId(event.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></div><div className="field"><label>知识分类</label><select value={category} onChange={(event) => setCategory(event.target.value as KnowledgeCategory)}>{Object.entries(CATEGORY_META).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div></div>
    <div className="field"><label>标题 *</label><input maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} /></div>
    <div className="field"><label>标签</label><input maxLength={240} value={tags} onChange={(event) => setTags(event.target.value)} placeholder="用逗号分隔，最多 10 个" /></div>
    <div className="field"><label>知识正文 *</label><textarea className="knowledge-editor" rows={14} maxLength={200000} value={content} onChange={(event) => setContent(event.target.value)} /></div>
    <label className="knowledge-check"><input type="checkbox" checked={pinned} onChange={(event) => setPinned(event.target.checked)} /><span>置顶到当前项目知识列表</span></label>
  </Modal>;
}

function KnowledgeDetailModal({ detail, onClose, onEdit, onVersion, onOpenSource }: { detail: KnowledgeDetail; onClose: () => void; onEdit: () => void; onVersion: () => void; onOpenSource: () => void }) {
  const [tab, setTab] = useState<DetailTab>('content');
  const [selectedVersion, setSelectedVersion] = useState(detail.latestVersion);
  useEffect(() => setSelectedVersion(detail.latestVersion), [detail.id, detail.latestVersion]);
  const version = detail.versions.find((item) => item.version === selectedVersion) ?? detail.versions[0];
  return <Modal title={detail.title} width={980} onClose={onClose} footer={<><button className="btn" onClick={() => void navigator.clipboard.writeText(version?.content ?? '').then(() => toast.ok('知识正文已复制'))}>复制正文</button><button className="btn primary" onClick={onClose}>关闭</button></>}>
    <div className="knowledge-trace"><span><small>项目</small><strong>{detail.trace.project.name}</strong></span><b>›</b><span><small>来源</small><strong>{SOURCE_META[detail.sourceType]}</strong></span><b>›</b><span><small>当前版本</small><strong>v{detail.latestVersion}</strong></span><span className="knowledge-detail-usage">已复用 {detail.usageCount} 次</span></div>
    <div className="knowledge-detail-toolbar"><div className="knowledge-detail-tabs">{([['content', '知识正文'], ['versions', `版本历史 ${detail.versionCount}`], ['trace', '来源追溯']] as const).map(([key, label]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</div><button className="btn small" onClick={onEdit}><IconTag size={12} />编辑属性</button><button className="btn small primary" onClick={onVersion}><IconPlus size={12} />新增版本</button></div>
    {tab === 'content' && <div className="knowledge-detail-content"><div className="knowledge-version-picker"><label>查看版本</label><select className="project-scope-select" value={selectedVersion} onChange={(event) => setSelectedVersion(Number(event.target.value))}>{detail.versions.map((item) => <option key={item.id} value={item.version}>v{item.version} · {item.changeNote}</option>)}</select></div><MarkdownView content={version?.content ?? ''} className="knowledge-markdown" /></div>}
    {tab === 'versions' && <div className="knowledge-version-timeline">{detail.versions.map((item) => <button key={item.id} className={selectedVersion === item.version ? 'active' : ''} onClick={() => { setSelectedVersion(item.version); setTab('content'); }}><span>v{item.version}</span><div><strong>{item.changeNote}</strong><small>{item.origin === 'deliverable' ? '成果同步' : '手动维护'} · {item.createdBy} · {new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })}</small></div></button>)}</div>}
    {tab === 'trace' && <div className="knowledge-source-detail"><section><span><IconBook size={17} /></span><div><small>所属项目</small><strong>{detail.trace.project.name}</strong><p>{detail.trace.project.status}</p></div></section><section><span>{detail.sourceType === 'deliverable' ? <IconCheck size={17} /> : <IconFile size={17} />}</span><div><small>知识来源</small><strong>{detail.trace.source.title}</strong><p>{detail.sourceType === 'deliverable' ? detail.sourceId : detail.id}</p></div>{detail.sourceType === 'deliverable' && <button className="btn small" onClick={onOpenSource}>查看成果库</button>}</section><section><span><IconHistory size={17} /></span><div><small>版本与使用</small><strong>{detail.versionCount} 个版本 · 复用 {detail.usageCount} 次</strong><p>{detail.lastUsedAt ? `最近复用 ${new Date(detail.lastUsedAt).toLocaleString('zh-CN', { hour12: false })}` : '尚未用于专家团执行'}</p></div></section></div>}
  </Modal>;
}

function KnowledgeMetaEditor({ detail, onClose, onSaved }: { detail: KnowledgeDetail; onClose: () => void; onSaved: (id: string) => Promise<void> }) {
  const [title, setTitle] = useState(detail.title);
  const [category, setCategory] = useState(detail.category);
  const [tags, setTags] = useState(detail.tags.join('，'));
  const [pinned, setPinned] = useState(detail.pinned);
  const [saving, setSaving] = useState(false);
  const submit = async () => { setSaving(true); try { await window.aibox.updateKnowledge(detail.id, { title, category, tags: splitTags(tags), pinned }); toast.ok('知识属性已更新'); await onSaved(detail.id); } catch (error) { toast.err(error instanceof Error ? error.message : '保存失败'); } finally { setSaving(false); } };
  return <Modal title={`编辑属性 · ${detail.title}`} width={560} onClose={onClose} footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={saving || title.trim().length < 2} onClick={() => void submit()}>保存</button></>}><div className="field"><label>标题 *</label><input value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} /></div><div className="field"><label>知识分类</label><select value={category} onChange={(event) => setCategory(event.target.value as KnowledgeCategory)}>{Object.entries(CATEGORY_META).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div><div className="field"><label>标签</label><input value={tags} maxLength={240} onChange={(event) => setTags(event.target.value)} /></div><label className="knowledge-check"><input type="checkbox" checked={pinned} onChange={(event) => setPinned(event.target.checked)} /><span>置顶知识</span></label></Modal>;
}

function KnowledgeVersionEditor({ detail, onClose, onSaved }: { detail: KnowledgeDetail; onClose: () => void; onSaved: (id: string) => Promise<void> }) {
  const [note, setNote] = useState('内容修订');
  const [content, setContent] = useState(detail.latestContent);
  const [saving, setSaving] = useState(false);
  const submit = async () => { setSaving(true); try { await window.aibox.addKnowledgeVersion(detail.id, { content, changeNote: note }); toast.ok(`知识 v${detail.latestVersion + 1} 已创建`); await onSaved(detail.id); } catch (error) { toast.err(error instanceof Error ? error.message : '版本创建失败'); } finally { setSaving(false); } };
  return <Modal title={`新增版本 · ${detail.title}`} width={760} onClose={onClose} footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={saving || note.trim().length < 2 || !content.trim()} onClick={() => void submit()}>{saving ? '保存中…' : `创建 v${detail.latestVersion + 1}`}</button></>}><div className="field"><label>版本说明 *</label><input value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} /></div><div className="field"><label>知识正文 *</label><textarea className="knowledge-editor" rows={18} maxLength={200000} value={content} onChange={(event) => setContent(event.target.value)} /></div></Modal>;
}

function splitTags(value: string): string[] {
  return value.split(/[，,]/).map((item) => item.trim()).filter(Boolean);
}
