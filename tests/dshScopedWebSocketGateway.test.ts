import { createServer, type IncomingMessage, type Server } from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { DshWebGateway } from '../src/main/services/dshWebGateway.js';
import type {
  DshBrowserReadScopeDecision,
  DshBrowserSessionScope,
  DshBrowserWriteGuard
} from '../src/main/services/dshSessionWriteCoordinator.js';

const QUEST_SCOPE = { rootUpstreamSessionId: 'project-a-root' } satisfies DshBrowserSessionScope;
const SOCKET_TIMEOUT_MS = 2_000;

interface ReceivedFrame {
  binary: boolean;
  data: Buffer;
}

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

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) client.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
  const issued = gateway.createDesktopSession(scope);
  const response = await fetch(issued.url, { redirect: 'manual' });
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

function serverRequest(rpcId: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ type: 'server-request', rpcId, method: payload.type, payload });
}

function openSocket(origin: string, path: string, cookie: string): WebSocket {
  return new WebSocket(`${origin.replace('http:', 'ws:')}${path}`, {
    headers: { Cookie: cookie, Origin: origin }
  });
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket open timed out')), SOCKET_TIMEOUT_MS);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function collectUntil(socket: WebSocket, done: (frame: ReceivedFrame) => boolean): Promise<ReceivedFrame[]> {
  return new Promise((resolve, reject) => {
    const frames: ReceivedFrame[] = [];
    const timer = setTimeout(() => finish(new Error('WebSocket frame collection timed out')), SOCKET_TIMEOUT_MS);
    const onMessage = (data: RawData, binary: boolean) => {
      const frame = { binary, data: Buffer.from(data as Buffer) };
      frames.push(frame);
      if (done(frame)) finish();
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error('WebSocket closed before the sentinel frame'));
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (error) reject(error);
      else resolve(frames);
    };
    socket.on('message', onMessage);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function parseTextFrames(frames: ReceivedFrame[]): Array<{
  rpcId: string;
  method: string;
  payload: Record<string, unknown>;
}> {
  return frames.map((frame) => {
    expect(frame.binary).toBe(false);
    return JSON.parse(frame.data.toString('utf8')) as {
      rpcId: string;
      method: string;
      payload: Record<string, unknown>;
    };
  });
}

describe('DSH scoped WebSocket gateway', () => {
  it('keeps only root and child mux frames while dropping unsafe rc.6 downlink data', async () => {
    const upstream = createServer((_request, response) => response.writeHead(404).end());
    const sockets = new WebSocketServer({ noServer: true });
    upstream.on('upgrade', (request, socket, head) => {
      sockets.handleUpgrade(request, socket, head, (webSocket) => {
        setTimeout(() => {
          webSocket.send(serverRequest('mux-root', {
            type: 'session/subscribed', sessionId: 'project-a-root', lastSeq: 7
          }));
          webSocket.send(serverRequest('mux-hidden', {
            type: 'session/event', sessionId: 'project-b-root',
            event: { type: 'assistant/chunk', data: 'cross-root-secret' }
          }));
          webSocket.send(Buffer.from('binary-secret'), { binary: true });
          webSocket.send('{malformed-secret');
          webSocket.send(serverRequest('mux-error', {
            type: 'stream/error', error: { code: 'internal', message: 'runtime-secret', details: {} }
          }));
          webSocket.send(serverRequest('mux-child', {
            type: 'session/event', sessionId: 'project-a-child',
            event: { type: 'assistant/chunk', data: 'child-visible' }
          }));
          webSocket.send(serverRequest('mux-sentinel', {
            type: 'session/projection', sessionId: 'project-a-root', key: 'title', value: 'done', seq: 8
          }));
        }, 20);
      });
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
    let socket: WebSocket | null = null;

    try {
      await gateway.start();
      const { cookie, origin } = await desktopCookie(gateway, QUEST_SCOPE);
      socket = openSocket(origin, '/api/events.mux', cookie);
      const collected = collectUntil(socket, (frame) => (
        !frame.binary && frame.data.toString('utf8').includes('mux-sentinel')
      ));
      await waitForOpen(socket);
      const frames = parseTextFrames(await collected);

      expect(frames.map((frame) => frame.rpcId)).toEqual(['mux-root', 'mux-child', 'mux-sentinel']);
      expect(frames.map((frame) => frame.method)).toEqual([
        'session/subscribed', 'session/event', 'session/projection'
      ]);
      expect(JSON.stringify(frames)).toContain('child-visible');
      expect(JSON.stringify(frames)).not.toMatch(/cross-root-secret|binary-secret|malformed-secret|runtime-secret/);
    } finally {
      socket?.terminate();
      await gateway.stop();
      await closeWebSocketServer(sockets);
      await close(upstream);
    }
  });

  it('filters host workspace snapshots and global ids without forwarding remote or malformed frames', async () => {
    const upstream = createServer((request, response) => {
      void (async () => {
        const body = JSON.parse(await readRequest(request)) as { rpcId: string; method: string };
        if (body.method !== 'workspace.list') {
          response.writeHead(404).end();
          return;
        }
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          type: 'server-response',
          rpcId: body.rpcId,
          result: {
            ok: true,
            value: {
              items: [{
                workspaceId: 'workspace-a',
                path: 'E:\\Projects\\Selected',
                title: 'Selected',
                sessionIds: ['project-a-root', 'project-a-child', 'project-b-root']
              }, {
                workspaceId: 'workspace-b',
                path: 'E:\\Projects\\Confidential',
                title: 'Confidential',
                sessionIds: ['project-b-root']
              }],
              archivedSessionIds: []
            }
          }
        }));
      })().catch(() => response.destroy());
    });
    const sockets = new WebSocketServer({ noServer: true });
    upstream.on('upgrade', (request, socket, head) => {
      sockets.handleUpgrade(request, socket, head, (webSocket) => {
        setTimeout(() => {
          webSocket.send(serverRequest('host-root', {
            type: 'host/session-status', sessionId: 'project-a-root', running: true
          }));
          webSocket.send(serverRequest('host-hidden', {
            type: 'host/session-status', sessionId: 'project-b-root', running: true,
            secret: 'cross-root-host-secret'
          }));
          webSocket.send(Buffer.from('host-binary-secret'), { binary: true });
          webSocket.send('{host-malformed-secret');
          webSocket.send(serverRequest('host-error', {
            type: 'stream/error', error: { code: 'internal', message: 'host-runtime-secret', details: {} }
          }));
          webSocket.send(serverRequest('host-remote', {
            type: 'host/remote-event', event: 'credentials/updated', args: ['credential-secret']
          }));
          webSocket.send(serverRequest('host-workspace', {
            type: 'host/workspace-changed',
            workspace: {
              workspaceId: 'workspace-a', path: 'E:\\Projects\\Selected', title: 'Selected',
              sessionIds: ['project-a-root', 'project-a-child', 'project-b-root']
            }
          }));
          webSocket.send(serverRequest('host-hidden-workspace', {
            type: 'host/workspace-changed',
            workspace: {
              workspaceId: 'workspace-b', path: 'E:\\Projects\\Confidential', title: 'Confidential',
              sessionIds: ['project-b-root']
            }
          }));
          webSocket.send(serverRequest('host-workspace-order', {
            type: 'host/workspace-order-changed', workspaceIds: ['workspace-b', 'workspace-a']
          }));
          webSocket.send(serverRequest('host-archives', {
            type: 'host/archived-sessions-changed',
            archivedSessionIds: ['project-a-child', 'project-b-root']
          }));
          webSocket.send(serverRequest('host-sentinel', {
            type: 'host/session-status', sessionId: 'project-a-child', running: false
          }));
        }, 20);
      });
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
    let socket: WebSocket | null = null;

    try {
      await gateway.start();
      const { cookie, origin } = await desktopCookie(gateway, QUEST_SCOPE);
      const workspace = await rpc(origin, cookie, 'workspace.list');
      expect(workspace.status).toBe(200);
      await workspace.arrayBuffer();

      socket = openSocket(origin, '/api/events.host', cookie);
      const collected = collectUntil(socket, (frame) => (
        !frame.binary && frame.data.toString('utf8').includes('host-sentinel')
      ));
      await waitForOpen(socket);
      const frames = parseTextFrames(await collected);

      expect(frames.map((frame) => frame.rpcId)).toEqual([
        'host-root', 'host-workspace', 'host-workspace-order', 'host-archives', 'host-sentinel'
      ]);
      expect(frames.find((frame) => frame.rpcId === 'host-workspace')?.payload).toMatchObject({
        workspace: { workspaceId: 'workspace-a', sessionIds: ['project-a-root', 'project-a-child'] }
      });
      expect(frames.find((frame) => frame.rpcId === 'host-workspace-order')?.payload)
        .toMatchObject({ workspaceIds: ['workspace-a'] });
      expect(frames.find((frame) => frame.rpcId === 'host-archives')?.payload)
        .toMatchObject({ archivedSessionIds: ['project-a-child'] });
      expect(JSON.stringify(frames)).not.toMatch(
        /Confidential|project-b-root|cross-root-host-secret|host-binary-secret|host-malformed-secret|host-runtime-secret|credential-secret/
      );
    } finally {
      socket?.terminate();
      await gateway.stop();
      await closeWebSocketServer(sockets);
      await close(upstream);
    }
  });

  it('admits each delivered question or approval response once and rejects forged or hidden rpc ids', async () => {
    const forwardedResponseIds: string[] = [];
    const upstream = createServer((request, response) => {
      void (async () => {
        if (request.url !== '/api/respond') {
          response.writeHead(404).end();
          return;
        }
        const envelope = JSON.parse(await readRequest(request)) as { rpcId?: unknown };
        forwardedResponseIds.push(String(envelope.rpcId));
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: { accepted: true } }
        }));
      })().catch(() => response.destroy());
    });
    const sockets = new WebSocketServer({ noServer: true });
    upstream.on('upgrade', (request, socket, head) => {
      sockets.handleUpgrade(request, socket, head, (webSocket) => {
        setTimeout(() => {
          webSocket.send(serverRequest('hidden-approval', {
            type: 'approval/requested', sessionId: 'project-b-root',
            approvalId: 'approval-hidden', toolName: 'bash', description: 'hidden project request'
          }));
          webSocket.send(serverRequest('owned-question', {
            type: 'question/requested', sessionId: 'project-a-root',
            questions: [{ id: 'scope', header: 'Scope', question: 'Continue?', options: [] }]
          }));
          webSocket.send(serverRequest('owned-approval', {
            type: 'approval/requested', sessionId: 'project-a-child',
            approvalId: 'approval-owned', toolName: 'bash', description: 'visible project request'
          }));
        }, 20);
      });
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
    let socket: WebSocket | null = null;
    const respond = (origin: string, cookie: string, rpcId: string) => fetch(`${origin}/api/respond`, {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-response', rpcId, result: { ok: true, value: { accepted: true } }
      })
    });

    try {
      await gateway.start();
      const { cookie, origin } = await desktopCookie(gateway, QUEST_SCOPE);
      socket = openSocket(origin, '/api/events.mux', cookie);
      const collected = collectUntil(socket, (frame) => (
        !frame.binary && frame.data.toString('utf8').includes('owned-approval')
      ));
      await waitForOpen(socket);
      const delivered = parseTextFrames(await collected);
      expect(delivered.map((frame) => frame.rpcId)).toEqual(['owned-question', 'owned-approval']);

      expect((await respond(origin, cookie, 'forged-response')).status).toBe(403);
      expect((await respond(origin, cookie, 'hidden-approval')).status).toBe(403);
      expect(forwardedResponseIds).toEqual([]);

      expect((await respond(origin, cookie, 'owned-question')).status).toBe(200);
      expect((await respond(origin, cookie, 'owned-question')).status).toBe(403);
      expect((await respond(origin, cookie, 'owned-approval')).status).toBe(200);
      expect((await respond(origin, cookie, 'owned-approval')).status).toBe(403);
      expect(forwardedResponseIds).toEqual(['owned-question', 'owned-approval']);
    } finally {
      socket?.terminate();
      await gateway.stop();
      await closeWebSocketServer(sockets);
      await close(upstream);
    }
  });

  it('preserves native text, malformed, and binary downlink frames for an unscoped DSH window', async () => {
    const upstream = createServer((_request, response) => response.writeHead(404).end());
    const sockets = new WebSocketServer({ noServer: true });
    const nativeText = serverRequest('native-global', {
      type: 'host/remote-event', event: 'credentials/updated', args: ['native-value']
    });
    const malformed = '{native-malformed';
    const binary = Buffer.from([0, 1, 2, 255]);
    upstream.on('upgrade', (request, socket, head) => {
      sockets.handleUpgrade(request, socket, head, (webSocket) => {
        setTimeout(() => {
          webSocket.send(nativeText);
          webSocket.send(malformed);
          webSocket.send(binary, { binary: true });
        }, 20);
      });
    });
    const port = await listen(upstream);
    const gateway = new DshWebGateway({ resolveUpstream: () => `http://127.0.0.1:${port}/` });
    let socket: WebSocket | null = null;

    try {
      await gateway.start();
      const { cookie, origin } = await desktopCookie(gateway, null);
      socket = openSocket(origin, '/api/events.host', cookie);
      const collected = collectUntil(socket, (frame) => frame.binary);
      await waitForOpen(socket);
      const frames = await collected;

      expect(frames).toHaveLength(3);
      expect(frames[0]).toMatchObject({ binary: false, data: Buffer.from(nativeText) });
      expect(frames[1]).toMatchObject({ binary: false, data: Buffer.from(malformed) });
      expect(frames[2]).toMatchObject({ binary: true, data: binary });
    } finally {
      socket?.terminate();
      await gateway.stop();
      await closeWebSocketServer(sockets);
      await close(upstream);
    }
  });
});
