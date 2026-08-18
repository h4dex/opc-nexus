'use strict';

const { spawnSync } = require('node:child_process');
const { dirname, join, resolve } = require('node:path');
const {
  packagedEnvironment,
  resolvePackagedExecutable,
} = require('./verify-packaged-deepseek-harness.cjs');
const { smokeManagedHarnessWeb } = require('./smoke-deepseek-harness-managed-web.cjs');

function runtimeRootFor(executable) {
  const appDir = dirname(executable);
  return process.platform === 'darwin'
    ? join(appDir, '..', 'Resources', 'runtime', 'deepseek-harness-managed')
    : join(appDir, 'resources', 'runtime', 'deepseek-harness-managed');
}

async function verifyPackagedManagedHarness(input) {
  const { executable } = await resolvePackagedExecutable(resolve(input));
  const runtimeRoot = resolve(runtimeRootFor(executable));
  const probe = join(runtimeRoot, 'probe-managed-capabilities.mjs');
  const result = spawnSync(executable, [probe], {
    cwd: runtimeRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    env: packagedEnvironment(),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Packaged managed Harness capability probe exited ${result.status}: ${result.stderr || result.stdout}`);
  }
  const report = JSON.parse(result.stdout);
  if (report?.runtime?.package !== '@deepseek-ai/dsh' || report?.runtime?.version !== '0.1.0-rc.6') {
    throw new Error('Packaged managed Harness capability report is invalid');
  }
  await smokeManagedHarnessWeb({ executable, runtimeRoot });
  return { executable, runtimeRoot, report };
}

if (require.main === module) {
  const input = process.argv[2];
  if (!input || process.argv.length !== 3) {
    throw new Error('Usage: node scripts/verify-packaged-deepseek-harness-managed.cjs <unpacked-directory-or-electron-executable>');
  }
  verifyPackagedManagedHarness(input).then(({ runtimeRoot }) => {
    console.log(`[deepseek-harness-managed] packaged capability, RunAsNode and Web smoke verified: ${runtimeRoot}`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = { runtimeRootFor, verifyPackagedManagedHarness };
