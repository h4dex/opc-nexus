// @ts-nocheck
import { createHash, X509Certificate } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

const {
  DEFAULT_DSH_LAN_PORT,
  DSH_LAN_CERTIFICATE_KEY,
  DSH_LAN_CONFIG_KEY,
  DSH_LAN_PRIVATE_KEY_REF,
  DshLanGatewayController,
  DshLanTlsIdentityStore,
  normalizeDshLanGatewayConfig
} = await import('../src/main/services/dshLanGatewayController.js');

class MemoryStore {
  values = new Map<string, unknown>();
  audits: unknown[] = [];
  transactionCount = 0;
  failConfigWrites = false;

  getSetting<T>(key: string, fallback: T): T {
    return this.values.has(key) ? this.values.get(key) as T : fallback;
  }

  setSetting(key: string, value: unknown): void {
    if (this.failConfigWrites && key === DSH_LAN_CONFIG_KEY) throw new Error('disk full');
    this.values.set(key, structuredClone(value));
  }

  transaction(operation: () => void): void {
    this.transactionCount += 1;
    const checkpoint = new Map(this.values);
    try { operation(); } catch (error) {
      this.values = checkpoint;
      throw error;
    }
  }

  audit(entry: unknown): void {
    this.audits.push(structuredClone(entry));
  }
}

class TestProtector {
  available = true;
  encryptCalls = 0;
  decryptCalls = 0;
  failDecrypt = false;

  isEncryptionAvailable(): boolean { return this.available; }

  encryptString(value: string): Buffer {
    this.encryptCalls += 1;
    return Buffer.from(`sealed:${Buffer.from(value, 'utf8').toString('base64')}`, 'utf8');
  }

  decryptString(value: Buffer): string {
    this.decryptCalls += 1;
    if (this.failDecrypt) throw new Error('cannot decrypt secret payload');
    const encoded = value.toString('utf8');
    if (!encoded.startsWith('sealed:')) throw new Error('invalid envelope');
    return Buffer.from(encoded.slice('sealed:'.length), 'base64').toString('utf8');
  }
}

function fingerprint(certPem: string): string {
  const certificate = new X509Certificate(certPem);
  const der = certificate.publicKey.export({ format: 'der', type: 'spki' });
  return `sha256/${createHash('sha256').update(der).digest('base64')}`;
}

class FakeGateway {
  starts: unknown[] = [];
  stopCalls = 0;
  sessions = 0;
  sockets = 0;
  status = {
    state: 'stopped', enabled: false, running: false,
    bindHost: null, port: null, authority: null, origin: null,
    trustedAuthorities: [], runtimeId: 'runtime-1', activeSessions: 0,
    activeRequests: 0, activeWebSockets: 0, certificateFingerprint: null, lastError: null
  };

  getStatus() { return { ...this.status, trustedAuthorities: [...this.status.trustedAuthorities] }; }

  async start(options: any) {
    this.starts.push(options);
    const authority = `${options.publicHost}:${options.publicPort}`;
    this.status = {
      ...this.status,
      state: 'running', enabled: true, running: true,
      bindHost: options.bindHost, port: options.port,
      authority, origin: `https://${authority}`,
      trustedAuthorities: [authority],
      certificateFingerprint: fingerprint(options.tls.cert),
      lastError: null
    };
    return this.getStatus();
  }

  async stop() {
    this.stopCalls += 1;
    this.sessions = 0;
    this.sockets = 0;
    this.status = {
      ...this.status,
      state: 'stopped', enabled: false, running: false,
      bindHost: null, port: null, authority: null, origin: null,
      trustedAuthorities: [], activeSessions: 0, activeWebSockets: 0,
      certificateFingerprint: null
    };
  }

  createPairingOffer(role = 'operator') {
    if (!this.status.running) throw new Error('gateway is stopped');
    return {
      code: '12345678', expiresAt: Date.now() + 60_000,
      origin: this.status.origin, pairingUrl: `${this.status.origin}/pair`, runtimeId: 'runtime-1', role,
      certificateFingerprint: this.status.certificateFingerprint
    };
  }
}

function controller(store = new MemoryStore(), protector = new TestProtector(), gateway = new FakeGateway()) {
  const identities = new DshLanTlsIdentityStore(store, protector);
  return {
    store,
    protector,
    gateway,
    controller: new DshLanGatewayController(store, gateway, identities)
  };
}

const config = {
  bindHost: '127.0.0.1',
  port: DEFAULT_DSH_LAN_PORT,
  publicHost: '127.0.0.1',
  publicPort: DEFAULT_DSH_LAN_PORT
};

describe('DshLanGatewayController', () => {
  it('defaults to disabled and does not auto-start without persisted intent', async () => {
    const harness = controller();
    expect(harness.controller.getStatus()).toMatchObject({
      desiredEnabled: false,
      configured: null,
      gateway: { running: false }
    });
    const restored = await harness.controller.restoreOnStartup();
    expect(restored.gateway.running).toBe(false);
    expect(harness.gateway.starts).toHaveLength(0);
    expect(harness.store.values.has(DSH_LAN_PRIVATE_KEY_REF)).toBe(false);
  });

  it('normalizes persistent config and rejects wildcard/public listeners', () => {
    expect(normalizeDshLanGatewayConfig({ bindHost: '192.168.1.8' })).toEqual({
      bindHost: '192.168.1.8',
      port: DEFAULT_DSH_LAN_PORT,
      publicHost: '192.168.1.8',
      publicPort: DEFAULT_DSH_LAN_PORT
    });
    expect(() => normalizeDshLanGatewayConfig({ bindHost: '0.0.0.0' })).toThrow(/literal private/);
    expect(() => normalizeDshLanGatewayConfig({ bindHost: '8.8.8.8' })).toThrow(/literal private/);
    expect(() => normalizeDshLanGatewayConfig({ bindHost: '127.0.0.1', port: 443 })).toThrow(/port/);
    expect(() => normalizeDshLanGatewayConfig({ bindHost: '127.0.0.1', publicHost: 'bad/host' })).toThrow(/public host/);
  });

  it('persists an encrypted private key and exposes only renderer-safe status plus pairing data', async () => {
    const harness = controller();
    const status = await harness.controller.start(config);
    const stored = harness.store.values.get(DSH_LAN_CONFIG_KEY);
    const certificate = harness.store.values.get(DSH_LAN_CERTIFICATE_KEY) as string;
    const encryptedKey = harness.store.values.get(DSH_LAN_PRIVATE_KEY_REF) as string;
    const internalKey = harness.gateway.starts[0].tls.key as string;

    expect(stored).toEqual({ enabled: true, config });
    expect(certificate).toContain('BEGIN CERTIFICATE');
    expect(internalKey).toContain('PRIVATE KEY');
    expect(encryptedKey).not.toContain('PRIVATE KEY');
    expect(Buffer.from(encryptedKey, 'base64').toString()).toMatch(/^sealed:/);
    expect(harness.protector.encryptCalls).toBe(1);
    expect(harness.store.transactionCount).toBe(1);
    expect(status.gateway.certificateFingerprint).toMatch(/^sha256\//);
    expect(harness.controller.getTrustedAuthorities()).toEqual([`${config.publicHost}:${config.publicPort}`]);
    expect(harness.controller.createPairingCode('viewer')).toMatchObject({ code: '12345678', role: 'viewer' });

    const visible = JSON.stringify(status);
    expect(visible).not.toContain('BEGIN CERTIFICATE');
    expect(visible).not.toContain('PRIVATE KEY');
    expect(visible).not.toContain(encryptedKey);
    expect(JSON.stringify(harness.store.audits)).not.toContain(internalKey);
  });

  it('uses Electron safeStorage by default when no test protector is injected', async () => {
    const store = new MemoryStore();
    const gateway = new FakeGateway();
    const instance = new DshLanGatewayController(store, gateway);
    await instance.start(config);
    const encrypted = store.values.get(DSH_LAN_PRIVATE_KEY_REF) as string;
    expect(Buffer.from(encrypted, 'base64').toString('utf8')).toMatch(/^enc:-----BEGIN .*PRIVATE KEY-----/s);
    expect(JSON.stringify(instance.getStatus())).not.toContain('PRIVATE KEY');
  });

  it('preserves enabled intent on shutdown and restores the same TLS identity after restart', async () => {
    const store = new MemoryStore();
    const protector = new TestProtector();
    const first = controller(store, protector, new FakeGateway());
    await first.controller.start(config);
    const firstKey = first.gateway.starts[0].tls.key;
    const firstCert = first.gateway.starts[0].tls.cert;
    const firstFingerprint = first.controller.getStatus().gateway.certificateFingerprint;

    const shutdown = await first.controller.shutdown();
    expect(shutdown).toMatchObject({ desiredEnabled: true, gateway: { running: false } });
    expect(store.values.get(DSH_LAN_CONFIG_KEY)).toEqual({ enabled: true, config });

    const second = controller(store, protector, new FakeGateway());
    const restored = await second.controller.restoreOnStartup();
    expect(restored).toMatchObject({ desiredEnabled: true, configured: config, gateway: { running: true } });
    expect(second.gateway.starts).toHaveLength(1);
    expect(second.gateway.starts[0].tls.key).toBe(firstKey);
    expect(second.gateway.starts[0].tls.cert).toBe(firstCert);
    expect(restored.gateway.certificateFingerprint).toBe(firstFingerprint);
    expect(protector.encryptCalls).toBe(1);
    expect(protector.decryptCalls).toBe(1);
    expect(store.audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'dsh.lan.tls.load', result: 'ok' }),
      expect.objectContaining({ action: 'dsh.lan.restore', result: 'ok' })
    ]));
  });

  it('emergency stop persists disabled before revoking sessions and prevents restart recovery', async () => {
    const store = new MemoryStore();
    const protector = new TestProtector();
    const first = controller(store, protector, new FakeGateway());
    await first.controller.start(config);
    first.gateway.sessions = 2;
    first.gateway.sockets = 3;
    first.gateway.status.activeSessions = 2;
    first.gateway.status.activeWebSockets = 3;

    const stopped = await first.controller.emergencyStop();
    expect(stopped).toMatchObject({ desiredEnabled: false, gateway: { running: false, activeSessions: 0, activeWebSockets: 0 } });
    expect(store.values.get(DSH_LAN_CONFIG_KEY)).toEqual({ enabled: false, config });
    expect(first.gateway.stopCalls).toBe(1);

    const second = controller(store, protector, new FakeGateway());
    await second.controller.restoreOnStartup();
    expect(second.gateway.starts).toHaveLength(0);
    expect(() => second.controller.createPairingCode()).toThrow(/stopped/);
  });

  it('still revokes the live gateway if persisting emergency disabled state fails', async () => {
    const harness = controller();
    await harness.controller.start(config);
    harness.store.failConfigWrites = true;
    await expect(harness.controller.emergencyStop()).rejects.toThrow('disk full');
    expect(harness.gateway.stopCalls).toBe(1);
    expect(harness.gateway.getStatus().running).toBe(false);
    expect(harness.controller.getStatus().lastError).toMatch(/stopped.*could not be persisted/);
  });

  it('stops a restored listener if its enabled state cannot be durably confirmed', async () => {
    const store = new MemoryStore();
    const protector = new TestProtector();
    const seeded = controller(store, protector, new FakeGateway());
    await seeded.controller.start(config);
    await seeded.controller.shutdown();
    store.failConfigWrites = true;

    const restarted = controller(store, protector, new FakeGateway());
    const restored = await restarted.controller.restoreOnStartup();
    expect(restarted.gateway.starts).toHaveLength(1);
    expect(restarted.gateway.stopCalls).toBe(1);
    expect(restored.gateway.running).toBe(false);
    expect(restored.lastError).toBe('DSH LAN Gateway restore failed');
  });

  it('certificate reset disables recovery and clears both public certificate and encrypted private key', async () => {
    const harness = controller();
    await harness.controller.start(config);
    const previousEncryptedKey = harness.store.values.get(DSH_LAN_PRIVATE_KEY_REF);
    const reset = await harness.controller.resetCertificate();
    expect(reset).toMatchObject({ desiredEnabled: false, gateway: { running: false } });
    expect(harness.store.values.get(DSH_LAN_CERTIFICATE_KEY)).toBe('');
    expect(harness.store.values.get(DSH_LAN_PRIVATE_KEY_REF)).toBe('');
    expect(harness.store.values.get(DSH_LAN_CONFIG_KEY)).toEqual({ enabled: false, config });

    await harness.controller.start(config);
    expect(harness.store.values.get(DSH_LAN_PRIVATE_KEY_REF)).not.toBe(previousEncryptedKey);
    expect(harness.protector.encryptCalls).toBe(2);
  });

  it('fails closed when safeStorage is unavailable or a persisted key cannot be decrypted', async () => {
    const unavailable = controller();
    unavailable.protector.available = false;
    await expect(unavailable.controller.start(config)).rejects.toThrow(/safeStorage is unavailable/);
    expect(unavailable.gateway.starts).toHaveLength(0);
    expect(unavailable.store.values.has(DSH_LAN_PRIVATE_KEY_REF)).toBe(false);
    expect(unavailable.controller.getStatus().lastError).toMatch(/safeStorage is unavailable/);

    const store = new MemoryStore();
    const protector = new TestProtector();
    const seeded = controller(store, protector, new FakeGateway());
    await seeded.controller.start(config);
    await seeded.controller.shutdown();
    protector.failDecrypt = true;
    const restarted = controller(store, protector, new FakeGateway());
    const restored = await restarted.controller.restoreOnStartup();
    expect(restored).toMatchObject({ desiredEnabled: true, gateway: { running: false } });
    expect(restored.lastError).toMatch(/cannot be decrypted/);
    expect(restarted.gateway.starts).toHaveLength(0);
  });

  it('requires certificate reset before changing to an authority absent from the stored SAN', async () => {
    const harness = controller();
    await harness.controller.start(config);
    await expect(harness.controller.start({ ...config, publicHost: 'nexus-new.test' }))
      .rejects.toThrow(/does not cover the configured authority/);
    expect(harness.gateway.getStatus().running).toBe(false);
    expect(harness.store.values.get(DSH_LAN_CONFIG_KEY)).toEqual({ enabled: true, config });
  });

  it('disables malformed persisted auto-start configuration instead of guessing defaults', async () => {
    const store = new MemoryStore();
    store.values.set(DSH_LAN_CONFIG_KEY, {
      enabled: true,
      config: { bindHost: '0.0.0.0', port: 18_766, publicHost: 'attacker.invalid', publicPort: 18_766 }
    });
    const harness = controller(store, new TestProtector(), new FakeGateway());
    expect(harness.controller.getStatus().lastError).toMatch(/configuration is invalid/);
    const restored = await harness.controller.restoreOnStartup();
    expect(restored).toMatchObject({ desiredEnabled: false, configured: null, gateway: { running: false } });
    expect(store.values.get(DSH_LAN_CONFIG_KEY)).toEqual({ enabled: false, config: null });
    expect(harness.gateway.starts).toHaveLength(0);
  });
});
