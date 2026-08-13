import type { Agent, CreateAgentInput, MobileToolName } from '../../shared/types.js';
import type { Orchestrator } from './orchestrator.js';
import type { MobileGatewayService } from './mobileGatewayService.js';

export async function createProvisionedAgent(
  orchestrator: Orchestrator,
  mobile: MobileGatewayService,
  input: CreateAgentInput,
  mobileTools: MobileToolName[] | null
): Promise<Agent> {
  const agentCheckpoint = orchestrator.checkpointAgentCreation(input);
  const agent = orchestrator.createAgent(input);

  // createAgent deliberately returns an existing active employee unchanged.
  if (agentCheckpoint.existing?.archived === 0 || agent.kind !== 'android_operator') return agent;
  if (!mobileTools) throw new Error('Android tool policy is required for an Android operator');

  let mobileCheckpoint: ReturnType<MobileGatewayService['checkpointAgentProvision']> | null = null;
  try {
    mobileCheckpoint = mobile.checkpointAgentProvision(agent.id);
    await mobile.ensureAgentProfile(agent, mobileTools);
    if (input.deviceId) {
      await mobile.bindAgent(agent.id, input.deviceId, mobileTools, input.mobileAuthorizationConfirmed === true);
    }
    mobile.commitAgentProvision(mobileCheckpoint);
    return agent;
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    try {
      if (mobileCheckpoint) mobile.rollbackAgentProvision(mobileCheckpoint);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    try {
      orchestrator.rollbackAgentCreation(agentCheckpoint, agent.id);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length) {
      throw new AggregateError([error, ...rollbackErrors], 'Android operator provisioning failed and compensation was incomplete');
    }
    throw error;
  }
}
