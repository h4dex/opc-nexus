'use strict';

const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

const REPO_ROOT = resolve(__dirname, '..');
const VERIFY_SCRIPT = resolve(__dirname, 'prepare-deepseek-harness.cjs');

function verifyHarnessWithElectron() {
  const electronExecutable = require('electron');
  if (typeof electronExecutable !== 'string' || electronExecutable.length === 0) {
    throw new Error('Could not resolve the Electron executable for DeepSeek Harness verification');
  }
  return spawnSync(electronExecutable, [VERIFY_SCRIPT, '--verify'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  });
}

if (require.main === module) {
  const verified = verifyHarnessWithElectron();
  if (verified.error) throw verified.error;
  if (verified.status !== 0) process.exitCode = verified.status ?? 1;
}

module.exports = { verifyHarnessWithElectron };
