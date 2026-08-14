'use strict';

const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, readdirSync, rmSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, dirname, extname, join, resolve } = require('node:path');
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');

// getCurrentFuseWire() exposes the raw ASCII fuse wire through its public API.
const ENABLED_FUSE_VALUE = '1'.charCodeAt(0);

const ENV_ALLOWLIST = new Set([
  'APPDATA', 'COMSPEC', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'LANG', 'LC_ALL',
  'LOCALAPPDATA', 'OS', 'PATH', 'PATHEXT', 'SYSTEMROOT', 'TEMP', 'TMP',
  'TMPDIR', 'USERPROFILE', 'WINDIR'
]);

function packagedEnvironment(overrides = {}, source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && ENV_ALLOWLIST.has(key.toUpperCase())) env[key] = value;
  }
  return { ...env, ...overrides, ELECTRON_RUN_AS_NODE: '1' };
}

function runtimeRootFor(executable) {
  const appDir = dirname(executable);
  return process.platform === 'darwin'
    ? join(appDir, '..', 'Resources', 'runtime', 'deepseek-harness')
    : join(appDir, 'resources', 'runtime', 'deepseek-harness');
}

function executableCandidates(unpackedDir, platform = process.platform) {
  return readdirSync(unpackedDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(unpackedDir, entry.name))
    .filter((path) => {
      if (platform === 'win32') return extname(path).toLowerCase() === '.exe';
      if (platform === 'linux') {
        return (statSync(path).mode & 0o111) !== 0 || extname(path) === '';
      }
      return false;
    });
}

async function resolvePackagedExecutable(packagedPath, options = {}) {
  const input = resolve(packagedPath);
  if (!existsSync(input)) {
    throw new Error(`Packaged Harness verification path is missing: ${input}`);
  }

  const inputStat = statSync(input);
  const readFuseWire = options.readFuseWire ?? getCurrentFuseWire;
  if (inputStat.isFile()) {
    return { executable: input, fuses: await readFuseWire(input) };
  }
  if (!inputStat.isDirectory()) {
    throw new Error(`Packaged Harness verification path is not a file or directory: ${input}`);
  }

  const candidates = executableCandidates(input, options.platform ?? process.platform);
  const matches = [];
  for (const candidate of candidates) {
    try {
      const fuses = await readFuseWire(candidate);
      if (fuses?.version) matches.push({ executable: candidate, fuses });
    } catch {
      // Electron helpers do not contain a fuse wire and are not the app binary.
    }
  }
  if (matches.length !== 1) {
    const checked = candidates.map((candidate) => basename(candidate)).join(', ') || '(none)';
    throw new Error(
      `Expected exactly one Electron executable in ${input}, found ${matches.length}; checked: ${checked}`
    );
  }
  return matches[0];
}

async function verifyPackagedHarness(packagedPath) {
  const { executable, fuses } = await resolvePackagedExecutable(packagedPath);
  const runtimeRoot = resolve(runtimeRootFor(executable));
  const entry = join(runtimeRoot, 'opc-acp-entry.mjs');
  const config = join(runtimeRoot, 'config', 'cordis.yml');
  for (const path of [executable, entry, config]) {
    if (!existsSync(path)) throw new Error(`Packaged Harness verification path is missing: ${path}`);
  }

  if (fuses[FuseV1Options.RunAsNode] !== ENABLED_FUSE_VALUE) {
    throw new Error(`RunAsNode fuse is not enabled in ${basename(executable)}`);
  }

  const root = join(tmpdir(), `aibox-packaged-harness-${process.pid}-${Date.now()}`);
  const workspace = join(root, 'workspace');
  const skills = join(root, 'skills');
  const sessions = join(root, 'sessions');
  const dshHome = join(root, 'dsh-home');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(skills, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  mkdirSync(dshHome, { recursive: true });

  try {
    const initialize = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }
    });
    const newSession = JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: workspace, mcpServers: [] }
    });
    const result = spawnSync(executable, [entry, '--config', config], {
      cwd: workspace,
      input: `${initialize}\n${newSession}\n`,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      env: packagedEnvironment({
        AIBOX_DSH_PROVIDER: 'deepseek-official',
        AIBOX_DSH_MODEL: 'deepseek-chat',
        DSH_HOME: dshHome,
        AIBOX_DSH_MANAGED_SKILLS_DIR: skills,
        AIBOX_DSH_SESSIONS_ROOT: sessions
      })
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Packaged ACP exited ${result.status}: ${result.stderr || result.stdout}`);
    }
    const messages = result.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    if (!messages.some((message) => message.id === 1 && message.result?.protocolVersion === 1)) {
      throw new Error('Packaged ACP initialize response is missing');
    }
    if (!messages.some((message) => message.id === 2 && typeof message.result?.sessionId === 'string')) {
      throw new Error('Packaged ACP session/new response is missing');
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }

  return { executable, runtimeRoot };
}

if (require.main === module) {
  const executable = process.argv[2];
  if (!executable || process.argv.length !== 3) {
    throw new Error('Usage: node scripts/verify-packaged-deepseek-harness.cjs <unpacked-directory-or-electron-executable>');
  }
  verifyPackagedHarness(executable).then(({ runtimeRoot }) => {
    console.log(`[deepseek-harness] packaged ACP and RunAsNode fuse verified: ${runtimeRoot}`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  ENABLED_FUSE_VALUE,
  executableCandidates,
  packagedEnvironment,
  resolvePackagedExecutable,
  verifyPackagedHarness
};
