import { describe, expect, it } from 'vitest';
import { DSH_MANAGED_ENGINE_ID, LEGACY_DSH_ENGINE_ID, type Engine } from '../src/shared/types.js';
import {
  isSelectableLocalEngine,
  selectDefaultLocalEngineId
} from '../src/renderer/src/wizard/runtimeMode.js';

type EngineFixture = Pick<Engine, 'id' | 'isDefault' | 'status'>;

function engine(id: string, status: Engine['status'], isDefault = false): EngineFixture {
  return { id, status, isDefault };
}

describe('digital employee runtime mode engine selection', () => {
  it('never treats the managed DSH engine as a local CLI default', () => {
    const engines = [
      engine(DSH_MANAGED_ENGINE_ID, 'HEALTHY', true),
      engine('eng-codex', 'HEALTHY'),
      engine('eng-claude', 'AUTH_REQUIRED')
    ];

    expect(selectDefaultLocalEngineId(engines)).toBe('eng-codex');
    expect(isSelectableLocalEngine(engines[0]!)).toBe(false);
  });

  it('keeps the legacy one-shot DSH adapter out of new employee choices', () => {
    const legacy = engine(LEGACY_DSH_ENGINE_ID, 'HEALTHY', true);
    const codex = engine('eng-codex', 'HEALTHY');

    expect(isSelectableLocalEngine(legacy)).toBe(false);
    expect(selectDefaultLocalEngineId([legacy, codex])).toBe('eng-codex');
  });

  it('prefers an eligible local default and returns empty when none exists', () => {
    expect(selectDefaultLocalEngineId([
      engine('eng-codex', 'HEALTHY'),
      engine('eng-claude', 'SETUP_REQUIRED', true)
    ])).toBe('eng-claude');

    expect(selectDefaultLocalEngineId([
      engine(DSH_MANAGED_ENGINE_ID, 'AUTH_REQUIRED', true),
      engine('eng-codex', 'NOT_INSTALLED')
    ])).toBe('');
  });
});
