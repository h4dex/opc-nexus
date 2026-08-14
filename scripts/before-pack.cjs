'use strict';

const { Arch } = require('builder-util');
const { verifyDist } = require('./mobile-apk.cjs');
const { verifyHarnessWithElectron } = require('./verify-deepseek-harness-electron.cjs');

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

exports.default = async function verifyReleaseBeforePack(context) {
  verifyDist({ requireRelease: true });
  assertHarnessTarget(context);

  const verified = verifyHarnessWithElectron();
  if (verified.error) throw verified.error;
  if (verified.status !== 0) {
    throw new Error(`DeepSeek Harness runtime verification failed with exit code ${verified.status}`);
  }
};

exports.assertHarnessTarget = assertHarnessTarget;
