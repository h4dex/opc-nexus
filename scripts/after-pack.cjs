'use strict';

const { existsSync } = require('node:fs');
const { join } = require('node:path');

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
};

exports.assertPackagedMainDependencyEntries = assertPackagedMainDependencyEntries;
exports.assertPackagedMainDependencies = assertPackagedMainDependencies;
exports.REQUIRED_MAIN_DEPENDENCY_PACKAGES = REQUIRED_MAIN_DEPENDENCY_PACKAGES;
