// @ts-nocheck
import { EventEmitter } from 'node:events';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

const { MobileGatewayService, hashMobileUiTreeResult, isRfc1918Ipv4, limitMobileUiTree, mobileSigningPayload } = await import('../src/main/services/mobileGatewayService.js');
const { MOBILE_PROTOCOL_VERSION } = await import('../src/main/services/mobileCatalog.js');

function makeDb() {
  const devices = new Map();
  const sessions = new Map();
  const audits = [];
  const commands = new Map();
  const taskEvents = [];
  return {
    devices,
    sessions,
    audits,
    commands,
    taskEvents,
    raw: {
      prepare(sql: string) {
        return {
          get(...args: unknown[]) {
            if (/SELECT id FROM mobile_devices WHERE identity_fingerprint/.test(sql)) {
              const row = [...devices.values()].find((item) => item.identity_fingerprint === args[0]);
              return row ? { id: row.id } : undefined;
            }
            if (/SELECT identity_public_key FROM mobile_devices WHERE id/.test(sql)) {
              const row = devices.get(args[0]);
              return row ? { identity_public_key: row.identity_public_key } : undefined;
            }
            if (/SELECT id FROM mobile_control_sessions WHERE id/.test(sql)) {
              const row = sessions.get(args[0]);
              return row?.status === 'active' && row.expires_at > args[1] ? { id: row.id } : undefined;
            }
            if (/SELECT device_id, agent_id, task_id FROM mobile_control_sessions/.test(sql)) {
              const row = sessions.get(args[0]);
              return row?.status === 'active' ? { device_id: row.device_id, agent_id: row.agent_id, task_id: row.task_id } : undefined;
            }
            if (/SELECT id, device_id, agent_id FROM mobile_control_sessions WHERE task_id/.test(sql)) {
              const row = [...sessions.values()].find((item) => item.task_id === args[0] && item.status === 'active');
              return row ? { id: row.id, device_id: row.device_id, agent_id: row.agent_id } : undefined;
            }
            return undefined;
          },
          all() { return []; },
          run(...args: unknown[]) {
            if (/INSERT INTO task_events/.test(sql)) {
              const [id, taskId, eventType, payload, createdAt] = args;
              taskEvents.push({ id, taskId, eventType, payload, createdAt });
            }
            if (/INSERT INTO mobile_commands/.test(sql)) {
              const [id, sessionId, agentId, deviceId, taskId, toolName, requestSummary, startedAt] = args;
              commands.set(id, { id, sessionId, agentId, deviceId, taskId, toolName, requestSummary, status: 'running', startedAt });
            }
            if (/UPDATE mobile_commands SET status = \?, result_summary_json/.test(sql)) {
              const [status, resultSummary, error, endedAt, id] = args;
              Object.assign(commands.get(id), { status, resultSummary, error, endedAt });
            }
            if (/UPDATE mobile_commands SET status = \?, error/.test(sql)) {
              const [status, error, endedAt, id] = args;
              Object.assign(commands.get(id), { status, error, endedAt });
            }
            if (/INSERT INTO mobile_devices/.test(sql)) {
              const [id, name, model, manufacturer, androidVersion, apiLevel, appVersion, protocolVersion,
                identityPublicKey, identityFingerprint, certificateFingerprint, permissionsJson, capabilitiesJson, pairedAt, lastSeenAt, lastIp] = args;
              devices.set(id, {
                id, name, model, manufacturer, android_version: androidVersion, api_level: apiLevel, app_version: appVersion,
                protocol_version: protocolVersion, identity_public_key: identityPublicKey, identity_fingerprint: identityFingerprint,
                certificate_fingerprint: certificateFingerprint, permissions_json: permissionsJson, capabilities_json: capabilitiesJson,
                paired_at: pairedAt, last_seen_at: lastSeenAt, last_ip: lastIp
              });
            }
            if (/UPDATE mobile_control_sessions SET status = \?/.test(sql)) {
              const [status, endedAt, id] = args;
              const row = sessions.get(id);
              if (row?.status === 'active') Object.assign(row, { status, ended_at: endedAt });
            }
            return { changes: 1 };
          }
        };
      }
    },
    transaction(fn: () => void) { fn(); },
    audit(entry: unknown) { audits.push(entry); },
    getSetting(_key: string, fallback: unknown) { return fallback; },
    setSetting() {}
  };
}

class FakeSocket extends EventEmitter {
  close = vi.fn();
  send = vi.fn();
  readyState = 1;
}

function pairingMessage(pairingId: string, secret: string, publicKey: string) {
  return {
    type: 'pair',
    protocolVersion: MOBILE_PROTOCOL_VERSION,
    pairingId,
    secret,
    publicKey,
    device: { name: 'API 34', apiLevel: 34, permissions: {}, capabilities: {} }
  };
}

describe('Mobile Gateway security contracts', () => {
  it('hashes UI trees deterministically without serializing a full duplicate string', () => {
    const first = { count: 2, tree: [{ nodeId: 'root', children: [{ text: '中文按钮' }] }] };
    const reordered = { tree: [{ children: [{ text: '中文按钮' }], nodeId: 'root' }], count: 2 };
    expect(hashMobileUiTreeResult(first)).toBe(hashMobileUiTreeResult(reordered));
    expect(hashMobileUiTreeResult(first)).not.toBe(hashMobileUiTreeResult({ ...first, count: 3 }));
  });

  it('bounds the console UI tree without changing the full-tree count or hash', () => {
    const result = limitMobileUiTree({
      count: 5,
      hash: 'stable-hash',
      tree: [{ nodeId: 'root', children: [
        { nodeId: 'a', children: [{ nodeId: 'a.1' }, { nodeId: 'a.2' }] },
        { nodeId: 'b' }
      ] }]
    }, 3);

    expect(result).toMatchObject({ count: 5, hash: 'stable-hash', renderedCount: 3, truncated: true });
    expect(JSON.stringify(result.tree)).toContain('a.1');
    expect(JSON.stringify(result.tree)).not.toContain('a.2');
    expect(JSON.stringify(result.tree)).not.toContain('"b"');
  });

  it('renders pairing QR codes with integer modules and a scan-safe quiet zone', async () => {
    const gateway = new MobileGatewayService(makeDb() as never) as any;
    gateway.host = '192.168.1.20';
    gateway.wssPort = 18765;
    gateway.certificateFingerprint = `sha256/${'a'.repeat(44)}`;
    gateway.getStatus = () => ({ running: true });

    const offer = await gateway.createPairing();
    const image = gateway.getPairingImage(offer.id);
    const metadata = await sharp(image.data).metadata();
    const payload = gateway.pairings.get(offer.id).payload;
    const modules = (await import('qrcode')).default.create(payload, { errorCorrectionLevel: 'M' }).modules.size;

    expect(metadata.width).toBe((modules + 8) * 8);
    expect(metadata.height).toBe(metadata.width);
  });

  it('returns the exact live pairing payload for Main-only clipboard copy and audits it', async () => {
    const db = makeDb();
    const gateway = new MobileGatewayService(db as never) as any;
    gateway.host = '192.168.1.20';
    gateway.wssPort = 18765;
    gateway.certificateFingerprint = `sha256/${'a'.repeat(44)}`;
    gateway.getStatus = () => ({ running: true });

    const offer = await gateway.createPairing();
    const expected = gateway.pairings.get(offer.id).payload;

    expect(gateway.getPairingConfigForCopy(offer.id)).toBe(expected);
    expect(JSON.parse(expected)).toMatchObject({
      v: 1,
      url: 'wss://192.168.1.20:18765/v1/device',
      pairingId: offer.id,
      spki: gateway.certificateFingerprint,
      expiresAt: offer.expiresAt,
    });
    expect(db.audits).toContainEqual(expect.objectContaining({
      action: 'mobile.pairing.config.copy',
      target: offer.id,
      result: 'clipboard',
    }));
  });

  it('rejects and clears an expired pairing configuration before clipboard copy', () => {
    const gateway = new MobileGatewayService(makeDb() as never) as any;
    const expired = {
      id: 'expired-copy',
      secret: 'one-time-secret',
      expiresAt: Date.now() - 1,
      payload: '{"secret":"one-time-secret"}',
      png: Buffer.alloc(0),
    };
    gateway.pairings.set(expired.id, expired);

    expect(() => gateway.getPairingConfigForCopy(expired.id)).toThrow(/invalid or expired/);
    expect(expired.secret).toBe('');
    expect(gateway.pairings.has(expired.id)).toBe(false);
  });

  it('only accepts RFC1918 IPv4 addresses', () => {
    expect(isRfc1918Ipv4('10.1.2.3')).toBe(true);
    expect(isRfc1918Ipv4('172.31.255.254')).toBe(true);
    expect(isRfc1918Ipv4('192.168.20.8')).toBe(true);
    expect(isRfc1918Ipv4('172.32.0.1')).toBe(false);
    expect(isRfc1918Ipv4('127.0.0.1')).toBe(false);
    expect(isRfc1918Ipv4('2001:db8::1')).toBe(false);
  });

  it('consumes a pairing secret once and rejects replay', () => {
    const db = makeDb();
    const gateway = new MobileGatewayService(db as never) as any;
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const publicDer = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    gateway.certificateFingerprint = 'sha256/test';
    gateway.pairings.set('pair-1', { id: 'pair-1', secret: 'one-time-secret', expiresAt: Date.now() + 60_000, payload: '', png: Buffer.alloc(0) });
    const message = pairingMessage('pair-1', 'one-time-secret', publicDer);

    expect(gateway.acceptPairing(message, '192.168.1.5')).toMatch(/[0-9a-f-]{36}/);
    expect(() => gateway.acceptPairing(message, '192.168.1.5')).toThrow(/invalid or expired/);
    expect(db.devices.size).toBe(1);
  });

  it('rejects expired pairing offers without consuming another offer', () => {
    const db = makeDb();
    const gateway = new MobileGatewayService(db as never) as any;
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    gateway.pairings.set('expired', { id: 'expired', secret: 'secret', expiresAt: Date.now() - 1, payload: '', png: Buffer.alloc(0) });
    expect(() => gateway.acceptPairing(pairingMessage('expired', 'secret', publicKey.export({ format: 'der', type: 'spki' }).toString('base64')), '192.168.1.5'))
      .toThrow(/invalid or expired/);
  });

  it('verifies ECDSA P-256 challenge signatures over the versioned payload', () => {
    const db = makeDb();
    const gateway = new MobileGatewayService(db as never) as any;
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const deviceId = 'device-1';
    const nonce = 'nonce-123';
    db.devices.set(deviceId, { id: deviceId, identity_public_key: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') });
    const signature = sign('sha256', mobileSigningPayload(deviceId, nonce), privateKey).toString('base64');
    expect(gateway.verifyDeviceSignature(deviceId, nonce, signature)).toBe(true);
    expect(gateway.verifyDeviceSignature(deviceId, `${nonce}-changed`, signature)).toBe(false);
  });

  it('bans an IP after five failures in 60 seconds', () => {
    const db = makeDb();
    const gateway = new MobileGatewayService(db as never) as any;
    const socket = new FakeSocket();
    for (let attempt = 0; attempt < 5; attempt++) gateway.authFail('192.168.1.8', socket, 'bad auth');
    expect(gateway.isBanned('192.168.1.8')).toBe(true);
    expect(socket.close).toHaveBeenLastCalledWith(1008, 'Authentication rate limit exceeded');
    expect(db.audits).toHaveLength(5);
  });

  it('expires and revokes task tokens with their control session', () => {
    const db = makeDb();
    const gateway = new MobileGatewayService(db as never) as any;
    db.sessions.set('session-1', { id: 'session-1', device_id: 'device-1', agent_id: 'agent-1', task_id: 'task-1', status: 'active', expires_at: Date.now() + 60_000 });
    gateway.taskTokens.set('expired-token', { token: 'expired-token', sessionId: 'session-1', agentId: 'agent-1', deviceId: 'device-1', taskId: 'task-1', allowedTools: new Set(['android_ping']), expiresAt: Date.now() - 1 });
    const request = { headers: { authorization: 'Bearer expired-token' } };
    expect(gateway.authenticatePlugin(request)).toBeNull();
    expect(gateway.taskTokens.has('expired-token')).toBe(false);
    expect(db.sessions.get('session-1').status).toBe('expired');

    db.sessions.set('session-2', { id: 'session-2', device_id: 'device-1', agent_id: 'agent-1', task_id: 'task-2', status: 'active', expires_at: Date.now() + 60_000 });
    gateway.taskTokens.set('live-token', { token: 'live-token', sessionId: 'session-2', agentId: 'agent-1', deviceId: 'device-1', taskId: 'task-2', allowedTools: new Set(['android_ping']), expiresAt: Date.now() + 60_000 });
    gateway.finishTask('task-2', 'cancelled');
    expect(gateway.taskTokens.has('live-token')).toBe(false);
    expect(db.sessions.get('session-2').status).toBe('cancelled');
  });

  it('translates a database uniqueness violation into a control lease conflict', () => {
    const db = makeDb();
    const originalPrepare = db.raw.prepare;
    db.raw.prepare = (sql: string) => {
      if (/INSERT INTO mobile_control_sessions/.test(sql)) {
        return { get: () => undefined, all: () => [], run: () => { throw new Error('UNIQUE constraint failed: mobile_control_sessions.device_id'); } };
      }
      return originalPrepare(sql);
    };
    const gateway = new MobileGatewayService(db as never) as any;
    // The lease path rejects offline devices before touching the database.
    gateway.connections.set('device-1', { deviceId: 'device-1', ws: {}, ip: '127.0.0.1', lastSeenAt: Date.now(), pending: new Map() });
    expect(() => gateway.acquireSession('agent-1', 'device-1', 'task-1', ['android_ping'], 60_000))
      .toThrow(/active control lease/);
  });

  it('enforces loopback access and task-scoped tool ACLs on the plugin API', async () => {
    const db = makeDb();
    const gateway = new MobileGatewayService(db as never) as any;
    const response = () => ({
      statusCode: 0,
      writableEnded: false,
      headers: {},
      setHeader(name: string, value: unknown) { this.headers[name] = value; },
      end(body: string) { this.body = body; this.writableEnded = true; }
    });
    const remoteResponse = response();
    await gateway.handlePluginRequest({ socket: { remoteAddress: '192.168.1.9' }, headers: {}, method: 'GET', url: '/v1/status' }, remoteResponse);
    expect(remoteResponse.statusCode).toBe(403);
    expect(JSON.parse(remoteResponse.body)).toEqual({ error: 'loopback_only' });

    db.sessions.set('session-acl', { id: 'session-acl', device_id: 'device-1', agent_id: 'agent-1', task_id: 'task-acl', status: 'active', expires_at: Date.now() + 60_000 });
    gateway.taskTokens.set('acl-token', {
      token: 'acl-token', sessionId: 'session-acl', agentId: 'agent-1', deviceId: 'device-1', taskId: 'task-acl',
      allowedTools: new Set(['android_ping']), expiresAt: Date.now() + 60_000
    });
    const request = new EventEmitter() as any;
    Object.assign(request, {
      socket: { remoteAddress: '127.0.0.1' }, headers: { authorization: 'Bearer acl-token' },
      method: 'POST', url: '/v1/tools/android_tap', destroy: vi.fn()
    });
    const aclResponse = response();
    const pending = gateway.handlePluginRequest(request, aclResponse);
    request.emit('data', Buffer.from('{"args":{"x":1,"y":1}}'));
    request.emit('end');
    await pending;
    expect(aclResponse.statusCode).toBe(403);
    expect(JSON.parse(aclResponse.body).error).toMatch(/not allowed/);
  });

  it('adds redacted Android tool calls and results to the owning task timeline', async () => {
    const db = makeDb();
    const gateway = new MobileGatewayService(db as never) as any;
    gateway.listDevices = () => [{ id: 'device-1', permissions: { accessibility: 'granted' } }];
    gateway.connections.set('device-1', { ws: { readyState: 1 } });
    gateway.sendBridgeCommand = vi.fn()
      .mockResolvedValueOnce({ status: 200, result: { success: true } })
      .mockResolvedValueOnce({ status: 200, result: { success: true, data: { tree: [{ text: 'private UI value' }] } } });
    const context = {
      sessionId: 'session-task', agentId: 'agent-1', deviceId: 'device-1', taskId: 'task-1',
      allowedTools: new Set(['android_type', 'android_read_screen'])
    };

    await gateway.executeTool(context, 'android_type', { text: 'super-secret-input', clear_first: true });
    await gateway.executeTool(context, 'android_read_screen', {});

    expect(db.taskEvents.map((event) => event.eventType)).toEqual(['tool_call', 'tool_result', 'tool_call', 'tool_result']);
    const serialized = JSON.stringify(db.taskEvents);
    expect(serialized).not.toContain('super-secret-input');
    expect(serialized).not.toContain('private UI value');
    expect(serialized).toContain('[redacted]');
    expect(JSON.parse(db.taskEvents[3].payload)).toMatchObject({
      name: 'android_read_screen', status: 'completed', result: { redacted: true }
    });
    expect(db.taskEvents.every((event) => event.taskId === 'task-1')).toBe(true);
  });

  it('rejects media chunks over 64 KiB and mismatched SHA-256', async () => {
    const gateway = new MobileGatewayService(makeDb() as never) as any;
    const socket = new FakeSocket();
    const pending = {
      requestId: 'request-1', toolName: 'android_screenshot', nonIdempotent: false,
      timer: setTimeout(() => {}, 60_000), resolve: vi.fn(), reject: vi.fn()
    };
    const connection = { deviceId: 'device-1', ws: socket, ip: '192.168.1.2', lastSeenAt: Date.now(), pending: new Map([['request-1', pending]]) };
    gateway.connections.set('device-1', connection);

    gateway.handleAuthenticatedMessage('device-1', { request_id: 'request-1', stream: { event: 'start', filename: 'screen.png', mimeType: 'image/png', size: 70_000 } });
    gateway.handleBinary('device-1', Buffer.concat([Buffer.from([0, 9]), Buffer.from('request-1'), Buffer.alloc(65_537)]));
    expect(pending.reject).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/chunk or total size/) }));

    const data = Buffer.from('valid-image-bytes');
    const pending2 = { ...pending, requestId: 'request-2', timer: setTimeout(() => {}, 60_000), resolve: vi.fn(), reject: vi.fn() };
    connection.pending.set('request-2', pending2);
    gateway.handleAuthenticatedMessage('device-1', { request_id: 'request-2', stream: { event: 'start', filename: 'screen.png', mimeType: 'image/png', size: data.length } });
    gateway.handleBinary('device-1', Buffer.concat([Buffer.from([0, 9]), Buffer.from('request-2'), data]));
    gateway.handleAuthenticatedMessage('device-1', { request_id: 'request-2', stream: { event: 'end', bytes: data.length, sha256: createHash('sha256').update('different').digest('hex') } });
    expect(pending2.reject).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/SHA-256/) }));
  });
});
