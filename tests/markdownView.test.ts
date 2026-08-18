import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseMarkdownChartArtifact,
  parseMarkdownMediaArtifact,
  parseMarkdownMermaidArtifact
} from '../src/renderer/src/components/MarkdownView.js';

describe('MarkdownView typed artifacts', () => {
  it('keeps asynchronous Mermaid enhancements outside React innerHTML reconciliation', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'components', 'MarkdownView.tsx'), 'utf8');
    expect(source).toContain('useLayoutEffect');
    expect(source).toContain('root.innerHTML = html;');
    expect(source).not.toContain('dangerouslySetInnerHTML');
  });

  it('accepts only bounded HTTPS or app-protocol media references', () => {
    expect(parseMarkdownMediaArtifact('https://media.example/demo.mp4\nQuarterly demo')).toEqual({
      url: 'https://media.example/demo.mp4',
      title: 'Quarterly demo'
    });
    expect(parseMarkdownMediaArtifact('aibox-mobile://artifact/media-1')).toEqual({
      url: 'aibox-mobile://artifact/media-1'
    });
    expect(parseMarkdownMediaArtifact(`aibox-artifact://artifact/artifact-video-${'a'.repeat(64)}?grant=${'A'.repeat(43)}`)).toEqual({
      url: `aibox-artifact://artifact/artifact-video-${'a'.repeat(64)}?grant=${'A'.repeat(43)}`
    });

    for (const source of [
      'http://media.example/demo.mp4',
      'file:///C:/secret.mp4',
      'javascript:alert(1)',
      'https://user:password@media.example/demo.mp4',
      'https://media.example/demo.mp4\ntitle\nignored-third-line'
    ]) {
      expect(parseMarkdownMediaArtifact(source)).toBeNull();
    }
  });

  it('normalizes the two supported bounded bar-chart shapes', () => {
    expect(parseMarkdownChartArtifact(JSON.stringify({
      type: 'bar',
      title: 'Revenue',
      unit: 'CNY',
      data: [{ label: 'Q1', value: 12.5 }, { label: 'Q2', value: -3 }]
    }))).toEqual({
      title: 'Revenue',
      unit: 'CNY',
      data: [{ label: 'Q1', value: 12.5 }, { label: 'Q2', value: -3 }]
    });
    expect(parseMarkdownChartArtifact(JSON.stringify({
      labels: ['Ready', 'Running'],
      values: [4, 2]
    }))).toEqual({
      data: [{ label: 'Ready', value: 4 }, { label: 'Running', value: 2 }]
    });
  });

  it('rejects malformed, executable, oversized, and non-finite chart input', () => {
    const tooMany = Array.from({ length: 25 }, (_, index) => ({ label: String(index), value: index }));
    for (const source of [
      'not-json',
      JSON.stringify({ type: 'line', data: [{ label: 'A', value: 1 }] }),
      JSON.stringify({ data: [{ label: 'A', value: '1' }] }),
      JSON.stringify({ labels: ['A'], values: [1, 2] }),
      JSON.stringify({ data: tooMany }),
      JSON.stringify({ data: [{ label: 'A', value: 1e16 }] }),
      JSON.stringify({ title: 'bad\u0000title', data: [{ label: 'A', value: 1 }] })
    ]) {
      expect(parseMarkdownChartArtifact(source)).toBeNull();
    }
  });

  it('accepts bounded Mermaid source while rejecting configuration and navigation directives', () => {
    expect(parseMarkdownMermaidArtifact('flowchart TD\n  A[Start] --> B[Done]')).toBe('flowchart TD\n  A[Start] --> B[Done]');
    expect(parseMarkdownMermaidArtifact('%%{init: {"securityLevel":"loose"}}\nflowchart TD\n A-->B')).toBeNull();
    expect(parseMarkdownMermaidArtifact('flowchart TD\n click A "https://evil.example"')).toBeNull();
    expect(parseMarkdownMermaidArtifact('')).toBeNull();
    expect(parseMarkdownMermaidArtifact('x'.repeat(32 * 1024 + 1))).toBeNull();
  });
});
