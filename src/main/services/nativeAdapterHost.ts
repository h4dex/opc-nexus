/**
 * Dispatch boundary for optional DLL/SO, WASM and pure-JS accelerators.
 *
 * This host never imports or dlopens a native module. A concrete transport is
 * owned by an Electron utility process or Node worker thread and is injected
 * by Main after EnvironmentDiagnostics has selected a compatible mode.
 */
import { randomUUID } from 'node:crypto';
import type { EnvironmentComponentView, NativeAdapterMode } from '../../shared/types.js';
import type { DshScopedPolicyBroker } from './dshPolicyBroker.js';

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const MAX_OPERATIONS = 64;
const MAX_SERIALIZED_BYTES = 4 * 1024 * 1024;

export interface NativeAdapterWorkerRequest {
  adapterId: string;
  operation: string;
  mode: NativeAdapterMode;
  /** Main-only path. It is present only for native-worker utility processes. */
  nativePath?: string;
  input: unknown;
}

export interface NativeAdapterTransport {
  readonly boundary: 'utility-process' | 'worker-thread';
  invoke(request: Readonly<NativeAdapterWorkerRequest>, signal: AbortSignal): unknown | Promise<unknown>;
}

export interface NativeAdapterRegistration {
  id: string;
  operations: string[];
  diagnostic: EnvironmentComponentView;
  transports: Partial<Record<NativeAdapterMode, NativeAdapterTransport>>;
}

export type NativeAdapterHostErrorCode =
  | 'INVALID_ADAPTER'
  | 'DUPLICATE_ADAPTER'
  | 'ADAPTER_NOT_FOUND'
  | 'ADAPTER_NOT_READY'
  | 'OPERATION_NOT_ALLOWED'
  | 'PAYLOAD_TOO_LARGE'
  | 'POLICY_DENIED'
  | 'TRANSPORT_FAILED';

export class NativeAdapterHostError extends Error {
  constructor(readonly code: NativeAdapterHostErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NativeAdapterHostError';
  }
}

interface RegisteredNativeAdapter {
  id: string;
  operations: ReadonlySet<string>;
  diagnostic: Readonly<EnvironmentComponentView>;
  transport: NativeAdapterTransport;
  mode: NativeAdapterMode;
}

function assertIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new NativeAdapterHostError('INVALID_ADAPTER', `${field} is invalid`);
  return value;
}

function cloneBounded(value: unknown, field: string): unknown {
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { throw new NativeAdapterHostError('INVALID_ADAPTER', `${field} is not serializable`); }
  if (serialized === undefined) throw new NativeAdapterHostError('INVALID_ADAPTER', `${field} is not serializable`);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SERIALIZED_BYTES) {
    throw new NativeAdapterHostError('PAYLOAD_TOO_LARGE', `${field} exceeds the native adapter limit`);
  }
  try { return JSON.parse(serialized) as unknown; } catch { throw new NativeAdapterHostError('INVALID_ADAPTER', `${field} is invalid`); }
}

function expectedBoundary(mode: NativeAdapterMode): NativeAdapterTransport['boundary'] {
  return mode === 'native-worker' ? 'utility-process' : 'worker-thread';
}

export class NativeAdapterHost {
  private readonly adapters = new Map<string, RegisteredNativeAdapter>();

  constructor(private readonly policy?: DshScopedPolicyBroker) {}

  register(input: NativeAdapterRegistration): void {
    const id = assertIdentifier(input.id, 'adapter id');
    if (this.adapters.has(id)) throw new NativeAdapterHostError('DUPLICATE_ADAPTER', `Native adapter already exists: ${id}`);
    if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > MAX_OPERATIONS) {
      throw new NativeAdapterHostError('INVALID_ADAPTER', 'Native adapter operations are invalid');
    }
    const operations = new Set(input.operations.map((operation) => assertIdentifier(operation, 'operation')));
    if (operations.size !== input.operations.length) throw new NativeAdapterHostError('INVALID_ADAPTER', 'Native adapter operations must be unique');
    const diagnostic = input.diagnostic;
    if (!diagnostic || diagnostic.id !== id || diagnostic.kind !== 'native-addon' || !diagnostic.ready || !diagnostic.selectedAdapter) {
      throw new NativeAdapterHostError('ADAPTER_NOT_READY', `Native adapter is not ready: ${id}`);
    }
    const mode = diagnostic.selectedAdapter;
    const transport = input.transports[mode];
    if (!transport || transport.boundary !== expectedBoundary(mode) || diagnostic.executionBoundary !== transport.boundary) {
      throw new NativeAdapterHostError('INVALID_ADAPTER', `Native adapter transport boundary is invalid: ${id}`);
    }
    if ((mode === 'native-worker') !== (typeof diagnostic.path === 'string' && diagnostic.path.length > 0)) {
      throw new NativeAdapterHostError('INVALID_ADAPTER', `Native adapter path does not match selected mode: ${id}`);
    }
    this.adapters.set(id, Object.freeze({
      id,
      operations,
      diagnostic: Object.freeze({ ...diagnostic }),
      transport,
      mode
    }));
  }

  unregister(id: string): boolean {
    return this.adapters.delete(id);
  }

  list(): Array<{ id: string; mode: NativeAdapterMode; boundary: NativeAdapterTransport['boundary']; operations: string[] }> {
    return [...this.adapters.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((adapter) => ({ id: adapter.id, mode: adapter.mode, boundary: adapter.transport.boundary, operations: [...adapter.operations].sort() }));
  }

  async invoke(id: string, operation: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const adapter = this.adapters.get(assertIdentifier(id, 'adapter id'));
    if (!adapter) throw new NativeAdapterHostError('ADAPTER_NOT_FOUND', `Native adapter not found: ${id}`);
    const normalizedOperation = assertIdentifier(operation, 'operation');
    if (!adapter.operations.has(normalizedOperation)) {
      throw new NativeAdapterHostError('OPERATION_NOT_ALLOWED', `Native adapter operation is not allowed: ${normalizedOperation}`);
    }
    const invocationSignal = signal ?? new AbortController().signal;
    if (invocationSignal.aborted) throw invocationSignal.reason instanceof Error ? invocationSignal.reason : new Error('Native adapter invocation aborted');
    if (!this.policy) {
      throw new NativeAdapterHostError('POLICY_DENIED', 'Native adapter policy is unavailable');
    }
    const decision = await this.policy.decide({
      requestId: randomUUID(),
      capability: 'process.exec',
      target: `native-adapter:${adapter.id}/${normalizedOperation}`,
      operation: 'native-adapter.invoke',
      context: {
        boundary: 'native-adapter',
        registered: true,
        adapterId: adapter.id,
        adapterMode: adapter.mode,
        operation: normalizedOperation
      }
    });
    if (decision.effect !== 'allow') {
      throw new NativeAdapterHostError(
        'POLICY_DENIED',
        `Native adapter policy denied ${adapter.id}/${normalizedOperation}: ${decision.reasonCode}`
      );
    }
    if (invocationSignal.aborted) throw invocationSignal.reason instanceof Error ? invocationSignal.reason : new Error('Native adapter invocation aborted');
    const request: NativeAdapterWorkerRequest = {
      adapterId: adapter.id,
      operation: normalizedOperation,
      mode: adapter.mode,
      ...(adapter.mode === 'native-worker' ? { nativePath: adapter.diagnostic.path! } : {}),
      input: cloneBounded(input, 'input')
    };
    try {
      const result = await adapter.transport.invoke(Object.freeze(request), invocationSignal);
      return cloneBounded(result, 'result');
    } catch (error) {
      if (error instanceof NativeAdapterHostError) throw error;
      if (invocationSignal.aborted) throw invocationSignal.reason instanceof Error ? invocationSignal.reason : error;
      throw new NativeAdapterHostError('TRANSPORT_FAILED', `Native adapter failed: ${adapter.id}`, { cause: error });
    }
  }
}
