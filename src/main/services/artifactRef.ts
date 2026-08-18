/**
 * Main-owned ArtifactRef storage and preview authorization.
 *
 * Artifact identity is content-addressed. Renderer receives only a short-lived
 * opaque URL; filesystem paths, roots and authorization state stay in Main.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { ArtifactKind, ArtifactRef } from '../../shared/types.js';

export const ARTIFACT_PROTOCOL_SCHEME = 'aibox-artifact' as const;
const SCHEME = `${ARTIFACT_PROTOCOL_SCHEME}:`;
const HOST = 'artifact';
const ID_PATTERN = /^artifact-(image|video|audio|mermaid|chart|markdown|file)-([a-f0-9]{64})$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_FILENAME_CHARS = 180;
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_GRANT_TTL_MS = 15 * 60_000;

const MIME_BY_KIND: Readonly<Record<ArtifactKind, ReadonlySet<string>>> = {
  image: new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  video: new Set(['video/mp4', 'video/webm']),
  audio: new Set(['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4']),
  mermaid: new Set(['text/vnd.mermaid']),
  chart: new Set(['application/vnd.aibox.chart+json', 'application/json']),
  markdown: new Set(['text/markdown']),
  file: new Set(['application/pdf', 'application/json', 'text/plain', 'text/csv', 'application/zip'])
};

const PREVIEWABLE_MIMES = new Set([
  ...MIME_BY_KIND.image,
  ...MIME_BY_KIND.video,
  ...MIME_BY_KIND.audio,
  ...MIME_BY_KIND.mermaid,
  ...MIME_BY_KIND.chart,
  ...MIME_BY_KIND.markdown,
  'application/pdf',
  'application/json',
  'text/plain',
  'text/csv'
]);

export interface ArtifactRefServiceOptions {
  root: string;
  now?: () => number;
  maxBytes?: number;
  grantTtlMs?: number;
  randomToken?: () => string;
  audit?: (event: ArtifactRefAuditEvent) => void;
}

export interface ArtifactRefAuditEvent {
  action: 'store' | 'authorize' | 'read' | 'revoke';
  result: 'ok' | 'denied' | 'failed';
  artifactId?: string;
  reason?: string;
}

export interface ArtifactPutInput {
  kind: ArtifactKind;
  mediaType: string;
  filename: string;
  data: Uint8Array;
}

export interface ResolvedArtifactPreview {
  data: Buffer;
  mediaType: string;
  filename: string;
  headers: Readonly<Record<string, string>>;
}

interface Grant {
  ref: ArtifactRef;
  expiresAt: number;
}

export type ArtifactRefErrorCode =
  | 'INVALID_ARTIFACT'
  | 'ARTIFACT_TOO_LARGE'
  | 'ARTIFACT_NOT_FOUND'
  | 'ARTIFACT_INTEGRITY_FAILED'
  | 'ARTIFACT_GRANT_INVALID'
  | 'ARTIFACT_GRANT_EXPIRED';

export class ArtifactRefError extends Error {
  constructor(readonly code: ArtifactRefErrorCode, message: string) {
    super(message);
    this.name = 'ArtifactRefError';
  }
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function sameAscii(left: string, right: string): boolean {
  const a = Buffer.from(left, 'ascii');
  const b = Buffer.from(right, 'ascii');
  return a.length === b.length && timingSafeEqual(a, b);
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ArtifactRefError('INVALID_ARTIFACT', `${label} is invalid`);
  }
  return value;
}

function safeFilename(value: unknown): string {
  const filename = boundedText(value, 'filename', MAX_FILENAME_CHARS);
  if (basename(filename) !== filename || filename === '.' || filename === '..') {
    throw new ArtifactRefError('INVALID_ARTIFACT', 'filename is invalid');
  }
  return filename;
}

function extensionFor(mediaType: string): string {
  switch (mediaType) {
    case 'image/png': return '.png';
    case 'image/jpeg': return '.jpg';
    case 'image/webp': return '.webp';
    case 'image/gif': return '.gif';
    case 'video/mp4': return '.mp4';
    case 'video/webm': return '.webm';
    case 'audio/mpeg': return '.mp3';
    case 'audio/wav': return '.wav';
    case 'audio/ogg': return '.ogg';
    case 'audio/mp4': return '.m4a';
    case 'text/vnd.mermaid': return '.mmd';
    case 'application/vnd.aibox.chart+json': return '.chart.json';
    case 'application/json': return '.json';
    case 'text/markdown': return '.md';
    case 'application/pdf': return '.pdf';
    case 'text/plain': return '.txt';
    case 'text/csv': return '.csv';
    case 'application/zip': return '.zip';
    default: return '.bin';
  }
}

function ascii(data: Uint8Array, start: number, length: number): string {
  return Buffer.from(data.slice(start, start + length)).toString('ascii');
}

function validMagic(data: Uint8Array, mediaType: string): boolean {
  if (mediaType === 'image/png') return data.length >= 8 && Buffer.from(data.slice(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mediaType === 'image/jpeg') return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (mediaType === 'image/gif') return ascii(data, 0, 6) === 'GIF87a' || ascii(data, 0, 6) === 'GIF89a';
  if (mediaType === 'image/webp') return ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 4) === 'WEBP';
  if (mediaType === 'video/mp4' || mediaType === 'audio/mp4') return data.length >= 12 && ascii(data, 4, 4) === 'ftyp';
  if (mediaType === 'video/webm') return data.length >= 4 && Buffer.from(data.slice(0, 4)).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mediaType === 'audio/mpeg') return data.length >= 3 && (ascii(data, 0, 3) === 'ID3' || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0));
  if (mediaType === 'audio/wav') return data.length >= 12 && ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 4) === 'WAVE';
  if (mediaType === 'audio/ogg') return data.length >= 4 && ascii(data, 0, 4) === 'OggS';
  if (mediaType === 'application/pdf') return data.length >= 5 && ascii(data, 0, 5) === '%PDF-';
  if (mediaType === 'application/zip') return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b
    && ((data[2] === 0x03 && data[3] === 0x04) || (data[2] === 0x05 && data[3] === 0x06));
  return true;
}

function validateStructuredText(kind: ArtifactKind, mediaType: string, data: Uint8Array): void {
  if (!['mermaid', 'chart', 'markdown'].includes(kind) && mediaType !== 'application/json') return;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new ArtifactRefError('INVALID_ARTIFACT', 'Artifact text is not valid UTF-8');
  }
  if (!text.trim()) throw new ArtifactRefError('INVALID_ARTIFACT', 'Artifact text is empty');
  if (kind === 'chart' || mediaType === 'application/json') {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed === null || typeof parsed !== 'object') throw new Error('not structured');
    } catch {
      throw new ArtifactRefError('INVALID_ARTIFACT', 'Chart/JSON artifact is invalid');
    }
  }
}

function validateKind(value: unknown): ArtifactKind {
  if (!['image', 'video', 'audio', 'mermaid', 'chart', 'markdown', 'file'].includes(String(value))) {
    throw new ArtifactRefError('INVALID_ARTIFACT', 'Artifact kind is invalid');
  }
  return value as ArtifactKind;
}

function parseRef(value: ArtifactRef): ArtifactRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ArtifactRefError('INVALID_ARTIFACT', 'ArtifactRef is invalid');
  const allowed = new Set(['schemaVersion', 'id', 'kind', 'mediaType', 'filename', 'bytes', 'sha256', 'createdAt', 'previewable', 'uri']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new ArtifactRefError('INVALID_ARTIFACT', 'ArtifactRef contains unsupported fields');
  const kind = validateKind(value.kind);
  const id = boundedText(value.id, 'id', 96);
  const hash = boundedText(value.sha256, 'sha256', 64).toLowerCase();
  const mediaType = boundedText(value.mediaType, 'mediaType', 96).toLowerCase();
  const filename = safeFilename(value.filename);
  const match = ID_PATTERN.exec(id);
  if (value.schemaVersion !== 1 || !match || match[1] !== kind || !HASH_PATTERN.test(hash) || !sameAscii(match[2], hash)
    || !MIME_BY_KIND[kind].has(mediaType) || !Number.isSafeInteger(value.bytes) || value.bytes < 1
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || typeof value.previewable !== 'boolean') {
    throw new ArtifactRefError('INVALID_ARTIFACT', 'ArtifactRef fields are invalid');
  }
  boundedText(value.uri, 'uri', 512);
  return { ...value, kind, id, sha256: hash, mediaType, filename };
}

export class ArtifactRefService {
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly grantTtlMs: number;
  private readonly randomToken: () => string;
  private readonly grants = new Map<string, Grant>();

  constructor(private readonly options: ArtifactRefServiceOptions) {
    if (!options.root || typeof options.root !== 'string') throw new Error('Artifact root is required');
    this.now = options.now ?? Date.now;
    this.maxBytes = Math.max(1, Math.min(1024 * 1024 * 1024, options.maxBytes ?? DEFAULT_MAX_BYTES));
    this.grantTtlMs = Math.max(1_000, Math.min(60 * 60_000, options.grantTtlMs ?? DEFAULT_GRANT_TTL_MS));
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString('base64url'));
    mkdirSync(options.root, { recursive: true });
  }

  put(input: ArtifactPutInput): ArtifactRef {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => !['kind', 'mediaType', 'filename', 'data'].includes(key))) {
      throw new ArtifactRefError('INVALID_ARTIFACT', 'Artifact input is invalid');
    }
    const kind = validateKind(input.kind);
    const mediaType = boundedText(input.mediaType, 'mediaType', 96).toLowerCase();
    const filename = safeFilename(input.filename);
    const data = input.data instanceof Uint8Array ? input.data : new Uint8Array(input.data);
    if (!MIME_BY_KIND[kind].has(mediaType)) throw new ArtifactRefError('INVALID_ARTIFACT', 'Media type does not match artifact kind');
    if (data.byteLength < 1 || data.byteLength > this.maxBytes) throw new ArtifactRefError('ARTIFACT_TOO_LARGE', 'Artifact exceeds the size limit');
    if (!validMagic(data, mediaType)) throw new ArtifactRefError('INVALID_ARTIFACT', 'Artifact bytes do not match the media type');
    validateStructuredText(kind, mediaType, data);
    const digest = sha256(data);
    const id = `artifact-${kind}-${digest}`;
    const target = this.storagePath(digest, mediaType);
    if (!existsSync(target)) {
      const temporary = join(this.options.root, `.artifact-${randomBytes(12).toString('hex')}.tmp`);
      writeFileSync(temporary, Buffer.from(data), { flag: 'wx' });
      try {
        renameSync(temporary, target);
      } catch (error) {
        try { unlinkSync(temporary); } catch { /* best effort */ }
        if (!existsSync(target)) throw error;
      }
    }
    const identity: ArtifactRef = {
      schemaVersion: 1,
      id,
      kind,
      mediaType,
      filename,
      bytes: data.byteLength,
      sha256: digest,
      createdAt: this.now(),
      previewable: PREVIEWABLE_MIMES.has(mediaType),
      uri: `${SCHEME}//${HOST}/pending`
    };
    this.audit({ action: 'store', result: 'ok', artifactId: id });
    return this.authorize(identity);
  }

  authorize(value: ArtifactRef): ArtifactRef {
    const ref = parseRef(value);
    this.verifyStored(ref);
    this.pruneExpired();
    const token = this.randomToken();
    if (!TOKEN_PATTERN.test(token) || this.grants.has(token)) throw new ArtifactRefError('ARTIFACT_GRANT_INVALID', 'Artifact grant token is invalid');
    const uri = `${SCHEME}//${HOST}/${encodeURIComponent(ref.id)}?grant=${encodeURIComponent(token)}`;
    const authorized = { ...ref, uri };
    this.grants.set(token, { ref: authorized, expiresAt: this.now() + this.grantTtlMs });
    this.audit({ action: 'authorize', result: 'ok', artifactId: ref.id });
    return authorized;
  }

  resolveAuthorizedUrl(rawUrl: string): ResolvedArtifactPreview {
    let parsed: URL;
    try { parsed = new URL(rawUrl); } catch { throw new ArtifactRefError('ARTIFACT_GRANT_INVALID', 'Artifact URL is invalid'); }
    const token = parsed.searchParams.get('grant') ?? '';
    const id = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    if (parsed.protocol !== SCHEME || parsed.hostname !== HOST || !ID_PATTERN.test(id) || !TOKEN_PATTERN.test(token)
      || [...parsed.searchParams.keys()].some((key) => key !== 'grant')) {
      this.audit({ action: 'read', result: 'denied', reason: 'invalid_url' });
      throw new ArtifactRefError('ARTIFACT_GRANT_INVALID', 'Artifact grant is invalid');
    }
    const grant = this.grants.get(token);
    if (!grant || grant.ref.id !== id) {
      this.audit({ action: 'read', result: 'denied', artifactId: id, reason: 'unknown_grant' });
      throw new ArtifactRefError('ARTIFACT_GRANT_INVALID', 'Artifact grant is invalid');
    }
    if (grant.expiresAt <= this.now()) {
      this.grants.delete(token);
      this.audit({ action: 'read', result: 'denied', artifactId: id, reason: 'expired' });
      throw new ArtifactRefError('ARTIFACT_GRANT_EXPIRED', 'Artifact grant has expired');
    }
    const data = this.verifyStored(grant.ref);
    this.audit({ action: 'read', result: 'ok', artifactId: id });
    return {
      data,
      mediaType: grant.ref.mediaType,
      filename: grant.ref.filename,
      headers: {
        'content-type': grant.ref.mediaType,
        'content-length': String(data.byteLength),
        'cache-control': 'private, no-store',
        'content-security-policy': "default-src 'none'; style-src 'none'; sandbox",
        'x-content-type-options': 'nosniff'
      }
    };
  }

  revoke(value: ArtifactRef | string): boolean {
    const rawUrl = typeof value === 'string' ? value : value.uri;
    let token = '';
    try { token = new URL(rawUrl).searchParams.get('grant') ?? ''; } catch { return false; }
    const grant = this.grants.get(token);
    if (!grant) return false;
    this.grants.delete(token);
    this.audit({ action: 'revoke', result: 'ok', artifactId: grant.ref.id });
    return true;
  }

  private verifyStored(ref: ArtifactRef): Buffer {
    const target = this.storagePath(ref.sha256, ref.mediaType);
    try {
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== ref.bytes || stat.size > this.maxBytes) throw new Error('invalid file');
      const data = readFileSync(target);
      if (!sameAscii(sha256(data), ref.sha256) || !validMagic(data, ref.mediaType)) throw new Error('integrity mismatch');
      return data;
    } catch (error) {
      const code = existsSync(target) ? 'ARTIFACT_INTEGRITY_FAILED' : 'ARTIFACT_NOT_FOUND';
      this.audit({ action: 'read', result: 'failed', artifactId: ref.id, reason: code });
      throw new ArtifactRefError(code, code === 'ARTIFACT_NOT_FOUND' ? 'Artifact is missing' : 'Artifact integrity check failed');
    }
  }

  private storagePath(hash: string, mediaType: string): string {
    if (!HASH_PATTERN.test(hash)) throw new ArtifactRefError('INVALID_ARTIFACT', 'Artifact hash is invalid');
    return join(this.options.root, `${hash}${extensionFor(mediaType)}`);
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [token, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(token);
  }

  private audit(event: ArtifactRefAuditEvent): void {
    try { this.options.audit?.(event); } catch { /* audit failures must not expose paths or corrupt storage */ }
  }
}

/** Renderer protocol allowlist entry; no http/file/data URL is accepted. */
export function isAuthorizedArtifactUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === SCHEME && parsed.hostname === HOST && ID_PATTERN.test(decodeURIComponent(parsed.pathname.replace(/^\//, '')))
      && TOKEN_PATTERN.test(parsed.searchParams.get('grant') ?? '') && [...parsed.searchParams.keys()].every((key) => key === 'grant');
  } catch {
    return false;
  }
}

/** Extension checks are intentionally not used as trust decisions. */
export function suggestedArtifactExtension(mediaType: string): string {
  return extensionFor(mediaType).replace(/^\./, '') || extname(mediaType);
}
