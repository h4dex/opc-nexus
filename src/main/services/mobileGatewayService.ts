import { app, safeStorage } from 'electron';
import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify as verifySignature,
  X509Certificate
} from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { basename, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import type {
  Agent,
  MobileAgentConfig,
  MobileArtifact,
  MobileArtifactKind,
  MobileCommandLog,
  MobileCommandStatus,
  MobileControlSession,
  MobileDevice,
  MobileEvent,
  MobileGatewayStatus,
  MobilePairingOffer,
  MobilePermissionName,
  MobilePermissionState,
  MobileScriptDefinition,
  MobileScriptStep,
  MobileToolName,
  Task
} from '../../shared/types.js';
import type { Database } from './database.js';
import {
  MobileProfileService,
  type MobileProfileCheckpoint,
  type PreparedMobileRuntime
} from './mobileProfileService.js';
import {
  MOBILE_PROTOCOL_VERSION,
  MOBILE_TOOL_NAMES,
  assertMobilePermissions,
  getMobileTool,
  isMobileToolName,
  redactMobileValue,
  toMobileBridgeCommand,
  validateMobileScript,
  validateMobileScriptSteps,
  validateMobileToolArgs
} from './mobileCatalog.js';

const DEFAULT_WSS_PORT = 18765;
const PAIRING_TTL_MS = 5 * 60_000;
const TASK_TOKEN_TTL_MS = 15 * 60_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const OFFLINE_AFTER_MS = 30_000;
const COMMAND_TIMEOUT_MS = 30_000;
const AUTH_WINDOW_MS = 60_000;
const AUTH_FAILURE_LIMIT = 5;
const AUTH_BAN_MS = 5 * 60_000;
const MAX_PLUGIN_BODY = 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;
const MAX_SCREEN_RECORD_BYTES = 64 * 1024 * 1024;
const MAX_AUDIO_BYTES = 128 * 1024 * 1024;
const PREVIEW_CACHE_MS = 750;
const SIGNING_PREFIX = 'opcnexus-mobile-v1';
const PAIRING_QR_SCALE = 8;
const PAIRING_QR_MARGIN_MODULES = 4;
const MAX_CONSOLE_UI_NODES = 800;

interface PairingSecret {
  id: string;
  secret: string;
  expiresAt: number;
  payload: string;
  png: Buffer;
}

interface TaskToken {
  token: string;
  sessionId: string;
  agentId: string;
  deviceId: string;
  taskId: string;
  allowedTools: Set<MobileToolName>;
  expiresAt: number;
}

interface DeviceConnection {
  deviceId: string;
  ws: WebSocket;
  ip: string;
  lastSeenAt: number;
  pending: Map<string, PendingCommand>;
}

interface PendingStream {
  filename: string;
  mimeType: string;
  expectedSize: number;
  maxSize: number;
  chunks: Buffer[];
  bytes: number;
}

interface PendingCommand {
  requestId: string;
  toolName: MobileToolName;
  nonIdempotent: boolean;
  timer: NodeJS.Timeout;
  resolve: (value: BridgeResponse) => void;
  reject: (error: Error) => void;
  stream?: PendingStream;
}

interface BridgeResponse {
  status: number;
  result: Record<string, unknown>;
  stream?: { filename: string; mimeType: string; data: Buffer; sha256: string };
}

interface AuthFailureState {
  attempts: number[];
  bannedUntil: number;
}

interface CommandContext {
  sessionId: string | null;
  agentId: string | null;
  deviceId: string;
  taskId: string | null;
  allowedTools: Set<MobileToolName>;
}

export interface MobileAgentProvisionCheckpoint {
  agentId: string;
  config: Record<string, unknown> | null;
  profile: MobileProfileCheckpoint;
}

class MobileDisconnectedError extends Error {
  constructor(readonly uncertain: boolean) {
    super(uncertain ? 'Device disconnected after a non-idempotent command was sent' : 'Device disconnected');
  }
}

export function isRfc1918Ipv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function listRfc1918Addresses(): string[] {
  const values = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isRfc1918Ipv4(entry.address)) values.add(entry.address);
    }
  }
  return [...values].sort();
}

export function mobileSigningPayload(deviceId: string, nonce: string): Buffer {
  return Buffer.from(`${SIGNING_PREFIX}\n${deviceId}\n${nonce}`, 'utf8');
}

export function hashMobileUiTreeResult(value: unknown): string {
  type HashWork = { type: 'value'; value: unknown } | { type: 'token'; value: string };
  const hash = createHash('sha256');
  const work: HashWork[] = [{ type: 'value', value }];
  while (work.length > 0) {
    const item = work.pop()!;
    if (item.type === 'token') {
      hash.update(item.value, 'utf8');
      continue;
    }
    const current = item.value;
    if (current === null) {
      hash.update('null;', 'utf8');
    } else if (typeof current === 'string') {
      hash.update(`s${Buffer.byteLength(current, 'utf8')}:`, 'utf8');
      hash.update(current, 'utf8');
    } else if (typeof current === 'number') {
      hash.update(`d${Number.isFinite(current) ? current : 'invalid'};`, 'utf8');
    } else if (typeof current === 'boolean') {
      hash.update(current ? 'b1;' : 'b0;', 'utf8');
    } else if (Array.isArray(current)) {
      hash.update(`a${current.length}[`, 'utf8');
      work.push({ type: 'token', value: ']' });
      for (let index = current.length - 1; index >= 0; index -= 1) {
        work.push({ type: 'value', value: current[index] });
      }
    } else if (typeof current === 'object') {
      const record = current as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      hash.update(`o${keys.length}{`, 'utf8');
      work.push({ type: 'token', value: '}' });
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index];
        work.push({ type: 'value', value: record[key] });
        work.push({ type: 'token', value: `k${Buffer.byteLength(key, 'utf8')}:${key}` });
      }
    } else {
      hash.update('unsupported;', 'utf8');
    }
  }
  return hash.digest('base64url');
}

export function limitMobileUiTree(result: Record<string, unknown>, limit = MAX_CONSOLE_UI_NODES): Record<string, unknown> {
  if (!Array.isArray(result.tree) || !Number.isInteger(limit) || limit < 1) return result;
  let remaining = limit;
  let copied = 0;
  const copyNode = (node: unknown): Record<string, unknown> | null => {
    if (remaining <= 0 || !node || typeof node !== 'object' || Array.isArray(node)) return null;
    remaining -= 1;
    copied += 1;
    const value = node as Record<string, unknown>;
    const next: Record<string, unknown> = { ...value };
    if (Array.isArray(value.children)) {
      const children: Record<string, unknown>[] = [];
      for (const child of value.children) {
        const copiedChild = copyNode(child);
        if (copiedChild) children.push(copiedChild);
        if (remaining <= 0) break;
      }
      next.children = children;
    }
    return next;
  };
  const tree: Record<string, unknown>[] = [];
  for (const root of result.tree) {
    const copiedRoot = copyNode(root);
    if (copiedRoot) tree.push(copiedRoot);
    if (remaining <= 0) break;
  }
  const reportedCount = typeof result.count === 'number' ? result.count : copied;
  return {
    ...result,
    tree,
    renderedCount: copied,
    truncated: reportedCount > copied
  };
}

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseStringArray<T extends string>(value: unknown): T[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is T => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function remoteIp(req: IncomingMessage): string {
  return (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
}

function isLoopback(address: string): boolean {
  const normalized = address.replace(/^::ffff:/, '');
  return normalized === '127.0.0.1' || normalized === '::1';
}

function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

function artifactLimit(kind: MobileArtifactKind): number {
  if (kind === 'screen_recording') return MAX_SCREEN_RECORD_BYTES;
  if (kind === 'audio') return MAX_AUDIO_BYTES;
  return MAX_SCREENSHOT_BYTES;
}

function artifactExtension(kind: MobileArtifactKind, mimeType: string): string {
  if (kind === 'screen_recording' || mimeType === 'video/mp4') return '.mp4';
  if (kind === 'audio' || mimeType === 'audio/wav') return '.wav';
  return mimeType === 'image/jpeg' ? '.jpg' : '.png';
}

export class MobileGatewayService {
  private httpsServer: HttpsServer | null = null;
  private pluginServer: HttpServer | null = null;
  private wsServer: WebSocketServer | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private host: string | null = null;
  private wssPort: number | null = null;
  private pluginPort: number | null = null;
  private certificateFingerprint: string | null = null;
  private lastError: string | null = null;
  private pairings = new Map<string, PairingSecret>();
  private taskTokens = new Map<string, TaskToken>();
  private connections = new Map<string, DeviceConnection>();
  private authFailures = new Map<string, AuthFailureState>();
  private listeners = new Set<(event: MobileEvent) => void>();
  private previews = new Map<string, { data: Buffer; mimeType: string; sha256: string; updatedAt: number }>();
  private previewRefreshes = new Map<string, Promise<string>>();
  private profiles: MobileProfileService;

  constructor(private db: Database) {
    this.profiles = new MobileProfileService(db);
  }

  onEvent(listener: (event: MobileEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(type: MobileEvent['type'], payload: Omit<MobileEvent, 'type' | 'timestamp'> = { payload: {} }): void {
    const { payload: data, ...context } = payload;
    const event: MobileEvent = { type, ...context, payload: data ?? {}, timestamp: Date.now() };
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* listeners cannot break gateway */ }
    }
  }

  getStatus(): MobileGatewayStatus {
    return {
      running: !!this.httpsServer?.listening && !!this.pluginServer?.listening,
      host: this.host,
      wssPort: this.wssPort,
      pluginPort: this.pluginPort,
      certificateFingerprint: this.certificateFingerprint,
      error: this.lastError
    };
  }

  getLanAddresses(): string[] {
    return listRfc1918Addresses();
  }

  private async ensureTlsCertificate(host: string): Promise<{ key: string; cert: string; fingerprint: string }> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('System safeStorage is unavailable; Mobile Gateway cannot protect its TLS private key');
    const cert = this.db.getSetting<string>('mobile:tls:certificate', '');
    const encryptedKey = this.db.getSetting<string>('secret:mobile:tls:privateKey', '');
    if (cert && encryptedKey) {
      try {
        const key = safeStorage.decryptString(Buffer.from(encryptedKey, 'base64'));
        if (!new X509Certificate(cert).checkIP(host)) {
          throw new Error('Stored Mobile Gateway certificate does not cover this LAN address; reset the certificate and pair devices again');
        }
        return { key, cert, fingerprint: this.spkiFingerprint(cert) };
      } catch {
        throw new Error('Stored Mobile Gateway TLS identity cannot be used for this address; reset the mobile certificate');
      }
    }

    const selfsigned = (await import('selfsigned')).default;
    const generated = await selfsigned.generate(
      [{ name: 'commonName', value: 'OPC-Nexus Mobile Gateway' }],
      {
        algorithm: 'sha256',
        keyType: 'rsa',
        keySize: 2048,
        notAfterDate: new Date(Date.now() + 10 * 365 * 86_400_000),
        extensions: [
          { name: 'basicConstraints', cA: false },
          { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
          { name: 'extKeyUsage', serverAuth: true },
          { name: 'subjectAltName', altNames: [{ type: 7, ip: host }, { type: 7, ip: '127.0.0.1' }] }
        ]
      }
    );
    this.db.setSetting('mobile:tls:certificate', generated.cert);
    this.db.setSetting('secret:mobile:tls:privateKey', safeStorage.encryptString(generated.private).toString('base64'));
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'mobile.tls.create', target: host, result: 'ok' });
    return { key: generated.private, cert: generated.cert, fingerprint: this.spkiFingerprint(generated.cert) };
  }

  private spkiFingerprint(certPem: string): string {
    const cert = new X509Certificate(certPem);
    const der = cert.publicKey.export({ format: 'der', type: 'spki' });
    return `sha256/${createHash('sha256').update(der).digest('base64')}`;
  }

  async start(host: string, port = DEFAULT_WSS_PORT): Promise<MobileGatewayStatus> {
    if (this.getStatus().running) {
      if (host === this.host && port === this.wssPort) return this.getStatus();
      await this.stop();
    }
    // A process crash cannot leave a live in-memory token or device socket.
    // Clear persisted leases before accepting a new connection so a queued
    // Android task is not blocked by a session from the previous process.
    this.recoverStaleSessions();
    if (!isRfc1918Ipv4(host)) throw new Error('Mobile Gateway must bind to an RFC1918 LAN IPv4 address');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid Mobile Gateway port');
    this.lastError = null;
    const tls = await this.ensureTlsCertificate(host);
    this.certificateFingerprint = tls.fingerprint;

    const httpsServer = createHttpsServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2' }, (_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end('{"error":"not_found"}');
    });
    const wsServer = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    httpsServer.on('upgrade', (request, socket, head) => {
      let pathname = '';
      try { pathname = new URL(request.url ?? '/', 'https://gateway.invalid').pathname; } catch { /* invalid URL */ }
      if (pathname !== '/v1/device') {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wsServer.handleUpgrade(request, socket, head, (ws) => wsServer.emit('connection', ws, request));
    });
    wsServer.on('connection', (ws, request) => this.handleSocket(ws, request));

    const pluginServer = createHttpServer((request, response) => { void this.handlePluginRequest(request, response); });
    try {
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          httpsServer.once('error', reject);
          httpsServer.listen(port, host, () => { httpsServer.off('error', reject); resolve(); });
        }),
        new Promise<void>((resolve, reject) => {
          pluginServer.once('error', reject);
          pluginServer.listen(0, '127.0.0.1', () => { pluginServer.off('error', reject); resolve(); });
        })
      ]);
    } catch (error) {
      httpsServer.close();
      pluginServer.close();
      wsServer.close();
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }

    this.httpsServer = httpsServer;
    this.pluginServer = pluginServer;
    this.wsServer = wsServer;
    this.host = host;
    this.wssPort = port;
    const pluginAddress = pluginServer.address();
    this.pluginPort = typeof pluginAddress === 'object' && pluginAddress ? pluginAddress.port : null;
    this.db.setSetting('mobile:gateway', { enabled: true, host, port });
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    this.emit('gateway_started', { payload: this.getStatus() as unknown as Record<string, unknown> });
    return this.getStatus();
  }

  async stop(disable = false): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const connection of this.connections.values()) {
      for (const pending of connection.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new MobileDisconnectedError(pending.nonIdempotent));
      }
      connection.pending.clear();
      connection.ws.close(1001, 'Gateway stopping');
    }
    this.connections.clear();
    this.clearAllPreviews();
    this.revokeAllTokens('disconnected');
    const servers = [this.wsServer, this.httpsServer, this.pluginServer];
    this.wsServer = null;
    this.httpsServer = null;
    this.pluginServer = null;
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
      if (!server) return resolve();
      try { server.close(() => resolve()); } catch { resolve(); }
    })));
    if (disable) this.db.setSetting('mobile:gateway', { enabled: false, host: this.host, port: this.wssPort });
    this.emit('gateway_stopped', { payload: {} });
  }

  async resetCertificate(): Promise<void> {
    await this.stop();
    this.db.raw.prepare("DELETE FROM settings WHERE key IN ('mobile:tls:certificate','secret:mobile:tls:privateKey')").run();
    this.db.raw.prepare("UPDATE mobile_control_sessions SET status = 'disconnected', ended_at = COALESCE(ended_at, ?) WHERE status = 'active'").run(Date.now());
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'mobile.tls.reset', target: 'all-devices', result: 'repair-required' });
    this.certificateFingerprint = null;
  }

  async createPairing(): Promise<MobilePairingOffer> {
    if (!this.getStatus().running || !this.host || !this.wssPort || !this.certificateFingerprint) throw new Error('Start Mobile Gateway before pairing');
    this.pruneEphemeral();
    const id = randomUUID();
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    const secret = randomBytes(32).toString('base64url');
    const payload = JSON.stringify({
      v: MOBILE_PROTOCOL_VERSION,
      url: `wss://${this.host}:${this.wssPort}/v1/device`,
      pairingId: id,
      secret,
      spki: this.certificateFingerprint,
      expiresAt
    });
    const QRCode = (await import('qrcode')).default;
    const png = await QRCode.toBuffer(payload, {
      type: 'png',
      scale: PAIRING_QR_SCALE,
      margin: PAIRING_QR_MARGIN_MODULES,
      errorCorrectionLevel: 'M'
    });
    this.pairings.set(id, { id, secret, expiresAt, payload, png });
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'mobile.pairing.create', target: id, result: 'expires-5m' });
    this.emit('pairing_created', { payload: { pairingId: id, expiresAt } });
    return {
      id,
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      host: this.host,
      port: this.wssPort,
      certificateFingerprint: this.certificateFingerprint,
      expiresAt,
      qrUri: `aibox-mobile://pairing/${id}`
    };
  }

  getPairingConfigForCopy(pairingId: string): string {
    const pairing = this.pairings.get(pairingId);
    if (!pairing || pairing.expiresAt <= Date.now()) {
      if (pairing) pairing.secret = '';
      this.pairings.delete(pairingId);
      throw new Error('Pairing configuration is invalid or expired');
    }
    this.db.audit({
      id: randomUUID(),
      actor: 'admin',
      action: 'mobile.pairing.config.copy',
      target: pairingId,
      result: 'clipboard'
    });
    return pairing.payload;
  }

  getPairingImage(pairingId: string): { data: Buffer; mimeType: string } | null {
    const pairing = this.pairings.get(pairingId);
    if (!pairing || pairing.expiresAt <= Date.now()) {
      if (pairing) pairing.secret = '';
      this.pairings.delete(pairingId);
      return null;
    }
    return { data: pairing.png, mimeType: 'image/png' };
  }

  private handleSocket(ws: WebSocket, request: IncomingMessage): void {
    const ip = remoteIp(request);
    if (this.isBanned(ip)) {
      ws.close(1008, 'Too many authentication failures');
      return;
    }
    let authenticatedDeviceId: string | null = null;
    let challenge: { deviceId: string; nonce: string; expiresAt: number } | null = null;

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (authenticatedDeviceId) this.handleBinary(authenticatedDeviceId, data);
        return;
      }
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        this.authFail(ip, ws, 'Invalid JSON');
        return;
      }

      if (!authenticatedDeviceId) {
        const type = message.type;
        if (type === 'pair') {
          try {
            authenticatedDeviceId = this.acceptPairing(message, ip);
            challenge = null;
            this.attachConnection(authenticatedDeviceId, ws, ip, message.device);
            ws.send(JSON.stringify({ type: 'paired', protocolVersion: MOBILE_PROTOCOL_VERSION, deviceId: authenticatedDeviceId }));
            this.authFailures.delete(ip);
          } catch (error) {
            this.authFail(ip, ws, error instanceof Error ? error.message : 'Pairing failed');
          }
          return;
        }
        if (type === 'hello') {
          const deviceId = typeof message.deviceId === 'string' ? message.deviceId : '';
          const row = this.db.raw.prepare('SELECT id, certificate_fingerprint FROM mobile_devices WHERE id = ?').get(deviceId) as { id: string; certificate_fingerprint: string } | undefined;
          if (!row || row.certificate_fingerprint !== this.certificateFingerprint) {
            this.authFail(ip, ws, 'Device must be paired again');
            return;
          }
          challenge = { deviceId, nonce: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 30_000 };
          ws.send(JSON.stringify({ type: 'challenge', nonce: challenge.nonce, expiresAt: challenge.expiresAt }));
          return;
        }
        if (type === 'authenticate') {
          try {
            if (!challenge || challenge.expiresAt < Date.now()) throw new Error('Challenge missing or expired');
            if (message.deviceId !== challenge.deviceId) throw new Error('Challenge device mismatch');
            const signature = typeof message.signature === 'string' ? message.signature : '';
            if (!this.verifyDeviceSignature(challenge.deviceId, challenge.nonce, signature)) throw new Error('Invalid device signature');
            authenticatedDeviceId = challenge.deviceId;
            this.attachConnection(authenticatedDeviceId, ws, ip, message.device);
            challenge = null;
            ws.send(JSON.stringify({ type: 'authenticated', protocolVersion: MOBILE_PROTOCOL_VERSION, deviceId: authenticatedDeviceId }));
            this.authFailures.delete(ip);
          } catch (error) {
            this.authFail(ip, ws, error instanceof Error ? error.message : 'Authentication failed');
          }
          return;
        }
        this.authFail(ip, ws, 'Authentication required');
        return;
      }

      this.handleAuthenticatedMessage(authenticatedDeviceId, message);
    });
    ws.on('pong', () => {
      if (!authenticatedDeviceId) return;
      const connection = this.connections.get(authenticatedDeviceId);
      if (connection?.ws === ws) connection.lastSeenAt = Date.now();
    });
    ws.on('close', () => {
      if (authenticatedDeviceId) this.detachConnection(authenticatedDeviceId, ws);
    });
    ws.on('error', () => {
      if (authenticatedDeviceId) this.detachConnection(authenticatedDeviceId, ws);
    });
  }

  private acceptPairing(message: Record<string, unknown>, ip: string): string {
    if (message.protocolVersion !== MOBILE_PROTOCOL_VERSION) throw new Error('Unsupported mobile protocol version');
    const pairingId = typeof message.pairingId === 'string' ? message.pairingId : '';
    const secret = typeof message.secret === 'string' ? message.secret : '';
    const publicKey = typeof message.publicKey === 'string' ? message.publicKey : '';
    const pairing = this.pairings.get(pairingId);
    if (!pairing || pairing.expiresAt < Date.now() || !safeEqual(pairing.secret, secret)) throw new Error('Pairing secret is invalid or expired');
    const keyDer = Buffer.from(publicKey, 'base64');
    if (keyDer.length < 64 || keyDer.length > 512) throw new Error('Invalid device identity key');
    const key = createPublicKey({ key: keyDer, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Device identity must use ECDSA P-256');
    this.pairings.delete(pairingId); // one-time before any persistent side effect
    const identityFingerprint = createHash('sha256').update(keyDer).digest('hex');
    const existing = this.db.raw.prepare('SELECT id FROM mobile_devices WHERE identity_fingerprint = ?').get(identityFingerprint) as { id: string } | undefined;
    const deviceId = existing?.id ?? randomUUID();
    const device = message.device && typeof message.device === 'object' ? message.device as Record<string, unknown> : {};
    const now = Date.now();
    this.db.raw.prepare(
      `INSERT INTO mobile_devices(id, name, model, manufacturer, android_version, api_level, app_version, protocol_version,
        identity_public_key, identity_fingerprint, certificate_fingerprint, permissions_json, capabilities_json, paired_at, last_seen_at, last_ip)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, model=excluded.model, manufacturer=excluded.manufacturer,
        android_version=excluded.android_version, api_level=excluded.api_level, app_version=excluded.app_version,
        protocol_version=excluded.protocol_version, identity_public_key=excluded.identity_public_key,
        certificate_fingerprint=excluded.certificate_fingerprint, permissions_json=excluded.permissions_json,
        capabilities_json=excluded.capabilities_json, last_seen_at=excluded.last_seen_at, last_ip=excluded.last_ip`
    ).run(
      deviceId,
      String(device.name ?? device.model ?? 'Android device').slice(0, 100),
      String(device.model ?? '').slice(0, 100),
      String(device.manufacturer ?? '').slice(0, 100),
      String(device.androidVersion ?? '').slice(0, 40),
      Number(device.apiLevel ?? 0),
      String(device.appVersion ?? '').slice(0, 40),
      MOBILE_PROTOCOL_VERSION,
      publicKey,
      identityFingerprint,
      this.certificateFingerprint ?? '',
      JSON.stringify(device.permissions && typeof device.permissions === 'object' ? device.permissions : {}),
      JSON.stringify(device.capabilities && typeof device.capabilities === 'object' ? device.capabilities : {}),
      now,
      now,
      ip
    );
    this.db.audit({ id: randomUUID(), actor: `device:${deviceId}`, action: 'mobile.device.pair', target: deviceId, result: 'ok', source: ip });
    this.emit('device_paired', { deviceId, payload: { identityFingerprint } });
    return deviceId;
  }

  private verifyDeviceSignature(deviceId: string, nonce: string, signatureBase64: string): boolean {
    const row = this.db.raw.prepare('SELECT identity_public_key FROM mobile_devices WHERE id = ?').get(deviceId) as { identity_public_key: string } | undefined;
    if (!row || !signatureBase64) return false;
    try {
      const key = createPublicKey({ key: Buffer.from(row.identity_public_key, 'base64'), format: 'der', type: 'spki' });
      return verifySignature('sha256', mobileSigningPayload(deviceId, nonce), key, Buffer.from(signatureBase64, 'base64'));
    } catch {
      return false;
    }
  }

  private attachConnection(deviceId: string, ws: WebSocket, ip: string, rawDevice: unknown): void {
    const old = this.connections.get(deviceId);
    if (old && old.ws !== ws) old.ws.close(1008, 'Replaced by a new authenticated connection');
    const connection: DeviceConnection = { deviceId, ws, ip, lastSeenAt: Date.now(), pending: new Map() };
    this.connections.set(deviceId, connection);
    this.updateDeviceState(deviceId, ip, rawDevice);
    const binding = this.db.raw.prepare('SELECT agent_id FROM mobile_agent_configs WHERE device_id = ?').get(deviceId) as { agent_id: string } | undefined;
    this.emit('device_connected', { deviceId, agentId: binding?.agent_id, payload: { ip } });
  }

  private detachConnection(deviceId: string, ws: WebSocket): void {
    const connection = this.connections.get(deviceId);
    if (!connection || connection.ws !== ws) return;
    this.connections.delete(deviceId);
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new MobileDisconnectedError(pending.nonIdempotent));
    }
    connection.pending.clear();
    this.clearPreview(deviceId);
    const now = Date.now();
    this.db.raw.prepare('UPDATE mobile_devices SET last_seen_at = ? WHERE id = ?').run(now, deviceId);
    const sessions = this.db.raw.prepare(
      "SELECT id FROM mobile_control_sessions WHERE device_id = ? AND status = 'active'"
    ).all(deviceId) as unknown as { id: string }[];
    for (const session of sessions) this.endSession(session.id, 'disconnected');
    this.revokeTokensForDevice(deviceId);
    const binding = this.db.raw.prepare('SELECT agent_id FROM mobile_agent_configs WHERE device_id = ?').get(deviceId) as { agent_id: string } | undefined;
    this.emit('device_disconnected', { deviceId, agentId: binding?.agent_id, payload: {} });
  }

  private updateDeviceState(deviceId: string, ip: string, rawDevice: unknown): void {
    const device = rawDevice && typeof rawDevice === 'object' ? rawDevice as Record<string, unknown> : {};
    this.db.raw.prepare(
      `UPDATE mobile_devices SET name = COALESCE(?, name), model = COALESCE(?, model), manufacturer = COALESCE(?, manufacturer),
       android_version = COALESCE(?, android_version), api_level = COALESCE(?, api_level), app_version = COALESCE(?, app_version),
       permissions_json = COALESCE(?, permissions_json), capabilities_json = COALESCE(?, capabilities_json), last_seen_at = ?, last_ip = ? WHERE id = ?`
    ).run(
      typeof device.name === 'string' ? device.name.slice(0, 100) : null,
      typeof device.model === 'string' ? device.model.slice(0, 100) : null,
      typeof device.manufacturer === 'string' ? device.manufacturer.slice(0, 100) : null,
      typeof device.androidVersion === 'string' ? device.androidVersion.slice(0, 40) : null,
      typeof device.apiLevel === 'number' ? device.apiLevel : null,
      typeof device.appVersion === 'string' ? device.appVersion.slice(0, 40) : null,
      device.permissions && typeof device.permissions === 'object' ? JSON.stringify(device.permissions) : null,
      device.capabilities && typeof device.capabilities === 'object' ? JSON.stringify(device.capabilities) : null,
      Date.now(), ip, deviceId
    );
    this.emit('device_updated', { deviceId, payload: {} });
  }

  private handleAuthenticatedMessage(deviceId: string, message: Record<string, unknown>): void {
    const connection = this.connections.get(deviceId);
    if (!connection) return;
    connection.lastSeenAt = Date.now();
    const type = message.type;
    if (type === 'heartbeat') {
      connection.ws.send(JSON.stringify({ type: 'heartbeat_ack', timestamp: Date.now() }));
      return;
    }
    if (type === 'device_state') {
      this.updateDeviceState(deviceId, connection.ip, message.device);
      return;
    }
    const requestId = typeof message.request_id === 'string'
      ? message.request_id
      : typeof message.requestId === 'string' ? message.requestId : '';
    if (!requestId) return;
    const pending = connection.pending.get(requestId);
    if (!pending) return;
    const stream = message.stream && typeof message.stream === 'object' ? message.stream as Record<string, unknown> : null;
    if (stream) {
      const event = stream.event;
      if (event === 'start') {
        const kind = getMobileTool(pending.toolName).artifactKind;
        const maxSize = kind ? artifactLimit(kind) : MAX_AUDIO_BYTES;
        const expectedSize = Number(stream.size ?? 0);
        if (!Number.isFinite(expectedSize) || expectedSize < 0 || expectedSize > maxSize) {
          this.rejectPending(connection, pending, new Error('Media stream declared an invalid size'));
          return;
        }
        pending.stream = {
          filename: basename(String(stream.filename ?? 'mobile-media')),
          mimeType: String(stream.mimeType ?? 'application/octet-stream'),
          expectedSize,
          maxSize,
          chunks: [],
          bytes: 0
        };
        return;
      }
      if (event === 'end') {
        const state = pending.stream;
        if (!state) return this.rejectPending(connection, pending, new Error('Media stream ended without begin'));
        const data = Buffer.concat(state.chunks, state.bytes);
        const claimedBytes = Number(stream.bytes ?? state.bytes);
        const claimedHash = String(stream.sha256 ?? '').toLowerCase();
        const actualHash = createHash('sha256').update(data).digest('hex');
        if (state.bytes !== claimedBytes || (state.expectedSize > 0 && state.bytes !== state.expectedSize) || claimedHash !== actualHash) {
          return this.rejectPending(connection, pending, new Error('Media stream length or SHA-256 verification failed'));
        }
        clearTimeout(pending.timer);
        connection.pending.delete(requestId);
        pending.resolve({ status: Number(message.status ?? 200), result: {}, stream: { filename: state.filename, mimeType: state.mimeType, data, sha256: actualHash } });
        return;
      }
      if (event === 'error') return this.rejectPending(connection, pending, new Error(String(stream.message ?? 'Media stream failed')));
      return;
    }
    clearTimeout(pending.timer);
    connection.pending.delete(requestId);
    const result = message.result && typeof message.result === 'object' ? message.result as Record<string, unknown> : {};
    pending.resolve({ status: Number(message.status ?? 200), result });
  }

  private handleBinary(deviceId: string, raw: RawData): void {
    const connection = this.connections.get(deviceId);
    if (!connection) return;
    const data = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
    if (data.length < 3) return;
    const idLength = data.readUInt16BE(0);
    if (idLength < 1 || idLength > 128 || data.length < 2 + idLength) return;
    const requestId = data.subarray(2, 2 + idLength).toString('utf8');
    const pending = connection.pending.get(requestId);
    if (!pending?.stream) return;
    const payload = data.subarray(2 + idLength);
    if (payload.length > 64 * 1024 || pending.stream.bytes + payload.length > pending.stream.maxSize) {
      this.rejectPending(connection, pending, new Error('Media stream exceeded chunk or total size limit'));
      return;
    }
    pending.stream.chunks.push(Buffer.from(payload));
    pending.stream.bytes += payload.length;
  }

  private rejectPending(connection: DeviceConnection, pending: PendingCommand, error: Error): void {
    clearTimeout(pending.timer);
    connection.pending.delete(pending.requestId);
    pending.reject(error);
  }

  private authFail(ip: string, ws: WebSocket, reason: string): void {
    const now = Date.now();
    const state = this.authFailures.get(ip) ?? { attempts: [], bannedUntil: 0 };
    state.attempts = state.attempts.filter((time) => now - time <= AUTH_WINDOW_MS);
    state.attempts.push(now);
    if (state.attempts.length >= AUTH_FAILURE_LIMIT) state.bannedUntil = now + AUTH_BAN_MS;
    this.authFailures.set(ip, state);
    this.db.audit({ id: randomUUID(), actor: 'device:unknown', action: 'mobile.auth.reject', target: ip, result: reason.slice(0, 120), source: ip });
    ws.close(1008, state.bannedUntil > now ? 'Authentication rate limit exceeded' : 'Authentication failed');
  }

  private isBanned(ip: string): boolean {
    const state = this.authFailures.get(ip);
    if (!state) return false;
    if (state.bannedUntil > Date.now()) return true;
    if (state.bannedUntil) this.authFailures.delete(ip);
    return false;
  }

  private heartbeat(): void {
    const now = Date.now();
    this.pruneEphemeral();
    for (const [deviceId, connection] of this.connections) {
      if (now - connection.lastSeenAt > OFFLINE_AFTER_MS) {
        connection.ws.terminate();
        this.detachConnection(deviceId, connection.ws);
        continue;
      }
      try { connection.ws.ping(); } catch { connection.ws.terminate(); }
    }
  }

  private pruneEphemeral(): void {
    const now = Date.now();
    for (const [id, pairing] of this.pairings) if (pairing.expiresAt <= now) this.pairings.delete(id);
    for (const [token, scope] of this.taskTokens) {
      if (scope.expiresAt <= now) {
        this.taskTokens.delete(token);
        this.endSession(scope.sessionId, 'expired');
      }
    }
    for (const [ip, state] of this.authFailures) {
      state.attempts = state.attempts.filter((time) => now - time <= AUTH_WINDOW_MS);
      if (!state.attempts.length && state.bannedUntil <= now) this.authFailures.delete(ip);
    }
  }

  listDevices(): MobileDevice[] {
    const rows = this.db.raw.prepare(
      `SELECT d.*, c.agent_id AS bound_agent_id,
       (SELECT task_id FROM mobile_control_sessions s WHERE s.device_id = d.id AND s.status = 'active' LIMIT 1) AS active_task_id
       FROM mobile_devices d LEFT JOIN mobile_agent_configs c ON c.device_id = d.id ORDER BY d.paired_at DESC`
    ).all() as Record<string, unknown>[];
    return rows.map((row) => {
      const online = this.connections.has(row.id as string);
      const activeTaskId = (row.active_task_id as string | null) ?? null;
      return {
        id: row.id as string,
        name: row.name as string,
        model: row.model as string,
        manufacturer: row.manufacturer as string,
        androidVersion: row.android_version as string,
        apiLevel: row.api_level as number,
        appVersion: row.app_version as string,
        protocolVersion: row.protocol_version as number,
        identityPublicKey: row.identity_public_key as string,
        identityFingerprint: row.identity_fingerprint as string,
        status: !online ? 'offline' : activeTaskId ? 'busy' : 'online',
        permissions: parseJson(row.permissions_json) as Partial<Record<MobilePermissionName, MobilePermissionState>>,
        capabilities: parseJson(row.capabilities_json) as Record<string, boolean>,
        pairedAt: row.paired_at as number,
        lastSeenAt: (row.last_seen_at as number | null) ?? null,
        lastIp: (row.last_ip as string | null) ?? null,
        boundAgentId: (row.bound_agent_id as string | null) ?? null,
        activeTaskId
      } satisfies MobileDevice;
    });
  }

  getAgentConfig(agentId: string): MobileAgentConfig | null {
    const row = this.db.raw.prepare('SELECT * FROM mobile_agent_configs WHERE agent_id = ?').get(agentId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      agentId: row.agent_id as string,
      deviceId: (row.device_id as string | null) ?? null,
      hermesProfile: row.hermes_profile as string,
      allowedTools: parseStringArray<MobileToolName>(row.allowed_tools_json).filter(isMobileToolName),
      authorizationConfirmedAt: (row.authorization_confirmed_at as number | null) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number
    };
  }

  async bindAgent(agentId: string, deviceId: string, allowedTools: MobileToolName[] = [...MOBILE_TOOL_NAMES], confirmAuthorization = false): Promise<MobileAgentConfig> {
    const agentRow = this.db.raw.prepare('SELECT * FROM agents WHERE id = ? AND archived = 0').get(agentId) as Record<string, unknown> | undefined;
    if (!agentRow || agentRow.agent_kind !== 'android_operator') throw new Error('Only an Android operator can bind a phone');
    if (!this.db.raw.prepare('SELECT id FROM mobile_devices WHERE id = ?').get(deviceId)) throw new Error('Mobile device not found');
    const uniqueTools = [...new Set(allowedTools)];
    if (uniqueTools.some((name) => !isMobileToolName(name))) throw new Error('Tool policy contains an unknown Android tool');
    if (!confirmAuthorization) throw new Error('Full Android tool authorization must be confirmed before binding');
    const agent = this.mapAgentRow(agentRow);
    await this.profiles.ensure(agent);
    const now = Date.now();
    this.db.raw.prepare(
      `UPDATE mobile_agent_configs SET device_id = ?, allowed_tools_json = ?, authorization_confirmed_at = ?, updated_at = ? WHERE agent_id = ?`
    ).run(deviceId, JSON.stringify(uniqueTools), now, now, agentId);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'mobile.agent.bind', target: `${agentId}:${deviceId}`, result: `${uniqueTools.length}-tools` });
    this.emit('binding_changed', { deviceId, agentId, payload: { bound: true } });
    return this.getAgentConfig(agentId)!;
  }

  async ensureAgentProfile(agent: Agent, allowedTools: MobileToolName[] = [...MOBILE_TOOL_NAMES]): Promise<MobileAgentConfig> {
    const uniqueTools = [...new Set(allowedTools)];
    if (uniqueTools.some((name) => !isMobileToolName(name))) throw new Error('Tool policy contains an unknown Android tool');
    await this.profiles.ensure(agent);
    this.db.raw.prepare('UPDATE mobile_agent_configs SET allowed_tools_json = ?, updated_at = ? WHERE agent_id = ?')
      .run(JSON.stringify(uniqueTools), Date.now(), agent.id);
    return this.getAgentConfig(agent.id)!;
  }

  discardAgentProfile(agentId: string): void {
    this.profiles.discard(agentId);
  }

  checkpointAgentProvision(agentId: string): MobileAgentProvisionCheckpoint {
    const config = this.db.raw.prepare('SELECT * FROM mobile_agent_configs WHERE agent_id = ?').get(agentId) as Record<string, unknown> | undefined;
    return { agentId, config: config ? { ...config } : null, profile: this.profiles.checkpoint(agentId) };
  }

  commitAgentProvision(checkpoint: MobileAgentProvisionCheckpoint): void {
    this.profiles.commit(checkpoint.profile);
  }

  rollbackAgentProvision(checkpoint: MobileAgentProvisionCheckpoint): void {
    this.profiles.rollback(checkpoint.profile);
    this.db.transaction(() => {
      this.db.raw.prepare('DELETE FROM mobile_agent_configs WHERE agent_id = ?').run(checkpoint.agentId);
      if (checkpoint.config) {
        this.db.raw.prepare(
          `INSERT INTO mobile_agent_configs(agent_id, device_id, hermes_profile, allowed_tools_json, authorization_confirmed_at, created_at, updated_at)
           VALUES(?,?,?,?,?,?,?)`
        ).run(
          checkpoint.config.agent_id as string,
          checkpoint.config.device_id as string | null,
          checkpoint.config.hermes_profile as string,
          checkpoint.config.allowed_tools_json as string,
          checkpoint.config.authorization_confirmed_at as number | null,
          checkpoint.config.created_at as number,
          checkpoint.config.updated_at as number
        );
      }
    });
  }

  unbindAgent(agentId: string): void {
    const config = this.getAgentConfig(agentId);
    if (!config) return;
    if (config.deviceId) this.emergencyStop(config.deviceId);
    this.db.raw.prepare('UPDATE mobile_agent_configs SET device_id = NULL, authorization_confirmed_at = NULL, updated_at = ? WHERE agent_id = ?').run(Date.now(), agentId);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'mobile.agent.unbind', target: agentId, result: 'ok' });
    this.emit('binding_changed', { deviceId: config.deviceId ?? undefined, agentId, payload: { bound: false } });
  }

  updateToolPolicy(agentId: string, allowedTools: MobileToolName[], confirmAuthorization = false): MobileAgentConfig {
    const config = this.getAgentConfig(agentId);
    if (!config) throw new Error('Mobile agent configuration not found');
    const uniqueTools = [...new Set(allowedTools)];
    if (uniqueTools.some((name) => !isMobileToolName(name))) throw new Error('Tool policy contains an unknown Android tool');
    const confirmedAt = confirmAuthorization ? Date.now() : config.authorizationConfirmedAt;
    this.db.raw.prepare('UPDATE mobile_agent_configs SET allowed_tools_json = ?, authorization_confirmed_at = ?, updated_at = ? WHERE agent_id = ?')
      .run(JSON.stringify(uniqueTools), confirmedAt, Date.now(), agentId);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'mobile.agent.tools', target: agentId, result: `${uniqueTools.length}-tools` });
    this.emit('binding_changed', {
      deviceId: config.deviceId ?? undefined,
      agentId,
      payload: { bound: Boolean(config.deviceId), authorizationConfirmed: Boolean(confirmedAt) }
    });
    return this.getAgentConfig(agentId)!;
  }

  canDispatch(agentId: string): { bound: boolean; ready: boolean; reason: string } {
    const config = this.getAgentConfig(agentId);
    if (!config?.deviceId) return { bound: false, ready: false, reason: '未绑定 Android 设备' };
    if (!config.authorizationConfirmedAt) return { bound: true, ready: false, reason: '等待确认手机工具授权' };
    if (!this.connections.has(config.deviceId)) return { bound: true, ready: false, reason: '手机离线，等待连接' };
    this.expireSessions();
    const active = this.db.raw.prepare("SELECT id FROM mobile_control_sessions WHERE device_id = ? AND status = 'active'").get(config.deviceId);
    if (active) return { bound: true, ready: false, reason: '手机正被其他会话占用' };
    return { bound: true, ready: true, reason: '' };
  }

  async prepareTask(task: Task, agent: Agent): Promise<{
    token: string;
    gatewayUrl: string;
    runtime: PreparedMobileRuntime;
    sessionId: string;
  }> {
    if (agent.kind !== 'android_operator') throw new Error('Task is not owned by an Android operator');
    const config = this.getAgentConfig(agent.id);
    if (!config?.deviceId || !config.authorizationConfirmedAt) throw new Error('Android operator is not fully bound and authorized');
    if (!this.connections.has(config.deviceId)) throw new Error('Android device is offline');
    if (!this.pluginPort) throw new Error('Mobile Gateway plugin API is not running');
    const runtime = await this.profiles.ensure(agent);
    // Profile preparation can invoke a CLI and yield to a device disconnect;
    // recheck before creating the lease so the task can be deferred cleanly.
    if (!this.connections.has(config.deviceId)) throw new Error('Android device is offline');
    const session = this.acquireSession(agent.id, config.deviceId, task.id, config.allowedTools, TASK_TOKEN_TTL_MS);
    const token = randomBytes(32).toString('base64url');
    this.taskTokens.set(token, {
      token,
      sessionId: session.id,
      agentId: agent.id,
      deviceId: config.deviceId,
      taskId: task.id,
      allowedTools: new Set(config.allowedTools),
      expiresAt: session.expiresAt
    });
    return { token, gatewayUrl: `http://127.0.0.1:${this.pluginPort}`, runtime, sessionId: session.id };
  }

  finishTask(taskId: string, status: 'completed' | 'failed' | 'cancelled' | 'expired' | 'disconnected' = 'completed'): void {
    for (const [token, scope] of this.taskTokens) if (scope.taskId === taskId) this.taskTokens.delete(token);
    const row = this.db.raw.prepare("SELECT id, device_id, agent_id FROM mobile_control_sessions WHERE task_id = ? AND status = 'active'").get(taskId) as { id: string; device_id: string; agent_id: string } | undefined;
    if (row) {
      this.endSession(row.id, status);
    }
  }

  private acquireSession(agentId: string, deviceId: string, taskId: string | null, allowedTools: MobileToolName[], ttlMs: number): MobileControlSession {
    this.expireSessions();
    if (!this.connections.has(deviceId)) throw new Error('Android device is offline');
    const now = Date.now();
    const id = randomUUID();
    try {
      this.db.raw.prepare(
        `INSERT INTO mobile_control_sessions(id, agent_id, device_id, task_id, status, allowed_tools_json, started_at, expires_at, ended_at)
         VALUES(?, ?, ?, ?, 'active', ?, ?, ?, NULL)`
      ).run(id, agentId, deviceId, taskId, JSON.stringify(allowedTools), now, now + ttlMs);
    } catch (error) {
      if (/UNIQUE constraint/i.test(error instanceof Error ? error.message : String(error))) throw new Error('Android device or operator already has an active control lease');
      throw error;
    }
    this.emit('session_started', { deviceId, agentId, taskId: taskId ?? undefined, payload: { sessionId: id, expiresAt: now + ttlMs } });
    return { id, agentId, deviceId, taskId, status: 'active', allowedTools, startedAt: now, expiresAt: now + ttlMs, endedAt: null };
  }

  private endSession(sessionId: string, status: 'completed' | 'failed' | 'cancelled' | 'expired' | 'disconnected'): void {
    const row = this.db.raw.prepare("SELECT device_id, agent_id, task_id FROM mobile_control_sessions WHERE id = ? AND status = 'active'").get(sessionId) as { device_id: string; agent_id: string; task_id: string | null } | undefined;
    this.db.raw.prepare("UPDATE mobile_control_sessions SET status = ?, ended_at = COALESCE(ended_at, ?) WHERE id = ? AND status = 'active'").run(status, Date.now(), sessionId);
    for (const [token, scope] of this.taskTokens) if (scope.sessionId === sessionId) this.taskTokens.delete(token);
    if (row) this.emit('session_ended', { deviceId: row.device_id, agentId: row.agent_id, taskId: row.task_id ?? undefined, payload: { status } });
  }

  private expireSessions(): void {
    const now = Date.now();
    const expired = this.db.raw.prepare("SELECT id FROM mobile_control_sessions WHERE status = 'active' AND expires_at <= ?").all(now) as { id: string }[];
    for (const row of expired) this.endSession(row.id, 'expired');
  }

  private recoverStaleSessions(): void {
    const rows = this.db.raw.prepare(
      "SELECT id FROM mobile_control_sessions WHERE status = 'active'"
    ).all() as unknown as { id: string }[];
    for (const row of rows) this.endSession(row.id, 'disconnected');
    if (rows.length > 0) {
      this.db.audit({
        id: randomUUID(), actor: 'system', action: 'mobile.session.recover',
        target: `${rows.length} stale sessions`, result: 'disconnected'
      });
    }
  }

  private revokeTokensForDevice(deviceId: string): void {
    for (const [token, scope] of this.taskTokens) if (scope.deviceId === deviceId) this.taskTokens.delete(token);
  }

  private revokeAllTokens(status: 'disconnected'): void {
    this.taskTokens.clear();
    this.db.raw.prepare("UPDATE mobile_control_sessions SET status = ?, ended_at = COALESCE(ended_at, ?) WHERE status = 'active'").run(status, Date.now());
  }

  async executeManual(deviceId: string, toolName: MobileToolName, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const configRow = this.db.raw.prepare('SELECT * FROM mobile_agent_configs WHERE device_id = ?').get(deviceId) as Record<string, unknown> | undefined;
    if (!configRow) throw new Error('Device is not bound to an Android operator');
    const tools = parseStringArray<MobileToolName>(configRow.allowed_tools_json).filter(isMobileToolName);
    const session = this.acquireSession(configRow.agent_id as string, deviceId, null, tools, 5 * 60_000);
    try {
      return await this.executeTool({ sessionId: session.id, agentId: configRow.agent_id as string, deviceId, taskId: null, allowedTools: new Set(tools) }, toolName, args);
    } finally {
      this.endSession(session.id, 'completed');
    }
  }

  async runScript(scriptId: string): Promise<{ completed: number; results: Record<string, unknown>[] }> {
    const script = this.getScript(scriptId);
    if (!script) throw new Error('Mobile script not found');
    const deviceId = script.deviceId ?? (script.agentId ? this.getAgentConfig(script.agentId)?.deviceId : null);
    if (!deviceId) throw new Error('Script has no bound device');
    const configRow = this.db.raw.prepare('SELECT * FROM mobile_agent_configs WHERE device_id = ?').get(deviceId) as Record<string, unknown> | undefined;
    if (!configRow) throw new Error('Device is not bound to an Android operator');
    const tools = parseStringArray<MobileToolName>(configRow.allowed_tools_json).filter(isMobileToolName);
    const session = this.acquireSession(configRow.agent_id as string, deviceId, null, tools, 5 * 60_000);
    try {
      return await this.runSteps({ sessionId: session.id, agentId: configRow.agent_id as string, deviceId, taskId: null, allowedTools: new Set(tools) }, script.steps);
    } finally {
      this.endSession(session.id, 'completed');
    }
  }

  private async runSteps(context: CommandContext, steps: MobileScriptStep[]): Promise<{ completed: number; results: Record<string, unknown>[] }> {
    const validated = validateMobileScriptSteps(steps);
    const started = Date.now();
    const results: Record<string, unknown>[] = [];
    for (let index = 0; index < validated.length; index++) {
      if (Date.now() - started > 5 * 60_000) throw new Error('Mobile script exceeded 5-minute runtime');
      const step = validated[index];
      try {
        const result = await this.executeTool(context, step.tool, step.args);
        results.push({ step: index, tool: step.tool, result });
      } catch (error) {
        results.push({ step: index, tool: step.tool, error: error instanceof Error ? error.message : String(error) });
        if (step.onFailure !== 'continue') throw error;
      }
      if (step.delayAfterMs) await new Promise((resolve) => setTimeout(resolve, step.delayAfterMs));
    }
    return { completed: validated.length, results };
  }

  private async executeTool(context: CommandContext, toolName: MobileToolName, rawArgs: unknown): Promise<Record<string, unknown>> {
    if (!context.allowedTools.has(toolName)) throw new Error(`Tool not allowed for this Android operator: ${toolName}`);
    const args = validateMobileToolArgs(toolName, rawArgs);
    if (toolName === 'android_setup') return this.setupStatus(context.agentId, context.deviceId);
    if (toolName === 'android_macro') return this.runSteps(context, validateMobileScriptSteps(args.steps)) as unknown as Record<string, unknown>;
    const entry = getMobileTool(toolName);
    const device = this.listDevices().find((item) => item.id === context.deviceId);
    if (!device) throw new Error('Android device not found');
    assertMobilePermissions(entry, device.permissions);
    if (!this.connections.has(context.deviceId)) throw new Error('Android device is offline');
    const commandId = randomUUID();
    const startedAt = Date.now();
    const requestSummary = redactMobileValue(entry, args);
    this.db.transaction(() => {
      this.db.raw.prepare(
        `INSERT INTO mobile_commands(id, session_id, agent_id, device_id, task_id, tool_name, status, request_summary_json, result_summary_json, error, started_at, ended_at)
         VALUES(?, ?, ?, ?, ?, ?, 'running', ?, '{}', NULL, ?, NULL)`
      ).run(commandId, context.sessionId, context.agentId, context.deviceId, context.taskId, toolName, JSON.stringify(requestSummary), startedAt);
      this.recordTaskToolEvent(context.taskId, 'tool_call', {
        source: 'android', commandId, name: toolName, args: requestSummary
      }, startedAt);
    });
    this.emit('command_started', { deviceId: context.deviceId, agentId: context.agentId ?? undefined, taskId: context.taskId ?? undefined, payload: { commandId, toolName } });
    try {
      const bridge = toMobileBridgeCommand(toolName, args);
      const response = await this.sendBridgeCommand(context.deviceId, toolName, bridge);
      if (response.status < 200 || response.status >= 300) throw new Error(`Android Bridge returned HTTP ${response.status}`);
      let result = response.result;
      const artifact = await this.extractArtifact(context, commandId, toolName, response);
      if (artifact) result = { ...result, artifact };
      const failed = result.success === false || typeof result.error === 'string';
      const status: MobileCommandStatus = failed ? 'failed' : 'completed';
      const resultSummary = redactMobileValue(entry, result, true);
      const endedAt = Date.now();
      this.db.transaction(() => {
        this.db.raw.prepare('UPDATE mobile_commands SET status = ?, result_summary_json = ?, error = ?, ended_at = ? WHERE id = ?')
          .run(status, JSON.stringify(resultSummary), failed ? String(result.error ?? 'Android command failed').slice(0, 500) : null, endedAt, commandId);
        this.recordTaskToolEvent(context.taskId, 'tool_result', {
          source: 'android', commandId, name: toolName, status, result: resultSummary
        }, endedAt);
      });
      this.emit('command_finished', { deviceId: context.deviceId, agentId: context.agentId ?? undefined, taskId: context.taskId ?? undefined, payload: { commandId, toolName, status } });
      return result;
    } catch (error) {
      const status: MobileCommandStatus = error instanceof MobileDisconnectedError && error.uncertain ? 'unknown_after_disconnect' : /permission_denied/.test(error instanceof Error ? error.message : '') ? 'permission_denied' : 'failed';
      const message = error instanceof Error ? error.message : String(error);
      const endedAt = Date.now();
      this.db.transaction(() => {
        this.db.raw.prepare('UPDATE mobile_commands SET status = ?, error = ?, ended_at = ? WHERE id = ?').run(status, message.slice(0, 500), endedAt, commandId);
        this.recordTaskToolEvent(context.taskId, 'tool_result', {
          source: 'android', commandId, name: toolName, status
        }, endedAt);
      });
      this.emit('command_finished', { deviceId: context.deviceId, agentId: context.agentId ?? undefined, taskId: context.taskId ?? undefined, payload: { commandId, toolName, status } });
      throw error;
    }
  }

  private recordTaskToolEvent(
    taskId: string | null,
    eventType: 'tool_call' | 'tool_result',
    payload: Record<string, unknown>,
    createdAt: number
  ): void {
    if (!taskId) return;
    this.db.raw.prepare('INSERT INTO task_events(id, task_id, event_type, payload, created_at) VALUES(?, ?, ?, ?, ?)')
      .run(randomUUID(), taskId, eventType, JSON.stringify(payload), createdAt);
  }

  private sendBridgeCommand(deviceId: string, toolName: MobileToolName, command: ReturnType<typeof toMobileBridgeCommand>): Promise<BridgeResponse> {
    const connection = this.connections.get(deviceId);
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Android device is offline'));
    const requestId = randomUUID();
    return new Promise<BridgeResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(requestId);
        reject(new Error(`${toolName} timed out after ${COMMAND_TIMEOUT_MS / 1000}s`));
      }, COMMAND_TIMEOUT_MS);
      const pending: PendingCommand = { requestId, toolName, nonIdempotent: getMobileTool(toolName).nonIdempotent, timer, resolve, reject };
      connection.pending.set(requestId, pending);
      const accepted = connection.ws.send(JSON.stringify({
        type: 'command',
        request_id: requestId,
        method: command.method,
        path: command.path,
        params: command.params,
        body: command.body
      }), (error) => {
        if (error) this.rejectPending(connection, pending, error);
      });
      if (accepted === undefined && connection.ws.readyState !== WebSocket.OPEN) this.rejectPending(connection, pending, new Error('Android device disconnected'));
    });
  }

  private async extractArtifact(context: CommandContext, commandId: string, toolName: MobileToolName, response: BridgeResponse): Promise<MobileArtifact | null> {
    const kind = getMobileTool(toolName).artifactKind;
    if (!kind) return null;
    if (response.stream) return this.storeArtifact(context, commandId, kind, response.stream.mimeType, response.stream.filename, response.stream.data, response.stream.sha256);
    const root = response.result.data && typeof response.result.data === 'object' ? response.result.data as Record<string, unknown> : response.result;
    const encoded = kind === 'screenshot' ? root.image : kind === 'screen_recording' ? root.video : null;
    if (typeof encoded !== 'string' || !encoded) return null;
    let data: Buffer;
    try { data = Buffer.from(encoded, 'base64'); } catch { throw new Error('Android media response is not valid base64'); }
    const mimeType = kind === 'screenshot' ? String(root.mimeType ?? 'image/png') : kind === 'screen_recording' ? 'video/mp4' : 'audio/wav';
    const hash = createHash('sha256').update(data).digest('hex');
    return this.storeArtifact(context, commandId, kind, mimeType, `${kind}${artifactExtension(kind, mimeType)}`, data, hash);
  }

  private storeArtifact(context: CommandContext, commandId: string | null, kind: MobileArtifactKind, mimeType: string, filename: string, data: Buffer, claimedHash: string): MobileArtifact {
    const limit = artifactLimit(kind);
    if (!data.length || data.length > limit) throw new Error(`${kind} artifact exceeds size limit`);
    const sha256 = createHash('sha256').update(data).digest('hex');
    if (claimedHash && claimedHash.toLowerCase() !== sha256) throw new Error(`${kind} artifact SHA-256 mismatch`);
    const id = randomUUID();
    const ext = artifactExtension(kind, mimeType);
    const storageName = `${id}${ext}`;
    const dir = join(app.getPath('userData'), 'aibox-data', 'mobile-artifacts');
    mkdirSync(dir, { recursive: true });
    const target = join(dir, storageName);
    const temp = `${target}.tmp`;
    writeFileSync(temp, data, { flag: 'wx' });
    renameSync(temp, target);
    const safeFilename = `${basename(filename, ext).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || kind}${ext}`;
    const createdAt = Date.now();
    this.db.raw.prepare(
      `INSERT INTO mobile_artifacts(id, device_id, agent_id, task_id, command_id, kind, mime_type, filename, storage_name, size, sha256, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(id, context.deviceId, context.agentId, context.taskId, commandId, kind, mimeType, safeFilename, storageName, data.length, sha256, createdAt);
    const artifact: MobileArtifact = {
      id,
      deviceId: context.deviceId,
      agentId: context.agentId,
      taskId: context.taskId,
      commandId,
      kind,
      mimeType,
      filename: safeFilename,
      size: data.length,
      sha256,
      uri: `aibox-mobile://artifact/${id}`,
      createdAt
    };
    this.emit('artifact_created', { deviceId: context.deviceId, agentId: context.agentId ?? undefined, taskId: context.taskId ?? undefined, payload: { artifactId: id, kind } });
    return artifact;
  }

  listArtifacts(deviceId?: string): MobileArtifact[] {
    const rows = (deviceId
      ? this.db.raw.prepare('SELECT * FROM mobile_artifacts WHERE device_id = ? ORDER BY created_at DESC LIMIT 100').all(deviceId)
      : this.db.raw.prepare('SELECT * FROM mobile_artifacts ORDER BY created_at DESC LIMIT 100').all()) as Record<string, unknown>[];
    return rows.map((row) => this.mapArtifact(row));
  }

  private mapArtifact(row: Record<string, unknown>): MobileArtifact {
    return {
      id: row.id as string,
      deviceId: row.device_id as string,
      agentId: (row.agent_id as string | null) ?? null,
      taskId: (row.task_id as string | null) ?? null,
      commandId: (row.command_id as string | null) ?? null,
      kind: row.kind as MobileArtifactKind,
      mimeType: row.mime_type as string,
      filename: row.filename as string,
      size: row.size as number,
      sha256: row.sha256 as string,
      uri: `aibox-mobile://artifact/${row.id as string}`,
      createdAt: row.created_at as number
    };
  }

  getArtifactFile(id: string): { data: Buffer; mimeType: string; filename: string } | null {
    const row = this.db.raw.prepare('SELECT mime_type, filename, storage_name FROM mobile_artifacts WHERE id = ?').get(id) as { mime_type: string; filename: string; storage_name: string } | undefined;
    if (!row || basename(row.storage_name) !== row.storage_name) return null;
    const file = join(app.getPath('userData'), 'aibox-data', 'mobile-artifacts', row.storage_name);
    if (!existsSync(file)) return null;
    return { data: readFileSync(file), mimeType: row.mime_type, filename: row.filename };
  }

  listCommands(deviceId?: string): MobileCommandLog[] {
    const rows = (deviceId
      ? this.db.raw.prepare('SELECT * FROM mobile_commands WHERE device_id = ? ORDER BY started_at DESC LIMIT 200').all(deviceId)
      : this.db.raw.prepare('SELECT * FROM mobile_commands ORDER BY started_at DESC LIMIT 200').all()) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      sessionId: (row.session_id as string | null) ?? null,
      agentId: (row.agent_id as string | null) ?? null,
      deviceId: row.device_id as string,
      taskId: (row.task_id as string | null) ?? null,
      toolName: row.tool_name as MobileToolName,
      status: row.status as MobileCommandStatus,
      requestSummary: parseJson(row.request_summary_json),
      resultSummary: parseJson(row.result_summary_json),
      error: (row.error as string | null) ?? null,
      startedAt: row.started_at as number,
      endedAt: (row.ended_at as number | null) ?? null
    }));
  }

  listScripts(): MobileScriptDefinition[] {
    return (this.db.raw.prepare('SELECT * FROM mobile_scripts ORDER BY updated_at DESC').all() as Record<string, unknown>[]).map((row) => this.mapScript(row));
  }

  getScript(id: string): MobileScriptDefinition | null {
    const row = this.db.raw.prepare('SELECT * FROM mobile_scripts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapScript(row) : null;
  }

  saveScript(input: Omit<MobileScriptDefinition, 'id' | 'createdAt' | 'updatedAt'>, id?: string): MobileScriptDefinition {
    const valid = validateMobileScript(input);
    const now = Date.now();
    const scriptId = id ?? randomUUID();
    this.db.raw.prepare(
      `INSERT INTO mobile_scripts(id, name, description, agent_id, device_id, steps_json, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, agent_id=excluded.agent_id,
        device_id=excluded.device_id, steps_json=excluded.steps_json, updated_at=excluded.updated_at`
    ).run(scriptId, valid.name, valid.description, valid.agentId, valid.deviceId, JSON.stringify(valid.steps), now, now);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: id ? 'mobile.script.update' : 'mobile.script.create', target: scriptId, result: `${valid.steps.length}-steps` });
    return this.getScript(scriptId)!;
  }

  deleteScript(id: string): void {
    this.db.raw.prepare('DELETE FROM mobile_scripts WHERE id = ?').run(id);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'mobile.script.delete', target: id, result: 'ok' });
  }

  private mapScript(row: Record<string, unknown>): MobileScriptDefinition {
    let rawSteps: unknown = [];
    try { rawSteps = JSON.parse((row.steps_json as string) || '[]'); } catch { /* validation below reports invalid storage */ }
    return {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string,
      agentId: (row.agent_id as string | null) ?? null,
      deviceId: (row.device_id as string | null) ?? null,
      steps: validateMobileScriptSteps(rawSteps),
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number
    };
  }

  async refreshPreview(deviceId: string): Promise<string> {
    this.assertConsoleObservationAllowed(deviceId, 'android_screenshot');
    const cached = this.previews.get(deviceId);
    if (cached && Date.now() - cached.updatedAt < PREVIEW_CACHE_MS) {
      return `aibox-mobile://preview/${deviceId}?v=${cached.updatedAt}`;
    }
    const active = this.previewRefreshes.get(deviceId);
    if (active) return active;
    const refresh = this.capturePreview(deviceId);
    this.previewRefreshes.set(deviceId, refresh);
    try {
      return await refresh;
    } finally {
      if (this.previewRefreshes.get(deviceId) === refresh) this.previewRefreshes.delete(deviceId);
    }
  }

  private async capturePreview(deviceId: string): Promise<string> {
    const response = await this.sendBridgeCommand(deviceId, 'android_screenshot', { method: 'GET', path: '/screenshot', params: {}, body: {} });
    const root = response.result.data && typeof response.result.data === 'object' ? response.result.data as Record<string, unknown> : response.result;
    if (typeof root.image !== 'string' || !root.image) {
      const message = typeof response.result.message === 'string' ? response.result.message : 'Android screenshot is restricted or unavailable';
      const reason = typeof root.reason === 'string' ? ` (${root.reason})` : '';
      throw new Error(`${message}${reason}`);
    }
    const data = Buffer.from(root.image, 'base64');
    if (!data.length || data.length > MAX_SCREENSHOT_BYTES) throw new Error('Preview frame is invalid');
    const mimeType = String(root.mimeType ?? 'image/png');
    const sha256 = createHash('sha256').update(data).digest('hex');
    const previous = this.previews.get(deviceId);
    if (previous && previous.sha256 === sha256 && previous.mimeType === mimeType) {
      // Keep the existing decoded image URL stable while the screen is unchanged.
      data.fill(0);
      return `aibox-mobile://preview/${deviceId}?v=${previous.updatedAt}`;
    }
    const updatedAt = Date.now();
    this.previews.set(deviceId, { data, mimeType, sha256, updatedAt });
    if (previous) previous.data.fill(0);
    this.emit('preview_updated', { deviceId, payload: {} });
    return `aibox-mobile://preview/${deviceId}?v=${updatedAt}`;
  }

  getPreview(deviceId: string): { data: Buffer; mimeType: string } | null {
    const preview = this.previews.get(deviceId);
    return preview ? { data: preview.data, mimeType: preview.mimeType } : null;
  }

  async readUiTree(deviceId: string): Promise<Record<string, unknown>> {
    this.assertConsoleObservationAllowed(deviceId, 'android_read_screen');
    const response = await this.sendBridgeCommand(deviceId, 'android_read_screen', { method: 'GET', path: '/screen', params: { bounds: true, system_ui: false }, body: {} });
    if (response.status !== 200) throw new Error(`Android Bridge returned ${response.status}`);
    const treeHash = typeof response.result.hash === 'string' && response.result.hash
      ? response.result.hash
      : hashMobileUiTreeResult(response.result);
    return limitMobileUiTree({ ...response.result, hash: treeHash });
  }

  private clearPreview(deviceId: string): void {
    const preview = this.previews.get(deviceId);
    if (preview) preview.data.fill(0);
    this.previews.delete(deviceId);
  }

  private clearAllPreviews(): void {
    for (const preview of this.previews.values()) preview.data.fill(0);
    this.previews.clear();
    this.previewRefreshes.clear();
  }

  private assertConsoleObservationAllowed(deviceId: string, toolName: 'android_screenshot' | 'android_read_screen'): void {
    const config = this.db.raw.prepare('SELECT allowed_tools_json FROM mobile_agent_configs WHERE device_id = ?').get(deviceId) as { allowed_tools_json: string } | undefined;
    if (!config) throw new Error('Device is not bound to an Android operator');
    const allowed = parseStringArray<MobileToolName>(config.allowed_tools_json);
    if (!allowed.includes(toolName)) throw new Error(`Tool not allowed for this Android operator: ${toolName}`);
    const device = this.listDevices().find((item) => item.id === deviceId);
    if (!device) throw new Error('Android device not found');
    assertMobilePermissions(getMobileTool(toolName), device.permissions);
    if (!this.connections.has(deviceId)) throw new Error('Android device is offline');
  }

  emergencyStop(deviceId: string): void {
    const row = this.db.raw.prepare("SELECT id, task_id, agent_id FROM mobile_control_sessions WHERE device_id = ? AND status = 'active'").get(deviceId) as { id: string; task_id: string | null; agent_id: string } | undefined;
    if (row) this.endSession(row.id, 'cancelled');
    this.revokeTokensForDevice(deviceId);
    const connection = this.connections.get(deviceId);
    if (connection?.ws.readyState === WebSocket.OPEN) connection.ws.send(JSON.stringify({ type: 'emergency_stop' }));
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'mobile.emergencyStop', target: deviceId, result: 'ok' });
    this.emit('emergency_stop', { deviceId, agentId: row?.agent_id, taskId: row?.task_id ?? undefined, payload: {} });
  }

  private setupStatus(agentId: string | null, deviceId: string): Record<string, unknown> {
    const config = agentId ? this.getAgentConfig(agentId) : null;
    return {
      managedBy: 'OPC-Nexus',
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      paired: this.listDevices().some((item) => item.id === deviceId),
      bound: config?.deviceId === deviceId,
      connected: this.connections.has(deviceId),
      online: this.connections.has(deviceId),
      deviceId,
      allowedToolCount: config?.allowedTools.length ?? 0
    };
  }

  private mapAgentRow(row: Record<string, unknown>): Agent {
    const caps = parseJson(row.capabilities_json);
    return {
      id: row.id as string,
      kind: ((row.agent_kind as string) || 'general') as Agent['kind'],
      name: row.name as string,
      role: row.role as string,
      systemPrompt: row.system_prompt as string,
      soulMd: (row.soul_md as string) ?? '',
      agentsMd: (row.agents_md as string) ?? '',
      userMd: (row.user_md as string) ?? '',
      lifecycle: row.lifecycle as Agent['lifecycle'],
      engineId: row.engine_id as string,
      workspace: row.workspace as string,
      permissionMode: row.permission_mode as Agent['permissionMode'],
      capabilities: {
        network: caps.network === true,
        shell: caps.shell === true,
        install: caps.install === true,
        browser: caps.browser === true,
        computer: caps.computer === true,
        mobile: caps.mobile === true
      },
      tags: parseStringArray<string>(row.tags_json),
      modelOverride: (row.model_override as string | null) ?? undefined,
      concurrencyLimit: row.concurrency_limit as number,
      archived: row.archived === 1,
      avatarColor: row.avatar_color as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number
    };
  }

  private authenticatePlugin(request: IncomingMessage): TaskToken | null {
    const header = request.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return null;
    const token = header.slice(7).trim();
    const scope = this.taskTokens.get(token);
    if (!scope || scope.expiresAt <= Date.now()) {
      if (scope) {
        this.taskTokens.delete(token);
        this.endSession(scope.sessionId, 'expired');
      }
      return null;
    }
    const active = this.db.raw.prepare("SELECT id FROM mobile_control_sessions WHERE id = ? AND status = 'active' AND expires_at > ?").get(scope.sessionId, Date.now());
    return active ? scope : null;
  }

  private async handlePluginRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-type', 'application/json; charset=utf-8');
    if (!isLoopback(request.socket.remoteAddress ?? '')) return this.reply(response, 403, { error: 'loopback_only' });
    const scope = this.authenticatePlugin(request);
    if (!scope) return this.reply(response, 401, { error: 'valid OPC-Nexus task token required' });
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/v1/status') return this.reply(response, 200, this.setupStatus(scope.agentId, scope.deviceId));
    const artifactMatch = /^\/v1\/artifacts\/([a-f0-9-]+)$/.exec(url.pathname);
    if (request.method === 'GET' && artifactMatch) {
      const artifact = this.db.raw.prepare('SELECT task_id FROM mobile_artifacts WHERE id = ?').get(artifactMatch[1]) as { task_id: string | null } | undefined;
      if (!artifact || artifact.task_id !== scope.taskId) return this.reply(response, 404, { error: 'artifact_not_found' });
      const file = this.getArtifactFile(artifactMatch[1]);
      if (!file) return this.reply(response, 404, { error: 'artifact_not_found' });
      response.statusCode = 200;
      response.setHeader('content-type', file.mimeType);
      response.setHeader('content-length', file.data.length);
      response.setHeader('content-disposition', `attachment; filename="${file.filename.replace(/["\\]/g, '_')}"`);
      response.end(file.data);
      return;
    }
    const toolMatch = /^\/v1\/tools\/(android_[a-z_]+)$/.exec(url.pathname);
    if (request.method === 'POST' && toolMatch && isMobileToolName(toolMatch[1])) {
      try {
        const body = await this.readPluginBody(request);
        const context: CommandContext = {
          sessionId: scope.sessionId,
          agentId: scope.agentId,
          deviceId: scope.deviceId,
          taskId: scope.taskId,
          allowedTools: scope.allowedTools
        };
        const result = await this.executeTool(context, toolMatch[1], body.args ?? {});
        const artifact = result.artifact as MobileArtifact | undefined;
        return this.reply(response, 200, artifact ? { ...result, mediaUrl: `/v1/artifacts/${artifact.id}` } : result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = /not allowed|permission_denied/.test(message) ? 403 : /offline|disconnected|lease/.test(message) ? 409 : /arguments|invalid|forbidden|must/.test(message) ? 400 : 502;
        return this.reply(response, status, { error: message });
      }
    }
    return this.reply(response, 404, { error: 'not_found' });
  }

  private readPluginBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      request.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_PLUGIN_BODY) {
          reject(new Error('Request body too large'));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON body must be an object');
          resolve(parsed as Record<string, unknown>);
        } catch (error) { reject(error); }
      });
      request.on('error', reject);
    });
  }

  private reply(response: ServerResponse, status: number, body: Record<string, unknown>): void {
    if (response.writableEnded) return;
    response.statusCode = status;
    response.end(JSON.stringify(body));
  }

  dispose(): void {
    void this.stop();
    this.clearAllPreviews();
    for (const pairing of this.pairings.values()) pairing.secret = '';
    this.pairings.clear();
  }
}
