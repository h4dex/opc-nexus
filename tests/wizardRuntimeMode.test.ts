import { describe, expect, it } from 'vitest';
import type { Engine } from '../src/shared/types.js';
import {
  isSelectableLocalEngine,
  selectDefaultLocalEngineId
} from '../src/renderer/src/wizard/runtimeMode.js';

type EngineFixture = Pick<Engine, 'id' | 'isDefault' | 'status'>;
const RETIRED_ENGINE_IDS = ['eng-deepseek-harness', 'eng-deepseek-harness-managed'] as const;

function engine(id: string, status: Engine['status'], isDefault = false): EngineFixture {
  return { id, status, isDefault };
}

describe('digital employee runtime mode engine selection', () => {
  it('never treats a retired execution engine as a local CLI default', () => {
    const engines = [
      engine(RETIRED_ENGINE_IDS[1], 'HEALTHY', true),
      engine('eng-codex', 'HEALTHY'),
      engine('eng-claude', 'AUTH_REQUIRED')
    ];

    expect(selectDefaultLocalEngineId(engines)).toBe('eng-codex');
    expect(isSelectableLocalEngine(engines[0]!)).toBe(false);
  });

  it('keeps the retired one-shot adapter out of new employee choices', () => {
    const legacy = engine(RETIRED_ENGINE_IDS[0], 'HEALTHY', true);
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
      engine(RETIRED_ENGINE_IDS[1], 'AUTH_REQUIRED', true),
      engine('eng-codex', 'NOT_INSTALLED')
    ])).toBe('');
  });
});
