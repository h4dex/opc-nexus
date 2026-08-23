'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'runtime', 'agent-clis', 'manifest.json'), 'utf8'));

function verifyPackaged(rootDir) {
  const resources = path.basename(rootDir).toLowerCase().includes('resources')
    ? rootDir
    : path.join(rootDir, 'resources');
  const runtimeRoot = path.join(resources, 'agent-runtimes');
  const results = [];
  for (const [id, spec] of Object.entries(manifest.runtimes)) {
    const runtimeDir = path.join(runtimeRoot, spec.directory);
    const entry = path.join(runtimeDir, ...spec.entry.split('/'));
    const packageJson = path.join(runtimeDir, 'node_modules', ...spec.package.split('/'), 'package.json');
    if (!fs.existsSync(entry)) throw new Error(`${id}: packaged entry is missing (${entry})`);
    if (!fs.existsSync(packageJson)) throw new Error(`${id}: packaged package.json is missing (${packageJson})`);
    const installed = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
    if (installed.version !== spec.version) throw new Error(`${id}: expected ${spec.version}, found ${installed.version}`);
    results.push({ id, version: installed.version, entry: path.relative(resources, entry).replaceAll(path.sep, '/') });
  }
  return { runtimeRoot, runtimes: results };
}

if (require.main === module) {
  const target = process.argv[2];
  if (!target) throw new Error('Usage: node scripts/verify-packaged-agent-runtimes.cjs <unpacked-app-or-resources>');
  console.log(JSON.stringify(verifyPackaged(path.resolve(target)), null, 2));
}

module.exports = { verifyPackaged };
