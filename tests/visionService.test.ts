import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validatePluginManifest } from '../src/main/services/pluginHost.js';
import {
  DSH_VISION_PLUGIN_MANIFEST,
  MAX_VISION_IMAGE_BYTES,
  MAX_VISION_RESPONSE_BYTES,
  VisionService,
  VisionServiceError,
  type VisionModelBinding,
  type VisionProviderResolution
} from '../src/main/services/visionService.js';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

function settings(initial: VisionModelBinding | null = null) {
  let value: unknown = initial;
  return {
    getSetting: vi.fn(<T>(_key: string, fallback: T) => (value === null ? fallback : value as T)),
    setSetting: vi.fn((_key: string, next: unknown) => { value = next; }),
    audit: vi.fn()
  };
}

function provider(overrides: Partial<VisionProviderResolution> = {}): VisionProviderResolution {
  return {
    providerId: 'provider-vision',
    model: 'vision-model',
    baseUrl: 'https://provider.example/v1',
    key: 'sk-provider-secret',
    ...overrides
  };
}

describe('VisionService', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function create(options: Partial<ConstructorParameters<typeof VisionService>[0]> = {}) {
    const root = mkdtempSync(join(tmpdir(), 'aibox-vision-'));
    roots.push(root);
    const store = options.settings ?? settings();
    const providers = options.providers ?? { resolveForAgentWithIdentity: vi.fn(() => provider()) };
    const service = new VisionService({ attachmentRoot: root, settings: store, providers, ...options });
    return { service, store, providers, root };
  }

  it('stores content-addressed attachments and rejects paths, spoofed MIME, and oversize input', async () => {
    const { service, root } = create();
    const ref = await service.putAttachment({ data: PNG, mimeType: 'image/png', filename: 'screen.png' });
    expect(ref.id).toMatch(/^vision-[a-f0-9]{64}$/);
    expect(ref.uri).toBe(`aibox-vision://attachment/${ref.id}`);
    expect(ref).not.toHaveProperty('path');
    expect(service.readAttachment(ref)).toEqual(Buffer.from(PNG));
    const stored = readFileSync(join(root, `${ref.sha256}.png`));
    expect(stored).toEqual(Buffer.from(PNG));

    await expect(service.putAttachment({ data: PNG, mimeType: 'image/jpeg' })).rejects.toMatchObject({ code: 'INVALID_ATTACHMENT' });
    await expect(service.putAttachment({ data: new Uint8Array(MAX_VISION_IMAGE_BYTES + 1), mimeType: 'image/png' })).rejects.toMatchObject({ code: 'INVALID_ATTACHMENT' });
    await expect(service.createToolHandler()({ attachmentRef: { path: 'C:\\secret.png' } }, {
      owner: 'dsh-cordis', pluginId: 'opc.dsh.vision', pluginVersion: '1.0.0',
      capabilityId: 'vision.describe', capabilityKind: 'tool', signal: new AbortController().signal
    })).rejects.toMatchObject({ code: 'INVALID_ATTACHMENT' });
  });

  it('verifies content integrity after an attachment file is tampered with', async () => {
    const { service, root } = create();
    const ref = await service.putAttachment({ data: PNG, mimeType: 'image/png' });
    writeFileSync(join(root, `${ref.sha256}.png`), Buffer.from('tampered')); 
    expect(() => service.readAttachment(ref)).toThrowError(new VisionServiceError('ATTACHMENT_NOT_FOUND', 'Attachment is missing or invalid'));
  });

  it('publishes a DSH-owned tool and proxies image content without exposing credentials', async () => {
    const store = settings();
    const upstream = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.headers).toMatchObject({ authorization: 'Bearer sk-provider-secret' });
      const body = JSON.parse(String(init.body)) as { model: string; messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }> };
      expect(body.model).toBe('vision-model');
      expect(body.messages[0]?.content.some((part) => part.type === 'image_url' && part.image_url?.url.startsWith('data:image/png;base64,'))).toBe(true);
      return new Response(JSON.stringify({ choices: [{ message: { content: '这是一张测试图片。' } }] }), { status: 200 });
    });
    const { service } = create({ settings: store, fetch: upstream as unknown as typeof fetch });
    const ref = await service.putAttachment({ data: PNG, mimeType: 'image/png' });
    service.configureBinding({ providerId: 'provider-vision', model: 'vision-model' });
    const result = await service.createToolHandler()({ attachmentRef: ref, prompt: '识别内容' }, {
      owner: 'dsh-cordis', pluginId: 'opc.dsh.vision', pluginVersion: '1.0.0',
      capabilityId: 'vision.describe', capabilityKind: 'tool', signal: new AbortController().signal
    });
    expect(result).toMatchObject({ ok: true, text: '这是一张测试图片。', providerId: 'provider-vision', model: 'vision-model' });
    expect(JSON.stringify(result)).not.toContain('sk-provider-secret');
    const manifest = validatePluginManifest(DSH_VISION_PLUGIN_MANIFEST);
    expect(manifest).toMatchObject({ owner: 'dsh-cordis' });
    expect(manifest.executionAdapter).toBeUndefined();
    expect(manifest.capabilities[0]).toMatchObject({ risk: 'write', permissions: ['artifact.read', 'engine.use', 'network.request'] });
    expect(manifest.capabilities[1]).toMatchObject({ id: 'vision.ocr', risk: 'safe', permissions: ['artifact.read'] });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('runs local OCR through the same content-addressed attachment boundary', async () => {
    const { service } = create();
    const ref = await service.putAttachment({ data: PNG, mimeType: 'image/png', filename: 'screen.png' });
    const recognizeBytes = vi.fn(async () => ({
      ok: true,
      text: '订单 123',
      boxes: [],
      elapsed: 7
    }));
    const handler = service.createOcrToolHandler({ recognizeBytes });
    const context = {
      owner: 'dsh-cordis' as const,
      pluginId: 'opc.dsh.vision',
      pluginVersion: '1.0.0',
      capabilityId: 'vision.ocr',
      capabilityKind: 'tool' as const,
      signal: new AbortController().signal
    };

    await expect(handler({ attachmentRef: ref }, context)).resolves.toMatchObject({
      ok: true,
      text: '订单 123',
      attachmentId: ref.id
    });
    expect(recognizeBytes).toHaveBeenCalledWith(Buffer.from(PNG));
    await expect(handler({ attachmentRef: ref, path: 'C:\\secret.png' }, context)).rejects.toMatchObject({
      code: 'INVALID_ATTACHMENT'
    });
  });

  it('fails closed for disabled/unconfigured bindings and malformed upstream responses', async () => {
    const { service } = create({ fetch: vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch });
    const ref = await service.putAttachment({ data: PNG, mimeType: 'image/png' });
    await expect(service.describe({ attachmentRef: ref })).rejects.toMatchObject({ code: 'VISION_NOT_CONFIGURED' });
    service.configureBinding({ providerId: 'provider-vision', model: 'vision-model', enabled: false });
    await expect(service.describe({ attachmentRef: ref })).rejects.toMatchObject({ code: 'VISION_NOT_CONFIGURED' });

    const active = create({ fetch: vi.fn(async () => new Response('not json', { status: 200 })) as unknown as typeof fetch });
    const activeRef = await active.service.putAttachment({ data: PNG, mimeType: 'image/png' });
    active.service.configureBinding({ providerId: 'provider-vision', model: 'vision-model' });
    await expect(active.service.describe({ attachmentRef: activeRef })).rejects.toMatchObject({ code: 'VISION_RESPONSE_INVALID' });

    const oversized = create({
      fetch: vi.fn(async () => new Response(new Uint8Array(MAX_VISION_RESPONSE_BYTES + 1), { status: 200 })) as unknown as typeof fetch
    });
    const oversizedRef = await oversized.service.putAttachment({ data: PNG, mimeType: 'image/png' });
    oversized.service.configureBinding({ providerId: 'provider-vision', model: 'vision-model' });
    await expect(oversized.service.describe({ attachmentRef: oversizedRef })).rejects.toMatchObject({ code: 'VISION_RESPONSE_INVALID' });
  });
});
