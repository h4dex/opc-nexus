import { describe, expect, it } from 'vitest';
import { engineDisplayName } from '../src/shared/engineVisibility.js';
import { isUserVisibleEngine } from '../src/renderer/src/utils/engineVisibility.js';

const RETIRED_ENGINE_IDS = ['eng-deepseek-harness', 'eng-deepseek-harness-managed', 'eng-hermes', 'eng-zcode', 'eng-kimi'];

describe('engine visibility', () => {
  it('hides retired execution engines while keeping real worker engines visible', () => {
    for (const id of RETIRED_ENGINE_IDS) expect(isUserVisibleEngine({ id })).toBe(false);
    expect(isUserVisibleEngine({ id: 'eng-codex' })).toBe(true);
  });

  it('normalizes historical built-in labels before they reach user-facing views', () => {
    expect(engineDisplayName('eng-nexus', 'Nexus Agent')).toBe('OPC-Nexus Worker');
    expect(engineDisplayName('eng-hermes-cli', 'Hermes Agent')).toBe('Hermes Agent CLI Worker');
    expect(engineDisplayName('eng-codex', 'OpenAI Codex CLI')).toBe('OpenAI Codex CLI');
  });
});
