import { app } from 'electron';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { MobileAdbDevice, MobileApkInfo } from '../../shared/types.js';

interface ApkManifest {
  schemaVersion: number;
  filename: string;
  packageName: string;
  versionCode: string;
  versionName: string;
  buildType: 'debug' | 'release';
  sha256: string;
  signerSha256: string;
  releaseSigned: boolean;
}

function androidSdkRoot(): string | null {
  const candidates = [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : null,
    process.platform !== 'win32' && process.env.HOME ? join(process.env.HOME, 'Android', 'Sdk') : null
  ].filter((value): value is string => !!value);
  return candidates.find(existsSync) ?? null;
}

function executable(root: string | null, relative: string[], fallback: string): string {
  if (root) {
    const candidate = join(root, ...relative);
    if (existsSync(candidate)) return candidate;
  }
  return fallback;
}

function execFileText(file: string, args: string[], timeoutMs = 30_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || stdout || error.message).trim().slice(0, 1000)));
      resolvePromise({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function normalizeDigest(value: string): string {
  return value.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
}

export class MobileAdbService {
  private sdkRoot = androidSdkRoot();

  private adbPath(): string {
    return executable(this.sdkRoot, ['platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb'], 'adb');
  }

  private buildTool(name: string): string {
    if (!this.sdkRoot) throw new Error('未找到 Android SDK');
    const root = join(this.sdkRoot, 'build-tools');
    const versions = existsSync(root) ? readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true })) : [];
    for (const version of versions) {
      const candidate = join(root, version, ...name.split('/'));
      if (existsSync(candidate)) return candidate;
    }
    throw new Error(`Android SDK build-tools 缺少 ${name}`);
  }

  private resourceRoots(): string[] {
    return [
      join(process.resourcesPath, 'mobile', 'android'),
      join(app.getAppPath(), 'mobile', 'dist'),
      join(import.meta.dirname, '../../../mobile/dist')
    ];
  }

  private readManifest(): { root: string; manifest: ApkManifest; apk: string } {
    for (const root of this.resourceRoots()) {
      const manifestPath = join(root, 'apk-manifest.json');
      if (!existsSync(manifestPath)) continue;
      let manifest: ApkManifest;
      try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ApkManifest; } catch { throw new Error('内置 Android APK 清单不是有效 JSON'); }
      if (manifest.schemaVersion !== 1) throw new Error('内置 Android APK 清单版本不受支持');
      if (basename(manifest.filename) !== manifest.filename || !manifest.filename.endsWith('.apk')) throw new Error('内置 Android APK 清单文件名无效');
      if (manifest.packageName !== 'com.senke.opcnexus.bridge') throw new Error('内置 Android APK 包名不匹配');
      if (!/^\d+$/.test(String(manifest.versionCode)) || !manifest.versionName || !['debug', 'release'].includes(manifest.buildType)) throw new Error('内置 Android APK 版本信息无效');
      if (!/^[a-fA-F0-9]{64}$/.test(manifest.sha256) || !/^[a-fA-F0-9]{64}$/.test(manifest.signerSha256)) throw new Error('内置 Android APK 摘要格式无效');
      const apk = resolve(root, manifest.filename);
      if (dirname(apk) !== resolve(root) || !existsSync(apk)) throw new Error('内置 Android APK 文件缺失');
      return { root, manifest, apk };
    }
    throw new Error('尚未构建内置 OPC-Nexus 手机桥 APK');
  }

  async verifyApk(requireRelease = false): Promise<{ info: MobileApkInfo; apk: string }> {
    const { manifest, apk } = this.readManifest();
    if (requireRelease && (!manifest.releaseSigned || manifest.buildType !== 'release')) throw new Error('内置 Android APK 不是生产签名版本');
    const actualHash = createHash('sha256').update(readFileSync(apk)).digest('hex');
    if (actualHash !== manifest.sha256.toLowerCase()) throw new Error('内置 Android APK SHA-256 校验失败');
    const { stdout: badging } = await execFileText(this.buildTool(process.platform === 'win32' ? 'aapt.exe' : 'aapt'), ['dump', 'badging', apk]);
    const packageMatch = /^package:\s+name='([^']+)'\s+versionCode='([^']*)'\s+versionName='([^']*)'/m.exec(badging);
    if (!packageMatch || packageMatch[1] !== manifest.packageName || packageMatch[2] !== String(manifest.versionCode) || packageMatch[3] !== manifest.versionName) throw new Error('内置 Android APK 包名或版本与清单不匹配');
    if (manifest.buildType === 'release' && /^application-debuggable\b/m.test(badging)) throw new Error('内置 Android Release APK 不得启用 debuggable');
    const { stdout, stderr } = await execFileText('java', ['-jar', this.buildTool('lib/apksigner.jar'), 'verify', '--verbose', '--print-certs', apk]);
    const output = `${stdout}\n${stderr}`;
    const signer = /(?:Signer #1|V\d+(?:\.\d+)? Signer): certificate SHA-256 digest:\s*([a-fA-F0-9:]+)/i.exec(output)?.[1];
    if (!signer || normalizeDigest(signer) !== manifest.signerSha256.toLowerCase()) throw new Error('内置 Android APK 签名证书校验失败');
    return {
      apk,
      info: {
        available: true,
        packageName: manifest.packageName,
        versionName: manifest.versionName,
        sha256: actualHash,
        signerSha256: normalizeDigest(signer),
        releaseSigned: manifest.releaseSigned,
        error: null
      }
    };
  }

  async getApkInfo(): Promise<MobileApkInfo> {
    try { return (await this.verifyApk()).info; } catch (error) {
      return { available: false, packageName: 'com.senke.opcnexus.bridge', versionName: '', sha256: '', signerSha256: '', releaseSigned: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async listDevices(): Promise<MobileAdbDevice[]> {
    const { stdout } = await execFileText(this.adbPath(), ['devices', '-l'], 10_000);
    return stdout.split(/\r?\n/).slice(1).map((line) => line.trim()).filter(Boolean).map((line) => {
      const [serial = '', rawState = 'unknown', ...tokens] = line.split(/\s+/);
      const fields = Object.fromEntries(tokens.flatMap((token) => {
        const at = token.indexOf(':');
        return at > 0 ? [[token.slice(0, at), token.slice(at + 1)]] : [];
      }));
      const state = ['device', 'offline', 'unauthorized'].includes(rawState) ? rawState as MobileAdbDevice['state'] : 'unknown';
      return { serial, state, model: fields.model ?? '', product: fields.product ?? '', transportId: fields.transport_id ?? null };
    }).filter((device) => /^[a-zA-Z0-9._:-]{1,128}$/.test(device.serial));
  }

  async install(serial: string): Promise<{ ok: true; message: string }> {
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(serial)) throw new Error('ADB 设备序列号无效');
    const device = (await this.listDevices()).find((item) => item.serial === serial);
    if (!device || device.state !== 'device') throw new Error('ADB 设备未连接或未授权');
    const { apk, info } = await this.verifyApk();
    const { stdout, stderr } = await execFileText(this.adbPath(), ['-s', serial, 'install', '-r', apk], 180_000);
    const output = `${stdout}\n${stderr}`;
    if (!/\bSuccess\b/i.test(output)) throw new Error(`APK 安装失败：${output.trim().slice(0, 800)}`);
    return { ok: true, message: `OPC-Nexus 手机桥 ${info.versionName} 已安装到 ${device.model || serial}` };
  }
}
