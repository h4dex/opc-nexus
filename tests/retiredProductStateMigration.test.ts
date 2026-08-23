import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => ({ safeStorage: {} }));
import { purgeRetiredProductState, purgeRetiredRuntimeDirectories } from '../src/main/services/seed.js';
import {
  HERMES_MOBILE_TLS_CERTIFICATE_KEY,
  HERMES_MOBILE_TLS_PRIVATE_KEY_REF
} from '../src/main/services/hermesMobileGateway.js';

class MemoryDb {
  readonly settings = new Map<string, unknown>();
  readonly audits: Array<Record<string, unknown>> = [];
  private inTransaction = false;

  readonly raw = {
    prepare: (sql: string) => ({
      run: (...values: unknown[]) => {
        if (!/DELETE FROM settings/i.test(sql)) return { changes: 0 };
        if (/key LIKE 'dsh:lan:%'/i.test(sql)) {
          const exact = new Set(values.map(String));
          let removed = 0;
          for (const key of [...this.settings.keys()]) {
            if (key.startsWith('dsh:lan:') || key.startsWith('secret:dsh:lan:') || exact.has(key)) {
              this.settings.delete(key);
              removed += 1;
            }
          }
          return { changes: removed };
        }
        const removed = values.reduce((count, value) => {
          if (!this.settings.has(String(value))) return count;
          this.settings.delete(String(value));
          return count + 1;
        }, 0);
        return { changes: removed };
      }
    })
  };

  transaction<T>(operation: () => T): T {
    if (this.inTransaction) throw new Error('nested transaction');
    this.inTransaction = true;
    try { return operation(); } finally { this.inTransaction = false; }
  }

  audit(entry: Record<string, unknown>): void {
    this.audits.push(entry);
  }
}

describe('retired product state cleanup', () => {
  it('removes retired DSH LAN and Web admin settings while keeping Hermes separate', () => {
    const db = new MemoryDb();
    db.settings.set('dsh:lan:gateway', { enabled: true });
    db.settings.set('dsh:lan:tls:certificate', 'legacy-cert');
    db.settings.set('secret:dsh:lan:tls:privateKey', 'legacy-secret');
    db.settings.set('legacyWebAdminEnabled', true);
    db.settings.set('secret:webserver:token', 'legacy-web-secret');
    db.settings.set(HERMES_MOBILE_TLS_CERTIFICATE_KEY, 'hermes-cert');
    db.settings.set(HERMES_MOBILE_TLS_PRIVATE_KEY_REF, 'hermes-secret');

    expect(purgeRetiredProductState(db as never)).toBe(true);
    expect([...db.settings.keys()]).toEqual([
      HERMES_MOBILE_TLS_CERTIFICATE_KEY,
      HERMES_MOBILE_TLS_PRIVATE_KEY_REF
    ]);
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({
      action: 'legacy.productState.remove',
      result: 'retired:5',
      source: 'migration'
    });
  });

  it('is idempotent when an upgraded installation has no retired settings', () => {
    const db = new MemoryDb();
    expect(purgeRetiredProductState(db as never)).toBe(false);
    expect(db.audits).toHaveLength(0);
  });

  it('removes only app-owned retired runtime directories and keeps Hermes data', () => {
    const root = mkdtempSync(join(tmpdir(), 'opc-retired-runtime-'));
    const legacy = join(root, 'deepseek-harness');
    const managed = join(root, 'deepseek-harness-managed');
    const hermes = join(root, 'hermes');
    mkdirSync(legacy);
    mkdirSync(managed);
    mkdirSync(hermes);
    writeFileSync(join(legacy, 'legacy.txt'), 'retired');
    writeFileSync(join(managed, 'legacy.txt'), 'retired');
    writeFileSync(join(hermes, 'memory.txt'), 'keep');
    try {
      expect(purgeRetiredRuntimeDirectories(root)).toEqual({
        removed: ['deepseek-harness', 'deepseek-harness-managed'],
        failed: []
      });
      expect(existsSync(legacy)).toBe(false);
      expect(existsSync(managed)).toBe(false);
      expect(existsSync(join(hermes, 'memory.txt'))).toBe(true);
      expect(purgeRetiredRuntimeDirectories(root)).toEqual({ removed: [], failed: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
