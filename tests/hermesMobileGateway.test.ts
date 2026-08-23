import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ safeStorage: {} }));

import {
  ensureHermesMobileTlsIdentity,
  hermesMobileRoutePolicy
} from '../src/main/services/hermesMobileGateway.js';
import { SecureLanTlsHostMismatchError } from '../src/main/services/secureLanGatewayConfig.js';

const runtimeId = 'hermes-project:project-1:operator';

function policy(
  pathname: string,
  options: { method?: string; search?: string; websocket?: boolean } = {}
) {
  return hermesMobileRoutePolicy(runtimeId, {
    runtimeId,
    method: options.method ?? 'GET',
    pathname,
    search: options.search ?? '',
    websocket: options.websocket ?? false
  });
}

describe('Hermes mobile route policy', () => {
  it('exposes only project chat, static assets, and the health projection', () => {
    expect(policy('/chat')).toMatchObject({ kind: 'web', roles: ['operator'] });
    expect(policy('/sessions')).toBeNull();
    expect(policy('/files')).toBeNull();
    expect(policy('/logs')).toBeNull();
    expect(policy('/')).toBeNull();
    expect(policy('/assets/index.js')).toMatchObject({ kind: 'web', roles: ['operator'] });
    expect(policy('/config')).toBeNull();
    expect(policy('/profiles')).toBeNull();
    expect(policy('/api/sessions?profile=other')).toBeNull();
    expect(policy('/api/sessions', { method: 'DELETE' })).toBeNull();
    expect(policy('/api/env')).toBeNull();
    expect(policy('/api/status')).toMatchObject({ kind: 'web', roles: ['operator'] });
    expect(policy('/api/status', { search: '?profile=other' })).toBeNull();
    for (const path of ['/api/sessions', '/api/files', '/api/memory', '/api/logs', '/api/git', '/api/model/info']) {
      expect(policy(path)).toBeNull();
    }
  });

  it('exposes only the Main-owned project event socket', () => {
    const token = `token=${encodeURIComponent('opc-nexus-main-proxy')}`;
    expect(policy('/__opc_nexus/project/events', { websocket: true }))
      .toMatchObject({ kind: 'websocket', roles: ['operator'] });
    expect(policy('/api/events', { websocket: true, search: `?channel=c1&${token}` })).toBeNull();
    expect(policy('/api/ws', { websocket: true, search: `?${token}` })).toBeNull();
    expect(policy('/api/pty', { websocket: true, search: `?channel=c1&attach=a1&${token}` })).toBeNull();
    expect(policy('/api/pty', { websocket: true, search: `?profile=other&${token}` })).toBeNull();
    expect(policy('/api/ws', { websocket: true, search: '?token=real-secret' })).toBeNull();
  });

  it('keeps projected state and every control operation operator-only', () => {
    expect(policy('/__opc_nexus/project/state')).toMatchObject({
      kind: 'web', roles: ['operator']
    });
    expect(policy('/__opc_nexus/project/chat-history')).toMatchObject({
      kind: 'web', roles: ['operator']
    });
    expect(policy('/__opc_nexus/project/conversations')).toMatchObject({
      kind: 'web', roles: ['operator']
    });
    expect(policy('/__opc_nexus/project/chat-history', { method: 'POST' })).toMatchObject({
      kind: 'rpc', roles: ['operator']
    });
    expect(policy('/__opc_nexus/project/create-conversation', { method: 'POST' })).toMatchObject({
      kind: 'rpc', roles: ['operator']
    });
    expect(policy('/__opc_nexus/project/chat-queue')).toMatchObject({
      kind: 'web', roles: ['operator']
    });
    expect(policy('/__opc_nexus/project/events', { websocket: true })).toMatchObject({
      kind: 'websocket', roles: ['operator']
    });
    expect(policy('/__opc_nexus/project/enqueue-chat-turn', { method: 'POST' })).toMatchObject({
      kind: 'rpc', roles: ['operator']
    });
    expect(policy('/__opc_nexus/project/retry-chat-message', { method: 'POST' })).toMatchObject({
      kind: 'rpc', roles: ['operator']
    });
    expect(policy('/__opc_nexus/project/cancel-chat-message', { method: 'POST' })).toMatchObject({
      kind: 'rpc', roles: ['operator']
    });
    expect(policy('/__opc_nexus/project/chat-turn', { method: 'POST' })).toMatchObject({
      kind: 'rpc', roles: ['operator']
    });
    expect(policy('/__opc_nexus/project/answer-clarify', { method: 'POST' })).toMatchObject({
      kind: 'rpc', roles: ['operator']
    });
    expect(policy('/__opc_nexus/project/approve-plan', { method: 'POST' })).toMatchObject({
      kind: 'rpc', roles: ['operator']
    });
    expect(policy('/__opc_nexus/project/dispatch-plan', { method: 'POST' })).toMatchObject({
      kind: 'rpc', roles: ['operator']
    });
    expect(policy('/__opc_nexus/project/open-project-directory', { method: 'POST' })).toBeNull();
    expect(policy('/__opc_nexus/project/delete-project', { method: 'POST' })).toBeNull();
  });

  it('rejects cross-runtime policy reuse', () => {
    expect(hermesMobileRoutePolicy('other-runtime', {
      runtimeId, method: 'GET', pathname: '/', search: '', websocket: false
    })).toBeNull();
  });
});

describe('Hermes mobile configuration boundary', () => {
  it('rotates only a host-mismatched Hermes mobile TLS identity', async () => {
    const identity = { key: 'key', cert: 'cert' };
    const identities = {
      ensure: vi.fn()
        .mockRejectedValueOnce(new SecureLanTlsHostMismatchError())
        .mockResolvedValueOnce(identity),
      reset: vi.fn()
    };
    const config = {
      bindHost: '192.168.1.20', port: 18_766,
      publicHost: '192.168.1.20', publicPort: 18_766
    };

    await expect(ensureHermesMobileTlsIdentity(identities as never, config)).resolves.toBe(identity);
    expect(identities.reset).toHaveBeenCalledTimes(1);
    expect(identities.ensure).toHaveBeenCalledTimes(2);
  });

  it('does not hide a corrupt Hermes mobile TLS identity', async () => {
    const identities = {
      ensure: vi.fn().mockRejectedValue(new Error('cannot decrypt secret payload')),
      reset: vi.fn()
    };
    const config = {
      bindHost: '192.168.1.20', port: 18_766,
      publicHost: '192.168.1.20', publicPort: 18_766
    };

    await expect(ensureHermesMobileTlsIdentity(identities as never, config))
      .rejects.toThrow('cannot decrypt secret payload');
    expect(identities.reset).not.toHaveBeenCalled();
  });

  it('does not inherit retired DSH LAN settings', async () => {
    const { HermesMobileGatewayService } = await import('../src/main/services/hermesMobileGateway.js');
    const db = {
      getSetting: vi.fn((key: string, fallback: unknown) => key === 'dsh:lan:gateway' ? {
        enabled: true,
        config: { bindHost: '192.168.1.20', port: 18766, publicHost: '192.168.1.20', publicPort: 18766 }
      } : fallback),
      setSetting: vi.fn(),
      audit: vi.fn()
    } as never;
    const services = { getStatus: vi.fn(), isUiAvailable: vi.fn() } as never;
    const gateway = new HermesMobileGatewayService(db, services);
    expect(gateway.getProjectStatus('project-1').configured).toBeNull();
    expect(db.setSetting).not.toHaveBeenCalled();
  });
});
