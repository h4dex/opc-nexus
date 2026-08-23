import { useLayoutEffect, useMemo, useRef } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const IMAGE_PROTOCOLS = new Set(['https:', 'aibox-mobile:', 'aibox-artifact:']);
const MEDIA_PROTOCOLS = new Set(['https:', 'aibox-mobile:', 'aibox-artifact:']);
const MAX_MEDIA_URL_CHARS = 4_096;
const MAX_MEDIA_TITLE_CHARS = 160;
const MAX_CHART_SOURCE_CHARS = 64 * 1024;
const MAX_CHART_ITEMS = 24;
const MAX_CHART_LABEL_CHARS = 80;
const MAX_MERMAID_SOURCE_CHARS = 32 * 1024;
const MAX_MERMAID_LINES = 500;

let mermaidConfigured = false;
let mermaidRenderSequence = 0;
type MermaidApi = typeof import('mermaid').default;
let mermaidApi: MermaidApi | null = null;
let mermaidLoad: Promise<MermaidApi> | null = null;

type TypedCodeBlockKind = 'audio' | 'chart' | 'mermaid' | 'video';

export interface MarkdownMediaArtifact {
  url: string;
  title?: string;
}

export interface MarkdownChartDatum {
  label: string;
  value: number;
}

export interface MarkdownChartArtifact {
  title?: string;
  unit?: string;
  data: MarkdownChartDatum[];
}

/**
 * Keep Mermaid as a typed artifact rather than allowing arbitrary directives
 * or links to flow into the renderer. The strict renderer is deliberately
 * conservative: unsupported/dangerous diagrams remain readable source.
 */
export function parseMarkdownMermaidArtifact(source: string): string | null {
  const normalized = source.trim();
  if (!normalized || normalized.length > MAX_MERMAID_SOURCE_CHARS) return null;
  if (normalized.split(/\r?\n/).length > MAX_MERMAID_LINES) return null;
  // Mermaid directives can change parser/security configuration. Link/click
  // directives are also omitted so a diagram cannot become an external
  // navigation surface inside the Nexus renderer.
  if (/%%\{|^\s*(?:click|href|link)\b/im.test(normalized)) return null;
  return normalized;
}

function normalizeTables(markdown: string): string {
  const output: string[] = [];
  for (const line of markdown.split('\n')) {
    const previous = output[output.length - 1] ?? '';
    if (/^\s*\|/.test(line) && previous.trim() && !/^\s*\|/.test(previous)) output.push('');
    output.push(line);
  }
  return output.join('\n');
}

function safeUrl(value: string, protocols: ReadonlySet<string>): boolean {
  if (value.length === 0 || value.length > MAX_MEDIA_URL_CHARS) return false;
  try {
    const url = new URL(value);
    return protocols.has(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) return undefined;
  return normalized;
}

function typedCodeBlockKind(code: Element): TypedCodeBlockKind | null {
  const language = [...code.classList]
    .find((name) => name.startsWith('language-'))
    ?.slice('language-'.length)
    .toLowerCase();
  if (language === 'audio' || language === 'video') return language;
  if (language === 'chart' || language === 'bar' || language === 'bar-chart') return 'chart';
  if (language === 'mermaid' || language === 'mmd') return 'mermaid';
  return null;
}

export function parseMarkdownMediaArtifact(source: string): MarkdownMediaArtifact | null {
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 1 || lines.length > 2 || !safeUrl(lines[0]!, MEDIA_PROTOCOLS)) return null;
  const title = lines.length === 2 ? boundedText(lines[1], MAX_MEDIA_TITLE_CHARS) : undefined;
  if (lines.length === 2 && title === undefined) return null;
  return { url: lines[0]!, ...(title === undefined ? {} : { title }) };
}

function finiteChartValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e15 ? value : null;
}

export function parseMarkdownChartArtifact(source: string): MarkdownChartArtifact | null {
  if (source.length === 0 || source.length > MAX_CHART_SOURCE_CHARS) return null;
  let raw: unknown;
  try { raw = JSON.parse(source); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  if (candidate.type !== undefined && candidate.type !== 'bar') return null;

  const title = candidate.title === undefined ? undefined : boundedText(candidate.title, MAX_MEDIA_TITLE_CHARS);
  const unit = candidate.unit === undefined ? undefined : boundedText(candidate.unit, 24);
  if ((candidate.title !== undefined && title === undefined) || (candidate.unit !== undefined && unit === undefined)) return null;

  let data: MarkdownChartDatum[] = [];
  if (Array.isArray(candidate.data)) {
    if (candidate.data.length < 1 || candidate.data.length > MAX_CHART_ITEMS) return null;
    for (const item of candidate.data) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const row = item as Record<string, unknown>;
      const label = boundedText(row.label, MAX_CHART_LABEL_CHARS);
      const value = finiteChartValue(row.value);
      if (label === undefined || value === null) return null;
      data.push({ label, value });
    }
  } else if (Array.isArray(candidate.labels) && Array.isArray(candidate.values)) {
    if (candidate.labels.length < 1 || candidate.labels.length > MAX_CHART_ITEMS
      || candidate.labels.length !== candidate.values.length) return null;
    for (let index = 0; index < candidate.labels.length; index += 1) {
      const labelValue = candidate.labels[index];
      const label = boundedText(labelValue, MAX_CHART_LABEL_CHARS);
      const value = finiteChartValue(candidate.values[index]);
      if (label === undefined || value === null) return null;
      data.push({ label, value });
    }
  } else {
    return null;
  }

  return { ...(title === undefined ? {} : { title }), ...(unit === undefined ? {} : { unit }), data };
}

function replaceWithBlockedText(document: Document, node: Element, label: string): void {
  node.replaceWith(document.createTextNode(`[${label}已拦截]`));
}

function renderMediaArtifact(
  document: Document,
  pre: HTMLPreElement,
  kind: 'audio' | 'video',
  source: string
): void {
  const artifact = parseMarkdownMediaArtifact(source);
  if (!artifact) {
    replaceWithBlockedText(document, pre, kind === 'video' ? '视频' : '音频');
    return;
  }
  const figure = document.createElement('figure');
  figure.className = `md-media md-media-${kind}`;
  figure.dataset.artifactKind = kind;
  const media = document.createElement(kind);
  media.controls = true;
  media.preload = 'metadata';
  media.src = artifact.url;
  if (kind === 'video') (media as HTMLVideoElement).playsInline = true;
  figure.appendChild(media);
  if (artifact.title) {
    const caption = document.createElement('figcaption');
    caption.textContent = artifact.title;
    figure.appendChild(caption);
  }
  pre.replaceWith(figure);
}

function renderChartArtifact(document: Document, pre: HTMLPreElement, source: string): void {
  let artifact: MarkdownChartArtifact | null;
  try { artifact = parseMarkdownChartArtifact(source); } catch { artifact = null; }
  if (!artifact) {
    replaceWithBlockedText(document, pre, '图表');
    return;
  }
  const chart = document.createElement('figure');
  chart.className = 'md-chart';
  chart.dataset.artifactKind = 'chart';
  chart.setAttribute('role', 'img');
  chart.setAttribute('aria-label', artifact.title ?? '数据图表');
  if (artifact.title) {
    const caption = document.createElement('figcaption');
    caption.textContent = artifact.title;
    chart.appendChild(caption);
  }
  const maximum = Math.max(...artifact.data.map((item) => Math.abs(item.value)), 1);
  const rows = document.createElement('div');
  rows.className = 'md-chart-rows';
  const format = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 });
  for (const item of artifact.data) {
    const row = document.createElement('div');
    row.className = 'md-chart-row';
    const label = document.createElement('span');
    label.className = 'md-chart-label';
    label.textContent = item.label;
    label.title = item.label;
    const track = document.createElement('span');
    track.className = 'md-chart-track';
    const bar = document.createElement('span');
    bar.className = `md-chart-bar${item.value < 0 ? ' negative' : ''}`;
    bar.style.width = `${Math.max(1.5, Math.abs(item.value) / maximum * 100)}%`;
    track.appendChild(bar);
    const value = document.createElement('output');
    value.className = 'md-chart-value';
    value.textContent = `${format.format(item.value)}${artifact.unit ? ` ${artifact.unit}` : ''}`;
    row.append(label, track, value);
    rows.appendChild(row);
  }
  chart.appendChild(rows);
  pre.replaceWith(chart);
}

function enhanceTypedCodeBlocks(document: Document): void {
  for (const pre of [...document.querySelectorAll('pre')]) {
    const code = pre.firstElementChild;
    if (!code || code.tagName !== 'CODE') continue;
    const kind = typedCodeBlockKind(code);
    if (!kind) continue;
    const source = code.textContent ?? '';
    if (kind === 'audio' || kind === 'video') {
      renderMediaArtifact(document, pre, kind, source);
    } else if (kind === 'chart') {
      renderChartArtifact(document, pre, source);
    } else {
      const wrapper = document.createElement('figure');
      wrapper.className = 'md-mermaid-source';
      wrapper.dataset.artifactKind = 'mermaid';
      wrapper.dataset.mermaidSource = source;
      const caption = document.createElement('figcaption');
      caption.textContent = 'Mermaid';
      pre.replaceWith(wrapper);
      wrapper.append(caption, pre);
    }
  }
}

async function loadMermaid(): Promise<MermaidApi> {
  if (mermaidApi) return mermaidApi;
  mermaidLoad ??= import('mermaid').then((module) => module.default);
  mermaidApi = await mermaidLoad;
  return mermaidApi;
}

function configureMermaid(api: MermaidApi): void {
  if (mermaidConfigured) return;
  api.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    suppressErrorRendering: true,
    maxTextSize: MAX_MERMAID_SOURCE_CHARS,
    theme: 'neutral'
  });
  mermaidConfigured = true;
}

function sanitizeMermaidSvg(svg: string): string | null {
  if (!svg || svg.length > 512 * 1024) return null;
  const clean = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['foreignObject', 'script', 'iframe', 'object', 'embed'],
    FORBID_ATTR: [
      'onload', 'onerror', 'onclick', 'onmouseover', 'onfocus', 'onanimationstart',
      'href', 'xlink:href', 'src', 'srcset', 'style'
    ]
  });
  const parsed = new DOMParser().parseFromString(clean, 'image/svg+xml');
  const root = parsed.documentElement;
  if (!root || root.tagName.toLowerCase() !== 'svg') return null;
  // DOMPurify's SVG profile strips event attributes, but keep this explicit
  // post-condition in case the sanitizer configuration changes later.
  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      if (name.startsWith('on') || /(?:javascript:|data:text\/html|https?:\/\/)/i.test(value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  return root.outerHTML;
}

async function renderMermaidArtifacts(root: HTMLElement, isDisposed: () => boolean): Promise<void> {
  const figures = Array.from(root.querySelectorAll<HTMLElement>('.md-mermaid-source'));
  if (figures.length === 0) return;
  const api = await loadMermaid();
  configureMermaid(api);
  for (const figure of figures) {
    if (isDisposed()) return;
    const source = parseMarkdownMermaidArtifact(figure.dataset.mermaidSource ?? '');
    if (!source) continue;
    try {
      await api.parse(source, { suppressErrors: false });
      const id = `aibox-mermaid-${++mermaidRenderSequence}`;
      const rendered = await api.render(id, source);
      const clean = sanitizeMermaidSvg(rendered.svg);
      if (!clean || isDisposed()) continue;
      figure.innerHTML = clean;
      figure.dataset.renderState = 'rendered';
      figure.setAttribute('role', 'img');
      figure.setAttribute('aria-label', 'Mermaid 图表');
    } catch {
      // Keep the original fenced source visible and mark the failure for
      // diagnostics/styles; a malformed diagram must never blank the answer.
      figure.dataset.renderState = 'source';
    }
  }
}

export function renderSafeMarkdown(content: string): string {
  const raw = marked.parse(normalizeTables(content), { async: false, gfm: true, breaks: true }) as string;
  const clean = DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['audio', 'button', 'embed', 'form', 'iframe', 'input', 'object', 'source', 'style', 'video'],
    FORBID_ATTR: ['background', 'formaction', 'ping', 'poster', 'srcset', 'style']
  });
  const document = new DOMParser().parseFromString(clean, 'text/html');
  for (const link of document.querySelectorAll('a')) {
    const href = link.getAttribute('href') ?? '';
    if (!safeUrl(href, LINK_PROTOCOLS)) link.removeAttribute('href');
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
  for (const image of document.querySelectorAll('img')) {
    const src = image.getAttribute('src') ?? '';
    if (!safeUrl(src, IMAGE_PROTOCOLS)) {
      image.replaceWith(document.createTextNode(image.alt ? `[图片：${image.alt}]` : '[图片已拦截]'));
      continue;
    }
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
  }
  enhanceTypedCodeBlocks(document);
  return document.body.innerHTML;
}

export function MarkdownView({ content, className = '', codeCopy = true }: { content: string; className?: string; codeCopy?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => {
    return renderSafeMarkdown(content);
  }, [content]);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.innerHTML = html;
    if (codeCopy) root.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.code-copy-btn')) return;
      const button = document.createElement('button');
      button.className = 'code-copy-btn';
      button.type = 'button';
      button.textContent = '复制';
      button.title = '复制代码';
      button.onclick = () => {
        const code = pre.querySelector('code')?.textContent ?? pre.textContent ?? '';
        void navigator.clipboard.writeText(code);
        button.textContent = '已复制';
        window.setTimeout(() => { button.textContent = '复制'; }, 1500);
      };
      pre.appendChild(button);
    });
    let disposed = false;
    void renderMermaidArtifacts(root, () => disposed);
    return () => { disposed = true; };
  }, [codeCopy, html]);

  return <div ref={ref} className={`md-body ${className}`.trim()} />;
}
