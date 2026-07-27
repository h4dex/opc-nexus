import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

function normalizeTables(markdown: string): string {
  const output: string[] = [];
  for (const line of markdown.split('\n')) {
    const previous = output[output.length - 1] ?? '';
    if (/^\s*\|/.test(line) && previous.trim() && !/^\s*\|/.test(previous)) output.push('');
    output.push(line);
  }
  return output.join('\n');
}

export function MarkdownView({ content, className = '' }: { content: string; className?: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(normalizeTables(content), { async: false, gfm: true, breaks: true }) as string;
    const clean = DOMPurify.sanitize(raw, { ADD_ATTR: ['target', 'rel'] });
    const document = new DOMParser().parseFromString(clean, 'text/html');
    for (const link of document.querySelectorAll('a')) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    return document.body.innerHTML;
  }, [content]);

  return <div className={`md-body ${className}`.trim()} dangerouslySetInnerHTML={{ __html: html }} />;
}
