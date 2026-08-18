import { safeStorage } from 'electron';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  X509Certificate
} from 'node:crypto';
import { isIP } from 'node:net';
import {
  DshLanGateway,
  isPrivateDshLanAddress,
  type DshLanGatewayStartOptions,
  type DshLanGatewayStatus,
  type DshLanPairingOffer,
  type DshLanRole,
  type DshLanTlsIdentity
} from './dshLanGateway.js';

export const DSH_LAN_CONFIG_KEY = 'dsh:lan:gateway';
export const DSH_LAN_CERTIFICATE_KEY = 'dsh:lan:tls:certificate';
export const DSH_LAN_PRIVATE_KEY_REF = 'secret:dsh:lan:tls:privateKey';
export const DEFAULT_DSH_LAN_PORT = 18_766;
const MAX_TLS_SETTING_CHARS = 128 * 1024;

export interface DshLanGatewayConfig {
  bindHost: string;
  port: number;
  publicHost: string;
  publicPort: number;
}

export interface DshLanGatewayConfigInput {
  bindHost: string;
  port?: number;
  publicHost?: string;
  publicPort?: number;
}

export interface DshLanStoredState {
  enabled: boolean;
  config: DshLanGatewayConfig | null;
}

export interface DshLanGatewayControllerStatus {
  desiredEnabled: boolean;
  configured: DshLanGatewayConfig | null;
  gateway: DshLanGatewayStatus;
  lastError: string | null;
}

export interface DshLanSettingsStore {
  getSetting<T>(key: string, fallback: T): T;
  setSetting(key: string, value: unknown): void;
  transaction?(operation: () => void): void;
  audit?(entry: {
    id: string;
    actor: string;
    action: string;
    target: string;
    result: string;
    source?: string;
  }): void;
}

export interface DshLanSecretProtector {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface DshLanGatewayControlPort {
  getStatus(): DshLanGatewayStatus;
  start(options: DshLanGatewayStartOptions): Promise<DshLanGatewayStatus>;
  stop(): Promise<void>;
  createPairingOffer(role?: DshLanRole): DshLanPairingOffer;
}

interface LoadedState {
  state: DshLanStoredState;
  valid: boolean;
}

function runTransaction(store: DshLanSettingsStore, operation: () => void): void {
  if (store.transaction) store.transaction(operation);
  else operation();
}

function audit(
  store: DshLanSettingsStore,
  action: string,
  target: string,
  result: string
): void {
  try {
    store.audit?.({ id: randomUUID(), actor: 'admin', action, target, result, source: 'desktop' });
  } catch {
    // Audit persistence must not leak key material or prevent emergency cleanup.
  }
}

function normalizedCertificateHost(value: string): string {
  if (!value || value !== value.trim() || /[\s/@?#]/.test(value)) throw new Error('Invalid DSH LAN public host');
  const unwrapped = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  if (isIP(unwrapped)) return unwrapped.toLowerCase();
  if (unwrapped.includes(':')) throw new Error('Invalid DSH LAN public host');
  let parsed: URL;
  try { parsed = new URL(`https://${unwrapped}/`); } catch { throw new Error('Invalid DSH LAN public host'); }
  if (!parsed.hostname || parsed.hostname.includes(':')) throw new Error('Invalid DSH LAN public host');
  return parsed.hostname.toLowerCase();
}

export function normalizeDshLanGatewayConfig(input: DshLanGatewayConfigInput): DshLanGatewayConfig {
  if (!isPrivateDshLanAddress(input.bindHost)) {
    throw new Error('DSH LAN Gateway bind host must be a literal private or loopback address');
  }
  const port = input.port ?? DEFAULT_DSH_LAN_PORT;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid DSH LAN Gateway port');
  const publicHost = normalizedCertificateHost(input.publicHost ?? input.bindHost);
  const publicPort = input.publicPort ?? port;
  if (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535) {
    throw new Error('Invalid DSH LAN public port');
  }
  return { bindHost: input.bindHost, port, publicHost, publicPort };
}

function parseStoredState(value: unknown): LoadedState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { state: { enabled: false, config: null }, valid: value === null || value === undefined };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.enabled !== 'boolean') return { state: { enabled: false, config: null }, valid: false };
  if (record.config === null || record.config === undefined) {
    return { state: { enabled: record.enabled, config: null }, valid: !record.enabled };
  }
  if (typeof record.config !== 'object' || Array.isArray(record.config)) {
    return { state: { enabled: false, config: null }, valid: false };
  }
  try {
    const config = record.config as Record<string, unknown>;
    const normalized = normalizeDshLanGatewayConfig({
      bindHost: typeof config.bindHost === 'string' ? config.bindHost : '',
      port: typeof config.port === 'number' ? config.port : Number.NaN,
      publicHost: typeof config.publicHost === 'string' ? config.publicHost : '',
      publicPort: typeof config.publicPort === 'number' ? config.publicPort : Number.NaN
    });
    return { state: { enabled: record.enabled, config: normalized }, valid: true };
  } catch {
    return { state: { enabled: false, config: null }, valid: false };
  }
}

export function readPersistedDshLanState(store: Pick<DshLanSettingsStore, 'getSetting'>): DshLanStoredState {
  const loaded = parseStoredState(store.getSetting<unknown>(DSH_LAN_CONFIG_KEY, null));
  return loaded.valid ? loaded.state : { enabled: false, config: null };
}

export function dshLanAuthorityForConfig(config: DshLanGatewayConfig): string {
  const host = isIP(config.publicHost) === 6 ? `[${config.publicHost}]` : config.publicHost;
  return new URL(`https://${host}:${config.publicPort}/`).host;
}

export function readPersistedDshLanTrustedAuthorities(
  store: Pick<DshLanSettingsStore, 'getSetting'>
): readonly string[] {
  const state = readPersistedDshLanState(store);
  return state.enabled && state.config ? [dshLanAuthorityForConfig(state.config)] : [];
}

function fingerprint(certificate: X509Certificate): string {
  const der = certificate.publicKey.export({ format: 'der', type: 'spki' });
  return `sha256/${createHash('sha256').update(der).digest('base64')}`;
}

function assertTlsIdentity(keyPem: string, certificatePem: string, hosts: readonly string[], now: number): string {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certificatePem);
    const privateKey = createPrivateKey(keyPem);
    const publicFromPrivate = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    const publicFromCertificate = certificate.publicKey.export({ format: 'der', type: 'spki' });
    if (!Buffer.from(publicFromPrivate).equals(Buffer.from(publicFromCertificate))) {
      throw new Error('TLS key pair mismatch');
    }
  } catch {
    throw new Error('Stored DSH LAN TLS identity is invalid; reset the LAN certificate');
  }
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || now < validFrom || now >= validTo) {
    throw new Error('Stored DSH LAN TLS certificate is expired or not yet valid; reset the LAN certificate');
  }
  for (const host of new Set(hosts.map(normalizedCertificateHost))) {
    const match = isIP(host) ? certificate.checkIP(host) : certificate.checkHost(host);
    if (!match) throw new Error('Stored DSH LAN TLS certificate does not cover the configured authority; reset the LAN certificate');
  }
  return fingerprint(certificate);
}

/** Main-process-only safeStorage persistence for the DSH LAN TLS identity. */
export class DshLanTlsIdentityStore {
  constructor(
    private readonly store: DshLanSettingsStore,
    private readonly protector: DshLanSecretProtector = safeStorage,
    private readonly now: () => number = Date.now
  ) {}

  async ensure(config: DshLanGatewayConfig): Promise<DshLanTlsIdentity> {
    if (!this.protector.isEncryptionAvailable()) {
      audit(this.store, 'dsh.lan.tls.load', config.publicHost, 'safe-storage-unavailable');
      throw new Error('System safeStorage is unavailable; DSH LAN Gateway cannot protect its TLS private key');
    }
    const certificateValue = this.store.getSetting<unknown>(DSH_LAN_CERTIFICATE_KEY, null);
    const privateKeyValue = this.store.getSetting<unknown>(DSH_LAN_PRIVATE_KEY_REF, null);
    const certificateAbsent = certificateValue === null || certificateValue === '';
    const privateKeyAbsent = privateKeyValue === null || privateKeyValue === '';
    if (!certificateAbsent || !privateKeyAbsent) {
      if (typeof certificateValue !== 'string' || !certificateValue
        || typeof privateKeyValue !== 'string' || !privateKeyValue
        || certificateValue.length > MAX_TLS_SETTING_CHARS
        || privateKeyValue.length > MAX_TLS_SETTING_CHARS
        || privateKeyValue.length % 4 !== 0
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(privateKeyValue)) {
        audit(this.store, 'dsh.lan.tls.load', config.publicHost, 'invalid');
        throw new Error('Stored DSH LAN TLS identity is incomplete; reset the LAN certificate');
      }
      try {
        const keyPem = this.protector.decryptString(Buffer.from(privateKeyValue, 'base64'));
        const identityFingerprint = assertTlsIdentity(
          keyPem,
          certificateValue,
          [config.publicHost],
          this.now()
        );
        audit(this.store, 'dsh.lan.tls.load', identityFingerprint, 'ok');
        return { key: keyPem, cert: certificateValue };
      } catch (error) {
        audit(this.store, 'dsh.lan.tls.load', config.publicHost, 'invalid');
        if (error instanceof Error && error.message.startsWith('Stored DSH LAN TLS')) throw error;
        throw new Error('Stored DSH LAN TLS identity cannot be decrypted; reset the LAN certificate');
      }
    }

    try {
      const identity = await this.generate(config);
      const identityFingerprint = assertTlsIdentity(
        identity.key,
        identity.cert,
        [config.publicHost],
        this.now()
      );
      const encrypted = this.protector.encryptString(identity.key).toString('base64');
      runTransaction(this.store, () => {
        this.store.setSetting(DSH_LAN_CERTIFICATE_KEY, identity.cert);
        this.store.setSetting(DSH_LAN_PRIVATE_KEY_REF, encrypted);
      });
      audit(this.store, 'dsh.lan.tls.create', identityFingerprint, 'ok');
      return identity;
    } catch (error) {
      audit(this.store, 'dsh.lan.tls.create', config.publicHost, 'error');
      throw error;
    }
  }

  reset(): void {
    runTransaction(this.store, () => {
      this.store.setSetting(DSH_LAN_CERTIFICATE_KEY, '');
      this.store.setSetting(DSH_LAN_PRIVATE_KEY_REF, '');
    });
    audit(this.store, 'dsh.lan.tls.reset', 'all-lan-sessions', 'repair-required');
  }

  private async generate(config: DshLanGatewayConfig): Promise<{ key: string; cert: string }> {
    const hosts = new Set([
      normalizedCertificateHost(config.publicHost),
      normalizedCertificateHost(config.bindHost),
      '127.0.0.1'
    ]);
    const altNames: Array<{ type: 2; value: string } | { type: 7; ip: string }> = [];
    for (const host of hosts) {
      if (isIP(host)) altNames.push({ type: 7, ip: host });
      else altNames.push({ type: 2, value: host });
    }
    const selfsigned = (await import('selfsigned')).default;
    const generated = await selfsigned.generate(
      [{ name: 'commonName', value: 'OPC-Nexus DSH LAN Gateway' }],
      {
        algorithm: 'sha256',
        keyType: 'rsa',
        keySize: 2048,
        notAfterDate: new Date(this.now() + 10 * 365 * 86_400_000),
        extensions: [
          { name: 'basicConstraints', cA: false },
          { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
          { name: 'extKeyUsage', serverAuth: true },
          { name: 'subjectAltName', altNames }
        ]
      }
    );
    return { key: generated.private, cert: generated.cert };
  }
}

/**
 * Persistent Main-process controller. Its status deliberately excludes both
 * the certificate PEM and private key; only the public SPKI fingerprint from
 * DshLanGateway is exposed.
 */
export class DshLanGatewayController {
  private desiredEnabled = false;
  private configured: DshLanGatewayConfig | null = null;
  private activeConfig: DshLanGatewayConfig | null = null;
  private lastError: string | null = null;
  private operation: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: DshLanSettingsStore,
    private readonly gateway: DshLanGatewayControlPort,
    private readonly identities = new DshLanTlsIdentityStore(store)
  ) {
    const loaded = this.loadState();
    this.desiredEnabled = loaded.state.enabled;
    this.configured = loaded.state.config;
    if (!loaded.valid) this.lastError = 'Stored DSH LAN Gateway configuration is invalid';
  }

  getStatus(): DshLanGatewayControllerStatus {
    return {
      desiredEnabled: this.desiredEnabled,
      configured: this.configured ? { ...this.configured } : null,
      gateway: this.gateway.getStatus(),
      lastError: this.lastError
    };
  }

  getTrustedAuthorities(): readonly string[] {
    return [...this.gateway.getStatus().trustedAuthorities];
  }

  start(input: DshLanGatewayConfigInput): Promise<DshLanGatewayControllerStatus> {
    return this.exclusive(() => this.startInternal(normalizeDshLanGatewayConfig(input), false));
  }

  /**
   * Persist a user's request to enable LAN without opening a listener yet.
   * The composition layer uses this while the managed DSH runtime is still
   * starting (or when more than one candidate is READY). Keeping the intent in
   * the same validated store means a later runtime-ready event can restore it
   * without asking the user to repeat the configuration.
   */
  rememberEnabledIntent(input: DshLanGatewayConfigInput): DshLanGatewayControllerStatus {
    const config = normalizeDshLanGatewayConfig(input);
    this.persistState({ enabled: true, config });
    this.desiredEnabled = true;
    this.configured = config;
    this.lastError = null;
    return this.getStatus();
  }

  restoreOnStartup(): Promise<DshLanGatewayControllerStatus> {
    return this.exclusive(async () => {
      const loaded = this.loadState();
      this.desiredEnabled = loaded.state.enabled;
      this.configured = loaded.state.config;
      if (!loaded.valid) {
        this.persistState({ enabled: false, config: null });
        this.desiredEnabled = false;
        this.lastError = 'Stored DSH LAN Gateway configuration is invalid';
        audit(this.store, 'dsh.lan.restore', 'configuration', 'disabled-invalid');
        return this.getStatus();
      }
      if (!loaded.state.enabled || !loaded.state.config) {
        this.lastError = null;
        return this.getStatus();
      }
      try {
        return await this.startInternal(loaded.state.config, true);
      } catch (error) {
        this.lastError = this.publicError(error, 'DSH LAN Gateway restore failed');
        audit(this.store, 'dsh.lan.restore', loaded.state.config.publicHost, 'error');
        return this.getStatus();
      }
    });
  }

  createPairingCode(role: DshLanRole = 'operator'): DshLanPairingOffer {
    return this.gateway.createPairingOffer(role);
  }

  /** App shutdown: revoke live sessions but preserve restart intent. */
  shutdown(): Promise<DshLanGatewayControllerStatus> {
    return this.exclusive(async () => {
      await this.gateway.stop();
      this.activeConfig = null;
      audit(this.store, 'dsh.lan.shutdown', this.configured?.publicHost ?? 'not-configured', 'ok');
      return this.getStatus();
    });
  }

  /** User emergency stop: persist disabled first, then revoke every session/socket. */
  emergencyStop(): Promise<DshLanGatewayControllerStatus> {
    return this.exclusive(() => this.emergencyStopInternal());
  }

  resetCertificate(): Promise<DshLanGatewayControllerStatus> {
    return this.exclusive(async () => {
      await this.emergencyStopInternal();
      this.identities.reset();
      return this.getStatus();
    });
  }

  private async startInternal(
    config: DshLanGatewayConfig,
    restoring: boolean
  ): Promise<DshLanGatewayControllerStatus> {
    const current = this.gateway.getStatus();
    if (current.running && (!this.activeConfig || !this.sameConfig(this.activeConfig, config))) {
      await this.gateway.stop();
      this.activeConfig = null;
    }
    try {
      const tls = await this.identities.ensure(config);
      await this.gateway.start({
        bindHost: config.bindHost,
        port: config.port,
        publicHost: config.publicHost,
        publicPort: config.publicPort,
        tls
      });
      this.persistState({ enabled: true, config });
      this.desiredEnabled = true;
      this.configured = config;
      this.activeConfig = config;
      this.lastError = null;
      audit(this.store, restoring ? 'dsh.lan.restore' : 'dsh.lan.start', config.publicHost, 'ok');
      return this.getStatus();
    } catch (error) {
      try { await this.gateway.stop(); } catch { /* start remains failed closed */ }
      this.activeConfig = null;
      this.lastError = this.publicError(error, 'DSH LAN Gateway failed to start');
      throw error;
    }
  }

  private async emergencyStopInternal(): Promise<DshLanGatewayControllerStatus> {
    let persistenceError: unknown;
    const state: DshLanStoredState = { enabled: false, config: this.configured };
    try {
      this.persistState(state);
      this.desiredEnabled = false;
    } catch (error) {
      persistenceError = error;
    }
    try {
      await this.gateway.stop();
    } finally {
      this.activeConfig = null;
      audit(this.store, 'dsh.lan.emergency-stop', this.configured?.publicHost ?? 'not-configured', 'revoked');
    }
    if (persistenceError) {
      this.lastError = 'DSH LAN Gateway stopped, but disabled state could not be persisted';
      throw persistenceError;
    }
    this.lastError = null;
    return this.getStatus();
  }

  private loadState(): LoadedState {
    return parseStoredState(this.store.getSetting<unknown>(DSH_LAN_CONFIG_KEY, null));
  }

  private persistState(state: DshLanStoredState): void {
    this.store.setSetting(DSH_LAN_CONFIG_KEY, state);
  }

  private sameConfig(left: DshLanGatewayConfig, right: DshLanGatewayConfig): boolean {
    return left.bindHost === right.bindHost
      && left.port === right.port
      && left.publicHost === right.publicHost
      && left.publicPort === right.publicPort;
  }

  private publicError(error: unknown, fallback: string): string {
    if (!(error instanceof Error)) return fallback;
    const safePrefixes = [
      'System safeStorage is unavailable',
      'Stored DSH LAN TLS',
      'DSH LAN TLS certificate',
      'Invalid DSH LAN',
      'DSH LAN Gateway bind host'
    ];
    return safePrefixes.some((prefix) => error.message.startsWith(prefix)) ? error.message : fallback;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function createDshLanGatewayController(
  store: DshLanSettingsStore,
  gateway: DshLanGateway
): DshLanGatewayController {
  return new DshLanGatewayController(store, gateway);
}
