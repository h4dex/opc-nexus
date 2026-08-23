import { describe, expect, it } from 'vitest';
import type { Agent } from '../src/shared/types.js';
import {
  isLegacyBootstrappedCordisAgent,
  LEGACY_CORDIS_ROLE,
  LEGACY_CORDIS_SYSTEM_PROMPT
} from '../src/main/services/legacyCordisMigration.js';

function employee(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'legacy-cordis',
    kind: 'general',
    name: 'Cordis',
    role: LEGACY_CORDIS_ROLE,
    systemPrompt: LEGACY_CORDIS_SYSTEM_PROMPT,
    soulMd: '',
    agentsMd: '',
    userMd: '',
    lifecycle: 'READY',
    engineId: 'eng-deepseek-harness-managed',
    workspace: 'C:\\Users\\owner\\AppData\\Roaming\\opc-nexus\\aibox-data\\workspaces\\Cordis',
    permissionMode: 'autonomous',
    memoryMode: 'short_term',
    capabilities: { network: false, shell: false, install: false, browser: false, computer: false, mobile: false },
    tags: [],
    concurrencyLimit: 1,
    archived: false,
    avatarColor: '#4d6bfe',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

describe('legacy Cordis migration', () => {
  it('matches only the exact startup-created employee', () => {
    expect(isLegacyBootstrappedCordisAgent(employee())).toBe(true);
    expect(isLegacyBootstrappedCordisAgent(employee({ role: '用户自定义负责人' }))).toBe(false);
    expect(isLegacyBootstrappedCordisAgent(employee({ systemPrompt: '用户自定义提示词' }))).toBe(false);
    expect(isLegacyBootstrappedCordisAgent(employee({ workspace: 'E:\\Projects\\Cordis' }))).toBe(false);
    expect(isLegacyBootstrappedCordisAgent(employee({ engineId: 'eng-codex' }))).toBe(false);
  });
});
