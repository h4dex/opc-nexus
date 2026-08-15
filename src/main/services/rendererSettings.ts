import type { RendererSettingKey, RendererSettingMap } from '../../shared/types.js';
import type { Database } from './database.js';

const SETTING_KEYS = new Set<RendererSettingKey>([
  'theme',
  'thresholds',
  'notifications',
  'demoAutoTasks',
  'memory:autoAcceptConversationProposals'
]);

function settingKey(value: unknown): RendererSettingKey {
  if (typeof value !== 'string' || !SETTING_KEYS.has(value as RendererSettingKey)) {
    throw new Error('Renderer setting key is not allowed');
  }
  return value as RendererSettingKey;
}

function finiteInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

export function validateRendererSetting<K extends RendererSettingKey>(
  key: K,
  value: unknown
): RendererSettingMap[K] {
  if (key === 'theme') {
    if (value !== 'dark' && value !== 'light') throw new Error('Invalid theme setting');
    return value as RendererSettingMap[K];
  }
  if (key === 'notifications' || key === 'demoAutoTasks' || key === 'memory:autoAcceptConversationProposals') {
    if (typeof value !== 'boolean') throw new Error(`Invalid ${key} setting`);
    return value as RendererSettingMap[K];
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid thresholds setting');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 3 || !keys.every((name) => ['cpu', 'mem', 'gpuTemp'].includes(name))) {
    throw new Error('Invalid thresholds setting');
  }
  if (!finiteInRange(record.cpu, 50, 100)
    || !finiteInRange(record.mem, 50, 100)
    || !finiteInRange(record.gpuTemp, 50, 110)) {
    throw new Error('Invalid thresholds setting');
  }
  return { cpu: record.cpu, mem: record.mem, gpuTemp: record.gpuTemp } as RendererSettingMap[K];
}

export function readRendererSetting(
  db: Database,
  inputKey: unknown
): RendererSettingMap[RendererSettingKey] | null {
  const key = settingKey(inputKey);
  const stored = db.getSetting<unknown>(key, null);
  if (stored === null) return null;
  try {
    return validateRendererSetting(key, stored);
  } catch {
    return null;
  }
}

export function writeRendererSetting(db: Database, inputKey: unknown, value: unknown): void {
  const key = settingKey(inputKey);
  const validated = validateRendererSetting(key, value);
  db.setSetting(key, validated);
}
