import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectArtifactManifest } from '../src/shared/types.js';
import {
  ArtifactRuntimeManager,
  artifactLaunchCommand,
  artifactLoopbackUrl,
  parseArtifactRunCommand
} from '../src/main/services/artifactRuntimeManager.js';

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'aibox-artifact-runtime-'));
  roots.push(root);
  return root;
}

function manifest(command = 'npm run preview'): ProjectArtifactManifest {
  return {
    schemaVersion: 1,
    projectId: 'project-1',
    sourceTaskId: 'task-1',
    generatedAt: 1,
    totalBytes: 10,
    entries: [{
      relativePath: 'package.json',
      mediaType: 'application/json',
      size: 10,
      sha256: 'a'.repeat(64),
      modifiedAt: 1,
      sourceTaskId: 'task-1',
      version: 1,
      validationState: 'verified',
      previewKind: 'text',
      previewable: true,
      run: { command, cwd: '.' }
    }],
    truncated: false,
    validation: { status: 'verified', reason: null }
  };
}

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid: 4321,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: null,
    stdio: [],
    connected: false,
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true)
  });
  return child;
}

function eventDb() {
  const events: Array<{ id: string; task_id: string; event_type: string; payload: string; created_at: number }> = [];
  return {
    events,
    raw: {
      prepare: (sql: string) => ({
        get: (taskId: string) => events
          .filter((event) => event.task_id === taskId && event.event_type === 'artifact_runtime')
          .at(-1),
        all: () => [...events].reverse().filter((event) => event.event_type === 'artifact_runtime'),
        run: (id: string, taskId: string, eventType: string, payload: string, createdAt: number) => {
          events.push({ id, task_id: taskId, event_type: eventType, payload, created_at: createdAt });
          return { changes: 1 };
        }
      })
    },
    audit: vi.fn()
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('artifact runtime command policy', () => {
  it('accepts only real preview scripts from npm, pnpm and yarn', () => {
    expect(parseArtifactRunCommand('npm run preview')).toEqual({ bin: 'npm', args: ['run', 'preview'] });
    expect(parseArtifactRunCommand('pnpm run dev')).toEqual({ bin: 'pnpm', args: ['run', 'dev'] });
    expect(parseArtifactRunCommand('yarn serve')).toEqual({ bin: 'yarn', args: ['serve'] });
    expect(parseArtifactRunCommand('npm run build')).toBeNull();
    expect(parseArtifactRunCommand('npm run dev && calc')).toBeNull();
  });

  it('uses the Windows command interpreter for package-manager shims', () => {
    expect(artifactLaunchCommand({ bin: 'npm', args: ['run', 'dev'] }, 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }))
      .toEqual({
        executable: 'C:\\Windows\\System32\\cmd.exe',
        args: ['/d', '/s', '/c', 'npm.cmd run dev']
      });
    expect(artifactLaunchCommand({ bin: 'pnpm', args: ['run', 'preview'] }, 'win32', {}))
      .toEqual({ executable: 'cmd.exe', args: ['/d', '/s', '/c', 'pnpm.cmd run preview'] });
    expect(artifactLaunchCommand({ bin: 'yarn', args: ['start'] }, 'win32', {}))
      .toEqual({ executable: 'cmd.exe', args: ['/d', '/s', '/c', 'yarn.cmd start'] });
  });

  it('returns only loopback preview URLs', () => {
    expect(artifactLoopbackUrl('Local: http://localhost:5173/')).toBe('http://localhost:5173/');
    expect(artifactLoopbackUrl('http://127.0.0.1:3000/path')).toBe('http://127.0.0.1:3000/path');
    expect(artifactLoopbackUrl('Network: http://192.168.1.8:5173/')).toBeNull();
  });
});

describe('ArtifactRuntimeManager', () => {
  it('persists a real running URL, captures evidence, strips host secrets and stops the process', async () => {
    const root = workspace();
    mkdirSync(join(root, 'src'));
    const child = fakeChild();
    const db = eventDb();
    const spawnProcess = vi.fn(() => child);
    const terminateProcess = vi.fn(async () => { child.emit('close', null); });
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'must-not-leak';
    try {
      const manager = new ArtifactRuntimeManager({
        db: db as never,
        resolveManifest: () => manifest(),
        resolveWorkspace: () => root,
        spawnProcess,
        terminateProcess,
        startupWaitMs: 2_000,
        captureScreenshots: vi.fn(async () => [{
          relativePath: '.opc-nexus/delivery/task-1/preview-desktop.png',
          viewport: 'desktop',
          width: 1440,
          height: 900,
          mediaType: 'image/png',
          sha256: 'b'.repeat(64),
          createdAt: 2
        }])
      });

      const started = manager.start('task-1');
      (child.stdout as PassThrough).write('\u001b[32mLocal:\u001b[0m http://localhost:4173/\n');
      const result = await started;

      expect(result.ok).toBe(true);
      expect(result.runtime).toMatchObject({ state: 'RUNNING', pid: 4321, url: 'http://localhost:4173/' });
      const spawnEnv = spawnProcess.mock.calls[0]?.[2].env as NodeJS.ProcessEnv;
      expect(spawnEnv.OPENAI_API_KEY).toBeUndefined();
      await expect.poll(() => manager.status('task-1')?.screenshots.length).toBe(1);

      const stopped = await manager.stop('task-1');
      expect(stopped).toMatchObject({ ok: true, runtime: { state: 'STOPPED', endedAt: expect.any(Number) } });
      expect(terminateProcess).toHaveBeenCalledWith(child);
      expect(db.events.filter((event) => event.event_type === 'artifact_runtime').length).toBeGreaterThanOrEqual(3);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('fails closed for build-only manifests', async () => {
    const root = workspace();
    const manager = new ArtifactRuntimeManager({
      db: eventDb() as never,
      resolveManifest: () => manifest('npm run build'),
      resolveWorkspace: () => root,
      spawnProcess: vi.fn()
    });
    await expect(manager.start('task-1')).resolves.toEqual(expect.objectContaining({
      ok: false,
      error: expect.stringContaining('允许列表')
    }));
  });
});
