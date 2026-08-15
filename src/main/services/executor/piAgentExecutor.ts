import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { Agent, ExecutorKind, Task } from '../../../shared/types.js';
import type { Database } from '../database.js';
import { spawnCli } from '../cliLauncher.js';
import {
  childProcessEnv,
  createSensitiveTextRedactor,
  redactSensitiveText
} from '../engineEnv.js';
import {
  PI_ENGINE_ID,
  PiRuntimeProfileService,
  type PreparedPiRuntime
} from '../piRuntimeProfile.js';
import {
  appendBoundedText,
  appendProcessOutput,
  boundedText,
  createProcessOutputBuffer,
  createUtf8StreamDecoder,
  finishProcessOutput
} from '../textEncoding.js';
import { killQuietly, type ExecutorAdapter, type ExecutorCallbacks } from './types.js';

const TIMEOUT_MS = 10 * 60_000;
const MAX_RESULT_CHARS = 16_000;
const MAX_STREAM_BUFFER_CHARS = 1024 * 1024;

/** Pi has no built-in OS sandbox. Keep the initial integration read-only. */
export const PI_SAFE_TOOLS = ['read', 'grep', 'find', 'ls'] as const;

interface RunningChild {
  child: ChildProcess;
  timer: NodeJS.Timeout;
}

interface PiMessage {
  role?: unknown;
  content?: unknown;
  errorMessage?: unknown;
  stopReason?: unknown;
}

function safeSessionId(value: string): string | null {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value) ? value : null;
}

export function piSessionIdFor(task: Pick<Task, 'id' | 'sessionId'>): string {
  if (task.sessionId?.startsWith('pi-')) {
    const existing = safeSessionId(task.sessionId.slice('pi-'.length));
    if (existing) return existing;
  }
  return `opc-${createHash('sha256').update(task.id).digest('hex').slice(0, 32)}`;
}

export function buildPiArgs(
  task: Pick<Task, 'id' | 'sessionId'>,
  agent: Pick<Agent, 'systemPrompt'>,
  runtime: Pick<PreparedPiRuntime, 'provider' | 'model' | 'sessionsDir' | 'workspaceGuardExtension'>,
  prompt: string
): string[] {
  const args = [
    '--mode', 'json',
    '--provider', runtime.provider,
    '--model', runtime.model,
    '--session-dir', runtime.sessionsDir,
    '--session-id', piSessionIdFor(task),
    '--no-approve',
    '--no-extensions',
    '--extension', runtime.workspaceGuardExtension,
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    '--tools', PI_SAFE_TOOLS.join(',')
  ];
  if (agent.systemPrompt.trim()) args.push('--append-system-prompt', agent.systemPrompt.trim());
  args.push(prompt);
  return args;
}

export function buildPiAuthCheckArgs(runtime: Pick<PreparedPiRuntime, 'provider' | 'model'>): string[] {
  return ['auth', 'check', '--provider', runtime.provider, '--model', runtime.model, '--json', '--no-refresh'];
}

export function buildPiProbeArgs(runtime: Pick<PreparedPiRuntime, 'provider' | 'model'>): string[] {
  return [
    '--mode', 'json',
    '--provider', runtime.provider,
    '--model', runtime.model,
    '--no-session',
    '--no-approve',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    '--no-tools',
    'Reply with exactly OPC_PI_OK.'
  ];
}

function messageText(message: PiMessage | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const value = part as { type?: unknown; text?: unknown };
      return value.type === 'text' && typeof value.text === 'string' ? value.text : '';
    })
    .join('');
}

function assistantError(message: PiMessage | undefined): string | null {
  if (!message) return null;
  if (typeof message.errorMessage === 'string' && message.errorMessage.trim()) return message.errorMessage.trim();
  return message.stopReason === 'error' ? 'Pi reported a model execution error' : null;
}

export function parsePiProbeOutput(stdout: string): { ok: boolean; output: string; error: string | null } {
  let output = '';
  let error: string | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === 'message_end') {
        const message = event.message as PiMessage | undefined;
        if (message?.role === 'assistant') {
          output = messageText(message) || output;
          error = assistantError(message) ?? error;
        }
      }
      if (event.type === 'error' && typeof event.message === 'string') error = event.message;
    } catch {
      // JSON mode is a strict protocol. Non-JSON stdout is not proof of a task result.
    }
  }
  return { ok: Boolean(output.trim()) && !error, output: output.trim(), error };
}

export function parsePiAuthCheck(stdout: string): { ready: boolean; reason: string } {
  try {
    const result = JSON.parse(stdout.trim()) as { status?: unknown; reason?: unknown };
    return {
      ready: result.status === 'ready',
      reason: typeof result.reason === 'string' ? result.reason : String(result.status ?? 'invalid response')
    };
  } catch {
    return { ready: false, reason: 'invalid auth check response' };
  }
}

export function redactPiText(text: string, env: Record<string, string | undefined>): string {
  return redactSensitiveText(text, env);
}

export class PiAgentExecutor implements ExecutorAdapter {
  readonly kind: ExecutorKind = 'pi-cli';
  private readonly profiles: PiRuntimeProfileService;
  private readonly running = new Map<string, RunningChild>();
  private readonly suppressed = new Set<string>();

  constructor(private readonly db: Database, profiles?: PiRuntimeProfileService) {
    this.profiles = profiles ?? new PiRuntimeProfileService(db);
  }

  isReady(): boolean {
    const row = this.db.raw.prepare('SELECT status FROM engines WHERE id = ?').get(PI_ENGINE_ID) as
      | { status: string }
      | undefined;
    return row?.status === 'HEALTHY';
  }

  private resolveBin(): string {
    const row = this.db.raw.prepare('SELECT path FROM engines WHERE id = ?').get(PI_ENGINE_ID) as
      | { path: string | null }
      | undefined;
    return row?.path || 'pi';
  }

  start(task: Task, agent: Agent, cb: ExecutorCallbacks): void {
    const workspace = task.workspaceOverride || agent.workspace || join(app.getPath('userData'), 'workspaces', agent.id);
    try {
      mkdirSync(workspace, { recursive: true });
    } catch (error) {
      cb.onError(task.id, `Pi workspace is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    let runtime: PreparedPiRuntime;
    try {
      runtime = this.profiles.ensure(agent);
    } catch (error) {
      cb.onError(task.id, `Pi runtime profile is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const prompt = task.sessionId?.startsWith('pi-')
      ? `Continue the existing task with this request:\n${task.content || task.title}`
      : task.content || task.title;
    const args = buildPiArgs(task, agent, runtime, prompt);
    const bin = this.resolveBin();
    const env = childProcessEnv(runtime.env);

    let child: ChildProcess;
    try {
      child = spawnCli(bin, args, {
        cwd: workspace,
        shell: false,
        windowsHide: true,
        env
      });
    } catch (error) {
      cb.onError(task.id, `Unable to start ${bin}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    let settled = false;
    const finishError = (message: string): void => {
      if (settled) return;
      settled = true;
      const run = this.running.get(task.id);
      if (run) clearTimeout(run.timer);
      this.running.delete(task.id);
      this.suppressed.add(task.id);
      cb.onError(task.id, redactPiText(message, env));
    };
    const timer = setTimeout(() => {
      killQuietly(child);
      finishError('Pi execution timed out after 10 minutes');
    }, TIMEOUT_MS);
    this.running.set(task.id, { child, timer });

    cb.onStage(task.id, 'Understanding request');
    cb.onProgress(task.id, 5);

    const streamedParts: string[] = [];
    const streamedState = { length: 0, truncated: false };
    const stderrOutput = createProcessOutputBuffer();
    const protocolOutput = createProcessOutputBuffer();
    let finalAssistantText = '';
    let fatalError: string | null = null;
    let outBuffer = '';
    let stdoutBuffer = '';
    let lastFlush = Date.now();
    let lastProgress = 5;
    let sawDelta = false;
    const decoder = createUtf8StreamDecoder();
    const streamRedactor = createSensitiveTextRedactor(env);

    const bump = (stage: string | null, progress: number): void => {
      if (stage) cb.onStage(task.id, stage);
      if (progress > lastProgress) {
        lastProgress = progress;
        cb.onProgress(task.id, progress);
      }
    };
    const flush = (force: boolean): void => {
      if (outBuffer && (force || Date.now() - lastFlush >= 300)) {
        const safe = streamRedactor.push(outBuffer);
        if (safe) cb.onOutput(task.id, safe);
        outBuffer = '';
        lastFlush = Date.now();
      }
      if (force) {
        const tail = streamRedactor.finish();
        if (tail) cb.onOutput(task.id, tail);
      }
    };
    const pushText = (value: string): void => {
      appendBoundedText(streamedParts, streamedState, value, MAX_RESULT_CHARS);
      if (outBuffer.length < 32 * 1024) outBuffer += value.slice(0, 32 * 1024 - outBuffer.length);
      bump('Generating result', Math.min(90, 10 + Math.floor(streamedState.length / 30)));
      flush(false);
    };
    const handleEvent = (line: string): void => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        appendProcessOutput(protocolOutput, Buffer.from(`${line}\n`, 'utf8'));
        return;
      }

      const type = event.type;
      if (type === 'session') {
        if (!task.sessionId && typeof event.id === 'string') cb.onSession?.(task.id, `pi-${event.id}`);
        bump('Planning', 12);
        return;
      }
      if (type === 'turn_start' || type === 'agent_start') {
        bump('Planning', 15);
        return;
      }
      if (type === 'tool_execution_start') {
        bump('Using read-only tools', Math.min(85, lastProgress + 8));
        return;
      }
      if (type === 'message_update') {
        const update = event.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
        if (update?.type === 'text_delta' && typeof update.delta === 'string') {
          sawDelta = true;
          pushText(update.delta);
        }
        return;
      }
      if (type === 'message_end') {
        const message = event.message as PiMessage | undefined;
        if (message?.role !== 'assistant') return;
        const text = messageText(message);
        if (text) {
          finalAssistantText = text;
          if (!sawDelta) pushText(text);
        }
        fatalError = assistantError(message) ?? fatalError;
        return;
      }
      if (type === 'agent_end') {
        const messages = Array.isArray(event.messages) ? event.messages as PiMessage[] : [];
        const lastAssistant = [...messages].reverse().find((message) => message?.role === 'assistant');
        const text = messageText(lastAssistant);
        if (text) finalAssistantText = text;
        fatalError = assistantError(lastAssistant) ?? fatalError;
        bump('Validating result', 95);
        return;
      }
      if (type === 'error' && typeof event.message === 'string') fatalError = event.message;
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutBuffer += decoder.write(chunk);
      if (stdoutBuffer.length > MAX_STREAM_BUFFER_CHARS) {
        finishError('Pi protocol record exceeded the 1 MiB safety limit');
        killQuietly(child);
        return;
      }
      let newline: number;
      while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '').trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line) handleEvent(line);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => appendProcessOutput(stderrOutput, chunk));

    child.on('error', (error) => {
      finishError(`Pi failed to start: ${error.message}. Confirm that pi is installed and available on PATH.`);
    });

    child.on('close', (code) => {
      if (this.suppressed.delete(task.id)) return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.running.delete(task.id);
      stdoutBuffer += decoder.end();
      if (stdoutBuffer.trim()) handleEvent(stdoutBuffer.replace(/\r$/, '').trim());
      flush(true);

      const stderr = redactPiText(finishProcessOutput(stderrOutput), env);
      const protocol = redactPiText(finishProcessOutput(protocolOutput), env);
      if (fatalError) {
        cb.onError(task.id, `Pi task failed: ${redactPiText(fatalError, env).slice(0, 500)}`);
        return;
      }
      if (code !== 0) {
        const detail = (stderr || protocol || 'no diagnostic output').trim().slice(0, 500);
        cb.onError(task.id, `Pi exited with code ${code ?? 'null'}: ${detail}`);
        return;
      }

      bump('Validating result', 98);
      const streamed = boundedText(streamedParts, streamedState).trim();
      const result = (finalAssistantText.trim() || streamed || '(Pi completed without a textual result)').slice(0, MAX_RESULT_CHARS);
      cb.onDone(task.id, redactPiText(result, env));
    });
  }

  abort(taskId: string): void {
    const run = this.running.get(taskId);
    if (!run) return;
    this.suppressed.add(taskId);
    clearTimeout(run.timer);
    killQuietly(run.child);
    this.running.delete(taskId);
  }
}
