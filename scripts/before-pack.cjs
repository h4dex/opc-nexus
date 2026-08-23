'use strict';

const { Arch } = require('builder-util');
const { verifyDist } = require('./mobile-apk.cjs');
const { verifyRuntime: verifyHermesRuntime } = require('./prepare-hermes.cjs');
const { verifyRuntime: verifyAgentRuntime, manifest: agentRuntimeManifest } = require('./prepare-agent-runtimes.cjs');

exports.default = async function verifyReleaseBeforePack(context) {
  verifyDist({ requireRelease: true });
  const targetPlatform = context?.electronPlatformName || process.platform;
  const targetArch = typeof context?.arch === 'number' ? Arch[context.arch] : context?.arch || process.arch;
  verifyHermesRuntime({ platform: targetPlatform, arch: targetArch });
  for (const [id, spec] of Object.entries(agentRuntimeManifest.runtimes)) verifyAgentRuntime(id, spec);
};
