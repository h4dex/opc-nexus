import { createServer, type IncomingMessage, type Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { DshWebGateway } from '../src/main/services/dshWebGateway.js';
import type {
  DshBrowserReadScopeDecision,
  DshBrowserSessionScope,
  DshBrowserWriteGuard
} from '../src/main/services/dshSessionWriteCoordinator.js';

const QUEST_SCOPE = { rootUpstreamSessionId: 'project-a-root' } satisfies DshBrowserSessionScope;

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('missing test port'));
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function readRequest(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function scopeGuard(decisions: Record<string, DshBrowserReadScopeDecision>): DshBrowserWriteGuard {
  return {
    checkReadScope: ({ upstreamSessionId }) => decisions[upstreamSessionId] ?? 'unknown',
    claim: () => ({ projected: false, localSessionId: null, commandId: null }),
    completeClaim: () => {},
    failClaim: () => {},
    releaseClient: () => {},
    releaseAll: () => {}
  };
}

async function desktopCookie(
  gateway: DshWebGateway,
  scope: DshBrowserSessionScope | null
): Promise<{ cookie: string; origin: string }> {
  const origin = gateway.getStatus().origin;
  if (!origin) throw new Error('gateway did not start');
  const session = gateway.createDesktopSession(scope);
  const response = await fetch(session.url, { redirect: 'manual' });
  const setCookie = response.headers.get('set-cookie');
  if (response.status !== 303 || !setCookie) throw new Error('desktop session failed');
  return { cookie: setCookie.split(';', 1)[0]!, origin };
}

async function rpc(
  origin: string,
  cookie: string,
  method: string,
  payload: Record<string, unknown> = {}
): Promise<Response> {
  return fetch(`${origin}/api/${method}`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `rpc-${method}`, method, payload })
  });
}

function rpcResponse(rpcId: string, value: Record<string, unknown>): string {
  return JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } });
}

function sseFrame(rpcId: string, payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    type: 'server-request', rpcId, method: payload.type, payload
  })}\n\n`;
}

async function rejectedWebSocketStatus(url: string, cookie: string, origin: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Cookie: cookie, Origin: origin } });
    socket.once('open', () => {
      socket.close();
      reject(new Error('WebSocket was unexpectedly accepted'));
    });
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once('error', reject);
  });
}

describe('DSH scoped read gateway', () => {
  it('filters session.list to the selected root and its multi-level descendants', async () => {
    let upstreamRequests = 0;
    let upstreamHeaders = '';
    const upstream = createServer((request, response) => {
      upstreamRequests += 1;
      upstreamHeaders = JSON.stringify(request.headers);
      response.setHeader('content-type', 'application/json');
      const body = rpcResponse('rpc-session.list', {
        items: [
          { sessionId: 'project-a-grandchild', parentSessionId: 'project-a-child', title: 'Grandchild' },
          { sessionId: 'project-b-child', parentSessionId: 'project-b-root', title: 'Other child' },
          { sessionId: 'project-a-root', title: 'Selected root' },
          { sessionId: 'project-b-root', title: 'Other root' },
          { sessionId: 'project-a-child', parentSessionId: 'project-a-root', title: 'Child' },
          { sessionId: 'unknown-orphan', parentSessionId: 'missing-parent', title: 'Orphan' }
        ]
      });
      const split = Math.floor(body.length / 2);
      response.write(body.slice(0, split));
      response.end(body.slice(split));
    });
    const port = await listen(upstream);
    const gateway = new DshWebGateway({
      resolveUpstream: () => `http://127.0.0.1:${port}/`,
      resolveWriteAgentId: () => 'agent-a',
      writeGuard: scopeGuard({
        'project-a-root': 'allowed',
        'project-a-child': 'allowed',
        'project-a-grandchild': 'allowed',
        'project-b-root': 'denied',
        'project-b-child': 'denied'
      })
    });

    try {
      await gateway.start();
      const { cookie, origin } = await desktopCookie(gateway, QUEST_SCOPE);
      expect(cookie).not.toContain(QUEST_SCOPE.rootUpstreamSessionId);
      const response = await rpc(origin, cookie, 'session.list');
      expect(response.status).toBe(200);
      const envelope = await response.json() as {
        result: { value: { items: Array<{ sessionId: string }> } };
      };
      expect(envelope.result.value.items.map((item) => item.sessionId)).toEqual([
        'project-a-grandchild',
        'project-a-root',
        'project-a-child'
      ]);
      expect(upstreamRequests).toBe(1);
      expect(upstreamHeaders).not.toContain(QUEST_SCOPE.rootUpstreamSessionId);
    } finally {
      await gateway.stop();
      await close(upstream);
    }
  });

  it.each([
    ['session.history', { sessionId: 'project-b-root' }],
    ['session.models', { sessionId: 'unknown-session' }]
  ])('denies cross-root or unknown %s before it reaches upstream', async (method, payload) => {
    let upstreamRequests = 0;
    const upstream = createServer((_request, response) => {
      upstreamRequests += 1;
      response.end('{}');
    });
    const port = await listen(upstream);
    const gateway = new DshWebGateway({
      resolveUpstream: () => `http://127.0.0.1:${port}/`,
      resolveWriteAgentId: () => 'agent-a',
      writeGuard: scopeGuard({
        'project-a-root': 'allowed',
        'project-b-root': 'denied',
        'unknown-session': 'unknown'
      })
    });

    try {
      await gateway.start();
      const { cookie, origin } = await desktopCookie(gateway, QUEST_SCOPE);
      const response = await rpc(origin, cookie, method, payload);
      expect(response.status).toBe(403);
      expect(upstreamRequests).toBe(0);
    } finally {
      await gateway.stop();
      await close(upstream);
    }
  });

  it('filters workspace paths, session ids, and archived ids outside the selected project', async () => {
    const upstream = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(rpcResponse('rpc-workspace.list', {
        items: [
          {
            workspaceId: 'workspace-a',
            path: 'E:\\Projects\\Selected',
            title: 'Selected project',
            sessionIds: ['project-a-root', 'project-a-child', 'project-b-root']
          },
          {
            workspaceId: 'workspace-b',
            path: 'E:\\Projects\\Confidential',
            title: 'Confidential project',
            sessionIds: ['project-b-root']
          }
        ],
        archivedSessionIds: ['project-a-child', 'project-b-root']
      }));
    });
    const port = await listen(upstream);
    const gateway = new DshWebGateway({
      resolveUpstream: () => `http://127.0.0.1:${port}/`,
      resolveWriteAgentId: () => 'agent-a',
      writeGuard: scopeGuard({
        'project-a-root': 'allowed',
        'project-a-child': 'allowed',
        'project-b-root': 'denied'
      })
    });

    try {
      await gateway.start();
      const { cookie, origin } = await desktopCookie(gateway, QUEST_SCOPE);
      const response = await rpc(origin, cookie, 'workspace.list');
      expect(response.status).toBe(200);
      const raw = await response.text();
      expect(raw).not.toContain('Confidential');
      const envelope = JSON.parse(raw) as {
        result: { value: { items: Array<Record<string, unknown>>; archivedSessionIds: string[] } };
      };
      expect(envelope.result.value).toEqual({
        items: [{
          workspaceId: 'workspace-a',
          path: 'E:\\Projects\\Selected',
          title: 'Selected project',
          sessionIds: ['project-a-root', 'project-a-child']
        }],
        archivedSessionIds: ['project-a-child']
      });
    } finally {
      await gateway.stop();
      await close(upstream);
    }
  });

  it.each(['GET', 'HEAD'])('rejects scoped session.export %s without contacting upstream', async (method) => {
    let upstreamRequests = 0;
    const upstream = createServer((_request, response) => {
      upstreamRequests += 1;
      response.end('export');
    });
    const port = await listen(upstream);
    const gateway = new DshWebGateway({ resolveUpstream: () => `http://127.0.0.1:${port}/` });

    try {
      await gateway.start();
      const { cookie, origin } = await desktopCookie(gateway, QUEST_SCOPE);
      const response = await fetch(`${origin}/api/session.export?sessionId=project-a-root`, {
        method,
        headers: { cookie }
      });
      expect(response.status).toBe(403);
      expect(upstreamRequests).toBe(0);
    } finally {
      await gateway.stop();
      await close(upstream);
    }
  });

  it('rejects non-event scoped WebSocket upgrades before contacting upstream', async () => {
    let upstreamUpgrades = 0;
    const upstream = createServer((_request, response) => response.writeHead(404).end());
    upstream.on('upgrade', (_request, socket) => {
      upstreamUpgrades += 1;
      socket.destroy();
    });
    const port = await listen(upstream);
    const gateway = new DshWebGateway({ resolveUpstream: () => `http://127.0.0.1:${port}/` });

    try {
      await gateway.start();
      const { cookie, origin } = await desktopCookie(gateway, QUEST_SCOPE);
      const status = await rejectedWebSocketStatus(
        `${origin.replace('http:', 'ws:')}/api/private`, cookie, origin
      );
      expect(status).toBe(400);
      expect(upstreamUpgrades).toBe(0);
    } finally {
      await gateway.stop();
      await close(upstream);
    }
  });

  it('filters fragmented UTF-8 SSE frames and drops comments, malformed, unknown, and cross-root data', async () => {
    let acceptEncoding: string | undefined;
    const allowed = sseFrame('event-a', {
      type: 'session/event', sessionId: 'project-a-root',
      event: { type: 'message/complete', seq: 1, text: '项目甲' }
    });
    const hidden = sseFrame('event-b', {
      type: 'session/event', sessionId: 'project-b-root',
      event: { type: 'message/complete', seq: 2, text: '机密项目' }
    });
    const unknown = sseFrame('event-unknown', {
      type: 'future/global-frame', sessionId: 'project-a-root', secret: 'future-secret'
    });
    const stream = Buffer.from(
      `: upstream-secret-comment\n\n${allowed}${hidden}data: {not-json}\n\n${unknown}`,
      'utf8'
    );
    const utf8Marker = Buffer.from('项目甲', 'utf8');
    const markerIndex = stream.indexOf(utf8Marker);
    if (markerIndex < 0) throw new Error('missing UTF-8 test marker');
    const split = markerIndex + 1;
    const upstream = createServer((request, response) => {
      acceptEncoding = request.headers['accept-encoding'];
      response.setHeader('content-type', 'text/event-stream; charset=utf-8');
      response.write(stream.subarray(0, split));
      setTimeout(() => response.end(stream.subarray(split)), 5);
    });
    const port = await listen(upstream);
    const gateway = new DshWebGateway({
      resolveUpstream: () => `http://127.0.0.1:${port}/`,
      resolveWriteAgentId: () => 'agent-a',
      writeGuard: scopeGuard({ 'project-a-root': 'allowed', 'project-b-root': 'denied' })
    });

    try {
      await gateway.start();
      const { cookie, origin } = await desktopCookie(gateway, QUEST_SCOPE);
      const response = await fetch(`${origin}/api/events.mux`, { headers: { cookie } });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(acceptEncoding).toBe('identity');
      expect(body).toContain(': opc-scoped-stream');
      expect(body).toContain('项目甲');
      expect(body).not.toContain('upstream-secret-comment');
      expect(body).not.toContain('机密项目');
      expect(body).not.toContain('future-secret');
      expect(body).not.toContain('not-json');
    } finally {
      await gateway.stop();
      await close(upstream);
    }
  });

  it('terminates a scoped SSE response before parsing an oversized complete frame', async () => {
    const oversized = sseFrame('oversized', {
      type: 'session/event', sessionId: 'project-a-root', data: 'x'.repeat(2 * 1024 * 1024)
    });
    const upstream = createServer((_request, response) => {
      response.setHeader('content-type', 'text/event-stream');
      response.end(oversized);
    });
    const port = await listen(upstream);
    const gateway = new DshWebGateway({
      resolveUpstream: () => `http://127.0.0.1:${port}/`,
      resolveWriteAgentId: () => 'agent-a',
      writeGuard: scopeGuard({ 'project-a-root': 'allowed' })
    });

    try {
      await gateway.start();
      const { cookie, origin } = await desktopCookie(gateway, QUEST_SCOPE);
      const response = await fetch(`${origin}/api/events.mux`, { headers: { cookie } });
      expect(response.status).toBe(200);
      await expect(response.text()).rejects.toThrow();
    } finally {
      await gateway.stop();
      await close(upstream);
    }
  });

  it('keeps unscoped HTTP reads and WebSocket traffic on the native passthrough', async () => {
    let httpBody = '';
    let upstreamUpgrades = 0;
    const nativeResponse = '{"native":true,"items":["unfiltered"]}';
    const upstream = createServer((request, response) => {
      void readRequest(request).then((body) => {
        httpBody = body;
        response.setHeader('content-type', 'application/octet-stream');
        response.end(nativeResponse);
      });
    });
    const sockets = new WebSocketServer({ noServer: true });
    upstream.on('upgrade', (request, socket, head) => {
      upstreamUpgrades += 1;
      sockets.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.once('message', (message, isBinary) => webSocket.send(message, { binary: isBinary }));
      });
    });
    const port = await listen(upstream);
    const gateway = new DshWebGateway({ resolveUpstream: () => `http://127.0.0.1:${port}/` });

    try {
      await gateway.start();
      const { cookie, origin } = await desktopCookie(gateway, null);
      const requestBody = JSON.stringify({
        type: 'client-request', rpcId: 'native-rpc', method: 'session.list', payload: { native: true }
      });
      const response = await fetch(`${origin}/api/session.list`, {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: requestBody
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(nativeResponse);
      expect(httpBody).toBe(requestBody);

      const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/events.mux`, {
        headers: { Cookie: cookie, Origin: origin }
      });
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      const payload = Buffer.from([0, 1, 2, 255]);
      socket.send(payload);
      const echoed = await new Promise<Buffer>((resolve, reject) => {
        socket.once('message', (message, isBinary) => {
          if (!isBinary) return reject(new Error('binary frame became text'));
          resolve(Buffer.from(message as Buffer));
        });
        socket.once('error', reject);
      });
      expect(echoed).toEqual(payload);
      expect(upstreamUpgrades).toBe(1);
      socket.close();
    } finally {
      await gateway.stop();
      sockets.close();
      await close(upstream);
    }
  });
});
