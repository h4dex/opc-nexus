'use strict';

const { Arch } = require('builder-util');
const { verifyDist } = require('./mobile-apk.cjs');
const { verifyHarnessWithElectron } = require('./verify-deepseek-harness-electron.cjs');
const { verifyManagedHarnessWithElectron } = require('./verify-deepseek-harness-managed-electron.cjs');

function assertHarnessTarget(context) {
  const targetPlatform = context?.electronPlatformName;
  const targetArch = typeof context?.arch === 'number' ? Arch[context.arch] : context?.arch;
  const hostArch = process.arch === 'arm' ? 'armv7l' : process.arch;
  if (targetPlatform && targetPlatform !== process.platform) {
    throw new Error(`DeepSeek Harness contains native packages; prepare and package on ${targetPlatform}, not ${process.platform}`);
  }
  if (targetArch && targetArch !== hostArch) {
    throw new Error(`DeepSeek Harness must be prepared for ${targetArch}, not ${hostArch}`);
  }
}

function assertVerificationResult(result, label) {
  if (!result || typeof result !== 'object') {
    throw new Error(`${label} runtime verification returned no process result`);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.signal
      ? `signal ${result.signal}`
      : `exit code ${result.status ?? 'unknown'}`;
    throw new Error(`${label} runtime verification failed with ${detail}`);
  }
}

async function verifyHarnessRuntimes(
  verifyHarness = verifyHarnessWithElectron,
  verifyManagedHarness = verifyManagedHarnessWithElectron
) {
  assertVerificationResult(await verifyHarness(), 'DeepSeek Harness');
  assertVerificationResult(await verifyManagedHarness(), 'Managed DeepSeek Harness');
}

exports.default = async function verifyReleaseBeforePack(context) {
  verifyDist({ requireRelease: true });
  assertHarnessTarget(context);
  await verifyHarnessRuntimes();
};

exports.assertHarnessTarget = assertHarnessTarget;
exports.assertVerificationResult = assertVerificationResult;
exports.verifyHarnessRuntimes = verifyHarnessRuntimes;
