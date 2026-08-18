#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

const runtimeRoot = dirname(fileURLToPath(import.meta.url));

function fail(message) {
  throw new Error(`[deepseek-harness-managed] ${message}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function packageRootName(reference) {
  if (typeof reference !== 'string' || reference.length === 0 || reference === 'cordis:group') return null;
  const parts = reference.split('/');
  return reference.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function collectPresetPackages(value, output = new Set()) {
  if (!Array.isArray(value)) fail('managed preset composition must be a YAML array');
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('managed preset row must be an object');
    const name = packageRootName(entry.name);
    if (name) output.add(name);
    if (entry.group === true) collectPresetPackages(entry.config, output);
  }
  return output;
}

function validateManagedPresetRows(value, presetId) {
  if (!Array.isArray(value)) fail(`managed preset ${presetId} composition must be a YAML array`);
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`managed preset ${presetId} row must be an object`);
    }
    if (entry.name === '@deepseek-ai/dsh-plan-mode') {
      if (!entry.config || typeof entry.config !== 'object' || Array.isArray(entry.config)
        || typeof entry.config.section !== 'string' || entry.config.section.trim().length < 40) {
        fail(`managed preset ${presetId} plan-mode requires a reviewed non-empty section`);
      }
    }
    if (entry.name === '@deepseek-ai/dsh-tool-subagent') {
      if (!entry.config || typeof entry.config !== 'object' || Array.isArray(entry.config)
        || entry.config.backgroundMode !== 'continuable' || entry.config.maxDepth !== 2) {
        fail(`managed preset ${presetId} subagent policy must be continuable with maxDepth 2`);
      }
    }
    if (entry.group === true) validateManagedPresetRows(entry.config, presetId);
  }
}

function runtimeCapabilities(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('runtimeCapabilities must be an object');
  const output = {};
  for (const [name, enabled] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(name) || typeof enabled !== 'boolean') {
      fail(`invalid runtime capability ${name}`);
    }
    output[name] = enabled;
  }
  if (Object.keys(output).length === 0) fail('runtimeCapabilities must not be empty');
  return output;
}

export function safeEnvironment(source = process.env) {
  const allowed = new Set([
    'APPDATA', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432',
    'COMSPEC', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'LANG', 'LANGUAGE', 'LC_ALL',
    'LC_CTYPE', 'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT',
    'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432', 'PROGRAMDATA', 'PROGRAMFILES',
    'PROGRAMFILES(X86)', 'PROGRAMW6432', 'SHELL', 'SYSTEMROOT', 'TEMP', 'TMP',
    'TMPDIR', 'TZ', 'USERPROFILE', 'WINDIR'
  ]);
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && allowed.has(key.toUpperCase())) env[key] = value;
  }
  return { ...env, ELECTRON_RUN_AS_NODE: '1' };
}

export function probeManagedCapabilities(root = runtimeRoot) {
  const fixture = readJson(join(root, 'capabilities.expected.json'));
  if (fixture.schemaVersion !== 1) fail(`unsupported capability fixture schema: ${fixture.schemaVersion}`);

  const entry = resolve(root, fixture.runtime.cliEntry);
  const rel = relative(resolve(root), entry);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !existsSync(entry)) {
    fail(`managed CLI entry is missing or outside the runtime: ${fixture.runtime.cliEntry}`);
  }
  const webStartupEntry = resolve(root, fixture.runtime.webStartupEntry);
  const webStartupRel = relative(resolve(root), webStartupEntry);
  if (!webStartupRel || webStartupRel.startsWith('..') || isAbsolute(webStartupRel) || !existsSync(webStartupEntry)) {
    fail(`managed Web startup entry is missing or outside the runtime: ${fixture.runtime.webStartupEntry}`);
  }

  const rootManifest = readJson(join(root, 'package.json'));
  if (rootManifest.dependencies?.[fixture.runtime.package] !== fixture.runtime.version) {
    fail(`${fixture.runtime.package} must be pinned exactly to ${fixture.runtime.version}`);
  }
  const lock = readJson(join(root, 'package-lock.json'));
  const lockedDsh = lock.packages?.['node_modules/@deepseek-ai/dsh'];
  if (lockedDsh?.version !== fixture.runtime.version || lockedDsh?.integrity !== fixture.runtime.integrity) {
    fail(`${fixture.runtime.package} lock entry does not match the reviewed version and integrity`);
  }

  const packages = {};
  for (const [capability, names] of Object.entries(fixture.capabilityPackages)) {
    packages[capability] = Object.fromEntries(names.map((name) => {
      const packageVersion = packageVersionAt(root, name);
      if (packageVersion !== fixture.runtime.version) {
        fail(`${name} resolved to ${packageVersion}; expected ${fixture.runtime.version}`);
      }
      return [name, packageVersion];
    }));
  }

  const version = runCliAt(root, entry, ['--version']).trim();
  if (version !== fixture.cli.version) fail(`dsh --version returned ${JSON.stringify(version)}`);
  const help = runCliAt(root, entry, ['--help']);
  for (const token of fixture.cli.helpTokens) {
    if (!help.includes(token)) fail(`dsh --help is missing reviewed token: ${token}`);
  }

  const dshManifest = readJson(packagePathAt(root, fixture.runtime.package));
  const webManifest = readJson(packagePathAt(root, '@deepseek-ai/dsh-web-app'));
  const dependencyText = JSON.stringify({
    dsh: dshManifest.dependencies ?? {},
    web: webManifest.dependencies ?? {}
  });
  for (const token of fixture.cli.webProfileTokens) {
    if (!dependencyText.includes(token)) fail(`managed Web dependency contract is missing: ${token}`);
  }
  const webStartupSource = readFileSync(webStartupEntry, 'utf8');
  for (const token of fixture.cli.webStartupTokens) {
    if (!webStartupSource.includes(token)) fail(`managed Web startup contract is missing: ${token}`);
  }

  const policyPatch = resolve(root, fixture.runtime.managedPolicyPatch);
  const policyPatchRel = relative(resolve(root), policyPatch);
  if (!policyPatchRel || policyPatchRel.startsWith('..') || isAbsolute(policyPatchRel) || !existsSync(policyPatch)) {
    fail(`managed policy patch is missing or outside the runtime: ${fixture.runtime.managedPolicyPatch}`);
  }
  const patchSource = readFileSync(policyPatch, 'utf8');
  for (const token of fixture.managedPolicy.requiredPatchTokens) {
    if (!patchSource.includes(token)) fail(`managed policy patch is missing reviewed token: ${token}`);
  }
  const presetRoot = resolve(root, fixture.runtime.managedPresetRoot);
  const presetRootRel = relative(resolve(root), presetRoot);
  if (!presetRootRel || presetRootRel.startsWith('..') || isAbsolute(presetRootRel) || !existsSync(presetRoot)) {
    fail(`managed preset root is missing or outside the runtime: ${fixture.runtime.managedPresetRoot}`);
  }
  const authorizedPresetPackages = new Set(fixture.managedPolicy.authorizedPresetPackages);
  const presetPackages = {};
  for (const id of fixture.managedPolicy.shadowedPresetIds) {
    const composition = join(presetRoot, id, 'agent.cordis.yml');
    if (!existsSync(composition)) fail(`managed preset is missing: ${id}`);
    const source = readFileSync(composition, 'utf8');
    const installed = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'config', 'agent-presets', id, 'agent.cordis.yml');
    if (!existsSync(installed) || readFileSync(installed, 'utf8') !== source) {
      fail(`managed preset is not installed over the reviewed upstream preset: ${id}`);
    }
    for (const forbidden of fixture.managedPolicy.forbiddenPresetPackages) {
      if (source.includes(forbidden)) fail(`managed preset ${id} exposes forbidden package: ${forbidden}`);
    }
    for (const token of fixture.managedPolicy.requiredPresetTokens) {
      if (!source.includes(token)) fail(`managed preset ${id} is missing reviewed capability token: ${token}`);
    }
    let parsed;
    try {
      parsed = loadYaml(source);
    } catch (error) {
      fail(`managed preset ${id} is invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
    }
    validateManagedPresetRows(parsed, id);
    const packages = [...collectPresetPackages(parsed)].sort();
    for (const name of packages) {
      if (!authorizedPresetPackages.has(name)) fail(`managed preset ${id} exposes unreviewed package: ${name}`);
    }
    presetPackages[id] = packages;
  }

  const authorizedCapabilities = runtimeCapabilities(fixture.runtimeCapabilities);

  return {
    schemaVersion: fixture.schemaVersion,
    runtime: {
      package: fixture.runtime.package,
      version,
      entry: rel.replaceAll('\\', '/'),
      webStartupEntry: webStartupRel.replaceAll('\\', '/'),
      managedPolicyPatch: policyPatchRel.replaceAll('\\', '/'),
      managedPresetRoot: presetRootRel.replaceAll('\\', '/')
    },
    capabilities: packages,
    managedProfile: {
      authorizedCapabilities,
      presetPackages
    }
  };
}

function packagePathAt(root, name) {
  return join(root, 'node_modules', ...name.split('/'), 'package.json');
}

function packageVersionAt(root, name) {
  const path = packagePathAt(root, name);
  if (!existsSync(path)) fail(`required capability package is missing: ${name}`);
  const manifest = readJson(path);
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    fail(`capability package has no version: ${name}`);
  }
  return manifest.version;
}

function runCliAt(root, entry, args) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    env: safeEnvironment()
  });
  if (result.error) fail(`dsh ${args.join(' ')} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`dsh ${args.join(' ')} failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  }
  return result.stdout;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = probeManagedCapabilities();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
