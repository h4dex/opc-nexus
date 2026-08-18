// @ts-nocheck
/* eslint-disable */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const {
  assertPackagedHarness,
  assertPackagedManagedHarness,
  assertManagedWebFrontend,
  assertPackagedMainDependencyEntries,
  REQUIRED_MAIN_DEPENDENCY_PACKAGES,
} = require('../scripts/after-pack.cjs');
const roots: string[] = [];

function context() {
  const appOutDir = join(tmpdir(), `aibox-after-pack-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  roots.push(appOutDir);
  return { appOutDir, electronPlatformName: 'win32' };
}

function writeRuntimeFile(appOutDir: string, relative: string, size = 1) {
  const path = join(appOutDir, 'resources', 'runtime', 'deepseek-harness', relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(size, 1));
}

function writeManagedRuntimeFile(appOutDir: string, relative: string, size = 1) {
  const path = join(appOutDir, 'resources', 'runtime', 'deepseek-harness-managed', relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(size, 1));
}

const MANAGED_REQUIRED_FILES = [
  'node_modules/@deepseek-ai/dsh/lib/bin.js',
  'node_modules/@deepseek-ai/dsh-web-app/lib/index.js',
  'node_modules/@deepseek-ai/dsh-web-frontend/package.json',
  'opc-managed/managed-web.patch.yml',
  'opc-managed/agent-presets/standard/agent.cordis.yml',
  'opc-managed/agent-presets/code/agent.cordis.yml',
  'opc-managed/agent-presets/cordis/agent.cordis.yml',
  'opc-managed/agent-presets/minimal/agent.cordis.yml',
  'capabilities.expected.json',
  'probe-managed-capabilities.mjs',
  'package.json',
  'package-lock.json',
  'README.md',
  'THIRD-PARTY-NOTICES.md',
];

function writeManagedWebUi(appOutDir: string, options: { jsSize?: number; cssSize?: number } = {}) {
  writeManagedRuntimeFile(
    appOutDir,
    'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
    0
  );
  const index = join(
    appOutDir,
    'resources/runtime/deepseek-harness-managed/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html'
  );
  writeFileSync(index, [
    '<script type="module" src="/assets/index.js"></script>',
    '<link rel="stylesheet" href="/assets/index.css">',
  ].join('\n'));
  writeManagedRuntimeFile(
    appOutDir,
    'node_modules/@deepseek-ai/dsh-web-frontend/dist/manifest.webmanifest'
  );
  writeManagedRuntimeFile(
    appOutDir,
    'node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index.js',
    options.jsSize ?? 1
  );
  writeManagedRuntimeFile(
    appOutDir,
    'node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index.css',
    options.cssSize ?? 1
  );
}

function resolvedProductionClosure(rootPackages: string[]): string[] {
  const projectRoot = process.cwd();
  const resolved = new Set<string>();
  const resolvePackage = (from: string, packageName: string): string => {
    let current = from;
    while (true) {
      const candidate = join(current, 'node_modules', ...packageName.split('/'));
      if (existsSync(join(candidate, 'package.json'))) return candidate;
      const parent = dirname(current);
      if (parent === current) throw new Error(`Unable to resolve production dependency ${packageName} from ${from}`);
      current = parent;
    }
  };
  const visit = (packageDirectory: string) => {
    const entry = relative(projectRoot, join(packageDirectory, 'package.json')).split(sep).join('/');
    if (resolved.has(entry)) return;
    resolved.add(entry);
    const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
      visit(resolvePackage(packageDirectory, dependency));
    }
  };
  for (const packageName of rootPackages) visit(resolvePackage(projectRoot, packageName));
  return [...resolved].sort();
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('DeepSeek Harness afterPack guard', () => {
  it('fails when electron-builder filters the sidecar node_modules entry', () => {
    const ctx = context();
    writeRuntimeFile(ctx.appOutDir, 'opc-acp-entry.mjs');
    writeRuntimeFile(ctx.appOutDir, 'config/cordis.yml');

    expect(() => assertPackagedHarness(ctx)).toThrow(/dsh-acp-demo/);
  });

  it('fails when the OPC-owned lifecycle entry is missing', () => {
    const ctx = context();
    writeRuntimeFile(ctx.appOutDir, 'node_modules/@deepseek-ai/dsh-acp-demo/lib/bin.js');
    writeRuntimeFile(ctx.appOutDir, 'config/cordis.yml');

    expect(() => assertPackagedHarness(ctx)).toThrow(/opc-acp-entry/);
  });

  it('accepts a complete, non-trivial packaged runtime', () => {
    const ctx = context();
    const required = [
      'node_modules/@deepseek-ai/dsh-acp-demo/lib/bin.js',
      'opc-acp-entry.mjs',
      'config/cordis.yml',
      'package.json',
      'package-lock.json',
      'README.md',
      'THIRD-PARTY-NOTICES.md',
    ];
    for (const relative of required) writeRuntimeFile(ctx.appOutDir, relative);
    for (let index = 0; index < 100; index += 1) {
      writeRuntimeFile(ctx.appOutDir, `node_modules/pkg-${index}/payload.bin`, index === 0 ? 1024 * 1024 : 1);
    }

    expect(assertPackagedHarness(ctx)).toMatchObject({ files: 107 });
  });
});

describe('Electron Main production dependency closure', () => {
  it('fails when a direct or transitive runtime package is absent from app.asar', () => {
    const withoutSelfsignedTransitive = REQUIRED_MAIN_DEPENDENCY_PACKAGES.filter(
      (entry: string) => entry !== 'node_modules/@peculiar/x509/package.json'
    );
    expect(() => assertPackagedMainDependencyEntries(withoutSelfsignedTransitive)).toThrow(/@peculiar\/x509/);

    const withoutQrTransitive = REQUIRED_MAIN_DEPENDENCY_PACKAGES.filter(
      (entry: string) => entry !== 'node_modules/pngjs/package.json'
    );
    expect(() => assertPackagedMainDependencyEntries(withoutQrTransitive)).toThrow(/pngjs/);

    const withoutAjvTransitive = REQUIRED_MAIN_DEPENDENCY_PACKAGES.filter(
      (entry: string) => entry !== 'node_modules/fast-uri/package.json'
    );
    expect(() => assertPackagedMainDependencyEntries(withoutAjvTransitive)).toThrow(/fast-uri/);
  });

  it('accepts the reviewed physical package closure with either asar path separator', () => {
    const entries = REQUIRED_MAIN_DEPENDENCY_PACKAGES.map((entry: string, index: number) =>
      index % 2 === 0 ? `/${entry}` : `\\${entry.replaceAll('/', '\\')}`
    );
    expect(assertPackagedMainDependencyEntries(entries)).toEqual({
      packages: REQUIRED_MAIN_DEPENDENCY_PACKAGES.length,
    });
  });

  it('keeps every reviewed package reachable from the electron-builder files allowlist', () => {
    const config = readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8');
    const prefixes = [
      ...[...config.matchAll(/^\s*-\s+(node_modules\/[^*\r\n]+)\/\*\*\/?\*?\s*$/gm)]
        .map((match) => match[1]!.replace(/\/$/, '')),
      ...[...config.matchAll(/^\s+to:\s+(node_modules\/[^\r\n]+)\s*$/gm)]
        .map((match) => match[1]!.replace(/\/$/, '')),
    ];
    const uncovered = REQUIRED_MAIN_DEPENDENCY_PACKAGES.filter((entry: string) => {
      const packageDirectory = entry.slice(0, -'/package.json'.length);
      return !prefixes.some((prefix) => {
        if (packageDirectory === prefix) return true;
        if (!packageDirectory.startsWith(`${prefix}/`)) return false;
        return !packageDirectory.slice(prefix.length + 1).split('/').includes('node_modules');
      });
    });
    expect(uncovered).toEqual([]);
  });

  it('tracks the complete installed production graph for selfsigned, qrcode, and ajv', () => {
    expect([...REQUIRED_MAIN_DEPENDENCY_PACKAGES].sort()).toEqual(
      resolvedProductionClosure(['selfsigned', 'qrcode', 'ajv'])
    );
  });
});

describe('managed DeepSeek Harness afterPack guard', () => {
  it('fails when the full Web CLI closure is absent', () => {
    const ctx = context();
    writeManagedRuntimeFile(ctx.appOutDir, 'capabilities.expected.json');
    writeManagedRuntimeFile(ctx.appOutDir, 'probe-managed-capabilities.mjs');

    expect(() => assertPackagedManagedHarness(ctx)).toThrow(/@deepseek-ai.*dsh.*bin\.js/);
  });

  it('fails when the reviewed managed policy is absent', () => {
    const ctx = context();
    const requiredWithoutPolicy = [
      'node_modules/@deepseek-ai/dsh/lib/bin.js',
      'node_modules/@deepseek-ai/dsh-web-app/lib/index.js',
      'node_modules/@deepseek-ai/dsh-web-frontend/package.json',
      'capabilities.expected.json',
      'probe-managed-capabilities.mjs',
      'package.json',
      'package-lock.json',
      'README.md',
      'THIRD-PARTY-NOTICES.md',
    ];
    for (const relative of requiredWithoutPolicy) writeManagedRuntimeFile(ctx.appOutDir, relative);

    expect(() => assertPackagedManagedHarness(ctx)).toThrow(/managed-web\.patch\.yml/);
  });

  it('rejects a frontend package whose official WebUI dist is absent', () => {
    const ctx = context();
    for (const relative of MANAGED_REQUIRED_FILES) writeManagedRuntimeFile(ctx.appOutDir, relative);

    expect(() => assertPackagedManagedHarness(ctx)).toThrow(/dsh-web-frontend.*dist.*index\.html/);
  });

  it('requires non-empty WebUI entry and manifest files', () => {
    const ctx = context();
    const runtime = join(ctx.appOutDir, 'resources', 'runtime', 'deepseek-harness-managed');
    const frontend = 'node_modules/@deepseek-ai/dsh-web-frontend/dist';
    writeManagedWebUi(ctx.appOutDir);
    writeManagedRuntimeFile(ctx.appOutDir, `${frontend}/index.html`, 0);
    expect(() => assertManagedWebFrontend(runtime)).toThrow(/dist\/index\.html.*missing or empty/);

    writeManagedWebUi(ctx.appOutDir);
    writeManagedRuntimeFile(ctx.appOutDir, `${frontend}/manifest.webmanifest`, 0);
    expect(() => assertManagedWebFrontend(runtime)).toThrow(/manifest\.webmanifest.*missing or empty/);
  });

  it('requires index.html to reference non-empty local JavaScript and CSS assets', () => {
    const ctx = context();
    const runtime = join(ctx.appOutDir, 'resources', 'runtime', 'deepseek-harness-managed');
    writeManagedWebUi(ctx.appOutDir, { jsSize: 0 });
    expect(() => assertManagedWebFrontend(runtime)).toThrow(/non-empty referenced \.js asset/);

    writeManagedWebUi(ctx.appOutDir, { cssSize: 0 });
    expect(() => assertManagedWebFrontend(runtime)).toThrow(/non-empty referenced \.css asset/);
  });

  it('rejects encoded asset traversal even when the escaped file exists', () => {
    const ctx = context();
    const runtime = join(ctx.appOutDir, 'resources', 'runtime', 'deepseek-harness-managed');
    const frontend = 'node_modules/@deepseek-ai/dsh-web-frontend';
    writeManagedWebUi(ctx.appOutDir);
    writeManagedRuntimeFile(ctx.appOutDir, `${frontend}/escape.js`);
    writeManagedRuntimeFile(ctx.appOutDir, `${frontend}/dist/index.html`, 0);
    const index = join(runtime, frontend, 'dist', 'index.html');
    writeFileSync(index, [
      '<script type="module" src="/assets%2f..%2f..%2fescape.js"></script>',
      '<link rel="stylesheet" href="/assets/index.css">',
    ].join('\n'));

    expect(() => assertManagedWebFrontend(runtime)).toThrow(/asset escapes dist/);
  });

  it('accepts a complete, non-trivial managed runtime', () => {
    const ctx = context();
    for (const relative of MANAGED_REQUIRED_FILES) writeManagedRuntimeFile(ctx.appOutDir, relative);
    writeManagedWebUi(ctx.appOutDir);
    for (let index = 0; index < 500; index += 1) {
      writeManagedRuntimeFile(ctx.appOutDir, `node_modules/pkg-${index}/payload.bin`, index === 0 ? 5 * 1024 * 1024 : 1);
    }

    expect(assertPackagedManagedHarness(ctx)).toMatchObject({ files: 518 });
  });
});
