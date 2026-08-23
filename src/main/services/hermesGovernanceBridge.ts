import { createHash, randomUUID } from 'node:crypto';
import type {
  HermesClarifyRequest,
  HermesDelegationRequest,
  HermesProjectConversationView,
  HermesPlanDraft,
  HermesPlanProjection
} from '../../shared/types.js';
import type { Database } from './database.js';
import { assertHermesDelegationRequest, assertHermesPlanDraft, parseHermesControlMessage } from './hermesProtocol.js';
import { HermesDeliveryGate, type HermesDeliveryGateResult } from './hermesDeliveryGate.js';

const SAFE_RELATIVE_PATH = /^(?![A-Za-z]:)(?![\\/])[A-Za-z0-9._-]+(?:[\\/][A-Za-z0-9._-]+)*$/;
const QUESTION_KINDS = new Set<HermesClarifyRequest['questionKind']>(['scope', 'acceptance', 'risk', 'budget', 'execution']);

export interface HermesClarifyAnswer {
  clarifyId: string;
  projectId: string;
  principalId: string;
  answer: unknown;
}

export interface HermesPlanAdmission {
  draftId: string;
  projectId: string;
  conversationId: string;
  hash: string;
  draft: HermesPlanDraft;
  admittedAt: number;
}

export interface HermesDelegationAdmission {
  requestId: string;
  projectId: string;
  request: HermesDelegationRequest;
  status: 'ADMITTED' | 'DISPATCHED' | 'REJECTED';
  createdAt: number;
}

export interface HermesDelegationProjector {
  project(request: HermesDelegationRequest, admission: HermesDelegationAdmission): {
    jobIds: string[];
    runIds: Array<string | null>;
    planHash: string;
  };
}

export interface HermesPlanProjector {
  project(draft: HermesPlanDraft, admission: HermesPlanAdmission): Promise<{
    governanceSessionId: string;
    sessionId: string;
    planId: string;
    version: number;
    hash: string;
  }>;
  approve(projection: HermesPlanProjection, principalId: string): Promise<void>;
  dispatch(projection: HermesPlanProjection, principalId: string): Promise<void>;
}

export interface HermesClarifyResponder {
  respond(projectId: string, clarifyId: string, answer: unknown): Promise<{ content?: string } | void>;
}

interface ClarifyRow {
  clarify_id: string;
  project_id: string;
  conversation_id: string;
  question_kind: HermesClarifyRequest['questionKind'];
  prompt: string;
  options_json: string;
  allow_other: number;
  expires_at: number | null;
  required: number;
  channel_targets_json: string;
  status: HermesClarifyRequest['status'];
  answer_json: string | null;
}

function json(value: unknown, field: string, maxBytes = 512_000): string {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); }
  catch { throw new Error(`${field} is not serializable`); }
  if (typeof encoded !== 'string') throw new Error(`${field} is not serializable`);
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) throw new Error(`${field} exceeds the size limit`);
  return encoded;
}

function parseArray(value: string, field: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) throw new Error('array expected');
    return parsed;
  } catch { throw new Error(`${field} persistence is corrupt`); }
}

/** Durable, host-governed bridge for Hermes planning and execution facts. */
export class HermesGovernanceBridge {
  private readonly deliveryGate: HermesDeliveryGate;
  private planProjector: HermesPlanProjector | null = null;
  private clarifyResponder: HermesClarifyResponder | null = null;
  private delegationProjector: HermesDelegationProjector | null = null;
  private readonly planProjectionTasks = new Map<string, Promise<HermesPlanProjection>>();
  private readonly clarifyResumeTasks = new Map<string, Promise<string | null>>();

  constructor(private readonly db: Database, private readonly now: () => number = Date.now) {
    this.deliveryGate = new HermesDeliveryGate(db);
    this.db.raw.prepare(`
      CREATE TABLE IF NOT EXISTS hermes_clarify_requests (
        clarify_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        question_kind TEXT NOT NULL,
        prompt TEXT NOT NULL,
        options_json TEXT NOT NULL DEFAULT '[]',
        allow_other INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER,
        required INTEGER NOT NULL DEFAULT 1,
        channel_targets_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'OPEN',
        answer_json TEXT,
        answered_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `).run();
    this.db.raw.prepare(`
      CREATE TABLE IF NOT EXISTS hermes_plan_drafts (
        draft_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'DRAFT',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `).run();
    this.db.raw.prepare(`
      CREATE TABLE IF NOT EXISTS hermes_delegation_requests (
        request_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        parent_session_id TEXT NOT NULL,
        parent_run_id TEXT NOT NULL,
        worker_agent_id TEXT NOT NULL REFERENCES agents(id),
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ADMITTED',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `).run();
    this.db.raw.prepare(`
      CREATE TABLE IF NOT EXISTS hermes_plan_projections (
        draft_id TEXT PRIMARY KEY REFERENCES hermes_plan_drafts(draft_id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        governance_session_id TEXT NOT NULL,
        hermes_session_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        plan_version INTEGER NOT NULL,
        plan_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PROJECTED',
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `).run();
    this.migrateLegacyPlanProjectionColumns();
    this.db.raw.prepare(`
      CREATE TABLE IF NOT EXISTS hermes_clarify_resumes (
        clarify_id TEXT PRIMARY KEY REFERENCES hermes_clarify_requests(clarify_id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'PENDING',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at INTEGER NOT NULL
      )
    `).run();
    this.db.raw.prepare(`
      CREATE TABLE IF NOT EXISTS hermes_plan_jobs (
        draft_id TEXT NOT NULL REFERENCES hermes_plan_drafts(draft_id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        created_at INTEGER NOT NULL,
        PRIMARY KEY(draft_id, node_id),
        UNIQUE(task_id)
      )
    `).run();
    this.db.raw.prepare(`
      CREATE TABLE IF NOT EXISTS hermes_conversation_profiles (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        employee_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `).run();
  }

  attachPlanProjector(projector: HermesPlanProjector): void {
    this.planProjector = projector;
  }

  attachClarifyResponder(responder: HermesClarifyResponder): void {
    this.clarifyResponder = responder;
  }

  attachDelegationProjector(projector: HermesDelegationProjector): void {
    this.delegationProjector = projector;
  }

  /** Main-owned answer used by UI and channels before exposing plan output. */
  getDeliveryGate(taskId: string): HermesDeliveryGateResult {
    return this.deliveryGate.check(taskId);
  }

  async handleClientControlMessage(projectId: string, value: unknown): Promise<{ handled: boolean; result?: unknown }> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { handled: false };
    const frame = value as Record<string, unknown>;
    if (frame.method !== 'clarify.respond') return { handled: false };
    const params = frame.params && typeof frame.params === 'object' && !Array.isArray(frame.params)
      ? frame.params as Record<string, unknown> : null;
    const clarifyId = typeof params?.request_id === 'string' ? params.request_id : '';
    if (!clarifyId) throw new Error('Hermes clarification response has no request identity');
    const row = this.db.raw.prepare(`
      SELECT h.project_id, c.principal_id
      FROM hermes_clarify_requests h
      JOIN conversations c ON c.id = h.conversation_id
      WHERE h.clarify_id = ? AND h.project_id = ?
    `).get(clarifyId, projectId) as { project_id?: string; principal_id?: string | null } | undefined;
    if (row?.project_id !== projectId || !row.principal_id) throw new Error('Hermes clarification is not bound to this project owner');
    const answered = await this.answerClarify({
      clarifyId,
      projectId,
      principalId: row.principal_id,
      answer: params?.answer
    });
    return { handled: true, result: { ok: true, request_id: answered.clarifyId } };
  }

  async handleHostRequest(projectId: string, operation: string, value: unknown): Promise<unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Hermes host request must be an object');
    const input = value as Record<string, unknown>;
    if (operation === 'clarify') {
      const hermesSessionId = typeof input.hermesSessionId === 'string' ? input.hermesSessionId.trim() : '';
      const clarifyId = typeof input.clarifyId === 'string' ? input.clarifyId.trim() : '';
      const prompt = typeof input.question === 'string' ? input.question.trim() : '';
      if (!hermesSessionId || hermesSessionId.length > 256) throw new Error('Hermes clarification has no valid session identity');
      if (!clarifyId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(clarifyId)) throw new Error('Hermes clarification identity is invalid');
      if (!prompt || prompt.length > 8_000) throw new Error('Hermes clarification prompt is invalid');
      const binding = this.ensureSessionBinding(projectId, hermesSessionId);
      const choices = Array.isArray(input.choices) ? input.choices : [];
      const request = this.persistClarify({
        clarifyId,
        projectId,
        conversationId: binding.conversationId,
        questionKind: 'execution',
        prompt,
        options: choices.slice(0, 32).map((choice, index) => ({
          id: `option-${index + 1}`,
          label: String(choice).trim().slice(0, 500)
        })).filter((choice) => choice.label.length > 0),
        allowOther: true,
        expiresAt: null,
        required: true,
        channelTargets: [],
        status: 'OPEN'
      });
      return { clarifyId: request.clarifyId, status: request.status, conversationId: request.conversationId };
    }
    if (operation !== 'submit-plan') throw new Error(`Unsupported OPC-Nexus host operation: ${operation}`);
    const hermesSessionId = typeof input.hermesSessionId === 'string' ? input.hermesSessionId.trim() : '';
    const model = typeof input.model === 'string' ? input.model.trim() : '';
    if (!hermesSessionId || hermesSessionId.length > 256) throw new Error('Hermes host plan has no valid session identity');
    if (!model || model.length > 256) throw new Error('Hermes host plan has no valid model identity');
    if (!input.draft || typeof input.draft !== 'object' || Array.isArray(input.draft)) throw new Error('Hermes host plan draft is invalid');
    const binding = this.ensureSessionBinding(projectId, hermesSessionId);
    const pending = this.db.raw.prepare(`
      SELECT clarify_id FROM hermes_clarify_requests
      WHERE project_id = ? AND conversation_id = ? AND status = 'OPEN'
      ORDER BY created_at LIMIT 1
    `).get(projectId, binding.conversationId) as { clarify_id?: string } | undefined;
    if (pending?.clarify_id) throw new Error(`Hermes plan is blocked by unanswered clarification ${pending.clarify_id}`);
    const admission = this.admitPlanDraft({
      ...(input.draft as Record<string, unknown>),
      projectId,
      conversationId: binding.conversationId,
      source: 'hermes',
      model
    });
    return this.projectPlanAdmission(admission);
  }

  persistClarify(request: HermesClarifyRequest): HermesClarifyRequest {
    this.assertProjectConversation(request.projectId, request.conversationId);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(request.clarifyId)) throw new Error('clarifyId is invalid');
    if (!QUESTION_KINDS.has(request.questionKind)) throw new Error('clarify question kind is invalid');
    if (typeof request.prompt !== 'string' || request.prompt.trim().length === 0 || request.prompt.length > 8_000) {
      throw new Error('clarify prompt is invalid');
    }
    if (!Array.isArray(request.options) || request.options.length > 32 || !Array.isArray(request.channelTargets)) {
      throw new Error('clarify options are invalid');
    }
    if (request.expiresAt !== null && (!Number.isSafeInteger(request.expiresAt) || request.expiresAt <= this.now())) {
      throw new Error('clarify expiry must be in the future');
    }
    const existing = this.db.raw.prepare(
      'SELECT status, project_id, conversation_id FROM hermes_clarify_requests WHERE clarify_id = ?'
    ).get(request.clarifyId) as { status?: string; project_id?: string; conversation_id?: string } | undefined;
    if (existing) {
      if (existing.project_id !== request.projectId || existing.conversation_id !== request.conversationId) throw new Error('clarify identity conflict');
      if (existing.status !== 'OPEN' && request.status === 'OPEN') throw new Error('answered clarify cannot be reopened');
      return this.getClarify(request.clarifyId)!;
    }
    const createdAt = this.now();
    this.db.raw.prepare(`
      INSERT INTO hermes_clarify_requests(
        clarify_id, project_id, conversation_id, question_kind, prompt, options_json,
        allow_other, expires_at, required, channel_targets_json, status, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)
    `).run(
      request.clarifyId,
      request.projectId,
      request.conversationId,
      request.questionKind,
      request.prompt.trim(),
      json(request.options, 'clarify options'),
      request.allowOther ? 1 : 0,
      request.expiresAt,
      request.required ? 1 : 0,
      json(request.channelTargets, 'clarify channel targets', 32_000),
      createdAt,
      createdAt
    );
    this.audit('hermes.clarify.open', request.projectId, request.clarifyId, 'OPEN');
    return this.getClarify(request.clarifyId)!;
  }

  async answerClarify(input: HermesClarifyAnswer): Promise<HermesClarifyRequest> {
    const existing = this.db.raw.prepare('SELECT * FROM hermes_clarify_requests WHERE clarify_id = ?').get(input.clarifyId) as unknown as ClarifyRow | undefined;
    if (!existing || existing.project_id !== input.projectId) throw new Error('clarify request not found in this project');
    if (existing.status === 'ANSWERED') {
      await this.resumeClarification(existing.clarify_id, existing.project_id).catch(() => undefined);
      return this.toClarify(existing);
    }
    if (existing.status !== 'OPEN') throw new Error(`clarify request is ${existing.status}`);
    if (existing.expires_at !== null && existing.expires_at <= this.now()) {
      this.expire(input.clarifyId);
      throw new Error('clarify request has expired');
    }
    if (typeof input.principalId !== 'string' || input.principalId.length < 1 || input.principalId.length > 128) throw new Error('principalId is invalid');
    const principal = this.db.raw.prepare(
      `SELECT pr.id FROM principals pr JOIN projects p ON p.organization_id = pr.organization_id
       WHERE pr.id = ? AND p.id = ?`
    ).get(input.principalId, input.projectId) as { id?: string } | undefined;
    if (principal?.id !== input.principalId) throw new Error('clarify principal is outside the project organization');
    const answer = json(input.answer, 'clarify answer', 64_000);
    const now = this.now();
    this.db.transaction(() => {
      this.db.raw.prepare(
        `UPDATE hermes_clarify_requests SET status = 'ANSWERED', answer_json = ?, answered_at = ?, updated_at = ? WHERE clarify_id = ? AND status = 'OPEN'`
      ).run(answer, now, now, input.clarifyId);
      this.db.raw.prepare(`
        INSERT INTO hermes_clarify_resumes(clarify_id, project_id, status, attempts, last_error, updated_at)
        VALUES(?, ?, 'PENDING', 0, NULL, ?)
        ON CONFLICT(clarify_id) DO UPDATE SET status = 'PENDING', last_error = NULL, updated_at = excluded.updated_at
      `).run(input.clarifyId, input.projectId, now);
    });
    this.audit('hermes.clarify.answer', input.projectId, input.clarifyId, `principal=${input.principalId}`);
    void this.resumeClarification(input.clarifyId, input.projectId).catch(() => undefined);
    return this.getClarify(input.clarifyId)!;
  }

  /** Channel callers need the continued Hermes turn, while desktop/mobile UI
   * can keep the non-blocking answerClarify behavior. Both paths join the same
   * per-clarify resume promise, so the answer is consumed exactly once. */
  async answerClarifyAndWait(input: HermesClarifyAnswer): Promise<{
    request: HermesClarifyRequest;
    content: string | null;
  }> {
    const request = await this.answerClarify(input);
    const content = await this.resumeClarification(input.clarifyId, input.projectId);
    return { request, content };
  }

  async resumePendingClarifications(projectId: string): Promise<void> {
    const rows = this.db.raw.prepare(`
      SELECT clarify_id FROM hermes_clarify_resumes
      WHERE project_id = ? AND status IN ('PENDING', 'FAILED')
      ORDER BY updated_at, clarify_id LIMIT 50
    `).all(projectId) as Array<{ clarify_id: string }>;
    for (const row of rows) await this.resumeClarification(row.clarify_id, projectId).catch(() => undefined);
  }

  private async resumeClarification(clarifyId: string, projectId: string): Promise<string | null> {
    const active = this.clarifyResumeTasks.get(clarifyId);
    if (active) return active;
    const task = this.performClarificationResume(clarifyId, projectId)
      .finally(() => this.clarifyResumeTasks.delete(clarifyId));
    this.clarifyResumeTasks.set(clarifyId, task);
    return task;
  }

  private async performClarificationResume(clarifyId: string, projectId: string): Promise<string | null> {
    const row = this.db.raw.prepare(`
      SELECT h.answer_json, r.status
      FROM hermes_clarify_requests h
      JOIN hermes_clarify_resumes r ON r.clarify_id = h.clarify_id
      WHERE h.clarify_id = ? AND h.project_id = ? AND h.status = 'ANSWERED'
    `).get(clarifyId, projectId) as { answer_json?: string | null; status?: string } | undefined;
    if (!row || row.status === 'RESUMED' || row.answer_json === null || row.answer_json === undefined) return null;
    if (!this.clarifyResponder) throw new Error('Hermes clarification responder is unavailable');
    let answer: unknown;
    try { answer = JSON.parse(row.answer_json) as unknown; }
    catch { throw new Error('Hermes clarification answer persistence is corrupt'); }
    try {
      const response = await this.clarifyResponder.respond(projectId, clarifyId, answer);
      this.db.raw.prepare(`
        UPDATE hermes_clarify_resumes SET status = 'RESUMED', attempts = attempts + 1,
          last_error = NULL, updated_at = ? WHERE clarify_id = ? AND project_id = ?
      `).run(this.now(), clarifyId, projectId);
      this.audit('hermes.clarify.resume', projectId, clarifyId, 'RESUMED');
      const content = response && typeof response === 'object' && typeof response.content === 'string'
        ? response.content.trim()
        : '';
      return content || null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.raw.prepare(`
        UPDATE hermes_clarify_resumes SET status = 'FAILED', attempts = attempts + 1,
          last_error = ?, updated_at = ? WHERE clarify_id = ? AND project_id = ?
      `).run(message.slice(0, 4_000), this.now(), clarifyId, projectId);
      this.audit('hermes.clarify.resume', projectId, clarifyId, `FAILED:${message.slice(0, 500)}`);
      throw error;
    }
  }

  expire(clarifyId: string): void {
    const now = this.now();
    this.db.transaction(() => {
      this.db.raw.prepare(
        `UPDATE hermes_clarify_requests SET status = 'EXPIRED', updated_at = ? WHERE clarify_id = ? AND status = 'OPEN'`
      ).run(now, clarifyId);
    });
  }

  expireDue(): number {
    const now = this.now();
    const due = this.db.raw.prepare(
      `SELECT clarify_id FROM hermes_clarify_requests WHERE status = 'OPEN' AND expires_at IS NOT NULL AND expires_at <= ?`
    ).all(now) as Array<{ clarify_id: string }>;
    for (const row of due) this.expire(row.clarify_id);
    return due.length;
  }

  listOpen(projectId: string, conversationId?: string): HermesClarifyRequest[] {
    this.expireDue();
    const rows = conversationId === undefined
      ? this.db.raw.prepare('SELECT * FROM hermes_clarify_requests WHERE project_id = ? AND status = \'OPEN\' ORDER BY created_at').all(projectId)
      : this.db.raw.prepare('SELECT * FROM hermes_clarify_requests WHERE project_id = ? AND conversation_id = ? AND status = \'OPEN\' ORDER BY created_at').all(projectId, conversationId);
    return (rows as unknown as ClarifyRow[]).map((row) => this.toClarify(row));
  }

  getClarify(clarifyId: string): HermesClarifyRequest | null {
    const row = this.db.raw.prepare('SELECT * FROM hermes_clarify_requests WHERE clarify_id = ?').get(clarifyId) as unknown as ClarifyRow | undefined;
    return row ? this.toClarify(row) : null;
  }

  admitPlanDraft(draftInput: unknown): HermesPlanAdmission {
    const draft = assertHermesPlanDraft(draftInput);
    this.assertProjectConversation(draft.projectId, draft.conversationId);
    this.assertWorkers(draft);
    this.assertDag(draft);
    for (const artifact of draft.expectedArtifacts) {
      if (!artifact || typeof artifact !== 'object' || !SAFE_RELATIVE_PATH.test(String(artifact.relativePath ?? ''))) {
        throw new Error('Hermes artifact path must remain project-relative');
      }
    }
    const payload = json(draft, 'Hermes plan draft');
    const hash = createHash('sha256').update(payload).digest('hex');
    const existing = this.db.raw.prepare(`
      SELECT draft_id, created_at FROM hermes_plan_drafts
      WHERE project_id = ? AND conversation_id = ? AND payload_hash = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(draft.projectId, draft.conversationId, hash) as { draft_id?: string; created_at?: number } | undefined;
    if (existing?.draft_id) {
      return {
        draftId: existing.draft_id,
        projectId: draft.projectId,
        conversationId: draft.conversationId,
        hash,
        draft,
        admittedAt: Number(existing.created_at ?? this.now())
      };
    }
    const draftId = `hermes-draft-${randomUUID()}`;
    const now = this.now();
    this.db.raw.prepare(`
      INSERT INTO hermes_plan_drafts(draft_id, project_id, conversation_id, model, payload_json, payload_hash, status, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)
    `).run(draftId, draft.projectId, draft.conversationId, draft.model, payload, hash, now, now);
    this.audit('hermes.plan.draft', draft.projectId, draftId, `hash=${hash}`);
    return { draftId, projectId: draft.projectId, conversationId: draft.conversationId, hash, draft, admittedAt: now };
  }

  /** Convert an upstream Hermes event into a durable Nexus-governed request. */
  ingestControlMessage(projectId: string, value: unknown): HermesClarifyRequest | HermesPlanAdmission | HermesDelegationAdmission | null {
    const frame = this.gatewayEvent(value);
    if (frame?.type === 'clarify.expire') {
      const clarifyId = typeof frame.payload.request_id === 'string' ? frame.payload.request_id : '';
      if (clarifyId) this.expire(clarifyId);
      return null;
    }
    const message = parseHermesControlMessage(value);
    if (!message) return null;
    if (message.type === 'clarify.request') {
      const request = this.normalizeClarify(projectId, frame, message.request);
      if (request.projectId !== projectId) throw new Error('Hermes clarify project scope does not match the service');
      return this.persistClarify(request);
    }
    if (message.type === 'plan.draft') {
      if (message.draft.projectId !== projectId) throw new Error('Hermes plan project scope does not match the service');
      const admission = this.admitPlanDraft(message.draft);
      if (this.planProjector) void this.projectPlanAdmission(admission).catch(() => undefined);
      return admission;
    }
    const request = assertHermesDelegationRequest(message.request);
    if (request.projectId !== projectId) throw new Error('Hermes delegation project scope does not match the service');
    return this.admitDelegation(request);
  }

  private gatewayEvent(value: unknown): { type: string; sessionId: string | null; payload: Record<string, unknown> } | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const root = value as Record<string, unknown>;
    const event = root.method === 'event' && root.params && typeof root.params === 'object'
      ? root.params as Record<string, unknown> : root;
    if (typeof event.type !== 'string') return null;
    return {
      type: event.type,
      sessionId: typeof event.session_id === 'string' ? event.session_id : null,
      payload: event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? event.payload as Record<string, unknown> : event
    };
  }

  private normalizeClarify(
    projectId: string,
    frame: ReturnType<HermesGovernanceBridge['gatewayEvent']>,
    raw: HermesClarifyRequest
  ): HermesClarifyRequest {
    if (raw.projectId && raw.conversationId && raw.prompt) return { ...raw, projectId };
    if (!frame?.sessionId) throw new Error('Hermes clarify event has no session identity');
    const binding = this.ensureSessionBinding(projectId, frame.sessionId);
    const choices = Array.isArray(frame.payload.choices) ? frame.payload.choices : [];
    return {
      clarifyId: typeof frame.payload.request_id === 'string' ? frame.payload.request_id : `clarify-${randomUUID()}`,
      projectId,
      conversationId: binding.conversationId,
      questionKind: 'execution',
      prompt: typeof frame.payload.question === 'string' ? frame.payload.question : 'Please confirm the execution boundary.',
      options: choices.slice(0, 32).map((choice, index) => ({ id: `option-${index + 1}`, label: String(choice).slice(0, 500) })),
      allowOther: true,
      expiresAt: null,
      required: true,
      channelTargets: [],
      status: 'OPEN'
    };
  }

  ensureSessionBinding(
    projectId: string,
    hermesSessionId: string,
    requested?: { conversationId: string; principalId: string }
  ): { conversationId: string; principalId: string } {
    if (!hermesSessionId || hermesSessionId.length > 256 || /[\r\n\0]/.test(hermesSessionId)) {
      throw new Error('Hermes session identity is invalid');
    }
    const existing = this.db.raw.prepare(
      'SELECT conversation_id, principal_id FROM hermes_session_bindings WHERE project_id = ? AND hermes_session_id = ?'
    ).get(projectId, hermesSessionId) as { conversation_id?: string; principal_id?: string } | undefined;
    if (existing?.conversation_id && existing.principal_id) {
      if (requested && (existing.conversation_id !== requested.conversationId || existing.principal_id !== requested.principalId)) {
        throw new Error('Hermes session is already bound to another conversation');
      }
      this.assertProjectConversation(projectId, existing.conversation_id);
      return { conversationId: existing.conversation_id, principalId: existing.principal_id };
    }
    if (requested) {
      const target = this.db.raw.prepare(`
        SELECT c.id AS conversation_id, c.principal_id, c.organization_id,
               p.organization_id AS principal_organization_id,
               project.organization_id AS project_organization_id
        FROM conversations c
        JOIN projects project ON project.id = c.project_id AND project.status <> 'archived'
        JOIN principals p ON p.id = ?
        WHERE c.id = ? AND c.project_id = ?
      `).get(requested.principalId, requested.conversationId, projectId) as {
        conversation_id?: string;
        principal_id?: string | null;
        organization_id?: string | null;
        principal_organization_id?: string;
        project_organization_id?: string;
      } | undefined;
      if (target?.conversation_id !== requested.conversationId
        || target.principal_id !== requested.principalId
        || target.organization_id !== target.project_organization_id
        || target.principal_organization_id !== target.project_organization_id) {
        throw new Error('Hermes conversation or principal is outside the project scope');
      }
      const conflicting = this.db.raw.prepare(`
        SELECT hermes_session_id FROM hermes_session_bindings
        WHERE project_id = ? AND conversation_id = ?
      `).get(projectId, requested.conversationId) as { hermes_session_id?: string } | undefined;
      if (conflicting?.hermes_session_id && conflicting.hermes_session_id !== hermesSessionId) {
        throw new Error('Hermes conversation is already bound to another session');
      }
      this.db.raw.prepare(`
        INSERT INTO hermes_session_bindings(project_id, principal_id, conversation_id, hermes_session_id, last_seen_at)
        VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(project_id, conversation_id) DO UPDATE SET
          principal_id = excluded.principal_id,
          hermes_session_id = excluded.hermes_session_id,
          last_seen_at = excluded.last_seen_at
      `).run(projectId, requested.principalId, requested.conversationId, hermesSessionId, this.now());
      this.audit('hermes.session.bind', projectId, hermesSessionId, `conversation=${requested.conversationId}`);
      return requested;
    }
    const owner = this.db.raw.prepare(`
      SELECT p.organization_id, a.id AS agent_id, pr.id AS principal_id
      FROM projects p
      JOIN agents a ON a.organization_id = p.organization_id AND a.archived = 0
        AND a.engine_id NOT IN ('eng-deepseek-harness', 'eng-deepseek-harness-managed')
      JOIN principals pr ON pr.organization_id = p.organization_id
      WHERE p.id = ? AND p.status <> 'archived'
       ORDER BY CASE WHEN pr.id = 'principal-local-admin' THEN 0 ELSE 1 END,
                a.created_at, a.id LIMIT 1
    `).get(projectId) as { organization_id?: string; agent_id?: string; principal_id?: string } | undefined;
    if (!owner?.organization_id || !owner.agent_id || !owner.principal_id) throw new Error('Hermes project has no owner or employee for a conversation binding');
    const conversationId = `hermes-conversation-${randomUUID()}`;
    const now = this.now();
    this.db.raw.prepare(`
      INSERT INTO conversations(id, agent_id, project_id, organization_id, principal_id, title, last_message_at, message_count, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, 'Hermes Workbench', ?, 0, ?, ?)
    `).run(conversationId, owner.agent_id, projectId, owner.organization_id, owner.principal_id, now, now, now);
    this.db.raw.prepare(`
      INSERT INTO hermes_session_bindings(project_id, principal_id, conversation_id, hermes_session_id, last_seen_at)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(project_id, conversation_id) DO UPDATE SET hermes_session_id = excluded.hermes_session_id, last_seen_at = excluded.last_seen_at
    `).run(projectId, owner.principal_id, conversationId, hermesSessionId, now);
    this.audit('hermes.session.bind', projectId, hermesSessionId, `conversation=${conversationId}`);
    return { conversationId, principalId: owner.principal_id };
  }

  createConversation(projectId: string, input: { employeeId?: string; title?: string } = {}): HermesProjectConversationView {
    const project = this.db.raw.prepare(`
      SELECT id, organization_id FROM projects WHERE id = ? AND status <> 'archived'
    `).get(projectId) as { id?: string; organization_id?: string } | undefined;
    if (project?.id !== projectId || !project.organization_id) throw new Error('Hermes project is unavailable');
    const principal = this.db.raw.prepare(`
      SELECT id FROM principals WHERE organization_id = ?
      ORDER BY CASE WHEN id = 'principal-local-admin' THEN 0 ELSE 1 END, created_at, id LIMIT 1
    `).get(project.organization_id) as { id?: string } | undefined;
    if (!principal?.id) throw new Error('Hermes project has no owner principal');
    const requestedEmployeeId = input.employeeId?.trim() || null;
    const owner = requestedEmployeeId
      ? this.db.raw.prepare(`
          SELECT id, name, role, engine_id, memory_mode FROM agents
          WHERE id = ? AND organization_id = ? AND archived = 0 AND lifecycle = 'READY'
            AND engine_id NOT IN ('eng-deepseek-harness', 'eng-deepseek-harness-managed')
        `).get(requestedEmployeeId, project.organization_id) as Record<string, unknown> | undefined
      : this.db.raw.prepare(`
          SELECT id, name, role, engine_id, memory_mode FROM agents
          WHERE organization_id = ? AND archived = 0 AND lifecycle = 'READY'
            AND engine_id NOT IN ('eng-deepseek-harness', 'eng-deepseek-harness-managed')
          ORDER BY created_at, id LIMIT 1
        `).get(project.organization_id) as Record<string, unknown> | undefined;
    if (typeof owner?.id !== 'string') throw new Error('Hermes project has no eligible digital employee');
    const ownerId = owner.id;
    const title = (input.title?.trim() || (requestedEmployeeId ? `${String(owner.name)} · 员工会话` : 'Hermes 会话')).slice(0, 160);
    const conversationId = `hermes-conversation-${randomUUID()}`;
    const now = this.now();
    this.db.transaction(() => {
      this.db.raw.prepare(`
        INSERT INTO conversations(id, agent_id, project_id, organization_id, principal_id, title, last_message_at, message_count, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(conversationId, ownerId, projectId, project.organization_id, principal.id, title, now, now, now);
      this.db.raw.prepare(`
        INSERT INTO hermes_conversation_profiles(conversation_id, project_id, employee_id, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?)
      `).run(conversationId, projectId, requestedEmployeeId, now, now);
    });
    this.audit('hermes.conversation.create', projectId, conversationId,
      requestedEmployeeId ? `employee=${requestedEmployeeId}` : 'scheduler=hermes');
    return this.listConversations(projectId).find((item) => item.conversationId === conversationId)!;
  }

  listConversations(projectId: string): HermesProjectConversationView[] {
    const project = this.db.raw.prepare("SELECT id FROM projects WHERE id = ? AND status <> 'archived'")
      .get(projectId) as { id?: string } | undefined;
    if (project?.id !== projectId) throw new Error('Hermes project is unavailable');
    const rows = this.db.raw.prepare(`
      SELECT c.id, c.title, c.updated_at, c.last_message_at,
             b.hermes_session_id,
             p.employee_id, a.name AS employee_name, a.role AS employee_role,
             a.engine_id AS employee_engine_id, a.memory_mode AS employee_memory_mode
      FROM conversations c
      LEFT JOIN hermes_session_bindings b
        ON b.project_id = c.project_id AND b.conversation_id = c.id
      LEFT JOIN hermes_conversation_profiles p
        ON p.project_id = c.project_id AND p.conversation_id = c.id
      LEFT JOIN agents a ON a.id = p.employee_id AND a.archived = 0
      WHERE c.project_id = ?
        AND c.id LIKE 'hermes-conversation-%'
        AND (p.employee_id IS NULL OR a.id IS NOT NULL)
      ORDER BY COALESCE(b.last_seen_at, c.updated_at, c.last_message_at) DESC, c.id DESC
      LIMIT 100
    `).all(projectId) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const rawTitle = String(row.title || 'Hermes 会话');
      return {
        conversationId: String(row.id),
        title: rawTitle,
        employee: typeof row.employee_id === 'string' && typeof row.employee_name === 'string'
          ? {
              id: row.employee_id,
              name: row.employee_name,
              role: typeof row.employee_role === 'string' ? row.employee_role : '',
              engineId: typeof row.employee_engine_id === 'string' ? row.employee_engine_id : '',
              memoryMode: row.employee_memory_mode === 'long_term' || row.employee_memory_mode === 'none'
                ? row.employee_memory_mode : 'short_term'
            }
          : null,
        hasSession: typeof row.hermes_session_id === 'string' && row.hermes_session_id.length > 0,
        updatedAt: Number(row.updated_at ?? row.last_message_at ?? 0)
      };
    });
  }

  getConversationEmployee(projectId: string, conversationId: string): HermesProjectConversationView['employee'] {
    const conversation = this.listConversations(projectId).find((item) => item.conversationId === conversationId);
    if (!conversation) throw new Error('Hermes project conversation is unavailable');
    return conversation.employee;
  }

  listPlanProjections(projectId: string): HermesPlanProjection[] {
    const project = this.db.raw.prepare("SELECT id FROM projects WHERE id = ? AND status <> 'archived'").get(projectId) as { id?: string } | undefined;
    if (project?.id !== projectId) throw new Error('Hermes project is unavailable');
    const rows = this.db.raw.prepare('SELECT * FROM hermes_plan_projections WHERE project_id = ? ORDER BY updated_at DESC').all(projectId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.toPlanProjection(row));
  }

  async approvePlan(draftId: string, projectId: string, principalId: string): Promise<HermesPlanProjection> {
    if (!this.planProjector) throw new Error('OPC-Nexus plan governance is unavailable');
    const projection = this.requirePlanProjection(draftId, projectId);
    if (projection.status === 'APPROVED') return projection;
    if (projection.status !== 'PROJECTED') throw new Error(`Hermes plan is ${projection.status}`);
    await this.planProjector.approve(projection, principalId);
    this.db.raw.prepare("UPDATE hermes_plan_projections SET status = 'APPROVED', last_error = NULL, updated_at = ? WHERE draft_id = ? AND status = 'PROJECTED'")
      .run(this.now(), draftId);
    this.audit('hermes.plan.approve', projectId, draftId, `principal=${principalId}`);
    return this.requirePlanProjection(draftId, projectId);
  }

  async dispatchPlan(draftId: string, projectId: string, principalId: string): Promise<HermesPlanProjection> {
    if (!this.planProjector) throw new Error('OPC-Nexus plan governance is unavailable');
    const projection = this.requirePlanProjection(draftId, projectId);
    if (projection.status === 'DISPATCHED') return projection;
    if (projection.status !== 'APPROVED') throw new Error('Hermes plan must be boss-approved before dispatch');
    await this.planProjector.dispatch(projection, principalId);
    this.db.raw.prepare("UPDATE hermes_plan_projections SET status = 'DISPATCHED', last_error = NULL, updated_at = ? WHERE draft_id = ? AND status = 'APPROVED'")
      .run(this.now(), draftId);
    this.audit('hermes.plan.dispatch', projectId, draftId, `principal=${principalId}`);
    return this.requirePlanProjection(draftId, projectId);
  }

  admitDelegation(input: HermesDelegationRequest): HermesDelegationAdmission {
    const request = assertHermesDelegationRequest(input);
    this.assertProjectConversationBySession(request.projectId, request.parentSessionId);
    const worker = this.db.raw.prepare(
      `SELECT a.id FROM agents a JOIN projects p ON p.organization_id = a.organization_id
       WHERE a.id = ? AND a.archived = 0 AND p.id = ?`
    ).get(request.workerAgentId, request.projectId) as { id?: string } | undefined;
    if (worker?.id !== request.workerAgentId) throw new Error(`Hermes delegation references unavailable worker ${request.workerAgentId}`);
    const ids = new Set(request.tasks.map((task) => task.id));
    if (ids.size !== request.tasks.length || request.tasks.some((task) => task.dependsOn.some((id) => !ids.has(id)))) {
      throw new Error('Hermes delegation task dependency graph is invalid');
    }
    if (!this.delegationProjector) throw new Error('OPC-Nexus delegation governance is unavailable');
    const payload = json(request, 'Hermes delegation request', 512_000);
    const requestId = `hermes-delegate-${createHash('sha256').update(payload).digest('hex').slice(0, 40)}`;
    const existing = this.db.raw.prepare(
      'SELECT * FROM hermes_delegation_requests WHERE request_id = ? AND project_id = ?'
    ).get(requestId, request.projectId) as Record<string, unknown> | undefined;
    if (existing) {
      return {
        requestId,
        projectId: request.projectId,
        request: JSON.parse(String(existing.payload_json)) as HermesDelegationRequest,
        status: String(existing.status) as HermesDelegationAdmission['status'],
        createdAt: Number(existing.created_at)
      };
    }
    const now = this.now();
    this.db.raw.prepare(`
      INSERT INTO hermes_delegation_requests(request_id, project_id, parent_session_id, parent_run_id, worker_agent_id, payload_json, status, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, 'ADMITTED', ?, ?)
    `).run(requestId, request.projectId, request.parentSessionId, request.parentRunId, request.workerAgentId, payload, now, now);
    const admission: HermesDelegationAdmission = {
      requestId, projectId: request.projectId, request, status: 'ADMITTED', createdAt: now
    };
    try {
      const projected = this.delegationProjector.project(request, admission);
      this.db.raw.prepare(
        "UPDATE hermes_delegation_requests SET status = 'DISPATCHED', updated_at = ? WHERE request_id = ? AND status = 'ADMITTED'"
      ).run(this.now(), requestId);
      this.audit('hermes.delegate.dispatch', request.projectId, requestId,
        `worker=${request.workerAgentId};jobs=${projected.jobIds.join(',')};plan=${projected.planHash}`);
      return { ...admission, status: 'DISPATCHED' };
    } catch (error) {
      this.db.raw.prepare(
        "UPDATE hermes_delegation_requests SET status = 'REJECTED', updated_at = ? WHERE request_id = ? AND status = 'ADMITTED'"
      ).run(this.now(), requestId);
      const message = error instanceof Error ? error.message : String(error);
      this.audit('hermes.delegate.reject', request.projectId, requestId, message);
      throw error;
    }
  }

  listDelegations(projectId: string): HermesDelegationAdmission[] {
    this.assertProjectConversation(projectId, this.firstProjectConversation(projectId));
    const rows = this.db.raw.prepare('SELECT * FROM hermes_delegation_requests WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      requestId: String(row.request_id), projectId: String(row.project_id), request: JSON.parse(String(row.payload_json)) as HermesDelegationRequest,
      status: String(row.status) as HermesDelegationAdmission['status'], createdAt: Number(row.created_at)
    }));
  }

  private async projectPlanAdmission(admission: HermesPlanAdmission): Promise<HermesPlanProjection> {
    const existing = this.db.raw.prepare(
      'SELECT * FROM hermes_plan_projections WHERE draft_id = ? AND project_id = ?'
    ).get(admission.draftId, admission.projectId) as Record<string, unknown> | undefined;
    if (existing) return this.toPlanProjection(existing);
    const inFlight = this.planProjectionTasks.get(admission.draftId);
    if (inFlight) return inFlight;
    if (!this.planProjector) throw new Error('OPC-Nexus plan governance is unavailable');
    const task = (async () => {
      try {
        const projection = await this.planProjector!.project(admission.draft, admission);
        const now = this.now();
        this.db.transaction(() => {
          this.db.raw.prepare(`
            INSERT INTO hermes_plan_projections(
              draft_id, project_id, governance_session_id, hermes_session_id, plan_id,
              plan_version, plan_hash, status, last_error, created_at, updated_at
            ) VALUES(?, ?, ?, ?, ?, ?, ?, 'PROJECTED', NULL, ?, ?)
          `).run(admission.draftId, admission.projectId, projection.governanceSessionId, projection.sessionId,
            projection.planId, projection.version, projection.hash, now, now);
          this.db.raw.prepare("UPDATE hermes_plan_drafts SET status = 'PROJECTED', updated_at = ? WHERE draft_id = ?")
            .run(now, admission.draftId);
        });
        this.audit('hermes.plan.project', admission.projectId, admission.draftId,
          `plan=${projection.planId};version=${projection.version};hash=${projection.hash}`);
        return this.requirePlanProjection(admission.draftId, admission.projectId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.db.raw.prepare("UPDATE hermes_plan_drafts SET status = 'PROJECTION_FAILED', updated_at = ? WHERE draft_id = ?")
          .run(this.now(), admission.draftId);
        this.audit('hermes.plan.project', admission.projectId, admission.draftId, message);
        throw error;
      } finally {
        this.planProjectionTasks.delete(admission.draftId);
      }
    })();
    this.planProjectionTasks.set(admission.draftId, task);
    return task;
  }

  private assertWorkers(draft: HermesPlanDraft): void {
    const workers = new Set<string>();
    for (const member of draft.team) workers.add(member.workerAgentId);
    for (const node of draft.dag) workers.add(node.workerAgentId);
    if (workers.size === 0) throw new Error('Hermes plan must nominate at least one worker');
    for (const workerId of workers) {
      const row = this.db.raw.prepare(
        `SELECT a.id FROM agents a JOIN projects p ON p.organization_id = a.organization_id WHERE a.id = ? AND a.archived = 0 AND p.id = ?`
      ).get(workerId, draft.projectId) as { id?: string } | undefined;
      if (row?.id !== workerId) throw new Error(`Hermes plan references unavailable worker ${workerId}`);
    }
  }

  private assertDag(draft: HermesPlanDraft): void {
    const nodes = new Map(draft.dag.map((node) => [node.id, node]));
    if (nodes.size !== draft.dag.length) throw new Error('Hermes plan DAG node ids must be unique');
    const planArtifacts = new Set(draft.expectedArtifacts.map((artifact) => artifact.relativePath));
    if (planArtifacts.size !== draft.expectedArtifacts.length) {
      throw new Error('Hermes plan artifact paths must be unique');
    }
    const artifactOwners = new Map<string, string>();
    for (const node of draft.dag) {
      if (!Array.isArray(node.expectedArtifacts)) {
        throw new Error(`Hermes plan DAG node ${node.id} expectedArtifacts are invalid`);
      }
      if (node.dependsOn.includes(node.id)) throw new Error('Hermes plan DAG contains a self dependency');
      for (const dependency of node.dependsOn) if (!nodes.has(dependency)) throw new Error(`Hermes plan dependency ${dependency} is missing`);
      for (const artifactPath of node.expectedArtifacts) {
        if (typeof artifactPath !== 'string' || !SAFE_RELATIVE_PATH.test(artifactPath)) {
          throw new Error(`Hermes plan DAG node ${node.id} artifact path must remain project-relative`);
        }
        if (!planArtifacts.has(artifactPath)) {
          throw new Error(`Hermes plan DAG node ${node.id} references undeclared artifact ${artifactPath}`);
        }
        const owner = artifactOwners.get(artifactPath);
        if (owner) throw new Error(`Hermes plan artifact ${artifactPath} is assigned to both ${owner} and ${node.id}`);
        artifactOwners.set(artifactPath, node.id);
      }
    }
    for (const artifactPath of planArtifacts) {
      if (!artifactOwners.has(artifactPath)) {
        throw new Error(`Hermes plan artifact ${artifactPath} has no DAG owner`);
      }
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error('Hermes plan DAG contains a cycle');
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of nodes.get(id)!.dependsOn) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of nodes.keys()) visit(id);
  }

  private assertProjectConversation(projectId: string, conversationId: string): void {
    const project = this.db.raw.prepare("SELECT id FROM projects WHERE id = ? AND status <> 'archived'").get(projectId) as { id?: string } | undefined;
    if (project?.id !== projectId) throw new Error('Hermes project is unavailable');
    const conversation = this.db.raw.prepare('SELECT id, project_id FROM conversations WHERE id = ?').get(conversationId) as { id?: string; project_id?: string | null } | undefined;
    if (conversation?.id !== conversationId || conversation.project_id !== projectId) throw new Error('Hermes conversation is not bound to this project');
  }

  private requirePlanProjection(draftId: string, projectId: string): HermesPlanProjection {
    const row = this.db.raw.prepare('SELECT * FROM hermes_plan_projections WHERE draft_id = ? AND project_id = ?').get(draftId, projectId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Hermes plan projection does not exist in this project');
    return this.toPlanProjection(row);
  }

  private toPlanProjection(row: Record<string, unknown>): HermesPlanProjection {
    return {
      draftId: String(row.draft_id), projectId: String(row.project_id), governanceSessionId: String(row.governance_session_id),
      sessionId: String(row.hermes_session_id), planId: String(row.plan_id), version: Number(row.plan_version),
      hash: String(row.plan_hash), status: String(row.status) as HermesPlanProjection['status'],
      lastError: typeof row.last_error === 'string' ? row.last_error : null,
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at)
    };
  }

  private migrateLegacyPlanProjectionColumns(): void {
    const renames = [
      ['planning_session_id', 'governance_session_id'],
      ['dsh_session_id', 'hermes_session_id'],
      ['dsh_plan_id', 'plan_id'],
      ['dsh_version', 'plan_version']
    ] as const;
    const columns = new Set(
      (this.db.raw.prepare('PRAGMA table_info(hermes_plan_projections)').all() as Array<{ name?: string }>)
        .map((column) => column.name)
        .filter((name): name is string => typeof name === 'string')
    );
    const migrated: string[] = [];
    this.db.transaction(() => {
      for (const [legacy, current] of renames) {
        if (!columns.has(legacy)) continue;
        if (columns.has(current)) throw new Error(`Hermes plan projection contains conflicting columns ${legacy}/${current}`);
        this.db.raw.prepare(`ALTER TABLE hermes_plan_projections RENAME COLUMN ${legacy} TO ${current}`).run();
        columns.delete(legacy);
        columns.add(current);
        migrated.push(`${legacy}->${current}`);
      }
    });
    for (const required of ['governance_session_id', 'hermes_session_id', 'plan_id', 'plan_version']) {
      if (!columns.has(required)) throw new Error(`Hermes plan projection schema is missing ${required}`);
    }
    if (migrated.length > 0) {
      this.audit('hermes.plan.schema.migrate', 'all-projects', 'hermes-plan-projections', migrated.join(','));
    }
  }

  private assertProjectConversationBySession(projectId: string, sessionId: string): void {
    const binding = this.db.raw.prepare('SELECT conversation_id FROM hermes_session_bindings WHERE project_id = ? AND hermes_session_id = ?').get(projectId, sessionId) as { conversation_id?: string } | undefined;
    if (binding?.conversation_id) {
      this.assertProjectConversation(projectId, binding.conversation_id);
      return;
    }
    // Parent session ids are only accepted when explicitly bound by Main.
    throw new Error('Hermes parent session is not bound to a project conversation');
  }

  private firstProjectConversation(projectId: string): string {
    const row = this.db.raw.prepare('SELECT id FROM conversations WHERE project_id = ? ORDER BY updated_at DESC, id LIMIT 1').get(projectId) as { id?: string } | undefined;
    if (!row?.id) throw new Error('Hermes project has no bound conversation');
    return row.id;
  }

  private toClarify(row: ClarifyRow): HermesClarifyRequest {
    return {
      clarifyId: row.clarify_id,
      projectId: row.project_id,
      conversationId: row.conversation_id,
      questionKind: row.question_kind,
      prompt: row.prompt,
      options: parseArray(row.options_json, 'clarify options') as HermesClarifyRequest['options'],
      allowOther: row.allow_other === 1,
      expiresAt: row.expires_at,
      required: row.required === 1,
      channelTargets: parseArray(row.channel_targets_json, 'clarify channels') as string[],
      status: row.status
    };
  }

  private audit(action: string, projectId: string, target: string, result: string): void {
    this.db.audit({ id: randomUUID(), actor: 'system', action, target, result, source: 'hermes' });
  }
}
