import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactRefService, ARTIFACT_PROTOCOL_SCHEME } from '../src/main/services/artifactRef.js';
import { createArtifactProtocolHandler, registerArtifactProtocol } from '../src/main/services/artifactProtocol.js';

function request(url: string, method = 'GET'): Request {
  return { url, method } as Request;
}

describe('aibox-artifact protocol', () => {
  it('serves only valid GET grants with bounded security headers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aibox-artifact-protocol-'));
    const service = new ArtifactRefService({ root, randomToken: () => 'A'.repeat(43) });
    const ref = service.put({
      kind: 'markdown', mediaType: 'text/markdown', filename: 'result.md', data: new TextEncoder().encode('# Result')
    });
    const handle = createArtifactProtocolHandler(service);
    const response = handle(request(ref.uri));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/markdown');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.text()).toBe('# Result');

    const write = handle(request(ref.uri, 'POST'));
    expect(write.status).toBe(405);
    expect(write.headers.get('allow')).toBe('GET');
    expect(handle(request(`aibox-artifact://artifact/${ref.id}?grant=${'B'.repeat(43)}`)).status).toBe(403);
    expect(handle(request('file:///C:/secret.md')).status).toBe(403);
  });

  it('maps expired grants to 410 without leaking a host path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aibox-artifact-protocol-'));
    let now = 0;
    const service = new ArtifactRefService({ root, now: () => now, grantTtlMs: 1_000, randomToken: () => 'C'.repeat(43) });
    const ref = service.put({
      kind: 'markdown', mediaType: 'text/markdown', filename: 'result.md', data: new TextEncoder().encode('# Result')
    });
    now = 1_000;
    const response = createArtifactProtocolHandler(service)(request(ref.uri));
    expect(response.status).toBe(410);
    const body = await response.text();
    expect(body).toBe('Artifact unavailable');
    expect(body).not.toContain(root);
  });

  it('registers the handler after ready while scheme privilege stays before app.whenReady', () => {
    const root = mkdtempSync(join(tmpdir(), 'aibox-artifact-protocol-'));
    const service = new ArtifactRefService({ root });
    const handle = vi.fn();
    registerArtifactProtocol({ handle }, service);
    expect(handle).toHaveBeenCalledWith(ARTIFACT_PROTOCOL_SCHEME, expect.any(Function));

    const source = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8');
    expect(source).toContain('scheme: ARTIFACT_PROTOCOL_SCHEME');
    expect(source.indexOf('protocol.registerSchemesAsPrivileged')).toBeLessThan(source.indexOf('app.whenReady()'));
    expect(source.indexOf('registerArtifactProtocol(protocol, artifactRefs)')).toBeGreaterThan(source.indexOf('app.whenReady()'));
  });
});
