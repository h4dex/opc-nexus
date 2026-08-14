'use strict';

const { existsSync, readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');

const UPSTREAM_HARNESS_ENTRY = join('node_modules', '@deepseek-ai', 'dsh-acp-demo', 'lib', 'bin.js');
const MANAGED_HARNESS_ENTRY = 'opc-acp-entry.mjs';
const REQUIRED_RUNTIME_FILES = [
  UPSTREAM_HARNESS_ENTRY,
  MANAGED_HARNESS_ENTRY,
  join('config', 'cordis.yml'),
  'package.json',
  'package-lock.json',
  'README.md',
  'THIRD-PARTY-NOTICES.md',
];

function resourcesDir(context) {
  if (context?.electronPlatformName === 'darwin' || context?.electronPlatformName === 'mas') {
    const productFilename = context.packager?.appInfo?.productFilename;
    if (!productFilename) throw new Error('Could not resolve the packaged macOS product name');
    return join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Resources');
  }
  return join(context.appOutDir, 'resources');
}

function measureTree(root) {
  let files = 0;
  let bytes = 0;
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        files += 1;
        bytes += statSync(path).size;
      }
    }
  };
  visit(root);
  return { files, bytes };
}

function assertPackagedHarness(context) {
  const root = join(resourcesDir(context), 'runtime', 'deepseek-harness');
  const missing = REQUIRED_RUNTIME_FILES.filter((relative) => !existsSync(join(root, relative)));
  if (missing.length > 0) {
    throw new Error(`Packaged DeepSeek Harness is incomplete; missing: ${missing.join(', ')}`);
  }

  const measured = measureTree(root);
  if (measured.files < 100 || measured.bytes < 1024 * 1024) {
    throw new Error(
      `Packaged DeepSeek Harness is unexpectedly small: ${measured.files} files, ${measured.bytes} bytes`
    );
  }
  return { root, ...measured };
}

exports.default = async function verifyReleaseAfterPack(context) {
  const measured = assertPackagedHarness(context);
  console.log(
    `[deepseek-harness] packaged ${measured.files} files, ${(measured.bytes / 1024 / 1024).toFixed(2)} MiB`
  );
};

exports.assertPackagedHarness = assertPackagedHarness;
