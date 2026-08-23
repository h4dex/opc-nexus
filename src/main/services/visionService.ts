/**
 * Main-process vision proxy for the Nexus vision tool.
 *
 * The service deliberately accepts content-addressed attachment references,
 * never arbitrary renderer paths or data URLs. Provider credentials are
 * resolved through the injected Main-process provider boundary and are never
 * returned from this module. Hermes owns the tool/orchestration contract;
 * The native host only stores attachments, applies limits, and proxies the model call.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { basename, extname, join } from 'node:path';
import { providerResourceUrl } from './providerEndpoint.js';
import type {
  PluginCapabilityHandler,
  PluginInvocationContext,
  PluginManifest
} from './pluginHost.js';

export const VISION_PLUGIN_ID = 'opc.nexus.vision';
export const VISION_TOOL_CAPABILITY_ID = 'vision.describe';
export const VISION_OCR_TOOL_CAPABILITY_ID = 'vision.ocr';
export const VISION_MODEL_BINDING_SETTING = 'vision:model-binding';

/** Keep the encoded request below the Provider Credential Proxy's 10 MiB cap. */
export const MAX_VISION_IMAGE_BYTES = 6 * 1024 * 1024;
export const MAX_VISION_REQUEST_BYTES = 9 * 1024 * 1024;
export const MAX_VISION_PROMPT_CHARS = 16_000;
export const MAX_VISION_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_VISION_PIXELS = 40_000_000;
export const VISION_REQUEST_TIMEOUT_MS = 120_000;

const SAFE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const ID_PATTERN = /^vision-[a-f0-9]{64}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MODEL_PATTERN = /^[^\u0000-\u001f\u007f]{1,256}$/;

export interface VisionAttachmentRef {
  id: string;
  sha256: string;
  bytes: number;
  mimeType: string;
  filename: string;
  /** An opaque app URI; it never contains a host filesystem path. */
  uri: string;
}

export interface VisionModelBinding {
  providerId: string;
  model: string;
  enabled: boolean;
  updatedAt: number;
}

export interface VisionModelBindingView extends VisionModelBinding {
  configured: boolean;
  supportsImages: true;
}

export interface VisionProviderResolution {
  providerId: string;
  model: string;
  baseUrl: string;
  key: string;
}

export interface VisionProviderResolver {
  resolveForAgentWithIdentity(
    providerId: string | null,
    modelOverride: string | null
  ): VisionProviderResolution | null;
}

export interface VisionSettingsStore {
  getSetting<T>(key: string, fallback: T): T;
  setSetting(key: string, value: unknown): void;
  audit?(entry: unknown): void;
}

export interface VisionImageInspector {
  inspect(data: Uint8Array, mimeType: string): Promise<{ width?: number; height?: number }> | { width?: number; height?: number };
}

export interface VisionServiceOptions {
  /** Must be an application-owned directory, never a renderer supplied path. */
  attachmentRoot: string;
  settings: VisionSettingsStore;
  providers: VisionProviderResolver;
  fetch?: typeof fetch;
  now?: () => number;
  imageInspector?: VisionImageInspector;
  requestTimeoutMs?: number;
  audit?: (event: VisionAuditEvent) => void;
}

export interface VisionAuditEvent {
  action: 'attachment.store' | 'attachment.read' | 'attachment.delete' | 'binding.update' | 'describe' | 'ocr';
  result: 'ok' | 'denied' | 'failed';
  attachmentId?: string;
  providerId?: string;
  model?: string;
  reason?: string;
}

export interface VisionDescribeInput {
  attachmentRef: VisionAttachmentRef;
  prompt?: string;
  signal?: AbortSignal;
}

export interface VisionDescribeResult {
  ok: boolean;
  text: string;
  attachmentId: string;
  providerId: string;
  model: string;
  error?: string;
}

export interface VisionOcrRuntime {
  recognizeBytes(imageData: Uint8Array): Promise<{
    ok: boolean;
    text: string;
    boxes: Array<{ box: [number, number][]; text: string; confidence: number }>;
    elapsed: number;
    error?: string;
  }>;
}

export type VisionServiceErrorCode =
  | 'INVALID_ATTACHMENT'
  | 'ATTACHMENT_NOT_FOUND'
  | 'ATTACHMENT_LIMIT'
  | 'VISION_NOT_CONFIGURED'
  | 'VISION_PROVIDER_UNAVAILABLE'
  | 'VISION_REQUEST_TOO_LARGE'
  | 'VISION_UPSTREAM_FAILED'
  | 'VISION_RESPONSE_INVALID';

export class VisionServiceError extends Error {
  constructor(readonly code: VisionServiceErrorCode, message: string) {
    super(message);
    this.name = 'VisionServiceError';
  }
}

/** Nexus owns this built-in capability; Main only supplies a safe proxy. */
export const NEXUS_VISION_PLUGIN_MANIFEST: PluginManifest = {
  schemaVersion: 1,
  id: VISION_PLUGIN_ID,
  name: 'Nexus Vision Tool',
  version: '1.0.0',
  owner: 'nexus-governance',
  capabilities: [{
    id: VISION_TOOL_CAPABILITY_ID,
    kind: 'tool',
    version: '1.0.0',
    owner: 'nexus-governance',
    toolName: VISION_TOOL_CAPABILITY_ID,
    // The model call sends attachment bytes to the configured Provider.
    risk: 'write',
    permissions: ['artifact.read', 'engine.use', 'network.request'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['attachmentRef'],
      properties: {
        attachmentRef: { type: 'object' },
        prompt: { type: 'string', maxLength: MAX_VISION_PROMPT_CHARS }
      }
    }
  }, {
    id: VISION_OCR_TOOL_CAPABILITY_ID,
    kind: 'tool',
    version: '1.0.0',
    owner: 'nexus-governance',
    toolName: VISION_OCR_TOOL_CAPABILITY_ID,
    risk: 'safe',
    permissions: ['artifact.read'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['attachmentRef'],
      properties: { attachmentRef: { type: 'object' } }
    }
  }],
  permissions: ['artifact.read', 'engine.use', 'network.request']
};

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new VisionServiceError('INVALID_ATTACHMENT', `${label} is invalid`);
  }
  return value;
}

function boundedPrompt(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_VISION_PROMPT_CHARS
    || /[\u0000-\u001f\u007f]/.test(value) || value.trim().length === 0) {
    throw new VisionServiceError('INVALID_ATTACHMENT', 'prompt is invalid');
  }
  return value;
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, 'ascii');
  const b = Buffer.from(right, 'ascii');
  return a.length === b.length && timingSafeEqual(a, b);
}

function extensionForMime(mimeType: string): string {
  switch (mimeType) {
    case 'image/png': return '.png';
    case 'image/jpeg': return '.jpg';
    case 'image/webp': return '.webp';
    case 'image/gif': return '.gif';
    default: return '.img';
  }
}

function hasMagic(data: Uint8Array, mimeType: string): boolean {
  const ascii = (start: number, length: number): string => Buffer.from(data.slice(start, start + length)).toString('ascii');
  if (mimeType === 'image/png') {
    return data.length >= 8 && Buffer.from(data.slice(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (mimeType === 'image/jpeg') return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (mimeType === 'image/gif') return ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a';
  if (mimeType === 'image/webp') return ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP';
  return false;
}

function safeFilename(value: unknown, mimeType: string): string {
  if (value === undefined || value === null || value === '') return `image${extensionForMime(mimeType)}`;
  if (typeof value !== 'string' || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new VisionServiceError('INVALID_ATTACHMENT', 'filename is invalid');
  }
  const name = basename(value).trim();
  if (!name || name === '.' || name === '..' || name !== value.trim()) {
    throw new VisionServiceError('INVALID_ATTACHMENT', 'filename is invalid');
  }
  const extension = extname(name).toLowerCase();
  const allowed = extension === extensionForMime(mimeType) || (mimeType === 'image/jpeg' && extension === '.jpeg');
  return allowed ? name : `${name}${extensionForMime(mimeType)}`;
}

function parseAttachmentRef(value: unknown): VisionAttachmentRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new VisionServiceError('INVALID_ATTACHMENT', 'attachmentRef must be an object');
  }
  const input = value as Record<string, unknown>;
  const allowedKeys = new Set(['id', 'sha256', 'bytes', 'mimeType', 'filename', 'uri']);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw new VisionServiceError('INVALID_ATTACHMENT', 'attachmentRef contains unsupported fields');
  }
  const id = boundedText(input.id, 'attachmentRef.id', 80);
  const hash = boundedText(input.sha256, 'attachmentRef.sha256', 64).toLowerCase();
  const mimeType = boundedText(input.mimeType, 'attachmentRef.mimeType', 64).toLowerCase();
  const filename = boundedText(input.filename, 'attachmentRef.filename', 160);
  if (!ID_PATTERN.test(id) || !HASH_PATTERN.test(hash) || !SAFE_MIME_TYPES.has(mimeType)
    || !Number.isSafeInteger(input.bytes) || Number(input.bytes) < 1 || Number(input.bytes) > MAX_VISION_IMAGE_BYTES) {
    throw new VisionServiceError('INVALID_ATTACHMENT', 'attachmentRef fields are invalid');
  }
  const uri = input.uri === undefined ? `aibox-vision://attachment/${id}` : boundedText(input.uri, 'attachmentRef.uri', 128);
  if (uri !== `aibox-vision://attachment/${id}`) throw new VisionServiceError('INVALID_ATTACHMENT', 'attachmentRef.uri is invalid');
  return { id, sha256: hash, bytes: Number(input.bytes), mimeType, filename, uri };
}

function parseBinding(value: unknown): VisionModelBinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.providerId !== 'string' || !input.providerId.trim() || !MODEL_PATTERN.test(String(input.model ?? ''))) return null;
  if (typeof input.enabled !== 'boolean') return null;
  const updatedAt = Number(input.updatedAt);
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) return null;
  return { providerId: input.providerId.trim(), model: String(input.model), enabled: input.enabled, updatedAt };
}

function extractText(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') return '';
  const message = (choices[0] as Record<string, unknown>).message;
  if (!message || typeof message !== 'object') return '';
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (!part || typeof part !== 'object') return '';
    const text = (part as Record<string, unknown>).text;
    return typeof text === 'string' ? text : '';
  }).join('').trim();
}

function abortableSignal(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Vision request timed out')), timeoutMs);
  timer.unref?.();
  const abort = () => controller.abort(signal?.reason ?? new Error('Vision request aborted'));
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
}

async function readBoundedResponse(response: Response, maximum: number): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    throw new VisionServiceError('VISION_RESPONSE_INVALID', 'Vision response is too large');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximum) {
        await reader.cancel('Vision response exceeded the size limit');
        throw new VisionServiceError('VISION_RESPONSE_INVALID', 'Vision response is too large');
      }
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    reader.releaseLock();
  }
}

export class VisionService {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly attachmentRoot: string;

  constructor(private readonly options: VisionServiceOptions) {
    if (!options.attachmentRoot || typeof options.attachmentRoot !== 'string') throw new Error('Vision attachment root is required');
    this.attachmentRoot = options.attachmentRoot;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = Math.max(1_000, Math.min(600_000, options.requestTimeoutMs ?? VISION_REQUEST_TIMEOUT_MS));
    mkdirSync(this.attachmentRoot, { recursive: true });
  }

  getBinding(): VisionModelBindingView | null {
    const binding = parseBinding(this.options.settings.getSetting<unknown>(VISION_MODEL_BINDING_SETTING, null));
    if (!binding) return null;
    return { ...binding, configured: true, supportsImages: true };
  }

  configureBinding(input: { providerId: string; model: string; enabled?: boolean }): VisionModelBindingView {
    const providerId = boundedText(input.providerId, 'providerId', 128);
    const model = boundedText(input.model, 'model', 256);
    if (!MODEL_PATTERN.test(model)) throw new VisionServiceError('VISION_PROVIDER_UNAVAILABLE', 'model is invalid');
    const resolved = this.options.providers.resolveForAgentWithIdentity(providerId, model);
    // A binding is only persisted when the selected Provider is currently
    // usable. This avoids storing a route that silently points at another
    // credential or an unknown Provider.
    if (!resolved || resolved.providerId !== providerId || resolved.model !== model || !resolved.key) {
      throw new VisionServiceError('VISION_PROVIDER_UNAVAILABLE', 'Provider model binding mismatch');
    }
    const binding: VisionModelBinding = {
      providerId,
      model,
      enabled: input.enabled !== false,
      updatedAt: this.now()
    };
    this.options.settings.setSetting(VISION_MODEL_BINDING_SETTING, binding);
    this.audit({ action: 'binding.update', result: 'ok', providerId, model });
    return { ...binding, configured: true, supportsImages: true };
  }

  clearBinding(): void {
    this.options.settings.setSetting(VISION_MODEL_BINDING_SETTING, null);
    this.audit({ action: 'binding.update', result: 'ok', reason: 'cleared' });
  }

  async putAttachment(input: { data: Uint8Array; mimeType: string; filename?: string }): Promise<VisionAttachmentRef> {
    const data = input.data instanceof Uint8Array ? input.data : new Uint8Array(input.data);
    const mimeType = boundedText(input.mimeType, 'mimeType', 64).toLowerCase();
    if (!SAFE_MIME_TYPES.has(mimeType) || !hasMagic(data, mimeType)) {
      throw new VisionServiceError('INVALID_ATTACHMENT', 'Unsupported or invalid image bytes');
    }
    if (data.length === 0 || data.length > MAX_VISION_IMAGE_BYTES) {
      throw new VisionServiceError('ATTACHMENT_LIMIT', 'Image exceeds the size limit');
    }
    if (this.options.imageInspector) {
      const dimensions = await this.options.imageInspector.inspect(data, mimeType);
      if (dimensions.width !== undefined && dimensions.height !== undefined
        && (!Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height)
          || dimensions.width < 1 || dimensions.height < 1 || dimensions.width * dimensions.height > MAX_VISION_PIXELS)) {
        throw new VisionServiceError('ATTACHMENT_LIMIT', 'Image exceeds the pixel limit');
      }
    }
    const digest = sha256(data);
    const id = `vision-${digest}`;
    const filename = safeFilename(input.filename, mimeType);
    const target = join(this.attachmentRoot, `${digest}${extensionForMime(mimeType)}`);
    if (!existsSync(target)) {
      const temporary = join(this.attachmentRoot, `.upload-${randomUUID()}.tmp`);
      writeFileSync(temporary, Buffer.from(data), { flag: 'wx' });
      try { renameSync(temporary, target); } catch (error) {
        try { unlinkSync(temporary); } catch { /* best effort */ }
        if (!existsSync(target)) throw error;
      }
    }
    const ref: VisionAttachmentRef = { id, sha256: digest, bytes: data.length, mimeType, filename, uri: `aibox-vision://attachment/${id}` };
    this.audit({ action: 'attachment.store', result: 'ok', attachmentId: id });
    return ref;
  }

  readAttachment(input: VisionAttachmentRef): Buffer {
    const ref = parseAttachmentRef(input);
    if (!sameHash(ref.id.slice('vision-'.length), ref.sha256)) {
      throw new VisionServiceError('INVALID_ATTACHMENT', 'Attachment id/hash mismatch');
    }
    const target = join(this.attachmentRoot, `${ref.sha256}${extensionForMime(ref.mimeType)}`);
    try {
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.size !== ref.bytes || stat.size > MAX_VISION_IMAGE_BYTES) throw new Error('invalid attachment file');
      const data = readFileSync(target);
      if (data.length !== ref.bytes || !sameHash(sha256(data), ref.sha256) || !hasMagic(data, ref.mimeType)) throw new Error('attachment integrity mismatch');
      this.audit({ action: 'attachment.read', result: 'ok', attachmentId: ref.id });
      return data;
    } catch {
      this.audit({ action: 'attachment.read', result: 'failed', attachmentId: ref.id, reason: 'not_found_or_invalid' });
      throw new VisionServiceError('ATTACHMENT_NOT_FOUND', 'Attachment is missing or invalid');
    }
  }

  deleteAttachment(input: VisionAttachmentRef): boolean {
    const ref = parseAttachmentRef(input);
    const target = join(this.attachmentRoot, `${ref.sha256}${extensionForMime(ref.mimeType)}`);
    try { unlinkSync(target); this.audit({ action: 'attachment.delete', result: 'ok', attachmentId: ref.id }); return true; }
    catch { return false; }
  }

  async describe(input: VisionDescribeInput): Promise<VisionDescribeResult> {
    const ref = parseAttachmentRef(input.attachmentRef);
    const prompt = input.prompt === undefined ? '请描述这张图片中的主要内容，并指出需要注意的文字或视觉信息。' : boundedPrompt(input.prompt);
    const binding = this.getBinding();
    if (!binding || !binding.enabled) {
      this.audit({ action: 'describe', result: 'denied', attachmentId: ref.id, reason: 'not_configured' });
      throw new VisionServiceError('VISION_NOT_CONFIGURED', 'Vision model is not configured');
    }
    const provider = this.options.providers.resolveForAgentWithIdentity(binding.providerId, binding.model);
    if (!provider || provider.providerId !== binding.providerId || provider.model !== binding.model || !provider.key) {
      this.audit({ action: 'describe', result: 'denied', attachmentId: ref.id, providerId: binding.providerId, model: binding.model, reason: 'provider_unavailable' });
      throw new VisionServiceError('VISION_PROVIDER_UNAVAILABLE', 'Vision Provider is unavailable');
    }
    const image = this.readAttachment(ref);
    const payload = {
      model: binding.model,
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${ref.mimeType};base64,${image.toString('base64')}`, detail: 'auto' } }
      ] }],
      max_tokens: 1_024,
      stream: false
    };
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body, 'utf8') > MAX_VISION_REQUEST_BYTES) {
      this.audit({ action: 'describe', result: 'denied', attachmentId: ref.id, providerId: binding.providerId, model: binding.model, reason: 'request_too_large' });
      throw new VisionServiceError('VISION_REQUEST_TOO_LARGE', 'Vision request exceeds the provider proxy limit');
    }
    const request = abortableSignal(input.signal, this.timeoutMs);
    try {
      const response = await this.fetchImpl(providerResourceUrl(provider.baseUrl, 'chat/completions'), {
        method: 'POST',
        headers: { authorization: `Bearer ${provider.key}`, 'content-type': 'application/json', accept: 'application/json' },
        body,
        redirect: 'error',
        signal: request.signal
      });
      const bytes = await readBoundedResponse(response, MAX_VISION_RESPONSE_BYTES);
      if (!response.ok) {
        this.audit({ action: 'describe', result: 'failed', attachmentId: ref.id, providerId: binding.providerId, model: binding.model, reason: `http_${response.status}` });
        throw new VisionServiceError('VISION_UPSTREAM_FAILED', `Vision Provider returned HTTP ${response.status}`);
      }
      let parsed: unknown;
      try { parsed = JSON.parse(bytes.toString('utf8')) as unknown; } catch { throw new VisionServiceError('VISION_RESPONSE_INVALID', 'Vision response is not valid JSON'); }
      const text = extractText(parsed);
      if (!text) throw new VisionServiceError('VISION_RESPONSE_INVALID', 'Vision response did not contain text');
      this.audit({ action: 'describe', result: 'ok', attachmentId: ref.id, providerId: binding.providerId, model: binding.model });
      return { ok: true, text, attachmentId: ref.id, providerId: binding.providerId, model: binding.model };
    } catch (error) {
      if (error instanceof VisionServiceError) throw error;
      throw new VisionServiceError('VISION_UPSTREAM_FAILED', error instanceof Error ? error.message : 'Vision request failed');
    } finally {
      request.dispose();
    }
  }

  /** Attach the Nexus tool to a PluginHost without exposing a path or secret. */
  createToolHandler(): PluginCapabilityHandler {
    return async (input: unknown, context: Readonly<PluginInvocationContext>) => {
      if (context.owner !== 'nexus-governance' || context.capabilityId !== VISION_TOOL_CAPABILITY_ID) {
        throw new VisionServiceError('VISION_PROVIDER_UNAVAILABLE', 'Vision tool ownership is invalid');
      }
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new VisionServiceError('INVALID_ATTACHMENT', 'Vision tool input is invalid');
      const value = input as Record<string, unknown>;
      if ('path' in value || 'data' in value || 'url' in value) throw new VisionServiceError('INVALID_ATTACHMENT', 'Vision tool accepts attachmentRef only');
      return this.describe({ attachmentRef: value.attachmentRef as VisionAttachmentRef, prompt: value.prompt as string | undefined, signal: context.signal });
    };
  }

  /** Local OCR shares the exact attachment identity and integrity boundary. */
  createOcrToolHandler(runtime: VisionOcrRuntime): PluginCapabilityHandler {
    return async (input: unknown, context: Readonly<PluginInvocationContext>) => {
      if (context.owner !== 'nexus-governance' || context.capabilityId !== VISION_OCR_TOOL_CAPABILITY_ID) {
        throw new VisionServiceError('VISION_PROVIDER_UNAVAILABLE', 'OCR tool ownership is invalid');
      }
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new VisionServiceError('INVALID_ATTACHMENT', 'OCR tool input is invalid');
      }
      const value = input as Record<string, unknown>;
      if (Object.keys(value).some((key) => key !== 'attachmentRef')) {
        throw new VisionServiceError('INVALID_ATTACHMENT', 'OCR tool accepts attachmentRef only');
      }
      const ref = parseAttachmentRef(value.attachmentRef);
      const result = await runtime.recognizeBytes(this.readAttachment(ref));
      this.audit({
        action: 'ocr',
        result: result.ok ? 'ok' : 'failed',
        attachmentId: ref.id,
        ...(result.error ? { reason: result.error.slice(0, 160) } : {})
      });
      return { ...result, attachmentId: ref.id };
    };
  }

  private audit(event: VisionAuditEvent): void {
    try { this.options.audit?.(event); } catch { /* audit must not leak data or break the request */ }
    try { this.options.settings.audit?.({ id: randomUUID(), actor: 'system', action: `vision.${event.action}`, target: event.attachmentId ?? event.providerId ?? 'vision', result: event.result }); } catch { /* best effort */ }
  }
}

/** Keep the plugin handler export easy to inject in bootstrap code. */
export function createHostVisionToolHandler(service: VisionService): PluginCapabilityHandler {
  return service.createToolHandler();
}
