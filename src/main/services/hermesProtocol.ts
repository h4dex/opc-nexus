import type {
  HermesClarifyRequest,
  HermesDelegationRequest,
  HermesPlanDraft,
  HermesRuntimeStatus
} from '../../shared/types.js';

export const HERMES_RUNTIME_VERSION = '0.19.0' as const;
export const HERMES_PROTOCOL_VERSION = 1 as const;

export interface HermesHealthResponse {
  ok: true;
  version: string;
  protocolVersion: number;
  service: 'hermes';
}

export type HermesControlMessage =
  | { type: 'plan.draft'; draft: HermesPlanDraft }
  | { type: 'clarify.request'; request: HermesClarifyRequest }
  | { type: 'delegate.request'; request: HermesDelegationRequest };

/**
 * Hermes emits both direct event frames and JSON-RPC gateway frames. Keep the
 * adapter deliberately small: unknown upstream events are ignored instead of
 * being guessed into a Nexus state transition.
 */
export function parseHermesControlMessage(value: unknown): HermesControlMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  const candidate = root.method === 'event' && root.params && typeof root.params === 'object'
    ? root.params as Record<string, unknown>
    : root;
  const type = candidate.type;
  const payload = candidate.payload && typeof candidate.payload === 'object'
    ? candidate.payload as Record<string, unknown>
    : candidate;
  if (type === 'clarify.request') {
    const request = payload.request && typeof payload.request === 'object'
      ? payload.request as Record<string, unknown>
      : payload;
    return { type, request: request as unknown as HermesClarifyRequest };
  }
  if (type === 'plan.draft') {
    const draft = payload.draft && typeof payload.draft === 'object'
      ? payload.draft as Record<string, unknown>
      : payload;
    return { type, draft: draft as unknown as HermesPlanDraft };
  }
  if (type === 'delegate.request') {
    const request = payload.request && typeof payload.request === 'object'
      ? payload.request as Record<string, unknown>
      : payload;
    return { type, request: request as unknown as HermesDelegationRequest };
  }
  return null;
}

export function parseHermesHealth(value: unknown): HermesHealthResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.ok !== true || record.service !== 'hermes') return null;
  if (typeof record.version !== 'string' || !/^0\.19(?:\.\d+)?$/.test(record.version)) return null;
  if (record.protocolVersion !== HERMES_PROTOCOL_VERSION) return null;
  return {
    ok: true,
    version: record.version,
    protocolVersion: HERMES_PROTOCOL_VERSION,
    service: 'hermes'
  };
}

export function runtimeStatusError(
  projectId: string,
  homePath: string,
  error: unknown,
  previous: Partial<HermesRuntimeStatus> = {}
): HermesRuntimeStatus {
  return {
    projectId,
    state: 'error',
    startupPhase: 'error',
    startupElapsedMs: previous.startedAt === null || previous.startedAt === undefined
      ? null
      : Math.max(0, Date.now() - previous.startedAt),
    version: previous.version ?? null,
    host: '127.0.0.1',
    port: previous.port ?? null,
    proxyPort: previous.proxyPort ?? null,
    homePath,
    serviceUrl: previous.serviceUrl ?? null,
    uiUrl: previous.uiUrl ?? null,
    pid: previous.pid ?? null,
    lastHealthAt: previous.lastHealthAt ?? null,
    lastError: error instanceof Error ? error.message : String(error),
    startedAt: previous.startedAt ?? null
  };
}

export function assertProjectScope(expectedProjectId: string, value: unknown): void {
  if (typeof value !== 'string' || value !== expectedProjectId) {
    throw new Error('Hermes request project scope does not match the active project');
  }
}

export function assertHermesPlanDraft(value: unknown): HermesPlanDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Hermes plan draft must be an object');
  const draft = value as Partial<HermesPlanDraft>;
  const text = (input: unknown, field: string, max = 8_000): string => {
    if (typeof input !== 'string' || input.trim().length === 0 || input.length > max) throw new Error(`Hermes plan ${field} is invalid`);
    return input.trim();
  };
  if (draft.source !== 'hermes') throw new Error('Hermes plan source is invalid');
  const projectId = text(draft.projectId, 'projectId', 128);
  const conversationId = text(draft.conversationId, 'conversationId', 256);
  const model = text(draft.model, 'model', 256);
  if (!Array.isArray(draft.assumptions) || !Array.isArray(draft.acceptanceCriteria)
    || !Array.isArray(draft.expectedArtifacts) || !Array.isArray(draft.team)
    || !Array.isArray(draft.dag) || !Array.isArray(draft.risks) || !Array.isArray(draft.memoryRefs)) {
    throw new Error('Hermes plan arrays are invalid');
  }
  if (!draft.scope || typeof draft.scope !== 'object' || Array.isArray(draft.scope)) throw new Error('Hermes plan scope is invalid');
  if (!draft.budget || typeof draft.budget !== 'object' || Array.isArray(draft.budget)) throw new Error('Hermes plan budget is invalid');
  const budget = draft.budget as HermesPlanDraft['budget'];
  if (![budget.maxCost, budget.maxTokens, budget.maxConcurrent].every((number) => typeof number === 'number' && Number.isSafeInteger(number) && number >= 0)) {
    throw new Error('Hermes plan budget is invalid');
  }
  if (budget.maxConcurrent < 1 || budget.maxConcurrent > 32) throw new Error('Hermes plan concurrency is outside policy');
  if (draft.dag.length === 0 || draft.dag.length > 128) throw new Error('Hermes plan DAG must contain 1-128 nodes');
  return structuredClone(draft) as HermesPlanDraft;
}

export function assertHermesDelegationRequest(value: unknown): HermesDelegationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Hermes delegation request must be an object');
  const request = value as Partial<HermesDelegationRequest>;
  const text = (input: unknown, field: string, max = 256): string => {
    if (typeof input !== 'string' || input.trim().length === 0 || input.length > max) throw new Error(`Hermes delegation ${field} is invalid`);
    return input.trim();
  };
  const integer = (input: unknown, field: string, min: number, max: number): number => {
    if (!Number.isSafeInteger(input) || Number(input) < min || Number(input) > max) throw new Error(`Hermes delegation ${field} is outside policy`);
    return Number(input);
  };
  const parentSessionId = text(request.parentSessionId, 'parentSessionId');
  const parentRunId = text(request.parentRunId, 'parentRunId');
  const projectId = text(request.projectId, 'projectId', 128);
  const workerAgentId = text(request.workerAgentId, 'workerAgentId', 128);
  if (!Array.isArray(request.tasks) || request.tasks.length < 1 || request.tasks.length > 128) throw new Error('Hermes delegation tasks are invalid');
  const tasks = request.tasks.map((task, index) => {
    if (!task || typeof task !== 'object') throw new Error(`Hermes delegation task ${index} is invalid`);
    const item = task as Record<string, unknown>;
    if (!Array.isArray(item.dependsOn) || item.dependsOn.some((id) => typeof id !== 'string')) throw new Error(`Hermes delegation task ${index} dependencies are invalid`);
    return {
      id: text(item.id, `tasks[${index}].id`, 128),
      title: text(item.title, `tasks[${index}].title`, 500),
      description: text(item.description, `tasks[${index}].description`, 8_000),
      dependsOn: item.dependsOn.map((id) => text(id, `tasks[${index}].dependsOn`, 128))
    };
  });
  const permissions = request.permissions;
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) throw new Error('Hermes delegation permissions are invalid');
  const permissionKeys = ['network', 'shell', 'install', 'browser', 'computer', 'mobile'] as const;
  if (permissionKeys.some((key) => typeof permissions[key] !== 'boolean')) throw new Error('Hermes delegation permissions are invalid');
  const budget = request.budget;
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) throw new Error('Hermes delegation budget is invalid');
  const safeBudget = {
    maxCost: integer(budget.maxCost, 'budget.maxCost', 0, Number.MAX_SAFE_INTEGER),
    maxTokens: integer(budget.maxTokens, 'budget.maxTokens', 0, 100_000_000)
  };
  return {
    parentSessionId, parentRunId, projectId, tasks, workerAgentId,
    dependencies: Array.isArray(request.dependencies) ? request.dependencies.map((id) => text(id, 'dependencies', 128)) : [],
    permissions: Object.fromEntries(permissionKeys.map((key) => [key, permissions[key]])) as HermesDelegationRequest['permissions'],
    budget: safeBudget,
    maxDepth: integer(request.maxDepth, 'maxDepth', 0, 8),
    maxConcurrentChildren: integer(request.maxConcurrentChildren, 'maxConcurrentChildren', 1, 32)
  };
}
