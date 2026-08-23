import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArtifactRefService, isAuthorizedArtifactUrl } from '../src/main/services/artifactRef.js';
import type { ArtifactKind } from '../src/shared/types.js';

const encoder = new TextEncoder();

function fixture(kind: ArtifactKind): { mediaType: string; filename: string; data: Uint8Array } {
  switch (kind) {
    case 'image': return { mediaType: 'image/png', filename: 'image.png', data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]) };
    case 'video': return { mediaType: 'video/mp4', filename: 'clip.mp4', data: new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109]) };
    case 'audio': return { mediaType: 'audio/wav', filename: 'voice.wav', data: encoder.encode('RIFF0000WAVEdata') };
    case 'mermaid': return { mediaType: 'text/vnd.mermaid', filename: 'flow.mmd', data: encoder.encode('flowchart LR\nA --> B') };
    case 'chart': return { mediaType: 'application/vnd.aibox.chart+json', filename: 'usage.chart.json', data: encoder.encode('{"type":"bar","data":{"labels":["A"],"datasets":[]}}') };
    case 'markdown': return { mediaType: 'text/markdown', filename: 'report.md', data: encoder.encode('# Report\n\nDone.') };
    case 'file': return { mediaType: 'application/pdf', filename: 'report.pdf', data: encoder.encode('%PDF-1.7\nfixture') };
  }
}

describe('ArtifactRefService', () => {
  it('creates content-addressed authorized refs for every v2 artifact kind', () => {
    const root = mkdtempSync(join(tmpdir(), 'aibox-artifact-'));
    let token = 0;
    const service = new ArtifactRefService({
      root,
      now: () => 100,
      randomToken: () => `${'A'.repeat(40)}${String(token++).padStart(4, '0')}`
    });
    for (const kind of ['image', 'video', 'audio', 'mermaid', 'chart', 'markdown', 'file'] as ArtifactKind[]) {
      const ref = service.put({ kind, ...fixture(kind) });
      expect(ref).toMatchObject({ schemaVersion: 1, kind, createdAt: 100, previewable: true });
      expect(ref.id).toBe(`artifact-${kind}-${ref.sha256}`);
      expect(isAuthorizedArtifactUrl(ref.uri)).toBe(true);
      expect(JSON.stringify(ref)).not.toContain(root);
      const resolved = service.resolveAuthorizedUrl(ref.uri);
      expect(resolved.data).toEqual(Buffer.from(fixture(kind).data));
      expect(resolved.headers).toMatchObject({
        'content-type': fixture(kind).mediaType,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff'
      });
    }
  });

  it('rejects path/url injection, MIME spoofing and malformed chart data', () => {
    const root = mkdtempSync(join(tmpdir(), 'aibox-artifact-'));
    const service = new ArtifactRefService({ root });
    expect(() => service.put({ kind: 'markdown', ...fixture('markdown'), filename: '../secret.md' })).toThrow(/filename/);
    expect(() => service.put({ kind: 'image', mediaType: 'image/png', filename: 'spoof.png', data: encoder.encode('<html>') })).toThrow(/media type/);
    expect(() => service.put({ kind: 'chart', mediaType: 'application/json', filename: 'bad.json', data: encoder.encode('{bad') })).toThrow(/invalid/);
    expect(() => service.put({ kind: 'markdown', ...fixture('markdown'), path: 'C:\\secret.md' } as never)).toThrow(/input/);
    expect(isAuthorizedArtifactUrl('file:///C:/secret.png')).toBe(false);
    expect(isAuthorizedArtifactUrl('https://example.com/image.png')).toBe(false);
  });

  it('expires and revokes grants, and detects stored-byte tampering', () => {
    const root = mkdtempSync(join(tmpdir(), 'aibox-artifact-'));
    let now = 1_000;
    let token = 0;
    const service = new ArtifactRefService({
      root,
      now: () => now,
      grantTtlMs: 1_000,
      randomToken: () => `${'B'.repeat(40)}${String(token++).padStart(4, '0')}`
    });
    const first = service.put({ kind: 'markdown', ...fixture('markdown') });
    now = 2_000;
    expect(() => service.resolveAuthorizedUrl(first.uri)).toThrow(/expired/);

    now = 2_001;
    const second = service.authorize(first);
    expect(service.revoke(second)).toBe(true);
    expect(() => service.resolveAuthorizedUrl(second.uri)).toThrow(/invalid/);

    const third = service.authorize(first);
    writeFileSync(join(root, `${third.sha256}.md`), 'tampered');
    expect(() => service.resolveAuthorizedUrl(third.uri)).toThrow(/integrity/);
  });
});
