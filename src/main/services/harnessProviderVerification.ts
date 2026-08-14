import { createHash } from 'node:crypto';
import type { Database } from './database.js';

export const HARNESS_PROVIDER_FINGERPRINT_SETTING = 'engine:health:eng-deepseek-harness:provider-fingerprint';

interface ProviderFingerprintRow {
  id: string;
  base_url: string;
  model: string;
  api_key_ref: string;
  is_default: number;
}

/**
 * Bind a Harness task probe to the exact Provider configuration it exercised.
 * The persisted value is a one-way digest; neither plaintext credentials nor
 * encrypted credential blobs are exposed through engine health diagnostics.
 */
export function harnessProviderFingerprint(db: Database): string {
  const rows = db.raw.prepare(
    'SELECT id, base_url, model, api_key_ref, is_default FROM providers ORDER BY id'
  ).all() as unknown as ProviderFingerprintRow[];
  const material = rows.map((row) => ({
    id: row.id,
    baseUrl: row.base_url?.trim() ?? '',
    model: row.model?.trim() ?? '',
    keyRef: row.api_key_ref ?? '',
    encryptedKey: row.api_key_ref ? db.getSetting<string | null>(row.api_key_ref, null) : null,
    isDefault: row.is_default === 1
  }));
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

export function verifiedHarnessProviderFingerprint(db: Database): string | null {
  return db.getSetting<string | null>(HARNESS_PROVIDER_FINGERPRINT_SETTING, null);
}

export function harnessProviderVerificationIsCurrent(db: Database): boolean {
  const verified = verifiedHarnessProviderFingerprint(db);
  return verified !== null && verified === harnessProviderFingerprint(db);
}

export function saveHarnessProviderFingerprint(db: Database, fingerprint: string | null): void {
  db.setSetting(HARNESS_PROVIDER_FINGERPRINT_SETTING, fingerprint);
}
