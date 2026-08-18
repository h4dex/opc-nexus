import { createHash } from 'node:crypto';
import type {
  DshControlPort,
  DshHistoryEntry,
  DshSessionEvent,
  DshSessionSummary
} from './dshControlClient.js';
import {
  DshDelegationService,
  type DshChildSessionInput
} from './dshDelegationService.js';
import {
  DshSessionService,
  type DshSessionInput,
  type DshSessionRecord
} from './dshSessionService.js';

/**
 * A bounded, Main-process adapter for the DSH subagent projection.
 *
 * DSH owns the upstream child lifecycle. The governance plugin only projects child sessions
 * after a parent is already known, and never creates an Agent row for a
 * transient subagent.  This split also lets us keep the adapter tolerant of
 * upstream capability changes: an unknown/partial summary is reported and
 * ignored rather than becoming a new root session in Nexus.
 */

const DEFAULT_MAX_SUMMARIES = 256;
const DEFAULT_MAX_HISTORY_PAGES = 32;
const DEFAULT_HISTORY_PAGE_SIZE = 100;
const MAX_SUMMARIES = 2_000;
const MAX_HISTORY_PAGES = 100;
const MAX_HISTORY_PAGE_SIZE = 200;
const MAX_ID_LENGTH = 120;
const PROTOCOL_VERSION = 'dsh-web/0.1.0-rc.6';
const TERMINAL_REASONS = new Set([
  'completed', 'success', 'succeeded', 'done', 'finished', 'max-tokens', 'stopped',
  'cancelled', 'canceled', 'failed', 'error', 'interrupted', 'aborted', 'expired'
]);

export interface DshDelegationSyncOptions {
  maxSummaries?: number;
  maxHistoryPages?: number;
  historyPageSize?: number;
  now?: () => number;
  /** Override only for deterministic tests or a future persisted mapping. */
  localSessionId?: (runtimeInstanceId: string, upstreamSessionId: string) => string;
}

export interface DshDelegationSyncInput {
  agentId: string;
  runtimeInstanceId: string;
  summaries: readonly DshSessionSummary[];
  /** Existing root projection. A sync never infers a new root from DSH. */
  rootSessionId?: string;
  workspace?: string;
  controlMode?: DshSessionInput['controlMode'];
}

export interface DshDelegationRuntimeSyncInput {
  agentId: string;
  runtimeInstanceId: string;
  client: DshControlPort;
  rootSessionId?: string;
  workspace?: string;
  controlMode?: DshSessionInput['controlMode'];
  signal?: AbortSignal;
  projectHistory?: boolean;
}

export type DshDelegationSyncSkipReason =
  | 'not-a-child'
  | 'missing-parent'
  | 'parent-not-projected'
  | 'duplicate-summary';

export interface DshDelegationSyncIssue {
  upstreamSessionId: string;
  /** Local projection id when the issue occurs during history replay. */
  sessionId?: string;
  parentSessionId?: string;
  reason: string;
  detail?: string;
}

export interface DshDelegationSyncResult {
  registeredSessionIds: string[];
  existingSessionIds: string[];
  skippedSessionIds: string[];
  orphanSessionIds: string[];
  rejected: DshDelegationSyncIssue[];
  issues: DshDelegationSyncIssue[];
  history?: DshDelegationHistoryResult;
}

export interface DshDelegationHistoryInput {
  agentId: string;
  runtimeInstanceId: string;
  client: DshControlPort;
  sessionIds: readonly string[];
  signal?: AbortSignal;
}

export interface DshDelegationHistoryResult {
  projectedSessionIds: string[];
  projectedEventCount: number;
  terminalSessionIds: string[];
  failedSessionIds: string[];
  errors: DshDelegationSyncIssue[];
}

interface PendingSummary {
  summary: DshSessionSummary;
  parentUpstreamId: string;
}

function assertText(value: unknown, field: string, max = 500): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function boundedPositive(value: number | undefined, fallback: number, maximum: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) throw new Error(`${field} is invalid`);
  return resolved;
}

function safeDetail(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]').slice(0, 500);
}

function hashId(runtimeInstanceId: string, upstreamSessionId: string): string {
  const digest = createHash('sha256')
    .update(`${runtimeInstanceId}\u0000${upstreamSessionId}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `dsh-child-${digest}`.slice(0, MAX_ID_LENGTH);
}

function eventPayload(event: DshSessionEvent): Record<string, unknown> {
  const payload: Record<string, unknown> = { data: event.data };
  if (event.sourceEventSeqs) payload.sourceEventSeqs = event.sourceEventSeqs;
  if (event.surfaceOp !== undefined) payload.surfaceOp = event.surfaceOp;
  if (event.ignorable) payload.ignorable = true;
  return payload;
}

function terminalReason(event: DshSessionEvent): string | null {
  if (event.type !== 'turn/end') return null;
  const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : {};
  const reason = data.reason && typeof data.reason === 'object' && !Array.isArray(data.reason)
    ? (data.reason as Record<string, unknown>).kind
    : undefined;
  return typeof reason === 'string' ? reason.toLowerCase() : 'completed';
}

function isTerminalState(value: string): boolean {
  return TERMINAL_REASONS.has(value.trim().toLowerCase())
    || value.trim().toUpperCase() === 'COMPLETED';
}

function runStateFor(summary: DshSessionSummary, events: readonly DshSessionEvent[], fallbackState?: string): string {
  const terminal = [...events].reverse().map(terminalReason).find((value): value is string => value !== null);
  if (terminal) {
    if (['completed', 'success', 'succeeded', 'done', 'finished', 'max-tokens', 'stopped'].includes(terminal)) {
      return 'COMPLETED';
    }
    return terminal.toUpperCase();
  }
  if (fallbackState && isTerminalState(fallbackState)) return fallbackState;
  return summary.running ? 'RUNNING' : 'COMPLETED';
}

function sortEvents(events: readonly DshHistoryEntry[]): DshSessionEvent[] {
  const bySeq = new Map<number, DshSessionEvent>();
  for (const entry of events) {
    const event = entry.event;
    if (!bySeq.has(event.seq)) bySeq.set(event.seq, event);
  }
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message.toLowerCase().includes('aborted'));
}

export class DshDelegationSyncService {
  private readonly maxSummaries: number;
  private readonly maxHistoryPages: number;
  private readonly historyPageSize: number;
  private readonly now: () => number;
  private readonly localSessionId: (runtimeInstanceId: string, upstreamSessionId: string) => string;

  constructor(
    private readonly sessions: DshSessionService,
    private readonly delegation: DshDelegationService,
    options: DshDelegationSyncOptions = {}
  ) {
    this.maxSummaries = boundedPositive(options.maxSummaries, DEFAULT_MAX_SUMMARIES, MAX_SUMMARIES, 'maxSummaries');
    this.maxHistoryPages = boundedPositive(options.maxHistoryPages, DEFAULT_MAX_HISTORY_PAGES, MAX_HISTORY_PAGES, 'maxHistoryPages');
    this.historyPageSize = boundedPositive(options.historyPageSize, DEFAULT_HISTORY_PAGE_SIZE, MAX_HISTORY_PAGE_SIZE, 'historyPageSize');
    this.now = options.now ?? Date.now;
    this.localSessionId = options.localSessionId ?? hashId;
  }

  /** Fetch and project one runtime's current upstream session inventory. */
  async syncRuntime(input: DshDelegationRuntimeSyncInput): Promise<DshDelegationSyncResult> {
    const summaries = await input.client.listSessions(input.signal);
    if (input.signal?.aborted) throw new Error('DSH delegation sync was aborted');
    const result = this.syncSummaries({ ...input, summaries });
    if (input.projectHistory !== false && result.registeredSessionIds.length + result.existingSessionIds.length > 0) {
      const ids = [...result.registeredSessionIds, ...result.existingSessionIds];
      result.history = await this.projectHistory({
        agentId: input.agentId,
        runtimeInstanceId: input.runtimeInstanceId,
        client: input.client,
        sessionIds: ids,
        signal: input.signal
      });
    }
    return result;
  }

  /**
   * Register only children whose parent is already projected. The method is
   * intentionally synchronous so callers can run it inside their normal Main
   * event queue and inspect every skipped/rejected row before reading the tree.
   */
  syncSummaries(input: DshDelegationSyncInput): DshDelegationSyncResult {
    const agentId = assertText(input.agentId, 'agentId');
    const runtimeInstanceId = assertText(input.runtimeInstanceId, 'runtimeInstanceId');
    if (input.summaries.length > this.maxSummaries) throw new Error('DSH delegation summary limit exceeded');

    const result: DshDelegationSyncResult = {
      registeredSessionIds: [],
      existingSessionIds: [],
      skippedSessionIds: [],
      orphanSessionIds: [],
      rejected: [],
      issues: []
    };
    const byUpstream = new Map<string, DshSessionSummary>();
    for (const summary of input.summaries) {
      try {
        assertText(summary.sessionId, 'sessionId');
        if (summary.parentSessionId !== undefined) assertText(summary.parentSessionId, 'parentSessionId');
        if (byUpstream.has(summary.sessionId)) {
          result.rejected.push({ upstreamSessionId: summary.sessionId, reason: 'duplicate-summary', detail: 'duplicate session id' });
          continue;
        }
        byUpstream.set(summary.sessionId, summary);
      } catch (error) {
        result.rejected.push({
          upstreamSessionId: typeof summary.sessionId === 'string' ? summary.sessionId.slice(0, 500) : '<invalid>',
          reason: 'invalid-summary',
          detail: safeDetail(error)
        });
      }
    }

    const roots = new Map<string, DshSessionRecord>();
    if (input.rootSessionId) {
      try {
        const root = this.sessions.getSession(assertText(input.rootSessionId, 'rootSessionId'));
        if (root.runtimeInstanceId !== runtimeInstanceId || root.agentId !== agentId || root.sessionId.length === 0) {
          throw new Error('root session runtime boundary mismatch');
        }
        if (root.sessionId) roots.set(root.upstreamSessionId, root);
      } catch (error) {
        result.rejected.push({
          upstreamSessionId: input.rootSessionId.slice(0, 500),
          reason: 'invalid-root',
          detail: safeDetail(error)
        });
      }
    }
    // Existing projections are authoritative. Resolve parent IDs through the
    // scoped lookup and never synthesize a root from an upstream summary.
    for (const summary of byUpstream.values()) {
      if (summary.parentSessionId !== undefined) continue;
      try {
        const existing = this.sessions.findSessionByUpstream(agentId, summary.sessionId);
        if (existing && existing.runtimeInstanceId === runtimeInstanceId && existing.parentSessionId === null) {
          roots.set(summary.sessionId, existing);
        }
      } catch (error) {
        result.rejected.push({ upstreamSessionId: summary.sessionId, reason: 'root-lookup-failed', detail: safeDetail(error) });
      }
    }

    const pending: PendingSummary[] = [];
    for (const summary of byUpstream.values()) {
      if (summary.parentSessionId === undefined) {
        result.skippedSessionIds.push(summary.sessionId);
        result.issues.push({ upstreamSessionId: summary.sessionId, reason: 'not-a-child' });
      } else {
        pending.push({ summary, parentUpstreamId: summary.parentSessionId });
      }
    }

    const projectedByUpstream = new Map<string, DshSessionRecord>(roots);
    // Resolve parents in topological passes. A child whose parent is absent in
    // both DSH inventory and Nexus projection remains an explicit orphan.
    let progressed = true;
    while (pending.length > 0 && progressed) {
      progressed = false;
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const pendingChild = pending[index]!;
        const parent = projectedByUpstream.get(pendingChild.parentUpstreamId)
          ?? this.findScopedParent(agentId, runtimeInstanceId, pendingChild.parentUpstreamId, result);
        if (!parent) continue;
        pending.splice(index, 1);
        progressed = true;
        const projection = this.registerChild({
          summary: pendingChild.summary,
          parent,
          agentId,
          runtimeInstanceId,
          workspace: input.workspace,
          controlMode: input.controlMode
        }, result);
        if (projection) {
          projectedByUpstream.set(pendingChild.summary.sessionId, projection.session);
          if (projection.created) result.registeredSessionIds.push(projection.session.sessionId);
          else result.existingSessionIds.push(projection.session.sessionId);
        }
      }
    }
    for (const orphan of pending) {
      result.orphanSessionIds.push(orphan.summary.sessionId);
      result.issues.push({
        upstreamSessionId: orphan.summary.sessionId,
        parentSessionId: orphan.parentUpstreamId,
        reason: 'parent-not-projected'
      });
    }
    return result;
  }

  /** Incrementally project child histories already registered by syncSummaries. */
  async projectHistory(input: DshDelegationHistoryInput): Promise<DshDelegationHistoryResult> {
    const agentId = assertText(input.agentId, 'agentId');
    const runtimeInstanceId = assertText(input.runtimeInstanceId, 'runtimeInstanceId');
    if (input.sessionIds.length > this.maxSummaries) throw new Error('DSH child history target limit exceeded');
    const output: DshDelegationHistoryResult = {
      projectedSessionIds: [], projectedEventCount: 0, terminalSessionIds: [], failedSessionIds: [], errors: []
    };
    for (const sessionId of input.sessionIds) {
      if (input.signal?.aborted) throw new Error('DSH delegation history projection was aborted');
      let upstreamSessionId = sessionId;
      let session!: DshSessionRecord;
      try {
        session = this.sessions.getSession(assertText(sessionId, 'sessionId'));
        upstreamSessionId = session.upstreamSessionId;
        if (session.runtimeInstanceId !== runtimeInstanceId || session.parentSessionId === null) {
          throw new Error('session is outside the child projection boundary');
        }
        // The agent argument is part of the scope even though getSession is
        // already ownership checked by the database foreign keys.
        const scoped = this.sessions.findSessionByUpstream(agentId, session.upstreamSessionId);
        if (!scoped || scoped.sessionId !== session.sessionId) throw new Error('session agent boundary mismatch');
      } catch (error) {
        output.errors.push({ upstreamSessionId, sessionId, reason: 'invalid-history-target', detail: safeDetail(error) });
        continue;
      }
      try {
        const events = await this.readAllHistory(input.client, session.upstreamSessionId, input.signal);
        const runId = this.runId(runtimeInstanceId, session.upstreamSessionId);
        const priorRun = this.sessions.findRun(runId);
        const state = runStateFor({
          sessionId: session.upstreamSessionId,
          updatedAt: session.updatedAt,
          running: priorRun?.upstreamState === 'RUNNING',
          blank: false
        }, events, priorRun?.upstreamState);
        this.sessions.upsertRun({ id: runId, sessionId: session.sessionId, upstreamState: state });
        let projected = 0;
        const cursor = this.sessions.getSession(session.sessionId).lastEventCursor;
        for (const event of events) {
          if (event.seq <= cursor) continue;
          await this.sessions.projectEvent({
            sessionId: session.sessionId,
            runId,
            seq: event.seq,
            type: event.type,
            protocolVersion: PROTOCOL_VERSION,
            payload: eventPayload(event),
            createdAt: Number.isSafeInteger(event.time) && event.time >= 0 ? event.time : this.now()
          });
          projected += 1;
        }
        // Re-read after projection so the state update is attached to the
        // durable cursor and can be resumed safely after a restart.
        const finalState = runStateFor({
          sessionId: session.upstreamSessionId,
          updatedAt: session.updatedAt,
          running: priorRun?.upstreamState === 'RUNNING',
          blank: false
        }, events, priorRun?.upstreamState);
        this.sessions.upsertRun({ id: runId, sessionId: session.sessionId, upstreamState: finalState });
        output.projectedSessionIds.push(session.sessionId);
        output.projectedEventCount += projected;
        if (TERMINAL_REASONS.has(finalState.toLowerCase())) output.terminalSessionIds.push(session.sessionId);
        if (['FAILED', 'ERROR', 'INTERRUPTED', 'ABORTED', 'EXPIRED'].includes(finalState)) output.failedSessionIds.push(session.sessionId);
      } catch (error) {
        if (isAbort(error)) throw error;
        output.errors.push({ upstreamSessionId: session.upstreamSessionId, sessionId, reason: 'history-projection-failed', detail: safeDetail(error) });
      }
    }
    return output;
  }

  private findScopedParent(
    agentId: string,
    runtimeInstanceId: string,
    upstreamSessionId: string,
    result: DshDelegationSyncResult
  ): DshSessionRecord | null {
    try {
      const parent = this.sessions.findSessionByUpstream(agentId, upstreamSessionId);
      if (!parent) return null;
      if (parent.runtimeInstanceId !== runtimeInstanceId) {
        result.rejected.push({ upstreamSessionId, reason: 'parent-runtime-boundary' });
        return null;
      }
      return parent;
    } catch (error) {
      result.rejected.push({ upstreamSessionId, reason: 'parent-lookup-failed', detail: safeDetail(error) });
      return null;
    }
  }

  private registerChild(
    input: {
      summary: DshSessionSummary;
      parent: DshSessionRecord;
      agentId: string;
      runtimeInstanceId: string;
      workspace?: string;
      controlMode?: DshSessionInput['controlMode'];
    },
    result: DshDelegationSyncResult
  ): { session: DshSessionRecord; created: boolean; runId: string } | null {
    const { summary, parent } = input;
    if (parent.agentId !== input.agentId || parent.runtimeInstanceId !== input.runtimeInstanceId) {
      result.rejected.push({ upstreamSessionId: summary.sessionId, parentSessionId: summary.parentSessionId, reason: 'parent-boundary' });
      return null;
    }
    let existing: DshSessionRecord | null = null;
    try {
      existing = this.sessions.findSessionByUpstream(input.agentId, summary.sessionId);
    } catch (error) {
      result.rejected.push({ upstreamSessionId: summary.sessionId, parentSessionId: summary.parentSessionId, reason: 'child-lookup-failed', detail: safeDetail(error) });
      return null;
    }
    if (existing) {
      if (existing.runtimeInstanceId !== input.runtimeInstanceId
        || existing.parentSessionId !== parent.sessionId) {
        result.rejected.push({ upstreamSessionId: summary.sessionId, parentSessionId: summary.parentSessionId, reason: 'child-boundary' });
        return null;
      }
      this.ensureSummaryRun(existing, summary, input.runtimeInstanceId);
      return { session: existing, created: false, runId: this.runId(input.runtimeInstanceId, summary.sessionId) };
    }
    let id: string;
    try {
      id = assertText(this.localSessionId(input.runtimeInstanceId, summary.sessionId), 'localSessionId', MAX_ID_LENGTH);
    } catch (error) {
      result.rejected.push({ upstreamSessionId: summary.sessionId, parentSessionId: summary.parentSessionId, reason: 'local-id-failed', detail: safeDetail(error) });
      return null;
    }
    const childInput: DshChildSessionInput = {
      id,
      upstreamSessionId: summary.sessionId,
      runtimeInstanceId: input.runtimeInstanceId,
      agentId: input.agentId,
      conversationId: parent.conversationId,
      // The upstream cwd is display metadata, not an authority to move a
      // child outside the user-selected workspace. Keep the durable projection
      // inside the trusted parent/work-order workspace boundary.
      workspace: input.workspace ?? parent.workspace,
      controlMode: input.controlMode ?? 'DELEGATED',
      parentSessionId: parent.sessionId
    };
    if (childInput.controlMode !== 'DELEGATED') {
      result.rejected.push({
        upstreamSessionId: summary.sessionId,
        parentSessionId: summary.parentSessionId,
        reason: 'child-control-mode',
        detail: 'DSH subagent projections must use DELEGATED control mode'
      });
      return null;
    }
    try {
      const session = this.delegation.createChildSession(childInput);
      this.ensureSummaryRun(session, summary, input.runtimeInstanceId);
      return { session, created: true, runId: this.runId(input.runtimeInstanceId, summary.sessionId) };
    } catch (error) {
      result.rejected.push({ upstreamSessionId: summary.sessionId, parentSessionId: summary.parentSessionId, reason: 'child-registration-failed', detail: safeDetail(error) });
      return null;
    }
  }

  private runId(runtimeInstanceId: string, upstreamSessionId: string): string {
    return `dsh-subagent-run-${hashId(runtimeInstanceId, upstreamSessionId).slice('dsh-child-'.length)}`;
  }

  private ensureSummaryRun(session: DshSessionRecord, summary: DshSessionSummary, runtimeInstanceId: string): void {
    this.sessions.upsertRun({
      id: this.runId(runtimeInstanceId, summary.sessionId),
      sessionId: session.sessionId,
      upstreamState: summary.running ? 'RUNNING' : 'COMPLETED'
    });
  }

  private async readAllHistory(client: DshControlPort, upstreamSessionId: string, signal?: AbortSignal): Promise<DshSessionEvent[]> {
    const collected = new Map<number, DshSessionEvent>();
    let beforeSeq: number | undefined;
    let exhausted = false;
    for (let page = 0; page < this.maxHistoryPages; page += 1) {
      const history = await client.readHistory({
        sessionId: upstreamSessionId,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
        maxMessages: this.historyPageSize
      }, signal);
      const events = sortEvents(history.events);
      if (events.length === 0) {
        if (history.hasMore) throw new Error('DSH child history returned an empty page with more events');
        exhausted = true;
        break;
      }
      for (const event of events) collected.set(event.seq, event);
      const minimum = events[0]!.seq;
      if (!history.hasMore) {
        exhausted = true;
        break;
      }
      if (beforeSeq !== undefined && minimum >= beforeSeq) throw new Error('DSH child history cursor did not move');
      beforeSeq = minimum;
    }
    if (!exhausted) throw new Error('DSH child history page limit exceeded');
    return [...collected.values()].sort((left, right) => left.seq - right.seq);
  }
}
