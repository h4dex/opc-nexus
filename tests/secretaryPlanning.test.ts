import {
  InMemoryPlanningRepository,
  PlanningError,
  SecretaryPlanningService,
  canonicalJson,
  evaluatePlanningGate,
  hashCanonicalJson,
  normalizeAndValidatePlan,
  type CompanyExecutionPlan,
  type DispatchPort,
  type DispatchWorkOrder,
  type PlanValidationPolicy,
  type PlanningComplexitySignals,
  type PlanningQuestion
} from '../src/main/services/secretaryPlanning.js';

function simpleSignals(overrides: Partial<PlanningComplexitySignals> = {}): PlanningComplexitySignals {
  return {
    departmentIds: ['engineering'],
    hasCrossTeamDependencies: false,
    ambiguousObjective: false,
    ambiguousScope: false,
    ambiguousAcceptance: false,
    estimatedDurationMinutes: 10,
    estimatedCost: 1,
    estimatedTokenCount: 1_000,
    requiresNewTeam: false,
    irreversibleOperations: [],
    compareAlternatives: false,
    phasedExecution: false,
    confirmBeforeExecution: false,
    estimatedTaskCount: 2,
    ...overrides
  };
}

function policy(overrides: Partial<PlanValidationPolicy> = {}): PlanValidationPolicy {
  return {
    organizationId: 'org-1',
    agents: [
      {
        id: 'agent-a',
        organizationId: 'org-1',
        lifecycle: 'READY',
        archived: false,
        permissionProfiles: ['standard'],
        permissions: ['read', 'write']
      },
      {
        id: 'agent-b',
        organizationId: 'org-1',
        lifecycle: 'READY',
        archived: false,
        permissionProfiles: ['standard'],
        permissions: ['read', 'write']
      }
    ],
    allowedPermissionProfiles: ['standard'],
    allowedPermissions: ['read', 'write'],
    maxBudget: { timeMinutes: 120, tokenLimit: 20_000, costLimit: 20 },
    maxRetryAttempts: 3,
    allowEphemeralTeams: true,
    ...overrides
  };
}

function validPlan(): CompanyExecutionPlan {
  return {
    schemaVersion: 1,
    organizationId: 'org-1',
    objective: 'Deliver a reviewed implementation',
    assumptions: ['The repository is available'],
    scope: { included: ['Implementation'], excluded: ['Production rollout'] },
    team: [
      {
        teamId: 'team-engineering',
        organizationId: 'org-1',
        leadAgentId: 'agent-a',
        memberAgentIds: ['agent-b'],
        proposedEphemeralRoles: []
      }
    ],
    // Deliberately reverse dependency order; dispatch must topologically sort it.
    dag: [
      {
        nodeId: 'node-review',
        organizationId: 'org-1',
        ownerAgentId: 'agent-b',
        dependencies: ['node-build'],
        workOrder: 'Review the implementation',
        expectedArtifacts: ['Review report'],
        acceptanceCriteria: ['No blocking findings'],
        permissionProfile: 'standard',
        requiredPermissions: ['read'],
        budget: { timeMinutes: 20, tokenLimit: 2_000, costLimit: 2 },
        retryPolicy: { maxAttempts: 2, backoff: 'linear' }
      },
      {
        nodeId: 'node-build',
        organizationId: 'org-1',
        ownerAgentId: 'agent-a',
        dependencies: [],
        workOrder: 'Build the implementation',
        expectedArtifacts: ['Source code'],
        acceptanceCriteria: ['Tests pass'],
        permissionProfile: 'standard',
        requiredPermissions: ['write', 'read'],
        budget: { timeMinutes: 30, tokenLimit: 3_000, costLimit: 3 },
        retryPolicy: { maxAttempts: 2, backoff: 'exponential' }
      }
    ],
    risks: [{ risk: 'Regression', mitigation: 'Run tests', ownerAgentId: 'agent-b' }],
    overallBudget: { timeMinutes: 60, tokenLimit: 6_000, costLimit: 6 },
    acceptanceCriteria: ['Implementation and review artifacts are present']
  };
}

function question(id: string, kind: 'single' | 'multi' | 'text'): PlanningQuestion {
  const options = kind === 'text' ? [] : [
    { id: `${id}-fast`, label: 'Fast', impact: 'Lower time, higher risk' },
    { id: `${id}-safe`, label: 'Safe', impact: 'Higher time, lower risk' }
  ];
  return {
    id,
    kind,
    prompt: `Choose ${id}`,
    options,
    recommendedOptionId: kind === 'text' ? null : `${id}-safe`,
    recommendationReason: kind === 'text' ? null : 'This option lowers delivery risk',
    allowOther: true
  };
}

function createHarness(dispatchOverride?: DispatchPort['createTask']) {
  const repository = new InMemoryPlanningRepository();
  let id = 0;
  let now = 1_000;
  const createTask = vi.fn(dispatchOverride ?? ((order: DispatchWorkOrder) => ({ taskId: `task-${order.nodeId}` })));
  const service = new SecretaryPlanningService(repository, { createTask }, {
    idFactory: () => `generated-${++id}`,
    now: () => ++now
  });
  const session = service.createSession({
    id: 'session-1',
    organizationId: 'org-1',
    principalId: 'owner-1',
    request: 'Build and review the feature',
    signals: simpleSignals()
  });
  return { repository, service, session, createTask };
}

function expectPlanningCode(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error(`expected PlanningError(${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(PlanningError);
    expect((error as PlanningError).code).toBe(code);
  }
}

describe('deterministic planning gate', () => {
  it('keeps a small, clear, reversible single-team task outside the gate', () => {
    expect(evaluatePlanningGate(simpleSignals())).toEqual({
      requiresPlanning: false,
      complexityScore: 0,
      riskScore: 0,
      reasons: []
    });
  });

  it('deterministically covers every mandatory complexity and risk trigger', () => {
    const signals = simpleSignals({
      departmentIds: ['engineering', 'finance'],
      hasCrossTeamDependencies: true,
      ambiguousObjective: true,
      ambiguousScope: true,
      ambiguousAcceptance: true,
      estimatedDurationMinutes: 60,
      estimatedCost: 10,
      estimatedTokenCount: 100_000,
      requiresNewTeam: true,
      irreversibleOperations: ['production_change'],
      compareAlternatives: true,
      phasedExecution: true,
      confirmBeforeExecution: true
    });
    const expectedReasons = [
      'CROSS_TEAM',
      'AMBIGUOUS_OBJECTIVE',
      'AMBIGUOUS_SCOPE',
      'AMBIGUOUS_ACCEPTANCE',
      'LONG_TASK',
      'HIGH_COST',
      'HIGH_TOKEN_BUDGET',
      'NEW_TEAM',
      'IRREVERSIBLE_OPERATION',
      'COMPARE_ALTERNATIVES',
      'PHASED_EXECUTION',
      'EXPLICIT_CONFIRMATION'
    ];
    const first = evaluatePlanningGate(signals);
    const second = evaluatePlanningGate(structuredClone(signals));
    expect(first).toEqual(second);
    expect(first.requiresPlanning).toBe(true);
    expect(first.reasons).toEqual(expectedReasons);
  });

  it('rejects invalid numeric signals instead of trusting model-provided estimates', () => {
    expectPlanningCode(() => evaluatePlanningGate(simpleSignals({ estimatedCost: Number.NaN })), 'INVALID_NUMBER');
    expectPlanningCode(() => evaluatePlanningGate(simpleSignals({ estimatedTokenCount: Number.MAX_SAFE_INTEGER + 1 })), 'INVALID_NUMBER');
  });

  it('can trigger solely from the deterministic complexity score', () => {
    const result = evaluatePlanningGate(simpleSignals({ estimatedTaskCount: 10 }));
    expect(result).toMatchObject({ requiresPlanning: true, complexityScore: 5, reasons: ['COMPLEXITY_SCORE'] });
  });
});

describe('canonical JSON and plan hashing', () => {
  it('sorts object keys recursively while retaining array order', () => {
    expect(canonicalJson({ z: 1, a: { z: false, a: [2, 1, null] } })).toBe('{"a":{"a":[2,1,null],"z":false},"z":1}');
    expect(hashCanonicalJson({ b: 2, a: 1 })).toBe(hashCanonicalJson({ a: 1, b: 2 }));
    expect(hashCanonicalJson({ a: [1, 2] })).not.toBe(hashCanonicalJson({ a: [2, 1] }));
    expect(canonicalJson({ value: -0 })).toBe('{"value":0}');
  });

  it.each([
    [{ value: undefined }, 'INVALID_JSON_VALUE'],
    [{ value: Number.NaN }, 'INVALID_JSON_NUMBER'],
    [{ value: Number.POSITIVE_INFINITY }, 'INVALID_JSON_NUMBER'],
    [{ value: Number.MAX_SAFE_INTEGER + 1 }, 'INVALID_JSON_NUMBER'],
    [{ value: new Date(0) }, 'INVALID_JSON_VALUE'],
    [{ value: '\ud800' }, 'INVALID_JSON_STRING']
  ])('fails closed for values outside the canonical JSON domain', (value, code) => {
    expectPlanningCode(() => canonicalJson(value), code);
  });

  it('rejects non-data properties that JSON.stringify would silently omit or execute', () => {
    const symbolValue = { value: 1, [Symbol('hidden')]: 2 };
    const accessorValue = Object.defineProperty({ value: 1 }, 'computed', { enumerable: true, get: () => 2 });
    expectPlanningCode(() => canonicalJson(symbolValue), 'INVALID_JSON_VALUE');
    expectPlanningCode(() => canonicalJson(accessorValue), 'INVALID_JSON_VALUE');
  });
});

describe('question-set state and versioning', () => {
  it('supports single, multi, and text answers without dispatching work', () => {
    const { service, createTask } = createHarness();
    const set = service.issueQuestionSet('session-1', [
      question('q-single', 'single'),
      question('q-multi', 'multi'),
      question('q-text', 'text')
    ]);
    expect(set.version).toBe(1);
    expect(service.getSession('session-1')).toMatchObject({ status: 'NEEDS_INPUT', activeQuestionSetVersion: 1 });
    expectPlanningCode(() => service.answerQuestionSet('session-1', 0, 'owner-1', []), 'STALE_QUESTION_SET');

    const answered = service.answerQuestionSet('session-1', 1, 'owner-1', [
      { questionId: 'q-single', selectedOptionIds: ['q-single-safe'], text: null },
      { questionId: 'q-multi', selectedOptionIds: ['q-multi-fast', 'q-multi-safe'], text: 'Preserve a rollback path' },
      { questionId: 'q-text', selectedOptionIds: [], text: 'Friday before noon' }
    ]);
    expect(answered.answers).toHaveLength(3);
    expect(answered.answeredBy).toBe('owner-1');
    expect(service.getSession('session-1')).toMatchObject({ status: 'DRAFT', activeQuestionSetVersion: null });
    expect(createTask).not.toHaveBeenCalled();
  });

  it('enforces 1-3 questions, 2-4 choice options, recommendations, and principal ownership', () => {
    const { service } = createHarness();
    const tooManyOptions = question('q-options', 'single');
    tooManyOptions.options.push(
      { id: 'q-options-third', label: 'Third', impact: 'Third impact' },
      { id: 'q-options-fourth', label: 'Fourth', impact: 'Fourth impact' },
      { id: 'q-options-fifth', label: 'Fifth', impact: 'Fifth impact' }
    );
    expectPlanningCode(() => service.issueQuestionSet('session-1', [tooManyOptions]), 'INVALID_QUESTION_SET');

    const invalidRecommendation = question('q-recommend', 'single');
    invalidRecommendation.recommendedOptionId = 'missing';
    expectPlanningCode(() => service.issueQuestionSet('session-1', [invalidRecommendation]), 'INVALID_QUESTION_SET');

    service.issueQuestionSet('session-1', [question('q-owner', 'single')]);
    expectPlanningCode(() => service.answerQuestionSet('session-1', 1, 'intruder', [
      { questionId: 'q-owner', selectedOptionIds: ['q-owner-fast'], text: null }
    ]), 'PRINCIPAL_MISMATCH');
    expect(service.getSession('session-1').status).toBe('NEEDS_INPUT');
  });
});

describe('strict plan normalization and validation', () => {
  it('normalizes identifiers, dependency sets, permissions, and monetary precision', () => {
    const plan = validPlan();
    plan.organizationId = ' org-1 ';
    plan.dag[0].dependencies = [' node-build '];
    plan.dag[1].requiredPermissions = ['write', 'read'];
    plan.dag[0].budget.costLimit = 0.1;
    plan.dag[1].budget.costLimit = 0.2;
    plan.overallBudget.costLimit = 0.3;
    const normalized = normalizeAndValidatePlan(plan, policy());
    expect(normalized.organizationId).toBe('org-1');
    expect(normalized.dag.find((node) => node.nodeId === 'node-review')?.dependencies).toEqual(['node-build']);
    expect(normalized.dag.find((node) => node.nodeId === 'node-build')?.requiredPermissions).toEqual(['read', 'write']);
  });

  it.each([
    ['unknown agent', (plan: CompanyExecutionPlan, context: PlanValidationPolicy) => {
      plan.team[0].memberAgentIds = ['missing-agent'];
      return context;
    }, 'UNKNOWN_AGENT'],
    ['archived agent', (_plan: CompanyExecutionPlan, context: PlanValidationPolicy) => {
      (context.agents[0] as { archived: boolean }).archived = true;
      return context;
    }, 'AGENT_NOT_ELIGIBLE'],
    ['non-ready agent', (_plan: CompanyExecutionPlan, context: PlanValidationPolicy) => {
      (context.agents[0] as { lifecycle: string }).lifecycle = 'ERROR';
      return context;
    }, 'AGENT_NOT_ELIGIBLE'],
    ['organization boundary', (plan: CompanyExecutionPlan, context: PlanValidationPolicy) => {
      plan.dag[0].organizationId = 'org-2';
      return context;
    }, 'ORGANIZATION_BOUNDARY'],
    ['unauthorized profile', (plan: CompanyExecutionPlan, context: PlanValidationPolicy) => {
      plan.dag[0].permissionProfile = 'administrator';
      return context;
    }, 'PERMISSION_DENIED'],
    ['unauthorized permission', (plan: CompanyExecutionPlan, context: PlanValidationPolicy) => {
      plan.dag[0].requiredPermissions = ['delete'];
      return context;
    }, 'PERMISSION_DENIED'],
    ['ephemeral team boundary', (plan: CompanyExecutionPlan, context: PlanValidationPolicy) => {
      plan.team[0].proposedEphemeralRoles = ['Temporary researcher'];
      context.allowEphemeralTeams = false;
      return context;
    }, 'ORGANIZATION_BOUNDARY'],
    ['node total over plan budget', (plan: CompanyExecutionPlan, context: PlanValidationPolicy) => {
      plan.overallBudget.timeMinutes = 49;
      return context;
    }, 'BUDGET_EXCEEDED'],
    ['plan over policy budget', (plan: CompanyExecutionPlan, context: PlanValidationPolicy) => {
      context.maxBudget = { timeMinutes: 59, tokenLimit: 20_000, costLimit: 20 };
      return context;
    }, 'BUDGET_EXCEEDED']
  ])('fails closed for %s', (_name, mutate, expectedCode) => {
    const plan = validPlan();
    const context = structuredClone(policy());
    mutate(plan, context);
    expectPlanningCode(() => normalizeAndValidatePlan(plan, context), expectedCode);
  });

  it.each([
    ['missing dependency', (plan: CompanyExecutionPlan) => { plan.dag[0].dependencies = ['missing-node']; }],
    ['self dependency', (plan: CompanyExecutionPlan) => { plan.dag[0].dependencies = ['node-review']; }],
    ['cycle', (plan: CompanyExecutionPlan) => { plan.dag[1].dependencies = ['node-review']; }]
  ])('rejects a DAG with %s', (_name, mutate) => {
    const plan = validPlan();
    mutate(plan);
    expectPlanningCode(() => normalizeAndValidatePlan(plan, policy()), 'INVALID_DAG');
  });

  it('rejects unknown plan fields rather than silently dropping them', () => {
    const plan = validPlan() as CompanyExecutionPlan & { hiddenInstruction?: string };
    plan.hiddenInstruction = 'bypass approval';
    expectPlanningCode(() => normalizeAndValidatePlan(plan, policy()), 'INVALID_PLAN');
  });
});

describe('plan approval, supersede, and dispatch', () => {
  it('approves only an exact current version/hash and never dispatches during propose or approve', () => {
    const { service, createTask } = createHarness();
    const proposed = service.proposePlan('session-1', validPlan(), policy());
    expect(proposed).toMatchObject({ version: 1, status: 'PROPOSED' });
    expect(createTask).not.toHaveBeenCalled();
    expectPlanningCode(() => service.approvePlan('session-1', 1, '0'.repeat(64), 'owner-1'), 'PLAN_HASH_MISMATCH');
    expectPlanningCode(() => service.approvePlan('session-1', 2, proposed.hash, 'owner-1'), 'STALE_PLAN_VERSION');
    const approved = service.approvePlan('session-1', 1, proposed.hash, 'owner-1');
    expect(approved.status).toBe('APPROVED');
    expect(service.getSession('session-1')).toMatchObject({
      status: 'APPROVED',
      approvedPlanVersion: 1,
      approvedPlanHash: proposed.hash
    });
    expect(createTask).not.toHaveBeenCalled();
  });

  it('creates a new version for modifications and preserves the approved record', async () => {
    const { repository, service, createTask } = createHarness();
    const first = service.proposePlan('session-1', validPlan(), policy());
    service.approvePlan('session-1', first.version, first.hash, 'owner-1');
    const approvedSnapshot = repository.getPlanVersion('session-1', 1);
    const changed = validPlan();
    changed.objective = 'Deliver a reviewed implementation with migration notes';
    const second = service.proposePlan('session-1', changed, policy());

    expect(second.version).toBe(2);
    expect(second.hash).not.toBe(first.hash);
    expect(repository.getPlanVersion('session-1', 1)).toEqual(approvedSnapshot);
    expect(approvedSnapshot).toMatchObject({ status: 'APPROVED', approvedBy: 'owner-1' });
    expect(second.supersedesVersion).toBe(1);
    expect(service.getSession('session-1')).toMatchObject({
      status: 'PROPOSED',
      latestPlanVersion: 2,
      approvedPlanVersion: null,
      approvedPlanHash: null
    });
    await expect(service.dispatchApprovedPlan('session-1', policy())).rejects.toMatchObject({ code: 'PLAN_NOT_APPROVED' });
    expect(createTask).not.toHaveBeenCalled();
  });

  it('dispatches in dependency order with task references and is idempotent', async () => {
    const { service, createTask } = createHarness();
    const proposed = service.proposePlan('session-1', validPlan(), policy());
    service.approvePlan('session-1', proposed.version, proposed.hash, 'owner-1');
    const first = await service.dispatchApprovedPlan('session-1', policy());

    expect(first.map((receipt) => receipt.nodeId)).toEqual(['node-build', 'node-review']);
    expect(createTask.mock.calls.map(([order]) => order.nodeId)).toEqual(['node-build', 'node-review']);
    expect(createTask.mock.calls[0][0].dependencyTaskIds).toEqual([]);
    expect(createTask.mock.calls[1][0].dependencyTaskIds).toEqual(['task-node-build']);
    expect(createTask.mock.calls[0][0].idempotencyKey).toContain(proposed.hash);
    expect(service.getSession('session-1').status).toBe('DISPATCHED');

    const second = await service.dispatchApprovedPlan('session-1', policy());
    expect(second).toEqual(first);
    expect(createTask).toHaveBeenCalledTimes(2);

    const laterPolicy = structuredClone(policy());
    (laterPolicy.agents[0] as { lifecycle: string }).lifecycle = 'ERROR';
    await expect(service.dispatchApprovedPlan('session-1', laterPolicy)).resolves.toEqual(first);
    expect(createTask).toHaveBeenCalledTimes(2);
  });

  it('persists partial receipts and resumes without recreating completed nodes', async () => {
    let failReview = true;
    const { service, createTask } = createHarness((order) => {
      if (order.nodeId === 'node-review' && failReview) {
        failReview = false;
        throw new Error('temporary dispatch failure');
      }
      return { taskId: `task-${order.nodeId}` };
    });
    const proposed = service.proposePlan('session-1', validPlan(), policy());
    service.approvePlan('session-1', proposed.version, proposed.hash, 'owner-1');

    await expect(service.dispatchApprovedPlan('session-1', policy())).rejects.toThrow('temporary dispatch failure');
    expect(service.getSession('session-1').status).toBe('APPROVED');
    const receipts = await service.dispatchApprovedPlan('session-1', policy());
    expect(receipts).toHaveLength(2);
    expect(createTask.mock.calls.filter(([order]) => order.nodeId === 'node-build')).toHaveLength(1);
    expect(createTask.mock.calls.filter(([order]) => order.nodeId === 'node-review')).toHaveLength(2);
  });

  it('revalidates current employee eligibility immediately before dispatch', async () => {
    const { service, createTask } = createHarness();
    const proposed = service.proposePlan('session-1', validPlan(), policy());
    service.approvePlan('session-1', proposed.version, proposed.hash, 'owner-1');
    const changedPolicy = structuredClone(policy());
    (changedPolicy.agents[0] as { lifecycle: string }).lifecycle = 'STOPPING';
    await expect(service.dispatchApprovedPlan('session-1', changedPolicy)).rejects.toMatchObject({ code: 'AGENT_NOT_ELIGIBLE' });
    expect(service.getSession('session-1').status).toBe('APPROVED');
    expect(createTask).not.toHaveBeenCalled();
  });

  it('atomically blocks plan modification once external dispatch has started', async () => {
    let releaseBuild!: () => void;
    const buildMayFinish = new Promise<void>((resolve) => { releaseBuild = resolve; });
    const { service, createTask } = createHarness(async (order) => {
      if (order.nodeId === 'node-build') await buildMayFinish;
      return { taskId: `task-${order.nodeId}` };
    });
    const proposed = service.proposePlan('session-1', validPlan(), policy());
    service.approvePlan('session-1', proposed.version, proposed.hash, 'owner-1');

    const dispatching = service.dispatchApprovedPlan('session-1', policy());
    expect(createTask).toHaveBeenCalledTimes(1);
    const changed = validPlan();
    changed.objective = 'A concurrent replacement';
    expectPlanningCode(() => service.proposePlan('session-1', changed, policy()), 'DISPATCH_IN_PROGRESS');

    releaseBuild();
    await expect(dispatching).resolves.toHaveLength(2);
    expect(service.getSession('session-1').status).toBe('DISPATCHED');
  });
});
