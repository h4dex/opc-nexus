import { createServer, type Server } from 'node:http';
import { DshWebGateway } from '../src/main/services/dshWebGateway.js';
import type {
  DshBrowserRpcClaim,
  DshBrowserSessionScope,
  DshBrowserWriteGuard
} from '../src/main/services/dshSessionWriteCoordinator.js';

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

function guardFixture() {
  const calls: Array<{ kind: string; value: unknown }> = [];
  const guard: DshBrowserWriteGuard = {
    claim: (context) => {
      calls.push({ kind: 'claim', value: context });
      const envelope = context.payload as { payload?: { deny?: boolean } };
      if (envelope?.payload?.deny) throw new Error('lease held');
      return { projected: true, localSessionId: 'local-1', commandId: 'rpc-1' };
    },
    completeClaim: (claim, result) => calls.push({ kind: 'complete', value: { claim, result } }),
    failClaim: (claim, error) => calls.push({ kind: 'fail', value: { claim, error } }),
    releaseClient: (id) => calls.push({ kind: 'release', value: id }),
    releaseAll: () => calls.push({ kind: 'releaseAll', value: null })
  };
  return { guard, calls };
}

async function desktopCookie(
  gateway: DshWebGateway,
  scope: DshBrowserSessionScope | null = null
): Promise<{ cookie: string; origin: string }> {
  const status = gateway.getStatus();
  const session = gateway.createDesktopSession(scope);
  const response = await fetch(session.url, { redirect: 'manual' });
  const cookie = response.headers.get('set-cookie');
  if (response.status !== 303 || !cookie || !status.origin) throw new Error('desktop session failed');
  return { cookie: cookie.split(';', 1)[0]!, origin: status.origin };
}

describe('desktop DSH browser write admission', () => {
  it('admits projected session writes before forwarding and completes only after upstream response', async () => {
    let received = '';
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        received = Buffer.concat(chunks).toString('utf8');
        response.setHeader('content-type', 'application/json');
        response.end('{"type":"server-response","rpcId":"rpc-1","result":{"ok":true,"value":{"accepted":true}}}');
      });
    });
    const port = await listen(upstream);
    const { guard, calls } = guardFixture();
    const gateway = new DshWebGateway({
      resolveUpstream: () => `http://127.0.0.1:${port}/`,
      resolveWriteAgentId: () => 'agent-1',
      writeGuard: guard
    });
    try {
      await gateway.start();
      const scope = { rootUpstreamSessionId: 'upstream-1' };
      const { cookie, origin } = await desktopCookie(gateway, scope);
      const payload = JSON.stringify({
        type: 'client-request', rpcId: 'rpc-1', method: 'session.prompt',
        payload: { sessionId: 'upstream-1', mode: 'queue', content: [{ type: 'text', text: 'hello' }] }
      });
      const response = await fetch(`${origin}/api/session.prompt`, {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: payload
      });
      expect(response.status).toBe(200);
      expect(received).toBe(payload);
      expect(calls.map((call) => call.kind)).toEqual(['claim', 'complete']);
      expect(calls[0]!.value).toMatchObject({ scope });
      expect((calls[1]!.value as { result: { statusCode: number } }).result.statusCode).toBe(200);
    } finally {
      await gateway.stop();
      await close(upstream);
    }
  });

  it('does not forward a denied admission', async () => {
    let forwarded = 0;
    const upstream = createServer((_request, response) => {
      forwarded += 1;
      response.end('{}');
    });
    const port = await listen(upstream);
    const { guard, calls } = guardFixture();
    const gateway = new DshWebGateway({
      resolveUpstream: () => `http://127.0.0.1:${port}/`,
      resolveWriteAgentId: () => 'agent-1',
      writeGuard: guard
    });
    try {
      await gateway.start();
      const { cookie, origin } = await desktopCookie(gateway);
      const denied = JSON.stringify({
        type: 'client-request', rpcId: 'rpc-1', method: 'session.prompt',
        payload: { sessionId: 'upstream-1', deny: true }
      });
      expect((await fetch(`${origin}/api/session.prompt`, {
        method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: denied
      })).status).toBe(409);
      expect(forwarded).toBe(0);
      expect(calls.map((call) => call.kind)).toEqual(['claim']);
    } finally {
      await gateway.stop();
      await close(upstream);
    }
  });

  it.each(['session.create', 'workspace.create'])(
    'routes scoped %s through Main admission instead of bypassing the guard',
    async (method) => {
      let forwarded = 0;
      const upstream = createServer((_request, response) => {
        forwarded += 1;
        response.end('{}');
      });
      const port = await listen(upstream);
      const calls: unknown[] = [];
      const guard: DshBrowserWriteGuard = {
        claim: (context) => {
          calls.push(context);
          throw new Error(`scoped browser write admission denies ${method}`);
        },
        completeClaim: () => {},
        failClaim: () => {},
        releaseClient: () => {},
        releaseAll: () => {}
      };
      const gateway = new DshWebGateway({
        resolveUpstream: () => `http://127.0.0.1:${port}/`,
        resolveWriteAgentId: () => 'agent-1',
        writeGuard: guard
      });
      try {
        await gateway.start();
        const scope = { rootUpstreamSessionId: 'upstream-root' };
        const { cookie, origin } = await desktopCookie(gateway, scope);
        const body = JSON.stringify({
          type: 'client-request', rpcId: `rpc-${method}`, method,
          payload: method === 'session.create'
            ? { workspaceId: 'workspace-1' }
            : { path: 'E:\\Projects\\Other' }
        });
        const response = await fetch(`${origin}/api/${method}`, {
          method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body
        });
        expect(response.status).toBe(409);
        expect(forwarded).toBe(0);
        expect(calls).toEqual([expect.objectContaining({ method, scope })]);
      } finally {
        await gateway.stop();
        await close(upstream);
      }
    }
  );

  it('keeps an admitted receipt unresolved when the upstream transport drops', async () => {
    const upstream = createServer((request) => {
      request.resume();
      request.once('end', () => request.socket.destroy());
    });
    const port = await listen(upstream);
    const { guard, calls } = guardFixture();
    const gateway = new DshWebGateway({
      resolveUpstream: () => `http://127.0.0.1:${port}/`,
      resolveWriteAgentId: () => 'agent-1',
      writeGuard: guard
    });
    try {
      await gateway.start();
      const { cookie, origin } = await desktopCookie(gateway);
      const payload = JSON.stringify({
        type: 'client-request', rpcId: 'rpc-1', method: 'session.prompt',
        payload: { sessionId: 'upstream-1', mode: 'queue', content: [] }
      });
      const response = await fetch(`${origin}/api/session.prompt`, {
        method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: payload
      });
      expect(response.status).toBe(502);
      expect(calls.map((call) => call.kind)).toEqual(['claim']);
    } finally {
      await gateway.stop();
      await close(upstream);
    }
  });

  it('fails an admitted receipt only after an explicit upstream rejection', async () => {
    const upstream = createServer((_request, response) => {
      response.statusCode = 409;
      response.end('{"error":"rejected"}');
    });
    const port = await listen(upstream);
    const { guard, calls } = guardFixture();
    const gateway = new DshWebGateway({
      resolveUpstream: () => `http://127.0.0.1:${port}/`,
      resolveWriteAgentId: () => 'agent-1',
      writeGuard: guard
    });
    try {
      await gateway.start();
      const { cookie, origin } = await desktopCookie(gateway);
      const payload = JSON.stringify({
        type: 'client-request', rpcId: 'rpc-1', method: 'session.prompt',
        payload: { sessionId: 'upstream-1', mode: 'queue', content: [] }
      });
      expect((await fetch(`${origin}/api/session.prompt`, {
        method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: payload
      })).status).toBe(409);
      expect(calls.map((call) => call.kind)).toEqual(['claim', 'fail']);
    } finally {
      await gateway.stop();
      await close(upstream);
    }
  });
});
