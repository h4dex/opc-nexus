import { describe, expect, it } from 'vitest';
import { DSH_MANAGED_ENGINE_ID, LEGACY_DSH_ENGINE_ID } from '../src/shared/types.js';
import { isUserVisibleEngine } from '../src/renderer/src/utils/engineVisibility.js';

describe('engine visibility', () => {
  it('shows managed DSH/Cordis and hides only the legacy ACP adapter', () => {
    expect(isUserVisibleEngine({ id: DSH_MANAGED_ENGINE_ID })).toBe(true);
    expect(isUserVisibleEngine({ id: LEGACY_DSH_ENGINE_ID })).toBe(false);
    expect(isUserVisibleEngine({ id: 'eng-codex' })).toBe(true);
  });
});
