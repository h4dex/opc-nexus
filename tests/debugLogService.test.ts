import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DebugLogService } from '../src/main/services/debugLogService.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'opc-nexus-debug-'));
  roots.push(value);
  return value;
}

describe('DebugLogService', () => {
  it('does not create files while disabled and redacts secrets after enabling', () => {
    const directory = join(root(), 'user', 'logs');
    const logger = new DebugLogService(directory, { captureConsole: false });
    logger.record('info', 'test', 'disabled message');
    expect(logger.getStatus()).toMatchObject({ enabled: false, retainedFiles: 0 });

    logger.setEnabled(true);
    logger.record('error', 'provider', 'Bearer bearer-secret-token apiKey=plain-secret', {
      apiKey: 'sk-test-secret-value-123456789',
      endpoint: 'https://example.invalid/v1?token=query-secret',
      nested: { cookie: 'session-private' }
    });
    const status = logger.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.currentFile).not.toBeNull();
    const text = readFileSync(status.currentFile!, 'utf8');
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('bearer-secret-token');
    expect(text).not.toContain('plain-secret');
    expect(text).not.toContain('sk-test-secret-value-123456789');
    expect(text).not.toContain('query-secret');
    expect(text).not.toContain('session-private');
    logger.dispose();
  });

  it('rotates bounded JSONL files and mirrors audit events only while enabled', () => {
    const directory = join(root(), 'logs');
    let auditListener: ((entry: Record<string, unknown>) => void) | null = null;
    const db = {
      onAudit: vi.fn((listener: (entry: Record<string, unknown>) => void) => {
        auditListener = listener;
        return () => { auditListener = null; };
      })
    };
    const logger = new DebugLogService(directory, {
      captureConsole: false,
      maxFileBytes: 300,
      maxFiles: 2,
      now: (() => { let value = Date.UTC(2026, 7, 19, 1); return () => ++value; })()
    });
    logger.initialize(true, db as never);
    auditListener?.({ action: 'task.dispatch', target: 'task-1', result: 'ok' });
    for (let index = 0; index < 12; index += 1) {
      logger.record('debug', 'rotation', `entry-${index}`, { detail: 'x'.repeat(180) });
    }
    const files = readdirSync(directory).filter((name) => name.endsWith('.jsonl'));
    expect(files.length).toBeLessThanOrEqual(2);
    expect(files.some((name) => name.includes('-2026-08-19'))).toBe(true);
    logger.dispose();
    expect(auditListener).toBeNull();
  });

  it('fails explicitly when the configured log directory is below a file', () => {
    const base = root();
    const blocker = join(base, 'not-a-directory');
    writeFileSync(blocker, 'occupied');
    const logger = new DebugLogService(join(blocker, 'logs'), { captureConsole: false });
    expect(() => logger.setEnabled(true)).toThrow('调试日志目录不可写');
    expect(logger.getStatus()).toMatchObject({ enabled: false });
  });
});
