// @ts-nocheck
/* eslint-disable */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  probeManagedCapabilities,
  safeEnvironment,
} from '../runtime/deepseek-harness-managed/probe-managed-capabilities.mjs';

const require = createRequire(import.meta.url);
const {
  DSH_INTEGRITY,
  DSH_VERSION,
  HOST_APIPROXY_PATCHED_SHA256,
  HOST_APIPROXY_UPSTREAM_SHA256,
  MIN_NPM_VERSION,
  NPM_CACHE_ROOT,
  NPM_CI_ARGS,
  assertSupportedNpmVersion,
  npmEnvironment,
  patchDshHostApiProxySource,
  verifyDependencyClosure,
} = require('../scripts/prepare-deepseek-harness-managed.cjs');
const roots: string[] = [];

function makeRoot() {
  const root = join(tmpdir(), `aibox-managed-harness-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  roots.push(root);
  mkdirSync(root, { recursive: true });
  return root;
}

function writeJson(path: string, value: unknown) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function packagePath(root: string, name: string) {
  return join(root, 'node_modules', ...name.split('/'));
}

function makeProbeRuntime() {
  const root = makeRoot();
  const fixture = JSON.parse(readFileSync(
    join(process.cwd(), 'runtime', 'deepseek-harness-managed', 'capabilities.expected.json'),
    'utf8',
  ));
  writeJson(join(root, 'capabilities.expected.json'), fixture);
  writeJson(join(root, 'package.json'), { dependencies: { '@deepseek-ai/dsh': DSH_VERSION } });
  writeJson(join(root, 'package-lock.json'), {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { '@deepseek-ai/dsh': DSH_VERSION } },
      'node_modules/@deepseek-ai/dsh': {
        version: DSH_VERSION,
        integrity: DSH_INTEGRITY,
        license: 'MIT',
      },
    },
  });

  const packageNames = new Set(Object.values(fixture.capabilityPackages).flat());
  packageNames.add('@deepseek-ai/dsh');
  packageNames.add('@deepseek-ai/dsh-web-app');
  for (const name of packageNames) {
    writeJson(join(packagePath(root, name), 'package.json'), {
      name,
      version: DSH_VERSION,
      type: 'module',
      license: 'MIT',
      dependencies: {},
    });
  }
  writeJson(join(packagePath(root, '@deepseek-ai/dsh'), 'package.json'), {
    name: '@deepseek-ai/dsh',
    version: DSH_VERSION,
    type: 'module',
    license: 'MIT',
    dependencies: { '@deepseek-ai/dsh-web-app': `^${DSH_VERSION}` },
  });
  writeJson(join(packagePath(root, '@deepseek-ai/dsh-web-app'), 'package.json'), {
    name: '@deepseek-ai/dsh-web-app',
    version: DSH_VERSION,
    type: 'module',
    license: 'MIT',
    dependencies: {
      '@deepseek-ai/dsh-host-webserver': `^${DSH_VERSION}`,
      '@deepseek-ai/dsh-web-frontend': `^${DSH_VERSION}`,
    },
  });
  const cli = join(packagePath(root, '@deepseek-ai/dsh'), 'lib', 'bin.js');
  mkdirSync(join(cli, '..'), { recursive: true });
  writeFileSync(cli, [
    "const args = process.argv.slice(2);",
    `if (args.includes('--version')) console.log('${DSH_VERSION}');`,
    "else console.log('--profile <name> web --dump-default-config');",
  ].join('\n'), 'utf8');
  const startup = join(packagePath(root, '@deepseek-ai/dsh-web-app'), 'lib', 'startup.js');
  mkdirSync(join(startup, '..'), { recursive: true });
  writeFileSync(startup, [
    'const flags = "--host <host> --port <port> --trusted-host <authority...>";',
    'if (options.host === "0.0.0.0") throw new Error("use 127.0.0.1 instead");',
  ].join('\n'), 'utf8');
  const managedRoot = join(root, 'opc-managed');
  mkdirSync(join(managedRoot, 'agent-presets'), { recursive: true });
  writeFileSync(
    join(managedRoot, 'managed-web.patch.yml'),
    fixture.managedPolicy.requiredPatchTokens.join('\n'),
    'utf8',
  );
  for (const id of fixture.managedPolicy.shadowedPresetIds) {
    const preset = join(managedRoot, 'agent-presets', id);
    mkdirSync(preset, { recursive: true });
    const content = readFileSync(
      join(process.cwd(), 'runtime', 'deepseek-harness-managed', 'opc-managed', 'agent-presets', id, 'agent.cordis.yml'),
      'utf8',
    );
    writeFileSync(join(preset, 'agent.cordis.yml'), content, 'utf8');
    const installed = join(packagePath(root, '@deepseek-ai/dsh'), 'config', 'agent-presets', id);
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, 'agent.cordis.yml'), content, 'utf8');
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('managed DeepSeek Harness prepare policy', () => {
  it('applies the reviewed optional directory-picker API patch deterministically', () => {
    const source = [
      '\t\t\tasync pickDirectory(request, signal) {',
      '\t\t\t\tconst capability = ctx.directoryPicker.capability();',
      '\t\t\tasync listDirectory(request, signal) {',
      '\t\t\t\tconst capability = ctx.directoryPicker.capability();',
      '\t\t\tasync createDirectory(request) {',
      '\t\t\t\tconst capability = ctx.directoryPicker.capability();',
      '\t\t"attachments",',
      '\t\t"directoryPicker",',
      '\t\t"llm",',
    ].join('\n');
    const patched = patchDshHostApiProxySource(source);
    expect(HOST_APIPROXY_UPSTREAM_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(HOST_APIPROXY_PATCHED_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(patched.match(/ctx\.get\("directoryPicker"\)/g)).toHaveLength(3);
    expect(patched.match(/details: \{ capability: "none" \}/g)).toHaveLength(3);
    expect(patched).not.toContain('\t\t"directoryPicker",');
    expect(() => patchDshHostApiProxySource(source.replace(
      'ctx.directoryPicker.capability()',
      'ctx.changedDirectoryPicker.capability()',
    ))).toThrow(/reviewed .* pickDirectory patch/);
  });

  it('pins the npm script policy used by the existing ACP runtime', () => {
    const manifest = JSON.parse(readFileSync(
      join(process.cwd(), 'runtime', 'deepseek-harness-managed', 'package.json'),
      'utf8',
    ));
    expect(MIN_NPM_VERSION).toEqual([11, 16, 0]);
    expect(() => assertSupportedNpmVersion('11.15.9')).toThrow(/npm >=11\.16\.0/);
    expect(() => assertSupportedNpmVersion('11.16.0')).not.toThrow();
    expect(NPM_CI_ARGS).toContain('--strict-allow-scripts');
    expect(NPM_CI_ARGS).toContain('--dangerously-allow-all-scripts=false');
    expect(manifest.allowScripts).toEqual({
      '@deepseek-ai/dsh-subprocess-local@0.1.0-rc.6': true,
      '@google/genai@1.52.0': false,
      'koffi@3.1.5': true,
      'node-pty@1.1.0': true,
      'protobufjs@7.6.5': false,
    });
  });

  it('does not forward credentials or Node injection into npm and probes', () => {
    const source = {
      Path: 'C:\\runtime-bin',
      TEMP: 'C:\\Temp',
      GITHUB_TOKEN: 'secret',
      DEEPSEEK_API_KEY: 'provider-secret',
      NODE_OPTIONS: '--require malicious.cjs',
      npm_config_allow_scripts: 'anything',
      npm_config_cache: 'C:\\untrusted-cache',
    };
    expect(npmEnvironment(source)).toMatchObject({ Path: 'C:\\runtime-bin', TEMP: 'C:\\Temp' });
    expect(npmEnvironment(source)).toHaveProperty('npm_config_cache', NPM_CACHE_ROOT);
    expect(NPM_CACHE_ROOT).toBe(join(process.cwd(), 'runtime', 'deepseek-harness-managed', '.npm-cache'));
    expect(npmEnvironment(source)).not.toHaveProperty('GITHUB_TOKEN');
    expect(npmEnvironment(source)).not.toHaveProperty('NODE_OPTIONS');
    expect(safeEnvironment(source)).toEqual({
      Path: 'C:\\runtime-bin',
      TEMP: 'C:\\Temp',
      ELECTRON_RUN_AS_NODE: '1',
    });
  });

  it('probes the reviewed CLI, Web and long-task capability package contract', () => {
    const report = probeManagedCapabilities(makeProbeRuntime());
    expect(report.runtime).toMatchObject({ package: '@deepseek-ai/dsh', version: DSH_VERSION });
    expect(report.capabilities.web).toHaveProperty('@deepseek-ai/dsh-web-app', DSH_VERSION);
    expect(report.capabilities.multiAgent).toHaveProperty('@deepseek-ai/dsh-subagent', DSH_VERSION);
    expect(report.capabilities.durableWork).toHaveProperty('@deepseek-ai/dsh-tool-jobs', DSH_VERSION);
    expect(report.runtime.managedPolicyPatch).toBe('opc-managed/managed-web.patch.yml');
    expect(report.managedProfile.authorizedCapabilities).toMatchObject({
      goals: true,
      jobs: true,
      subagents: true,
      shell: false,
      filesystem: true,
      network: false,
    });
    expect(report.managedProfile.presetPackages.standard).toContain('@deepseek-ai/dsh-tool-subagent');
  });

  it('fails closed when a managed preset loses a required capability or adds an unreviewed plugin', () => {
    const root = makeProbeRuntime();
    const preset = join(root, 'opc-managed', 'agent-presets', 'standard', 'agent.cordis.yml');
    const installed = join(packagePath(root, '@deepseek-ai/dsh'), 'config', 'agent-presets', 'standard', 'agent.cordis.yml');
    const source = readFileSync(preset, 'utf8');
    const missingGoal = source.replace("name: '@deepseek-ai/dsh-tool-goal'", "name: '@deepseek-ai/dsh-tool-ask-user'");
    writeFileSync(preset, missingGoal, 'utf8');
    writeFileSync(installed, missingGoal, 'utf8');
    expect(() => probeManagedCapabilities(root)).toThrow(/missing reviewed capability token.*tool-goal/s);

    const unreviewed = `${source}\n- id: extra\n  name: '@deepseek-ai/dsh-tool-web'\n`;
    writeFileSync(preset, unreviewed, 'utf8');
    writeFileSync(installed, unreviewed, 'utf8');
    expect(() => probeManagedCapabilities(root)).toThrow(/forbidden package.*tool-web/s);
  });

  it('rejects a preset whose plan-mode package is present but cannot mount', () => {
    const root = makeProbeRuntime();
    const preset = join(root, 'opc-managed', 'agent-presets', 'standard', 'agent.cordis.yml');
    const installed = join(packagePath(root, '@deepseek-ai/dsh'), 'config', 'agent-presets', 'standard', 'agent.cordis.yml');
    const source = readFileSync(preset, 'utf8');
    const invalid = source.replace(
      /section: \|\r?\n\s+You are in Quest planning mode\.[^\r\n]*/,
      "section: ''",
    );
    expect(invalid).not.toBe(source);
    writeFileSync(preset, invalid, 'utf8');
    writeFileSync(installed, invalid, 'utf8');

    expect(() => probeManagedCapabilities(root)).toThrow(/plan-mode requires a reviewed non-empty section/);
  });

  it('requires Nexus-owned credentials, settings, model routing, and workspace selection in the managed policy', () => {
    const root = makeProbeRuntime();
    const patch = join(root, 'opc-managed', 'managed-web.patch.yml');
    const source = readFileSync(patch, 'utf8');
    writeFileSync(patch, source.replace('- id: credentials\n  disabled: true', ''), 'utf8');
    expect(() => probeManagedCapabilities(root)).toThrow(/managed policy patch.*credentials/s);

    writeFileSync(patch, source.replace('- id: directory-picker\n  disabled: true', ''), 'utf8');
    expect(() => probeManagedCapabilities(root)).toThrow(/managed policy patch.*directory-picker/s);
  });

  it('rejects a lock entry whose reviewed DSH integrity changed', () => {
    const root = makeRoot();
    writeJson(join(root, 'package-lock.json'), {
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { '@deepseek-ai/dsh': DSH_VERSION } },
        'node_modules/@deepseek-ai/dsh': {
          version: DSH_VERSION,
          integrity: 'sha512-tampered',
          license: 'MIT',
        },
      },
    });
    writeJson(join(packagePath(root, '@deepseek-ai/dsh'), 'package.json'), {
      name: '@deepseek-ai/dsh', version: DSH_VERSION, license: 'MIT',
    });
    expect(() => verifyDependencyClosure(root)).toThrow(/reviewed version and integrity/);
  });
});
