'use strict';

const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { dirname, isAbsolute, join, relative, resolve } = require('node:path');

const REPO_ROOT = resolve(__dirname, '..');
const SOURCE_ROOT = join(REPO_ROOT, 'runtime', 'deepseek-harness-managed');
const DIST_ROOT = join(SOURCE_ROOT, 'dist');
const STAGE_ROOT = join(SOURCE_ROOT, `.dist-stage-${process.pid}`);
const BACKUP_ROOT = join(SOURCE_ROOT, `.dist-backup-${process.pid}`);
const NPM_CACHE_ROOT = join(SOURCE_ROOT, '.npm-cache');
const DSH_PACKAGE = '@deepseek-ai/dsh';
const DSH_VERSION = '0.1.0-rc.6';
const DSH_INTEGRITY = 'sha512-brpZfED7ieRa2PQ5tUxMhHrM1pb2CmKFVM/f6yMULBDMicahk+Z2OsHgTwTDnoiZm23Ftu9rQz0NN4pflaoJcg==';
const REQUIRED_FILES = [
  'package.json',
  'package-lock.json',
  'capabilities.expected.json',
  'probe-managed-capabilities.mjs',
  'README.md',
  'THIRD-PARTY-NOTICES.md',
];
const REQUIRED_DIRECTORIES = ['opc-managed'];
const MANAGED_PRESET_UPSTREAM_SHA256 = Object.freeze({
  code: '749da0d93d3824bc4a227b6ead38c99b4247e63108e48bd5fc661b463da00077',
  cordis: '16ad73eabe064f33056924c7157b944a74425ce9b6b5e9b8d910d369d9e15ed8',
  minimal: 'cacb47f09a88985c8eb0906a62e6883205727a3c8db901807cb03f936b863cca',
  standard: 'cb98756a9ed76ca351a45a0ba138a97bf0ab7eead4fe2f1e9d1c9f9ec97937f0',
});
const MIN_NPM_VERSION = [11, 16, 0];
const NPM_CI_ARGS = Object.freeze([
  'ci',
  '--omit=dev',
  '--no-audit',
  '--no-fund',
  '--ignore-scripts=false',
  '--strict-allow-scripts',
  '--dangerously-allow-all-scripts=false',
]);
const NPM_POLICY_ENV_KEYS = new Set([
  'npm_config_allow_scripts',
  'npm_config_dangerously_allow_all_scripts',
  'npm_config_ignore_scripts',
  'npm_config_strict_allow_scripts',
]);
const THIRD_PARTY_ENV_ALLOWLIST = new Set([
  'APPDATA', 'CI', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432',
  'COMSPEC', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'LANG', 'LANGUAGE', 'LC_ALL',
  'LC_CTYPE', 'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432', 'PROGRAMDATA', 'PROGRAMFILES',
  'PROGRAMFILES(X86)', 'PROGRAMW6432', 'SHELL', 'SYSTEMROOT', 'TEMP', 'TMP',
  'TMPDIR', 'TZ', 'USERPROFILE', 'WINDIR',
]);
const ANONYMOUS_ID_PACKAGE = '@deepseek-ai/dsh-anonymous-user-id';
const ANONYMOUS_ID_VERSION = DSH_VERSION;
const HOST_APIPROXY_PACKAGE = '@deepseek-ai/dsh-host-apiproxy';
const HOST_APIPROXY_VERSION = DSH_VERSION;
const HOST_APIPROXY_UPSTREAM_SHA256 = 'c0c506a6a22c02e07db3a1ced277c5fd4435119c1d97b83fec524da3e66711a9';
const HOST_APIPROXY_PATCHED_SHA256 = '7905bd27e8fd8861033fa32f71c44b976e5fac7368970c6d96203a7916ed5d98';
const UNSAFE_ANONYMOUS_ID_FALLBACK = [
  '\t\t\tif (id === void 0) {',
  '\t\t\t\ttry {',
  '\t\t\t\t\twriteFileSync(file, `${created}\\n`, "utf8");',
  '\t\t\t\t} catch {}',
  '\t\t\t\tid = created;',
  '\t\t\t}',
].join('\n');
const SAFE_ANONYMOUS_ID_FALLBACK = '\t\t\tif (id === void 0) id = created;';

function fail(message) {
  throw new Error(`[deepseek-harness-managed] ${message}`);
}

function assertManagedPath(path) {
  const rel = relative(resolve(SOURCE_ROOT), resolve(path));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    fail(`refusing to manage path outside ${SOURCE_ROOT}: ${path}`);
  }
}

function removeManaged(path) {
  assertManagedPath(path);
  rmSync(path, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}

function assertSupportedNode() {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(process.versions.node);
  if (!match) fail(`cannot parse Node version ${process.versions.node}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!((major === 22 && minor >= 19) || major >= 24)) {
    fail(`Node ${process.versions.node} is unsupported; use ^22.19.0 or >=24.0.0`);
  }
}

function parseVersion(value, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (!match) fail(`cannot parse ${label} version ${value}`);
  return match.slice(1, 4).map(Number);
}

function assertSupportedNpmVersion(version) {
  const actual = parseVersion(version, 'npm');
  for (let index = 0; index < MIN_NPM_VERSION.length; index += 1) {
    if (actual[index] > MIN_NPM_VERSION[index]) return;
    if (actual[index] < MIN_NPM_VERSION[index]) {
      fail(`npm ${version} is unsupported; use npm >=${MIN_NPM_VERSION.join('.')} so allowScripts is enforced`);
    }
  }
}

function npmEnvironment(source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined
      && THIRD_PARTY_ENV_ALLOWLIST.has(key.toUpperCase())
      && !NPM_POLICY_ENV_KEYS.has(key.toLowerCase())) {
      env[key] = value;
    }
  }
  return {
    ...env,
    npm_config_audit: 'false',
    npm_config_cache: NPM_CACHE_ROOT,
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
}

function thirdPartyAuditEnvironment(overrides = {}, source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && THIRD_PARTY_ENV_ALLOWLIST.has(key.toUpperCase())) env[key] = value;
  }
  return { ...env, ...overrides, ELECTRON_RUN_AS_NODE: '1' };
}

function npmCommand(args, options = {}) {
  const npmCliCandidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const npmCli = npmCliCandidates.find(existsSync);
  const command = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return spawnSync(command, npmCli ? [npmCli, ...args] : args, {
    cwd: STAGE_ROOT,
    stdio: 'inherit',
    windowsHide: true,
    env: npmEnvironment(),
    ...options,
  });
}

function assertSupportedNpm() {
  const result = npmCommand(['--version'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) fail(`npm version check could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`npm version check failed: ${result.stderr || `exit ${result.status}`}`);
  assertSupportedNpmVersion(result.stdout);
}

function stageSources() {
  removeManaged(STAGE_ROOT);
  removeManaged(BACKUP_ROOT);
  mkdirSync(STAGE_ROOT, { recursive: true });
  for (const file of REQUIRED_FILES) {
    const source = join(SOURCE_ROOT, file);
    if (!existsSync(source)) fail(`required source file is missing: ${source}`);
    copyFileSync(source, join(STAGE_ROOT, file));
  }
  for (const directory of REQUIRED_DIRECTORIES) {
    const source = join(SOURCE_ROOT, directory);
    if (!existsSync(source)) fail(`required source directory is missing: ${source}`);
    cpSync(source, join(STAGE_ROOT, directory), { recursive: true, force: false, errorOnExist: true });
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function packageManifestPath(runtimeRoot, name) {
  return join(runtimeRoot, 'node_modules', ...name.split('/'), 'package.json');
}

function verifyPackage(runtimeRoot, name, expectedVersion) {
  const path = packageManifestPath(runtimeRoot, name);
  if (!existsSync(path)) fail(`npm ci did not install ${name}`);
  const version = readJson(path).version;
  if (version !== expectedVersion) fail(`${name} resolved to ${version}; expected ${expectedVersion}`);
}

function patchAnonymousUserIdSource(source) {
  const normalized = source.replaceAll('\r\n', '\n');
  const occurrences = normalized.split(UNSAFE_ANONYMOUS_ID_FALLBACK).length - 1;
  if (occurrences !== 1) {
    fail(`cannot apply the reviewed ${ANONYMOUS_ID_PACKAGE}@${ANONYMOUS_ID_VERSION} exclusive-write patch`);
  }
  return normalized.replace(UNSAFE_ANONYMOUS_ID_FALLBACK, SAFE_ANONYMOUS_ID_FALLBACK);
}

function anonymousUserIdSourcePath(runtimeRoot) {
  return join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-anonymous-user-id', 'lib', 'index.js');
}

function patchAnonymousUserId(runtimeRoot) {
  verifyPackage(runtimeRoot, ANONYMOUS_ID_PACKAGE, ANONYMOUS_ID_VERSION);
  const path = anonymousUserIdSourcePath(runtimeRoot);
  writeFileSync(path, patchAnonymousUserIdSource(readFileSync(path, 'utf8')), 'utf8');
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sha256Text(source) {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

function replaceReviewedBlock(source, before, after, label) {
  const occurrences = source.split(before).length - 1;
  if (occurrences !== 1) {
    fail(`cannot apply the reviewed ${HOST_APIPROXY_PACKAGE}@${HOST_APIPROXY_VERSION} ${label} patch`);
  }
  return source.replace(before, after);
}

function patchDshHostApiProxySource(source) {
  let patched = source.replaceAll('\r\n', '\n');
  const optionalPicker = (method) => [
    `\t\t\tasync ${method}(request${method === 'createDirectory' ? '' : ', signal'}) {`,
    '\t\t\t\tconst directoryPicker = ctx.get("directoryPicker");',
    '\t\t\t\tif (!directoryPicker) return err(request, {',
    '\t\t\t\t\tcode: "directory-picker-unavailable",',
    `\t\t\t\t\tmessage: "host.${method} needs a composed directory picker",`,
    '\t\t\t\t\tdetails: { capability: "none" }',
    '\t\t\t\t});',
    '\t\t\t\tconst capability = directoryPicker.capability();',
  ].join('\n');
  for (const method of [
    'pickDirectory',
    'listDirectory',
    'createDirectory',
  ]) {
    const signature = `\t\t\tasync ${method}(request${method === 'createDirectory' ? '' : ', signal'}) {`;
    patched = replaceReviewedBlock(
      patched,
      `${signature}\n\t\t\t\tconst capability = ctx.directoryPicker.capability();`,
      optionalPicker(method),
      method,
    );
  }
  patched = replaceReviewedBlock(
    patched,
    '\t\t"attachments",\n\t\t"directoryPicker",\n\t\t"llm",',
    '\t\t"attachments",\n\t\t"llm",',
    'optional service injection',
  );
  return patched;
}

function dshHostApiProxySourcePath(runtimeRoot) {
  return join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'index.js');
}

function patchDshHostApiProxy(runtimeRoot) {
  verifyPackage(runtimeRoot, HOST_APIPROXY_PACKAGE, HOST_APIPROXY_VERSION);
  const path = dshHostApiProxySourcePath(runtimeRoot);
  const actualHash = sha256File(path);
  if (actualHash !== HOST_APIPROXY_UPSTREAM_SHA256) {
    fail(`${HOST_APIPROXY_PACKAGE} changed: expected sha256 ${HOST_APIPROXY_UPSTREAM_SHA256}, got ${actualHash}`);
  }
  const patched = patchDshHostApiProxySource(readFileSync(path, 'utf8'));
  const patchedHash = sha256Text(patched);
  if (patchedHash !== HOST_APIPROXY_PATCHED_SHA256) {
    fail(`${HOST_APIPROXY_PACKAGE} reviewed patch produced unexpected sha256 ${patchedHash}`);
  }
  writeFileSync(path, patched, 'utf8');
}

function managedPresetSource(id) {
  return join(SOURCE_ROOT, 'opc-managed', 'agent-presets', id, 'agent.cordis.yml');
}

function installedPreset(runtimeRoot, id) {
  return join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'config', 'agent-presets', id, 'agent.cordis.yml');
}

function patchManagedAgentPresets(runtimeRoot) {
  for (const [id, expectedHash] of Object.entries(MANAGED_PRESET_UPSTREAM_SHA256)) {
    const target = installedPreset(runtimeRoot, id);
    if (!existsSync(target)) fail(`reviewed upstream agent preset is missing: ${id}`);
    const actualHash = sha256File(target);
    if (actualHash !== expectedHash) {
      fail(`upstream agent preset ${id} changed: expected sha256 ${expectedHash}, got ${actualHash}`);
    }
    copyFileSync(managedPresetSource(id), target);
  }
}

function verifyAnonymousUserIdPatch(runtimeRoot) {
  const source = readFileSync(anonymousUserIdSourcePath(runtimeRoot), 'utf8').replaceAll('\r\n', '\n');
  const writes = source.match(/writeFileSync\(file,/g) ?? [];
  if (writes.length !== 1 || !source.includes('flag: "wx"')
    || !source.includes(SAFE_ANONYMOUS_ID_FALLBACK) || source.includes(UNSAFE_ANONYMOUS_ID_FALLBACK)) {
    fail(`${ANONYMOUS_ID_PACKAGE}@${ANONYMOUS_ID_VERSION} must retain exclusive-create-only persistence`);
  }
}

function verifyManagedAgentPresetPatch(runtimeRoot) {
  for (const id of Object.keys(MANAGED_PRESET_UPSTREAM_SHA256)) {
    const source = managedPresetSource(id);
    const installed = installedPreset(runtimeRoot, id);
    if (!existsSync(installed) || !readFileSync(source).equals(readFileSync(installed))) {
      fail(`managed agent preset patch is missing or stale: ${id}`);
    }
  }
}

function verifyDshHostApiProxyPatch(runtimeRoot) {
  const path = dshHostApiProxySourcePath(runtimeRoot);
  if (!existsSync(path) || sha256File(path) !== HOST_APIPROXY_PATCHED_SHA256) {
    fail(`${HOST_APIPROXY_PACKAGE}@${HOST_APIPROXY_VERSION} optional directory-picker patch is missing or stale`);
  }
}

function installedPackagePaths(runtimeRoot) {
  const found = [];
  const visitNodeModules = (nodeModulesRoot) => {
    if (!existsSync(nodeModulesRoot)) return;
    for (const entry of readdirSync(nodeModulesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.bin') continue;
      if (entry.name.startsWith('@')) {
        const scopeRoot = join(nodeModulesRoot, entry.name);
        for (const scoped of readdirSync(scopeRoot, { withFileTypes: true })) {
          if (scoped.isDirectory()) visitPackage(join(scopeRoot, scoped.name));
        }
      } else {
        visitPackage(join(nodeModulesRoot, entry.name));
      }
    }
  };
  const visitPackage = (packageRoot) => {
    if (!existsSync(join(packageRoot, 'package.json'))) return;
    found.push(relative(runtimeRoot, packageRoot).replaceAll('\\', '/'));
    visitNodeModules(join(packageRoot, 'node_modules'));
  };
  visitNodeModules(join(runtimeRoot, 'node_modules'));
  return found.sort();
}

function verifyDependencyClosure(runtimeRoot) {
  const lock = readJson(join(runtimeRoot, 'package-lock.json'));
  if (lock.lockfileVersion !== 3 || typeof lock.packages !== 'object' || lock.packages === null) {
    fail('prepared runtime requires a package-lock v3 dependency closure');
  }
  const root = lock.packages[''];
  if (root?.dependencies?.[DSH_PACKAGE] !== DSH_VERSION) fail(`${DSH_PACKAGE} is not pinned exactly in the lockfile root`);
  const lockedDsh = lock.packages['node_modules/@deepseek-ai/dsh'];
  if (lockedDsh?.version !== DSH_VERSION || lockedDsh?.integrity !== DSH_INTEGRITY) {
    fail(`${DSH_PACKAGE} lock entry does not match the reviewed version and integrity`);
  }

  const expected = new Map(Object.entries(lock.packages).filter(([path, metadata]) =>
    path.startsWith('node_modules/') && !metadata.dev));
  for (const [path, metadata] of expected) {
    const manifestPath = join(runtimeRoot, ...path.split('/'), 'package.json');
    if (!existsSync(manifestPath)) {
      if (metadata.optional) continue;
      fail(`locked production package is missing: ${path}`);
    }
    const manifest = readJson(manifestPath);
    if (metadata.version !== undefined && manifest.version !== metadata.version) {
      fail(`${path} resolved to ${manifest.version}; lockfile requires ${metadata.version}`);
    }
    if (typeof manifest.license !== 'string' && !Array.isArray(manifest.licenses)) {
      fail(`production package has no declared license: ${manifest.name}@${manifest.version}`);
    }
  }
  for (const path of installedPackagePaths(runtimeRoot)) {
    if (!expected.has(path)) fail(`unexpected package outside the production lock closure: ${path}`);
  }
}

function verifySourceParity(runtimeRoot) {
  for (const file of REQUIRED_FILES) {
    const source = join(SOURCE_ROOT, file);
    const prepared = join(runtimeRoot, file);
    if (!existsSync(prepared)) fail(`prepared runtime source is missing: ${prepared}`);
    if (!readFileSync(source).equals(readFileSync(prepared))) {
      fail(`prepared runtime is stale; source differs: ${file}`);
    }
  }
  const compareTree = (sourceRoot, preparedRoot) => {
    const sourceEntries = readdirSync(sourceRoot, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    const preparedEntries = readdirSync(preparedRoot, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    if (sourceEntries.map((entry) => `${entry.isDirectory() ? 'd' : 'f'}:${entry.name}`).join('|')
      !== preparedEntries.map((entry) => `${entry.isDirectory() ? 'd' : 'f'}:${entry.name}`).join('|')) {
      fail(`prepared runtime source tree differs: ${relative(SOURCE_ROOT, sourceRoot)}`);
    }
    for (const entry of sourceEntries) {
      const source = join(sourceRoot, entry.name);
      const prepared = join(preparedRoot, entry.name);
      if (entry.isDirectory()) compareTree(source, prepared);
      else if (!readFileSync(source).equals(readFileSync(prepared))) {
        fail(`prepared runtime source differs: ${relative(SOURCE_ROOT, source)}`);
      }
    }
  };
  for (const directory of REQUIRED_DIRECTORIES) {
    const prepared = join(runtimeRoot, directory);
    if (!existsSync(prepared)) fail(`prepared runtime source directory is missing: ${prepared}`);
    compareTree(join(SOURCE_ROOT, directory), prepared);
  }
}

function runCapabilityProbe(runtimeRoot) {
  const probe = spawnSync(process.execPath, [join(runtimeRoot, 'probe-managed-capabilities.mjs')], {
    cwd: runtimeRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 45_000,
    env: thirdPartyAuditEnvironment(),
  });
  if (probe.error) fail(`capability probe could not start: ${probe.error.message}`);
  if (probe.status !== 0) fail(`capability probe failed: ${probe.stderr || probe.stdout || `exit ${probe.status}`}`);
  let report;
  try {
    report = JSON.parse(probe.stdout);
  } catch {
    fail(`capability probe returned invalid JSON: ${probe.stdout.slice(0, 500)}`);
  }
  if (report?.runtime?.version !== DSH_VERSION) fail('capability probe returned an unexpected runtime version');
  return report;
}

function verifyRuntime(runtimeRoot) {
  verifyDependencyClosure(runtimeRoot);
  verifyPackage(runtimeRoot, DSH_PACKAGE, DSH_VERSION);
  verifyAnonymousUserIdPatch(runtimeRoot);
  verifyManagedAgentPresetPatch(runtimeRoot);
  verifyDshHostApiProxyPatch(runtimeRoot);

  const entry = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  const syntax = spawnSync(process.execPath, ['--check', entry], {
    cwd: runtimeRoot,
    encoding: 'utf8',
    windowsHide: true,
    env: thirdPartyAuditEnvironment(),
  });
  if (syntax.status !== 0) fail(`managed CLI entry failed syntax validation: ${syntax.stderr || syntax.stdout}`);

  const native = spawnSync(process.execPath, ['--input-type=module', '--eval', "await import('koffi')"], {
    cwd: runtimeRoot,
    encoding: 'utf8',
    windowsHide: true,
    env: thirdPartyAuditEnvironment(),
  });
  if (native.status !== 0) fail(`Koffi native module failed to load: ${native.stderr || native.stdout}`);
  return runCapabilityProbe(runtimeRoot);
}

function replaceDist() {
  let movedPrevious = false;
  if (existsSync(DIST_ROOT)) {
    renameSync(DIST_ROOT, BACKUP_ROOT);
    movedPrevious = true;
  }
  try {
    renameSync(STAGE_ROOT, DIST_ROOT);
    if (movedPrevious) removeManaged(BACKUP_ROOT);
  } catch (error) {
    if (movedPrevious && !existsSync(DIST_ROOT) && existsSync(BACKUP_ROOT)) renameSync(BACKUP_ROOT, DIST_ROOT);
    throw error;
  }
}

function measureTree(root) {
  let bytes = 0;
  let files = 0;
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        files += 1;
        bytes += statSync(path).size;
      }
    }
  };
  visit(root);
  return { bytes, files };
}

async function main() {
  const args = process.argv.slice(2);
  const verifyOnly = args.length === 1 && ['--verify', '--verify-only'].includes(args[0]);
  if (args.length > 1 || (args.length === 1 && !verifyOnly)) fail(`unexpected arguments: ${args.join(' ')}`);
  assertSupportedNode();

  if (verifyOnly) {
    if (!existsSync(DIST_ROOT)) fail(`prepared runtime is missing: ${DIST_ROOT}`);
    verifySourceParity(DIST_ROOT);
    verifyRuntime(DIST_ROOT);
    const measured = measureTree(DIST_ROOT);
    console.log(`[deepseek-harness-managed] verified ${DIST_ROOT}`);
    console.log(`[deepseek-harness-managed] ${measured.files} files, ${(measured.bytes / 1024 / 1024).toFixed(2)} MiB, ${process.platform}/${process.arch}, Node ${process.versions.node}`);
    return;
  }

  assertSupportedNpm();
  stageSources();
  const installed = npmCommand(NPM_CI_ARGS);
  if (installed.error) fail(`npm ci could not start: ${installed.error.message}`);
  if (installed.status !== 0) fail(`npm ci failed with exit code ${installed.status}`);
  patchAnonymousUserId(STAGE_ROOT);
  patchManagedAgentPresets(STAGE_ROOT);
  patchDshHostApiProxy(STAGE_ROOT);
  verifyRuntime(STAGE_ROOT);
  replaceDist();
  const measured = measureTree(DIST_ROOT);
  console.log(`[deepseek-harness-managed] prepared ${DIST_ROOT}`);
  console.log(`[deepseek-harness-managed] ${measured.files} files, ${(measured.bytes / 1024 / 1024).toFixed(2)} MiB, ${process.platform}/${process.arch}, Node ${process.versions.node}`);
}

if (require.main === module) {
  main().catch((error) => {
    try {
      if (existsSync(STAGE_ROOT)) removeManaged(STAGE_ROOT);
      if (existsSync(BACKUP_ROOT) && !existsSync(DIST_ROOT)) renameSync(BACKUP_ROOT, DIST_ROOT);
    } catch (cleanupError) {
      console.error(`[deepseek-harness-managed] cleanup failed: ${cleanupError.message}`);
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  DSH_INTEGRITY,
  DSH_PACKAGE,
  DSH_VERSION,
  HOST_APIPROXY_PATCHED_SHA256,
  HOST_APIPROXY_UPSTREAM_SHA256,
  MIN_NPM_VERSION,
  NPM_CACHE_ROOT,
  NPM_CI_ARGS,
  assertSupportedNpmVersion,
  npmEnvironment,
  patchAnonymousUserIdSource,
  patchDshHostApiProxySource,
  thirdPartyAuditEnvironment,
  verifyDependencyClosure,
};
