'use strict';

const { existsSync, readFileSync, readdirSync, statSync } = require('node:fs');
const { isAbsolute, join, relative, resolve, sep } = require('node:path');

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
const REQUIRED_MANAGED_RUNTIME_FILES = [
  join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  join('node_modules', '@deepseek-ai', 'dsh-web-app', 'lib', 'index.js'),
  join('node_modules', '@deepseek-ai', 'dsh-web-frontend', 'package.json'),
  join('node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'),
  join('node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'manifest.webmanifest'),
  join('opc-managed', 'managed-web.patch.yml'),
  join('opc-managed', 'agent-presets', 'standard', 'agent.cordis.yml'),
  join('opc-managed', 'agent-presets', 'code', 'agent.cordis.yml'),
  join('opc-managed', 'agent-presets', 'cordis', 'agent.cordis.yml'),
  join('opc-managed', 'agent-presets', 'minimal', 'agent.cordis.yml'),
  'capabilities.expected.json',
  'probe-managed-capabilities.mjs',
  'package.json',
  'package-lock.json',
  'README.md',
  'THIRD-PARTY-NOTICES.md',
];

// Physical package locations required by externalized Main-process imports.
// Keep nested locations when npm intentionally installs a second version.
const REQUIRED_MAIN_DEPENDENCY_PACKAGES = [
  'node_modules/selfsigned/package.json',
  'node_modules/@peculiar/x509/package.json',
  'node_modules/@peculiar/asn1-cms/package.json',
  'node_modules/@peculiar/asn1-csr/package.json',
  'node_modules/@peculiar/asn1-ecc/package.json',
  'node_modules/@peculiar/asn1-pfx/package.json',
  'node_modules/@peculiar/asn1-pkcs8/package.json',
  'node_modules/@peculiar/asn1-pkcs9/package.json',
  'node_modules/@peculiar/asn1-rsa/package.json',
  'node_modules/@peculiar/asn1-schema/package.json',
  'node_modules/@peculiar/asn1-x509/package.json',
  'node_modules/@peculiar/asn1-x509-attr/package.json',
  'node_modules/@peculiar/utils/package.json',
  'node_modules/pkijs/package.json',
  'node_modules/pkijs/node_modules/@noble/hashes/package.json',
  'node_modules/asn1js/package.json',
  'node_modules/bytestreamjs/package.json',
  'node_modules/pvtsutils/package.json',
  'node_modules/pvutils/package.json',
  'node_modules/reflect-metadata/package.json',
  'node_modules/tslib/package.json',
  'node_modules/tsyringe/package.json',
  'node_modules/tsyringe/node_modules/tslib/package.json',
  'node_modules/qrcode/package.json',
  'node_modules/dijkstrajs/package.json',
  'node_modules/pngjs/package.json',
  'node_modules/qrcode/node_modules/yargs/package.json',
  'node_modules/qrcode/node_modules/cliui/package.json',
  'node_modules/qrcode/node_modules/wrap-ansi/package.json',
  'node_modules/qrcode/node_modules/y18n/package.json',
  'node_modules/qrcode/node_modules/yargs-parser/package.json',
  'node_modules/string-width/package.json',
  'node_modules/emoji-regex/package.json',
  'node_modules/is-fullwidth-code-point/package.json',
  'node_modules/strip-ansi/package.json',
  'node_modules/ansi-regex/package.json',
  'node_modules/ansi-styles/package.json',
  'node_modules/color-convert/package.json',
  'node_modules/color-name/package.json',
  'node_modules/decamelize/package.json',
  'node_modules/find-up/package.json',
  'node_modules/locate-path/package.json',
  'node_modules/p-locate/package.json',
  'node_modules/p-locate/node_modules/p-limit/package.json',
  'node_modules/p-try/package.json',
  'node_modules/path-exists/package.json',
  'node_modules/get-caller-file/package.json',
  'node_modules/require-directory/package.json',
  'node_modules/require-main-filename/package.json',
  'node_modules/set-blocking/package.json',
  'node_modules/which-module/package.json',
  'node_modules/camelcase/package.json',
  'node_modules/ajv/package.json',
  'node_modules/fast-deep-equal/package.json',
  'node_modules/fast-uri/package.json',
  'node_modules/json-schema-traverse/package.json',
  'node_modules/require-from-string/package.json',
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

function assertPackagedManagedHarness(context) {
  const root = join(resourcesDir(context), 'runtime', 'deepseek-harness-managed');
  const missing = REQUIRED_MANAGED_RUNTIME_FILES.filter((relative) => !existsSync(join(root, relative)));
  if (missing.length > 0) {
    throw new Error(`Packaged managed DeepSeek Harness is incomplete; missing: ${missing.join(', ')}`);
  }

  assertManagedWebFrontend(root);

  const measured = measureTree(root);
  if (measured.files < 500 || measured.bytes < 5 * 1024 * 1024) {
    throw new Error(
      `Packaged managed DeepSeek Harness is unexpectedly small: ${measured.files} files, ${measured.bytes} bytes`
    );
  }
  return { root, ...measured };
}

function assertNonEmptyFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
    throw new Error(`Packaged managed DeepSeek Harness WebUI ${label} is missing or empty`);
  }
}

function assertManagedWebFrontend(root) {
  const dist = resolve(root, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist');
  const index = join(dist, 'index.html');
  const manifest = join(dist, 'manifest.webmanifest');
  assertNonEmptyFile(index, 'dist/index.html');
  assertNonEmptyFile(manifest, 'dist/manifest.webmanifest');

  const html = readFileSync(index, 'utf8');
  const references = [...html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);
  for (const extension of ['.js', '.css']) {
    const localAssets = references.flatMap((reference) => {
      const url = new URL(reference, 'https://dsh.local/index.html');
      if (url.origin !== 'https://dsh.local' || !url.pathname.toLowerCase().endsWith(extension)) return [];
      let decodedPath;
      try {
        decodedPath = decodeURIComponent(url.pathname);
      } catch {
        throw new Error(`Packaged managed DeepSeek Harness WebUI index.html has an invalid asset path: ${reference}`);
      }
      const asset = resolve(dist, decodedPath.replace(/^[/\\]+/, ''));
      const relativeAsset = relative(dist, asset);
      if (!relativeAsset || relativeAsset === '..' || relativeAsset.startsWith(`..${sep}`) || isAbsolute(relativeAsset)) {
        throw new Error(`Packaged managed DeepSeek Harness WebUI asset escapes dist: ${reference}`);
      }
      return [asset];
    });
    if (localAssets.length === 0) {
      throw new Error(`Packaged managed DeepSeek Harness WebUI index.html references no local ${extension} asset`);
    }
    if (!localAssets.some((asset) => existsSync(asset) && statSync(asset).isFile() && statSync(asset).size > 0)) {
      throw new Error(`Packaged managed DeepSeek Harness WebUI has no non-empty referenced ${extension} asset`);
    }
  }
}

function assertPackagedMainDependencyEntries(entries) {
  const normalized = new Set(entries.map((entry) => String(entry).replace(/^[/\\]+/, '').replaceAll('\\', '/')));
  const missing = REQUIRED_MAIN_DEPENDENCY_PACKAGES.filter((relative) => !normalized.has(relative));
  if (missing.length > 0) {
    throw new Error(`Packaged Main dependency closure is incomplete; missing: ${missing.join(', ')}`);
  }
  return { packages: REQUIRED_MAIN_DEPENDENCY_PACKAGES.length };
}

function assertPackagedMainDependencies(context) {
  const archive = join(resourcesDir(context), 'app.asar');
  if (!existsSync(archive)) throw new Error('Packaged Electron app.asar is missing');
  // @electron/asar is a build-time dependency of electron-builder. It is used
  // only by this hook and is not part of the shipped application closure.
  const { listPackage } = require('@electron/asar');
  return assertPackagedMainDependencyEntries(listPackage(archive));
}

exports.default = async function verifyReleaseAfterPack(context) {
  const mainDependencies = assertPackagedMainDependencies(context);
  console.log(`[main-dependencies] verified ${mainDependencies.packages} production package entries`);
  const measured = assertPackagedHarness(context);
  console.log(
    `[deepseek-harness] packaged ${measured.files} files, ${(measured.bytes / 1024 / 1024).toFixed(2)} MiB`
  );
  const managed = assertPackagedManagedHarness(context);
  console.log(
    `[deepseek-harness-managed] packaged ${managed.files} files, ${(managed.bytes / 1024 / 1024).toFixed(2)} MiB`
  );
};

exports.assertPackagedHarness = assertPackagedHarness;
exports.assertPackagedManagedHarness = assertPackagedManagedHarness;
exports.assertManagedWebFrontend = assertManagedWebFrontend;
exports.assertPackagedMainDependencyEntries = assertPackagedMainDependencyEntries;
exports.assertPackagedMainDependencies = assertPackagedMainDependencies;
exports.REQUIRED_MAIN_DEPENDENCY_PACKAGES = REQUIRED_MAIN_DEPENDENCY_PACKAGES;
