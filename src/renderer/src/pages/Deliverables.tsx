/** 成果库：版本、验收、追溯与项目成果包。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { AgentAvatar, Modal } from '../components/common';
import {
  IconCheck, IconDownload, IconFile, IconHistory, IconLayers, IconPlus, IconRefresh,
  IconSearch, IconTag, IconTask, IconX
} from '../components/icons';
import { MarkdownView } from '../components/MarkdownView';
import { toast } from '../components/Toast';
import { TrailingRefreshController } from '../utils/trailingRefresh';
import type {
  DeliverableDetail, DeliverableReviewInput, DeliverableReviewStatus, DeliverableSummary,
  DeliverableType, ProjectDeliverablePackage
} from '../../../shared/types';

type ReviewFilter = 'all' | DeliverableReviewStatus;
type TimeFilter = 'all' | '7d' | '30d' | '90d';
type DetailTab = 'preview' | 'versions' | 'reviews';

const REVIEW_META: Record<DeliverableReviewStatus, { label: string; tone: DeliverableReviewStatus }> = {
  accepted: { label: '已采纳', tone: 'accepted' },
  rejected: { label: '已驳回', tone: 'rejected' },
  rework: { label: '需返工', tone: 'rework' },
  unmarked: { label: '未验收', tone: 'unmarked' }
};

const TYPE_META: Record<DeliverableType, string> = {
  document: '文档', report: '报告', code: '代码', data: '数据', design: '设计', other: '其他'
};

const REVIEW_FILTERS: Array<{ key: ReviewFilter; label: string }> = [
  { key: 'all', label: '全部' }, { key: 'accepted', label: '已采纳' },
  { key: 'rework', label: '需返工' }, { key: 'rejected', label: '已驳回' },
  { key: 'unmarked', label: '未验收' }
];

export function Deliverables() {
  const { snapshot, navigationTarget, clearNavigationTarget } = useApp();
  const [items, setItems] = useState<DeliverableSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectFilter, setProjectFilter] = useState('all');
  const [ownerFilter, setOwnerFilter] = useState('all');
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | DeliverableType>('all');
  const [tagFilter, setTagFilter] = useState('all');
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all');
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState<DeliverableDetail | null>(null);
  const [reviewing, setReviewing] = useState<{ item: DeliverableSummary; status: DeliverableReviewStatus } | null>(null);
  const [editingMeta, setEditingMeta] = useState<DeliverableDetail | null>(null);
  const [addingVersion, setAddingVersion] = useState<DeliverableDetail | null>(null);
  const [projectPackage, setProjectPackage] = useState<ProjectDeliverablePackage | null>(null);
  const refreshRef = useRef<TrailingRefreshController<DeliverableSummary[]> | null>(null);
  if (!refreshRef.current) refreshRef.current = new TrailingRefreshController();
  const refresh = refreshRef.current;
  const firstLoadRef = useRef(true);

  const load = useCallback((immediate = false) => refresh.request({
    run: () => window.aibox.listDeliverables(),
    accept: (value) => { setItems(value); setLoading(false); },
    reject: (error) => {
      toast.err(error instanceof Error ? error.message : '成果加载失败');
      setLoading(false);
    }
  }, { immediate }), [refresh]);

  useEffect(() => {
    return () => {
      firstLoadRef.current = true;
      refresh.cancel();
    };
  }, [refresh]);
  useEffect(() => {
    void load(firstLoadRef.current);
    firstLoadRef.current = false;
  }, [load, snapshot?.version]);

  const projects = snapshot?.projects ?? [];
  const projectItems = useMemo(() => items.filter((item) => projectFilter === 'all'
    || (projectFilter === 'unassigned' ? !item.projectId : item.projectId === projectFilter)), [items, projectFilter]);
  const owners = useMemo(() => {
    const map = new Map<string, { id: string; type: 'agent' | 'team'; name: string; role: string; count: number }>();
    for (const item of projectItems) {
      const current = map.get(item.ownerId);
      if (current) current.count += 1;
      else map.set(item.ownerId, { id: item.ownerId, type: item.ownerType, name: item.ownerName, role: item.ownerRole, count: 1 });
    }
    return [...map.values()].sort((a, b) => a.type.localeCompare(b.type) || b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
  }, [projectItems]);
  const allTags = useMemo(() => [...new Set(projectItems.flatMap((item) => item.tags))].sort((a, b) => a.localeCompare(b, 'zh-CN')), [projectItems]);
  const agentColors = useMemo(() => new Map((snapshot?.agentCards ?? []).map((card) => [card.agent.id, card.agent.avatarColor])), [snapshot]);

  useEffect(() => {
    if (ownerFilter !== 'all' && ownerFilter !== 'team' && !owners.some((owner) => owner.id === ownerFilter)) setOwnerFilter('all');
  }, [ownerFilter, owners]);

  const baseFiltered = useMemo(() => {
    const now = Date.now();
    const days = timeFilter === '7d' ? 7 : timeFilter === '30d' ? 30 : timeFilter === '90d' ? 90 : 0;
    const keyword = query.trim().toLocaleLowerCase('zh-CN');
    return projectItems.filter((item) => {
      if (ownerFilter === 'team' && item.ownerType !== 'team') return false;
      if (ownerFilter !== 'all' && ownerFilter !== 'team' && item.ownerId !== ownerFilter) return false;
      if (typeFilter !== 'all' && item.type !== typeFilter) return false;
      if (tagFilter !== 'all' && !item.tags.includes(tagFilter)) return false;
      if (days && item.updatedAt < now - days * 86_400_000) return false;
      if (keyword && !`${item.title} ${item.ownerName} ${item.projectName ?? ''} ${item.tags.join(' ')}`.toLocaleLowerCase('zh-CN').includes(keyword)) return false;
      return true;
    });
  }, [ownerFilter, projectItems, query, tagFilter, timeFilter, typeFilter]);

  const reviewCounts = useMemo(() => {
    const counts: Record<ReviewFilter, number> = { all: baseFiltered.length, accepted: 0, rejected: 0, rework: 0, unmarked: 0 };
    baseFiltered.forEach((item) => { counts[item.reviewStatus] += 1; });
    return counts;
  }, [baseFiltered]);
  const visible = useMemo(() => baseFiltered
    .filter((item) => reviewFilter === 'all' || item.reviewStatus === reviewFilter)
    .sort((a, b) => b.updatedAt - a.updatedAt), [baseFiltered, reviewFilter]);

  const openDetail = async (id: string) => {
    const next = await window.aibox.getDeliverable(id);
    if (next) setDetail(next);
  };
  useEffect(() => {
    if (navigationTarget?.entityType !== 'deliverable') return;
    let active = true;
    void window.aibox.getDeliverable(navigationTarget.entityId).then((value) => {
      if (active && value) {
        setDetail(value);
        clearNavigationTarget();
      }
    });
    return () => { active = false; };
  }, [clearNavigationTarget, navigationTarget]);
  const refreshDetail = async (id: string) => {
    await load(true);
    const next = await window.aibox.getDeliverable(id);
    setDetail(next);
  };
  const copyLatest = async (id: string) => {
    const current = await window.aibox.getDeliverable(id);
    if (!current) return;
    await navigator.clipboard.writeText(current.latestContent);
    toast.ok('成果正文已复制');
  };
  const exportOne = async (id: string, format: 'markdown' | 'json') => {
    const result = await window.aibox.exportDeliverable(id, format);
    if (result.ok) toast.ok(format === 'markdown' ? '成果正文已下载' : '成果详情已导出');
  };
  const openPackage = async () => {
    if (projectFilter === 'all' || projectFilter === 'unassigned') return;
    setProjectPackage(await window.aibox.getProjectDeliverablePackage(projectFilter));
  };

  if (!snapshot) return null;
  const concreteProject = projectFilter !== 'all' && projectFilter !== 'unassigned';

  return (
    <div className="deliverables-page deliverable-workbench">
      <div className="page-head">
        <h2>成果库</h2>
        <span className="desc">{items.length} 项成果 · {items.filter((item) => item.reviewStatus === 'accepted').length} 项已采纳</span>
        <div className="right">
          <select className="project-scope-select" value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)} aria-label="按项目筛选成果" style={{ minWidth: 160 }}>
            <option value="all">全部项目</option><option value="unassigned">未归项目</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <button className="btn small primary" type="button" disabled={!concreteProject || projectItems.length === 0} title={concreteProject ? '预览项目成果包' : '先选择具体项目'} onClick={() => void openPackage()}>
            <IconDownload size={13} />成果包
          </button>
        </div>
      </div>

      <section className="deliverable-owner-section" aria-labelledby="deliverable-owner-title">
        <div className="deliverable-section-head"><h3 id="deliverable-owner-title">成果归属</h3><span>{projectItems.length} 项</span></div>
        <div className="deliverable-owner-list">
          <OwnerOption active={ownerFilter === 'all'} name="全部成果" role="项目与员工汇总" count={projectItems.length} onClick={() => setOwnerFilter('all')} />
          <OwnerOption active={ownerFilter === 'team'} name="专家团整体" role="协作终稿" count={projectItems.filter((item) => item.ownerType === 'team').length} team onClick={() => setOwnerFilter('team')} />
          {owners.filter((owner) => owner.type === 'agent').map((owner) => (
            <OwnerOption key={owner.id} active={ownerFilter === owner.id} name={owner.name} role={owner.role} count={owner.count}
              color={agentColors.get(owner.id)} onClick={() => setOwnerFilter(owner.id)} />
          ))}
        </div>
      </section>

      <div className="deliverable-tools">
        <label className="deliverable-search"><IconSearch size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索成果、负责人或标签" /></label>
        <select className="project-scope-select" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as 'all' | DeliverableType)} aria-label="按类型筛选">
          <option value="all">全部类型</option>{Object.entries(TYPE_META).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <select className="project-scope-select" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)} aria-label="按标签筛选">
          <option value="all">全部标签</option>{allTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
        </select>
        <select className="project-scope-select" value={timeFilter} onChange={(event) => setTimeFilter(event.target.value as TimeFilter)} aria-label="按更新时间筛选">
          <option value="all">全部时间</option><option value="7d">近 7 天</option><option value="30d">近 30 天</option><option value="90d">近 90 天</option>
        </select>
      </div>

      <div className="deliverable-filterbar">
        <div className="deliverable-filter-label">验收状态</div>
        <div className="deliverable-quality-switch" aria-label="按验收状态筛选">
          {REVIEW_FILTERS.map((item) => <button key={item.key} className={reviewFilter === item.key ? 'active' : ''} type="button" onClick={() => setReviewFilter(item.key)}>{item.label}<span>{reviewCounts[item.key]}</span></button>)}
        </div>
      </div>

      <div className="deliverable-results-head"><div><h3>成果列表</h3><span>展示 {visible.length} / {baseFiltered.length} 项</span></div></div>
      {loading ? <div className="deliverable-empty"><strong>正在汇总成果</strong></div> : visible.length === 0 ? (
        <div className="deliverable-empty"><span><IconLayers size={26} /></span><strong>暂无匹配成果</strong><small>调整项目、归属或验收筛选条件。</small></div>
      ) : (
        <div className="deliverable-list">
          {visible.map((item) => (
            <article key={item.id} className="card deliverable-card">
              <div className="deliverable-card-top">
                {item.ownerType === 'team' ? <span className="deliverable-team-avatar"><IconLayers size={19} /></span> : <AgentAvatar color={agentColors.get(item.ownerId) ?? 'var(--text-3)'} size={38} />}
                <div className="deliverable-card-heading">
                  <strong title={item.title}>{item.title}</strong>
                  <div className="deliverable-card-meta"><span>{item.ownerName}</span><span>{item.projectName ?? '未归项目'}</span><span>{TYPE_META[item.type]}</span><span>v{item.latestVersion} / {item.versionCount} 版</span><time>{new Date(item.updatedAt).toLocaleString('zh-CN', { hour12: false })}</time></div>
                </div>
                <span className="deliverable-quality" data-tone={REVIEW_META[item.reviewStatus].tone}>{REVIEW_META[item.reviewStatus].label}</span>
              </div>
              {item.tags.length > 0 && <div className="deliverable-tags">{item.tags.map((tag) => <span key={tag}><IconTag size={10} />{tag}</span>)}</div>}
              <div className="deliverable-preview">{item.preview}{item.preview.length >= 320 ? '…' : ''}</div>
              <div className="deliverable-actions">
                <button className="btn small" type="button" onClick={() => void openDetail(item.id)}><IconFile size={12} />预览</button>
                <button className="btn small" type="button" onClick={() => void copyLatest(item.id)}>复制</button>
                <button className="btn small" type="button" onClick={() => void exportOne(item.id, 'markdown')}><IconDownload size={12} />下载</button>
                <span className="deliverable-action-divider" />
                <button className="btn small deliverable-accept" type="button" aria-pressed={item.reviewStatus === 'accepted'} onClick={() => setReviewing({ item, status: 'accepted' })}><IconCheck size={13} />采纳</button>
                <button className="btn small deliverable-rework" type="button" aria-pressed={item.reviewStatus === 'rework'} onClick={() => setReviewing({ item, status: 'rework' })}><IconRefresh size={13} />返工</button>
                <button className="btn small deliverable-reject" type="button" aria-pressed={item.reviewStatus === 'rejected'} onClick={() => setReviewing({ item, status: 'rejected' })}><IconX size={13} />驳回</button>
              </div>
            </article>
          ))}
        </div>
      )}

      {detail && <DeliverableDetailModal detail={detail} onClose={() => setDetail(null)} onReview={(status) => setReviewing({ item: detail, status })}
        onEditMeta={() => setEditingMeta(detail)} onAddVersion={() => setAddingVersion(detail)} onExport={exportOne} />}
      {reviewing && <ReviewModal target={reviewing} onClose={() => setReviewing(null)} onSaved={async (id) => { setReviewing(null); await refreshDetail(id); }} />}
      {editingMeta && <MetaModal detail={editingMeta} onClose={() => setEditingMeta(null)} onSaved={async (id) => { setEditingMeta(null); await refreshDetail(id); }} />}
      {addingVersion && <VersionModal detail={addingVersion} onClose={() => setAddingVersion(null)} onSaved={async (id) => { setAddingVersion(null); await refreshDetail(id); }} />}
      {projectPackage && <PackageModal value={projectPackage} onClose={() => setProjectPackage(null)} />}
    </div>
  );
}

function OwnerOption({ active, name, role, count, team, color, onClick }: { active: boolean; name: string; role: string; count: number; team?: boolean; color?: string; onClick: () => void }) {
  return <button className={`deliverable-owner-option ${active ? 'active' : ''}`} type="button" aria-pressed={active} onClick={onClick}>
    {team ? <span className="deliverable-team-avatar"><IconLayers size={19} /></span> : color ? <AgentAvatar color={color} size={36} /> : <span className="deliverable-team-avatar"><IconFile size={18} /></span>}
    <span className="deliverable-owner-copy"><strong>{name}</strong><small>{role}</small></span><span className="deliverable-owner-count">{count}</span>
  </button>;
}

function DeliverableDetailModal({ detail, onClose, onReview, onEditMeta, onAddVersion, onExport }: {
  detail: DeliverableDetail; onClose: () => void; onReview: (status: DeliverableReviewStatus) => void;
  onEditMeta: () => void; onAddVersion: () => void; onExport: (id: string, format: 'markdown' | 'json') => Promise<void>;
}) {
  const [tab, setTab] = useState<DetailTab>('preview');
  const [selectedVersion, setSelectedVersion] = useState(detail.latestVersion);
  const [compareLeft, setCompareLeft] = useState(detail.versions[1]?.version ?? detail.latestVersion);
  const [compareRight, setCompareRight] = useState(detail.latestVersion);
  useEffect(() => {
    setSelectedVersion(detail.latestVersion);
    setCompareLeft(detail.versions[1]?.version ?? detail.latestVersion);
    setCompareRight(detail.latestVersion);
  }, [detail.id, detail.latestVersion, detail.versions]);
  const selected = detail.versions.find((version) => version.version === selectedVersion) ?? detail.versions[0];
  const left = detail.versions.find((version) => version.version === compareLeft) ?? detail.versions[0];
  const right = detail.versions.find((version) => version.version === compareRight) ?? detail.versions[0];

  return <Modal title={detail.title} onClose={onClose} width={1040} footer={<>
    <button className="btn" type="button" onClick={() => void navigator.clipboard.writeText(selected?.content ?? '').then(() => toast.ok('当前版本已复制'))}>复制当前版本</button>
    <button className="btn" type="button" onClick={() => void onExport(detail.id, 'markdown')}><IconDownload size={13} />下载正文</button>
    <button className="btn" type="button" onClick={() => void onExport(detail.id, 'json')}>导出详情</button>
    <button className="btn primary" type="button" onClick={onClose}>关闭</button>
  </>}>
    <div className="deliverable-trace">
      <span><small>项目</small><strong>{detail.trace.project?.name ?? '未归项目'}</strong></span><b>›</b>
      <span><small>{detail.sourceType === 'task' ? '来源任务' : '专家团运行'}</small><strong>{detail.trace.source.title}</strong></span><b>›</b>
      <span><small>执行负责人</small><strong>{detail.trace.owner.name}</strong></span>
      <span className="deliverable-quality" data-tone={detail.reviewStatus}>{REVIEW_META[detail.reviewStatus].label}</span>
    </div>
    <div className="deliverable-detail-toolbar">
      <div className="deliverable-detail-tabs">{(['preview', 'versions', 'reviews'] as DetailTab[]).map((key) => <button key={key} className={tab === key ? 'active' : ''} type="button" onClick={() => setTab(key)}>{key === 'preview' ? '成果预览' : key === 'versions' ? `版本历史 ${detail.versionCount}` : `验收记录 ${detail.reviews.length}`}</button>)}</div>
      <button className="btn small" type="button" onClick={onEditMeta}><IconTag size={12} />类型与标签</button>
      <button className="btn small primary" type="button" onClick={onAddVersion}><IconPlus size={12} />新增版本</button>
    </div>
    <div className="deliverable-detail-meta"><span>{TYPE_META[detail.type]}</span><span>v{detail.latestVersion}</span><span>{detail.ownerName}</span><span>{new Date(detail.updatedAt).toLocaleString('zh-CN', { hour12: false })}</span>{detail.tags.map((tag) => <span key={tag} className="tag gray">{tag}</span>)}</div>
    {tab === 'preview' && <div className="deliverable-detail-preview">
      <div className="deliverable-version-picker"><label>查看版本</label><select className="project-scope-select" value={selectedVersion} onChange={(event) => setSelectedVersion(Number(event.target.value))}>{detail.versions.map((version) => <option key={version.id} value={version.version}>v{version.version} · {version.changeNote}</option>)}</select></div>
      <MarkdownView content={selected?.content ?? ''} className="deliverable-markdown" />
      <div className="deliverable-review-actions"><button className="btn small deliverable-accept" onClick={() => onReview('accepted')}><IconCheck size={13} />采纳</button><button className="btn small deliverable-rework" onClick={() => onReview('rework')}><IconRefresh size={13} />返工</button><button className="btn small deliverable-reject" onClick={() => onReview('rejected')}><IconX size={13} />驳回</button>{detail.reviewStatus !== 'unmarked' && <button className="btn small" onClick={() => onReview('unmarked')}>重置验收</button>}</div>
    </div>}
    {tab === 'versions' && <div className="deliverable-version-layout">
      <div className="deliverable-version-list">{detail.versions.map((version) => <button key={version.id} className={selectedVersion === version.version ? 'active' : ''} type="button" onClick={() => { setSelectedVersion(version.version); setCompareLeft(version.version); }}><strong>v{version.version}</strong><span>{version.changeNote}</span><small>{version.createdBy} · {new Date(version.createdAt).toLocaleString('zh-CN', { hour12: false })}</small></button>)}</div>
      <div className="deliverable-compare">
        <div className="deliverable-compare-controls"><IconHistory size={14} /><strong>版本对比</strong><select className="project-scope-select" value={compareLeft} onChange={(event) => setCompareLeft(Number(event.target.value))}>{detail.versions.map((version) => <option key={version.id} value={version.version}>v{version.version}</option>)}</select><span>对比</span><select className="project-scope-select" value={compareRight} onChange={(event) => setCompareRight(Number(event.target.value))}>{detail.versions.map((version) => <option key={version.id} value={version.version}>v{version.version}</option>)}</select></div>
        <div className="deliverable-compare-panes"><section><header>v{left?.version}</header><pre>{left?.content}</pre></section><section><header>v{right?.version}</header><pre>{right?.content}</pre></section></div>
      </div>
    </div>}
    {tab === 'reviews' && <div className="deliverable-review-timeline">{detail.reviews.length === 0 ? <div className="empty">暂无验收记录</div> : detail.reviews.map((review) => <div key={review.id}><span className="deliverable-quality" data-tone={review.status}>{REVIEW_META[review.status].label}</span><div><strong>{review.note || '未填写说明'}</strong><small>{review.reviewer} · {new Date(review.createdAt).toLocaleString('zh-CN', { hour12: false })}{review.reworkRef ? ` · 返工编号 ${review.reworkRef}` : ''}</small></div></div>)}</div>}
  </Modal>;
}

function ReviewModal({ target, onClose, onSaved }: { target: { item: DeliverableSummary; status: DeliverableReviewStatus }; onClose: () => void; onSaved: (id: string) => Promise<void> }) {
  const [note, setNote] = useState(target.status === 'accepted' ? '符合项目验收标准' : '');
  const [createRework, setCreateRework] = useState(target.status === 'rework');
  const [saving, setSaving] = useState(false);
  const required = target.status === 'rejected' || target.status === 'rework';
  const submit = async () => {
    setSaving(true);
    try {
      const input: DeliverableReviewInput = { status: target.status, note: note.trim(), createRework };
      const result = await window.aibox.reviewDeliverable(target.item.id, input);
      toast.ok(result.reworkMessage ?? `成果${REVIEW_META[target.status].label}`);
      await onSaved(target.item.id);
    } catch (error) { toast.err(error instanceof Error ? error.message : '验收保存失败'); }
    finally { setSaving(false); }
  };
  return <Modal title={`${REVIEW_META[target.status].label} · ${target.item.title}`} onClose={onClose} width={560} footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={saving || (required && note.trim().length < 2)} onClick={() => void submit()}>{saving ? '保存中…' : '确认'}</button></>}>
    <div className="field"><label>{required ? '处理说明 *' : '验收说明'}</label><textarea rows={5} maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} placeholder={target.status === 'rework' ? '说明需要修改的内容和验收标准' : target.status === 'rejected' ? '说明驳回原因' : '记录采纳依据'} /></div>
    {target.status === 'rework' && <label className="deliverable-rework-toggle"><input type="checkbox" checked={createRework} onChange={(event) => setCreateRework(event.target.checked)} /><span>立即派发返工任务</span></label>}
  </Modal>;
}

function MetaModal({ detail, onClose, onSaved }: { detail: DeliverableDetail; onClose: () => void; onSaved: (id: string) => Promise<void> }) {
  const [type, setType] = useState(detail.type);
  const [tags, setTags] = useState(detail.tags.join('，'));
  const [saving, setSaving] = useState(false);
  const submit = async () => { setSaving(true); try { await window.aibox.updateDeliverableMeta(detail.id, { type, tags: tags.split(/[，,]/).map((item) => item.trim()).filter(Boolean) }); toast.ok('成果分类已更新'); await onSaved(detail.id); } catch (error) { toast.err(error instanceof Error ? error.message : '保存失败'); } finally { setSaving(false); } };
  return <Modal title={`类型与标签 · ${detail.title}`} onClose={onClose} width={520} footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={saving} onClick={() => void submit()}>保存</button></>}>
    <div className="field"><label>成果类型</label><select value={type} onChange={(event) => setType(event.target.value as DeliverableType)}>{Object.entries(TYPE_META).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div>
    <div className="field" style={{ marginTop: 14 }}><label>标签</label><input value={tags} maxLength={240} onChange={(event) => setTags(event.target.value)} placeholder="用逗号分隔，最多 10 个" /></div>
  </Modal>;
}

function VersionModal({ detail, onClose, onSaved }: { detail: DeliverableDetail; onClose: () => void; onSaved: (id: string) => Promise<void> }) {
  const [content, setContent] = useState(detail.latestContent);
  const [note, setNote] = useState(detail.reviewStatus === 'rework' ? '根据返工意见修订' : '内容修订');
  const [saving, setSaving] = useState(false);
  const submit = async () => { setSaving(true); try { await window.aibox.addDeliverableVersion(detail.id, { content, changeNote: note, origin: detail.reviewStatus === 'rework' ? 'rework' : 'manual' }); toast.ok(`v${detail.latestVersion + 1} 已创建，等待重新验收`); await onSaved(detail.id); } catch (error) { toast.err(error instanceof Error ? error.message : '版本创建失败'); } finally { setSaving(false); } };
  return <Modal title={`新增版本 · ${detail.title}`} onClose={onClose} width={760} footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={saving || content.trim().length === 0 || note.trim().length < 2} onClick={() => void submit()}>{saving ? '保存中…' : `创建 v${detail.latestVersion + 1}`}</button></>}>
    <div className="field"><label>版本说明 *</label><input value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} /></div>
    <div className="field" style={{ marginTop: 14 }}><label>成果正文 *</label><textarea className="deliverable-version-editor" rows={18} maxLength={200000} value={content} onChange={(event) => setContent(event.target.value)} /></div>
  </Modal>;
}

function PackageModal({ value, onClose }: { value: ProjectDeliverablePackage; onClose: () => void }) {
  const [exporting, setExporting] = useState(false);
  const exportPackage = async () => { setExporting(true); try { const result = await window.aibox.exportProjectDeliverablePackage(value.project.id); if (result.ok) { toast.ok('项目成果包已导出'); onClose(); } } catch (error) { toast.err(error instanceof Error ? error.message : '成果包导出失败'); } finally { setExporting(false); } };
  return <Modal title={`${value.project.name} · 成果包`} onClose={onClose} width={760} footer={<><button className="btn" onClick={onClose}>关闭</button><button className="btn primary" disabled={exporting || value.summary.total === 0} onClick={() => void exportPackage()}><IconDownload size={13} />{exporting ? '导出中…' : '导出到文件夹'}</button></>}>
    <div className="deliverable-package-summary"><span><strong>{value.summary.total}</strong>成果</span><span data-tone="accepted"><strong>{value.summary.accepted}</strong>已采纳</span><span data-tone="rework"><strong>{value.summary.rework}</strong>需返工</span><span data-tone="rejected"><strong>{value.summary.rejected}</strong>已驳回</span><span><strong>{value.summary.unmarked}</strong>未验收</span></div>
    <div className="deliverable-package-list">{value.deliverables.map((item, index) => <div key={item.id}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{item.title}</strong><small>{item.ownerName} · {TYPE_META[item.type]} · v{item.latestVersion}</small></div><span className="deliverable-quality" data-tone={item.reviewStatus}>{REVIEW_META[item.reviewStatus].label}</span></div>)}</div>
  </Modal>;
}
