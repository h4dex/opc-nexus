// @ts-nocheck
/* eslint-disable */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

const { safeStorage } = await import('electron');
const { ApiBridge, BRIDGE_KEY_SECRET_REF } = await import('../src/main/services/apiBridge.js');
const { WebServer, WEB_TOKEN_SECRET_REF } = await import('../src/main/services/webServer.js');

function makeDb(settings: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...settings };
  const audit = vi.fn();
  return {
    raw: {
      prepare: (sql: string) => ({
        get: () => undefined,
        all: () => [],
        run: (...args: unknown[]) => {
          if (/DELETE FROM settings WHERE key = \?/i.test(sql)) delete store[String(args[0])];
          return { changes: 1 };
        }
      })
    },
    transaction: (fn: () => void) => fn(),
    audit,
    getSetting: (key: string, fallback: unknown) => key in store ? store[key] : fallback,
    setSetting: (key: string, value: unknown) => { store[key] = value; },
    store
  } as never;
}

const providers = { list: () => [], resolveByModel: () => null } as never;
const decrypt = (value: unknown) => safeStorage.decryptString(Buffer.from(String(value), 'base64'));

function webServer(db: ReturnType<typeof makeDb>) {
  return new WebServer({ db } as never);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('API Bridge credential storage', () => {
  it('generates only an encrypted secret and audits creation', () => {
    const db = makeDb();
    const bridge = new ApiBridge(db, providers);

    const key = bridge.getBridgeKey();

    expect(key).toMatch(/^sk-bridge-[0-9a-f]{48}$/);
    expect(db.store).not.toHaveProperty('bridge_key');
    expect(db.store[BRIDGE_KEY_SECRET_REF]).not.toBe(key);
    expect(decrypt(db.store[BRIDGE_KEY_SECRET_REF])).toBe(key);
    expect(db.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'bridge.key.generate', target: BRIDGE_KEY_SECRET_REF, result: 'ok'
    }));
  });

  it('migrates a legacy plaintext key without rotating it', () => {
    const db = makeDb({ bridge_key: 'sk-bridge-legacy-value' });
    const bridge = new ApiBridge(db, providers);

    expect(bridge.getBridgeKey()).toBe('sk-bridge-legacy-value');
    expect(db.store).not.toHaveProperty('bridge_key');
    expect(decrypt(db.store[BRIDGE_KEY_SECRET_REF])).toBe('sk-bridge-legacy-value');
    expect(db.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'bridge.key.migrate' }));
  });

  it('rotates a damaged credential into a valid encrypted key', () => {
    const db = makeDb({ [BRIDGE_KEY_SECRET_REF]: 42 });
    const bridge = new ApiBridge(db, providers);

    expect(bridge.getStatus().keyConfigured).toBe(false);
    expect(() => bridge.getBridgeKey()).toThrow(/无法读取/);
    const fresh = bridge.regenerateKey();
    expect(decrypt(db.store[BRIDGE_KEY_SECRET_REF])).toBe(fresh);
    expect(db.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'bridge.key.rotate' }));
  });
});

describe('Web admin credential storage', () => {
  it('generates only an encrypted secret and reports a redacted status', () => {
    const db = makeDb();
    const server = webServer(db);

    server.ensureToken();

    const token = server.token;
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(db.store).not.toHaveProperty('webToken');
    expect(db.store[WEB_TOKEN_SECRET_REF]).not.toBe(token);
    expect(decrypt(db.store[WEB_TOKEN_SECRET_REF])).toBe(token);
    expect(server.getStatus()).toEqual({ port: 28889, tokenConfigured: true, weakToken: false });
    expect(server.getStatus()).not.toHaveProperty('token');
  });

  it('migrates the legacy weak token and preserves the warning signal', () => {
    const db = makeDb({ webToken: 'aibox-admin' });
    const server = webServer(db);

    expect(server.getStatus()).toEqual({ port: 28889, tokenConfigured: true, weakToken: true });
    expect(server.token).toBe('aibox-admin');
    expect(db.store).not.toHaveProperty('webToken');
    expect(decrypt(db.store[WEB_TOKEN_SECRET_REF])).toBe('aibox-admin');
    expect(db.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'webserver.token.migrate' }));
  });

  it('keeps status readable and allows rotation after encrypted data is damaged', () => {
    const db = makeDb({ [WEB_TOKEN_SECRET_REF]: 42 });
    const server = webServer(db);

    expect(server.getStatus()).toEqual({ port: 28889, tokenConfigured: false, weakToken: false });
    expect(() => server.token).toThrow(/无法读取/);
    const fresh = server.regenerateToken();
    expect(decrypt(db.store[WEB_TOKEN_SECRET_REF])).toBe(fresh);
    expect(db.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'webserver.token.rotate' }));
  });

  it('fails closed when safeStorage is unavailable', () => {
    vi.spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(false);
    const bridge = new ApiBridge(makeDb(), providers);
    const server = webServer(makeDb());

    expect(() => bridge.getBridgeKey()).toThrow(/密钥库不可用/);
    expect(() => server.ensureToken()).toThrow(/密钥库不可用/);
  });
});
