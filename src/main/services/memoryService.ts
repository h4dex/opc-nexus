import { createHash, randomUUID } from 'node:crypto';
import type { Database } from './database.js';

export type MemoryScopeType = 'organization' | 'principal' | 'channel' | 'conversation' | 'agent' | 'project';
export type MemoryStatus = 'active' | 'forgotten';

export interface MemoryScopeContext {
  organizationId: string;
  principalId?: string | null;
  channelId?: string | null;
  conversationId?: string | null;
  agentId?: string | null;
  projectId?: string | null;
}

export interface RememberMemoryInput extends MemoryScopeContext {
  kind: string;
  content: string;
  importance?: number;
  actor: string;
  source?: string;
}

export interface UpdateMemoryInput {
  organizationId: string;
  memoryId: string;
  expectedRevision: number;
  content?: string;
  importance?: number;
  actor: string;
  source?: string;
  reason?: string;
}

export interface ForgetMemoryInput {
  organizationId: string;
  memoryId: string;
  expectedRevision: number;
  actor: string;
  source?: string;
  reason?: string;
}

export interface RecallMemoryInput extends MemoryScopeContext {
  query?: string;
  limit?: number;
}

export interface ListMemoryInput {
  organizationId: string;
  status?: MemoryStatus | 'all';
  limit?: number;
}

export interface MemoryItem {
  id: string;
  organizationId: string;
  kind: string;
  content: string;
  importance: number;
  status: MemoryStatus;
  revision: number;
  scopes: Array<{ type: MemoryScopeType; id: string }>;
  createdAt: number;
  updatedAt: number;
  forgottenAt: number | null;
}

export interface RecalledMemory extends MemoryItem {
  score: number;
}

type Row = Record<string, unknown>;

const SCOPE_ORDER: Array<[MemoryScopeType, keyof MemoryScopeContext]> = [
  ['organization', 'organizationId'],
  ['principal', 'principalId'],
  ['channel', 'channelId'],
  ['conversation', 'conversationId'],
  ['agent', 'agentId'],
  ['project', 'projectId']
];

function required(value: string | null | undefined, field: string, max = 200): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) throw new Error(`${field} is required`);
  if (normalized.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return normalized;
}

function normalizeContent(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function contentValue(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error('memory content is required');
  if (normalized.length > 8_000) throw new Error('memory content exceeds 8000 characters');
  return normalized;
}

function kindValue(value: string): string {
  const normalized = required(value, 'memory kind', 80).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]*$/.test(normalized)) {
    throw new Error('memory kind must use lowercase letters, numbers, dot, colon, underscore or dash');
  }
  return normalized;
}

function importanceValue(value: number | undefined): number {
  const normalized = value ?? 0.5;
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1) {
    throw new Error('memory importance must be between 0 and 1');
  }
  return normalized;
}

function revisionValue(value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error('expectedRevision must be a positive integer');
  return value;
}

function limitValue(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new Error('limit must be a finite number');
  return Math.min(max, Math.max(1, Math.trunc(value)));
}

function scopesFor(context: MemoryScopeContext): Array<{ type: MemoryScopeType; id: string }> {
  const scopes: Array<{ type: MemoryScopeType; id: string }> = [];
  for (const [type, key] of SCOPE_ORDER) {
    const raw = context[key];
    if (type === 'organization') {
      scopes.push({ type, id: required(raw, 'organizationId') });
      continue;
    }
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (id) scopes.push({ type, id: required(id, `${String(key)}`) });
  }
  return scopes;
}

function scopeKey(scopes: Array<{ type: MemoryScopeType; id: string }>): string {
  return scopes.map((scope) => `${scope.type}:${Buffer.byteLength(scope.id, 'utf8')}:${scope.id}`).join('|');
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function termsFor(value: string): Map<string, number> {
  const normalized = normalizeContent(value).toLowerCase();
  const counts = new Map<string, number>();
  const add = (term: string) => {
    if (term.length === 0 || term.length > 80) return;
    counts.set(term, (counts.get(term) ?? 0) + 1);
  };
  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9_-]*/g)) add(match[0]);
  const ideographs = [...normalized.matchAll(/\p{Script=Han}/gu)].map((match) => match[0]);
  for (let index = 0; index < ideographs.length; index += 1) {
    add(ideographs[index]);
    if (index + 1 < ideographs.length) add(`${ideographs[index]}${ideographs[index + 1]}`);
  }
  return new Map([...counts].map(([term, count]) => [term, 1 + Math.log(count)]));
}

/**
 * Canonical long-term memory owned by OPC-Nexus. Native runtime memory is a
 * cache only; every mutation here is revisioned, scoped and audited.
 */
export class MemoryService {
  constructor(private readonly db: Database, private readonly now: () => number = Date.now) {}

  remember(input: RememberMemoryInput): MemoryItem {
    return this.rememberWithCommit(input, () => {});
  }

  /** Lets another Main-process service commit its state in the same transaction. */
  rememberWithCommit(input: RememberMemoryInput, commit: (memory: MemoryItem) => void): MemoryItem {
    let result!: MemoryItem;
    this.db.transaction(() => {
      result = this.rememberMutation(input);
      commit(result);
    });
    return result;
  }

  private rememberMutation(input: RememberMemoryInput): MemoryItem {
    const organizationId = required(input.organizationId, 'organizationId');
    const kind = kindValue(input.kind);
    const content = contentValue(input.content);
    const importance = importanceValue(input.importance);
    const actor = required(input.actor, 'actor');
    this.validateScopeContext({ ...input, organizationId });
    const scopes = scopesFor({ ...input, organizationId });
    const key = scopeKey(scopes);
    const hash = digest(normalizeContent(content).toLowerCase());
    const existing = this.db.raw.prepare(
      `SELECT * FROM memory_items
       WHERE organization_id = ? AND content_hash = ? AND scope_key = ? AND status = 'active' LIMIT 1`
    ).get(organizationId, hash, key) as Row | undefined;
    if (existing) {
      this.db.audit({ id: randomUUID(), actor, action: 'memory.remember', target: String(existing.id), result: 'deduplicated', source: input.source });
      return this.map(existing);
    }

    const id = randomUUID();
    const now = this.now();
    this.db.raw.prepare(
      `INSERT INTO memory_items(
        id, organization_id, kind, content, content_hash, scope_key, importance,
        status, revision, created_by, created_at, updated_at, forgotten_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, NULL)`
    ).run(id, organizationId, kind, content, hash, key, importance, actor, now, now);
    for (const scope of scopes) {
      this.db.raw.prepare(
        'INSERT INTO memory_scopes(memory_id, scope_type, scope_id) VALUES(?, ?, ?)'
      ).run(id, scope.type, scope.id);
    }
    this.insertVersion(id, 1, content, importance, 'active', actor, 'remember', null, now);
    this.replaceTerms(id, content);
    this.db.audit({ id: randomUUID(), actor, action: 'memory.remember', target: id, result: 'created', source: input.source });
    const row = this.row(organizationId, id);
    if (!row) throw new Error('memory persistence failed');
    return this.map(row);
  }

  update(input: UpdateMemoryInput): MemoryItem {
    const organizationId = required(input.organizationId, 'organizationId');
    this.validateOrganization(organizationId);
    const memoryId = required(input.memoryId, 'memoryId');
    const expectedRevision = revisionValue(input.expectedRevision);
    const actor = required(input.actor, 'actor');
    const current = this.row(organizationId, memoryId);
    if (!current || current.status !== 'active') throw new Error('active memory was not found');
    const content = input.content === undefined ? String(current.content) : contentValue(input.content);
    const importance = input.importance === undefined ? Number(current.importance) : importanceValue(input.importance);
    const revision = expectedRevision + 1;
    const now = this.now();
    const hash = digest(normalizeContent(content).toLowerCase());
    this.db.transaction(() => {
      const changed = this.db.raw.prepare(
        `UPDATE memory_items SET content = ?, content_hash = ?, importance = ?, revision = ?, updated_at = ?
         WHERE id = ? AND organization_id = ? AND status = 'active' AND revision = ?`
      ).run(content, hash, importance, revision, now, memoryId, organizationId, expectedRevision).changes;
      if (changed !== 1) throw new Error('memory revision conflict');
      this.insertVersion(memoryId, revision, content, importance, 'active', actor, 'update', input.reason ?? null, now);
      this.replaceTerms(memoryId, content);
      this.db.audit({ id: randomUUID(), actor, action: 'memory.update', target: memoryId, result: `revision:${revision}`, source: input.source });
    });
    return this.get(organizationId, memoryId)!;
  }

  forget(input: ForgetMemoryInput): MemoryItem {
    const organizationId = required(input.organizationId, 'organizationId');
    this.validateOrganization(organizationId);
    const memoryId = required(input.memoryId, 'memoryId');
    const expectedRevision = revisionValue(input.expectedRevision);
    const actor = required(input.actor, 'actor');
    const current = this.row(organizationId, memoryId);
    if (!current || current.status !== 'active') throw new Error('active memory was not found');
    const revision = expectedRevision + 1;
    const now = this.now();
    this.db.transaction(() => {
      const changed = this.db.raw.prepare(
        `UPDATE memory_items SET status = 'forgotten', revision = ?, updated_at = ?, forgotten_at = ?
         WHERE id = ? AND organization_id = ? AND status = 'active' AND revision = ?`
      ).run(revision, now, now, memoryId, organizationId, expectedRevision).changes;
      if (changed !== 1) throw new Error('memory revision conflict');
      this.insertVersion(memoryId, revision, String(current.content), Number(current.importance), 'forgotten', actor, 'forget', input.reason ?? null, now);
      this.db.audit({ id: randomUUID(), actor, action: 'memory.forget', target: memoryId, result: `revision:${revision}`, source: input.source });
    });
    return this.get(organizationId, memoryId)!;
  }

  get(organizationId: string, memoryId: string): MemoryItem | null {
    const normalizedOrganizationId = required(organizationId, 'organizationId');
    this.validateOrganization(normalizedOrganizationId);
    const row = this.row(normalizedOrganizationId, required(memoryId, 'memoryId'));
    return row ? this.map(row) : null;
  }

  list(input: ListMemoryInput): MemoryItem[] {
    const organizationId = required(input.organizationId, 'organizationId');
    this.validateOrganization(organizationId);
    const status = input.status ?? 'active';
    if (!['active', 'forgotten', 'all'].includes(status)) throw new Error('memory status is invalid');
    const limit = limitValue(input.limit, 100, 200);
    const rows = status === 'all'
      ? this.db.raw.prepare(
        'SELECT * FROM memory_items WHERE organization_id = ? ORDER BY updated_at DESC LIMIT ?'
      ).all(organizationId, limit) as Row[]
      : this.db.raw.prepare(
        'SELECT * FROM memory_items WHERE organization_id = ? AND status = ? ORDER BY updated_at DESC LIMIT ?'
      ).all(organizationId, status, limit) as Row[];
    return rows.map((row) => this.map(row));
  }

  recall(input: RecallMemoryInput): RecalledMemory[] {
    const organizationId = required(input.organizationId, 'organizationId');
    this.validateScopeContext({ ...input, organizationId });
    const query = (input.query ?? '').trim().slice(0, 4_000);
    const limit = limitValue(input.limit, 20, 100);
    const context = new Map<MemoryScopeType, string | null>(SCOPE_ORDER.map(([type, key]) => {
      const value = input[key];
      return [type, typeof value === 'string' && value.trim() ? value.trim() : null];
    }));
    context.set('organization', organizationId);
    const rows = this.db.raw.prepare(
      `WITH recall_context(scope_type, scope_id) AS (
         SELECT 'organization', ? UNION ALL SELECT 'principal', ? UNION ALL SELECT 'channel', ?
         UNION ALL SELECT 'conversation', ? UNION ALL SELECT 'agent', ? UNION ALL SELECT 'project', ?
       )
       SELECT mi.* FROM memory_items mi
       WHERE mi.organization_id = ? AND mi.status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM memory_scopes ms
           LEFT JOIN recall_context rc ON rc.scope_type = ms.scope_type
           WHERE ms.memory_id = mi.id AND (rc.scope_id IS NULL OR rc.scope_id != ms.scope_id)
         )
       ORDER BY mi.importance DESC, mi.updated_at DESC LIMIT 500`
    ).all(
      context.get('organization'), context.get('principal'), context.get('channel'),
      context.get('conversation'), context.get('agent'), context.get('project'), organizationId
    ) as Row[];
    const candidates = new Set(rows.map((row) => String(row.id)));
    const queryTerms = [...termsFor(query).keys()].slice(0, 64);
    const lexical = new Map<string, number>();
    if (queryTerms.length > 0) {
      const placeholders = queryTerms.map(() => '?').join(', ');
      const termRows = this.db.raw.prepare(
        `SELECT memory_id, SUM(weight) AS score FROM memory_terms
         WHERE term IN (${placeholders}) GROUP BY memory_id`
      ).all(...queryTerms) as Row[];
      for (const row of termRows) {
        const id = String(row.memory_id);
        if (candidates.has(id)) lexical.set(id, Number(row.score) / queryTerms.length);
      }
    }
    const normalizedQuery = normalizeContent(query).toLowerCase();
    return rows.map((row) => {
      const item = this.map(row);
      const exactBonus = normalizedQuery && normalizeContent(item.content).toLowerCase().includes(normalizedQuery) ? 1 : 0;
      return {
        item,
        matched: !normalizedQuery || exactBonus > 0 || lexical.has(item.id),
        score: (lexical.get(item.id) ?? 0) + exactBonus + item.importance * 0.35
      };
    }).filter((candidate) => candidate.matched).map(({ item, score }) => {
      return { ...item, score };
    }).sort((left, right) => right.score - left.score || right.updatedAt - left.updatedAt).slice(0, limit);
  }

  private row(organizationId: string, memoryId: string): Row | undefined {
    return this.db.raw.prepare(
      'SELECT * FROM memory_items WHERE id = ? AND organization_id = ? LIMIT 1'
    ).get(memoryId, organizationId) as Row | undefined;
  }

  private validateOrganization(organizationId: string): void {
    const row = this.db.raw.prepare(
      'SELECT id FROM organizations WHERE id = ? LIMIT 1'
    ).get(organizationId) as Row | undefined;
    if (!row) throw new Error('organization was not found');
  }

  private validateScopeContext(context: MemoryScopeContext): void {
    const organizationId = required(context.organizationId, 'organizationId');
    this.validateOrganization(organizationId);

    const ensureOwned = (table: 'principals' | 'channels' | 'agents' | 'projects', id: string, field: string) => {
      const row = this.db.raw.prepare(
        `SELECT organization_id FROM ${table} WHERE id = ? LIMIT 1`
      ).get(id) as Row | undefined;
      if (!row || String(row.organization_id) !== organizationId) {
        throw new Error(`${field} does not belong to organization`);
      }
    };

    const principalId = typeof context.principalId === 'string' && context.principalId.trim()
      ? required(context.principalId, 'principalId')
      : null;
    const channelId = typeof context.channelId === 'string' && context.channelId.trim()
      ? required(context.channelId, 'channelId')
      : null;
    const conversationId = typeof context.conversationId === 'string' && context.conversationId.trim()
      ? required(context.conversationId, 'conversationId')
      : null;
    const agentId = typeof context.agentId === 'string' && context.agentId.trim()
      ? required(context.agentId, 'agentId')
      : null;
    const projectId = typeof context.projectId === 'string' && context.projectId.trim()
      ? required(context.projectId, 'projectId')
      : null;

    if (principalId) ensureOwned('principals', principalId, 'principalId');
    if (channelId) ensureOwned('channels', channelId, 'channelId');
    if (agentId) ensureOwned('agents', agentId, 'agentId');
    if (projectId) ensureOwned('projects', projectId, 'projectId');
    if (!conversationId) return;

    const conversation = this.db.raw.prepare(
      'SELECT organization_id, principal_id, channel_id FROM conversations WHERE id = ? LIMIT 1'
    ).get(conversationId) as Row | undefined;
    if (!conversation || String(conversation.organization_id) !== organizationId) {
      throw new Error('conversationId does not belong to organization');
    }
    if (principalId && String(conversation.principal_id ?? '') !== principalId) {
      throw new Error('conversationId does not belong to principalId');
    }
    if (channelId && String(conversation.channel_id ?? '') !== channelId) {
      throw new Error('conversationId does not belong to channelId');
    }
  }

  private map(row: Row): MemoryItem {
    const scopes = this.db.raw.prepare(
      'SELECT scope_type, scope_id FROM memory_scopes WHERE memory_id = ? ORDER BY scope_type'
    ).all(String(row.id)) as Row[];
    return {
      id: String(row.id),
      organizationId: String(row.organization_id),
      kind: String(row.kind),
      content: String(row.content),
      importance: Number(row.importance),
      status: String(row.status) as MemoryStatus,
      revision: Number(row.revision),
      scopes: scopes.map((scope) => ({ type: String(scope.scope_type) as MemoryScopeType, id: String(scope.scope_id) })),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      forgottenAt: row.forgotten_at === null || row.forgotten_at === undefined ? null : Number(row.forgotten_at)
    };
  }

  private insertVersion(memoryId: string, revision: number, content: string, importance: number, status: MemoryStatus, actor: string, changeKind: string, reason: string | null, now: number): void {
    this.db.raw.prepare(
      `INSERT INTO memory_versions(
        id, memory_id, revision, content, importance, status, changed_by, change_kind, reason, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), memoryId, revision, content, importance, status, actor, changeKind, reason, now);
  }

  private replaceTerms(memoryId: string, content: string): void {
    this.db.raw.prepare('DELETE FROM memory_terms WHERE memory_id = ?').run(memoryId);
    for (const [term, weight] of termsFor(content)) {
      this.db.raw.prepare('INSERT INTO memory_terms(memory_id, term, weight) VALUES(?, ?, ?)').run(memoryId, term, weight);
    }
  }
}
