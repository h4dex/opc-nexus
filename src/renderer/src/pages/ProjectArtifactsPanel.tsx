import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ProjectArtifactDirectoryView,
  ProjectArtifactEntryView,
  ProjectArtifactPreviewView
} from '@shared/types';
import { MarkdownView } from '../components/MarkdownView';
import {
  IconAlert,
  IconChevronLeft,
  IconFile,
  IconFolder,
  IconFullscreen,
  IconRefresh
} from '../components/icons';

interface ProjectArtifactsPanelProps {
  projectId: string;
  projectName: string;
  onChooseWorkspace: () => Promise<void>;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  if (value < 1_024 * 1_024 * 1_024) return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
  return `${(value / (1_024 * 1_024 * 1_024)).toFixed(1)} GB`;
}

function entryTypeLabel(entry: ProjectArtifactEntryView): string {
  if (entry.kind === 'directory') return '目录';
  const labels: Record<ProjectArtifactEntryView['previewKind'], string> = {
    html: '网页',
    markdown: 'Markdown',
    image: '图片',
    video: '视频',
    audio: '音频',
    pdf: 'PDF',
    text: '文本',
    unsupported: '文件'
  };
  return labels[entry.previewKind];
}

const ARTIFACT_HTML_CSP = "default-src 'none'; img-src aibox-project: data: blob:; media-src aibox-project: data: blob:; style-src aibox-project: 'unsafe-inline'; font-src aibox-project: data:; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri aibox-project:; form-action 'none'";

function buildHtmlPreviewDocument(source: string, baseUri: string): string {
  const baseUrl = new URL(baseUri);
  if (baseUrl.protocol !== 'aibox-project:' || baseUrl.hostname !== 'preview') {
    throw new Error('项目产物预览地址无效');
  }
  const document = new DOMParser().parseFromString(source, 'text/html');
  document.querySelectorAll('base').forEach((node) => node.remove());
  const policy = document.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = ARTIFACT_HTML_CSP;
  const base = document.createElement('base');
  base.href = baseUrl.href;
  document.head.prepend(policy, base);
  return `<!doctype html>\n${document.documentElement.outerHTML}`;
}

export function ProjectArtifactsPanel({ projectId, projectName, onChooseWorkspace }: ProjectArtifactsPanelProps) {
  const loadSequence = useRef(0);
  const previewSequence = useRef(0);
  const [directory, setDirectory] = useState<ProjectArtifactDirectoryView | null>(null);
  const [selected, setSelected] = useState<ProjectArtifactEntryView | null>(null);
  const [preview, setPreview] = useState<ProjectArtifactPreviewView | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [htmlPreviewUrl, setHtmlPreviewUrl] = useState<string | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);

  const loadDirectory = useCallback(async (relativeDirectory = '') => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError(null);
    try {
      const value = await window.aibox.listProjectArtifacts(projectId, relativeDirectory);
      if (sequence !== loadSequence.current) return;
      setDirectory(value);
      setSelected(null);
      setPreview(null);
      setPreviewError(null);
      setFingerprint(null);
    } catch (reason) {
      if (sequence !== loadSequence.current) return;
      setError(reason instanceof Error ? reason.message : '项目产物目录加载失败');
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadDirectory();
    return () => {
      loadSequence.current += 1;
      previewSequence.current += 1;
    };
  }, [loadDirectory]);

  const openEntry = useCallback(async (entry: ProjectArtifactEntryView) => {
    if (entry.kind === 'directory') {
      await loadDirectory(entry.relativePath);
      return;
    }
    setSelected(entry);
    setPreview(null);
    setPreviewError(null);
    setFingerprint(null);
    const sequence = ++previewSequence.current;
    void window.aibox.hashProjectArtifact(projectId, entry.relativePath)
      .then((value) => { if (sequence === previewSequence.current) setFingerprint(value); })
      .catch(() => { /* advisory only: the preview stays usable without a fingerprint */ });
    if (!entry.previewable) {
      setPreviewError('该文件暂不支持内嵌预览，可在资源管理器中打开');
      return;
    }
    setPreviewLoading(true);
    try {
      const value = await window.aibox.previewProjectArtifact(projectId, entry.relativePath);
      if (sequence !== previewSequence.current) return;
      setPreview(value);
    } catch (reason) {
      if (sequence !== previewSequence.current) return;
      setPreviewError(reason instanceof Error ? reason.message : '项目产物预览失败');
    } finally {
      if (sequence === previewSequence.current) setPreviewLoading(false);
    }
  }, [loadDirectory, projectId]);

  const breadcrumbs = useMemo(() => {
    const parts = directory?.relativeDirectory ? directory.relativeDirectory.split('/') : [];
    return [
      { label: projectName, path: '' },
      ...parts.map((part, index) => ({ label: part, path: parts.slice(0, index + 1).join('/') }))
    ];
  }, [directory?.relativeDirectory, projectName]);

  const htmlPreviewDocument = useMemo(() => {
    if (preview?.entry.previewKind !== 'html' || !preview.uri || preview.text === null) return null;
    try {
      return buildHtmlPreviewDocument(preview.text, preview.uri);
    } catch {
      return null;
    }
  }, [preview]);

  useEffect(() => {
    setHtmlPreviewUrl(null);
    if (!htmlPreviewDocument) return;
    const url = URL.createObjectURL(new Blob([htmlPreviewDocument], { type: 'text/html' }));
    setHtmlPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [htmlPreviewDocument]);

  const revealSelected = async () => {
    if (!selected) return;
    try {
      await window.aibox.revealProjectArtifact(projectId, selected.relativePath);
    } catch (reason) {
      setPreviewError(reason instanceof Error ? reason.message : '无法定位项目产物');
    }
  };

  const chooseWorkspace = async () => {
    await onChooseWorkspace();
    await loadDirectory();
  };

  return (
    <aside className="quest-artifacts" aria-label="项目产物">
      <header className="quest-artifacts-head">
        <div><strong>项目产物</strong><span>项目目录内文件与预览</span></div>
        <button type="button" onClick={() => void loadDirectory(directory?.relativeDirectory ?? '')} title="刷新产物目录" aria-label="刷新产物目录">
          <IconRefresh size={14} />
        </button>
      </header>

      {!loading && directory && !directory.workspaceConfigured ? (
        <div className="quest-artifacts-unconfigured">
          <IconFolder size={22} />
          <strong>尚未选择项目目录</strong>
          <span>选择后，Cordis 和所有数字员工只在该目录内执行并交付产物。</span>
          <button className="btn small primary" type="button" onClick={() => void chooseWorkspace()}>选择项目目录</button>
        </div>
      ) : (
        <div className="quest-artifacts-body">
          <section className="quest-artifact-browser" aria-label="项目产物目录">
            <nav className="quest-artifact-breadcrumbs" aria-label="产物目录层级">
              {directory?.parentDirectory !== null && directory?.relativeDirectory && (
                <button type="button" onClick={() => void loadDirectory(directory.parentDirectory ?? '')} title="返回上级目录" aria-label="返回上级目录">
                  <IconChevronLeft size={14} />
                </button>
              )}
              <div>
                {breadcrumbs.map((item, index) => (
                  <button key={`${item.path}:${index}`} type="button" onClick={() => void loadDirectory(item.path)}>{item.label}</button>
                ))}
              </div>
            </nav>
            {error && <div className="quest-artifact-error"><IconAlert size={13} />{error}</div>}
            {loading && <div className="quest-artifact-loading"><span className="quest-state-spinner" />正在读取项目目录</div>}
            {!loading && directory?.entries.length === 0 && <div className="quest-artifact-empty">当前目录暂无文件</div>}
            <div className="quest-artifact-list">
              {directory?.entries.map((entry) => (
                <button
                  key={entry.relativePath}
                  className={selected?.relativePath === entry.relativePath ? 'active' : ''}
                  type="button"
                  onClick={() => void openEntry(entry)}
                  title={entry.relativePath}
                >
                  {entry.kind === 'directory' ? <IconFolder size={15} /> : <IconFile size={15} />}
                  <span><strong>{entry.name}</strong><small>{entryTypeLabel(entry)}{entry.kind === 'file' ? ` · ${formatBytes(entry.size)} · ${new Date(entry.modifiedAt).toLocaleString('zh-CN', { hour12: false })}` : ''}</small></span>
                </button>
              ))}
              {directory?.truncated && <div className="quest-artifact-truncated">仅显示前 500 项</div>}
            </div>
          </section>

          <section className="quest-artifact-preview" aria-label="项目产物预览">
            <header>
              <div>
                <strong>{selected?.name ?? '选择文件预览'}</strong>
                <span>{selected?.relativePath ?? 'HTML、Markdown、图片、视频、音频、PDF 和文本'}</span>
                {selected && (
                  <span className="quest-artifact-fingerprint" title={fingerprint ? `SHA-256 ${fingerprint}` : undefined}>
                    {fingerprint ? `SHA-256 ${fingerprint.slice(0, 16)}…` : '正在计算 SHA-256'}
                  </span>
                )}
              </div>
              <button type="button" disabled={!selected} onClick={() => void revealSelected()} title="在资源管理器中定位" aria-label="在资源管理器中定位项目产物">
                <IconFullscreen size={14} />
              </button>
            </header>
            <div className={`quest-artifact-preview-stage is-${preview?.entry.previewKind ?? 'empty'}`}>
              {previewLoading && <div className="quest-artifact-preview-state"><span className="quest-state-spinner" />正在生成安全预览</div>}
              {!previewLoading && previewError && <div className="quest-artifact-preview-state error"><IconAlert size={18} /><span>{previewError}</span></div>}
              {!previewLoading && !previewError && !preview && <div className="quest-artifact-preview-state"><IconFile size={20} /><span>从左侧选择一个产物</span></div>}
              {!previewLoading && preview?.entry.previewKind === 'html' && htmlPreviewUrl && (
                <iframe title={`${preview.entry.name} 网页预览`} src={htmlPreviewUrl} sandbox="allow-same-origin" referrerPolicy="no-referrer" />
              )}
              {!previewLoading && preview?.entry.previewKind === 'pdf' && preview.uri && (
                <iframe title={`${preview.entry.name} PDF 预览`} src={preview.uri} referrerPolicy="no-referrer" />
              )}
              {!previewLoading && preview?.entry.previewKind === 'image' && preview.uri && <img src={preview.uri} alt={preview.entry.name} />}
              {!previewLoading && preview?.entry.previewKind === 'video' && preview.uri && <video src={preview.uri} controls preload="metadata" />}
              {!previewLoading && preview?.entry.previewKind === 'audio' && preview.uri && <audio src={preview.uri} controls preload="metadata" />}
              {!previewLoading && preview?.entry.previewKind === 'markdown' && preview.text !== null && (
                <MarkdownView className="quest-artifact-markdown" content={preview.text} />
              )}
              {!previewLoading && preview?.entry.previewKind === 'text' && preview.text !== null && <pre>{preview.text}</pre>}
            </div>
          </section>
        </div>
      )}
    </aside>
  );
}
