import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  ProjectArtifactManifest,
  ProjectArtifactManifestEntry,
  ProjectArtifactRuntimeEvidence
} from '../../shared/types.js';
import type { Database } from './database.js';
import { projectArtifactMediaType, projectArtifactPreviewKind } from './projectArtifactService.js';

const EXCLUDED_DIRECTORIES = new Set(['.git', '.hg', '.svn', '.aibox', 'node_modules']);
const MAX_SCANNED_ENTRIES = 100_000;
const MAX_MANIFEST_ENTRIES = 1_000;
const CLOCK_TOLERANCE_MS = 2_000;
/** B.4 — 只读 package.json 里真实存在的脚本；上限防止把巨型文件读进内存。 */
const MAX_RUN_MANIFEST_BYTES = 256 * 1024;
const RUN_SCRIPT_PRIORITY = ['preview', 'start', 'dev', 'serve'] as const;

export interface ProjectArtifactCompletionInput {
  taskId: string;
  projectId: string;
  startedAt: number;
  endedAt: number;
}

export type ProjectArtifactCompletionResult =
  | { ok: true; manifest: ProjectArtifactManifest }
  | { ok: false; error: string };

export interface ProjectArtifactManifestServiceOptions {
  getProjectRoot: (projectId: string) => string | null;
  now?: () => number;
  audit?: (event: { taskId: string; projectId: string; result: 'verified' | 'rejected'; detail: string }) => void;
}

interface CandidateFile {
  absolutePath: string;
  relativePath: string;
  stat: Stats;
}

function within(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function safeIdentity(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}

async function sha256(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest('hex');
}

/**
 * B.6 — Manifest 是产物的唯一权威来源：IPC 预览、启动命令、渠道附件、渠道摘要
 * 全部从这里读，任何调用方都不得自己猜路径或重复解析 payload。
 */
export function readTaskArtifactManifest(db: Database, taskId: string): ProjectArtifactManifest | null {
  const event = db.raw.prepare(
    "SELECT payload FROM task_events WHERE task_id = ? AND event_type = 'artifact_manifest' ORDER BY created_at DESC, rowid DESC LIMIT 1"
  ).get(taskId) as { payload?: unknown } | undefined;
  if (typeof event?.payload !== 'string') return null;
  try {
    const parsed = JSON.parse(event.payload) as { manifest?: ProjectArtifactManifest };
    const manifest = parsed.manifest;
    return manifest && Array.isArray(manifest.entries)
      ? { ...manifest, runtime: readTaskArtifactRuntimeEvidence(db, taskId) }
      : null;
  } catch {
    return null;
  }
}

export function readTaskArtifactRuntimeEvidence(db: Database, taskId: string): ProjectArtifactRuntimeEvidence | null {
  const event = db.raw.prepare(
    "SELECT payload FROM task_events WHERE task_id = ? AND event_type = 'artifact_runtime' ORDER BY created_at DESC, rowid DESC LIMIT 1"
  ).get(taskId) as { payload?: unknown } | undefined;
  if (typeof event?.payload !== 'string') return null;
  try {
    const parsed = JSON.parse(event.payload) as { runtime?: ProjectArtifactRuntimeEvidence };
    const runtime = parsed.runtime;
    return runtime && runtime.taskId === taskId && typeof runtime.state === 'string' ? runtime : null;
  } catch {
    return null;
  }
}

/** 产物体积的统一人读格式（渠道摘要与 UI 共用一套口径）。 */
export function formatManifestBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 把 manifest 相对路径解析到项目根内；词法越界或绝对路径一律拒绝。 */
export function resolveManifestPath(root: string, relativePath: string): string | null {
  if (isAbsolute(relativePath)) return null;
  const absolute = resolve(root, relativePath);
  return within(root, absolute) ? absolute : null;
}

/**
 * B.4 — 从产物本身推导验收启动命令。只承认磁盘上真实存在的 `package.json`
 * 脚本，命令不来自模型输出，因此「声明可运行」等价于「真的可运行」。
 */
async function deriveRunConfig(
  absolutePath: string,
  relativePath: string,
  size: number
): Promise<{ command: string; cwd: string } | null> {
  if (!relativePath.endsWith('package.json') || size > MAX_RUN_MANIFEST_BYTES) return null;
  let scripts: Record<string, unknown>;
  let packageManager = 'npm';
  try {
    const parsed = JSON.parse(await readFile(absolutePath, 'utf8')) as {
      scripts?: Record<string, unknown>;
      packageManager?: unknown;
    };
    scripts = parsed.scripts ?? {};
    if (typeof parsed.packageManager === 'string') {
      const declared = /^(npm|pnpm|yarn)@/.exec(parsed.packageManager.trim())?.[1];
      if (declared) packageManager = declared;
    }
  } catch {
    return null;
  }
  const script = RUN_SCRIPT_PRIORITY.find((name) => typeof scripts[name] === 'string' && (scripts[name] as string).trim());
  if (!script) return null;
  const slash = relativePath.lastIndexOf('/');
  const command = packageManager === 'yarn' ? `yarn ${script}` : `${packageManager} run ${script}`;
  return { command, cwd: slash === -1 ? '.' : relativePath.slice(0, slash) };
}

/**
 * Produces completion evidence from files actually changed inside the selected
 * project during a task's running interval. The manifest is persisted by the
 * orchestrator as a task event, so this service never creates a synthetic file
 * that could accidentally satisfy its own completion gate.
 */
export class ProjectArtifactManifestService {
  private readonly now: () => number;

  constructor(private readonly options: ProjectArtifactManifestServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  async validateTaskCompletion(input: ProjectArtifactCompletionInput): Promise<ProjectArtifactCompletionResult> {
    if (!safeIdentity(input.taskId) || !safeIdentity(input.projectId)
      || !Number.isSafeInteger(input.startedAt) || input.startedAt < 0
      || !Number.isSafeInteger(input.endedAt) || input.endedAt < input.startedAt) {
      return this.reject(input, '任务产物校验参数无效');
    }
    const configuredRoot = this.options.getProjectRoot(input.projectId)?.trim() ?? '';
    if (!configuredRoot) return this.reject(input, '项目尚未配置工作目录，不能确认任务完成');

    let root: string;
    let realRoot: string;
    try {
      root = resolve(configuredRoot);
      const rootStat = await lstat(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('invalid root');
      realRoot = await realpath(root);
    } catch {
      return this.reject(input, '项目工作目录不存在或不可访问，不能确认任务完成');
    }

    const scanned = await this.scan(root, realRoot, input.startedAt, input.endedAt);
    if ('error' in scanned) return this.reject(input, scanned.error);
    if (scanned.files.length === 0) {
      return this.reject(input, '未检测到任务期间写入项目目录的真实产物；任务已停止在失败状态，请让执行员工把成果保存到项目目录后重试');
    }

    const entries: ProjectArtifactManifestEntry[] = [];
    let totalBytes = 0;
    for (const file of scanned.files.slice(0, MAX_MANIFEST_ENTRIES)) {
      try {
        const current = await lstat(file.absolutePath);
        if (!current.isFile() || current.isSymbolicLink() || current.size !== file.stat.size) {
          return this.reject(input, `项目产物在校验期间发生变化：${file.relativePath}`);
        }
        const realFile = await realpath(file.absolutePath);
        if (!within(realRoot, realFile)) return this.reject(input, `项目产物路径越界：${file.relativePath}`);
        const previewKind = projectArtifactPreviewKind(file.relativePath);
        entries.push({
          relativePath: file.relativePath,
          mediaType: projectArtifactMediaType(file.relativePath).replace(/;\s*charset=utf-8$/i, ''),
          size: current.size,
          sha256: await sha256(file.absolutePath),
          modifiedAt: current.mtimeMs,
          sourceTaskId: input.taskId,
          version: 1,
          validationState: 'verified',
          previewKind,
          previewable: previewKind !== 'unsupported',
          run: await deriveRunConfig(file.absolutePath, file.relativePath, current.size)
        });
        totalBytes += current.size;
      } catch (error) {
        const detail = error instanceof Error && /路径越界|发生变化/.test(error.message)
          ? error.message
          : `无法读取项目产物：${file.relativePath}`;
        return this.reject(input, detail);
      }
    }

    const manifest: ProjectArtifactManifest = {
      schemaVersion: 1,
      projectId: input.projectId,
      sourceTaskId: input.taskId,
      generatedAt: this.now(),
      totalBytes,
      entries,
      truncated: scanned.files.length > MAX_MANIFEST_ENTRIES,
      validation: { status: 'verified', reason: null }
    };
    this.audit(input, 'verified', `${entries.length} files`);
    return { ok: true, manifest };
  }

  private async scan(
    root: string,
    realRoot: string,
    startedAt: number,
    endedAt: number
  ): Promise<{ files: CandidateFile[] } | { error: string }> {
    const queue: Array<{ absolutePath: string; relativePath: string }> = [{ absolutePath: root, relativePath: '' }];
    const files: CandidateFile[] = [];
    let scannedEntries = 0;
    while (queue.length > 0) {
      const directory = queue.shift()!;
      let children;
      try {
        children = await readdir(directory.absolutePath, { withFileTypes: true });
      } catch {
        return { error: `无法读取项目产物目录：${directory.relativePath || '.'}` };
      }
      children.sort((left, right) => left.name.localeCompare(right.name, 'en'));
      for (const child of children) {
        scannedEntries += 1;
        if (scannedEntries > MAX_SCANNED_ENTRIES) {
          return { error: '项目目录文件过多，无法完整验证本次产物' };
        }
        if (child.isSymbolicLink()) continue;
        if (child.isDirectory() && EXCLUDED_DIRECTORIES.has(child.name)) continue;
        const relativePath = directory.relativePath ? `${directory.relativePath}/${child.name}` : child.name;
        const absolutePath = resolve(directory.absolutePath, child.name);
        if (!within(root, absolutePath)) continue;
        let stat: Stats;
        let realEntry: string;
        try {
          stat = await lstat(absolutePath);
          if (stat.isSymbolicLink()) continue;
          realEntry = await realpath(absolutePath);
        } catch {
          continue;
        }
        if (!within(realRoot, realEntry)) continue;
        if (stat.isDirectory()) {
          queue.push({ absolutePath, relativePath });
          continue;
        }
        if (!stat.isFile() || stat.size < 1 || child.name.endsWith('~') || /\.(?:tmp|swp)$/i.test(child.name)) continue;
        const changedAt = Math.max(stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs);
        if (changedAt < startedAt - CLOCK_TOLERANCE_MS || changedAt > endedAt + CLOCK_TOLERANCE_MS) continue;
        files.push({ absolutePath, relativePath: relativePath.replaceAll('\\', '/'), stat });
      }
    }
    files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
    return { files };
  }

  private reject(input: ProjectArtifactCompletionInput, error: string): ProjectArtifactCompletionResult {
    this.audit(input, 'rejected', error);
    return { ok: false, error };
  }

  private audit(input: ProjectArtifactCompletionInput, result: 'verified' | 'rejected', detail: string): void {
    try { this.options.audit?.({ taskId: input.taskId, projectId: input.projectId, result, detail }); } catch { /* audit must not alter completion */ }
  }
}
