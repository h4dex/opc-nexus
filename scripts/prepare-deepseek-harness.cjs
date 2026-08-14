'use strict';

const { spawn, spawnSync } = require('node:child_process');
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
const { tmpdir } = require('node:os');
const { dirname, isAbsolute, join, relative, resolve } = require('node:path');

const REPO_ROOT = resolve(__dirname, '..');
const SOURCE_ROOT = join(REPO_ROOT, 'runtime', 'deepseek-harness');
const DIST_ROOT = join(SOURCE_ROOT, 'dist');
const STAGE_ROOT = join(SOURCE_ROOT, `.dist-stage-${process.pid}`);
const BACKUP_ROOT = join(SOURCE_ROOT, `.dist-backup-${process.pid}`);
const REQUIRED_FILES = [
  'package.json',
  'package-lock.json',
  'opc-acp-entry.mjs',
  'README.md',
  'THIRD-PARTY-NOTICES.md',
];
const REQUIRED_PACKAGES = {
  '@deepseek-ai/dsh-acp-demo': '0.1.0-rc.6',
  '@deepseek-ai/dsh-app-boot': '0.1.0-rc.6',
  '@deepseek-ai/dsh-llm-deepseek': '0.1.0-rc.6',
  '@deepseek-ai/dsh-llm-pi-ai': '0.1.0-rc.6',
  'node-addon-require-builtin': '0.1.4',
};
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
  'APPDATA',
  'CI',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'COMSPEC',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_ARCHITEW6432',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'SHELL',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'TZ',
  'USERPROFILE',
  'WINDIR',
]);
const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:$|[._-])/i;
const LICENSE_FALLBACKS = new Map([
  ['@aws-sdk/credential-provider-http', '3.972.70'],
  ['@aws-sdk/credential-provider-login', '3.972.75'],
  ['@aws-sdk/nested-clients', '3.997.42'],
  ['@earendil-works/pi-ai', '0.82.1'],
  ['data-uri-to-buffer', '4.0.1'],
]);
const ANONYMOUS_ID_PACKAGE = '@deepseek-ai/dsh-anonymous-user-id';
const ANONYMOUS_ID_VERSION = '0.1.0-rc.6';
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
  throw new Error(`[deepseek-harness] ${message}`);
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
  if (actual.some((part, index) => part !== MIN_NPM_VERSION[index])) {
    fail(`npm ${version} is unsupported; use npm >=${MIN_NPM_VERSION.join('.')} so allowScripts is enforced`);
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
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
}

/** Environment for executing staged third-party code during prepare/verify. */
function thirdPartyAuditEnvironment(overrides = {}, source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && THIRD_PARTY_ENV_ALLOWLIST.has(key.toUpperCase())) env[key] = value;
  }
  return {
    ...env,
    ...overrides,
    ELECTRON_RUN_AS_NODE: '1',
  };
}

function npmCommand(args, options = {}) {
  const npmCliCandidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const npmCli = npmCliCandidates.find(existsSync);
  const command = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const commandArgs = npmCli ? [npmCli, ...args] : args;
  return spawnSync(command, commandArgs, {
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
  mkdirSync(join(STAGE_ROOT, 'config'), { recursive: true });
  for (const file of REQUIRED_FILES) {
    const source = join(SOURCE_ROOT, file);
    if (!existsSync(source)) fail(`required source file is missing: ${source}`);
    copyFileSync(source, join(STAGE_ROOT, file));
  }
  cpSync(join(SOURCE_ROOT, 'config'), join(STAGE_ROOT, 'config'), { recursive: true });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function verifyPackage(runtimeRoot, name, expectedVersion) {
  const manifestPath = join(runtimeRoot, 'node_modules', ...name.split('/'), 'package.json');
  if (!existsSync(manifestPath)) fail(`npm ci did not install ${name}`);
  const version = readJson(manifestPath).version;
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

function verifyAnonymousUserIdPatch(runtimeRoot) {
  const source = readFileSync(anonymousUserIdSourcePath(runtimeRoot), 'utf8').replaceAll('\r\n', '\n');
  const writes = source.match(/writeFileSync\(file,/g) ?? [];
  if (writes.length !== 1 || !source.includes('flag: "wx"') || !source.includes(SAFE_ANONYMOUS_ID_FALLBACK)
    || source.includes(UNSAFE_ANONYMOUS_ID_FALLBACK)) {
    fail(`${ANONYMOUS_ID_PACKAGE}@${ANONYMOUS_ID_VERSION} must retain exclusive-create-only persistence`);
  }
}

function listRelativeFiles(root) {
  const files = [];
  const visit = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      const relativePath = join(prefix, entry.name);
      if (entry.isDirectory()) visit(path, relativePath);
      else if (entry.isFile()) files.push(relativePath);
    }
  };
  visit(root);
  return files;
}

function verifySourceParity(runtimeRoot) {
  const sourceConfigRoot = join(SOURCE_ROOT, 'config');
  const runtimeConfigRoot = join(runtimeRoot, 'config');
  if (!existsSync(runtimeConfigRoot)) fail(`runtime config directory is missing: ${runtimeConfigRoot}`);

  const sourceConfigFiles = listRelativeFiles(sourceConfigRoot);
  const runtimeConfigFiles = listRelativeFiles(runtimeConfigRoot);
  if (JSON.stringify(sourceConfigFiles) !== JSON.stringify(runtimeConfigFiles)) {
    fail('prepared runtime config files do not match the locked source config');
  }

  const files = [
    ...REQUIRED_FILES,
    ...sourceConfigFiles.map((file) => join('config', file)),
  ];
  for (const file of files) {
    const source = join(SOURCE_ROOT, file);
    const prepared = join(runtimeRoot, file);
    if (!existsSync(prepared)) fail(`prepared runtime source is missing: ${prepared}`);
    if (!readFileSync(source).equals(readFileSync(prepared))) {
      fail(`prepared runtime is stale; source differs: ${file}`);
    }
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

  const expected = new Map(
    Object.entries(lock.packages).filter(([path, metadata]) =>
      path.startsWith('node_modules/') && !metadata.dev),
  );
  for (const [path, metadata] of expected) {
    const manifestPath = join(runtimeRoot, ...path.split('/'), 'package.json');
    if (!existsSync(manifestPath)) {
      if (metadata.optional) continue;
      fail(`locked production package is missing: ${path}`);
    }
    const installedVersion = readJson(manifestPath).version;
    if (metadata.version !== undefined && installedVersion !== metadata.version) {
      fail(`${path} resolved to ${installedVersion}; lockfile requires ${metadata.version}`);
    }
  }

  for (const path of installedPackagePaths(runtimeRoot)) {
    if (!expected.has(path)) fail(`unexpected package outside the production lock closure: ${path}`);
  }
}

function licenseFallbackAllowed(name, version) {
  return LICENSE_FALLBACKS.get(name) === version
    || (name.startsWith('@koromix/koffi-') && version === '3.1.4');
}

function verifyLicenseCoverage(runtimeRoot) {
  const notices = readFileSync(join(runtimeRoot, 'THIRD-PARTY-NOTICES.md'), 'utf8');
  for (const packagePath of installedPackagePaths(runtimeRoot)) {
    const packageRoot = join(runtimeRoot, ...packagePath.split('/'));
    if (readdirSync(packageRoot).some((entry) => LICENSE_FILE.test(entry))) continue;
    const manifest = readJson(join(packageRoot, 'package.json'));
    if (!licenseFallbackAllowed(manifest.name, manifest.version)) {
      fail(`production package has no redistributed license coverage: ${manifest.name}@${manifest.version}`);
    }
    const noticeKey = manifest.name.startsWith('@koromix/koffi-')
      ? '@koromix/koffi-<platform>-<arch>@3.1.4'
      : `${manifest.name}@${manifest.version}`;
    if (!notices.includes(noticeKey)) {
      fail(`third-party notices are missing license fallback: ${noticeKey}`);
    }
  }
}

function verifyStaticRuntime(runtimeRoot) {
  verifyDependencyClosure(runtimeRoot);
  verifyLicenseCoverage(runtimeRoot);
  for (const [name, version] of Object.entries(REQUIRED_PACKAGES)) {
    verifyPackage(runtimeRoot, name, version);
  }
  verifyAnonymousUserIdPatch(runtimeRoot);

  const acpBin = join(runtimeRoot, 'opc-acp-entry.mjs');
  if (!existsSync(acpBin)) fail(`ACP entry point is missing: ${acpBin}`);
  const acpEntrySource = readFileSync(acpBin, 'utf8');
  if (/\bloadEnv\b/.test(acpEntrySource)) {
    fail('managed ACP entry point must not load ambient .env files');
  }
  for (const shutdownHook of ["stdin.once('end'", "once('SIGINT'", "once('SIGTERM'"]) {
    if (!acpEntrySource.includes(shutdownHook)) {
      fail(`managed ACP entry point is missing shutdown hook: ${shutdownHook}`);
    }
  }

  const config = readFileSync(join(runtimeRoot, 'config', 'cordis.yml'), 'utf8');
  for (const forbidden of [
    '@anthropic-ai/claude',
    '@deepseek-ai/dsh-web',
    '@deepseek-ai/dsh-mcp',
    '@deepseek-ai/dsh-tool-fs',
    '@deepseek-ai/dsh-subprocess-local',
    'session-telemetry-otel',
    'watch: true',
  ]) {
    if (config.includes(forbidden)) fail(`forbidden runtime capability found in cordis.yml: ${forbidden}`);
  }
  if (!/^\s*watch:\s*false\s*$/m.test(config)) {
    fail('managed Skill filesystem watcher must be explicitly disabled');
  }
  for (const required of [
    '@deepseek-ai/dsh-llm-deepseek',
    '@deepseek-ai/dsh-llm-pi-ai',
    '@deepseek-ai/dsh-acp-demo',
    'skills:',
    'enabled: true',
    'filesystem:',
    'includeDefaultRoots: false',
    '!!js process.env.AIBOX_DSH_MANAGED_SKILLS_DIR',
    'watch: false',
    'workspaceContext: false',
    'mode: native',
    'toolBash: false',
    'toolJobs: false',
    'goals: false',
  ]) {
    if (!config.includes(required)) fail(`required runtime capability missing from cordis.yml: ${required}`);
  }
  for (const forbiddenSkillRoot of [
    'process.env.DSH_AGENTS_HOME',
    'process.env.DSH_BUNDLED_SKILL_DIR',
    "'/opc-skills'",
    '"/opc-skills"',
  ]) {
    if (config.includes(forbiddenSkillRoot)) {
      fail(`unmanaged Skill root found in cordis.yml: ${forbiddenSkillRoot}`);
    }
  }

  const mountedPackages = [...config.matchAll(/^\s*name:\s*['"]?([^'"\s#]+)/gm)].map((match) => match[1]);
  const expectedPackages = [
    '@deepseek-ai/dsh-llm-deepseek',
    '@deepseek-ai/dsh-llm-pi-ai',
    '@deepseek-ai/dsh-acp-demo',
  ];
  if (JSON.stringify(mountedPackages) !== JSON.stringify(expectedPackages)) {
    fail(`unexpected Cordis package composition: ${mountedPackages.join(', ') || '(empty)'}`);
  }

  const syntax = spawnSync(process.execPath, ['--check', acpBin], {
    cwd: runtimeRoot,
    encoding: 'utf8',
    windowsHide: true,
    env: thirdPartyAuditEnvironment(),
  });
  if (syntax.status !== 0) fail(`ACP entry point failed syntax validation: ${syntax.stderr || syntax.stdout}`);

  // JSONL publication uses Koffi for atomic Windows file replacement. Load it
  // during staging so a missing target-specific optional package fails here,
  // rather than on the first durable Session write in production.
  const native = spawnSync(process.execPath, ['--input-type=module', '--eval', "await import('koffi')"], {
    cwd: runtimeRoot,
    encoding: 'utf8',
    windowsHide: true,
    env: thirdPartyAuditEnvironment(),
  });
  if (native.status !== 0) fail(`Koffi native module failed to load: ${native.stderr || native.stdout}`);

  for (const forbiddenPackage of [
    ['@anthropic-ai', 'claude-agent-sdk'],
    ['@anthropic-ai', 'claude-code'],
    ['@deepseek-ai', 'dsh-subagent-claude-code'],
  ]) {
    if (existsSync(join(runtimeRoot, 'node_modules', ...forbiddenPackage))) {
      fail(`forbidden agent SDK package is installed: ${forbiddenPackage.join('/')}`);
    }
  }
}

function rpcRequest(child, state, method, params, timeoutMs = 15_000) {
  return new Promise((resolveRequest, rejectRequest) => {
    const id = ++state.nextId;
    const timer = setTimeout(() => {
      state.pending.delete(id);
      rejectRequest(new Error(`${method} timed out`));
    }, timeoutMs);
    state.pending.set(id, {
      resolve(value) {
        clearTimeout(timer);
        resolveRequest(value);
      },
      reject(error) {
        clearTimeout(timer);
        rejectRequest(error);
      },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

async function smokeAcp(runtimeRoot, provider, model, connection) {
  const smokeRoot = join(tmpdir(), `aibox-dsh-prepare-${process.pid}-${provider}-${connection}`);
  rmSync(smokeRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  mkdirSync(join(smokeRoot, 'workspace'), { recursive: true });

  const acpBin = join(runtimeRoot, 'opc-acp-entry.mjs');
  const env = thirdPartyAuditEnvironment({
    AIBOX_DSH_PROVIDER: provider,
    AIBOX_DSH_MODEL: model,
    DSH_HOME: join(smokeRoot, 'dsh-home'),
    DSH_AGENTS_HOME: join(smokeRoot, 'agents-home'),
    AIBOX_DSH_MANAGED_SKILLS_DIR: join(smokeRoot, 'managed-skills'),
    AIBOX_DSH_SESSIONS_ROOT: join(smokeRoot, 'sessions'),
  });
  if (connection === 'deepseek') env.DEEPSEEK_API_KEY = 'prepare-smoke-key-not-sent';
  if (connection === 'openai') {
    env.OPENAI_API_KEY = 'prepare-smoke-key-not-sent';
    env.OPENAI_BASE_URL = 'http://127.0.0.1:9/v1';
  }

  const child = spawn(process.execPath, [acpBin, '--config', join(runtimeRoot, 'config', 'cordis.yml')], {
    cwd: join(smokeRoot, 'workspace'),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env,
  });

  const state = { nextId: 0, pending: new Map(), stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    state.stderr = (state.stderr + chunk).slice(-16_000);
  });
  child.stdout.on('data', (chunk) => {
    state.stdout += chunk;
    while (true) {
      const newline = state.stdout.indexOf('\n');
      if (newline < 0) break;
      const line = state.stdout.slice(0, newline).trim();
      state.stdout = state.stdout.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        const error = new Error(`ACP stdout contained a non-JSON line: ${line.slice(0, 300)}`);
        for (const pending of state.pending.values()) pending.reject(error);
        state.pending.clear();
        continue;
      }
      const pending = state.pending.get(message.id);
      if (!pending) continue;
      state.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'ACP request failed'));
      else pending.resolve(message.result);
    }
  });

  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
  child.once('error', (error) => {
    for (const pending of state.pending.values()) pending.reject(error);
    state.pending.clear();
  });

  try {
    const initialized = await rpcRequest(child, state, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    if (initialized?.protocolVersion !== 1) fail('ACP initialize returned an unexpected protocol version');
    const promptCapabilities = initialized?.agentCapabilities?.promptCapabilities;
    if (promptCapabilities?.image !== false || promptCapabilities?.audio !== false
      || promptCapabilities?.embeddedContext !== false) {
      fail(`ACP advertised unexpected prompt capabilities for ${provider}`);
    }
    const session = await rpcRequest(child, state, 'session/new', {
      cwd: join(smokeRoot, 'workspace'),
      mcpServers: [],
    });
    if (typeof session?.sessionId !== 'string' || session.sessionId.length === 0) {
      fail('ACP session/new returned no session id');
    }
  } catch (error) {
    fail(`ACP smoke test failed for ${provider}/${connection}: ${error.message}; stderr: ${state.stderr.trim() || '(empty)'}`);
  } finally {
    child.stdin.end();
    const eofTimeout = Symbol('eof-timeout');
    const exitCode = await Promise.race([
      exited,
      new Promise((resolveWait) => setTimeout(() => resolveWait(eofTimeout), 3_000)),
    ]);
    let exitFailure = null;
    if (exitCode === eofTimeout) {
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 3_000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      exitFailure = `managed ACP entry did not dispose and exit after stdin EOF; stderr: ${state.stderr.trim() || '(empty)'}`;
    } else if (exitCode !== 0) {
      exitFailure = `managed ACP entry exited with code ${String(exitCode)} after stdin EOF; stderr: ${state.stderr.trim() || '(empty)'}`;
    }
    rmSync(smokeRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
    if (exitFailure) fail(exitFailure);
  }
}

function semanticAudit(runtimeRoot) {
  const audit = String.raw`
    import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join, resolve } from 'node:path';
    import { boot } from '@deepseek-ai/dsh-app-boot';

    const root = await mkdtemp(join(tmpdir(), 'aibox-dsh-semantic-'));
    const workspace = join(root, 'workspace');
    const managedRoot = join(root, 'managed-skills');
    const fixtures = [
      [join(managedRoot, 'managed-skill'), 'managed-skill', 'MANAGED_SKILL_OK'],
      [join(workspace, '.dsh', 'skills', 'project-dsh-skill'), 'project-dsh-skill', 'PROJECT_DSH_MUST_NOT_LOAD'],
      [join(workspace, '.agents', 'skills', 'project-agents-skill'), 'project-agents-skill', 'PROJECT_AGENTS_MUST_NOT_LOAD'],
      [join(root, 'dsh-home', 'skills', 'user-dsh-skill'), 'user-dsh-skill', 'USER_DSH_MUST_NOT_LOAD'],
      [join(root, 'agents-home', 'skills', 'user-agents-skill'), 'user-agents-skill', 'USER_AGENTS_MUST_NOT_LOAD'],
      [join(root, 'bundled-skills', 'bundled-skill'), 'bundled-skill', 'BUNDLED_MUST_NOT_LOAD'],
    ];
    for (const [dir, name, token] of fixtures) {
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'SKILL.md'),
        '---\nname: ' + name + '\ndescription: Semantic audit fixture.\n---\n\nReturn the exact token ' + token + '.\n',
        'utf8',
      );
    }

    process.env.DEEPSEEK_API_KEY = 'prepare-smoke-key-not-sent';
    process.env.OPENAI_API_KEY = 'prepare-smoke-key-not-sent';
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:9/v1';
    process.env.AIBOX_DSH_PROVIDER = 'deepseek-official';
    process.env.AIBOX_DSH_MODEL = 'deepseek-chat';
    process.env.DSH_HOME = join(root, 'dsh-home');
    process.env.DSH_AGENTS_HOME = join(root, 'agents-home');
    process.env.DSH_BUNDLED_SKILL_DIR = join(root, 'bundled-skills');
    process.env.AIBOX_DSH_MANAGED_SKILLS_DIR = managedRoot;
    process.env.AIBOX_DSH_SESSIONS_ROOT = join(root, 'sessions');

    let ctx;
    try {
      ctx = await boot('sidecar-semantic-audit', resolve('config/cordis.yml'));
      const schemas = ctx.tools.schemas().map(({ name }) => name).sort();
      if (JSON.stringify(schemas) !== JSON.stringify(['skill'])) {
        throw new Error('unexpected model tools: ' + (schemas.join(', ') || '(none)'));
      }

      const skills = await ctx.skills.list({ cwd: workspace });
      const names = skills.map(({ name }) => name).sort();
      if (JSON.stringify(names) !== JSON.stringify(['managed-skill'])) {
        throw new Error('filesystem Skills escaped managed root: ' + (names.join(', ') || '(none)'));
      }
      const summary = skills.find(({ name }) => name === 'managed-skill');
      if (!summary || summary.provider !== 'filesystem' || summary.source !== 'custom'
        || !summary.invocation.modelInvocable) {
        throw new Error('managed filesystem Skill is not model-visible');
      }
      const loaded = await ctx.skills.get('managed-skill', { cwd: workspace });
      if (!loaded || loaded.content !== 'Return the exact token MANAGED_SKILL_OK.') {
        throw new Error('managed filesystem Skill body did not load');
      }
    } finally {
      if (ctx) await ctx.fiber.dispose();
      await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', audit], {
    cwd: runtimeRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    env: thirdPartyAuditEnvironment(),
  });
  if (result.error) fail(`semantic runtime audit could not start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`semantic runtime audit failed: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
}

async function verifyRuntime(runtimeRoot) {
  verifyStaticRuntime(runtimeRoot);
  semanticAudit(runtimeRoot);
  await smokeAcp(runtimeRoot, 'deepseek-official', 'deepseek-chat', 'unconfigured');
  await smokeAcp(runtimeRoot, 'deepseek-official', 'deepseek-chat', 'deepseek');
  await smokeAcp(runtimeRoot, 'aibox-openai', 'aibox-smoke-model', 'openai');
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
    if (movedPrevious && !existsSync(DIST_ROOT) && existsSync(BACKUP_ROOT)) {
      renameSync(BACKUP_ROOT, DIST_ROOT);
    }
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
  if (args.length > 1 || (args.length === 1 && !verifyOnly)) {
    fail(`unexpected arguments: ${args.join(' ')}`);
  }
  assertSupportedNode();

  if (verifyOnly) {
    if (!existsSync(DIST_ROOT)) fail(`prepared runtime is missing: ${DIST_ROOT}`);
    verifySourceParity(DIST_ROOT);
    await verifyRuntime(DIST_ROOT);
    const { bytes, files } = measureTree(DIST_ROOT);
    console.log(`[deepseek-harness] verified ${DIST_ROOT}`);
    console.log(`[deepseek-harness] ${files} files, ${(bytes / 1024 / 1024).toFixed(2)} MiB, ${process.platform}/${process.arch}, Node ${process.versions.node}`);
    return;
  }

  assertSupportedNpm();
  stageSources();

  const installed = npmCommand(NPM_CI_ARGS);
  if (installed.error) fail(`npm ci could not start: ${installed.error.message}`);
  if (installed.status !== 0) fail(`npm ci failed with exit code ${installed.status}`);
  patchAnonymousUserId(STAGE_ROOT);

  await verifyRuntime(STAGE_ROOT);
  replaceDist();

  const { bytes, files } = measureTree(DIST_ROOT);
  console.log(`[deepseek-harness] prepared ${DIST_ROOT}`);
  console.log(`[deepseek-harness] ${files} files, ${(bytes / 1024 / 1024).toFixed(2)} MiB, ${process.platform}/${process.arch}, Node ${process.versions.node}`);
}

if (require.main === module) {
  main().catch((error) => {
    try {
      if (existsSync(STAGE_ROOT)) removeManaged(STAGE_ROOT);
      if (existsSync(BACKUP_ROOT) && !existsSync(DIST_ROOT)) renameSync(BACKUP_ROOT, DIST_ROOT);
    } catch (cleanupError) {
      console.error(`[deepseek-harness] cleanup failed: ${cleanupError.message}`);
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  MIN_NPM_VERSION,
  NPM_CI_ARGS,
  assertSupportedNpmVersion,
  npmEnvironment,
  thirdPartyAuditEnvironment,
  patchAnonymousUserIdSource,
};
