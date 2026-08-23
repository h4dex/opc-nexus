import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync
} from 'node:fs';
import { basename, join } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { DebugLogStatus } from '../../shared/types.js';
import type { Database } from './database.js';

export type DebugLogLevel = 'debug' | 'info' | 'warn' | 'error';

const SECRET_FIELD = /(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|cookie|credential|auth[_-]?token)/i;
const LOG_FILE = /^opc-nexus-debug-\d{4}-\d{2}-\d{2}\.jsonl$/;
const MAX_VALUE_LENGTH = 32_000;

function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_API_KEY]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|cookie|credential|authorization)\s*[:=]\s*["']?)[^\s"',;}]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:key|token|secret|signature|code)=)[^&#\s]+/gi, '$1[REDACTED]')
    .slice(0, MAX_VALUE_LENGTH);
}

function safeValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return String(value);
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message), stack: redactText(value.stack ?? '') };
  }
  if (depth >= 6) return '[MAX_DEPTH]';
  if (typeof value !== 'object') return redactText(String(value));
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => safeValue(item, depth + 1, seen));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 200)) {
    result[key] = SECRET_FIELD.test(key) ? '[REDACTED]' : safeValue(item, depth + 1, seen);
  }
  return result;
}

function dayStamp(now: number): string {
  const date = new Date(now);
  const local = new Date(now - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export interface DebugLogServiceOptions {
  now?: () => number;
  maxFileBytes?: number;
  maxFiles?: number;
  captureConsole?: boolean;
}

/** Opt-in diagnostic logger. It never writes before debug mode is enabled. */
export class DebugLogService {
  private readonly now: () => number;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly captureConsole: boolean;
  private enabled = false;
  private currentFile: string | null = null;
  private lastError: string | null = null;
  private restoreConsole: (() => void) | null = null;
  private removeAuditListener: (() => void) | null = null;
  private removeProcessListeners: (() => void) | null = null;

  constructor(readonly logDirectory: string, options: DebugLogServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxFileBytes = options.maxFileBytes ?? 5 * 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 20;
    this.captureConsole = options.captureConsole ?? true;
  }

  initialize(enabled: boolean, db?: Database): DebugLogStatus {
    if (db) this.attachDatabase(db);
    if (enabled) this.setEnabled(true);
    return this.getStatus();
  }

  getStatus(): DebugLogStatus {
    return {
      enabled: this.enabled,
      logDirectory: this.logDirectory,
      currentFile: this.currentFile,
      lastError: this.lastError,
      maxFileBytes: this.maxFileBytes,
      retainedFiles: this.listLogFiles().length
    };
  }

  setEnabled(enabled: boolean): DebugLogStatus {
    if (enabled === this.enabled) return this.getStatus();
    if (enabled) {
      try {
        mkdirSync(this.logDirectory, { recursive: true });
        this.enabled = true;
        this.lastError = null;
        this.installProcessCapture();
        if (this.captureConsole) this.installConsoleCapture();
        this.record('debug', 'lifecycle', 'debug mode enabled', { logDirectory: this.logDirectory });
      } catch (error) {
        this.enabled = false;
        this.restoreConsole?.();
        this.restoreConsole = null;
        this.lastError = error instanceof Error ? error.message : String(error);
        throw new Error(`调试日志目录不可写：${this.lastError}`);
      }
    } else {
      this.record('info', 'lifecycle', 'debug mode disabled');
      this.enabled = false;
      this.restoreConsole?.();
      this.restoreConsole = null;
      this.removeProcessListeners?.();
      this.removeProcessListeners = null;
      this.currentFile = null;
    }
    return this.getStatus();
  }

  attachDatabase(db: Database): void {
    this.removeAuditListener?.();
    this.removeAuditListener = db.onAudit((entry) => {
      this.record('info', 'audit', entry.action, entry);
    });
  }

  attachWindow(window: BrowserWindow, label = 'renderer'): void {
    const contents = window.webContents;
    contents.on('console-message', (details) => {
      const level: DebugLogLevel = details.level === 'error' ? 'error'
        : details.level === 'warning' ? 'warn'
          : details.level === 'debug' ? 'debug' : 'info';
      this.record(level, label, details.message, {
        line: details.lineNumber,
        source: details.sourceId
      });
    });
    contents.on('render-process-gone', (_event, details) => {
      this.record('error', label, 'render process gone', details);
    });
    contents.on('unresponsive', () => this.record('warn', label, 'renderer unresponsive'));
  }

  record(level: DebugLogLevel, category: string, message: string, data?: unknown): void {
    if (!this.enabled) return;
    try {
      const timestamp = this.now();
      const line = `${JSON.stringify({
        timestamp: new Date(timestamp).toISOString(),
        level,
        category: redactText(category).slice(0, 160),
        message: redactText(message),
        ...(data === undefined ? {} : { data: safeValue(data) })
      })}\n`;
      const file = this.resolveFile(timestamp, Buffer.byteLength(line, 'utf8'));
      appendFileSync(file, line, { encoding: 'utf8', flag: 'a' });
      this.currentFile = file;
      this.prune();
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  dispose(): void {
    if (this.enabled) this.record('info', 'lifecycle', 'application shutdown');
    this.enabled = false;
    this.restoreConsole?.();
    this.removeAuditListener?.();
    this.removeProcessListeners?.();
    this.restoreConsole = null;
    this.removeAuditListener = null;
    this.removeProcessListeners = null;
  }

  private resolveFile(timestamp: number, bytes: number): string {
    mkdirSync(this.logDirectory, { recursive: true });
    const target = join(this.logDirectory, `opc-nexus-debug-${dayStamp(timestamp)}.jsonl`);
    if (existsSync(target) && statSync(target).size + bytes > this.maxFileBytes) {
      const archive = join(this.logDirectory, `opc-nexus-debug-${dayStamp(timestamp)}-${timestamp}.jsonl`);
      renameSync(target, archive);
    }
    return target;
  }

  private listLogFiles(): string[] {
    try {
      return readdirSync(this.logDirectory)
        .filter((name) => LOG_FILE.test(name) || /^opc-nexus-debug-\d{4}-\d{2}-\d{2}-\d+\.jsonl$/.test(name))
        .map((name) => join(this.logDirectory, basename(name)));
    } catch {
      return [];
    }
  }

  private prune(): void {
    const files = this.listLogFiles()
      .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
      .sort((left, right) => right.mtime - left.mtime);
    for (const stale of files.slice(this.maxFiles)) {
      try { unlinkSync(stale.path); } catch { /* Retry on the next write. */ }
    }
  }

  private installConsoleCapture(): void {
    if (this.restoreConsole) return;
    const original = {
      debug: console.debug.bind(console),
      info: console.info.bind(console),
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console)
    };
    const wrap = (level: DebugLogLevel, output: (...args: unknown[]) => void) => (...args: unknown[]) => {
      output(...args);
      const [first, ...rest] = args;
      this.record(level, 'main.console', typeof first === 'string' ? first : 'console output',
        typeof first === 'string' ? rest : args);
    };
    console.debug = wrap('debug', original.debug);
    console.info = wrap('info', original.info);
    console.log = wrap('info', original.log);
    console.warn = wrap('warn', original.warn);
    console.error = wrap('error', original.error);
    this.restoreConsole = () => {
      console.debug = original.debug;
      console.info = original.info;
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
    };
  }

  private installProcessCapture(): void {
    if (this.removeProcessListeners) return;
    const onUncaught = (error: Error) => this.record('error', 'process', 'uncaught exception', error);
    const onRejection = (reason: unknown) => this.record('error', 'process', 'unhandled rejection', reason);
    process.on('uncaughtExceptionMonitor', onUncaught);
    process.on('unhandledRejection', onRejection);
    this.removeProcessListeners = () => {
      process.removeListener('uncaughtExceptionMonitor', onUncaught);
      process.removeListener('unhandledRejection', onRejection);
    };
  }
}

export const redactDebugLogValue = safeValue;
