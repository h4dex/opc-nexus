import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnvironmentDiagnosticsService, defaultEnvironmentCommands } from '../src/main/services/environmentDiagnostics.js';

describe('EnvironmentDiagnosticsService', () => {
  it('detects the bundled runtime and a declared native library without loading it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aibox-env-'));
    mkdirSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'managed-runtime', version: '2.0.0' }));
    writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'export {};');
    writeFileSync(join(root, 'vision.dll'), 'not a real library');

    const view = await new EnvironmentDiagnosticsService({
      managedRuntimeRoot: root,
      nativeRoots: [root],
      nativeExtensions: [{
        id: 'vision-native', name: 'Vision native bridge', kind: 'dll', relativePaths: ['vision.dll'],
        platforms: ['win32'], architectures: ['x64'], required: true
      }],
      commands: [],
      platform: 'win32',
      architecture: 'x64',
      now: () => 42
    }).diagnose();

    expect(view.scannedAt).toBe(42);
    expect(view.ready).toBe(true);
    expect(view.runtimeSelection).toEqual({ requested: 'bundled', selected: 'bundled', fallbackUsed: false, reason: null });
    expect(view.components.find((component) => component.id === 'dsh-managed-runtime')).toMatchObject({
      available: true, ready: true, version: '2.0.0', source: 'bundled'
    });
    expect(view.components.find((component) => component.id === 'vision-native')).toMatchObject({
      available: true, ready: true, source: 'declared', path: join(root, 'vision.dll')
    });
  });

  it('rejects traversal and mismatched platform/architecture declarations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aibox-env-'));
    writeFileSync(join(root, 'outside.so'), 'not a real library');
    const view = await new EnvironmentDiagnosticsService({
      nativeRoots: [root],
      nativeExtensions: [
        { id: 'escape', name: 'Escape', kind: 'so', relativePaths: ['../outside.so'], required: true },
        { id: 'wrong-platform', name: 'Wrong platform', kind: 'dll', relativePaths: ['outside.so'], platforms: ['win32'], required: true },
        { id: 'wrong-arch', name: 'Wrong architecture', kind: 'so', relativePaths: ['outside.so'], architectures: ['arm64'], required: true }
      ],
      commands: [],
      platform: 'linux',
      architecture: 'x64'
    }).diagnose();

    expect(view.ready).toBe(false);
    expect(view.components.find((component) => component.id === 'escape')?.reason).toBe('INVALID_NATIVE_PATH');
    expect(view.components.find((component) => component.id === 'wrong-platform')?.reason).toBe('PLATFORM_UNSUPPORTED');
    expect(view.components.find((component) => component.id === 'wrong-arch')?.reason).toBe('ARCHITECTURE_UNSUPPORTED');
  });

  it('covers DSH dist layout, ffmpeg, browsers and worker CLIs, with an explicit system fallback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aibox-env-'));
    mkdirSync(join(root, 'dist', 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'managed-runtime', version: '2.0.0' }));
    writeFileSync(join(root, 'dist', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'export {};');
    const audit: unknown[] = [];
    const view = await new EnvironmentDiagnosticsService({
      managedRuntimeRoot: root,
      commands: [{ id: 'node', name: 'System Node', bin: 'definitely-not-an-aibox-command', kind: 'toolchain' }],
      preferredRuntime: 'system',
      audit: (event) => audit.push(event)
    }).diagnose();

    expect(view.ready).toBe(true);
    expect(view.components.find((component) => component.id === 'dsh-managed-runtime')).toMatchObject({ ready: true, required: true });
    expect(view.components.find((component) => component.id === 'aibox-electron-browser')).toMatchObject({ kind: 'browser', ready: true });
    expect(view.runtimeSelection).toEqual({
      requested: 'system', selected: 'bundled', fallbackUsed: true, reason: 'SYSTEM_NODE_NOT_FOUND'
    });
    expect(view.warnings).toContain('runtime:SYSTEM_NODE_NOT_FOUND');
    expect(audit).toContainEqual(expect.objectContaining({ action: 'runtime.fallback', result: 'degraded', target: 'bundled' }));

    const specs = defaultEnvironmentCommands('win32');
    expect(specs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'ffmpeg', kind: 'media-tool' }),
      expect.objectContaining({ id: 'cli-codex', kind: 'worker-cli' }),
      expect.objectContaining({ id: 'cli-hermes', kind: 'worker-cli' }),
      expect.objectContaining({ id: 'cli-pi', kind: 'worker-cli' }),
      expect.objectContaining({ id: 'browser-edge', kind: 'browser' })
    ]));
  });

  it('selects a worker fallback when an optional native library is unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aibox-env-'));
    const view = await new EnvironmentDiagnosticsService({
      nativeRoots: [root],
      nativeExtensions: [{
        id: 'media-native', name: 'Media accelerator', kind: 'dll', relativePaths: ['media.dll'],
        platforms: ['win32'], architectures: ['x64'], required: true, fallbacks: ['wasm-worker', 'js-worker']
      }],
      commands: [],
      platform: 'win32',
      architecture: 'x64'
    }).diagnose();
    expect(view.ready).toBe(true);
    expect(view.components.find((component) => component.id === 'media-native')).toMatchObject({
      source: 'fallback', ready: true, selectedAdapter: 'wasm-worker', executionBoundary: 'worker-thread',
      reason: 'NATIVE_LIBRARY_MISSING_USING_FALLBACK'
    });
  });
});
