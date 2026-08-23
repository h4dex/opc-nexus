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
  SecureLanGateway,
  isPrivateSecureLanAddress,
  type SecureLanGatewayStartOptions,
  type SecureLanGatewayStatus,
  type SecureLanPairingOffer,
  type SecureLanRole,
  type SecureLanTlsIdentity
} from './secureLanGateway.js';

export const SECURE_LAN_CERTIFICATE_KEY = 'secure:lan:tls:certificate';
export const SECURE_LAN_PRIVATE_KEY_REF = 'secret:secure:lan:tls:privateKey';
export const DEFAULT_SECURE_LAN_PORT = 18_766;
const MAX_TLS_SETTING_CHARS = 128 * 1024;

export interface SecureLanTlsIdentityOptions {
  /** Settings namespace used by the caller. Hermes uses its own namespace. */
  certificateKey?: string;
  privateKeyRef?: string;
  auditPrefix?: string;
  commonName?: string;
}

export interface SecureLanGatewayConfig {
  bindHost: string;
  port: number;
  publicHost: string;
  publicPort: number;
}

export interface SecureLanGatewayConfigInput {
  bindHost: string;
  port?: number;
  publicHost?: string;
  publicPort?: number;
}

export interface SecureLanStoredState {
  enabled: boolean;
  config: SecureLanGatewayConfig | null;
}

export interface SecureLanGatewayControllerStatus {
  desiredEnabled: boolean;
  configured: SecureLanGatewayConfig | null;
  gateway: SecureLanGatewayStatus;
  lastError: string | null;
}

export interface SecureLanSettingsStore {
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

export interface SecureLanSecretProtector {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface SecureLanGatewayControlPort {
  getStatus(): SecureLanGatewayStatus;
  start(options: SecureLanGatewayStartOptions): Promise<SecureLanGatewayStatus>;
  stop(): Promise<void>;
  createPairingOffer(role?: SecureLanRole): SecureLanPairingOffer;
}

export class SecureLanTlsHostMismatchError extends Error {
  constructor() {
    super('Stored Secure LAN TLS certificate does not cover the configured authority; reset the LAN certificate');
    this.name = 'SecureLanTlsHostMismatchError';
  }
}

interface LoadedState {
  state: SecureLanStoredState;
  valid: boolean;
}

function runTransaction(store: SecureLanSettingsStore, operation: () => void): void {
  if (store.transaction) store.transaction(operation);
  else operation();
}

function audit(
  store: SecureLanSettingsStore,
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
  if (!value || value !== value.trim() || /[\s/@?#]/.test(value)) throw new Error('Invalid Secure LAN public host');
  const unwrapped = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  if (isIP(unwrapped)) return unwrapped.toLowerCase();
  if (unwrapped.includes(':')) throw new Error('Invalid Secure LAN public host');
  let parsed: URL;
  try { parsed = new URL(`https://${unwrapped}/`); } catch { throw new Error('Invalid Secure LAN public host'); }
  if (!parsed.hostname || parsed.hostname.includes(':')) throw new Error('Invalid Secure LAN public host');
  return parsed.hostname.toLowerCase();
}

export function normalizeSecureLanGatewayConfig(input: SecureLanGatewayConfigInput): SecureLanGatewayConfig {
  if (!isPrivateSecureLanAddress(input.bindHost)) {
    throw new Error('Secure LAN Gateway bind host must be a literal private or loopback address');
  }
  const port = input.port ?? DEFAULT_SECURE_LAN_PORT;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid Secure LAN Gateway port');
  const publicHost = normalizedCertificateHost(input.publicHost ?? input.bindHost);
  const publicPort = input.publicPort ?? port;
  if (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535) {
    throw new Error('Invalid Secure LAN public port');
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
    const normalized = normalizeSecureLanGatewayConfig({
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

export const SECURE_LAN_CONFIG_KEY = 'secure:lan:gateway';

export function readPersistedSecureLanState(store: Pick<SecureLanSettingsStore, 'getSetting'>): SecureLanStoredState {
  const loaded = parseStoredState(store.getSetting<unknown>(SECURE_LAN_CONFIG_KEY, null));
  return loaded.valid ? loaded.state : { enabled: false, config: null };
}

export function secureLanAuthorityForConfig(config: SecureLanGatewayConfig): string {
  const host = isIP(config.publicHost) === 6 ? `[${config.publicHost}]` : config.publicHost;
  return new URL(`https://${host}:${config.publicPort}/`).host;
}

export function readPersistedSecureLanTrustedAuthorities(
  store: Pick<SecureLanSettingsStore, 'getSetting'>
): readonly string[] {
  const state = readPersistedSecureLanState(store);
  return state.enabled && state.config ? [secureLanAuthorityForConfig(state.config)] : [];
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
    throw new Error('Stored Secure LAN TLS identity is invalid; reset the LAN certificate');
  }
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || now < validFrom || now >= validTo) {
    throw new Error('Stored Secure LAN TLS certificate is expired or not yet valid; reset the LAN certificate');
  }
  for (const host of new Set(hosts.map(normalizedCertificateHost))) {
    const match = isIP(host) ? certificate.checkIP(host) : certificate.checkHost(host);
    if (!match) throw new SecureLanTlsHostMismatchError();
  }
  return fingerprint(certificate);
}

/** Main-process-only safeStorage persistence for the Secure LAN TLS identity. */
export class SecureLanTlsIdentityStore {
  private readonly certificateKey: string;
  private readonly privateKeyRef: string;
  private readonly auditPrefix: string;
  private readonly commonName: string;

  constructor(
    private readonly store: SecureLanSettingsStore,
    private readonly protector: SecureLanSecretProtector = safeStorage,
    private readonly now: () => number = Date.now,
    options: SecureLanTlsIdentityOptions = {}
  ) {
    this.certificateKey = options.certificateKey ?? SECURE_LAN_CERTIFICATE_KEY;
    this.privateKeyRef = options.privateKeyRef ?? SECURE_LAN_PRIVATE_KEY_REF;
    this.auditPrefix = options.auditPrefix ?? 'secure.lan';
    this.commonName = options.commonName ?? 'OPC-Nexus Secure LAN Gateway';
  }

  async ensure(config: SecureLanGatewayConfig): Promise<SecureLanTlsIdentity> {
    if (!this.protector.isEncryptionAvailable()) {
      audit(this.store, `${this.auditPrefix}.tls.load`, config.publicHost, 'safe-storage-unavailable');
      throw new Error('System safeStorage is unavailable; Secure LAN Gateway cannot protect its TLS private key');
    }
    const certificateValue = this.store.getSetting<unknown>(this.certificateKey, null);
    const privateKeyValue = this.store.getSetting<unknown>(this.privateKeyRef, null);
    const certificateAbsent = certificateValue === null || certificateValue === '';
    const privateKeyAbsent = privateKeyValue === null || privateKeyValue === '';
    if (!certificateAbsent || !privateKeyAbsent) {
      if (typeof certificateValue !== 'string' || !certificateValue
        || typeof privateKeyValue !== 'string' || !privateKeyValue
        || certificateValue.length > MAX_TLS_SETTING_CHARS
        || privateKeyValue.length > MAX_TLS_SETTING_CHARS
        || privateKeyValue.length % 4 !== 0
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(privateKeyValue)) {
        audit(this.store, `${this.auditPrefix}.tls.load`, config.publicHost, 'invalid');
        throw new Error('Stored Secure LAN TLS identity is incomplete; reset the LAN certificate');
      }
      try {
        const keyPem = this.protector.decryptString(Buffer.from(privateKeyValue, 'base64'));
        const identityFingerprint = assertTlsIdentity(
          keyPem,
          certificateValue,
          [config.publicHost],
          this.now()
        );
        audit(this.store, `${this.auditPrefix}.tls.load`, identityFingerprint, 'ok');
        return { key: keyPem, cert: certificateValue };
      } catch (error) {
        audit(this.store, `${this.auditPrefix}.tls.load`, config.publicHost, 'invalid');
        if (error instanceof Error && error.message.startsWith('Stored Secure LAN TLS')) throw error;
        throw new Error('Stored Secure LAN TLS identity cannot be decrypted; reset the LAN certificate');
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
        this.store.setSetting(this.certificateKey, identity.cert);
        this.store.setSetting(this.privateKeyRef, encrypted);
      });
      audit(this.store, `${this.auditPrefix}.tls.create`, identityFingerprint, 'ok');
      return identity;
    } catch (error) {
      audit(this.store, `${this.auditPrefix}.tls.create`, config.publicHost, 'error');
      throw error;
    }
  }

  reset(): void {
    runTransaction(this.store, () => {
      this.store.setSetting(this.certificateKey, '');
      this.store.setSetting(this.privateKeyRef, '');
    });
    audit(this.store, `${this.auditPrefix}.tls.reset`, 'all-lan-sessions', 'repair-required');
  }

  private async generate(config: SecureLanGatewayConfig): Promise<{ key: string; cert: string }> {
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
      [{ name: 'commonName', value: this.commonName }],
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
 * SecureLanGateway is exposed.
 */
export class SecureLanGatewayController {
  private desiredEnabled = false;
  private configured: SecureLanGatewayConfig | null = null;
  private activeConfig: SecureLanGatewayConfig | null = null;
  private lastError: string | null = null;
  private operation: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: SecureLanSettingsStore,
    private readonly gateway: SecureLanGatewayControlPort,
    private readonly identities = new SecureLanTlsIdentityStore(store)
  ) {
    const loaded = this.loadState();
    this.desiredEnabled = loaded.state.enabled;
    this.configured = loaded.state.config;
    if (!loaded.valid) this.lastError = 'Stored Secure LAN Gateway configuration is invalid';
  }

  getStatus(): SecureLanGatewayControllerStatus {
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

  start(input: SecureLanGatewayConfigInput): Promise<SecureLanGatewayControllerStatus> {
    return this.exclusive(() => this.startInternal(normalizeSecureLanGatewayConfig(input), false));
  }

  /**
   * Persist a user's request to enable LAN without opening a listener yet.
   * A composition layer may use this while its upstream runtime is still
   * starting. Keeping the intent in
   * the same validated store means a later runtime-ready event can restore it
   * without asking the user to repeat the configuration.
   */
  rememberEnabledIntent(input: SecureLanGatewayConfigInput): SecureLanGatewayControllerStatus {
    const config = normalizeSecureLanGatewayConfig(input);
    this.persistState({ enabled: true, config });
    this.desiredEnabled = true;
    this.configured = config;
    this.lastError = null;
    return this.getStatus();
  }

  restoreOnStartup(): Promise<SecureLanGatewayControllerStatus> {
    return this.exclusive(async () => {
      const loaded = this.loadState();
      this.desiredEnabled = loaded.state.enabled;
      this.configured = loaded.state.config;
      if (!loaded.valid) {
        this.persistState({ enabled: false, config: null });
        this.desiredEnabled = false;
        this.lastError = 'Stored Secure LAN Gateway configuration is invalid';
        audit(this.store, 'secure.lan.restore', 'configuration', 'disabled-invalid');
        return this.getStatus();
      }
      if (!loaded.state.enabled || !loaded.state.config) {
        this.lastError = null;
        return this.getStatus();
      }
      try {
        return await this.startInternal(loaded.state.config, true);
      } catch (error) {
        this.lastError = this.publicError(error, 'Secure LAN Gateway restore failed');
        audit(this.store, 'secure.lan.restore', loaded.state.config.publicHost, 'error');
        return this.getStatus();
      }
    });
  }

  createPairingCode(role: SecureLanRole = 'operator'): SecureLanPairingOffer {
    return this.gateway.createPairingOffer(role);
  }

  /** App shutdown: revoke live sessions but preserve restart intent. */
  shutdown(): Promise<SecureLanGatewayControllerStatus> {
    return this.exclusive(async () => {
      await this.gateway.stop();
      this.activeConfig = null;
      audit(this.store, 'secure.lan.shutdown', this.configured?.publicHost ?? 'not-configured', 'ok');
      return this.getStatus();
    });
  }

  /** User emergency stop: persist disabled first, then revoke every session/socket. */
  emergencyStop(): Promise<SecureLanGatewayControllerStatus> {
    return this.exclusive(() => this.emergencyStopInternal());
  }

  resetCertificate(): Promise<SecureLanGatewayControllerStatus> {
    return this.exclusive(async () => {
      await this.emergencyStopInternal();
      this.identities.reset();
      return this.getStatus();
    });
  }

  private async startInternal(
    config: SecureLanGatewayConfig,
    restoring: boolean
  ): Promise<SecureLanGatewayControllerStatus> {
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
      audit(this.store, restoring ? 'secure.lan.restore' : 'secure.lan.start', config.publicHost, 'ok');
      return this.getStatus();
    } catch (error) {
      try { await this.gateway.stop(); } catch { /* start remains failed closed */ }
      this.activeConfig = null;
      this.lastError = this.publicError(error, 'Secure LAN Gateway failed to start');
      throw error;
    }
  }

  private async emergencyStopInternal(): Promise<SecureLanGatewayControllerStatus> {
    let persistenceError: unknown;
    const state: SecureLanStoredState = { enabled: false, config: this.configured };
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
      audit(this.store, 'secure.lan.emergency-stop', this.configured?.publicHost ?? 'not-configured', 'revoked');
    }
    if (persistenceError) {
      this.lastError = 'Secure LAN Gateway stopped, but disabled state could not be persisted';
      throw persistenceError;
    }
    this.lastError = null;
    return this.getStatus();
  }

  private loadState(): LoadedState {
    return parseStoredState(this.store.getSetting<unknown>(SECURE_LAN_CONFIG_KEY, null));
  }

  private persistState(state: SecureLanStoredState): void {
    this.store.setSetting(SECURE_LAN_CONFIG_KEY, state);
  }

  private sameConfig(left: SecureLanGatewayConfig, right: SecureLanGatewayConfig): boolean {
    return left.bindHost === right.bindHost
      && left.port === right.port
      && left.publicHost === right.publicHost
      && left.publicPort === right.publicPort;
  }

  private publicError(error: unknown, fallback: string): string {
    if (!(error instanceof Error)) return fallback;
    const safePrefixes = [
      'System safeStorage is unavailable',
      'Stored Secure LAN TLS',
      'Secure LAN TLS certificate',
      'Invalid Secure LAN',
      'Secure LAN Gateway bind host'
    ];
    return safePrefixes.some((prefix) => error.message.startsWith(prefix)) ? error.message : fallback;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function createSecureLanGatewayController(
  store: SecureLanSettingsStore,
  gateway: SecureLanGateway
): SecureLanGatewayController {
  return new SecureLanGatewayController(store, gateway);
}
