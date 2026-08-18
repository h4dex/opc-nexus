import { describe, expect, it } from 'vitest';
import { DSH_MANAGED_ENGINE_ID } from '../src/shared/types.js';
import { CordisControlKernel } from '../src/main/services/kernel/cordisControlKernel.js';
import type { KernelRequest } from '../src/main/services/kernel/types.js';

function request(overrides: Partial<KernelRequest> = {}): KernelRequest {
  return {
    requestId: 'request-1', source: 'desktop', organizationId: 'org-local',
    principalId: 'principal-local-admin', channelId: null, conversationId: 'conversation-1',
    inputMessageId: 'message-1', message: '建立研究项目并先向我确认范围',
    preferredAgentId: 'agent-cordis', projectId: 'project-1', memories: [],
    workers: [
      { agentId: 'agent-local', name: 'Local worker', role: '执行', engineId: 'eng-codex', capabilities: [] },
      { agentId: 'agent-cordis', name: 'Cordis', role: '主 AI', engineId: DSH_MANAGED_ENGINE_ID, capabilities: [] }
    ],
    ...overrides
  };
}

describe('CordisControlKernel', () => {
  it('routes the raw owner objective to the managed Cordis root worker', async () => {
    const plan = await new CordisControlKernel().plan(request(), []);
    expect(plan).toMatchObject({
      workerAgentId: 'agent-cordis',
      objective: '建立研究项目并先向我确认范围',
      requiresHumanApproval: false
    });
    expect(plan.rationale).toContain('DSH/Cordis');
  });

  it('keeps an explicitly selected Local CLI employee on the direct compatibility route', async () => {
    await expect(new CordisControlKernel().plan(request({
      routingMode: 'direct-worker',
      preferredAgentId: 'agent-local',
    }), [])).rejects.toThrow('Local CLI dispatch adapter');
  });
});
