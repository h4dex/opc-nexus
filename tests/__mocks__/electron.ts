/**
 * Electron 模块 mock（vitest 环境无 Electron 运行时）
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

function testPath(name: string): string {
  const path = join(tmpdir(), `aibox-test-${name}`);
  // Electron guarantees that userData exists before services use it.
  if (name === 'userData') mkdirSync(path, { recursive: true });
  return path;
}

export const app = {
  isPackaged: false,
  getAppPath: () => process.cwd(),
  getPath: testPath,
  getName: () => 'aibox-test',
  getVersion: () => '1.0.0'
};

export class Notification {
  static isSupported() { return false; }
  constructor(_opts: unknown) {}
  show() {}
}

export class BrowserWindow {
  static getAllWindows() { return []; }
  static fromWebContents = vi.fn(() => null);
  webContents = { send: vi.fn() };
  isDestroyed() { return false; }
}

export const ipcMain = {
  handle: vi.fn(),
  handleOnce: vi.fn(),
  removeHandler: vi.fn()
};

export const dialog = {
  showOpenDialog: vi.fn().mockResolvedValue({ canceled: true }),
  showMessageBox: vi.fn().mockResolvedValue({ response: 0 })
};

export const clipboard = {
  writeText: vi.fn(),
  readText: vi.fn().mockReturnValue('')
};

export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (buf: Buffer) => buf.toString().replace('enc:', '')
};

export const shell = {
  openExternal: vi.fn(),
  openPath: vi.fn().mockResolvedValue(''),
  showItemInFolder: vi.fn()
};
