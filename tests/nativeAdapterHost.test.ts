import { describe, expect, it, vi } from 'vitest';
import { NativeAdapterHost } from '../src/main/services/nativeAdapterHost.js';
import { HostPolicyBroker, type HostPolicyAuditEvent } from '../src/main/services/hostPolicyBroker.js';
import { resolveBuiltinHostPolicy } from '../src/main/services/hostPluginPolicy.js';
import type { EnvironmentComponentView, NativeAdapterMode } from '../src/shared/types.js';

function policy(audits: HostPolicyAuditEvent[] = []) {
  return new HostPolicyBroker({
    resolve: resolveBuiltinHostPolicy,
    audit: (event) => audits.push(event)
  }).scopeRuntime({ organizationId: 'org-local', runtimeId: 'native-host', agentId: 'agent-1' });
}

function diagnostic(mode: NativeAdapterMode, path: string | null = null): EnvironmentComponentView {
  return {
    id: 'media-accelerator',
    name: 'Media accelerator',
    kind: 'native-addon',
    source: mode === 'native-worker' ? 'declared' : 'fallback',
    available: true,
    ready: true,
    required: false,
    version: null,
    path,
    reason: null,
    selectedAdapter: mode,
    executionBoundary: mode === 'native-worker' ? 'utility-process' : 'worker-thread'
  };
}

describe('NativeAdapterHost', () => {
  it('keeps DLL/SO paths inside an injected utility-process transport', async () => {
    const invoke = vi.fn(async (request: { nativePath?: string; input: unknown }) => ({ ok: true, input: request.input }));
    const audits: HostPolicyAuditEvent[] = [];
    const host = new NativeAdapterHost(policy(audits));
    host.register({
      id: 'media-accelerator',
      operations: ['transcode'],
      diagnostic: diagnostic('native-worker', 'C:\\trusted\\media.dll'),
      transports: { 'native-worker': { boundary: 'utility-process', invoke } }
    });
    const input = { sourceRef: 'artifact-one' };
    await expect(host.invoke('media-accelerator', 'transcode', input)).resolves.toEqual({ ok: true, input });
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      adapterId: 'media-accelerator', mode: 'native-worker', nativePath: 'C:\\trusted\\media.dll'
    }), expect.any(AbortSignal));
    expect(host.list()).toEqual([{ id: 'media-accelerator', mode: 'native-worker', boundary: 'utility-process', operations: ['transcode'] }]);
    expect(audits).toEqual([expect.objectContaining({
      action: 'policy.decision', capability: 'process.exec', result: 'allow',
      reasonCode: 'registered_native_adapter'
    })]);
  });

  it('uses WASM/JS only through worker threads and rejects boundary mismatches', async () => {
    const host = new NativeAdapterHost(policy());
    expect(() => host.register({
      id: 'media-accelerator',
      operations: ['inspect'],
      diagnostic: diagnostic('wasm-worker'),
      transports: { 'wasm-worker': { boundary: 'utility-process', invoke: vi.fn() } }
    })).toThrow(/boundary/);

    const invoke = vi.fn(async (request: { nativePath?: string }) => ({ hasNativePath: 'nativePath' in request }));
    host.register({
      id: 'media-accelerator',
      operations: ['inspect'],
      diagnostic: diagnostic('wasm-worker'),
      transports: { 'wasm-worker': { boundary: 'worker-thread', invoke } }
    });
    await expect(host.invoke('media-accelerator', 'inspect', { ref: 'artifact-one' })).resolves.toEqual({ hasNativePath: false });
    expect(() => host.register({
      id: 'media-accelerator', operations: ['inspect'], diagnostic: diagnostic('wasm-worker'), transports: {}
    })).toThrow(/already exists/);
    await expect(host.invoke('media-accelerator', 'delete', {})).rejects.toMatchObject({ code: 'OPERATION_NOT_ALLOWED' });
  });

  it('bounds serialized payloads and honors cancellation before transport execution', async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const host = new NativeAdapterHost(policy());
    host.register({
      id: 'media-accelerator', operations: ['inspect'], diagnostic: diagnostic('js-worker'),
      transports: { 'js-worker': { boundary: 'worker-thread', invoke } }
    });
    await expect(host.invoke('media-accelerator', 'inspect', { payload: 'x'.repeat(4 * 1024 * 1024 + 1) }))
      .rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(host.invoke('media-accelerator', 'inspect', {}, controller.signal)).rejects.toThrow('cancelled');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fails closed before transport when policy is unavailable or denies', async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const registration = {
      id: 'media-accelerator', operations: ['inspect'], diagnostic: diagnostic('js-worker'),
      transports: { 'js-worker': { boundary: 'worker-thread' as const, invoke } }
    };
    const noPolicy = new NativeAdapterHost();
    noPolicy.register(registration);
    await expect(noPolicy.invoke('media-accelerator', 'inspect', {}))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' });

    const deniedPolicy = new HostPolicyBroker({
      resolve: async () => ({ effect: 'deny', reasonCode: 'profile_denied' })
    }).scopeRuntime({ organizationId: 'org-local', runtimeId: 'native-host', agentId: 'agent-1' });
    const denied = new NativeAdapterHost(deniedPolicy);
    denied.register(registration);
    await expect(denied.invoke('media-accelerator', 'inspect', {}))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(invoke).not.toHaveBeenCalled();
  });
});
