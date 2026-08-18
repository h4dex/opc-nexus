/**
 * Host environment diagnostics for the bundled runtime and optional native
 * extensions. Detection is deliberately non-invasive: commands are probed
 * with fixed argv and native libraries are checked as regular files only.
 * Nothing here dlopens, imports, or executes a DLL/SO/Node addon.
 */
import { execFile } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  EnvironmentComponentView,
  EnvironmentDiagnosticsView,
  NativeExtensionDeclaration,
  RuntimePreference
} from '../../shared/types.js';

const execFileAsync = promisify(execFile);
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const MAX_VERSION_LENGTH = 128;
const MAX_PATHS = 16;
const MAX_COMPONENTS = 128;
const MAX_WARNINGS = 64;

export interface EnvironmentCommandSpec {
  id: string;
  name: string;
  bin: string;
  args?: string[];
  required?: boolean;
  kind?: EnvironmentComponentView['kind'];
}

export interface EnvironmentDiagnosticAuditEvent {
  action: 'diagnose' | 'runtime.fallback';
  result: 'ok' | 'degraded';
  target: string;
  reason?: string;
}

export interface EnvironmentDiagnosticsOptions {
  managedRuntimeRoot?: string;
  nativeRoots?: string[];
  nativeExtensions?: NativeExtensionDeclaration[];
  commands?: EnvironmentCommandSpec[];
  now?: () => number;
  platform?: NodeJS.Platform;
  architecture?: string;
  electronVersion?: string;
  nodeVersion?: string;
  preferredRuntime?: RuntimePreference;
  audit?: (event: EnvironmentDiagnosticAuditEvent) => void;
}

export function defaultEnvironmentCommands(platform: NodeJS.Platform = process.platform): EnvironmentCommandSpec[] {
  const browsers: EnvironmentCommandSpec[] = platform === 'win32'
    ? [
        { id: 'browser-edge', name: 'Microsoft Edge', bin: 'msedge', args: ['--version'], kind: 'browser' },
        { id: 'browser-chrome', name: 'Google Chrome', bin: 'chrome', args: ['--version'], kind: 'browser' }
      ]
    : platform === 'darwin'
      ? [{ id: 'browser-chrome', name: 'Google Chrome', bin: 'google-chrome', args: ['--version'], kind: 'browser' }]
      : [
          { id: 'browser-chrome', name: 'Google Chrome', bin: 'google-chrome', args: ['--version'], kind: 'browser' },
          { id: 'browser-chromium', name: 'Chromium', bin: 'chromium', args: ['--version'], kind: 'browser' }
        ];
  return [
    { id: 'node', name: '系统 Node.js', bin: 'node', args: ['--version'], kind: 'toolchain' },
    { id: 'npm', name: 'npm', bin: 'npm', args: ['--version'], kind: 'toolchain' },
    { id: 'python', name: 'Python', bin: platform === 'win32' ? 'python' : 'python3', args: ['--version'], kind: 'toolchain' },
    { id: 'git', name: 'Git', bin: 'git', args: ['--version'], kind: 'toolchain' },
    { id: 'ffmpeg', name: 'FFmpeg', bin: 'ffmpeg', args: ['-version'], kind: 'media-tool' },
    { id: 'cli-codex', name: 'OpenAI Codex CLI', bin: 'codex', args: ['--version'], kind: 'worker-cli' },
    { id: 'cli-hermes', name: 'Hermes Agent CLI', bin: 'hermes', args: ['--version'], kind: 'worker-cli' },
    { id: 'cli-pi', name: 'Pi CLI', bin: 'pi', args: ['--version'], kind: 'worker-cli' },
    { id: 'cli-claude', name: 'Claude Code CLI', bin: 'claude', args: ['--version'], kind: 'worker-cli' },
    { id: 'cli-opencode', name: 'OpenCode CLI', bin: 'opencode', args: ['--version'], kind: 'worker-cli' },
    ...browsers
  ];
}

function bounded(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value !== value.trim()) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function regularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function regularDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function safeRelativePath(root: string, child: string): string | null {
  if (!child || isAbsolute(child)) return null;
  const target = resolve(root, child);
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  let current = root;
  for (const segment of rel.split(/[\\/]+/)) {
    if (!segment) continue;
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) return null;
    } catch {
      // Missing path is reported by the caller; it is not an escape.
      break;
    }
  }
  return target;
}

function nativeExtensionMatchesPlatform(declaration: NativeExtensionDeclaration, platform: NodeJS.Platform): boolean {
  return !declaration.platforms || declaration.platforms.length === 0 || declaration.platforms.includes(platform);
}

function nativeExtensionMatchesArchitecture(declaration: NativeExtensionDeclaration, architecture: string): boolean {
  return !declaration.architectures || declaration.architectures.length === 0 || declaration.architectures.includes(architecture);
}

function extensionAllowed(path: string, kind: NativeExtensionDeclaration['kind'], platform: NodeJS.Platform): boolean {
  const extension = extname(path).toLowerCase();
  const filename = path.toLowerCase();
  if (kind === 'dll') return extension === '.dll';
  if (kind === 'so') return extension === '.so' || /\.so(?:\.[0-9.]+)?$/.test(filename);
  if (kind === 'dylib') return extension === '.dylib';
  if (kind === 'node-addon') return extension === '.node';
  if (platform === 'win32') return extension === '.dll' || extension === '.node';
  if (platform === 'darwin') return extension === '.dylib' || extension === '.node';
  return extension === '.so' || extension === '.node' || /\.so(?:\.[0-9.]+)?$/.test(filename);
}

async function locateExecutable(bin: string): Promise<string | null> {
  // `where`/`which` are fixed executable names and the user-controlled value
  // is passed as an argv element with shell disabled.
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const result = await execFileAsync(locator, [bin], { shell: false, timeout: 4_000, windowsHide: true, maxBuffer: 32 * 1024 });
    const first = String(result.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return first ? first.slice(0, 2_048) : null;
  } catch {
    return null;
  }
}

async function probeCommand(spec: EnvironmentCommandSpec): Promise<EnvironmentComponentView> {
  const id = bounded(spec.id, 128) && IDENTIFIER.test(spec.id) ? spec.id : 'invalid-command';
  const name = bounded(spec.name, 160) ?? id;
  const bin = bounded(spec.bin, 256);
  const kind = spec.kind && ['toolchain', 'worker-cli', 'media-tool', 'browser'].includes(spec.kind)
    ? spec.kind
    : 'toolchain';
  if (!bin || /[\\/]/.test(bin)) {
    return { id, name, kind, source: 'missing', available: false, ready: false, required: spec.required === true, version: null, path: null, reason: 'INVALID_COMMAND' };
  }
  const path = await locateExecutable(bin);
  if (!path) {
    return { id, name, kind, source: 'missing', available: false, ready: false, required: spec.required === true, version: null, path: null, reason: 'NOT_FOUND' };
  }
  let version: string | null = null;
  try {
    const result = await execFileAsync(path, spec.args ?? ['--version'], { shell: false, timeout: 8_000, windowsHide: true, maxBuffer: 64 * 1024 });
    const output = `${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`.trim();
    version = bounded(output.split(/\r?\n/).find(Boolean) ?? '', MAX_VERSION_LENGTH);
  } catch {
    // A present executable that cannot answer its version is degraded rather
    // than hidden, so the user can see why a runtime switch may be needed.
    return { id, name, kind, source: 'system', available: true, ready: false, required: spec.required === true, version: null, path, reason: 'VERSION_PROBE_FAILED' };
  }
  return { id, name, kind, source: 'system', available: true, ready: true, required: spec.required === true, version, path, reason: null };
}

function bundledComponents(options: EnvironmentDiagnosticsOptions, platform: NodeJS.Platform, architecture: string): EnvironmentComponentView[] {
  const components: EnvironmentComponentView[] = [{
    id: 'aibox-electron-node',
    name: 'AI Box 内置 Node.js',
    kind: 'runtime',
    source: 'bundled',
    available: true,
    ready: true,
    required: true,
    version: options.nodeVersion ?? process.versions.node ?? null,
    path: process.execPath ?? null,
    reason: null
  }, {
    id: 'aibox-electron-browser',
    name: 'Electron Chromium',
    kind: 'browser',
    source: 'bundled',
    available: true,
    ready: true,
    required: true,
    version: process.versions.chrome ?? options.electronVersion ?? null,
    path: process.execPath ?? null,
    reason: null
  }];
  if (!options.managedRuntimeRoot) return components;
  const root = resolve(options.managedRuntimeRoot);
  const manifestPath = join(root, 'package.json');
  let version: string | null = null;
  let validManifest = false;
  if (regularDirectory(root) && regularFile(manifestPath)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown };
      version = bounded(parsed.version, MAX_VERSION_LENGTH);
      validManifest = version !== null;
    } catch {
      validManifest = false;
    }
  }
  const dependencyRoots = [join(root, 'dist', 'node_modules'), join(root, 'node_modules')];
  const nodeModules = dependencyRoots.find(regularDirectory) ?? dependencyRoots[0];
  const runtimeEntry = join(nodeModules, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  const ready = validManifest && regularDirectory(nodeModules) && regularFile(runtimeEntry);
  components.push({
    id: 'dsh-managed-runtime',
    name: 'DSH/Cordis 内置运行时',
    kind: 'runtime',
    source: 'bundled',
    available: validManifest,
    ready,
    required: true,
    version,
    path: validManifest ? root : null,
    reason: !regularDirectory(root)
      ? 'RUNTIME_ROOT_MISSING'
      : !validManifest
        ? 'RUNTIME_MANIFEST_INVALID'
        : !regularDirectory(nodeModules)
          ? 'RUNTIME_DEPENDENCIES_MISSING'
          : ready ? null : 'RUNTIME_ENTRY_MISSING'
  });
  // Keep parameters used to make platform/architecture intent explicit in
  // this pure diagnostic helper; native declarations are checked below.
  void platform;
  void architecture;
  return components;
}

function nativeComponents(
  options: EnvironmentDiagnosticsOptions,
  platform: NodeJS.Platform,
  architecture: string,
  roots: string[]
): EnvironmentComponentView[] {
  const declarations = options.nativeExtensions ?? [];
  const output: EnvironmentComponentView[] = [];
  for (const declaration of declarations.slice(0, MAX_COMPONENTS)) {
    const id = bounded(declaration.id, 128);
    const name = bounded(declaration.name, 160);
    const required = declaration.required === true;
    const fallbacks = Array.isArray(declaration.fallbacks)
      ? declaration.fallbacks.filter((item, index, all) => (item === 'wasm-worker' || item === 'js-worker') && all.indexOf(item) === index)
      : [];
    const fallback = fallbacks[0] ?? null;
    if (!id || !IDENTIFIER.test(id) || !name || !Array.isArray(declaration.relativePaths) || declaration.relativePaths.length === 0
      || (declaration.fallbacks !== undefined && fallbacks.length !== declaration.fallbacks.length)) {
      output.push({ id: id ?? 'invalid-native-extension', name: name ?? 'Invalid native extension', kind: 'native-addon', source: 'missing', available: false, ready: false, required, version: null, path: null, reason: 'INVALID_DECLARATION' });
      continue;
    }
    if (!nativeExtensionMatchesPlatform(declaration, platform)) {
      output.push(fallback
        ? { id, name, kind: 'native-addon', source: 'fallback', available: true, ready: true, required, version: null, path: null, reason: 'PLATFORM_UNSUPPORTED_USING_FALLBACK', selectedAdapter: fallback, executionBoundary: 'worker-thread' }
        : { id, name, kind: 'native-addon', source: 'declared', available: false, ready: false, required, version: null, path: null, reason: 'PLATFORM_UNSUPPORTED', selectedAdapter: null, executionBoundary: null });
      continue;
    }
    if (!nativeExtensionMatchesArchitecture(declaration, architecture)) {
      output.push(fallback
        ? { id, name, kind: 'native-addon', source: 'fallback', available: true, ready: true, required, version: null, path: null, reason: 'ARCHITECTURE_UNSUPPORTED_USING_FALLBACK', selectedAdapter: fallback, executionBoundary: 'worker-thread' }
        : { id, name, kind: 'native-addon', source: 'declared', available: false, ready: false, required, version: null, path: null, reason: 'ARCHITECTURE_UNSUPPORTED', selectedAdapter: null, executionBoundary: null });
      continue;
    }
    let found: string | null = null;
    let invalidPath = false;
    for (const root of roots) {
      const trustedRoot = resolve(root);
      if (!regularDirectory(trustedRoot)) continue;
      for (const child of declaration.relativePaths.slice(0, MAX_PATHS)) {
        const target = safeRelativePath(trustedRoot, child);
        if (!target) { invalidPath = true; continue; }
        if (regularFile(target) && extensionAllowed(target, declaration.kind, platform)) {
          found = target;
          break;
        }
      }
      if (found) break;
    }
    output.push({
      id,
      name,
      kind: 'native-addon',
      source: found ? 'declared' : fallback ? 'fallback' : 'missing',
      available: found !== null || fallback !== null,
      ready: found !== null || fallback !== null,
      required,
      version: null,
      path: found,
      reason: found ? null : invalidPath ? 'INVALID_NATIVE_PATH' : fallback ? 'NATIVE_LIBRARY_MISSING_USING_FALLBACK' : 'NATIVE_LIBRARY_MISSING',
      selectedAdapter: found ? 'native-worker' : fallback,
      executionBoundary: found ? 'utility-process' : fallback ? 'worker-thread' : null
    });
  }
  return output;
}

export class EnvironmentDiagnosticsService {
  private readonly now: () => number;

  constructor(private readonly options: EnvironmentDiagnosticsOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  async diagnose(): Promise<EnvironmentDiagnosticsView> {
    const platform = this.options.platform ?? process.platform;
    const architecture = this.options.architecture ?? process.arch;
    const components = bundledComponents(this.options, platform, architecture);
    const commands = this.options.commands ?? defaultEnvironmentCommands(platform);
    const probed = await Promise.all(commands.slice(0, MAX_COMPONENTS).map((command) => probeCommand(command)));
    components.push(...probed);
    const roots = (this.options.nativeRoots ?? [
      ...(typeof process.resourcesPath === 'string' ? [process.resourcesPath] : []),
      process.cwd()
    ]).filter((root) => typeof root === 'string' && root.length > 0);
    components.push(...nativeComponents(this.options, platform, architecture, roots));
    const requested = this.options.preferredRuntime ?? 'bundled';
    const systemNode = components.find((component) => component.id === 'node');
    const fallbackUsed = requested === 'system' && systemNode?.ready !== true;
    const runtimeSelection = {
      requested,
      selected: fallbackUsed ? 'bundled' as const : requested,
      fallbackUsed,
      reason: fallbackUsed ? `SYSTEM_NODE_${systemNode?.reason ?? 'NOT_FOUND'}` : null
    };
    const warnings: string[] = [];
    for (const component of components) {
      if (component.required && !component.ready) warnings.push(`${component.id}:${component.reason ?? 'NOT_READY'}`);
    }
    if (runtimeSelection.fallbackUsed) warnings.push(`runtime:${runtimeSelection.reason}`);
    if (warnings.length > MAX_WARNINGS) warnings.splice(MAX_WARNINGS);
    const view: EnvironmentDiagnosticsView = {
      scannedAt: this.now(),
      platform,
      architecture,
      electronVersion: this.options.electronVersion ?? process.versions.electron ?? 'unknown',
      nodeVersion: this.options.nodeVersion ?? process.versions.node ?? 'unknown',
      ready: components.every((component) => !component.required || component.ready),
      runtimeSelection,
      components: components.slice(0, MAX_COMPONENTS),
      warnings
    };
    try {
      if (runtimeSelection.fallbackUsed) {
        this.options.audit?.({ action: 'runtime.fallback', result: 'degraded', target: runtimeSelection.selected, reason: runtimeSelection.reason ?? undefined });
      }
      this.options.audit?.({ action: 'diagnose', result: view.ready ? 'ok' : 'degraded', target: 'environment' });
    } catch { /* diagnostics must remain available if audit persistence fails */ }
    return view;
  }
}

export async function diagnoseEnvironment(options: EnvironmentDiagnosticsOptions = {}): Promise<EnvironmentDiagnosticsView> {
  return new EnvironmentDiagnosticsService(options).diagnose();
}
