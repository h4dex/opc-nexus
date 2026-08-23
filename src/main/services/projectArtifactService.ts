import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync
} from 'node:fs';
import type { Stats } from 'node:fs';
import { Readable } from 'node:stream';
import {
  extname,
  isAbsolute,
  relative,
  resolve,
  sep
} from 'node:path';
import type {
  ProjectArtifactDirectoryView,
  ProjectArtifactEntryView,
  ProjectArtifactPreviewKind,
  ProjectArtifactPreviewView
} from '../../shared/types.js';

export const PROJECT_ARTIFACT_PROTOCOL_SCHEME = 'aibox-project' as const;
const PROTOCOL = `${PROJECT_ARTIFACT_PROTOCOL_SCHEME}:`;
const HOST = 'preview';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_DIRECTORY_ENTRIES = 500;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 128 * 1024 * 1024;
const DEFAULT_GRANT_TTL_MS = 15 * 60_000;

const TEXT_EXTENSIONS = new Set([
  '.txt', '.log', '.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml', '.xml',
  '.css', '.scss', '.less', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx',
  '.py', '.go', '.rs', '.java', '.c', '.cc', '.cpp', '.h', '.hpp', '.sql',
  '.toml', '.ini', '.env', '.sh', '.ps1', '.bat', '.cmd'
]);

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mdx': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

interface PreviewGrant {
  projectId: string;
  root: string;
  realRoot: string;
  expiresAt: number;
}

export interface ProjectArtifactServiceOptions {
  getProjectRoot: (projectId: string) => string | null;
  now?: () => number;
  randomToken?: () => string;
  grantTtlMs?: number;
  audit?: (event: { action: 'list' | 'preview' | 'read' | 'reveal'; projectId: string; result: string }) => void;
}

export interface ResolvedProjectArtifact {
  /** Open descriptor for the validated file. Callers stream from it instead of
   * receiving a Buffer: the protocol handler runs on the main thread, where
   * reading a large artifact whole would freeze every window. Streaming from the
   * descriptor rather than re-opening by path also removes the window in which a
   * validated file could be swapped. The caller owns the descriptor and must
   * either stream it with autoClose or close it on an error path. */
  fd: number;
  size: number;
  headers: Readonly<Record<string, string>>;
}

export class ProjectArtifactError extends Error {
  constructor(
    readonly code: 'WORKSPACE_REQUIRED' | 'INVALID_PATH' | 'NOT_FOUND' | 'NOT_PREVIEWABLE' | 'TOO_LARGE' | 'GRANT_INVALID' | 'GRANT_EXPIRED',
    message: string
  ) {
    super(message);
    this.name = 'ProjectArtifactError';
  }
}

function within(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function normalizedRelativePath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4_096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ProjectArtifactError('INVALID_PATH', '项目产物路径无效');
  }
  if (!value) return '';
  if (isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new ProjectArtifactError('INVALID_PATH', '项目产物路径必须位于项目目录内');
  }
  const parts = value.split(/[\\/]+/);
  if (parts.length > 128 || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new ProjectArtifactError('INVALID_PATH', '项目产物路径无效');
  }
  return parts.join('/');
}

export function projectArtifactPreviewKind(name: string): ProjectArtifactPreviewKind {
  const extension = extname(name).toLowerCase();
  if (extension === '.html' || extension === '.htm') return 'html';
  if (extension === '.md' || extension === '.mdx' || extension === '.mmd' || extension === '.mermaid') return 'markdown';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico'].includes(extension)) return 'image';
  if (['.mp4', '.webm'].includes(extension)) return 'video';
  if (['.mp3', '.wav', '.ogg', '.m4a'].includes(extension)) return 'audio';
  if (extension === '.pdf') return 'pdf';
  if (TEXT_EXTENSIONS.has(extension)) return 'text';
  return 'unsupported';
}

export function projectArtifactMediaType(name: string): string {
  return MIME_BY_EXTENSION[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

export class ProjectArtifactService {
  private readonly now: () => number;
  private readonly randomToken: () => string;
  private readonly grantTtlMs: number;
  private readonly grants = new Map<string, PreviewGrant>();

  constructor(private readonly options: ProjectArtifactServiceOptions) {
    this.now = options.now ?? Date.now;
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString('base64url'));
    this.grantTtlMs = Math.max(1_000, Math.min(60 * 60_000, options.grantTtlMs ?? DEFAULT_GRANT_TTL_MS));
  }

  list(projectId: string, relativeDirectory = ''): ProjectArtifactDirectoryView {
    const rootValue = this.options.getProjectRoot(projectId);
    if (!rootValue) {
      return {
        projectId,
        workspaceConfigured: false,
        relativeDirectory: '',
        parentDirectory: null,
        entries: [],
        truncated: false
      };
    }
    const directory = normalizedRelativePath(relativeDirectory);
    const root = this.resolveRoot(rootValue);
    const target = this.resolveExisting(root.path, root.realPath, directory, 'directory');
    const all = readdirSync(target.path, { withFileTypes: true });
    const entries: ProjectArtifactEntryView[] = [];
    for (const item of all) {
      if (entries.length >= MAX_DIRECTORY_ENTRIES) break;
      if (item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())) continue;
      const relativePath = directory ? `${directory}/${item.name}` : item.name;
      try {
        const resolved = this.resolveExisting(root.path, root.realPath, relativePath, item.isDirectory() ? 'directory' : 'file');
        entries.push(this.entry(relativePath, item.name, item.isDirectory() ? 'directory' : 'file', resolved.stat.size, resolved.stat.mtimeMs));
      } catch {
        // Raced or escaped entries are omitted from the renderer projection.
      }
    }
    entries.sort((left, right) => Number(right.kind === 'directory') - Number(left.kind === 'directory')
      || left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
    this.audit('list', projectId, 'ok');
    const parts = directory ? directory.split('/') : [];
    return {
      projectId,
      workspaceConfigured: true,
      relativeDirectory: directory,
      parentDirectory: parts.length > 0 ? parts.slice(0, -1).join('/') : null,
      entries,
      truncated: all.length > entries.length
    };
  }

  preview(projectId: string, relativePath: string): ProjectArtifactPreviewView {
    const rootValue = this.options.getProjectRoot(projectId);
    if (!rootValue) throw new ProjectArtifactError('WORKSPACE_REQUIRED', '请先选择项目目录');
    const normalized = normalizedRelativePath(relativePath);
    if (!normalized) throw new ProjectArtifactError('INVALID_PATH', '请选择要预览的项目产物');
    const root = this.resolveRoot(rootValue);
    const resolved = this.resolveExisting(root.path, root.realPath, normalized, 'file');
    const name = normalized.split('/').at(-1) ?? normalized;
    const entry = this.entry(normalized, name, 'file', resolved.stat.size, resolved.stat.mtimeMs);
    if (!entry.previewable) throw new ProjectArtifactError('NOT_PREVIEWABLE', '该文件类型暂不支持内嵌预览');
    if (entry.previewKind === 'markdown' || entry.previewKind === 'text') {
      if (resolved.stat.size > MAX_TEXT_BYTES) throw new ProjectArtifactError('TOO_LARGE', '文本文件超过 2 MB，无法内嵌预览');
      const text = this.readUtf8(resolved.path);
      this.audit('preview', projectId, 'text');
      return { entry, uri: null, text, truncated: false };
    }
    if (entry.previewKind === 'html') {
      if (resolved.stat.size > MAX_TEXT_BYTES) throw new ProjectArtifactError('TOO_LARGE', 'HTML 文件超过 2 MB，无法内嵌预览');
      const text = this.readUtf8(resolved.path);
      const token = this.issueGrant(projectId, root.path, root.realPath);
      const encodedPath = normalized.split('/').map(encodeURIComponent).join('/');
      this.audit('preview', projectId, 'html');
      return {
        entry,
        uri: `${PROTOCOL}//${HOST}/${token}/${encodedPath}`,
        text,
        truncated: false
      };
    }
    if (resolved.stat.size > MAX_PREVIEW_BYTES) throw new ProjectArtifactError('TOO_LARGE', '文件超过 128 MB，无法内嵌预览');
    const token = this.issueGrant(projectId, root.path, root.realPath);
    const encodedPath = normalized.split('/').map(encodeURIComponent).join('/');
    this.audit('preview', projectId, entry.previewKind);
    return {
      entry,
      uri: `${PROTOCOL}//${HOST}/${token}/${encodedPath}`,
      text: null,
      truncated: false
    };
  }

  resolveForReveal(projectId: string, relativePath: string): string {
    const rootValue = this.options.getProjectRoot(projectId);
    if (!rootValue) throw new ProjectArtifactError('WORKSPACE_REQUIRED', '请先选择项目目录');
    const normalized = normalizedRelativePath(relativePath);
    if (!normalized) throw new ProjectArtifactError('INVALID_PATH', '请选择项目产物');
    const root = this.resolveRoot(rootValue);
    const value = this.resolveExisting(root.path, root.realPath, normalized);
    this.audit('reveal', projectId, 'ok');
    return value.path;
  }

  /** Streaming SHA-256, so fingerprinting a large artifact never blocks the main
   * thread. Advisory for the operator inspecting a file; delivery-time
   * verification is the artifact manifest's job, not this browser's. */
  async hash(projectId: string, relativePath: string): Promise<string> {
    const rootValue = this.options.getProjectRoot(projectId);
    if (!rootValue) throw new ProjectArtifactError('WORKSPACE_REQUIRED', '请先选择项目目录');
    const normalized = normalizedRelativePath(relativePath);
    if (!normalized) throw new ProjectArtifactError('INVALID_PATH', '请选择项目产物');
    const root = this.resolveRoot(rootValue);
    const resolved = this.resolveExisting(root.path, root.realPath, normalized, 'file');
    if (resolved.stat.size > MAX_PREVIEW_BYTES) throw new ProjectArtifactError('TOO_LARGE', '项目产物过大');
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(resolved.path)) digest.update(chunk as Uint8Array);
    this.audit('read', projectId, 'hash');
    return digest.digest('hex');
  }

  resolveAuthorizedUrl(rawUrl: string): ResolvedProjectArtifact {
    let url: URL;
    try { url = new URL(rawUrl); } catch { throw new ProjectArtifactError('GRANT_INVALID', '项目产物预览授权无效'); }
    if (url.protocol !== PROTOCOL || url.hostname !== HOST || url.search || url.hash) {
      throw new ProjectArtifactError('GRANT_INVALID', '项目产物预览授权无效');
    }
    const encodedParts = url.pathname.replace(/^\/+/, '').split('/');
    const token = encodedParts.shift() ?? '';
    if (!TOKEN_PATTERN.test(token) || encodedParts.length < 1) throw new ProjectArtifactError('GRANT_INVALID', '项目产物预览授权无效');
    const grant = this.grants.get(token);
    if (!grant) throw new ProjectArtifactError('GRANT_INVALID', '项目产物预览授权无效');
    if (grant.expiresAt <= this.now()) {
      this.grants.delete(token);
      throw new ProjectArtifactError('GRANT_EXPIRED', '项目产物预览授权已过期');
    }
    let decoded: string;
    try { decoded = encodedParts.map((part) => decodeURIComponent(part)).join('/'); } catch {
      throw new ProjectArtifactError('GRANT_INVALID', '项目产物预览授权无效');
    }
    const normalized = normalizedRelativePath(decoded);
    const resolved = this.resolveExisting(grant.root, grant.realRoot, normalized, 'file');
    if (resolved.stat.size > MAX_PREVIEW_BYTES) throw new ProjectArtifactError('TOO_LARGE', '项目产物过大');
    const mime = projectArtifactMediaType(normalized);
    const opened = this.openVerified(resolved);
    this.audit('read', grant.projectId, 'ok');
    return {
      fd: opened.fd,
      size: opened.size,
      headers: {
        'content-type': mime,
        'content-length': String(opened.size),
        'cache-control': 'private, no-store',
        'content-security-policy': "default-src 'none'; img-src aibox-project: data: blob:; media-src aibox-project: data: blob:; style-src aibox-project: 'unsafe-inline'; font-src aibox-project: data:; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
        'x-content-type-options': 'nosniff'
      }
    };
  }

  private entry(relativePath: string, name: string, kind: 'directory' | 'file', size: number, modifiedAt: number): ProjectArtifactEntryView {
    const kindValue = kind === 'directory' ? 'unsupported' : projectArtifactPreviewKind(name);
    return {
      relativePath,
      name,
      kind,
      size: kind === 'directory' ? 0 : size,
      modifiedAt,
      previewKind: kindValue,
      previewable: kind === 'file' && kindValue !== 'unsupported'
    };
  }

  private resolveRoot(value: string): { path: string; realPath: string } {
    const path = resolve(value);
    let stat: Stats;
    try { stat = lstatSync(path); } catch { throw new ProjectArtifactError('NOT_FOUND', '项目目录不存在'); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ProjectArtifactError('INVALID_PATH', '项目目录无效');
    const realPath = realpathSync(path);
    return { path, realPath };
  }

  private resolveExisting(
    root: string,
    realRoot: string,
    relativePath: string,
    expected?: 'file' | 'directory'
  ): { path: string; stat: Stats } {
    const normalized = normalizedRelativePath(relativePath);
    const candidate = resolve(root, ...normalized.split('/').filter(Boolean));
    if (!within(root, candidate)) throw new ProjectArtifactError('INVALID_PATH', '项目产物路径越界');
    let stat: Stats;
    try { stat = lstatSync(candidate); } catch { throw new ProjectArtifactError('NOT_FOUND', '项目产物不存在'); }
    if (stat.isSymbolicLink()) throw new ProjectArtifactError('INVALID_PATH', '不允许通过符号链接访问项目外文件');
    const realCandidate = realpathSync(candidate);
    if (!within(realRoot, realCandidate)) throw new ProjectArtifactError('INVALID_PATH', '项目产物路径越界');
    if (expected === 'file' && !stat.isFile()) throw new ProjectArtifactError('NOT_FOUND', '项目产物不是文件');
    if (expected === 'directory' && !stat.isDirectory()) throw new ProjectArtifactError('NOT_FOUND', '项目产物目录不存在');
    if (!expected && !stat.isFile() && !stat.isDirectory()) throw new ProjectArtifactError('NOT_FOUND', '项目产物不存在');
    return { path: candidate, stat };
  }

  /** Opens the already-validated file and re-checks identity against the
   * validation stat. Serving from this descriptor rather than re-opening by
   * path means a file swapped for a symlink after validation cannot redirect
   * the response, and content-length reflects the bytes actually served. */
  private openVerified(resolved: { path: string; stat: Stats }): { fd: number; size: number } {
    let fd: number;
    try { fd = openSync(resolved.path, 'r'); } catch { throw new ProjectArtifactError('NOT_FOUND', '项目产物不存在'); }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new ProjectArtifactError('NOT_FOUND', '项目产物不是文件');
      if (stat.dev !== resolved.stat.dev || stat.ino !== resolved.stat.ino) {
        throw new ProjectArtifactError('INVALID_PATH', '项目产物在校验后被替换');
      }
      if (stat.size > MAX_PREVIEW_BYTES) throw new ProjectArtifactError('TOO_LARGE', '项目产物过大');
      return { fd, size: stat.size };
    } catch (error) {
      try { closeSync(fd); } catch { /* the descriptor is already unusable */ }
      throw error;
    }
  }

  private issueGrant(projectId: string, root: string, realRoot: string): string {
    this.pruneExpired();
    const token = this.randomToken();
    if (!TOKEN_PATTERN.test(token) || this.grants.has(token)) throw new ProjectArtifactError('GRANT_INVALID', '无法创建项目产物预览授权');
    this.grants.set(token, { projectId, root, realRoot, expiresAt: this.now() + this.grantTtlMs });
    return token;
  }

  private readUtf8(path: string): string {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
    } catch {
      throw new ProjectArtifactError('NOT_PREVIEWABLE', '文件不是有效的 UTF-8 文本');
    }
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [token, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(token);
  }

  private audit(action: 'list' | 'preview' | 'read' | 'reveal', projectId: string, result: string): void {
    try { this.options.audit?.({ action, projectId, result }); } catch { /* audit must not break file access */ }
  }
}

export interface ProjectArtifactProtocolRegistrar {
  handle(scheme: string, handler: (request: Request) => Response | Promise<Response>): void | Promise<void>;
}

export function createProjectArtifactProtocolHandler(service: ProjectArtifactService): (request: Request) => Response {
  return (request) => {
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET' } });
    let unowned: number | null = null;
    try {
      const opened = service.resolveAuthorizedUrl(request.url);
      unowned = opened.fd;
      const stream = createReadStream('', { fd: opened.fd, autoClose: true });
      // The stream now owns the descriptor. Clearing this before any further
      // statement keeps the catch below from closing a descriptor autoClose will
      // also close: a double close can land on an unrelated file once Node has
      // reused the number.
      unowned = null;
      const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
      return new Response(body, { status: 200, headers: opened.headers });
    } catch (error) {
      if (unowned !== null) {
        try { closeSync(unowned); } catch { /* the descriptor is already unusable */ }
      }
      const code = error instanceof ProjectArtifactError ? error.code : null;
      const status = code === 'GRANT_EXPIRED' ? 410
        : code === 'GRANT_INVALID' || code === 'INVALID_PATH' ? 403
          : code === 'NOT_FOUND' ? 404
            : code === 'TOO_LARGE' ? 413 : 500;
      return new Response(status === 500 ? 'Internal error' : 'Project artifact unavailable', {
        status,
        headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' }
      });
    }
  };
}

export function registerProjectArtifactProtocol(registrar: ProjectArtifactProtocolRegistrar, service: ProjectArtifactService): void {
  void registrar.handle(PROJECT_ARTIFACT_PROTOCOL_SCHEME, createProjectArtifactProtocolHandler(service));
}

/** Syntactic navigation allowlist. Grant ownership, expiry, project root, and
 * path containment are still enforced by resolveAuthorizedUrl. */
export function isAuthorizedProjectArtifactUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== PROTOCOL || url.hostname !== HOST || url.search || url.hash) return false;
    const parts = url.pathname.replace(/^\/+/, '').split('/');
    const token = parts.shift() ?? '';
    if (!TOKEN_PATTERN.test(token) || parts.length < 1) return false;
    const decoded = parts.map((part) => decodeURIComponent(part)).join('/');
    return normalizedRelativePath(decoded).length > 0;
  } catch {
    return false;
  }
}
