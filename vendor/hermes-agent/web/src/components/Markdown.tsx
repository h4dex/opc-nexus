import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useMemo, useState, type ReactNode } from "react";

marked.setOptions({ gfm: true, breaks: true });

// Project artifacts are opaque, short-lived Main-owned references. They are
// explicitly allowlisted here so the embedded Workbench can render real
// images/audio/video produced by governed workers without opening filesystem
// URLs or arbitrary custom-protocol navigation.
const SAFE_URI = /^(?:(?:https?|mailto):|aibox-(?:artifact|mobile):|\/(?!\/)|#)/i;

/** Render assistant Markdown without allowing HTML or URL schemes to escape the app. */
export function Markdown({
  content,
  streaming,
}: {
  content: string;
  highlightTerms?: string[];
  streaming?: boolean;
}) {
  const blocks = useMemo(() => splitMermaidBlocks(content), [content]);
  return (
    <div className="nexus-markdown text-sm text-foreground leading-relaxed">
      {blocks.map((block, index) => block.type === "mermaid"
        ? <MermaidBlock key={index} source={block.source} streaming={streaming && index === blocks.length - 1} />
        : <SafeMarkdown key={index} source={block.source} streaming={streaming && index === blocks.length - 1} />)}
      {blocks.length === 0 && streaming ? <StreamingCaret /> : null}
    </div>
  );
}

function SafeMarkdown({ source, streaming }: { source: string; streaming?: boolean }) {
  const html = useMemo(() => {
    const parsed = marked.parse(source) as string;
    return DOMPurify.sanitize(parsed, {
      ADD_TAGS: ["video", "audio", "source"],
      ADD_ATTR: ["controls", "preload", "poster", "playsinline", "target", "rel"],
      ALLOWED_URI_REGEXP: SAFE_URI,
      FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "button"],
      FORBID_ATTR: ["onerror", "onclick", "onload", "style"]
    });
  }, [source]);
  return (
    <div className="nexus-markdown-block min-w-0">
      <div dangerouslySetInnerHTML={{ __html: html }} />
      {streaming ? <StreamingCaret /> : null}
    </div>
  );
}

function MermaidBlock({ source, streaming }: { source: string; streaming?: boolean }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = useMemo(() => `nexus-mermaid-${Math.random().toString(36).slice(2, 10)}`, []);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);
    void import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base" });
      const rendered = await mermaid.render(id, source);
      if (cancelled) return;
      setSvg(DOMPurify.sanitize(rendered.svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        RETURN_TRUSTED_TYPE: false,
        FORBID_TAGS: ["script", "foreignObject"]
      }));
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "Mermaid 图表解析失败");
    });
    return () => { cancelled = true; };
  }, [id, source]);

  if (svg) {
    return (
      <div className="nexus-mermaid overflow-x-auto border border-current/15 bg-secondary/10 p-3">
        <div dangerouslySetInnerHTML={{ __html: svg }} />
        {streaming ? <StreamingCaret /> : null}
      </div>
    );
  }
  return (
    <div className="nexus-mermaid-fallback border border-current/15 bg-secondary/20 p-3">
      <div className="mb-2 text-xs text-text-secondary">{error ?? (streaming ? "正在绘制流程图…" : "正在解析流程图…")}</div>
      <pre className="overflow-x-auto text-xs"><code>{source}</code></pre>
      {streaming ? <StreamingCaret /> : null}
    </div>
  );
}

type MarkdownBlock = { type: "markdown"; source: string } | { type: "mermaid"; source: string };

function splitMermaidBlocks(content: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const pattern = /```(?:mermaid|mmd)\s*\n([\s\S]*?)\n```/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    if (match.index > cursor) blocks.push({ type: "markdown", source: content.slice(cursor, match.index) });
    blocks.push({ type: "mermaid", source: match[1] ?? "" });
    cursor = match.index + match[0].length;
  }
  if (cursor < content.length) blocks.push({ type: "markdown", source: content.slice(cursor) });
  return blocks;
}

function StreamingCaret(): ReactNode {
  return <span aria-hidden className="nexus-markdown-caret inline-block w-[0.5em] h-[1em] ml-0.5 align-[-0.15em] bg-foreground/50 animate-pulse" />;
}
