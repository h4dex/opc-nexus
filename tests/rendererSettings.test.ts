// @ts-nocheck
/* eslint-disable */
import { describe, expect, it, vi } from 'vitest';
import {
  readRendererSetting,
  validateRendererSetting,
  writeRendererSetting
} from '../src/main/services/rendererSettings.js';

function database(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getSetting: (key: string, fallback: unknown) => values.has(key) ? values.get(key) : fallback,
    setSetting: vi.fn((key: string, value: unknown) => values.set(key, value)),
    values
  } as never;
}

describe('Renderer setting boundary', () => {
  it('allows only the four typed UI preference keys', () => {
    const db = database({ theme: 'dark', notifications: true });

    expect(readRendererSetting(db, 'theme')).toBe('dark');
    expect(readRendererSetting(db, 'notifications')).toBe(true);
    for (const key of ['secret:provider:key', 'engine:health:eng-deepseek-harness', 'webToken', 'webPort']) {
      expect(() => readRendererSetting(db, key)).toThrow(/not allowed/);
      expect(() => writeRendererSetting(db, key, 'attacker-controlled')).toThrow(/not allowed/);
    }
  });

  it('validates primitive values and exact threshold shape before persistence', () => {
    const db = database();
    writeRendererSetting(db, 'theme', 'light');
    writeRendererSetting(db, 'demoAutoTasks', false);
    writeRendererSetting(db, 'thresholds', { cpu: 85, mem: 90, gpuTemp: 100 });

    expect(db.values.get('theme')).toBe('light');
    expect(db.values.get('thresholds')).toEqual({ cpu: 85, mem: 90, gpuTemp: 100 });
    expect(() => validateRendererSetting('theme', 'system')).toThrow(/Invalid theme/);
    expect(() => validateRendererSetting('notifications', 'true')).toThrow(/Invalid notifications/);
    expect(() => validateRendererSetting('thresholds', { cpu: 85, mem: 85, gpuTemp: 85, secret: 'x' }))
      .toThrow(/Invalid thresholds/);
    expect(() => validateRendererSetting('thresholds', { cpu: 101, mem: 85, gpuTemp: 85 }))
      .toThrow(/Invalid thresholds/);
  });

  it('fails closed when a previously stored preference is malformed', () => {
    const db = database({ thresholds: { cpu: 85, mem: 85, gpuTemp: 85, unexpected: true } });
    expect(readRendererSetting(db, 'thresholds')).toBeNull();
  });
});
