'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const appRoot = path.resolve(process.argv[2] || 'release/win-unpacked');
const resources = path.join(appRoot, 'resources');
const hermesRoot = path.join(resources, 'hermes');
const source = path.join(hermesRoot, 'hermes-agent');
const manifestPath = path.join(hermesRoot, 'runtime-manifest.json');

function fail(message) {
  throw new Error(`Packaged Hermes verification failed: ${message}`);
}

function exists(relativePath) {
  const target = path.join(appRoot, relativePath);
  if (!fs.existsSync(target)) fail(`missing ${relativePath}`);
  return target;
}

function main() {
  if (!fs.existsSync(appRoot)) fail(`application directory does not exist: ${appRoot}`);
  const manifest = JSON.parse(fs.readFileSync(exists(path.join('resources', 'hermes', 'runtime-manifest.json')), 'utf8'));
  if (manifest.hermesVersion !== '0.19.0') fail(`unexpected Hermes version ${manifest.hermesVersion}`);
  if (typeof manifest.upstreamCommit !== 'string' || manifest.upstreamCommit.length !== 40) {
    fail('runtime manifest has no pinned upstream commit');
  }
  exists(path.join('resources', 'hermes', 'hermes-agent', 'hermes_cli', 'main.py'));
  exists(path.join('resources', 'hermes', 'hermes-agent', 'hermes_cli', 'web_dist', 'index.html'));
  const python = process.platform === 'win32'
    ? exists(path.join('resources', 'hermes', 'python', 'python.exe'))
    : exists(path.join('resources', 'hermes', 'python', 'bin', 'python3'));
  const probe = spawnSync(python, [
    '-c',
    'import hermes_cli,sys; assert hermes_cli.__version__ == "0.19.0"; print(sys.version)'
  ], {
    cwd: source,
    env: { ...process.env, PYTHONPATH: [source, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
    encoding: 'utf8',
    windowsHide: true
  });
  if (probe.status !== 0) fail((probe.stderr || probe.stdout || 'Hermes import probe exited unsuccessfully').trim());
  console.log(`[Hermes] packaged runtime verified: ${appRoot}`);
}

try {
  main();
} catch (error) {
  console.error(`[Hermes] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

