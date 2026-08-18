import type { Database } from './database.js';
import {
  DshSessionService,
  type DshSessionInput,
  type DshSessionRecord
} from './dshSessionService.js';

type Row = Record<string, unknown>;

const MAX_SESSION_SCAN = 10_000;
const MAX_TREE_NODES = 1_000;
const MAX_CANCEL_TARGETS = 500;
const MAX_SUMMARY_RESULTS = 200;
const MAX_SUMMARY_EVENTS = 50;
const MAX_SUMMARY_TEXT = 4_096;
const MAX_SUMMARY_BYTES = 256 * 1024;
const SENSITIVE_PAYLOAD_KEY = /api.?key|access.?token|auth(?:orization)?|cookie|credential|lease.?token|pass(?:word|phrase)|private.?key|secret/i;
const DEFAULT_LIMITS: DshDelegationLimits = {
  maxDepth: 3,
  maxConcurrentChildren: 4,
  maxTotalChildren: 32
};
const TERMINAL_RUN_STATES = new Set([
  'COMPLETED', 'SUCCEEDED', 'SUCCESS', 'DONE', 'FINISHED', 'FAILED', 'ERROR',
  'CANCELLED', 'CANCELED', 'INTERRUPTED', 'STOPPED', 'ABORTED', 'EXPIRED'
]);

/** Limits are deliberately process-local policy, not persisted in the employee table. */
export interface DshDelegationLimits {
  /** Absolute DSH delegation depth. Root sessions are depth 0. */
  maxDepth: number;
  /** Number of active direct children allowed for one parent. */
  maxConcurrentChildren: number;
  /** Number of descendants allowed below one root session. */
  maxTotalChildren: number;
  /** Optional aggregate cost budget (units are chosen by the caller). */
  maxCost?: number;
}

export interface DshDelegationServiceOptions {
  now?: () => number;
  limits?: Partial<DshDelegationLimits>;
  /** A testable boundary around the existing durable session service. */
  sessions?: Pick<DshSessionService, 'upsertSession' | 'getSession'>;
  cancellationPort?: DshCancellationPort;
  maxTreeNodes?: number;
  maxSummaryResults?: number;
  maxSummaryBytes?: number;
  /** Optional authoritative cost reader for deployments with an external ledger. */
  costEstimator?: (sessionId: string) => number;
}

/** Input for a new child. The parent supplies the authoritative depth. */
export interface DshChildSessionInput {
  id: string;
  upstreamSessionId: string;
  runtimeInstanceId: string;
  agentId: string;
  conversationId?: string | null;
  workspace?: string;
  controlMode: DshSessionInput['controlMode'];
  parentSessionId: string;
  /** Optional caller assertion; it must equal parent.delegationDepth + 1. */
  delegationDepth?: number;
  /** Estimated cost reserved by this child before its first run exists. */
  estimatedCost?: number;
  limits?: Partial<DshDelegationLimits>;
}

export interface DshDelegationRunView {
  id: string;
  sessionId: string;
  state: string;
  eventCursor: number;
  createdAt: number;
  updatedAt: number;
}

export interface DshDelegationSessionView {
  session: DshSessionRecord;
  depthFromRoot: number;
  childSessionIds: string[];
  latestRun: DshDelegationRunView | null;
  active: boolean;
  eventCount: number;
  latestEvent: { seq: number; type: string; createdAt: number } | null;
}

export interface DshSessionTreeView {
  /** The actual root after resolving an input child through its ancestors. */
  rootSessionId: string;
  requestedSessionId: string;
  sessions: DshDelegationSessionView[];
  nodes: DshDelegationSessionView[];
  edges: Array<{ parentSessionId: string; childSessionId: string }>;
  /** Complete node count when not truncated; otherwise a lower bound. */
  totalNodes: number;
  returnedNodes: number;
  truncated: boolean;
  orphanSessionIds: string[];
}

export interface DshTreeQueryOptions {
  maxNodes?: number;
  maxDepth?: number;
  /** Return diagnostics instead of throwing for detached rows. */
  allowOrphans?: boolean;
}

export type DshDelegationLimitKind =
  | 'maxDepth'
  | 'maxConcurrentChildren'
  | 'maxTotalChildren'
  | 'maxCost';

export class DshDelegationLimitError extends Error {
  readonly name = 'DshDelegationLimitError';

  constructor(
    readonly kind: DshDelegationLimitKind,
    readonly limit: number,
    readonly current: number,
    readonly requested: number,
    message = `DSH delegation ${kind} limit exceeded`
  ) {
    super(message);
  }
}

export class DshDelegationBoundaryError extends Error {
  readonly name = 'DshDelegationBoundaryError';
}

export class DshDelegationTreeCycleError extends Error {
  readonly name = 'DshDelegationTreeCycleError';

  constructor(readonly cycleSessionIds: string[]) {
    super(`DSH delegation session tree contains a cycle: ${cycleSessionIds.join(' -> ')}`);
  }
}

export class DshDelegationTreeOrphanError extends Error {
  readonly name = 'DshDelegationTreeOrphanError';

  constructor(readonly orphanSessionIds: string[]) {
    super(`DSH delegation session tree contains orphan sessions: ${orphanSessionIds.join(', ')}`);
  }
}

export class DshDelegationTreeIntegrityError extends Error {
  readonly name = 'DshDelegationTreeIntegrityError';
}

export type DshCancellationConfirmationState =
  | 'CONFIRMED'
  | 'ALREADY_TERMINAL'
  | 'PENDING'
  | 'TIMED_OUT'
  | 'FAILED';

export interface DshCancellationRequest {
  sessionId: string;
  parentSessionId: string;
  reason: string;
  deadlineAt: number;
}

export interface DshCancellationAck {
  confirmed?: boolean;
  state?: DshCancellationConfirmationState;
  detail?: string;
}

/** Inject this adapter from the DSH gateway/executor. It must not mutate TaskStatus. */
export interface DshCancellationPort {
  requestCancel(
    request: DshCancellationRequest
  ): DshCancellationAck | boolean | void | Promise<DshCancellationAck | boolean | void>;
}

export interface DshCancellationTargetResult {
  sessionId: string;
  state: DshCancellationConfirmationState;
  detail?: string;
  deadlineAt: number;
}

export interface DshCascadeCancellationResult {
  requestedParentSessionId: string;
  requestedSessionIds: string[];
  confirmedSessionIds: string[];
  pendingSessionIds: string[];
  timedOutSessionIds: string[];
  failedSessionIds: string[];
  targets: DshCancellationTargetResult[];
  status: 'NO_TARGETS' | 'CONFIRMED' | 'PARTIAL' | 'PENDING' | 'TIMED_OUT' | 'FAILED';
  deadlineAt: number;
}

export interface DshChildResultView {
  sessionId: string;
  parentSessionId: string;
  depth: number;
  runId: string | null;
  status: string;
  summary: string;
  artifactRefs: string[];
  eventRefs: Array<{ seq: number; type: string }>;
  truncated: boolean;
  updatedAt: number;
}

export interface DshChildResultAggregate {
  rootSessionId: string;
  requestedParentSessionId: string;
  totalChildren: number;
  omittedChildren: number;
  truncated: boolean;
  results: DshChildResultView[];
  generatedAt: number;
}

interface SessionRow extends Row {
  id: string;
  parent_session_id: string | null;
  delegation_depth: number;
  runtime_instance_id: string;
  agent_id: string;
  conversation_id: string | null;
  organization_id: string;
  created_at: number;
  updated_at: number;
}

interface RunRow extends Row {
  id: string;
  session_id: string;
  upstream_state: string;
  event_cursor: number;
  created_at: number;
  updated_at: number;
}

interface EventRow extends Row {
  session_id: string;
  seq: number;
  type: string;
  payload_json: string;
  created_at: number;
}

function text(value: unknown, field: string, max = 500, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > max
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function optionalText(value: unknown, field: string, max = 500): string | null {
  if (value === undefined || value === null || value === '') return null;
  return text(value, field, max);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${field} must be a non-negative integer`);
  return value as number;
}

function finiteNonNegative(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${field} must be non-negative`);
  return value;
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

function parseJsonObject(value: unknown): Record<string, unknown> {
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

function isTerminal(state: string): boolean {
  return TERMINAL_RUN_STATES.has(state.trim().toUpperCase());
}

function boundedText(value: string, max = MAX_SUMMARY_TEXT): { value: string; truncated: boolean } {
  if (value.length <= max) return { value, truncated: false };
  return { value: `${value.slice(0, max)}...[TRUNCATED]`, truncated: true };
}

function safeSummaryValue(value: unknown, depth = 0): unknown {
  if (depth >= 8) return '[TRUNCATED]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeSummaryValue(item, depth + 1));
  if (!value || typeof value !== 'object') return String(value);
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    output[key] = SENSITIVE_PAYLOAD_KEY.test(key) ? '[REDACTED]' : safeSummaryValue(child, depth + 1);
  }
  return output;
}

function safeString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    const encoded = JSON.stringify(safeSummaryValue(value));
    return typeof encoded === 'string' ? encoded : String(value);
  } catch {
    return String(value);
  }
}

function redact(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*["']?)[^\s"',;]{4,}/gi, '$1[REDACTED]');
}

function costFromPayload(payload: Record<string, unknown>): number {
  const candidates: unknown[] = [
    payload.cost,
    payload.costUsd,
    payload.cost_usd,
    payload.totalCost,
    payload.total_cost,
    payload.estimatedCost,
    payload.estimated_cost,
    (payload.usage as Record<string, unknown> | undefined)?.cost,
    (payload.usage as Record<string, unknown> | undefined)?.costUsd,
    (payload.usage as Record<string, unknown> | undefined)?.cost_usd,
    (payload.usage as Record<string, unknown> | undefined)?.total_cost
  ];
  return candidates.reduce<number>((total, candidate) => (
    typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0 ? total + candidate : total
  ), 0);
}

function collectArtifactRefs(value: unknown, refs: string[], depth = 0): void {
  if (depth > 8 || refs.length >= 20 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectArtifactRefs(item, refs, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[-_]/g, '');
    if (normalized === 'artifactref' || normalized === 'artifacturi' || normalized === 'artifactid'
      || normalized === 'artifacturl' || normalized === 'artifactpath') {
      if (typeof child === 'string' && child.length > 0 && child.length <= 1_024) refs.push(redact(child));
    }
    collectArtifactRefs(child, refs, depth + 1);
    if (refs.length >= 20) return;
  }
}

function extractSummary(payload: Record<string, unknown>): string {
  const preferred = ['summary', 'result', 'output', 'content', 'message', 'text', 'description'];
  for (const key of preferred) {
    const candidate = payload[key];
    if (candidate !== undefined && candidate !== null) {
      const value = redact(safeString(candidate));
      if (value) return value;
    }
  }
  return '';
}

function mergeLimits(base: DshDelegationLimits, override?: Partial<DshDelegationLimits>): DshDelegationLimits {
  const merged: DshDelegationLimits = {
    maxDepth: override?.maxDepth ?? base.maxDepth,
    maxConcurrentChildren: override?.maxConcurrentChildren ?? base.maxConcurrentChildren,
    maxTotalChildren: override?.maxTotalChildren ?? base.maxTotalChildren,
    ...(override?.maxCost !== undefined || base.maxCost !== undefined
      ? { maxCost: override?.maxCost ?? base.maxCost }
      : {})
  };
  nonNegativeInteger(merged.maxDepth, 'maxDepth');
  nonNegativeInteger(merged.maxConcurrentChildren, 'maxConcurrentChildren');
  nonNegativeInteger(merged.maxTotalChildren, 'maxTotalChildren');
  if (merged.maxCost !== undefined) finiteNonNegative(merged.maxCost, 'maxCost');
  return merged;
}

/**
 * Projects DSH/Cordis-owned sub-agent sessions without promoting them into
 * durable employee records. Nexus supplies policy and adapter boundaries;
 * DSH remains the delegation owner.
 */
export class DshDelegationService {
  private readonly db: Database;
  private readonly now: () => number;
  private readonly sessions: Pick<DshSessionService, 'upsertSession' | 'getSession'>;
  private readonly limits: DshDelegationLimits;
  private readonly cancellationPort?: DshCancellationPort;
  private readonly maxTreeNodes: number;
  private readonly maxSummaryResults: number;
  private readonly maxSummaryBytes: number;
  private readonly costEstimator?: (sessionId: string) => number;
  /** Reservations exist until process restart; durable usage is read from events. */
  private readonly reservedCosts = new Map<string, number>();

  constructor(db: Database, options?: DshDelegationServiceOptions);
  constructor(
    db: Database,
    sessions: Pick<DshSessionService, 'upsertSession' | 'getSession'>,
    options?: DshDelegationServiceOptions
  );
  constructor(
    db: Database,
    optionsOrSessions: DshDelegationServiceOptions | Pick<DshSessionService, 'upsertSession' | 'getSession'> = {},
    maybeOptions: DshDelegationServiceOptions = {}
  ) {
    this.db = db;
    const isSessionAdapter = typeof (optionsOrSessions as Pick<DshSessionService, 'upsertSession' | 'getSession'>).upsertSession === 'function'
      && typeof (optionsOrSessions as Pick<DshSessionService, 'upsertSession' | 'getSession'>).getSession === 'function';
    const options = (isSessionAdapter ? maybeOptions : optionsOrSessions) as DshDelegationServiceOptions;
    this.now = options.now ?? Date.now;
    this.sessions = isSessionAdapter
      ? optionsOrSessions as Pick<DshSessionService, 'upsertSession' | 'getSession'>
      : options.sessions ?? new DshSessionService(db, { now: this.now });
    this.limits = mergeLimits(DEFAULT_LIMITS, options.limits);
    this.cancellationPort = options.cancellationPort;
    this.maxTreeNodes = Math.min(
      Math.max(nonNegativeInteger(options.maxTreeNodes ?? MAX_TREE_NODES, 'maxTreeNodes'), 1),
      MAX_TREE_NODES
    );
    this.maxSummaryResults = Math.min(
      Math.max(nonNegativeInteger(options.maxSummaryResults ?? MAX_SUMMARY_RESULTS, 'maxSummaryResults'), 1),
      MAX_SUMMARY_RESULTS
    );
    this.maxSummaryBytes = Math.min(
      Math.max(nonNegativeInteger(options.maxSummaryBytes ?? MAX_SUMMARY_BYTES, 'maxSummaryBytes'), 1),
      MAX_SUMMARY_BYTES
    );
    this.costEstimator = options.costEstimator;
  }

  getLimits(override?: Partial<DshDelegationLimits>): DshDelegationLimits {
    return { ...mergeLimits(this.limits, override) };
  }

  /**
   * Return a bounded, integrity-checked tree. Input may be any session in the
   * tree; its persisted root is resolved before the result is built.
   */
  getSessionTree(sessionId: string, options: DshTreeQueryOptions = {}): DshSessionTreeView {
    const requestedSessionId = text(sessionId, 'sessionId');
    const maxNodes = Math.min(
      Math.max(nonNegativeInteger(options.maxNodes ?? this.maxTreeNodes, 'maxNodes'), 1),
      this.maxTreeNodes
    );
    const maxDepth = options.maxDepth === undefined
      ? Number.POSITIVE_INFINITY
      : nonNegativeInteger(options.maxDepth, 'maxDepth');
    const requested = this.requireSessionRow(requestedSessionId);
    const scopeRows = this.loadScopeRows(requested);
    const byId = new Map(scopeRows.map((row) => [row.id, row]));
    const orphans = scopeRows
      .filter((row) => row.parent_session_id !== null && !byId.has(row.parent_session_id))
      .map((row) => row.id);
    if (orphans.length > 0 && !options.allowOrphans) throw new DshDelegationTreeOrphanError(orphans);
    this.assertNoCycles(scopeRows);

    let root = requested;
    const ancestorIds = new Set<string>();
    while (root.parent_session_id) {
      if (ancestorIds.has(root.id)) throw new DshDelegationTreeCycleError([...ancestorIds, root.id]);
      ancestorIds.add(root.id);
      const parent = byId.get(root.parent_session_id);
      if (!parent) {
        if (!options.allowOrphans) throw new DshDelegationTreeOrphanError([root.id]);
        break;
      }
      root = parent;
    }
    if (root.parent_session_id === null && root.delegation_depth !== 0) {
      throw new DshDelegationTreeIntegrityError('DSH root session must have delegation depth 0');
    }

    const childrenByParent = new Map<string, SessionRow[]>();
    for (const row of scopeRows) {
      if (!row.parent_session_id) continue;
      const list = childrenByParent.get(row.parent_session_id) ?? [];
      list.push(row);
      childrenByParent.set(row.parent_session_id, list);
    }
    for (const list of childrenByParent.values()) {
      list.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
    }

    const runRows = this.loadLatestRuns(scopeRows.map((row) => row.id));
    const eventRows = this.loadEventStats(scopeRows.map((row) => row.id));
    const sessions: DshDelegationSessionView[] = [];
    const edges: Array<{ parentSessionId: string; childSessionId: string }> = [];
    const queue: Array<{ row: SessionRow; depthFromRoot: number }> = [{ row: root, depthFromRoot: 0 }];
    const visited = new Set<string>();
    let truncated = false;
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.row.id)) throw new DshDelegationTreeCycleError([current.row.id]);
      if (visited.size >= maxNodes) {
        truncated = true;
        break;
      }
      visited.add(current.row.id);
      if (current.row.delegation_depth !== root.delegation_depth + current.depthFromRoot) {
        throw new DshDelegationTreeIntegrityError(
          `DSH session ${current.row.id} delegation depth does not match its tree depth`
        );
      }
      const childRows = childrenByParent.get(current.row.id) ?? [];
      const childSessionIds: string[] = [];
      for (const child of childRows) {
        if (current.depthFromRoot + 1 > maxDepth) {
          truncated = true;
          continue;
        }
        childSessionIds.push(child.id);
        edges.push({ parentSessionId: current.row.id, childSessionId: child.id });
        if (!visited.has(child.id)) queue.push({ row: child, depthFromRoot: current.depthFromRoot + 1 });
      }
      const latestRun = runRows.get(current.row.id) ?? null;
      const eventStat = eventRows.get(current.row.id) ?? { count: 0, latest: null };
      sessions.push({
        session: this.sessionRecord(current.row.id),
        depthFromRoot: current.depthFromRoot,
        childSessionIds,
        latestRun,
        active: latestRun ? !isTerminal(latestRun.state) : childSessionIds.length > 0 || current.row.id !== root.id,
        eventCount: eventStat.count,
        latestEvent: eventStat.latest
      });
    }

    // A bounded response must never silently claim a complete tree.
    const reachableCount = scopeRows.filter((row) => this.isDescendantOf(row, root, byId)).length;
    if (visited.size < reachableCount) truncated = true;
    const includedIds = new Set(sessions.map((entry) => entry.session.sessionId));
    for (const entry of sessions) entry.childSessionIds = entry.childSessionIds.filter((childId) => includedIds.has(childId));
    const boundedEdges = edges.filter((edge) => includedIds.has(edge.parentSessionId) && includedIds.has(edge.childSessionId));
    const rootSession = sessions.find((entry) => entry.session.sessionId === root.id);
    if (!rootSession) throw new DshDelegationTreeIntegrityError('DSH root session was not projected');
    return {
      rootSessionId: root.id,
      requestedSessionId,
      sessions,
      nodes: sessions,
      edges: boundedEdges,
      totalNodes: reachableCount,
      returnedNodes: sessions.length,
      truncated,
      orphanSessionIds: orphans
    };
  }

  /** Alias kept explicit for callers that use the Phase 5 terminology. */
  querySessionTree(sessionId: string, options: DshTreeQueryOptions = {}): DshSessionTreeView {
    return this.getSessionTree(sessionId, options);
  }

  projectSessionTree(sessionId: string, options: DshTreeQueryOptions = {}): DshSessionTreeView {
    return this.getSessionTree(sessionId, options);
  }

  /**
   * Atomically validate limits and register a child session. Retrying an
   * identical registration is idempotent and does not consume another slot.
   */
  createChildSession(input: DshChildSessionInput): DshSessionRecord {
    const parentId = text(input.parentSessionId, 'parentSessionId');
    const id = text(input.id, 'sessionId');
    const estimate = input.estimatedCost === undefined ? 0 : finiteNonNegative(input.estimatedCost, 'estimatedCost');
    const limits = mergeLimits(this.limits, input.limits);
    let result: DshSessionRecord | undefined;
    this.db.transaction(() => {
      const parent = this.requireSessionRow(parentId);
      this.assertChildBoundary(parent, input);
      const expectedDepth = parent.delegation_depth + 1;
      if (input.delegationDepth !== undefined && input.delegationDepth !== expectedDepth) {
        throw new DshDelegationLimitError('maxDepth', limits.maxDepth, expectedDepth, input.delegationDepth,
          'DSH child delegation depth must equal parent depth plus one');
      }
      if (expectedDepth > limits.maxDepth) {
        throw new DshDelegationLimitError('maxDepth', limits.maxDepth, parent.delegation_depth, expectedDepth);
      }

      const existing = this.db.raw.prepare(`
        SELECT id, parent_session_id, runtime_instance_id, agent_id, delegation_depth,
               upstream_session_id, conversation_id
        FROM dsh_sessions WHERE id = ?
      `).get(id) as Row | undefined;
      if (existing) {
        const requestedConversation = optionalText(input.conversationId, 'conversationId');
        if (rowText(existing, 'parent_session_id') !== parentId
          || rowText(existing, 'runtime_instance_id') !== input.runtimeInstanceId
          || rowText(existing, 'agent_id') !== input.agentId
          || rowNumber(existing, 'delegation_depth') !== expectedDepth
          || rowText(existing, 'upstream_session_id') !== input.upstreamSessionId
          || (requestedConversation !== null
            && rowNullableText(existing, 'conversation_id') !== requestedConversation)) {
          throw new DshDelegationBoundaryError('Existing DSH child identity does not match the requested parent');
        }
        result = this.sessions.getSession(id);
        return;
      }

      const tree = this.getSessionTree(parentId, { maxNodes: this.maxTreeNodes });
      if (tree.truncated) {
        throw new DshDelegationTreeIntegrityError('DSH delegation tree is too large to enforce limits safely');
      }
      // maxTotalChildren is a root-scoped budget. A child may delegate further,
      // but it must not evade the root's aggregate fan-out by using a branch.
      const descendantCount = Math.max(0, tree.sessions.length - 1);
      if (descendantCount + 1 > limits.maxTotalChildren) {
        throw new DshDelegationLimitError('maxTotalChildren', limits.maxTotalChildren, descendantCount, descendantCount + 1);
      }
      const parentNode = tree.sessions.find((entry) => entry.session.sessionId === parentId);
      if (!parentNode) throw new DshDelegationTreeIntegrityError('Parent session is outside its own tree');
      const activeDirectChildren = parentNode.childSessionIds
        .map((childId) => tree.sessions.find((entry) => entry.session.sessionId === childId))
        .filter((child): child is DshDelegationSessionView => Boolean(child && child.active)).length;
      if (activeDirectChildren + 1 > limits.maxConcurrentChildren) {
        throw new DshDelegationLimitError(
          'maxConcurrentChildren', limits.maxConcurrentChildren, activeDirectChildren, activeDirectChildren + 1
        );
      }
      if (limits.maxCost !== undefined) {
        const currentCost = this.treeCost(tree);
        if (currentCost + estimate > limits.maxCost) {
          throw new DshDelegationLimitError('maxCost', limits.maxCost, currentCost, currentCost + estimate);
        }
      }

      result = this.sessions.upsertSession({
        id,
        upstreamSessionId: input.upstreamSessionId,
        runtimeInstanceId: input.runtimeInstanceId,
        agentId: input.agentId,
        conversationId: input.conversationId,
        parentSessionId: parentId,
        delegationDepth: expectedDepth,
        workspace: input.workspace,
        controlMode: input.controlMode
      });
      if (estimate > 0) this.reservedCosts.set(id, Math.max(this.reservedCosts.get(id) ?? 0, estimate));
    });
    if (!result) throw new Error('DSH child session registration did not produce a session');
    return result;
  }

  registerChildSession(input: DshChildSessionInput): DshSessionRecord {
    return this.createChildSession(input);
  }

  createChild(input: DshChildSessionInput): DshSessionRecord {
    return this.createChildSession(input);
  }

  registerChild(input: DshChildSessionInput): DshSessionRecord {
    return this.createChildSession(input);
  }

  /** Return a cancellation plan and optionally execute it through the adapter. */
  async cascadeCancel(
    parentSessionId: string,
    options: {
      reason?: string;
      timeoutMs?: number;
      includeRoot?: boolean;
      cancellationPort?: DshCancellationPort;
      maxTargets?: number;
    } = {}
  ): Promise<DshCascadeCancellationResult> {
    const parentId = text(parentSessionId, 'parentSessionId');
    const timeoutMs = options.timeoutMs === undefined ? 30_000 : nonNegativeInteger(options.timeoutMs, 'timeoutMs');
    const maxTargets = Math.min(
      Math.max(nonNegativeInteger(options.maxTargets ?? MAX_CANCEL_TARGETS, 'maxTargets'), 1),
      MAX_CANCEL_TARGETS
    );
    const tree = this.getSessionTree(parentId, { maxNodes: Math.max(this.maxTreeNodes, maxTargets + 1) });
    if (tree.truncated) {
      throw new DshDelegationTreeIntegrityError('DSH cancellation tree is truncated; refusing a partial cascade');
    }
    const parent = tree.sessions.find((entry) => entry.session.sessionId === parentId);
    if (!parent) throw new DshDelegationTreeIntegrityError('Cancellation parent is not in the projected tree');
    const byId = new Map(tree.sessions.map((entry) => [entry.session.sessionId, entry]));
    const targetIds = tree.sessions
      .filter((entry) => entry.session.sessionId !== parentId && this.isDescendantInTree(entry.session.sessionId, parentId, tree))
      .sort((a, b) => b.depthFromRoot - a.depthFromRoot || a.session.sessionId.localeCompare(b.session.sessionId))
      .slice(0, maxTargets)
      .map((entry) => entry.session.sessionId);
    if (options.includeRoot) targetIds.push(parentId);
    const deadlineAt = this.now() + timeoutMs;
    const reason = options.reason === undefined ? 'parent session cancelled' : text(options.reason, 'reason', 1_000, true);
    const port = options.cancellationPort ?? this.cancellationPort;
    const targets: DshCancellationTargetResult[] = [];
    for (const targetId of targetIds) {
      const node = byId.get(targetId)!;
      if (node.latestRun && isTerminal(node.latestRun.state)) {
        targets.push({ sessionId: targetId, state: 'ALREADY_TERMINAL', detail: node.latestRun.state, deadlineAt });
        continue;
      }
      if (!port) {
        targets.push({ sessionId: targetId, state: 'PENDING', detail: 'no cancellation port configured', deadlineAt });
        continue;
      }
      const remaining = Math.max(0, deadlineAt - this.now());
      if (remaining === 0) {
        targets.push({ sessionId: targetId, state: 'TIMED_OUT', detail: 'cancellation deadline elapsed', deadlineAt });
        continue;
      }
      try {
        const ack = await this.withTimeout(
          Promise.resolve(port.requestCancel({ sessionId: targetId, parentSessionId: parentId, reason, deadlineAt })),
          remaining
        );
        if (ack === true || (ack && typeof ack === 'object' && (ack.confirmed === true || ack.state === 'CONFIRMED'))) {
          targets.push({ sessionId: targetId, state: 'CONFIRMED', detail: typeof ack === 'object' && ack.detail ? redact(ack.detail) : undefined, deadlineAt });
        } else if (ack && typeof ack === 'object' && ack.state && ['ALREADY_TERMINAL', 'TIMED_OUT', 'FAILED', 'PENDING'].includes(ack.state)) {
          targets.push({ sessionId: targetId, state: ack.state, detail: ack.detail ? redact(ack.detail) : undefined, deadlineAt });
        } else {
          targets.push({ sessionId: targetId, state: 'PENDING', detail: 'cancellation was accepted without confirmation', deadlineAt });
        }
      } catch (error) {
        if (error instanceof TimeoutError) {
          targets.push({ sessionId: targetId, state: 'TIMED_OUT', detail: 'cancellation timed out', deadlineAt });
        } else {
          targets.push({ sessionId: targetId, state: 'FAILED', detail: redact(error instanceof Error ? error.message : String(error)), deadlineAt });
        }
      }
    }
    const confirmedSessionIds = targets.filter((target) => target.state === 'CONFIRMED' || target.state === 'ALREADY_TERMINAL').map((target) => target.sessionId);
    const pendingSessionIds = targets.filter((target) => target.state === 'PENDING').map((target) => target.sessionId);
    const timedOutSessionIds = targets.filter((target) => target.state === 'TIMED_OUT').map((target) => target.sessionId);
    const failedSessionIds = targets.filter((target) => target.state === 'FAILED').map((target) => target.sessionId);
    let status: DshCascadeCancellationResult['status'] = 'NO_TARGETS';
    if (targets.length > 0) {
      if (timedOutSessionIds.length === targets.length) status = 'TIMED_OUT';
      else if (failedSessionIds.length === targets.length) status = 'FAILED';
      else if (confirmedSessionIds.length === targets.length) status = 'CONFIRMED';
      else if (pendingSessionIds.length > 0 && confirmedSessionIds.length === 0 && timedOutSessionIds.length === 0 && failedSessionIds.length === 0) status = 'PENDING';
      else status = 'PARTIAL';
    }
    return {
      requestedParentSessionId: parentId,
      requestedSessionIds: targetIds,
      confirmedSessionIds,
      pendingSessionIds,
      timedOutSessionIds,
      failedSessionIds,
      targets,
      status,
      deadlineAt
    };
  }

  cancelDescendants(parentSessionId: string, options: Parameters<DshDelegationService['cascadeCancel']>[1] = {}) {
    return this.cascadeCancel(parentSessionId, options);
  }

  requestCascadeCancellation(parentSessionId: string, options: Parameters<DshDelegationService['cascadeCancel']>[1] = {}) {
    return this.cascadeCancel(parentSessionId, options);
  }

  cancelCascade(parentSessionId: string, options: Parameters<DshDelegationService['cascadeCancel']>[1] = {}) {
    return this.cascadeCancel(parentSessionId, options);
  }

  /** Aggregate bounded summaries and artifact references from child events. */
  aggregateChildResults(
    parentSessionId: string,
    options: { maxResults?: number; maxBytes?: number } = {}
  ): DshChildResultAggregate {
    const parentId = text(parentSessionId, 'parentSessionId');
    const maxResults = Math.min(
      Math.max(nonNegativeInteger(options.maxResults ?? this.maxSummaryResults, 'maxResults'), 1),
      this.maxSummaryResults
    );
    const maxBytes = Math.min(
      Math.max(nonNegativeInteger(options.maxBytes ?? this.maxSummaryBytes, 'maxBytes'), 1),
      this.maxSummaryBytes
    );
    const tree = this.getSessionTree(parentId, { maxNodes: this.maxTreeNodes });
    const children = tree.sessions
      .filter((entry) => entry.session.sessionId !== parentId && this.isDescendantInTree(entry.session.sessionId, parentId, tree))
      .sort((a, b) => a.depthFromRoot - b.depthFromRoot || a.session.sessionId.localeCompare(b.session.sessionId));
    const runRows = this.loadLatestRuns(children.map((entry) => entry.session.sessionId));
    const output: DshChildResultView[] = [];
    let bytes = 0;
    let truncated = tree.truncated;
    for (const child of children) {
      if (output.length >= maxResults) { truncated = true; break; }
      const events = this.db.raw.prepare(`
        SELECT session_id, seq, type, payload_json, created_at
        FROM dsh_events WHERE session_id = ? ORDER BY seq DESC LIMIT ?
      `).all(child.session.sessionId, MAX_SUMMARY_EVENTS) as unknown as EventRow[];
      const orderedEvents = [...events].reverse();
      let summary = '';
      let childTruncated = false;
      const artifactRefs: string[] = [];
      const eventRefs: Array<{ seq: number; type: string }> = [];
      for (const event of orderedEvents) {
        const payload = parseJsonObject(event.payload_json);
        const candidate = extractSummary(payload);
        if (candidate) summary = candidate;
        collectArtifactRefs(payload, artifactRefs);
        if (/result|complete|output|artifact|goal|message/i.test(event.type)) {
          eventRefs.push({ seq: rowNumber(event, 'seq'), type: rowText(event, 'type') });
        }
      }
      const bounded = boundedText(summary);
      summary = bounded.value;
      childTruncated ||= bounded.truncated;
      const run = runRows.get(child.session.sessionId);
      const result: DshChildResultView = {
        sessionId: child.session.sessionId,
        parentSessionId: child.session.parentSessionId ?? parentId,
        depth: child.session.delegationDepth,
        runId: run?.id ?? null,
        status: run?.state ?? 'UNKNOWN',
        summary,
        artifactRefs: [...new Set(artifactRefs)].slice(0, 20),
        eventRefs: eventRefs.slice(-20),
        truncated: childTruncated,
        updatedAt: child.session.updatedAt
      };
      let encodedBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
      if (bytes + encodedBytes > maxBytes) {
        // Keep the envelope bounded even when the first child alone is larger
        // than the requested budget. Shrink the human text first, then drop
        // optional references before omitting the item entirely.
        const remaining = Math.max(0, maxBytes - bytes);
        const envelopeWithoutSummary = { ...result, summary: '' };
        const overhead = Buffer.byteLength(JSON.stringify(envelopeWithoutSummary), 'utf8');
        const availableSummary = Math.max(0, remaining - overhead - 16);
        result.summary = availableSummary > 0 ? boundedText(result.summary, availableSummary).value : '';
        result.truncated = true;
        encodedBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
        if (bytes + encodedBytes > maxBytes) {
          result.artifactRefs = [];
          result.eventRefs = [];
          encodedBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
        }
        if (bytes + encodedBytes > maxBytes) {
          truncated = true;
          break;
        }
        truncated = true;
      }
      bytes += encodedBytes;
      output.push(result);
    }
    const omittedChildren = Math.max(0, children.length - output.length);
    return {
      rootSessionId: tree.rootSessionId,
      requestedParentSessionId: parentId,
      totalChildren: children.length,
      omittedChildren,
      truncated: truncated || omittedChildren > 0,
      results: output,
      generatedAt: this.now()
    };
  }

  summarizeChildResults(parentSessionId: string, options: Parameters<DshDelegationService['aggregateChildResults']>[1] = {}) {
    return this.aggregateChildResults(parentSessionId, options);
  }

  aggregateResults(parentSessionId: string, options: Parameters<DshDelegationService['aggregateChildResults']>[1] = {}) {
    return this.aggregateChildResults(parentSessionId, options);
  }

  private requireSessionRow(sessionId: string): SessionRow {
    const row = this.db.raw.prepare(`
      SELECT s.*, a.organization_id
      FROM dsh_sessions s
      LEFT JOIN agents a ON a.id = s.agent_id
      WHERE s.id = ?
    `).get(sessionId) as Row | undefined;
    if (!row) throw new Error('DSH session does not exist');
    return this.normalizeSessionRow(row);
  }

  private loadScopeRows(anchor: SessionRow): SessionRow[] {
    const rows = this.db.raw.prepare(`
      SELECT s.*, a.organization_id
      FROM dsh_sessions s
      LEFT JOIN agents a ON a.id = s.agent_id
      WHERE s.runtime_instance_id = ? AND s.agent_id = ?
      ORDER BY s.created_at ASC, s.id ASC
      LIMIT ?
    `).all(anchor.runtime_instance_id, anchor.agent_id, MAX_SESSION_SCAN + 1) as unknown as Row[];
    if (rows.length > MAX_SESSION_SCAN) {
      throw new DshDelegationTreeIntegrityError('DSH session scope exceeds the projection safety bound');
    }
    return rows.map((row) => this.normalizeSessionRow(row));
  }

  private normalizeSessionRow(row: Row): SessionRow {
    return {
      ...row,
      id: rowText(row, 'id'),
      parent_session_id: rowNullableText(row, 'parent_session_id'),
      delegation_depth: rowNumber(row, 'delegation_depth'),
      runtime_instance_id: rowText(row, 'runtime_instance_id'),
      agent_id: rowText(row, 'agent_id'),
      conversation_id: rowNullableText(row, 'conversation_id'),
      organization_id: rowText(row, 'organization_id'),
      created_at: rowNumber(row, 'created_at'),
      updated_at: rowNumber(row, 'updated_at')
    };
  }

  private sessionRecord(sessionId: string): DshSessionRecord {
    return this.sessions.getSession(sessionId);
  }

  private assertNoCycles(rows: SessionRow[]): void {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const complete = new Set<string>();
    for (const row of rows) {
      if (complete.has(row.id)) continue;
      const path: string[] = [];
      const positions = new Map<string, number>();
      let cursor: SessionRow | undefined = row;
      while (cursor) {
        if (positions.has(cursor.id)) {
          const start = positions.get(cursor.id)!;
          throw new DshDelegationTreeCycleError(path.slice(start).concat(cursor.id));
        }
        if (complete.has(cursor.id)) break;
        positions.set(cursor.id, path.length);
        path.push(cursor.id);
        cursor = cursor.parent_session_id ? byId.get(cursor.parent_session_id) : undefined;
      }
      for (const id of path) complete.add(id);
    }
  }

  private assertChildBoundary(parent: SessionRow, input: DshChildSessionInput): void {
    if (input.agentId !== parent.agent_id) {
      throw new DshDelegationBoundaryError('DSH child must remain inside its parent employee');
    }
    if (input.runtimeInstanceId !== parent.runtime_instance_id) {
      throw new DshDelegationBoundaryError('DSH child must remain inside its parent runtime');
    }
    const organization = this.db.raw.prepare(`SELECT organization_id FROM agents WHERE id = ?`).get(input.agentId) as Row | undefined;
    if (!organization || rowText(organization, 'organization_id') !== parent.organization_id) {
      throw new DshDelegationBoundaryError('DSH child crosses an organization boundary');
    }
    const parentConversationId = parent.conversation_id;
    const conversationId = optionalText(input.conversationId, 'conversationId');
    if (conversationId) {
      const conversation = this.db.raw.prepare(`
        SELECT organization_id, agent_id FROM conversations WHERE id = ?
      `).get(conversationId) as Row | undefined;
      if (!conversation) throw new DshDelegationBoundaryError('DSH child conversation does not exist');
      if (rowText(conversation, 'organization_id') !== parent.organization_id
        || rowText(conversation, 'agent_id') !== parent.agent_id) {
        throw new DshDelegationBoundaryError('DSH child conversation crosses the organization or employee boundary');
      }
      if (parentConversationId && conversationId !== parentConversationId) {
        throw new DshDelegationBoundaryError('DSH child cannot switch its parent conversation');
      }
    }
  }

  private loadLatestRuns(sessionIds: string[]): Map<string, DshDelegationRunView> {
    const output = new Map<string, DshDelegationRunView>();
    for (const sessionId of sessionIds) {
      const row = this.db.raw.prepare(`
        SELECT id, session_id, upstream_state, event_cursor, created_at, updated_at
        FROM dsh_runs WHERE session_id = ?
        ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT 1
      `).get(sessionId) as Row | undefined;
      if (!row) continue;
      output.set(sessionId, {
        id: rowText(row, 'id'),
        sessionId: rowText(row, 'session_id'),
        state: rowText(row, 'upstream_state'),
        eventCursor: rowNumber(row, 'event_cursor'),
        createdAt: rowNumber(row, 'created_at'),
        updatedAt: rowNumber(row, 'updated_at')
      });
    }
    return output;
  }

  private loadEventStats(sessionIds: string[]): Map<string, { count: number; latest: { seq: number; type: string; createdAt: number } | null }> {
    const output = new Map<string, { count: number; latest: { seq: number; type: string; createdAt: number } | null }>();
    for (const sessionId of sessionIds) {
      const row = this.db.raw.prepare(`
        SELECT COUNT(*) AS count, MAX(seq) AS latest_seq FROM dsh_events WHERE session_id = ?
      `).get(sessionId) as Row | undefined;
      const count = rowNumber(row ?? {}, 'count');
      const latestSeq = row?.latest_seq === null || row?.latest_seq === undefined ? null : rowNumber(row, 'latest_seq');
      let latest: { seq: number; type: string; createdAt: number } | null = null;
      if (latestSeq !== null) {
        const event = this.db.raw.prepare(`
          SELECT seq, type, created_at FROM dsh_events WHERE session_id = ? AND seq = ?
        `).get(sessionId, latestSeq) as Row | undefined;
        if (event) latest = { seq: rowNumber(event, 'seq'), type: rowText(event, 'type'), createdAt: rowNumber(event, 'created_at') };
      }
      output.set(sessionId, { count, latest });
    }
    return output;
  }

  private descendantCount(tree: DshSessionTreeView, parentId: string): number {
    return tree.sessions.filter((entry) => entry.session.sessionId !== parentId
      && this.isDescendantInTree(entry.session.sessionId, parentId, tree)).length;
  }

  private isDescendantOf(row: SessionRow, root: SessionRow, byId: Map<string, SessionRow>): boolean {
    if (row.id === root.id) return true;
    const seen = new Set<string>();
    let cursor: SessionRow | undefined = row;
    while (cursor?.parent_session_id) {
      if (seen.has(cursor.id)) return false;
      seen.add(cursor.id);
      if (cursor.parent_session_id === root.id) return true;
      cursor = byId.get(cursor.parent_session_id);
    }
    return false;
  }

  private isDescendantInTree(sessionId: string, parentId: string, tree: DshSessionTreeView): boolean {
    const parentByChild = new Map(tree.edges.map((edge) => [edge.childSessionId, edge.parentSessionId]));
    const seen = new Set<string>();
    let cursor = sessionId;
    while (parentByChild.has(cursor)) {
      if (seen.has(cursor)) return false;
      seen.add(cursor);
      const parent = parentByChild.get(cursor)!;
      if (parent === parentId) return true;
      cursor = parent;
    }
    return false;
  }

  private treeCost(tree: DshSessionTreeView): number {
    let total = 0;
    for (const node of tree.sessions) {
      const reserved = this.reservedCosts.get(node.session.sessionId) ?? 0;
      let externalCost = 0;
      let eventCost = 0;
      if (this.costEstimator) {
        const estimate = this.costEstimator(node.session.sessionId);
        if (Number.isFinite(estimate) && estimate >= 0) externalCost = estimate;
      }
      const rows = this.db.raw.prepare(`
        SELECT payload_json FROM dsh_events WHERE session_id = ? ORDER BY seq ASC LIMIT ?
      `).all(node.session.sessionId, MAX_SUMMARY_EVENTS * 4) as unknown as Row[];
      for (const row of rows) eventCost += costFromPayload(parseJsonObject(row.payload_json));
      // Reservations and event/ledger costs can describe the same child. Use
      // the larger authoritative observation instead of charging twice.
      total += Math.max(reserved, externalCost, eventCost);
    }
    return total;
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new TimeoutError()), timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

class TimeoutError extends Error {
  readonly name = 'DshDelegationTimeoutError';
}

export const DSH_DELEGATION_DEFAULT_LIMITS = Object.freeze({ ...DEFAULT_LIMITS });
