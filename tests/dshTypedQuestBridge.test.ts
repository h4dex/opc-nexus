import { describe, expect, it, vi } from 'vitest';
import { hashCanonicalJson, type CompanyExecutionPlan, type PlanningComplexitySignals } from '../src/main/services/secretaryPlanning.js';
import {
  DshTypedQuestBridge,
  DshTypedQuestBridgeError,
  type DshTypedQuestContext
} from '../src/main/services/dshTypedQuestBridge.js';
import type { DshControlPort, DshQuestionRequestedFrame } from '../src/main/services/dshControlClient.js';
import type { DshQuestGovernanceView } from '../src/main/services/dshQuestGovernance.js';
import { DshPolicyBroker } from '../src/main/services/dshPolicyBroker.js';
import { resolveBuiltinDshHostPolicy } from '../src/main/services/dshPluginPolicy.js';

const signals: PlanningComplexitySignals = {
  departmentIds: ['content'],
  hasCrossTeamDependencies: false,
  ambiguousObjective: false,
  ambiguousScope: false,
  ambiguousAcceptance: false,
  estimatedDurationMinutes: 90,
  estimatedCost: 1,
  estimatedTokenCount: 10_000,
  requiresNewTeam: false,
  irreversibleOperations: [],
  compareAlternatives: false,
  phasedExecution: true,
  confirmBeforeExecution: true
};

const context: DshTypedQuestContext = {
  runtimeInstanceId: 'runtime-cordis',
  dshSessionId: 'session-cordis-root',
  planningSessionId: 'quest-typed-1',
  projectId: 'project-1',
  principalId: 'principal-owner',
  request: 'Deliver a reviewed artifact',
  signals
};

function view(overrides: Partial<DshQuestGovernanceView> = {}): DshQuestGovernanceView {
  return {
    binding: {
      planningSessionId: context.planningSessionId,
      projectId: context.projectId,
      dshSessionId: context.dshSessionId,
      organizationId: 'org-1',
      principalId: context.principalId,
      createdAt: 1,
      updatedAt: 1
    },
    session: {
      id: context.planningSessionId,
      organizationId: 'org-1',
      principalId: context.principalId,
      request: context.request,
      signals,
      status: 'DRAFT',
      gateDecision: { requiresPlanning: true, complexityScore: 1, riskScore: 1, reasons: ['LONG_TASK'] },
      questionSetVersion: 0,
      activeQuestionSetVersion: null,
      latestPlanVersion: 0,
      approvedPlanVersion: null,
      approvedPlanHash: null,
      dispatchPlanVersion: null,
      dispatchPlanHash: null,
      dispatchStartedAt: null,
      supersededBySessionId: null,
      revision: 1,
      createdAt: 1,
      updatedAt: 1
    },
    activeQuestionSet: null,
    planVersions: [],
    questionProjections: [],
    planProjections: [],
    dispatchReceipts: [],
    ...overrides
  };
}

function plan(): CompanyExecutionPlan {
  return {
    schemaVersion: 1,
    organizationId: 'org-1',
    objective: 'Deliver a reviewed artifact',
    assumptions: [],
    scope: { included: ['artifact'], excluded: [] },
    team: [{ teamId: 'team-1', organizationId: 'org-1', leadAgentId: 'agent-1', memberAgentIds: [], proposedEphemeralRoles: [] }],
    dag: [{
      nodeId: 'node-1', organizationId: 'org-1', ownerAgentId: 'agent-1', dependencies: [],
      workOrder: 'Write the artifact', expectedArtifacts: ['artifact.md'], acceptanceCriteria: ['reviewed'],
      permissionProfile: 'standard', requiredPermissions: ['read'],
      budget: { timeMinutes: 20, tokenLimit: 1000, costLimit: 1 },
      retryPolicy: { maxAttempts: 1, backoff: 'none' }
    }],
    risks: [],
    overallBudget: { timeMinutes: 20, tokenLimit: 1000, costLimit: 1 },
    acceptanceCriteria: ['reviewed']
  };
}

function frame(): DshQuestionRequestedFrame {
  return {
    type: 'question/requested',
    sessionId: context.dshSessionId,
    questions: [{
      id: 'plan-review',
      header: 'Plan review',
      question: 'Approve this plan?',
      detail: '# Plan\n\n1. Write the artifact',
      options: [
        { label: 'Approve', description: 'Run it' },
        { label: 'Keep planning', description: 'Revise it' }
      ],
      intent: { kind: 'plan-review', approve: 'Approve' }
    }]
  };
}

function questPolicy() {
  return new DshPolicyBroker({ resolve: resolveBuiltinDshHostPolicy }).scopeRuntime({
    organizationId: 'org-1', runtimeId: context.runtimeInstanceId, agentId: 'agent-1'
  });
}

function scopedPolicy(contextValue: DshTypedQuestContext, effect: 'allow' | 'deny' | 'require_approval' = 'allow') {
  return new DshPolicyBroker({
    resolve: async () => ({
      effect,
      reasonCode: effect === 'allow' ? 'test_allow' : effect === 'deny' ? 'test_deny' : 'test_approval',
      ...(effect === 'require_approval' ? { approvalId: 'approval-test' } : {})
    })
  }).scopeRuntime({
    organizationId: 'org-1',
    runtimeId: contextValue.runtimeInstanceId,
    agentId: 'agent-1'
  });
}

describe('DshTypedQuestBridge', () => {
  it('projects typed rc.6 questions with plan-review metadata and is idempotent on replay', async () => {
    let current = view();
    const governance = {
      openQuest: vi.fn(() => current),
      getQuest: vi.fn(() => current),
      projectQuestionSet: vi.fn((input: { questionSet: { id: string; version: number } }) => {
        current = view({
          session: { ...current.session, status: 'NEEDS_INPUT', questionSetVersion: input.questionSet.version, activeQuestionSetVersion: input.questionSet.version, revision: 2 },
          questionProjections: [{ dshQuestionSetId: input.questionSet.id, dshVersion: input.questionSet.version, localVersion: input.questionSet.version, payloadHash: '0'.repeat(64), createdAt: 2 }]
        });
        return current;
      }),
      projectPlan: vi.fn(),
      answerQuestions: vi.fn()
    };
    const bridge = new DshTypedQuestBridge({ governance, policyForContext: () => questPolicy() });
    const first = await bridge.projectQuestionSet(frame(), context, 'rpc-question-1');
    expect(governance.projectQuestionSet).toHaveBeenCalledTimes(1);
    expect(first.projection.planReview).toMatchObject({ kind: 'plan-review', approveLabel: 'Approve', markdown: '# Plan\n\n1. Write the artifact' });
    expect(first.projection.questions[0]).toMatchObject({ kind: 'single', recommendedOptionId: expect.stringMatching(/^dsh-option-/), recommendationReason: '# Plan\n\n1. Write the artifact' });
    const replay = await bridge.projectQuestionSet(frame(), context, 'rpc-question-1-replay');
    expect(governance.projectQuestionSet).toHaveBeenCalledTimes(1);
    expect(replay.projection.sourceId).toBe(first.projection.sourceId);
  });

  it('maps DSH answer labels to durable governance option ids without parsing prose', async () => {
    const bridge = new DshTypedQuestBridge({
      governance: {
        openQuest: vi.fn(() => view()),
        getQuest: vi.fn(() => view()),
        projectQuestionSet: vi.fn(),
        projectPlan: vi.fn(),
        answerQuestions: vi.fn()
      },
      policyForContext: () => questPolicy()
    });
    const answers = bridge.toGovernanceAnswers(frame(), { answers: [{ id: 'plan-review', selected: ['Approve'] }] });
    expect(answers).toEqual([{
      questionId: 'plan-review',
      selectedOptionIds: [expect.stringMatching(/^dsh-option-/)],
      text: null
    }]);
    expect(() => bridge.toGovernanceAnswers(frame(), { answers: [{ id: 'plan-review', selected: ['not-an-option'] }] })).toThrowError(
      expect.objectContaining({ code: 'ANSWER_INVALID' })
    );
  });

  it('accepts only a structured plan and verifies the declared hash', async () => {
    let current = view();
    const governance = {
      openQuest: vi.fn(() => current),
      getQuest: vi.fn(() => current),
      projectQuestionSet: vi.fn(),
      projectPlan: vi.fn((input: { plan: { id: string; version: number; hash: string } }) => {
        current = view({
          session: { ...current.session, status: 'PROPOSED', latestPlanVersion: input.plan.version, revision: 2 },
          planProjections: [{ dshPlanId: input.plan.id, dshVersion: input.plan.version, localVersion: input.plan.version, planHash: input.plan.hash, createdAt: 2 }]
        });
        return current;
      }),
      answerQuestions: vi.fn()
    };
    const bridge = new DshTypedQuestBridge({ governance, policyForContext: () => questPolicy() });
    const value = plan();
    const hash = hashCanonicalJson(value);
    const projected = await bridge.projectPlan(context, { id: 'cordis-plan-1', version: 1, value, hash });
    expect(projected.planHash).toBe(hash);
    expect(governance.projectPlan).toHaveBeenCalledTimes(1);
    await expect(bridge.projectPlan(context, { id: 'cordis-plan-1', version: 1, value, hash: '0'.repeat(64) })).rejects.toMatchObject({ code: 'PLAN_INVALID' });
    expect(() => bridge.projectPlan).not.toThrow();
  });

  it('keeps resolved frames typed and does not invent a governance decision', async () => {
    const bridge = new DshTypedQuestBridge({
      governance: {
        openQuest: vi.fn(() => view()),
        getQuest: vi.fn(() => view()),
        projectQuestionSet: vi.fn(() => view()),
        projectPlan: vi.fn(),
        answerQuestions: vi.fn()
      },
      policyForContext: () => questPolicy(),
      resolveContext: () => context
    });
    await bridge.handleEnvelope({ rpcId: 'rpc-q', payload: frame() }, new AbortController().signal);
    const resolved = await bridge.handleEnvelope({
      rpcId: 'push-resolved',
      payload: { type: 'question/resolved', sessionId: context.dshSessionId, questionRpcId: 'rpc-q', outcome: 'answered' }
    });
    expect(resolved).toMatchObject({ kind: 'question-resolved', frame: { outcome: 'answered' }, requested: { kind: 'question-requested' } });

    const duplicate = await bridge.handleEnvelope({
      rpcId: 'push-resolved-again',
      payload: { type: 'question/resolved', sessionId: context.dshSessionId, questionRpcId: 'rpc-q', outcome: 'answered' }
    });
    expect(duplicate).toMatchObject({ kind: 'question-resolved', frame: { outcome: 'answered' } });
    expect(duplicate).not.toHaveProperty('requested');

    await bridge.handleEnvelope({ rpcId: 'rpc-cancel', payload: frame() });
    const cancelled = await bridge.handleEnvelope({
      rpcId: 'push-cancelled',
      payload: { type: 'question/resolved', sessionId: context.dshSessionId, questionRpcId: 'rpc-cancel', outcome: 'cancelled' }
    });
    expect(cancelled).toHaveProperty('requested');
    const cancelledAgain = await bridge.handleEnvelope({
      rpcId: 'push-cancelled-again',
      payload: { type: 'question/resolved', sessionId: context.dshSessionId, questionRpcId: 'rpc-cancel', outcome: 'cancelled' }
    });
    expect(cancelledAgain).not.toHaveProperty('requested');
  });

  it('fails closed before durable projection when Main has no authenticated policy scope', async () => {
    const openQuest = vi.fn(() => view());
    const projectQuestionSet = vi.fn(() => view());
    const bridge = new DshTypedQuestBridge({
      governance: {
        openQuest,
        getQuest: vi.fn(() => view()),
        projectQuestionSet,
        projectPlan: vi.fn(),
        answerQuestions: vi.fn()
      }
    });
    await expect(bridge.projectQuestionSet(frame(), context)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(openQuest).not.toHaveBeenCalled();
    expect(projectQuestionSet).not.toHaveBeenCalled();
  });

  it.each(['deny', 'require_approval'] as const)(
    'does not project durable Quest state when policy returns %s',
    async (effect) => {
      const openQuest = vi.fn(() => view());
      const projectQuestionSet = vi.fn(() => view());
      const bridge = new DshTypedQuestBridge({
        governance: {
          openQuest,
          getQuest: vi.fn(() => view()),
          projectQuestionSet,
          projectPlan: vi.fn(),
          answerQuestions: vi.fn()
        },
        policyForContext: (value) => scopedPolicy(value, effect)
      });

      await expect(bridge.projectQuestionSet(frame(), context)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      expect(openQuest).not.toHaveBeenCalled();
      expect(projectQuestionSet).not.toHaveBeenCalled();
    }
  );

  it('does not project durable Quest state when cancellation arrives during policy evaluation', async () => {
    const controller = new AbortController();
    const openQuest = vi.fn(() => view());
    const projectQuestionSet = vi.fn(() => view());
    const policy = new DshPolicyBroker({
      resolve: async () => {
        controller.abort();
        return { effect: 'allow', reasonCode: 'test_allow' };
      }
    }).scopeRuntime({
      organizationId: 'org-1', runtimeId: context.runtimeInstanceId, agentId: 'agent-1'
    });
    const bridge = new DshTypedQuestBridge({
      governance: {
        openQuest,
        getQuest: vi.fn(() => view()),
        projectQuestionSet,
        projectPlan: vi.fn(),
        answerQuestions: vi.fn()
      },
      policyForContext: () => policy
    });

    await expect(bridge.projectQuestionSet(frame(), context, 'rpc-cancel-policy', controller.signal))
      .rejects.toMatchObject({ code: 'ABORTED' });
    expect(openQuest).not.toHaveBeenCalled();
    expect(projectQuestionSet).not.toHaveBeenCalled();
  });

  it('does not persist or send an owner response when policy requires approval', async () => {
    let current = view();
    const answerQuestions = vi.fn(() => current);
    const governance = {
      openQuest: vi.fn(() => current),
      getQuest: vi.fn(() => current),
      projectQuestionSet: vi.fn((input: { questionSet: { id: string; version: number } }) => {
        current = view({
          session: {
            ...current.session,
            status: 'NEEDS_INPUT',
            questionSetVersion: input.questionSet.version,
            activeQuestionSetVersion: input.questionSet.version,
            revision: 2
          },
          questionProjections: [{
            dshQuestionSetId: input.questionSet.id,
            dshVersion: input.questionSet.version,
            localVersion: input.questionSet.version,
            payloadHash: '0'.repeat(64),
            createdAt: 2
          }]
        });
        return current;
      }),
      projectPlan: vi.fn(),
      answerQuestions
    };
    await new DshTypedQuestBridge({ governance, policyForContext: () => questPolicy() })
      .projectQuestionSet(frame(), context, 'rpc-owner-policy');
    answerQuestions.mockClear();
    const respondQuestion = vi.fn();
    const bridge = new DshTypedQuestBridge({
      governance,
      policyForContext: (value) => scopedPolicy(value, 'require_approval')
    });
    await expect(bridge.answerQuestion(
      { respondQuestion } as unknown as DshControlPort,
      {
        rpcId: 'rpc-owner-policy',
        frame: frame(),
        context,
        principalId: context.principalId,
        answer: { answers: [{ id: 'plan-review', selected: ['Approve'] }] }
      }
    )).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(answerQuestions).not.toHaveBeenCalled();
    expect(respondQuestion).not.toHaveBeenCalled();
  });
});
