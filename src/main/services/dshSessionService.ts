import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  DshControlLeaseView,
  DshControlMode,
  DshControlStatusView,
  DshControlSurface,
  DshEventPage,
  DshEventView,
  DshLeaseController,
  DshReadEventsInput
} from '../../shared/types.js';
import type { Database } from './database.js';

const DEFAULT_LEASE_TTL_MS = 30_000;
const MIN_LEASE_TTL_MS = 5_000;
const MAX_LEASE_TTL_MS = 5 * 60_000;
const MAX_EVENT_PAYLOAD_BYTES = 1024 * 1024;
const MAX_COMMAND_PAYLOAD_BYTES = 256 * 1024;
const MAX_EVENT_READ_LIMIT = 200;
const SENSITIVE_PAYLOAD_KEY = /api.?key|access.?token|auth(?:orization)?|cookie|credential|lease.?token|pass(?:word|phrase)|private.?key|secret/i;

type Row = Record<string, unknown>;

export class DshRevisionConflictError extends Error {
  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`DSH session revision conflict: expected ${expectedRevision}, current ${actualRevision}`);
    this.name = 'DshRevisionConflictError';
  }
}

export class DshLeaseHeldError extends Error {
  constructor(readonly lease: DshControlLeaseView) {
    super(`DSH session is controlled by ${lease.controller} on ${lease.surface}`);
    this.name = 'DshLeaseHeldError';
  }
}

export class DshTakeoverConfirmationRequiredError extends Error {
  constructor(readonly status: DshControlStatusView) {
    super('DSH takeover requires a trusted turn-boundary confirmation');
    this.name = 'DshTakeoverConfirmationRequiredError';
  }
}

export class DshEventCursorError extends Error {
  constructor(readonly expectedSeq: number, readonly receivedSeq: number) {
    super(`DSH event cursor must be ${expectedSeq}, received ${receivedSeq}`);
    this.name = 'DshEventCursorError';
  }
}

export class DshCommandConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DshCommandConflictError';
  }
}

export interface DshProfileInput {
  id: string;
  engineId: string;
  providerProfile?: string;
  policy?: Record<string, unknown>;
  version: number;
}

export interface DshRuntimeInstanceInput {
  id: string;
  agentId: string;
  profileId: string;
  processState: string;
  endpoint?: string | null;
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  heartbeatAt?: number | null;
  crashCount?: number;
}

export interface DshSessionInput {
  id: string;
  upstreamSessionId: string;
  runtimeInstanceId: string;
  agentId: string;
  conversationId?: string | null;
  parentSessionId?: string | null;
  delegationDepth?: number;
  workspace?: string;
  controlMode: DshControlMode;
}

export interface DshSessionRecord extends DshControlStatusView {
  upstreamSessionId: string;
  runtimeInstanceId: string;
  parentSessionId: string | null;
  delegationDepth: number;
  workspace: string;
  createdAt: number;
  updatedAt: number;
}

export interface DshRunInput {
  id: string;
  sessionId: string;
  nexusTaskId?: string | null;
  teamRunId?: string | null;
  dagNodeId?: string | null;
  commandId?: string | null;
  upstreamState: string;
  checkpointRef?: string | null;
}

export interface DshRunRecord extends DshRunInput {
  eventCursor: number;
  createdAt: number;
  updatedAt: number;
}

export interface DshEventInput {
  sessionId: string;
  seq: number;
  runId?: string | null;
  type: string;
  protocolVersion?: string;
  payload: Record<string, unknown>;
  createdAt?: number;
}

export interface DshEventProjectionResult {
  duplicate: boolean;
  event: DshEventView;
  projectionError: boolean;
}

export interface DshLeaseRequest {
  sessionId: string;
  controller: DshLeaseController;
  surface: DshControlSurface;
  principal: string;
  expectedRevision: number;
  ttlMs?: number;
}

export interface DshTakeoverLeaseRequest extends DshLeaseRequest {
  reason?: string;
}

export interface DshLeaseGrant {
  /** Main-process bearer capability. Never expose this object through preload. */
  token: string;
  status: DshControlStatusView;
}

export interface DshLeaseTokenRequest {
  sessionId: string;
  token: string;
  expectedRevision: number;
  ttlMs?: number;
}

export interface DshTrustedReleaseRequest {
  sessionId: string;
  controller: DshLeaseController;
  surface: DshControlSurface;
  principal: string;
  expectedRevision: number;
}

export interface DshCommandRequest {
  commandId: string;
  sessionId: string;
  runId?: string | null;
  commandType: string;
  principal: string;
  leaseToken: string;
  expectedRevision: number;
  payload?: Record<string, unknown>;
}

export type DshCommandReceiptStatus = 'ACCEPTED' | 'COMPLETED' | 'FAILED';

export interface DshCommandReceipt {
  commandId: string;
  sessionId: string;
  runId: string | null;
  commandType: string;
  expectedRevision: number;
  appliedRevision: number;
  principal: string;
  status: DshCommandReceiptStatus;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: number;
  completedAt: number | null;
}

export interface DshCommandClaim {
  duplicate: boolean;
  receipt: DshCommandReceipt;
}

export interface DshTakeoverContext {
  requested: Omit<DshTakeoverLeaseRequest, 'ttlMs'>;
  current: DshControlStatusView;
}

export interface DshSessionServiceOptions {
  now?: () => number;
  authorizeTakeover?: (context: DshTakeoverContext) => boolean | Promise<boolean>;
  /** Called only after the immutable event and cursor have committed. */
  onEventProjected?: (event: DshEventView) => void | Promise<void>;
  onProjectionError?: (event: DshEventView, error: unknown) => void | Promise<void>;
}

function assertText(value: unknown, name: string, max = 200, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function assertNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${name} must be a non-negative integer`);
  return value as number;
}

function assertPositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${name} must be a positive integer`);
  return value as number;
}

function assertCursor(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < -1) throw new Error(`${name} must be an integer >= -1`);
  return value as number;
}

function canonicalize(value: unknown, seen = new Set<object>(), depth = 0): unknown {
  if (depth > 24) throw new Error('JSON payload nesting is too deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JSON payload contains a non-finite number');
    return value;
  }
  if (typeof value !== 'object') throw new Error('JSON payload contains an unsupported value');
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('JSON payload must contain plain objects');
  }
  if (seen.has(value)) throw new Error('JSON payload contains a cycle');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen, depth + 1));
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) throw new Error('JSON payload contains undefined');
      output[key] = canonicalize(record[key], seen, depth + 1);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function canonicalJson(value: unknown, maxBytes: number): string {
  const encoded = JSON.stringify(canonicalize(value));
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) throw new Error('JSON payload is too large');
  return encoded;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function rendererSafeValue(value: unknown, depth = 0): unknown {
  if (depth >= 8) return '[TRUNCATED]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    const bounded = value.length <= 16_000 ? value : `${value.slice(0, 16_000)}...[TRUNCATED]`;
    return bounded
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
      .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?)[^\s"',;]{4,}/gi, '$1[REDACTED]');
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => rendererSafeValue(item, depth + 1));
  if (!value || typeof value !== 'object') return String(value);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    output[key] = SENSITIVE_PAYLOAD_KEY.test(key) ? '[REDACTED]' : rendererSafeValue(item, depth + 1);
  }
  return output;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function tokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function rowText(row: Row, key: string): string {
  return String(row[key] ?? '');
}

function rowNullableText(row: Row, key: string): string | null {
  return row[key] === null || row[key] === undefined ? null : String(row[key]);
}

function rowNumber(row: Row, key: string): number {
  return Number(row[key] ?? 0);
}

/** Durable DSH facts and single-writer control. This service never mutates Nexus TaskStatus. */
export class DshSessionService {
  private readonly now: () => number;
  private readonly authorizeTakeover?: DshSessionServiceOptions['authorizeTakeover'];
  private readonly onEventProjected?: DshSessionServiceOptions['onEventProjected'];
  private readonly onProjectionError?: DshSessionServiceOptions['onProjectionError'];

  constructor(private readonly db: Database, options: DshSessionServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.authorizeTakeover = options.authorizeTakeover;
    this.onEventProjected = options.onEventProjected;
    this.onProjectionError = options.onProjectionError;
  }

  upsertProfile(input: DshProfileInput): void {
    const id = assertText(input.id, 'profileId');
    const engineId = assertText(input.engineId, 'engineId');
    const providerProfile = assertText(input.providerProfile ?? '', 'providerProfile', 500, true);
    const policyJson = canonicalJson(input.policy ?? {}, MAX_COMMAND_PAYLOAD_BYTES);
    const version = assertPositiveInteger(input.version, 'version');
    const now = this.now();
    const existing = this.db.raw.prepare('SELECT engine_id FROM dsh_profiles WHERE id = ?').get(id) as Row | undefined;
    if (existing && rowText(existing, 'engine_id') !== engineId) throw new Error('DSH profile engine identity is immutable');
    this.db.raw.prepare(`
      INSERT INTO dsh_profiles(id, engine_id, provider_profile, policy_json, version, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        provider_profile = excluded.provider_profile,
        policy_json = excluded.policy_json,
        version = excluded.version,
        updated_at = excluded.updated_at
    `).run(id, engineId, providerProfile, policyJson, version, now, now);
  }

  upsertRuntimeInstance(input: DshRuntimeInstanceInput): void {
    const id = assertText(input.id, 'runtimeInstanceId');
    const agentId = assertText(input.agentId, 'agentId');
    const profileId = assertText(input.profileId, 'profileId');
    const processState = assertText(input.processState, 'processState', 80);
    const endpoint = input.endpoint === null || input.endpoint === undefined
      ? null
      : assertText(input.endpoint, 'endpoint', 2048);
    const protocolVersion = assertText(input.protocolVersion ?? '', 'protocolVersion', 100, true);
    const capabilitiesJson = canonicalJson(input.capabilities ?? {}, MAX_COMMAND_PAYLOAD_BYTES);
    const heartbeatAt = input.heartbeatAt === null || input.heartbeatAt === undefined
      ? null
      : assertNonNegativeInteger(input.heartbeatAt, 'heartbeatAt');
    const crashCount = assertNonNegativeInteger(input.crashCount ?? 0, 'crashCount');
    const now = this.now();
    const ownership = this.db.raw.prepare(`
      SELECT a.engine_id AS agent_engine_id, p.engine_id AS profile_engine_id
      FROM agents a
      JOIN dsh_profiles p ON p.id = ?
      WHERE a.id = ?
    `).get(profileId, agentId) as Row | undefined;
    if (!ownership) throw new Error('DSH runtime agent or profile does not exist');
    if (rowText(ownership, 'agent_engine_id') !== rowText(ownership, 'profile_engine_id')) {
      throw new Error('DSH runtime agent and profile must use the same engine');
    }
    const existing = this.db.raw.prepare('SELECT agent_id, profile_id FROM dsh_runtime_instances WHERE id = ?').get(id) as Row | undefined;
    if (existing && (rowText(existing, 'agent_id') !== agentId || rowText(existing, 'profile_id') !== profileId)) {
      throw new Error('DSH runtime ownership is immutable');
    }
    this.db.raw.prepare(`
      INSERT INTO dsh_runtime_instances(
        id, agent_id, profile_id, process_state, endpoint, protocol_version,
        capabilities_json, heartbeat_at, crash_count, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        process_state = excluded.process_state,
        endpoint = excluded.endpoint,
        protocol_version = excluded.protocol_version,
        capabilities_json = excluded.capabilities_json,
        heartbeat_at = excluded.heartbeat_at,
        crash_count = excluded.crash_count,
        updated_at = excluded.updated_at
    `).run(id, agentId, profileId, processState, endpoint, protocolVersion, capabilitiesJson, heartbeatAt, crashCount, now, now);
  }

  upsertSession(input: DshSessionInput): DshSessionRecord {
    const id = assertText(input.id, 'sessionId');
    const upstreamSessionId = assertText(input.upstreamSessionId, 'upstreamSessionId', 500);
    const runtimeInstanceId = assertText(input.runtimeInstanceId, 'runtimeInstanceId');
    const agentId = assertText(input.agentId, 'agentId');
    const conversationId = input.conversationId ? assertText(input.conversationId, 'conversationId') : null;
    const parentSessionId = input.parentSessionId ? assertText(input.parentSessionId, 'parentSessionId') : null;
    const delegationDepth = assertNonNegativeInteger(input.delegationDepth ?? 0, 'delegationDepth');
    const workspace = assertText(input.workspace ?? '', 'workspace', 4096, true);
    this.assertControlMode(input.controlMode);
    const now = this.now();
    const runtime = this.db.raw.prepare(`
      SELECT r.agent_id, a.organization_id
      FROM dsh_runtime_instances r
      JOIN agents a ON a.id = r.agent_id
      WHERE r.id = ?
    `).get(runtimeInstanceId) as Row | undefined;
    if (!runtime) throw new Error('DSH runtime instance does not exist');
    if (rowText(runtime, 'agent_id') !== agentId) throw new Error('DSH session runtime belongs to another employee');

    if (conversationId) {
      const conversation = this.db.raw.prepare('SELECT organization_id FROM conversations WHERE id = ?')
        .get(conversationId) as Row | undefined;
      if (!conversation) throw new Error('DSH session conversation does not exist');
      if (rowText(conversation, 'organization_id') !== rowText(runtime, 'organization_id')) {
        throw new Error('DSH session conversation crosses the employee organization boundary');
      }
    }

    let parent: Row | undefined;
    if (parentSessionId) {
      if (parentSessionId === id) throw new Error('DSH session cannot be its own parent');
      parent = this.db.raw.prepare(`
        SELECT runtime_instance_id, agent_id, conversation_id, delegation_depth
        FROM dsh_sessions WHERE id = ?
      `).get(parentSessionId) as Row | undefined;
      if (!parent) throw new Error('DSH parent session does not exist');
      if (rowText(parent, 'runtime_instance_id') !== runtimeInstanceId || rowText(parent, 'agent_id') !== agentId) {
        throw new Error('DSH child session must remain inside its parent runtime and employee');
      }
      if (delegationDepth !== rowNumber(parent, 'delegation_depth') + 1) {
        throw new Error('DSH child session delegation depth must be exactly parent depth plus one');
      }
      const parentConversationId = rowNullableText(parent, 'conversation_id');
      if (conversationId && parentConversationId && conversationId !== parentConversationId) {
        throw new Error('DSH child session cannot cross its parent conversation');
      }
    } else if (delegationDepth !== 0) {
      throw new Error('DSH root session delegation depth must be zero');
    }
    const existing = this.db.raw.prepare(`
      SELECT upstream_session_id, runtime_instance_id, agent_id, parent_session_id, delegation_depth
      FROM dsh_sessions WHERE id = ?
    `).get(id) as Row | undefined;
    if (existing && (
      rowText(existing, 'upstream_session_id') !== upstreamSessionId
      || rowText(existing, 'runtime_instance_id') !== runtimeInstanceId
      || rowText(existing, 'agent_id') !== agentId
      || rowNullableText(existing, 'parent_session_id') !== parentSessionId
      || rowNumber(existing, 'delegation_depth') !== delegationDepth
    )) throw new Error('DSH session identity and ownership are immutable');

    this.db.raw.prepare(`
      INSERT INTO dsh_sessions(
        id, upstream_session_id, runtime_instance_id, agent_id, conversation_id,
        parent_session_id, delegation_depth, workspace, control_mode, revision,
        last_event_cursor, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0, -1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        workspace = excluded.workspace,
        updated_at = excluded.updated_at
    `).run(
      id, upstreamSessionId, runtimeInstanceId, agentId, conversationId,
      parentSessionId, delegationDepth, workspace, input.controlMode, now, now
    );
    return this.getSession(id);
  }

  getSession(sessionId: string): DshSessionRecord {
    const id = assertText(sessionId, 'sessionId');
    this.expireLease(id);
    const row = this.requireSessionRow(id);
    return {
      ...this.controlStatusFromRows(row, this.leaseRow(id)),
      upstreamSessionId: rowText(row, 'upstream_session_id'),
      runtimeInstanceId: rowText(row, 'runtime_instance_id'),
      parentSessionId: rowNullableText(row, 'parent_session_id'),
      delegationDepth: rowNumber(row, 'delegation_depth'),
      workspace: rowText(row, 'workspace'),
      createdAt: rowNumber(row, 'created_at'),
      updatedAt: rowNumber(row, 'updated_at')
    };
  }

  /** Return a durable session when an executor is reattaching after a restart. */
  findSession(sessionId: string): DshSessionRecord | null {
    try {
      return this.getSession(sessionId);
    } catch (error) {
      if (error instanceof Error && error.message === 'DSH session does not exist') return null;
      throw error;
    }
  }

  /**
   * Resolve the Nexus projection for an upstream browser-visible session.
   * Agent scope is mandatory because two managed runtimes may legally reuse
   * the same upstream session id. This lookup never creates a projection.
   */
  findSessionByUpstream(agentId: string, upstreamSessionId: string): DshSessionRecord | null {
    const owner = assertText(agentId, 'agentId');
    const upstream = assertText(upstreamSessionId, 'upstreamSessionId', 500);
    const rows = this.db.raw.prepare(`
      SELECT id FROM dsh_sessions
      WHERE agent_id = ? AND upstream_session_id = ?
      ORDER BY updated_at DESC LIMIT 2
    `).all(owner, upstream) as Row[];
    if (rows.length === 0) return null;
    if (rows.length > 1) throw new Error('DSH upstream session projection is ambiguous');
    return this.getSession(rowText(rows[0]!, 'id'));
  }

  upsertRun(input: DshRunInput): DshRunRecord {
    const id = assertText(input.id, 'runId');
    const sessionId = assertText(input.sessionId, 'sessionId');
    const nexusTaskId = input.nexusTaskId ? assertText(input.nexusTaskId, 'nexusTaskId') : null;
    const teamRunId = input.teamRunId ? assertText(input.teamRunId, 'teamRunId') : null;
    const dagNodeId = input.dagNodeId ? assertText(input.dagNodeId, 'dagNodeId', 500) : null;
    const commandId = input.commandId ? assertText(input.commandId, 'commandId') : null;
    const upstreamState = assertText(input.upstreamState, 'upstreamState', 100);
    const checkpointRef = input.checkpointRef ? assertText(input.checkpointRef, 'checkpointRef', 2048) : null;
    const now = this.now();
    const existing = this.db.raw.prepare('SELECT session_id FROM dsh_runs WHERE id = ?').get(id) as Row | undefined;
    if (existing && rowText(existing, 'session_id') !== sessionId) throw new Error('DSH run session is immutable');
    this.db.raw.prepare(`
      INSERT INTO dsh_runs(
        id, session_id, nexus_task_id, team_run_id, dag_node_id, command_id,
        upstream_state, event_cursor, checkpoint_ref, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, -1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        nexus_task_id = COALESCE(excluded.nexus_task_id, dsh_runs.nexus_task_id),
        team_run_id = COALESCE(excluded.team_run_id, dsh_runs.team_run_id),
        dag_node_id = COALESCE(excluded.dag_node_id, dsh_runs.dag_node_id),
        command_id = COALESCE(excluded.command_id, dsh_runs.command_id),
        upstream_state = excluded.upstream_state,
        checkpoint_ref = COALESCE(excluded.checkpoint_ref, dsh_runs.checkpoint_ref),
        updated_at = excluded.updated_at
    `).run(id, sessionId, nexusTaskId, teamRunId, dagNodeId, commandId, upstreamState, checkpointRef, now, now);
    return this.getRun(id);
  }

  getRun(runId: string): DshRunRecord {
    const id = assertText(runId, 'runId');
    const row = this.db.raw.prepare('SELECT * FROM dsh_runs WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new Error('DSH run does not exist');
    return {
      id,
      sessionId: rowText(row, 'session_id'),
      nexusTaskId: rowNullableText(row, 'nexus_task_id'),
      teamRunId: rowNullableText(row, 'team_run_id'),
      dagNodeId: rowNullableText(row, 'dag_node_id'),
      commandId: rowNullableText(row, 'command_id'),
      upstreamState: rowText(row, 'upstream_state'),
      checkpointRef: rowNullableText(row, 'checkpoint_ref'),
      eventCursor: rowNumber(row, 'event_cursor'),
      createdAt: rowNumber(row, 'created_at'),
      updatedAt: rowNumber(row, 'updated_at')
    };
  }

  findRun(runId: string): DshRunRecord | null {
    try {
      return this.getRun(runId);
    } catch (error) {
      if (error instanceof Error && error.message === 'DSH run does not exist') return null;
      throw error;
    }
  }

  async projectEvent(input: DshEventInput): Promise<DshEventProjectionResult> {
    const sessionId = assertText(input.sessionId, 'sessionId');
    // rc.6 starts a session stream at seq=0. Keep accepting seq=1 as the
    // legacy first-event form for sessions created by pre-v41 callers.
    const seq = assertNonNegativeInteger(input.seq, 'seq');
    const runId = input.runId ? assertText(input.runId, 'runId') : null;
    const type = assertText(input.type, 'eventType', 200);
    const protocolVersion = assertText(input.protocolVersion ?? '', 'protocolVersion', 100, true);
    const payloadJson = canonicalJson(input.payload, MAX_EVENT_PAYLOAD_BYTES);
    const createdAt = input.createdAt === undefined ? this.now() : assertNonNegativeInteger(input.createdAt, 'createdAt');
    let duplicate = false;
    let event!: DshEventView;

    this.db.transaction(() => {
      const session = this.requireSessionRow(sessionId);
      const existing = this.db.raw.prepare('SELECT * FROM dsh_events WHERE session_id = ? AND seq = ?')
        .get(sessionId, seq) as Row | undefined;
      if (existing) {
        if (
          rowText(existing, 'type') !== type
          || rowText(existing, 'protocol_version') !== protocolVersion
          || rowText(existing, 'payload_json') !== payloadJson
        ) throw new Error('DSH event sequence was reused with different content');
        // Session history outlives an individual Nexus run. Replaying the same
        // immutable event for a later run must preserve its original run_id,
        // while advancing the later run's reconciliation cursor.
        if (runId) {
          this.requireRunForSession(runId, sessionId);
          this.db.raw.prepare(`
            UPDATE dsh_runs SET event_cursor = CASE WHEN event_cursor < ? THEN ? ELSE event_cursor END,
              updated_at = ? WHERE id = ?
          `).run(seq, seq, this.now(), runId);
        }
        duplicate = true;
        event = this.eventFromRow(existing);
        return;
      }
      const cursor = rowNumber(session, 'last_event_cursor');
      const expectedSeq = cursor + 1;
      const legacyFirstEvent = cursor === -1 && seq === 1;
      if (seq !== expectedSeq && !legacyFirstEvent) throw new DshEventCursorError(expectedSeq, seq);
      if (runId) this.requireRunForSession(runId, sessionId);
      this.db.raw.prepare(`
        INSERT INTO dsh_events(session_id, seq, run_id, type, protocol_version, payload_json, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `).run(sessionId, seq, runId, type, protocolVersion, payloadJson, createdAt);
      const changed = this.db.raw.prepare(`
        UPDATE dsh_sessions SET last_event_cursor = ?, updated_at = ?
        WHERE id = ? AND last_event_cursor = ?
      `).run(seq, this.now(), sessionId, legacyFirstEvent ? -1 : seq - 1).changes;
      if (changed !== 1) throw new DshEventCursorError(expectedSeq, seq);
      if (runId) {
        this.db.raw.prepare('UPDATE dsh_runs SET event_cursor = ?, updated_at = ? WHERE id = ?')
          .run(seq, this.now(), runId);
      }
      event = {
        sessionId,
        seq,
        runId,
        type,
        protocolVersion,
        payload: JSON.parse(payloadJson) as Record<string, unknown>,
        createdAt
      };
    });

    let projectionError = false;
    if (!duplicate && this.onEventProjected) {
      try {
        await this.onEventProjected(event);
      } catch (error) {
        projectionError = true;
        try { await this.onProjectionError?.(event, error); } catch { /* diagnostics must not stop DSH */ }
      }
    }
    return { duplicate, event, projectionError };
  }

  readEvents(input: DshReadEventsInput): DshEventPage {
    const sessionId = assertText(input.sessionId, 'sessionId');
    this.requireSessionRow(sessionId);
    const afterCursor = assertCursor(input.afterCursor ?? -1, 'afterCursor');
    const limit = Math.min(assertPositiveInteger(input.limit ?? 100, 'limit'), MAX_EVENT_READ_LIMIT);
    const rows = this.db.raw.prepare(`
      SELECT * FROM dsh_events WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?
    `).all(sessionId, afterCursor, limit) as Row[];
    const events = rows.map((row) => {
      const event = this.eventFromRow(row);
      return { ...event, payload: rendererSafeValue(event.payload) as Record<string, unknown> };
    });
    return { events, nextCursor: events.at(-1)?.seq ?? afterCursor };
  }

  getControlStatus(sessionId: string): DshControlStatusView {
    const id = assertText(sessionId, 'sessionId');
    this.expireLease(id);
    return this.controlStatusFromRows(this.requireSessionRow(id), this.leaseRow(id));
  }

  acquireLease(input: DshLeaseRequest): DshLeaseGrant {
    const request = this.validateLeaseRequest(input);
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    this.db.transaction(() => {
      const session = this.requireSessionRow(request.sessionId);
      this.assertRevision(session, request.expectedRevision);
      const current = this.leaseRow(request.sessionId);
      if (current && rowNumber(current, 'expires_at') > now) throw new DshLeaseHeldError(this.leaseView(current));
      const previousMode = current
        ? rowText(current, 'previous_control_mode') as DshControlMode
        : rowText(session, 'control_mode') as DshControlMode;
      const revision = request.expectedRevision + 1;
      this.casSession(request.sessionId, request.expectedRevision, revision, previousMode, now);
      this.writeLease(request, token, revision, previousMode, now);
      if (current) this.audit(request.principal, 'dsh.control.expire', request.sessionId, 'replaced-expired');
      this.audit(request.principal, 'dsh.control.acquire', request.sessionId, `${request.controller}:${request.surface}`);
    });
    return { token, status: this.getControlStatus(request.sessionId) };
  }

  renewLease(input: DshLeaseTokenRequest): DshLeaseGrant {
    const sessionId = assertText(input.sessionId, 'sessionId');
    const token = assertText(input.token, 'leaseToken', 500);
    const expectedRevision = assertNonNegativeInteger(input.expectedRevision, 'expectedRevision');
    const ttlMs = this.leaseTtl(input.ttlMs);
    const now = this.now();
    this.db.transaction(() => {
      const session = this.requireSessionRow(sessionId);
      this.assertRevision(session, expectedRevision);
      const lease = this.requireActiveLease(sessionId, now);
      if (!tokenMatches(token, rowText(lease, 'token_hash'))) throw new Error('DSH lease token is invalid');
      const revision = expectedRevision + 1;
      this.casSession(sessionId, expectedRevision, revision, rowText(session, 'control_mode') as DshControlMode, now);
      this.db.raw.prepare(`
        UPDATE dsh_control_leases SET expires_at = ?, revision = ?, renewed_at = ? WHERE session_id = ?
      `).run(now + ttlMs, revision, now, sessionId);
      this.audit(rowText(lease, 'principal'), 'dsh.control.renew', sessionId, 'ok');
    });
    return { token, status: this.getControlStatus(sessionId) };
  }

  releaseLease(input: DshLeaseTokenRequest): DshControlStatusView {
    const sessionId = assertText(input.sessionId, 'sessionId');
    const token = assertText(input.token, 'leaseToken', 500);
    const expectedRevision = assertNonNegativeInteger(input.expectedRevision, 'expectedRevision');
    const now = this.now();
    this.db.transaction(() => {
      const session = this.requireSessionRow(sessionId);
      this.assertRevision(session, expectedRevision);
      const lease = this.requireActiveLease(sessionId, now);
      if (!tokenMatches(token, rowText(lease, 'token_hash'))) throw new Error('DSH lease token is invalid');
      this.releaseLeaseRow(session, lease, expectedRevision, now, rowText(lease, 'principal'), 'release');
    });
    return this.getControlStatus(sessionId);
  }

  async takeoverLease(input: DshTakeoverLeaseRequest): Promise<DshLeaseGrant> {
    const request = this.validateLeaseRequest(input);
    const reason = input.reason === undefined ? undefined : assertText(input.reason, 'reason', 1000, true);
    const currentStatus = this.getControlStatus(request.sessionId);
    if (currentStatus.revision !== request.expectedRevision) {
      throw new DshRevisionConflictError(request.expectedRevision, currentStatus.revision);
    }
    const current = currentStatus.lease;
    const sameOwner = current
      && current.controller === request.controller
      && current.surface === request.surface
      && current.principal === request.principal;
    if (current && !sameOwner) {
      if (!this.authorizeTakeover) throw new DshTakeoverConfirmationRequiredError(currentStatus);
      const authorized = await this.authorizeTakeover({
        requested: { ...request, reason },
        current: currentStatus
      });
      if (!authorized) throw new DshTakeoverConfirmationRequiredError(currentStatus);
    }

    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    this.db.transaction(() => {
      const session = this.requireSessionRow(request.sessionId);
      this.assertRevision(session, request.expectedRevision);
      const lease = this.leaseRow(request.sessionId);
      const active = lease && rowNumber(lease, 'expires_at') > now ? lease : null;
      if (active && !sameOwner && (
        rowText(active, 'controller') !== current?.controller
        || rowText(active, 'surface') !== current?.surface
        || rowText(active, 'principal') !== current?.principal
        || rowNumber(active, 'revision') !== current?.revision
      )) throw new DshRevisionConflictError(request.expectedRevision, rowNumber(session, 'revision'));
      const previousMode = lease
        ? rowText(lease, 'previous_control_mode') as DshControlMode
        : rowText(session, 'control_mode') as DshControlMode;
      const revision = request.expectedRevision + 1;
      this.casSession(request.sessionId, request.expectedRevision, revision, 'TAKEOVER', now);
      this.writeLease(request, token, revision, previousMode, now);
      this.audit(request.principal, 'dsh.control.takeover', request.sessionId, reason || `${request.controller}:${request.surface}`);
    });
    return { token, status: this.getControlStatus(request.sessionId) };
  }

  releaseLeaseForPrincipal(input: DshTrustedReleaseRequest): DshControlStatusView {
    const request = this.validateLeaseRequest(input);
    const now = this.now();
    this.db.transaction(() => {
      const session = this.requireSessionRow(request.sessionId);
      this.assertRevision(session, request.expectedRevision);
      const lease = this.requireActiveLease(request.sessionId, now);
      if (
        rowText(lease, 'controller') !== request.controller
        || rowText(lease, 'surface') !== request.surface
        || rowText(lease, 'principal') !== request.principal
      ) throw new Error('DSH control lease is owned by another principal');
      this.releaseLeaseRow(session, lease, request.expectedRevision, now, request.principal, 'release');
    });
    return this.getControlStatus(request.sessionId);
  }

  claimCommand(input: DshCommandRequest): DshCommandClaim {
    const commandId = assertText(input.commandId, 'commandId');
    const sessionId = assertText(input.sessionId, 'sessionId');
    const runId = input.runId ? assertText(input.runId, 'runId') : null;
    const commandType = assertText(input.commandType, 'commandType', 200);
    const principal = assertText(input.principal, 'principal', 200);
    const leaseToken = assertText(input.leaseToken, 'leaseToken', 500);
    const expectedRevision = assertNonNegativeInteger(input.expectedRevision, 'expectedRevision');
    const requestJson = canonicalJson(input.payload ?? {}, MAX_COMMAND_PAYLOAD_BYTES);
    const requestHash = createHash('sha256').update(requestJson, 'utf8').digest('hex');
    let duplicate = false;
    let receipt!: DshCommandReceipt;
    const now = this.now();

    this.db.transaction(() => {
      const existing = this.db.raw.prepare('SELECT * FROM dsh_command_receipts WHERE command_id = ?').get(commandId) as Row | undefined;
      if (existing) {
        if (
          rowText(existing, 'session_id') !== sessionId
          || rowNullableText(existing, 'run_id') !== runId
          || rowText(existing, 'command_type') !== commandType
          || rowText(existing, 'request_hash') !== requestHash
          || rowNumber(existing, 'expected_revision') !== expectedRevision
          || rowText(existing, 'principal') !== principal
        ) throw new DshCommandConflictError('DSH commandId was reused with a different request');
        duplicate = true;
        receipt = this.receiptFromRow(existing);
        return;
      }
      const unresolved = this.db.raw.prepare(`
        SELECT command_id FROM dsh_command_receipts
        WHERE session_id = ? AND status = 'ACCEPTED'
        ORDER BY created_at ASC LIMIT 1
      `).get(sessionId) as Row | undefined;
      if (unresolved) {
        throw new DshCommandConflictError(
          `DSH session has an unresolved command receipt (${rowText(unresolved, 'command_id')}); reconciliation is required`
        );
      }
      const session = this.requireSessionRow(sessionId);
      this.assertRevision(session, expectedRevision);
      const lease = this.requireActiveLease(sessionId, now);
      if (rowText(lease, 'principal') !== principal || !tokenMatches(leaseToken, rowText(lease, 'token_hash'))) {
        throw new Error('DSH command does not hold the active control lease');
      }
      if (runId) this.requireRunForSession(runId, sessionId);
      const appliedRevision = expectedRevision + 1;
      this.casSession(sessionId, expectedRevision, appliedRevision, rowText(session, 'control_mode') as DshControlMode, now);
      this.db.raw.prepare('UPDATE dsh_control_leases SET revision = ? WHERE session_id = ?')
        .run(appliedRevision, sessionId);
      this.db.raw.prepare(`
        INSERT INTO dsh_command_receipts(
          command_id, session_id, run_id, command_type, request_hash, expected_revision,
          applied_revision, principal, status, result_json, error, created_at, completed_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'ACCEPTED', NULL, NULL, ?, NULL)
      `).run(commandId, sessionId, runId, commandType, requestHash, expectedRevision, appliedRevision, principal, now);
      receipt = this.receiptFromRow(this.db.raw.prepare('SELECT * FROM dsh_command_receipts WHERE command_id = ?').get(commandId) as Row);
      this.audit(principal, 'dsh.command.accept', commandId, commandType);
    });
    return { duplicate, receipt };
  }

  completeCommand(commandId: string, result: Record<string, unknown>): DshCommandReceipt {
    const id = assertText(commandId, 'commandId');
    const resultJson = canonicalJson(result, MAX_COMMAND_PAYLOAD_BYTES);
    const now = this.now();
    this.db.transaction(() => {
      const existing = this.requireReceiptRow(id);
      const status = rowText(existing, 'status');
      if (status === 'COMPLETED') {
        if (rowNullableText(existing, 'result_json') !== resultJson) throw new DshCommandConflictError('DSH command completion changed');
        return;
      }
      if (status !== 'ACCEPTED') throw new DshCommandConflictError(`DSH command is already ${status}`);
      this.db.raw.prepare(`
        UPDATE dsh_command_receipts
        SET status = 'COMPLETED', result_json = ?, completed_at = ? WHERE command_id = ? AND status = 'ACCEPTED'
      `).run(resultJson, now, id);
    });
    return this.getCommandReceipt(id);
  }

  failCommand(commandId: string, error: string): DshCommandReceipt {
    const id = assertText(commandId, 'commandId');
    const safeError = assertText(error, 'error', 4000);
    const now = this.now();
    this.db.transaction(() => {
      const existing = this.requireReceiptRow(id);
      const status = rowText(existing, 'status');
      if (status === 'FAILED') {
        if (rowNullableText(existing, 'error') !== safeError) throw new DshCommandConflictError('DSH command failure changed');
        return;
      }
      if (status !== 'ACCEPTED') throw new DshCommandConflictError(`DSH command is already ${status}`);
      this.db.raw.prepare(`
        UPDATE dsh_command_receipts
        SET status = 'FAILED', error = ?, completed_at = ? WHERE command_id = ? AND status = 'ACCEPTED'
      `).run(safeError, now, id);
    });
    return this.getCommandReceipt(id);
  }

  getCommandReceipt(commandId: string): DshCommandReceipt {
    return this.receiptFromRow(this.requireReceiptRow(assertText(commandId, 'commandId')));
  }

  findCommandReceipt(commandId: string): DshCommandReceipt | null {
    try {
      return this.getCommandReceipt(commandId);
    } catch (error) {
      if (error instanceof Error && error.message === 'DSH command receipt does not exist') return null;
      throw error;
    }
  }

  private validateLeaseRequest<T extends DshLeaseRequest>(input: T): T & { ttlMs: number } {
    const controller = input.controller;
    if (!['HUMAN', 'NEXUS', 'TEAM_LEAD'].includes(controller)) throw new Error('controller is invalid');
    const surface = input.surface;
    if (!['DESKTOP', 'LAN', 'INTERNAL', 'A2A'].includes(surface)) throw new Error('surface is invalid');
    return {
      ...input,
      sessionId: assertText(input.sessionId, 'sessionId'),
      principal: assertText(input.principal, 'principal', 200),
      expectedRevision: assertNonNegativeInteger(input.expectedRevision, 'expectedRevision'),
      ttlMs: this.leaseTtl(input.ttlMs)
    };
  }

  private leaseTtl(value: number | undefined): number {
    const ttl = value ?? DEFAULT_LEASE_TTL_MS;
    if (!Number.isSafeInteger(ttl) || ttl < MIN_LEASE_TTL_MS || ttl > MAX_LEASE_TTL_MS) {
      throw new Error(`lease ttl must be ${MIN_LEASE_TTL_MS}-${MAX_LEASE_TTL_MS}ms`);
    }
    return ttl;
  }

  private assertControlMode(mode: DshControlMode): void {
    if (!['STANDALONE', 'DELEGATED', 'NEXUS_MANAGED', 'TAKEOVER'].includes(mode)) throw new Error('controlMode is invalid');
  }

  private requireSessionRow(sessionId: string): Row {
    const row = this.db.raw.prepare('SELECT * FROM dsh_sessions WHERE id = ?').get(sessionId) as Row | undefined;
    if (!row) throw new Error('DSH session does not exist');
    return row;
  }

  private leaseRow(sessionId: string): Row | null {
    return (this.db.raw.prepare('SELECT * FROM dsh_control_leases WHERE session_id = ?').get(sessionId) as Row | undefined) ?? null;
  }

  private requireActiveLease(sessionId: string, now: number): Row {
    const lease = this.leaseRow(sessionId);
    if (!lease || rowNumber(lease, 'expires_at') <= now) throw new Error('DSH control lease is absent or expired');
    return lease;
  }

  private assertRevision(session: Row, expectedRevision: number): void {
    const actual = rowNumber(session, 'revision');
    if (actual !== expectedRevision) throw new DshRevisionConflictError(expectedRevision, actual);
  }

  private casSession(
    sessionId: string,
    expectedRevision: number,
    revision: number,
    controlMode: DshControlMode,
    now: number
  ): void {
    const changed = this.db.raw.prepare(`
      UPDATE dsh_sessions SET revision = ?, control_mode = ?, updated_at = ? WHERE id = ? AND revision = ?
    `).run(revision, controlMode, now, sessionId, expectedRevision).changes;
    if (changed !== 1) {
      const current = this.requireSessionRow(sessionId);
      throw new DshRevisionConflictError(expectedRevision, rowNumber(current, 'revision'));
    }
  }

  private writeLease(
    request: DshLeaseRequest & { ttlMs: number },
    token: string,
    revision: number,
    previousControlMode: DshControlMode,
    now: number
  ): void {
    this.db.raw.prepare(`
      INSERT INTO dsh_control_leases(
        session_id, controller, surface, principal, token_hash, previous_control_mode,
        expires_at, revision, acquired_at, renewed_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        controller = excluded.controller,
        surface = excluded.surface,
        principal = excluded.principal,
        token_hash = excluded.token_hash,
        previous_control_mode = excluded.previous_control_mode,
        expires_at = excluded.expires_at,
        revision = excluded.revision,
        acquired_at = excluded.acquired_at,
        renewed_at = excluded.renewed_at
    `).run(
      request.sessionId, request.controller, request.surface, request.principal,
      hashToken(token), previousControlMode, now + request.ttlMs, revision, now, now
    );
  }

  private releaseLeaseRow(
    session: Row,
    lease: Row,
    expectedRevision: number,
    now: number,
    actor: string,
    action: 'release' | 'expire'
  ): void {
    const sessionId = rowText(session, 'id');
    const revision = expectedRevision + 1;
    const previousMode = rowText(lease, 'previous_control_mode') as DshControlMode;
    this.casSession(sessionId, expectedRevision, revision, previousMode, now);
    this.db.raw.prepare('DELETE FROM dsh_control_leases WHERE session_id = ?').run(sessionId);
    this.audit(actor, `dsh.control.${action}`, sessionId, action === 'expire' ? 'expired' : 'ok');
  }

  private expireLease(sessionId: string): void {
    const lease = this.leaseRow(sessionId);
    const now = this.now();
    if (!lease || rowNumber(lease, 'expires_at') > now) return;
    this.db.transaction(() => {
      const currentLease = this.leaseRow(sessionId);
      if (!currentLease || rowNumber(currentLease, 'expires_at') > now) return;
      const session = this.requireSessionRow(sessionId);
      const revision = rowNumber(session, 'revision');
      this.releaseLeaseRow(session, currentLease, revision, now, 'system', 'expire');
    });
  }

  private controlStatusFromRows(session: Row, lease: Row | null): DshControlStatusView {
    return {
      sessionId: rowText(session, 'id'),
      agentId: rowText(session, 'agent_id'),
      conversationId: rowNullableText(session, 'conversation_id'),
      controlMode: rowText(session, 'control_mode') as DshControlMode,
      revision: rowNumber(session, 'revision'),
      lastEventCursor: rowNumber(session, 'last_event_cursor'),
      lease: lease ? this.leaseView(lease) : null
    };
  }

  private leaseView(row: Row): DshControlLeaseView {
    return {
      sessionId: rowText(row, 'session_id'),
      controller: rowText(row, 'controller') as DshLeaseController,
      surface: rowText(row, 'surface') as DshControlSurface,
      principal: rowText(row, 'principal'),
      expiresAt: rowNumber(row, 'expires_at'),
      revision: rowNumber(row, 'revision')
    };
  }

  private requireRunForSession(runId: string, sessionId: string): Row {
    const row = this.db.raw.prepare('SELECT * FROM dsh_runs WHERE id = ?').get(runId) as Row | undefined;
    if (!row || rowText(row, 'session_id') !== sessionId) throw new Error('DSH run does not belong to the session');
    return row;
  }

  private eventFromRow(row: Row): DshEventView {
    return {
      sessionId: rowText(row, 'session_id'),
      seq: rowNumber(row, 'seq'),
      runId: rowNullableText(row, 'run_id'),
      type: rowText(row, 'type'),
      protocolVersion: rowText(row, 'protocol_version'),
      payload: parseObject(row.payload_json),
      createdAt: rowNumber(row, 'created_at')
    };
  }

  private requireReceiptRow(commandId: string): Row {
    const row = this.db.raw.prepare('SELECT * FROM dsh_command_receipts WHERE command_id = ?').get(commandId) as Row | undefined;
    if (!row) throw new Error('DSH command receipt does not exist');
    return row;
  }

  private receiptFromRow(row: Row): DshCommandReceipt {
    const result = rowNullableText(row, 'result_json');
    return {
      commandId: rowText(row, 'command_id'),
      sessionId: rowText(row, 'session_id'),
      runId: rowNullableText(row, 'run_id'),
      commandType: rowText(row, 'command_type'),
      expectedRevision: rowNumber(row, 'expected_revision'),
      appliedRevision: rowNumber(row, 'applied_revision'),
      principal: rowText(row, 'principal'),
      status: rowText(row, 'status') as DshCommandReceiptStatus,
      result: result ? parseObject(result) : null,
      error: rowNullableText(row, 'error'),
      createdAt: rowNumber(row, 'created_at'),
      completedAt: row.completed_at === null || row.completed_at === undefined ? null : rowNumber(row, 'completed_at')
    };
  }

  private audit(actor: string, action: string, target: string, result: string): void {
    this.db.audit({ id: randomUUID(), actor, action, target, result, source: 'dsh' });
  }
}
