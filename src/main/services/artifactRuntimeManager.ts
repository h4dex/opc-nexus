import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  ProjectArtifactManifest,
  ProjectArtifactRuntimeEvidence,
  ProjectArtifactRuntimeOperationResult,
  ProjectArtifactScreenshotEvidence
} from '../../shared/types.js';
import type { Database } from './database.js';
import { childProcessEnv } from './engineEnv.js';
import { terminateCliProcess } from './cliLauncher.js';
import { readTaskArtifactRuntimeEvidence } from './projectArtifactManifest.js';
import { createUtf8StreamDecoder } from './textEncoding.js';

const RUN_SCRIPTS = new Set(['preview', 'start', 'dev', 'serve']);
const SAFE_TOKEN = /^[A-Za-z0-9._:@=/\\-]+$/;
const MAX_OUTPUT_TAIL = 16_000;
const DEFAULT_STARTUP_WAIT_MS = 4_000;
const ACTIVE_STATES = new Set(['STARTING', 'RUNNING', 'STOPPING']);
const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;

export interface ArtifactRuntimeCaptureInput {
  taskId: string;
  projectId: string;
  projectRoot: string;
  url: string;
}

export interface ArtifactRuntimeManagerOptions {
  db: Database;
  resolveManifest: (taskId: string) => ProjectArtifactManifest | null;
  resolveWorkspace: (taskId: string) => string | null;
  captureScreenshots?: (input: ArtifactRuntimeCaptureInput) => Promise<ProjectArtifactScreenshotEvidence[]>;
  now?: () => number;
  startupWaitMs?: number;
  spawnProcess?: (executable: string, args: string[], options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    detached: boolean;
  }) => ChildProcess;
  terminateProcess?: (child: ChildProcess) => Promise<void>;
}

interface RuntimeHandle {
  child: ChildProcess;
  evidence: ProjectArtifactRuntimeEvidence;
  stopRequested: boolean;
  finalized: boolean;
  captureStarted: boolean;
  ready: () => void;
}

function within(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function cleanOutput(value: string): string {
  return value.replace(ANSI_ESCAPE, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(-MAX_OUTPUT_TAIL);
}

function errorText(error: unknown): string {
  return cleanOutput(error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

/** Only package-manager scripts selected by the manifest builder are valid.
 * Renderer and model output never supply this command. */
export function parseArtifactRunCommand(command: string): { bin: 'npm' | 'pnpm' | 'yarn'; args: string[] } | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 3 || !tokens.every((token) => SAFE_TOKEN.test(token))) return null;
  const [bin, ...args] = tokens;
  if (bin !== 'npm' && bin !== 'pnpm' && bin !== 'yarn') return null;
  const script = bin === 'yarn'
    ? (args[0] === 'run' ? args[1] : args[0])
    : (args[0] === 'run' ? args[1] : undefined);
  if (!script || !RUN_SCRIPTS.has(script)) return null;
  if (bin !== 'yarn' && args.length !== 2) return null;
  if (bin === 'yarn' && !((args.length === 1) || (args.length === 2 && args[0] === 'run'))) return null;
  return { bin, args };
}

export function artifactLaunchCommand(
  command: { bin: 'npm' | 'pnpm' | 'yarn'; args: string[] },
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): { executable: string; args: string[] } {
  if (platform !== 'win32') return { executable: command.bin, args: command.args };
  const executable = env.ComSpec || env.COMSPEC || 'cmd.exe';
  const line = [`${command.bin}.cmd`, ...command.args].join(' ');
  return { executable, args: ['/d', '/s', '/c', line] };
}

/** Extract a browser-safe local URL from tool output. Network-facing URLs are
 * deliberately ignored; OPC-Nexus only opens loopback artifact services. */
export function artifactLoopbackUrl(output: string): string | null {
  const matches = output.replace(ANSI_ESCAPE, '').match(/https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?(?:\/[^\s"'<>]*)?/gi) ?? [];
  for (const match of matches) {
    const candidate = match.replace(/[),.;]+$/, '');
    try {
      const url = new URL(candidate);
      const host = url.hostname.toLowerCase();
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      if (host !== 'localhost' && host !== '::1' && !host.startsWith('127.')) continue;
      const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) continue;
      return url.toString();
    } catch {
      // Continue to the next URL in the bounded process-output tail.
    }
  }
  return null;
}

export class ArtifactRuntimeManager {
  private readonly active = new Map<string, RuntimeHandle>();
  private readonly now: () => number;
  private readonly startupWaitMs: number;

  constructor(private readonly options: ArtifactRuntimeManagerOptions) {
    this.now = options.now ?? Date.now;
    this.startupWaitMs = Math.max(100, Math.min(30_000, options.startupWaitMs ?? DEFAULT_STARTUP_WAIT_MS));
    this.reconcileInterruptedRuntimes();
  }

  status(taskId: string): ProjectArtifactRuntimeEvidence | null {
    const current = this.active.get(taskId)?.evidence;
    return current ? structuredClone(current) : readTaskArtifactRuntimeEvidence(this.options.db, taskId);
  }

  async start(taskId: string): Promise<ProjectArtifactRuntimeOperationResult> {
    const current = this.active.get(taskId);
    if (current && ACTIVE_STATES.has(current.evidence.state)) {
      return { ok: true, runtime: structuredClone(current.evidence), error: null };
    }

    const prepared = this.prepare(taskId);
    if ('error' in prepared) return { ok: false, runtime: null, error: prepared.error };
    const parsed = parseArtifactRunCommand(prepared.run.command);
    if (!parsed) return { ok: false, runtime: null, error: `启动命令不在预览允许列表内：${prepared.run.command}` };
    const launch = artifactLaunchCommand(parsed, process.platform, process.env);
    const env = childProcessEnv({ FORCE_COLOR: '0', NO_COLOR: '1' });

    let child: ChildProcess;
    try {
      child = this.options.spawnProcess
        ? this.options.spawnProcess(launch.executable, launch.args, {
            cwd: prepared.cwd,
            env,
            detached: process.platform !== 'win32'
          })
        : spawn(launch.executable, launch.args, {
            cwd: prepared.cwd,
            env,
            detached: process.platform !== 'win32',
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
          });
    } catch (error) {
      const message = `无法启动产物预览：${errorText(error)}`;
      const failed = this.initialEvidence(taskId, prepared.manifest, prepared.run, null);
      failed.state = 'FAILED';
      failed.endedAt = this.now();
      failed.error = message;
      this.persist(failed);
      return { ok: false, runtime: failed, error: message };
    }

    let resolveReady!: () => void;
    const readyPromise = new Promise<void>((resolveReadyPromise) => { resolveReady = resolveReadyPromise; });
    const evidence = this.initialEvidence(taskId, prepared.manifest, prepared.run, child.pid ?? null);
    const handle: RuntimeHandle = {
      child,
      evidence,
      stopRequested: false,
      finalized: false,
      captureStarted: false,
      ready: resolveReady
    };
    this.active.set(taskId, handle);
    this.persist(evidence);
    this.audit('artifact.runtime.start', taskId, prepared.run.command);

    const stdoutDecoder = createUtf8StreamDecoder();
    const stderrDecoder = createUtf8StreamDecoder();
    const acceptOutput = (stream: 'stdoutTail' | 'stderrTail', value: string) => {
      evidence[stream] = cleanOutput(evidence[stream] + value);
      const url = artifactLoopbackUrl(`${evidence.stdoutTail}\n${evidence.stderrTail}`);
      if (url && !evidence.url) {
        evidence.url = url;
        evidence.state = 'RUNNING';
        this.persist(evidence);
        handle.ready();
        void this.capture(handle, prepared.root);
      }
    };
    child.stdout?.on('data', (chunk: Buffer | string) => acceptOutput('stdoutTail', stdoutDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))));
    child.stderr?.on('data', (chunk: Buffer | string) => acceptOutput('stderrTail', stderrDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))));
    child.once('error', (error) => {
      if (handle.finalized) return;
      evidence.stderrTail = cleanOutput(evidence.stderrTail + stderrDecoder.end());
      this.finalize(handle, 'FAILED', null, `产物预览进程启动失败：${errorText(error)}`);
    });
    child.once('close', (code) => {
      if (handle.finalized) return;
      evidence.stdoutTail = cleanOutput(evidence.stdoutTail + stdoutDecoder.end());
      evidence.stderrTail = cleanOutput(evidence.stderrTail + stderrDecoder.end());
      const state = handle.stopRequested ? 'STOPPED' : code === 0 ? 'EXITED' : 'FAILED';
      const message = handle.stopRequested || code === 0
        ? null
        : `产物预览进程退出，代码 ${code ?? 'unknown'}`;
      this.finalize(handle, state, code, message);
    });

    const timer = setTimeout(() => {
      if (handle.finalized) return;
      if (evidence.state === 'STARTING') {
        evidence.state = 'RUNNING';
        this.persist(evidence);
      }
      handle.ready();
    }, this.startupWaitMs);
    await readyPromise;
    clearTimeout(timer);
    const runtime = structuredClone(evidence);
    const ok = runtime.state === 'RUNNING' || runtime.state === 'STARTING';
    return { ok, runtime, error: ok ? null : runtime.error ?? '产物预览未能持续运行' };
  }

  async stop(taskId: string): Promise<ProjectArtifactRuntimeOperationResult> {
    const handle = this.active.get(taskId);
    if (!handle) {
      const runtime = this.status(taskId);
      return { ok: true, runtime, error: null };
    }
    if (handle.finalized) return { ok: true, runtime: structuredClone(handle.evidence), error: null };
    handle.stopRequested = true;
    handle.evidence.state = 'STOPPING';
    this.persist(handle.evidence);
    try {
      if (this.options.terminateProcess) {
        await this.options.terminateProcess(handle.child);
      } else if (process.platform === 'win32') {
        await terminateCliProcess(handle.child);
      } else if (handle.child.pid) {
        try { process.kill(-handle.child.pid, 'SIGTERM'); } catch { await terminateCliProcess(handle.child); }
      } else {
        await terminateCliProcess(handle.child);
      }
      if (!handle.finalized) this.finalize(handle, 'STOPPED', handle.child.exitCode, null);
      this.audit('artifact.runtime.stop', taskId, 'ok');
      return { ok: true, runtime: structuredClone(handle.evidence), error: null };
    } catch (error) {
      const message = `停止产物预览失败：${errorText(error)}`;
      handle.evidence.state = 'FAILED';
      handle.evidence.error = message;
      handle.evidence.endedAt = this.now();
      this.persist(handle.evidence);
      this.audit('artifact.runtime.stop', taskId, message);
      return { ok: false, runtime: structuredClone(handle.evidence), error: message };
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.active.keys()].map(async (taskId) => { await this.stop(taskId); }));
  }

  private prepare(taskId: string): {
    manifest: ProjectArtifactManifest;
    run: { command: string; cwd: string };
    root: string;
    cwd: string;
  } | { error: string } {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(taskId)) return { error: 'taskId 无效' };
    const manifest = this.options.resolveManifest(taskId);
    if (!manifest || manifest.validation.status !== 'verified' || manifest.sourceTaskId !== taskId) {
      return { error: '任务没有已验证的产物清单' };
    }
    const run = manifest.entries.find((entry) => entry.run)?.run;
    if (!run) return { error: '产物未声明可运行的预览脚本' };
    const rootValue = this.options.resolveWorkspace(taskId);
    if (!rootValue) return { error: '项目工作目录不存在' };
    try {
      const root = resolve(rootValue);
      const rootStat = lstatSync(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('invalid root');
      const realRoot = realpathSync(root);
      const cwd = resolve(root, run.cwd);
      if (!within(root, cwd)) return { error: '启动目录越界' };
      const cwdStat = lstatSync(cwd);
      if (!cwdStat.isDirectory() || cwdStat.isSymbolicLink()) return { error: '启动目录无效' };
      if (!within(realRoot, realpathSync(cwd))) return { error: '启动目录越界' };
      return { manifest, run, root, cwd };
    } catch {
      return { error: '项目工作目录或启动目录不存在' };
    }
  }

  private initialEvidence(
    taskId: string,
    manifest: ProjectArtifactManifest,
    run: { command: string; cwd: string },
    pid: number | null
  ): ProjectArtifactRuntimeEvidence {
    return {
      taskId,
      projectId: manifest.projectId,
      command: run.command,
      cwd: run.cwd,
      state: 'STARTING',
      pid,
      url: null,
      startedAt: this.now(),
      endedAt: null,
      exitCode: null,
      error: null,
      stdoutTail: '',
      stderrTail: '',
      screenshots: [],
      screenshotError: null
    };
  }

  private async capture(handle: RuntimeHandle, projectRoot: string): Promise<void> {
    if (handle.captureStarted || !handle.evidence.url || !this.options.captureScreenshots) return;
    handle.captureStarted = true;
    try {
      handle.evidence.screenshots = await this.options.captureScreenshots({
        taskId: handle.evidence.taskId,
        projectId: handle.evidence.projectId,
        projectRoot,
        url: handle.evidence.url
      });
      handle.evidence.screenshotError = null;
    } catch (error) {
      handle.evidence.screenshotError = `预览截图失败：${errorText(error)}`;
    }
    this.persist(handle.evidence);
  }

  private finalize(
    handle: RuntimeHandle,
    state: 'STOPPED' | 'EXITED' | 'FAILED',
    exitCode: number | null,
    error: string | null
  ): void {
    if (handle.finalized) return;
    handle.finalized = true;
    handle.evidence.state = state;
    handle.evidence.endedAt = this.now();
    handle.evidence.exitCode = exitCode;
    handle.evidence.error = error;
    this.persist(handle.evidence);
    this.active.delete(handle.evidence.taskId);
    handle.ready();
  }

  private persist(evidence: ProjectArtifactRuntimeEvidence): void {
    this.options.db.raw.prepare(
      'INSERT INTO task_events(id, task_id, event_type, payload, created_at) VALUES(?, ?, ?, ?, ?)'
    ).run(randomUUID(), evidence.taskId, 'artifact_runtime', JSON.stringify({ runtime: evidence }), this.now());
  }

  private audit(action: string, taskId: string, result: string): void {
    try {
      this.options.db.audit({ id: randomUUID(), actor: 'admin', action, target: taskId, result: result.slice(0, 2_000) });
    } catch {
      // Audit failures must not hide the real runtime state already persisted.
    }
  }

  private reconcileInterruptedRuntimes(): void {
    try {
      const rows = this.options.db.raw.prepare(
        "SELECT task_id, payload FROM task_events WHERE event_type = 'artifact_runtime' ORDER BY created_at DESC, rowid DESC"
      ).all() as { task_id: string; payload: string }[];
      const seen = new Set<string>();
      for (const row of rows) {
        if (seen.has(row.task_id)) continue;
        seen.add(row.task_id);
        let runtime: ProjectArtifactRuntimeEvidence | undefined;
        try { runtime = (JSON.parse(row.payload) as { runtime?: ProjectArtifactRuntimeEvidence }).runtime; } catch { continue; }
        if (!runtime || !ACTIVE_STATES.has(runtime.state)) continue;
        this.persist({
          ...runtime,
          state: 'STOPPED',
          pid: null,
          endedAt: this.now(),
          error: '应用已重启，之前的产物预览进程不再运行'
        });
      }
    } catch {
      // Focused test databases may not expose task_events; startup stays usable.
    }
  }
}
