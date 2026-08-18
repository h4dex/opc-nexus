'use strict';

const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
const { smokeManagedHarnessWeb } = require('./smoke-deepseek-harness-managed-web.cjs');

const REPO_ROOT = resolve(__dirname, '..');
const VERIFY_SCRIPT = resolve(__dirname, 'prepare-deepseek-harness-managed.cjs');

async function verifyManagedHarnessWithElectron() {
  const electronExecutable = require('electron');
  if (typeof electronExecutable !== 'string' || electronExecutable.length === 0) {
    throw new Error('Could not resolve the Electron executable for managed Harness verification');
  }
  const verified = spawnSync(electronExecutable, [VERIFY_SCRIPT, '--verify'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (verified.error) throw verified.error;
  if (verified.status !== 0) throw new Error(`Electron managed Harness verification exited ${verified.status ?? 1}`);
  await smokeManagedHarnessWeb({ executable: electronExecutable });
  return verified;
}

if (require.main === module) {
  verifyManagedHarnessWithElectron().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = { verifyManagedHarnessWithElectron };
