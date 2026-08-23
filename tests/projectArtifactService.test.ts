import { createHash } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProjectArtifactProtocolHandler,
  ProjectArtifactError,
  ProjectArtifactService
} from '../src/main/services/projectArtifactService.js';

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'aibox-project-artifacts-'));
  roots.push(root);
  return root;
}

function service(root: string, options: { now?: () => number; randomToken?: () => string } = {}) {
  let sequence = 0;
  return new ProjectArtifactService({
    getProjectRoot: (projectId) => projectId === 'project-1' ? root : null,
    now: options.now,
    randomToken: options.randomToken ?? (() => `${String(++sequence).padStart(32, 'A')}`)
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ProjectArtifactService', () => {
  it('lists only renderer-safe relative project entries including Chinese filenames', () => {
    const root = workspace();
    mkdirSync(join(root, '交付'));
    writeFileSync(join(root, '交付', '报告.md'), '# 完成');
    writeFileSync(join(root, 'index.html'), '<h1>Done</h1>');

    const value = service(root).list('project-1');

    expect(value.workspaceConfigured).toBe(true);
    expect(value.entries.map((entry) => [entry.name, entry.kind, entry.previewKind])).toEqual([
      ['交付', 'directory', 'unsupported'],
      ['index.html', 'file', 'html']
    ]);
    expect(value.entries.some((entry) => JSON.stringify(entry).includes(root))).toBe(false);
    expect(service(root).list('project-1', '交付').entries[0]).toMatchObject({
      relativePath: '交付/报告.md',
      previewKind: 'markdown',
      previewable: true
    });
  });

  it('returns an explicit unconfigured state instead of guessing another workspace', () => {
    const root = workspace();
    const artifacts = new ProjectArtifactService({ getProjectRoot: () => null });
    expect(artifacts.list('project-1')).toEqual({
      projectId: 'project-1',
      workspaceConfigured: false,
      relativeDirectory: '',
      parentDirectory: null,
      entries: [],
      truncated: false
    });
    expect(() => artifacts.preview('project-1', 'result.md')).toThrowError(ProjectArtifactError);
    expect(root).toBeTruthy();
  });

  it('previews UTF-8 Markdown without exposing a host path', () => {
    const root = workspace();
    writeFileSync(join(root, '总结.md'), '# 验收\n\n已完成。');
    const preview = service(root).preview('project-1', '总结.md');
    expect(preview).toMatchObject({ uri: null, text: '# 验收\n\n已完成。', truncated: false });
    expect(JSON.stringify(preview)).not.toContain(root);
  });

  it('serves an authorized HTML preview and its relative assets', async () => {
    const root = workspace();
    mkdirSync(join(root, 'site'));
    writeFileSync(join(root, 'site', 'index.html'), '<link rel="stylesheet" href="style.css"><h1>交付</h1>');
    writeFileSync(join(root, 'site', 'style.css'), 'h1 { color: green; }');
    const artifacts = service(root);
    const preview = artifacts.preview('project-1', 'site/index.html');
    const handle = createProjectArtifactProtocolHandler(artifacts);

    expect(preview.uri).toMatch(/^aibox-project:\/\/preview\//);
    expect(preview.text).toContain('<h1>交付</h1>');
    const html = handle(new Request(preview.uri!));
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toContain('text/html');
    expect(await html.text()).toContain('<h1>交付</h1>');

    const css = handle(new Request(new URL('style.css', preview.uri!).href));
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(await css.text()).toContain('color: green');
  });

  it('rejects absolute paths, traversal, and unsupported files', () => {
    const root = workspace();
    writeFileSync(join(root, 'archive.bin'), 'not a preview');
    const artifacts = service(root);
    expect(() => artifacts.list('project-1', '../outside')).toThrow(/路径/);
    expect(() => artifacts.preview('project-1', 'C:\\Windows\\win.ini')).toThrow(/项目目录内/);
    expect(() => artifacts.preview('project-1', 'archive.bin')).toThrow(/不支持/);
  });

  it('does not list or traverse symlinks that escape the project root', () => {
    const root = workspace();
    const outside = workspace();
    writeFileSync(join(outside, 'secret.txt'), 'outside');
    try {
      symlinkSync(outside, join(root, 'outside-link'), 'junction');
    } catch {
      return;
    }
    const artifacts = service(root);
    expect(artifacts.list('project-1').entries.some((entry) => entry.name === 'outside-link')).toBe(false);
    expect(() => artifacts.preview('project-1', 'outside-link/secret.txt')).toThrow(/符号链接|越界/);
  });

  it('serves protocol responses with a script-free CSP matching the renderer sandbox', () => {
    const root = workspace();
    writeFileSync(join(root, 'index.html'), '<h1>Done</h1>');
    const artifacts = service(root);
    const preview = artifacts.preview('project-1', 'index.html');
    const csp = createProjectArtifactProtocolHandler(artifacts)(new Request(preview.uri!))
      .headers.get('content-security-policy') ?? '';

    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).not.toMatch(/script-src[^;]*aibox-project:/);
  });

  it('streams protocol responses instead of buffering the whole artifact in the main process', async () => {
    const root = workspace();
    const payload = Buffer.alloc(3 * 1024 * 1024, 7);
    writeFileSync(join(root, 'clip.mp4'), payload);
    const artifacts = service(root);
    const preview = artifacts.preview('project-1', 'clip.mp4');

    expect(preview.text).toBeNull();
    const resolved = artifacts.resolveAuthorizedUrl(preview.uri!);
    expect(resolved).toMatchObject({ size: payload.byteLength });
    expect(resolved).not.toHaveProperty('data');
    expect(typeof resolved.fd).toBe('number');
    expect(resolved.headers['content-length']).toBe(String(payload.byteLength));
    closeSync(resolved.fd);

    const response = createProjectArtifactProtocolHandler(artifacts)(new Request(preview.uri!));
    expect(response.status).toBe(200);
    expect(response.body).toBeTruthy();
    expect(Buffer.from(await response.arrayBuffer()).equals(payload)).toBe(true);
  });

  it('reports the served byte count from the open descriptor, not a stale stat', async () => {
    const root = workspace();
    writeFileSync(join(root, 'report.pdf'), Buffer.alloc(64, 3));
    const artifacts = service(root);
    const preview = artifacts.preview('project-1', 'report.pdf');

    const grown = Buffer.alloc(4_096, 5);
    writeFileSync(join(root, 'report.pdf'), grown);

    const response = createProjectArtifactProtocolHandler(artifacts)(new Request(preview.uri!));
    expect(response.status).toBe(200);
    const body = Buffer.from(await response.arrayBuffer());
    expect(response.headers.get('content-length')).toBe(String(body.byteLength));
    expect(body.byteLength).toBe(grown.byteLength);
  });

  it('fingerprints a file with a streaming SHA-256 and keeps the workspace boundary', async () => {
    const root = workspace();
    const outside = workspace();
    writeFileSync(join(outside, 'secret.txt'), 'outside');
    writeFileSync(join(root, '交付.bin'), Buffer.alloc(1024 * 1024, 3));
    const expected = createHash('sha256').update(Buffer.alloc(1024 * 1024, 3)).digest('hex');
    const artifacts = service(root);

    await expect(artifacts.hash('project-1', '交付.bin')).resolves.toBe(expected);
    await expect(artifacts.hash('project-1', '../outside/secret.txt')).rejects.toThrow(/路径/);
    await expect(artifacts.hash('project-2', '交付.bin')).rejects.toThrow(/项目目录/);
  });

  it('expires preview grants and rejects non-GET protocol requests', () => {
    const root = workspace();
    writeFileSync(join(root, 'index.html'), '<h1>Done</h1>');
    let now = 100;
    const artifacts = service(root, { now: () => now, randomToken: () => 'T'.repeat(43) });
    const preview = artifacts.preview('project-1', 'index.html');
    const handle = createProjectArtifactProtocolHandler(artifacts);
    expect(handle(new Request(preview.uri!, { method: 'POST' })).status).toBe(405);
    now += 15 * 60_000 + 1;
    expect(handle(new Request(preview.uri!)).status).toBe(410);
  });
});
