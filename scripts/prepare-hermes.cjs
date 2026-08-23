'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, execSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'vendor', 'hermes-agent');
const runtimeRoot = path.join(root, 'runtime', 'hermes');
const runtimePythonRoot = path.join(runtimeRoot, 'python');
const runtimeManifestPath = path.join(runtimeRoot, 'runtime-manifest.json');
const expectedVersion = '0.19.0';
const expectedPython = '3.11';
const expectedAiohttp = '3.14.1';
const pinnedCommit = '2b0fb72acae67f51652de5c51db556bc15a68f0e';
const requiredSource = [
  'LICENSE',
  'NOTICE',
  'PATCHES.md',
  'pyproject.toml',
  path.join('hermes_cli', 'main.py'),
  path.join('hermes_cli', 'web_server.py'),
  'web'
];

function bundledPython(platform = process.platform) {
  return path.join(runtimePythonRoot, platform === 'win32' ? 'python.exe' : path.join('bin', 'python3'));
}

function runNpm(argumentsText) {
  if (process.platform === 'win32') {
    execSync(`npm.cmd ${argumentsText}`, {
      cwd: source,
      stdio: 'inherit',
      shell: process.env.ComSpec || 'cmd.exe'
    });
    return;
  }
  execFileSync('npm', argumentsText.split(/\s+/), { cwd: source, stdio: 'inherit' });
}

function pythonInfo(pythonPath) {
  const output = execFileSync(pythonPath, [
    '-c',
    'import json,platform,sys; print(json.dumps({"version": platform.python_version(), "major_minor": f"{sys.version_info.major}.{sys.version_info.minor}", "machine": platform.machine()}))'
  ], { cwd: source, encoding: 'utf8', windowsHide: true }).trim();
  return JSON.parse(output);
}

function verifySource() {
  if (!fs.existsSync(source)) throw new Error('vendor/hermes-agent is missing');
  for (const relativePath of requiredSource) {
    if (!fs.existsSync(path.join(source, relativePath))) throw new Error(`Hermes fork path is missing: ${relativePath}`);
  }
  const init = fs.readFileSync(path.join(source, 'hermes_cli', '__init__.py'), 'utf8');
  if (!init.includes(`__version__ = "${expectedVersion}"`)) throw new Error(`Hermes fork is not v${expectedVersion}`);
  const patches = fs.readFileSync(path.join(source, 'PATCHES.md'), 'utf8');
  if (!patches.includes(pinnedCommit)) throw new Error('Hermes PATCHES.md does not contain the pinned upstream commit');
  const webDist = path.join(source, 'hermes_cli', 'web_dist', 'index.html');
  if (!fs.existsSync(webDist)) throw new Error('Hermes Web dist is missing. Run npm run hermes:prepare.');
  return { source, webDist };
}

function prepareWeb() {
  if (!fs.existsSync(path.join(source, 'node_modules'))) {
    runNpm('install --workspace web --ignore-scripts --no-audit --no-fund');
  }
  runNpm('run build --workspace web');
}

function locateStandalonePython() {
  const configured = process.env.AIBOX_HERMES_STANDALONE_PYTHON?.trim();
  if (configured) return path.resolve(configured);
  try {
    return execFileSync('uv', ['python', 'find', expectedPython], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true
    }).trim();
  } catch {
    throw new Error(`A standalone Python ${expectedPython} runtime is required. Install uv and run: uv python install ${expectedPython}`);
  }
}

function prepareRuntime() {
  const sourcePython = locateStandalonePython();
  if (!fs.existsSync(sourcePython)) throw new Error(`Standalone Python was not found: ${sourcePython}`);
  const info = pythonInfo(sourcePython);
  if (info.major_minor !== expectedPython) throw new Error(`Hermes requires Python ${expectedPython}.x, found ${info.version}`);

  fs.mkdirSync(runtimeRoot, { recursive: true });
  const stage = path.join(runtimeRoot, `.python-stage-${process.pid}`);
  const backup = path.join(runtimeRoot, `.python-backup-${process.pid}`);
  const requirements = path.join(runtimeRoot, `.requirements-${process.pid}.txt`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(backup, { recursive: true, force: true });
  const sourcePythonRoot = fs.realpathSync.native(path.dirname(sourcePython));
  fs.cpSync(sourcePythonRoot, stage, { recursive: true, dereference: true });
  const stagePython = path.join(stage, process.platform === 'win32' ? 'python.exe' : path.join('bin', 'python3'));
  try {
    execFileSync('uv', [
      'export', '--locked', '--no-dev', '--no-default-groups', '--no-emit-project',
      '--output-file', requirements
    ], { cwd: source, stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
    execFileSync('uv', [
      'pip', 'install', '--python', stagePython, '--system', '--break-system-packages', '--no-cache',
      '--link-mode', 'copy', '--requirement', requirements
    ], { cwd: root, stdio: 'inherit', windowsHide: true });
    execFileSync('uv', [
      'pip', 'install', '--python', stagePython, '--system', '--break-system-packages', '--no-cache',
      '--link-mode', 'copy', `aiohttp==${expectedAiohttp}`
    ], { cwd: root, stdio: 'inherit', windowsHide: true });
    execFileSync(stagePython, [
      '-c',
      `import aiohttp, fastapi, hermes_cli, openai, uvicorn; assert hermes_cli.__version__ == "${expectedVersion}"; assert aiohttp.__version__ == "${expectedAiohttp}"`
    ], { cwd: source, stdio: 'inherit', windowsHide: true });
    if (fs.existsSync(runtimePythonRoot)) fs.renameSync(runtimePythonRoot, backup);
    fs.renameSync(stage, runtimePythonRoot);
    fs.rmSync(backup, { recursive: true, force: true });
    const manifest = {
      schemaVersion: 1,
      hermesVersion: expectedVersion,
      upstreamCommit: pinnedCommit,
      pythonVersion: pythonInfo(bundledPython()).version,
      pythonMajorMinor: expectedPython,
      platform: process.platform,
      arch: process.arch,
      preparedAt: new Date().toISOString()
    };
    fs.writeFileSync(runtimeManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.rmSync(requirements, { force: true });
    return manifest;
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(requirements, { force: true });
    if (!fs.existsSync(runtimePythonRoot) && fs.existsSync(backup)) fs.renameSync(backup, runtimePythonRoot);
    throw error;
  }
}

function verifyRuntime(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (!fs.existsSync(runtimeManifestPath)) throw new Error('Hermes runtime manifest is missing. Run npm run hermes:prepare.');
  const manifest = JSON.parse(fs.readFileSync(runtimeManifestPath, 'utf8'));
  if (manifest.hermesVersion !== expectedVersion || manifest.upstreamCommit !== pinnedCommit) {
    throw new Error('Hermes runtime manifest does not match the pinned fork');
  }
  if (manifest.pythonMajorMinor !== expectedPython) throw new Error(`Hermes runtime must use Python ${expectedPython}.x`);
  if (manifest.platform !== platform || manifest.arch !== arch) {
    throw new Error(`Hermes runtime targets ${manifest.platform}/${manifest.arch}, not ${platform}/${arch}`);
  }
  const pythonPath = bundledPython(platform);
  if (!fs.existsSync(pythonPath)) throw new Error(`Hermes bundled Python is missing: ${pythonPath}`);
  const info = pythonInfo(pythonPath);
  if (info.major_minor !== expectedPython) throw new Error(`Hermes bundled Python is ${info.version}, expected ${expectedPython}.x`);
  execFileSync(pythonPath, [
    '-c',
    `import aiohttp, fastapi, hermes_cli, openai, uvicorn; assert hermes_cli.__version__ == "${expectedVersion}"; assert aiohttp.__version__ == "${expectedAiohttp}"`
  ], { cwd: source, stdio: 'pipe', windowsHide: true });
  return manifest;
}

function verifyAll(options = {}) {
  const sourceInfo = verifySource();
  const runtime = verifyRuntime(options);
  console.log(`[Hermes] verified source fork at ${sourceInfo.source}`);
  console.log(`[Hermes] verified Python ${runtime.pythonVersion} runtime for ${runtime.platform}/${runtime.arch}`);
  return { source: sourceInfo, runtime };
}

if (require.main === module) {
  try {
    if (process.argv.includes('--web')) prepareWeb();
    if (process.argv.includes('--runtime')) prepareRuntime();
    verifyAll();
  } catch (error) {
    console.error(`[Hermes] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

module.exports = {
  bundledPython,
  prepareRuntime,
  prepareWeb,
  verifyAll,
  verifyRuntime,
  verifySource
};
