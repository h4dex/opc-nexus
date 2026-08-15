// @ts-nocheck
/* eslint-disable */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import initSqlJs from 'sql.js';
import { createRequire } from 'node:module';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

const { ProviderManager } = await import('../src/main/services/providerManager.js');
const {
  migrateLegacyProvider,
  PROVIDER_KEY_REF,
  PROVIDER_SETTING,
  saveProviderConfig
} = await import('../src/main/services/provider.js');

const require = createRequire(import.meta.url);
let SQL: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
});

const DDL = `
CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  api_key_ref TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  provider_id TEXT
);
CREATE TABLE engines (
  id TEXT PRIMARY KEY,
  config_json TEXT
);
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  result TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'desktop',
  created_at INTEGER NOT NULL
);
`;

function statement(db: InstanceType<typeof SQL.Database>, sql: string) {
  return {
    run: (...params: unknown[]) => {
      db.run(sql, params);
      return { changes: db.getRowsModified() };
    },
    get: (...params: unknown[]) => {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(params);
        return stmt.step() ? stmt.getAsObject() : undefined;
      } finally {
        stmt.free();
      }
    },
    all: (...params: unknown[]) => {
      const stmt = db.prepare(sql);
      const rows: Record<string, unknown>[] = [];
      try {
        stmt.bind(params);
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
      } finally {
        stmt.free();
      }
    }
  };
}

class SqlJsTestDatabase {
  readonly inner: InstanceType<typeof SQL.Database>;
  readonly raw: { prepare: (sql: string) => ReturnType<typeof statement> };
  failAfterAuditAction: string | null = null;

  constructor() {
    this.inner = new SQL.Database();
    this.inner.exec(DDL);
    this.raw = { prepare: (sql: string) => statement(this.inner, sql) };
  }

  close(): void {
    this.inner.close();
  }

  transaction(fn: () => void): void {
    this.inner.exec('BEGIN');
    try {
      fn();
      this.inner.exec('COMMIT');
    } catch (error) {
      this.inner.exec('ROLLBACK');
      throw error;
    }
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.raw.prepare('SELECT value_json FROM settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value_json as string) as T : fallback;
  }

  setSetting(key: string, value: unknown): void {
    this.raw.prepare(`
      INSERT INTO settings(key, value_json, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), Date.now());
  }

  audit(entry: { id: string; actor: string; action: string; target: string; result: string; source?: string }): void {
    this.raw.prepare(`
      INSERT INTO audit_logs(id, actor, action, target, result, source, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run(entry.id, entry.actor, entry.action, entry.target, entry.result, entry.source ?? 'desktop', Date.now());
    if (entry.action === this.failAfterAuditAction) throw new Error(`injected failure: ${entry.action}`);
  }

  rows(sql: string, ...params: unknown[]): Record<string, unknown>[] {
    return this.raw.prepare(sql).all(...params);
  }

  row(sql: string, ...params: unknown[]): Record<string, unknown> | undefined {
    return this.raw.prepare(sql).get(...params);
  }
}

function encrypted(value: string): string {
  return Buffer.from(`enc:${value}`).toString('base64');
}

function secretValue(db: SqlJsTestDatabase, ref: string): string | null {
  const value = db.getSetting<string | null>(ref, null);
  return value ? Buffer.from(value, 'base64').toString().replace(/^enc:/, '') : null;
}

describe('Provider transactions with real sql.js', () => {
  let db: SqlJsTestDatabase;
  let providers: InstanceType<typeof ProviderManager>;
  let runtimeConfigChanged: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = new SqlJsTestDatabase();
    runtimeConfigChanged = vi.fn();
    providers = new ProviderManager(db as never, runtimeConfigChanged);
  });

  afterEach(() => {
    db.close();
  });

  it('automatically makes the first Provider the sole default', () => {
    const first = providers.create({
      name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1/', model: 'deepseek-chat', isDefault: false
    });
    const second = providers.create({
      name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1', isDefault: false
    });

    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);
    expect(db.rows('SELECT id FROM providers WHERE is_default = 1')).toEqual([{ id: first.id }]);
  });

  it('adding an unrelated non-default Provider does not invalidate active runtimes', () => {
    providers.create({
      name: 'Default', baseUrl: 'https://default.test/v1', model: 'default-model', apiKey: 'default-key'
    });
    runtimeConfigChanged.mockClear();

    providers.create({
      name: 'Unused', baseUrl: 'https://unused.test/v1', model: 'unused-model', apiKey: 'unused-key'
    });

    expect(runtimeConfigChanged).not.toHaveBeenCalled();
  });

  it('invalidates runtime verification for key, endpoint, model, default, and removal changes', () => {
    const first = providers.create({
      name: 'First', baseUrl: 'https://first.test/v1', model: 'first-model', apiKey: 'first-key'
    });
    const second = providers.create({
      name: 'Second', baseUrl: 'https://second.test/v1', model: 'second-model', apiKey: 'second-key'
    });
    runtimeConfigChanged.mockClear();

    providers.update(first.id, { apiKey: 'rotated-key' });
    providers.update(first.id, { baseUrl: 'https://first.test/openai/v2' });
    providers.update(first.id, { model: 'replacement-model' });
    providers.update(second.id, { isDefault: true });
    providers.remove(second.id);

    expect(runtimeConfigChanged).toHaveBeenCalledTimes(5);
    runtimeConfigChanged.mockClear();
    providers.update(first.id, { name: 'Display name only' });
    expect(runtimeConfigChanged).not.toHaveBeenCalled();
  });

  it.each([
    'file:///tmp/provider',
    'ftp://provider.test/v1',
    'https://user:password@provider.test/v1',
    'https://provider.test/v1?target=attacker',
    'https://provider.test/v1#attacker',
    'http://provider.test/v1'
  ])('rejects an unsafe Provider endpoint before saving: %s', (baseUrl) => {
    expect(() => providers.create({ name: 'Unsafe', baseUrl, model: 'model', apiKey: 'key' })).toThrow();
    expect(db.rows('SELECT * FROM providers')).toEqual([]);
    expect(db.rows('SELECT * FROM settings')).toEqual([]);
  });

  it('selects a successor when the default is unset', () => {
    const first = providers.create({ name: 'First', baseUrl: 'https://first.test/v1', model: 'first' });
    const second = providers.create({ name: 'Second', baseUrl: 'https://second.test/v1', model: 'second' });

    providers.update(first.id, { isDefault: false });

    expect(db.rows('SELECT id FROM providers WHERE is_default = 1')).toEqual([{ id: second.id }]);
  });

  it('refuses to remove a Provider while an Agent is explicitly bound, preserving fail-closed routing', () => {
    const first = providers.create({
      name: 'First', baseUrl: 'https://first.test/v1', model: 'first', apiKey: 'first-key'
    });
    const second = providers.create({
      name: 'Second', baseUrl: 'https://second.test/v1', model: 'second', apiKey: 'second-key'
    });
    const firstRef = db.row('SELECT api_key_ref FROM providers WHERE id = ?', first.id)!.api_key_ref as string;
    const secondRef = db.row('SELECT api_key_ref FROM providers WHERE id = ?', second.id)!.api_key_ref as string;
    db.raw.prepare('INSERT INTO agents(id, provider_id) VALUES(?, ?)').run('agent-1', first.id);

    expect(() => providers.remove(first.id)).toThrow(/显式绑定|重新绑定/);

    expect(db.row('SELECT id FROM providers WHERE id = ?', first.id)).toMatchObject({ id: first.id });
    expect(db.row('SELECT provider_id FROM agents WHERE id = ?', 'agent-1')).toEqual({ provider_id: first.id });
    expect(db.rows('SELECT id FROM providers WHERE is_default = 1')).toEqual([{ id: first.id }]);
    expect(secretValue(db, firstRef)).toBe('first-key');
    expect(secretValue(db, secondRef)).toBe('second-key');
    expect(db.rows("SELECT action, target, result FROM audit_logs WHERE target = ? AND action IN ('provider.remove', 'provider.secret.delete') ORDER BY created_at, rowid", first.id))
      .toEqual([]);
  });

  it('refuses to remove a Provider while an engine is explicitly bound', () => {
    const provider = providers.create({
      name: 'Bound', baseUrl: 'https://bound.test/v1', model: 'bound-model', apiKey: 'bound-key'
    });
    db.raw.prepare('INSERT INTO engines(id, config_json) VALUES(?, ?)')
      .run('eng-codex', JSON.stringify({ providerMode: 'managed', providerId: provider.id }));

    expect(() => providers.remove(provider.id)).toThrow(/执行引擎显式绑定|重新配置引擎/);
    expect(db.row('SELECT id FROM providers WHERE id = ?', provider.id)).toEqual({ id: provider.id });
  });

  it('removes an unbound Provider, its owned secret, and promotes a successor', () => {
    const first = providers.create({
      name: 'First', baseUrl: 'https://first.test/v1', model: 'first', apiKey: 'first-key'
    });
    const second = providers.create({
      name: 'Second', baseUrl: 'https://second.test/v1', model: 'second', apiKey: 'second-key'
    });
    const firstRef = db.row('SELECT api_key_ref FROM providers WHERE id = ?', first.id)!.api_key_ref as string;
    const secondRef = db.row('SELECT api_key_ref FROM providers WHERE id = ?', second.id)!.api_key_ref as string;

    providers.remove(first.id);

    expect(db.row('SELECT id FROM providers WHERE id = ?', first.id)).toBeUndefined();
    expect(db.rows('SELECT id FROM providers WHERE is_default = 1')).toEqual([{ id: second.id }]);
    expect(db.row('SELECT key FROM settings WHERE key = ?', firstRef)).toBeUndefined();
    expect(secretValue(db, secondRef)).toBe('second-key');
    expect(db.rows('SELECT action, target, result FROM audit_logs WHERE target = ? ORDER BY created_at, rowid', first.id))
      .toEqual(expect.arrayContaining([
        { action: 'provider.secret.delete', target: first.id, result: 'ok' },
        { action: 'provider.remove', target: first.id, result: 'ok' }
      ]));
  });

  it('deletes both legacy settings when a migrated Provider is removed', () => {
    db.setSetting(PROVIDER_SETTING, { baseUrl: 'https://legacy.test/v1', model: 'legacy-model' });
    db.setSetting(`secret:${PROVIDER_KEY_REF}`, encrypted('legacy-key'));
    expect(migrateLegacyProvider(db as never)).toBe(true);
    const migrated = db.row('SELECT id, api_key_ref FROM providers')!;

    providers.remove(migrated.id as string);

    expect(db.rows('SELECT * FROM providers')).toEqual([]);
    expect(db.row('SELECT key FROM settings WHERE key = ?', `secret:${PROVIDER_KEY_REF}`)).toBeUndefined();
    expect(db.row('SELECT key FROM settings WHERE key = ?', PROVIDER_SETTING)).toBeUndefined();
    expect(db.rows('SELECT action FROM audit_logs WHERE target = ?', migrated.id))
      .toEqual(expect.arrayContaining([{ action: 'provider.secret.delete' }, { action: 'provider.remove' }]));
  });

  it('rolls back Provider deletion, secret deletion, and audit writes on a mid-operation failure', () => {
    const first = providers.create({
      name: 'First', baseUrl: 'https://first.test/v1', model: 'first', apiKey: 'first-key'
    });
    const second = providers.create({ name: 'Second', baseUrl: 'https://second.test/v1', model: 'second' });
    const ref = db.row('SELECT api_key_ref FROM providers WHERE id = ?', first.id)!.api_key_ref as string;
    db.raw.prepare('DELETE FROM audit_logs').run();
    db.failAfterAuditAction = 'provider.remove';

    expect(() => providers.remove(first.id)).toThrow('injected failure: provider.remove');

    expect(db.row('SELECT id, is_default FROM providers WHERE id = ?', first.id)).toEqual({ id: first.id, is_default: 1 });
    expect(db.row('SELECT id, is_default FROM providers WHERE id = ?', second.id)).toEqual({ id: second.id, is_default: 0 });
    expect(secretValue(db, ref)).toBe('first-key');
    expect(db.rows('SELECT * FROM audit_logs')).toEqual([]);
  });

  it('rotates the secret reference when the legacy Provider origin changes', () => {
    saveProviderConfig(db as never, {
      baseUrl: 'https://initial.test/v1/', model: 'initial-model', apiKey: 'initial-key'
    });
    const initial = db.row('SELECT id, base_url, model, api_key_ref, is_default FROM providers')!;
    expect(initial).toMatchObject({ base_url: 'https://initial.test/v1', model: 'initial-model', is_default: 1 });
    expect(secretValue(db, initial.api_key_ref as string)).toBe('initial-key');

    saveProviderConfig(db as never, {
      baseUrl: 'https://replacement.test/v1/', model: 'replacement-model', apiKey: 'replacement-key'
    });

    expect(db.rows('SELECT id FROM providers')).toEqual([{ id: initial.id }]);
    const replacement = db.row('SELECT base_url, model, api_key_ref FROM providers WHERE id = ?', initial.id)!;
    expect(replacement).toMatchObject({
      base_url: 'https://replacement.test/v1', model: 'replacement-model'
    });
    expect(replacement.api_key_ref).not.toBe(initial.api_key_ref);
    expect(secretValue(db, initial.api_key_ref as string)).toBeNull();
    expect(secretValue(db, replacement.api_key_ref as string)).toBe('replacement-key');
    expect(db.rows("SELECT action, target, result FROM audit_logs WHERE action = 'provider.secret.store' ORDER BY rowid"))
      .toEqual([
        { action: 'provider.secret.store', target: initial.id, result: 'ok' },
        { action: 'provider.secret.store', target: initial.id, result: 'replaced' }
      ]);
  });

  it('rejects a legacy Provider origin change without a new key and preserves the old credential', () => {
    saveProviderConfig(db as never, {
      baseUrl: 'https://initial.test/v1', model: 'initial-model', apiKey: 'initial-key'
    });
    const initial = db.row('SELECT id, base_url, model, api_key_ref FROM providers')!;

    expect(() => saveProviderConfig(db as never, {
      baseUrl: 'https://attacker.test/v1', model: 'changed-model'
    })).toThrow('requires a new API Key');

    expect(db.row('SELECT id, base_url, model, api_key_ref FROM providers')).toEqual(initial);
    expect(secretValue(db, initial.api_key_ref as string)).toBe('initial-key');
  });

  it('does not attach an unmigrated legacy key to a newly saved origin', () => {
    db.setSetting(PROVIDER_SETTING, { baseUrl: 'https://legacy.test/v1', model: 'legacy-model' });
    db.setSetting(`secret:${PROVIDER_KEY_REF}`, encrypted('legacy-key'));

    expect(() => saveProviderConfig(db as never, {
      baseUrl: 'https://attacker.test/v1', model: 'changed-model'
    })).toThrow('requires a new API Key');
    expect(db.rows('SELECT * FROM providers')).toEqual([]);
    expect(secretValue(db, `secret:${PROVIDER_KEY_REF}`)).toBe('legacy-key');

    saveProviderConfig(db as never, {
      baseUrl: 'https://attacker.test/v1', model: 'changed-model', apiKey: 'replacement-key'
    });
    const replacement = db.row('SELECT base_url, api_key_ref FROM providers')!;
    expect(replacement.base_url).toBe('https://attacker.test/v1');
    expect(replacement.api_key_ref).not.toBe(`secret:${PROVIDER_KEY_REF}`);
    expect(secretValue(db, `secret:${PROVIDER_KEY_REF}`)).toBeNull();
    expect(secretValue(db, replacement.api_key_ref as string)).toBe('replacement-key');
  });

  it('requires a new key and rotates its reference when ProviderManager changes origin', () => {
    const provider = providers.create({
      name: 'Initial', baseUrl: 'https://initial.test/v1', model: 'model', apiKey: 'initial-key'
    });
    const initial = db.row('SELECT base_url, api_key_ref FROM providers WHERE id = ?', provider.id)!;

    expect(() => providers.update(provider.id, { baseUrl: 'https://attacker.test/v1' }))
      .toThrow('requires a new API Key');
    expect(db.row('SELECT base_url, api_key_ref FROM providers WHERE id = ?', provider.id)).toEqual(initial);

    providers.update(provider.id, { baseUrl: 'https://replacement.test/v1', apiKey: 'replacement-key' });
    const replacement = db.row('SELECT base_url, api_key_ref FROM providers WHERE id = ?', provider.id)!;
    expect(replacement.base_url).toBe('https://replacement.test/v1');
    expect(replacement.api_key_ref).not.toBe(initial.api_key_ref);
    expect(secretValue(db, initial.api_key_ref as string)).toBeNull();
    expect(secretValue(db, replacement.api_key_ref as string)).toBe('replacement-key');
  });

  it('allows path changes on the same origin without reusing a key across origins', () => {
    const provider = providers.create({
      name: 'Initial', baseUrl: 'https://initial.test/v1', model: 'model', apiKey: 'initial-key'
    });
    const initial = db.row('SELECT api_key_ref FROM providers WHERE id = ?', provider.id)!;

    providers.update(provider.id, { baseUrl: 'https://initial.test/openai/v2' });

    expect(db.row('SELECT base_url, api_key_ref FROM providers WHERE id = ?', provider.id)).toEqual({
      base_url: 'https://initial.test/openai/v2', api_key_ref: initial.api_key_ref
    });
    expect(secretValue(db, initial.api_key_ref as string)).toBe('initial-key');
  });

  it('rolls back all legacy save writes when secret auditing fails', () => {
    saveProviderConfig(db as never, {
      baseUrl: 'https://initial.test/v1', model: 'initial-model', apiKey: 'initial-key'
    });
    const initial = db.row('SELECT id, base_url, model, api_key_ref FROM providers')!;
    db.raw.prepare('DELETE FROM audit_logs').run();
    db.failAfterAuditAction = 'provider.secret.store';

    expect(() => saveProviderConfig(db as never, {
      baseUrl: 'https://changed.test/v1', model: 'changed-model', apiKey: 'changed-key'
    })).toThrow('injected failure: provider.secret.store');

    expect(db.row('SELECT id, base_url, model, api_key_ref FROM providers')).toEqual(initial);
    expect(secretValue(db, initial.api_key_ref as string)).toBe('initial-key');
    expect(db.rows('SELECT * FROM audit_logs')).toEqual([]);
  });
});
