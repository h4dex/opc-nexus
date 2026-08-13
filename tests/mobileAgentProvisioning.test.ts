// @ts-nocheck
import { describe, expect, it, vi } from 'vitest';
import { createProvisionedAgent } from '../src/main/services/mobileAgentProvisioning.js';

const input = {
  name: 'Android Operator', role: 'Operate the assigned Android phone', systemPrompt: '', engineId: 'eng-hermes-cli',
  workspace: '', permissionMode: 'standard', concurrencyLimit: 1, channelIds: [], kind: 'android_operator',
  deviceId: 'phone-1', mobileAuthorizationConfirmed: true
};
const agent = { id: 'agent-1', name: input.name, kind: 'android_operator' };

describe('Android operator provisioning compensation', () => {
  it('rolls back profile/config and a new agent when binding fails', async () => {
    const checkpoint = { existing: null, autoWorkspacePath: null, autoWorkspaceExisted: false };
    const orchestrator = {
      checkpointAgentCreation: vi.fn(() => checkpoint),
      createAgent: vi.fn(() => agent),
      rollbackAgentCreation: vi.fn()
    };
    const mobileCheckpoint = { agentId: agent.id };
    const mobile = {
      checkpointAgentProvision: vi.fn(() => mobileCheckpoint),
      ensureAgentProfile: vi.fn().mockResolvedValue({}),
      bindAgent: vi.fn().mockRejectedValue(new Error('device already bound')),
      commitAgentProvision: vi.fn(),
      rollbackAgentProvision: vi.fn()
    };

    await expect(createProvisionedAgent(orchestrator as never, mobile as never, input as never, ['android_ping']))
      .rejects.toThrow('device already bound');
    expect(mobile.rollbackAgentProvision).toHaveBeenCalledWith(mobileCheckpoint);
    expect(orchestrator.rollbackAgentCreation).toHaveBeenCalledWith(checkpoint, agent.id);
    expect(mobile.commitAgentProvision).not.toHaveBeenCalled();
  });

  it('restores an archived employee through the same checkpoint path', async () => {
    const checkpoint = { existing: { id: agent.id, archived: 1, role: 'old role' }, autoWorkspacePath: null, autoWorkspaceExisted: false };
    const orchestrator = {
      checkpointAgentCreation: vi.fn(() => checkpoint),
      createAgent: vi.fn(() => agent),
      rollbackAgentCreation: vi.fn()
    };
    const mobile = {
      checkpointAgentProvision: vi.fn(() => ({ agentId: agent.id, config: { device_id: 'old-phone' } })),
      ensureAgentProfile: vi.fn().mockRejectedValue(new Error('profile failed')),
      bindAgent: vi.fn(), commitAgentProvision: vi.fn(), rollbackAgentProvision: vi.fn()
    };
    await expect(createProvisionedAgent(orchestrator as never, mobile as never, input as never, ['android_ping']))
      .rejects.toThrow('profile failed');
    expect(orchestrator.rollbackAgentCreation).toHaveBeenCalledWith(checkpoint, agent.id);
  });

  it('does not mutate an already-active employee with the same name', async () => {
    const orchestrator = {
      checkpointAgentCreation: vi.fn(() => ({ existing: { id: agent.id, archived: 0 }, autoWorkspacePath: null, autoWorkspaceExisted: false })),
      createAgent: vi.fn(() => agent), rollbackAgentCreation: vi.fn()
    };
    const mobile = { checkpointAgentProvision: vi.fn() };
    await expect(createProvisionedAgent(orchestrator as never, mobile as never, input as never, ['android_ping'])).resolves.toBe(agent);
    expect(mobile.checkpointAgentProvision).not.toHaveBeenCalled();
  });
});
