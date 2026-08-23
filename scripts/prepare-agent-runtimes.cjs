'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const runtimeRoot = path.join(root, 'runtime', 'agent-clis');
const manifestPath = path.join(runtimeRoot, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

function npmInvocation(args) {
  return process.platform === 'win32'
    ? { command: 'cmd.exe', args: ['/d', '/s', '/c', 'npm', ...args] }
    : { command: 'npm', args };
}

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function packageRoot(spec) {
  return path.join(runtimeRoot, spec.directory);
}

function entryPath(spec) {
  return path.join(packageRoot(spec), ...spec.entry.split('/'));
}

function verifyRuntime(id, spec) {
  const entry = entryPath(spec);
  if (!fs.existsSync(entry)) {
    throw new Error(`Built-in ${id} runtime is incomplete: missing ${path.relative(root, entry)}`);
  }
  const packageJson = path.join(packageRoot(spec), 'node_modules', ...spec.package.split('/'), 'package.json');
  if (!fs.existsSync(packageJson)) {
    throw new Error(`Built-in ${id} runtime is incomplete: missing ${path.relative(root, packageJson)}`);
  }
  const installed = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
  if (installed.version !== spec.version) {
    throw new Error(`Built-in ${id} runtime version mismatch: expected ${spec.version}, found ${installed.version}`);
  }
  return { id, version: installed.version, entry: path.relative(root, entry).replaceAll(path.sep, '/') };
}

function installRuntime(id, spec) {
  const target = packageRoot(spec);
  fs.mkdirSync(target, { recursive: true });
  // Rebuild the application-owned closure instead of mutating a user's global
  // npm installation. Native optional dependencies are selected by npm for the
  // current release platform and are verified immediately afterwards.
  fs.rmSync(path.join(target, 'node_modules'), { recursive: true, force: true });
  fs.rmSync(path.join(target, 'package-lock.json'), { force: true });
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({
    name: `opc-nexus-agent-runtime-${spec.directory}`,
    private: true,
    version: '0.0.0'
  }, null, 2) + '\n');
  const registry = process.env.AIBOX_NPM_REGISTRY || 'https://registry.npmjs.org';
  const npmArgs = [
    'install', '--prefix', target, '--no-save', '--ignore-scripts', '--no-audit', '--no-fund',
    `${spec.package}@${spec.version}`, '--registry', registry
  ];
  const invocation = npmInvocation(npmArgs);
  execFileSync(invocation.command, invocation.args, { cwd: root, stdio: 'inherit', windowsHide: true });
  return verifyRuntime(id, spec);
}

function main() {
  const verifyOnly = process.argv.includes('--verify');
  const selected = process.argv.includes('--codex') ? ['eng-codex']
    : process.argv.includes('--pi') ? ['eng-pi']
      : Object.keys(manifest.runtimes);
  const results = selected.map((id) => {
    const spec = manifest.runtimes[id];
    if (!spec) throw new Error(`Unknown agent runtime ${id}`);
    return verifyOnly ? verifyRuntime(id, spec) : installRuntime(id, spec);
  });
  console.log(JSON.stringify({ platform: platformKey(), runtimes: results }, null, 2));
}

if (require.main === module) main();

module.exports = { entryPath, verifyRuntime, installRuntime, manifest };
