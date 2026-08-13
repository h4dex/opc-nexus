'use strict';

const { createHash } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { basename, dirname, join, resolve } = require('node:path');
const AdmZip = require('adm-zip');

const REPO_ROOT = resolve(__dirname, '..');
const ANDROID_ROOT = join(REPO_ROOT, 'mobile', 'android-bridge');
const DIST_ROOT = join(REPO_ROOT, 'mobile', 'dist');
const MANIFEST_PATH = join(DIST_ROOT, 'apk-manifest.json');
const EXPECTED_PACKAGE = 'com.senke.opcnexus.bridge';
const REQUIRED_DEX_CLASSES = [
  'Landroidx/core/content/ContextCompat;',
  'Lcom/journeyapps/barcodescanner/CaptureActivity;',
];

function fail(message) {
  throw new Error(`[mobile-apk] ${message}`);
}

function sdkRoot() {
  const candidates = [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    process.platform === 'win32' && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk')
      : null,
    process.platform !== 'win32' && process.env.HOME
      ? join(process.env.HOME, 'Android', 'Sdk')
      : null,
  ].filter(Boolean);
  const found = candidates.find(existsSync);
  if (!found) fail('Android SDK was not found. Set ANDROID_SDK_ROOT or ANDROID_HOME.');
  return found;
}

function latestBuildTools() {
  const root = join(sdkRoot(), 'build-tools');
  if (!existsSync(root)) fail('Android SDK build-tools are missing.');
  const versions = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = join(root, version);
    const aapt = join(candidate, process.platform === 'win32' ? 'aapt.exe' : 'aapt');
    const signer = join(candidate, 'lib', 'apksigner.jar');
    if (existsSync(aapt) && existsSync(signer)) return { root: candidate, aapt, signer };
  }
  fail('Android SDK build-tools must contain aapt and lib/apksigner.jar.');
}

function run(file, args, options = {}) {
  try {
    return execFileSync(file, args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...options,
    });
  } catch (error) {
    const stderr = Buffer.isBuffer(error.stderr) ? error.stderr.toString('utf8') : String(error.stderr || '');
    const stdout = Buffer.isBuffer(error.stdout) ? error.stdout.toString('utf8') : String(error.stdout || '');
    fail(`${basename(file)} failed: ${(stderr || stdout || error.message).trim().slice(0, 2000)}`);
  }
}

function normalizeDigest(value) {
  return value.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function verifyRuntimeClasses(apk) {
  const dexEntries = new AdmZip(apk).getEntries().filter((entry) => /^classes\d*\.dex$/.test(entry.entryName));
  if (dexEntries.length === 0) fail('APK contains no DEX bytecode.');
  const dexBuffers = dexEntries.map((entry) => entry.getData());
  for (const descriptor of REQUIRED_DEX_CLASSES) {
    const needle = Buffer.from(descriptor, 'utf8');
    if (!dexBuffers.some((dex) => dex.includes(needle))) {
      fail(`APK is missing required runtime class ${descriptor}.`);
    }
  }
}

function inspectApk(apk) {
  if (!existsSync(apk)) fail(`APK does not exist: ${apk}`);
  verifyRuntimeClasses(apk);
  const tools = latestBuildTools();
  const badging = run(tools.aapt, ['dump', 'badging', apk]);
  const packageMatch = /^package:\s+name='([^']+)'\s+versionCode='([^']*)'\s+versionName='([^']*)'/m.exec(badging);
  if (!packageMatch) fail('aapt did not return package metadata.');
  const signerOutput = run('java', ['-jar', tools.signer, 'verify', '--verbose', '--print-certs', apk]);
  const signer = /(?:Signer #1|V\d+(?:\.\d+)? Signer): certificate SHA-256 digest:\s*([a-fA-F0-9:]+)/i.exec(signerOutput)?.[1];
  if (!signer) fail('APK has no verifiable signer certificate SHA-256 digest.');
  return {
    packageName: packageMatch[1],
    versionCode: packageMatch[2],
    versionName: packageMatch[3],
    signerSha256: normalizeDigest(signer),
    sha256: sha256File(apk),
    debuggable: /^application-debuggable\b/m.test(badging),
  };
}

function validateManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('APK manifest must be an object.');
  if (value.schemaVersion !== 1) fail('Unsupported APK manifest schemaVersion.');
  if (basename(value.filename || '') !== value.filename || !value.filename.endsWith('.apk')) fail('APK manifest filename is invalid.');
  if (value.packageName !== EXPECTED_PACKAGE) fail(`APK package must be ${EXPECTED_PACKAGE}.`);
  if (!/^\d+$/.test(String(value.versionCode || '')) || !String(value.versionName || '').trim()) fail('APK version metadata is invalid.');
  if (!/^[a-f0-9]{64}$/i.test(value.sha256 || '') || !/^[a-f0-9]{64}$/i.test(value.signerSha256 || '')) {
    fail('APK and signer SHA-256 digests are required.');
  }
  if (!['debug', 'release'].includes(value.buildType)) fail('APK manifest buildType is invalid.');
  if (typeof value.releaseSigned !== 'boolean') fail('APK manifest releaseSigned flag is missing.');
  return value;
}

function readDistManifest() {
  if (!existsSync(MANIFEST_PATH)) fail('mobile/dist/apk-manifest.json is missing. Build the Android release APK first.');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (error) {
    fail(`APK manifest is not valid JSON: ${error.message}`);
  }
  return validateManifest(parsed);
}

function verifyDist({ requireRelease = false } = {}) {
  const manifest = readDistManifest();
  const apk = resolve(DIST_ROOT, manifest.filename);
  if (dirname(apk) !== resolve(DIST_ROOT)) fail('APK manifest resolves outside mobile/dist.');
  const actual = inspectApk(apk);
  if (actual.packageName !== manifest.packageName) fail('APK package name does not match the manifest.');
  if (actual.versionCode !== String(manifest.versionCode) || actual.versionName !== manifest.versionName) fail('APK version does not match the manifest.');
  if (actual.sha256 !== manifest.sha256.toLowerCase()) fail('APK SHA-256 does not match the manifest.');
  if (actual.signerSha256 !== manifest.signerSha256.toLowerCase()) fail('APK signer certificate does not match the manifest.');
  if (manifest.buildType === 'release' && actual.debuggable) fail('A release manifest points to a debuggable APK.');
  if (requireRelease && (!manifest.releaseSigned || manifest.buildType !== 'release' || actual.debuggable)) {
    fail('Electron packaging requires a non-debuggable, production-signed Android release APK.');
  }
  return { manifest, apk, actual };
}

function runGradle(variant) {
  const task = variant === 'release' ? ':app:assembleRelease' : ':app:assembleDebug';
  const wrapper = join(ANDROID_ROOT, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  if (!existsSync(wrapper)) fail('Android Gradle wrapper is missing.');
  const command = process.platform === 'win32' ? 'cmd.exe' : wrapper;
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'call', wrapper, 'clean', task]
    : ['clean', task];
  const result = spawnSync(command, args, {
    cwd: ANDROID_ROOT,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) fail(`Gradle could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`Gradle ${task} failed with exit code ${result.status}.`);
}

function releaseEnvironmentIsComplete() {
  return [
    'OPCNEXUS_ANDROID_KEYSTORE',
    'OPCNEXUS_ANDROID_STORE_PASSWORD',
    'OPCNEXUS_ANDROID_KEY_ALIAS',
    'OPCNEXUS_ANDROID_KEY_PASSWORD',
  ].every((name) => typeof process.env[name] === 'string' && process.env[name].trim() !== '');
}

function findBuiltApk(variant) {
  const output = join(ANDROID_ROOT, 'app', 'build', 'outputs', 'apk', variant);
  if (!existsSync(output)) fail(`Gradle APK output directory is missing: ${output}`);
  const apks = readdirSync(output)
    .filter((name) => name.endsWith('.apk'))
    .map((name) => join(output, name));
  if (apks.length !== 1) fail(`Expected exactly one ${variant} APK, found ${apks.length}.`);
  return apks[0];
}

function stage(variant) {
  if (!['debug', 'release'].includes(variant)) fail('Variant must be debug or release.');
  if (variant === 'release' && !releaseEnvironmentIsComplete()) {
    fail('Release APK requires all four OPCNEXUS_ANDROID_* signing environment variables.');
  }
  const source = findBuiltApk(variant);
  const inspected = inspectApk(source);
  if (inspected.packageName !== EXPECTED_PACKAGE) fail(`Unexpected Android package ${inspected.packageName}.`);
  if (variant === 'release' && inspected.debuggable) fail('Gradle release output is unexpectedly debuggable.');

  mkdirSync(DIST_ROOT, { recursive: true });
  for (const name of readdirSync(DIST_ROOT)) {
    if (/^opcnexus-mobile-bridge-[A-Za-z0-9._-]+\.apk$/.test(name)) rmSync(join(DIST_ROOT, name), { force: true });
  }
  const filename = `opcnexus-mobile-bridge-${inspected.versionName}-${variant}.apk`;
  const target = join(DIST_ROOT, filename);
  const tempApk = `${target}.tmp`;
  copyFileSync(source, tempApk);
  renameSync(tempApk, target);

  const manifest = {
    schemaVersion: 1,
    filename,
    packageName: inspected.packageName,
    versionCode: inspected.versionCode,
    versionName: inspected.versionName,
    buildType: variant,
    sha256: inspected.sha256,
    signerSha256: inspected.signerSha256,
    releaseSigned: variant === 'release' && !inspected.debuggable,
    generatedAt: new Date().toISOString(),
  };
  const tempManifest = `${MANIFEST_PATH}.tmp`;
  writeFileSync(tempManifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  renameSync(tempManifest, MANIFEST_PATH);
  verifyDist({ requireRelease: variant === 'release' });
  return manifest;
}

function build(variant) {
  runGradle(variant);
  return stage(variant);
}

function cli() {
  const [command = 'verify', variantOrFlag] = process.argv.slice(2);
  let result;
  if (command === 'build') result = build(variantOrFlag || 'debug');
  else if (command === 'stage') result = stage(variantOrFlag || 'debug');
  else if (command === 'verify') result = verifyDist({ requireRelease: variantOrFlag === '--require-release' }).manifest;
  else fail(`Unknown command ${command}.`);
  process.stdout.write(`[mobile-apk] verified ${result.packageName} ${result.versionName} (${result.buildType})\n`);
}

module.exports = { build, inspectApk, stage, verifyDist };

if (require.main === module) {
  try {
    cli();
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  }
}
