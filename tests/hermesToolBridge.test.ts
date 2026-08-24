// @ts-nocheck
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

const execFile = vi.fn((file, args, _options, callback) => {
  const values = Array.isArray(args) ? args.map(String) : [];
  const candidate = values.at(-1);
  if (file.toLowerCase().includes('ffmpeg') && candidate && candidate !== '-') {
    mkdirSync(join(candidate, '..'), { recursive: true });
    writeFileSync(candidate, Buffer.from('real-media-output'));
  }
  callback(null, '', '');
});
vi.mock('node:child_process', () => ({ execFile }));

const { HermesToolBridge } = await import('../src/main/services/hermesToolBridge.js');

describe('Hermes governed tool bridge', () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function create(
    policy = { permissionMode: 'autonomous', sandbox: 'workspace' },
    provider: { baseUrl: string; model: string; key: string } | null = null
  ) {
    const root = mkdtempSync(join(tmpdir(), 'hermes-tools-'));
    roots.push(root);
    return {
      root,
      bridge: new HermesToolBridge({
        getWorkspace: () => root,
        getPolicy: () => policy,
        browserManager: {} as never,
        getImageProvider: () => provider,
      })
    };
  }

  it('blocks browser writes without explicit owner confirmation', async () => {
    const { bridge } = create();
    await expect(bridge.execute('project-1', 'browser-click', { selector: '#submit' }))
      .rejects.toThrow(/ownerConfirmed/);
  });

  it('requires host sandbox for computer controls', async () => {
    const { bridge } = create();
    await expect(bridge.execute('project-1', 'computer-screenshot', {}))
      .rejects.toThrow(/主机/);
  });

  it('rejects media paths outside the project workspace', async () => {
    const { bridge, root } = create();
    const input = join(root, 'clip.mp4');
    writeFileSync(input, 'input');
    await expect(bridge.execute('project-1', 'video-trim', {
      inputPath: 'clip.mp4', outputPath: '../outside.mp4', ownerConfirmed: true
    })).rejects.toThrow(/工作目录/);
  });

  it('returns a real FFmpeg artifact with a digest', async () => {
    const { bridge, root } = create();
    writeFileSync(join(root, 'clip.mp4'), 'input');
    const result = await bridge.execute('project-1', 'video-trim', {
      inputPath: 'clip.mp4', outputPath: 'out/clip.mp4', ownerConfirmed: true
    });
    expect(result).toMatchObject({ path: 'out/clip.mp4', mediaType: 'video/mp4' });
    expect(String(result.sha256)).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(join(root, 'out/clip.mp4'))).toBe(true);
  });

  it('blocks image generation without explicit owner confirmation', async () => {
    const { bridge } = create({ permissionMode: 'autonomous', sandbox: 'workspace' }, {
      baseUrl: 'https://provider.example/v1', model: 'gpt-image-2', key: 'test-key'
    });
    await expect(bridge.execute('project-1', 'image-generate', { prompt: '产品白底主图' }))
      .rejects.toThrow(/ownerConfirmed/);
  });

  it('writes a real provider image response into the project with a digest', async () => {
    const { bridge, root } = create({ permissionMode: 'autonomous', sandbox: 'workspace' }, {
      baseUrl: 'https://provider.example/v1', model: 'gpt-image-2', key: 'test-key'
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://provider.example/v1/images/generations');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-key', 'content-type': 'application/json' });
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: 'gpt-image-2', prompt: '白底电商剃须刀主图', n: 1 });
      expect(body).not.toHaveProperty('response_format');
      const bytes = Buffer.from('real-image-bytes');
      const jsonBytes = Buffer.from(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] }));
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: null,
        arrayBuffer: async () => jsonBytes.buffer.slice(jsonBytes.byteOffset, jsonBytes.byteOffset + jsonBytes.byteLength),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await bridge.execute('project-1', 'image-generate', {
      prompt: '白底电商剃须刀主图', size: '1024x1024', ownerConfirmed: true,
      outputPath: 'deliverables/shaver-main.png'
    }) as { model: string; mode: string; images: Array<{ path: string; mediaType: string; sha256: string }> };
    expect(result).toMatchObject({ model: 'gpt-image-2', mode: 'text-to-image' });
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({ path: 'deliverables/shaver-main.png', mediaType: 'image/png' });
    expect(result.images[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(join(root, 'deliverables/shaver-main.png'))).toBe(true);
  });

  it('uses the provider edit endpoint for an image-to-image request', async () => {
    const { bridge, root } = create({ permissionMode: 'autonomous', sandbox: 'workspace' }, {
      baseUrl: 'https://provider.example/v1', model: 'gpt-image-2', key: 'test-key'
    });
    writeFileSync(join(root, 'reference.png'), 'reference-image');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://provider.example/v1/images/edits');
      expect(init?.method).toBe('POST');
      expect(init?.body).toBeInstanceOf(FormData);
      const bytes = Buffer.from('edited-image-bytes');
      const jsonBytes = Buffer.from(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] }));
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: null,
        arrayBuffer: async () => jsonBytes.buffer.slice(jsonBytes.byteOffset, jsonBytes.byteOffset + jsonBytes.byteLength),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await bridge.execute('project-1', 'image-generate', {
      prompt: '改成浴室场景并保留产品外形', imagePath: 'reference.png', ownerConfirmed: true
    }) as { mode: string; images: Array<{ path: string }> };
    expect(result.mode).toBe('image-to-image');
    expect(result.images).toHaveLength(1);
    expect(existsSync(join(root, result.images[0].path))).toBe(true);
  });
});
