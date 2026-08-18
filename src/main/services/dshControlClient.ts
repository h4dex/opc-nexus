import WebSocket, { type RawData } from 'ws';

const DEFAULT_RPC_TIMEOUT_MS = 15_000;
const DEFAULT_STREAM_OPEN_TIMEOUT_MS = 10_000;
const MAX_RPC_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_STREAM_FRAME_BYTES = 4 * 1024 * 1024;

export interface DshRpcErrorPayload {
  code: string;
  message: string;
  details: unknown;
}

export interface DshSessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  parentSessionId?: string;
  origin?: 'subagent';
  cwd?: string;
  agentPreset?: string;
}

export interface DshWorkspaceSummary {
  workspaceId: string;
  path: string;
  title: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DshWorkspaceList {
  items: DshWorkspaceSummary[];
  archivedSessionIds: string[];
}

export interface DshSessionEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
  sourceEventSeqs?: number[];
  surfaceOp?: unknown;
  ignorable?: true;
}

export interface DshHistoryEntry {
  event: DshSessionEvent;
  view?: unknown;
}

export interface DshSessionHistory {
  events: DshHistoryEntry[];
  hasMore: boolean;
  projections?: {
    asOfSeq: number;
    values: Record<string, unknown>;
  };
}

export interface DshModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface DshModelReasoningEffort {
  id: string;
  name: string;
  description?: string;
}

export interface DshModelCatalogModel {
  id: string;
  name: string;
  description?: string;
  reasoning?: {
    efforts: DshModelReasoningEffort[];
    defaultEffort?: string;
  };
}

export interface DshModelProviderGroup {
  id: string;
  name: string;
  models: DshModelCatalogModel[];
}

export interface DshModelCatalogFailure {
  id: string;
  name: string;
  message: string;
}

export interface DshSessionModels {
  current: DshModelSelection;
  routable: boolean;
  groups: DshModelProviderGroup[];
  failures: DshModelCatalogFailure[];
}

export interface DshMuxEnvelope {
  rpcId: string;
  payload: Record<string, unknown>;
  /** rc.6 currently omits this field on mux frames; retain it when a future
   * compatible host includes the logical method. */
  method?: string;
}

/** The presentation intent currently defined by DSH rc.6. */
export interface DshQuestionIntent {
  kind: 'plan-review';
  approve: string;
}

export interface DshQuestionOption {
  label: string;
  description?: string;
}

export interface DshQuestionItem {
  id: string;
  question: string;
  header?: string;
  detail?: string;
  options?: DshQuestionOption[];
  multiSelect?: boolean;
  intent?: DshQuestionIntent;
}

export interface DshQuestionRequestedFrame {
  type: 'question/requested';
  sessionId: string;
  questions: DshQuestionItem[];
}

export interface DshQuestionResolvedFrame {
  type: 'question/resolved';
  sessionId: string;
  questionRpcId: string;
  outcome: 'answered' | 'cancelled';
}

export type DshTypedMuxFrame = DshQuestionRequestedFrame | DshQuestionResolvedFrame;

export interface DshQuestionAnswerItem {
  id: string;
  selected: string[];
  custom?: string;
}

export interface DshQuestionAnswer {
  answers: DshQuestionAnswerItem[];
}

export interface DshRespondAccepted {
  accepted: true;
}

export interface DshRespondRejected {
  accepted: false;
  reason: 'not-pending' | 'bad-response';
}

export type DshRespondReceipt = DshRespondAccepted | DshRespondRejected;

export interface DshClientResponse {
  type: 'client-response';
  rpcId: string;
  result:
    | { ok: true; value: { sessionId: string; answer: DshQuestionAnswer } }
    | { ok: false; error: { code: 'cancelled'; message: string; details: unknown } };
}

export interface DshControlPort {
  listWorkspaces(signal?: AbortSignal): Promise<DshWorkspaceList>;
  createWorkspace(
    input: { path: string },
    rpcId: string,
    signal?: AbortSignal
  ): Promise<{ workspace: DshWorkspaceSummary; created: boolean }>;
  listSessions(signal?: AbortSignal): Promise<DshSessionSummary[]>;
  createSession(input: {
    workspaceId?: string;
    cwd?: string;
    sessionId?: string;
    agentPreset?: string;
  }, rpcId: string, signal?: AbortSignal): Promise<{ sessionId: string; agentPreset?: string }>;
  readHistory(input: {
    sessionId: string;
    beforeSeq?: number;
    maxMessages?: number;
  }, signal?: AbortSignal): Promise<DshSessionHistory>;
  models(input: { sessionId: string }, signal?: AbortSignal): Promise<DshSessionModels>;
  selectModel(input: {
    sessionId: string;
    provider: string;
    model: string;
    reasoningEffort?: string;
  }, rpcId: string, signal?: AbortSignal): Promise<{ selected: DshModelSelection }>;
  prompt(input: {
    sessionId: string;
    mode: 'queue' | 'steer';
    content: Array<{ type: 'text'; text: string }>;
    clientTimeZone?: string;
  }, rpcId: string, signal?: AbortSignal): Promise<{ accepted: true; command?: { kind: 'success'; text?: string } }>;
  cancel(sessionId: string, rpcId: string, signal?: AbortSignal): Promise<{ accepted: true }>;
  /** Answer an rc.6 server-request through POST /api/respond. */
  respond(response: DshClientResponse, signal?: AbortSignal): Promise<DshRespondReceipt>;
  respondQuestion(
    input: { rpcId: string; sessionId: string; answer: DshQuestionAnswer },
    signal?: AbortSignal
  ): Promise<DshRespondReceipt>;
  cancelQuestion(
    input: { rpcId: string; message?: string },
    signal?: AbortSignal
  ): Promise<DshRespondReceipt>;
  observeMux(
    onEnvelope: (envelope: DshMuxEnvelope) => void | Promise<void>,
    signal: AbortSignal,
    onOpen?: () => void
  ): Promise<void>;
  observeTypedMux(
    onFrame: (frame: DshTypedMuxFrame, envelope: DshMuxEnvelope) => void | Promise<void>,
    signal: AbortSignal,
    onOpen?: () => void
  ): Promise<void>;
}

export class DshRpcError extends Error {
  constructor(
    readonly method: string,
    readonly rpcId: string,
    readonly rpcError: DshRpcErrorPayload
  ) {
    super(`DSH ${method} failed (${rpcError.code}): ${rpcError.message}`);
    this.name = 'DshRpcError';
  }
}

/**
 * A POST can reach DSH even when its response is lost. Callers must reconcile
 * mutating requests through durable history before deciding whether to retry.
 */
export class DshAmbiguousTransportError extends Error {
  readonly requestMayHaveBeenApplied = true;

  constructor(readonly method: string, readonly rpcId: string, cause: unknown) {
    super(`DSH ${method} response was not confirmed`, { cause });
    this.name = 'DshAmbiguousTransportError';
  }
}

interface DshFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type DshControlFetch = (
  input: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    redirect: 'manual';
    signal: AbortSignal;
  }
) => Promise<DshFetchResponse>;

interface DshSocket {
  readonly readyState: number;
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: RawData) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export type DshSocketFactory = (url: string, origin: string) => DshSocket;

export interface DshControlClientOptions {
  fetch?: DshControlFetch;
  createSocket?: DshSocketFactory;
  rpcTimeoutMs?: number;
  streamOpenTimeoutMs?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid DSH ${label}`);
  return value;
}

function requiredInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`Invalid DSH ${label}`);
  return value as number;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid DSH ${label}`);
  return value;
}

function boundedDshString(value: unknown, label: string, maximum: number): string {
  const result = requiredString(value, label);
  // Markdown details legitimately contain LF/CR/TAB; reject only the other
  // C0 controls and DEL.
  if (result.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)) {
    throw new Error(`Invalid DSH ${label}`);
  }
  return result;
}

function optionalDshString(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return boundedDshString(value, label, maximum);
}

function parseQuestionOption(value: unknown, index: number): DshQuestionOption {
  if (!isObject(value)) throw new Error(`Invalid DSH question option ${index}`);
  const option: DshQuestionOption = {
    label: boundedDshString(value.label, `question option ${index} label`, 4_000)
  };
  const description = optionalDshString(value.description, `question option ${index} description`, 20_000);
  if (description !== undefined) option.description = description;
  return option;
}

function parseQuestionIntent(value: unknown): DshQuestionIntent {
  if (!isObject(value) || value.kind !== 'plan-review') throw new Error('Invalid DSH question intent');
  return { kind: 'plan-review', approve: boundedDshString(value.approve, 'question intent approve', 4_000) };
}

function parseQuestionItem(value: unknown, index: number): DshQuestionItem {
  if (!isObject(value)) throw new Error(`Invalid DSH question ${index}`);
  const item: DshQuestionItem = {
    id: boundedDshString(value.id, `question ${index} id`, 256),
    question: boundedDshString(value.question, `question ${index} text`, 20_000)
  };
  const header = optionalDshString(value.header, `question ${index} header`, 512);
  const detail = optionalDshString(value.detail, `question ${index} detail`, 200_000);
  if (header !== undefined) item.header = header;
  if (detail !== undefined) item.detail = detail;
  if (value.options !== undefined) {
    if (!Array.isArray(value.options) || value.options.length > 32) throw new Error(`Invalid DSH question ${index} options`);
    item.options = value.options.map((option, optionIndex) => parseQuestionOption(option, optionIndex));
  }
  if (value.multiSelect !== undefined) item.multiSelect = requiredBoolean(value.multiSelect, `question ${index} multiSelect`);
  if (value.intent !== undefined) item.intent = parseQuestionIntent(value.intent);
  return item;
}

/**
 * Parse only the typed question frames documented by DSH rc.6. Unknown mux
 * frame types remain the executor's concern and return null; malformed known
 * question frames fail closed instead of being guessed from chat prose.
 */
export function parseDshTypedMuxFrame(payload: Record<string, unknown>): DshTypedMuxFrame | null {
  const type = payload.type;
  if (type === 'question/requested') {
    if (!Array.isArray(payload.questions) || payload.questions.length < 1 || payload.questions.length > 32) {
      throw new Error('Invalid DSH question/requested questions');
    }
    return {
      type,
      sessionId: boundedDshString(payload.sessionId, 'question sessionId', 256),
      questions: payload.questions.map((item, index) => parseQuestionItem(item, index))
    };
  }
  if (type === 'question/resolved') {
    const outcome = payload.outcome;
    if (outcome !== 'answered' && outcome !== 'cancelled') throw new Error('Invalid DSH question/resolved outcome');
    return {
      type,
      sessionId: boundedDshString(payload.sessionId, 'resolved question sessionId', 256),
      questionRpcId: boundedDshString(payload.questionRpcId, 'questionRpcId', 256),
      outcome
    };
  }
  return null;
}

function parseQuestionAnswer(value: unknown): DshQuestionAnswer {
  if (!isObject(value) || !Array.isArray(value.answers) || value.answers.length > 64) {
    throw new Error('Invalid DSH question answer');
  }
  const seen = new Set<string>();
  const answers = value.answers.map((candidate, index): DshQuestionAnswerItem => {
    if (!isObject(candidate) || seen.has(String(candidate.id))) throw new Error(`Invalid DSH answer ${index}`);
    const id = boundedDshString(candidate.id, `answer ${index} id`, 256);
    if (seen.has(id)) throw new Error(`Duplicate DSH answer ${id}`);
    seen.add(id);
    if (!Array.isArray(candidate.selected) || candidate.selected.length > 64) throw new Error(`Invalid DSH answer ${index} selected`);
    const selected = candidate.selected.map((item, selectedIndex) => boundedDshString(item, `answer ${index} selected ${selectedIndex}`, 4_000));
    const output: DshQuestionAnswerItem = { id, selected };
    const custom = optionalDshString(candidate.custom, `answer ${index} custom`, 20_000);
    if (custom !== undefined) output.custom = custom;
    return output;
  });
  return { answers };
}

function validateClientResponse(response: DshClientResponse): DshClientResponse {
  if (!isObject(response) || response.type !== 'client-response') throw new Error('Invalid DSH client response');
  const rpcId = boundedDshString(response.rpcId, 'response rpcId', 256);
  if (!isObject(response.result) || typeof response.result.ok !== 'boolean') throw new Error('Invalid DSH response result');
  if (response.result.ok) {
    const value = response.result.value;
    if (!isObject(value)) throw new Error('Invalid DSH question response value');
    const sessionId = boundedDshString(value.sessionId, 'response sessionId', 256);
    const answer = parseQuestionAnswer(value.answer);
    return { type: 'client-response', rpcId, result: { ok: true, value: { sessionId, answer } } };
  }
  const error = response.result.error;
  if (!isObject(error) || typeof error.code !== 'string' || error.code !== 'cancelled') {
    throw new Error('Invalid DSH cancellation response');
  }
  const message = boundedDshString(error.message, 'cancellation message', 2_000);
  return {
    type: 'client-response',
    rpcId,
    result: { ok: false, error: { code: 'cancelled', message, details: error.details } }
  };
}

function normalizeEndpoint(endpoint: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('DSH endpoint is invalid');
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password) {
    throw new Error('DSH control endpoint must use loopback HTTP');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('DSH control endpoint must be an origin');
  return parsed;
}

function boundedPositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > 5 * 60_000) {
    throw new Error(`${label} is invalid`);
  }
  return resolved;
}

function parseSessionSummary(value: unknown): DshSessionSummary {
  if (!isObject(value)) throw new Error('Invalid DSH session summary');
  const summary: DshSessionSummary = {
    sessionId: requiredString(value.sessionId, 'sessionId'),
    updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
      ? value.updatedAt
      : (() => { throw new Error('Invalid DSH session updatedAt'); })(),
    running: requiredBoolean(value.running, 'session running'),
    blank: requiredBoolean(value.blank, 'session blank')
  };
  if (value.parentSessionId !== undefined) summary.parentSessionId = requiredString(value.parentSessionId, 'parentSessionId');
  if (value.origin !== undefined) {
    if (value.origin !== 'subagent') throw new Error('Invalid DSH session origin');
    summary.origin = value.origin;
  }
  if (value.cwd !== undefined) summary.cwd = requiredString(value.cwd, 'session cwd');
  if (value.agentPreset !== undefined) summary.agentPreset = requiredString(value.agentPreset, 'agentPreset');
  return summary;
}

function parseWorkspaceSummary(value: unknown): DshWorkspaceSummary {
  if (!isObject(value) || !Array.isArray(value.sessionIds)) {
    throw new Error('Invalid DSH workspace summary');
  }
  return {
    workspaceId: boundedDshString(value.workspaceId, 'workspaceId', 256),
    path: boundedDshString(value.path, 'workspace path', 4_096),
    title: boundedDshString(value.title, 'workspace title', 1_000),
    sessionIds: value.sessionIds.map((sessionId, index) => (
      boundedDshString(sessionId, `workspace session ${index}`, 256)
    )),
    createdAt: boundedDshString(value.createdAt, 'workspace createdAt', 128),
    updatedAt: boundedDshString(value.updatedAt, 'workspace updatedAt', 128)
  };
}

function parseSessionEvent(value: unknown): DshSessionEvent {
  if (!isObject(value)) throw new Error('Invalid DSH session event');
  const event: DshSessionEvent = {
    type: requiredString(value.type, 'event type'),
    seq: requiredInteger(value.seq, 'event seq'),
    time: typeof value.time === 'number' && Number.isFinite(value.time)
      ? value.time
      : (() => { throw new Error('Invalid DSH event time'); })(),
    data: value.data
  };
  if (value.sourceEventSeqs !== undefined) {
    if (!Array.isArray(value.sourceEventSeqs)) throw new Error('Invalid DSH sourceEventSeqs');
    event.sourceEventSeqs = value.sourceEventSeqs.map((seq) => requiredInteger(seq, 'source event seq'));
  }
  if (value.surfaceOp !== undefined) event.surfaceOp = value.surfaceOp;
  if (value.ignorable !== undefined) {
    if (value.ignorable !== true) throw new Error('Invalid DSH ignorable marker');
    event.ignorable = true;
  }
  return event;
}

function parseHistory(value: unknown): DshSessionHistory {
  if (!isObject(value) || !Array.isArray(value.events)) throw new Error('Invalid DSH session.history result');
  const history: DshSessionHistory = {
    events: value.events.map((entry) => {
      if (!isObject(entry)) throw new Error('Invalid DSH history entry');
      return { event: parseSessionEvent(entry.event), ...(entry.view === undefined ? {} : { view: entry.view }) };
    }),
    hasMore: requiredBoolean(value.hasMore, 'history hasMore')
  };
  if (value.projections !== undefined) {
    if (!isObject(value.projections) || !isObject(value.projections.values)) throw new Error('Invalid DSH projections');
    history.projections = {
      asOfSeq: requiredInteger(value.projections.asOfSeq, 'projection seq', -1),
      values: value.projections.values
    };
  }
  return history;
}

function parseModelSelection(value: unknown, label: string): DshModelSelection {
  if (!isObject(value)) throw new Error(`Invalid DSH ${label}`);
  const selection: DshModelSelection = {
    provider: boundedDshString(value.provider, `${label} provider`, 512),
    model: boundedDshString(value.model, `${label} model`, 512)
  };
  const reasoningEffort = optionalDshString(value.reasoningEffort, `${label} reasoning effort`, 512);
  if (reasoningEffort !== undefined) selection.reasoningEffort = reasoningEffort;
  return selection;
}

function parseSessionModels(value: unknown): DshSessionModels {
  if (!isObject(value) || !Array.isArray(value.groups) || !Array.isArray(value.failures)) {
    throw new Error('Invalid DSH session.models result');
  }
  return {
    current: parseModelSelection(value.current, 'current model selection'),
    routable: requiredBoolean(value.routable, 'model route'),
    groups: value.groups.map((candidate, groupIndex): DshModelProviderGroup => {
      if (!isObject(candidate) || !Array.isArray(candidate.models)) {
        throw new Error(`Invalid DSH model group ${groupIndex}`);
      }
      return {
        id: boundedDshString(candidate.id, `model group ${groupIndex} id`, 512),
        name: boundedDshString(candidate.name, `model group ${groupIndex} name`, 4_000),
        models: candidate.models.map((model, modelIndex): DshModelCatalogModel => {
          if (!isObject(model)) throw new Error(`Invalid DSH model ${groupIndex}:${modelIndex}`);
          const parsed: DshModelCatalogModel = {
            id: boundedDshString(model.id, `model ${groupIndex}:${modelIndex} id`, 512),
            name: boundedDshString(model.name, `model ${groupIndex}:${modelIndex} name`, 4_000)
          };
          const description = optionalDshString(model.description, `model ${groupIndex}:${modelIndex} description`, 20_000);
          if (description !== undefined) parsed.description = description;
          if (model.reasoning !== undefined) {
            if (!isObject(model.reasoning) || !Array.isArray(model.reasoning.efforts)) {
              throw new Error(`Invalid DSH model ${groupIndex}:${modelIndex} reasoning`);
            }
            const reasoning: NonNullable<DshModelCatalogModel['reasoning']> = {
              efforts: model.reasoning.efforts.map((effort, effortIndex): DshModelReasoningEffort => {
                if (!isObject(effort)) throw new Error(`Invalid DSH reasoning effort ${groupIndex}:${modelIndex}:${effortIndex}`);
                const parsedEffort: DshModelReasoningEffort = {
                  id: boundedDshString(effort.id, `reasoning effort ${groupIndex}:${modelIndex}:${effortIndex} id`, 512),
                  name: boundedDshString(effort.name, `reasoning effort ${groupIndex}:${modelIndex}:${effortIndex} name`, 4_000)
                };
                const effortDescription = optionalDshString(
                  effort.description,
                  `reasoning effort ${groupIndex}:${modelIndex}:${effortIndex} description`,
                  20_000
                );
                if (effortDescription !== undefined) parsedEffort.description = effortDescription;
                return parsedEffort;
              })
            };
            const defaultEffort = optionalDshString(
              model.reasoning.defaultEffort,
              `model ${groupIndex}:${modelIndex} default reasoning effort`,
              512
            );
            if (defaultEffort !== undefined) reasoning.defaultEffort = defaultEffort;
            parsed.reasoning = reasoning;
          }
          return parsed;
        })
      };
    }),
    failures: value.failures.map((candidate, index): DshModelCatalogFailure => {
      if (!isObject(candidate)) throw new Error(`Invalid DSH model failure ${index}`);
      return {
        id: boundedDshString(candidate.id, `model failure ${index} id`, 512),
        name: boundedDshString(candidate.name, `model failure ${index} name`, 4_000),
        message: boundedDshString(candidate.message, `model failure ${index} message`, 20_000)
      };
    })
  };
}

function defaultSocketFactory(url: string, origin: string): DshSocket {
  return new WebSocket(url, {
    origin,
    handshakeTimeout: DEFAULT_STREAM_OPEN_TIMEOUT_MS,
    maxPayload: MAX_STREAM_FRAME_BYTES,
    perMessageDeflate: false
  });
}

export class DshControlClient implements DshControlPort {
  private readonly endpoint: URL;
  private readonly fetchImpl: DshControlFetch;
  private readonly createSocket: DshSocketFactory;
  private readonly rpcTimeoutMs: number;
  private readonly streamOpenTimeoutMs: number;

  constructor(endpoint: string, options: DshControlClientOptions = {}) {
    this.endpoint = normalizeEndpoint(endpoint);
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as DshControlFetch);
    this.createSocket = options.createSocket ?? defaultSocketFactory;
    this.rpcTimeoutMs = boundedPositiveInteger(options.rpcTimeoutMs, DEFAULT_RPC_TIMEOUT_MS, 'rpcTimeoutMs');
    this.streamOpenTimeoutMs = boundedPositiveInteger(
      options.streamOpenTimeoutMs,
      DEFAULT_STREAM_OPEN_TIMEOUT_MS,
      'streamOpenTimeoutMs'
    );
  }

  async listWorkspaces(signal?: AbortSignal): Promise<DshWorkspaceList> {
    const value = await this.call('workspace.list', {}, crypto.randomUUID(), signal, false);
    if (!isObject(value) || !Array.isArray(value.items) || !Array.isArray(value.archivedSessionIds)) {
      throw new Error('Invalid DSH workspace.list result');
    }
    return {
      items: value.items.map(parseWorkspaceSummary),
      archivedSessionIds: value.archivedSessionIds.map((sessionId, index) => (
        boundedDshString(sessionId, `archived workspace session ${index}`, 256)
      ))
    };
  }

  async createWorkspace(
    input: { path: string },
    rpcId: string,
    signal?: AbortSignal
  ): Promise<{ workspace: DshWorkspaceSummary; created: boolean }> {
    const value = await this.call('workspace.create', input, rpcId, signal, true);
    try {
      if (!isObject(value)) throw new Error('Invalid DSH workspace.create result');
      return {
        workspace: parseWorkspaceSummary(value.workspace),
        created: requiredBoolean(value.created, 'workspace created')
      };
    } catch (error) {
      throw new DshAmbiguousTransportError('workspace.create', rpcId, error);
    }
  }

  async listSessions(signal?: AbortSignal): Promise<DshSessionSummary[]> {
    const value = await this.call('session.list', {}, crypto.randomUUID(), signal, false);
    if (!isObject(value) || !Array.isArray(value.items)) throw new Error('Invalid DSH session.list result');
    return value.items.map(parseSessionSummary);
  }

  async createSession(
    input: { workspaceId?: string; cwd?: string; sessionId?: string; agentPreset?: string },
    rpcId: string,
    signal?: AbortSignal
  ): Promise<{ sessionId: string; agentPreset?: string }> {
    const value = await this.call('session.create', input, rpcId, signal, true);
    try {
      if (!isObject(value)) throw new Error('Invalid DSH session.create result');
      const result: { sessionId: string; agentPreset?: string } = {
        sessionId: requiredString(value.sessionId, 'created sessionId')
      };
      if (value.agentPreset !== undefined) {
        result.agentPreset = requiredString(value.agentPreset, 'created agentPreset');
      }
      if (input.sessionId !== undefined && result.sessionId !== input.sessionId) {
        throw new Error('DSH session.create returned an unexpected sessionId');
      }
      if (input.agentPreset !== undefined && result.agentPreset !== input.agentPreset) {
        throw new Error('DSH session.create did not confirm the requested agentPreset');
      }
      return result;
    } catch (error) {
      throw new DshAmbiguousTransportError('session.create', rpcId, error);
    }
  }

  async readHistory(
    input: { sessionId: string; beforeSeq?: number; maxMessages?: number },
    signal?: AbortSignal
  ): Promise<DshSessionHistory> {
    return parseHistory(await this.call('session.history', input, crypto.randomUUID(), signal, false));
  }

  async models(input: { sessionId: string }, signal?: AbortSignal): Promise<DshSessionModels> {
    const payload = { sessionId: boundedDshString(input?.sessionId, 'models sessionId', 256) };
    return parseSessionModels(await this.call('session.models', payload, crypto.randomUUID(), signal, false));
  }

  async selectModel(
    input: { sessionId: string; provider: string; model: string; reasoningEffort?: string },
    rpcId: string,
    signal?: AbortSignal
  ): Promise<{ selected: DshModelSelection }> {
    const payload = {
      sessionId: boundedDshString(input?.sessionId, 'model selection sessionId', 256),
      provider: boundedDshString(input?.provider, 'model selection provider', 512),
      model: boundedDshString(input?.model, 'model selection model', 512),
      ...(input?.reasoningEffort === undefined ? {} : {
        reasoningEffort: boundedDshString(input.reasoningEffort, 'model selection reasoning effort', 512)
      })
    };
    const value = await this.call('session.selectModel', payload, rpcId, signal, true);
    try {
      if (!isObject(value)) throw new Error('Invalid DSH session.selectModel result');
      return { selected: parseModelSelection(value.selected, 'selected model') };
    } catch (error) {
      throw new DshAmbiguousTransportError('session.selectModel', rpcId, error);
    }
  }

  async prompt(
    input: {
      sessionId: string;
      mode: 'queue' | 'steer';
      content: Array<{ type: 'text'; text: string }>;
      clientTimeZone?: string;
    },
    rpcId: string,
    signal?: AbortSignal
  ): Promise<{ accepted: true; command?: { kind: 'success'; text?: string } }> {
    const value = await this.call('session.prompt', input, rpcId, signal, true);
    if (!isObject(value) || value.accepted !== true) throw new Error('Invalid DSH session.prompt result');
    const result: { accepted: true; command?: { kind: 'success'; text?: string } } = { accepted: true };
    if (value.command !== undefined) {
      if (!isObject(value.command) || value.command.kind !== 'success') throw new Error('Invalid DSH prompt command result');
      result.command = {
        kind: 'success',
        ...(value.command.text === undefined ? {} : { text: requiredString(value.command.text, 'command text') })
      };
    }
    return result;
  }

  async cancel(sessionId: string, rpcId: string, signal?: AbortSignal): Promise<{ accepted: true }> {
    const value = await this.call('session.cancel', { sessionId }, rpcId, signal, true);
    if (!isObject(value) || value.accepted !== true) throw new Error('Invalid DSH session.cancel result');
    return { accepted: true };
  }

  async respond(response: DshClientResponse, signal?: AbortSignal): Promise<DshRespondReceipt> {
    const validated = validateClientResponse(response);
    const timeout = AbortSignal.timeout(this.rpcTimeoutMs);
    const requestSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;
    let result: DshFetchResponse;
    try {
      result = await this.fetchImpl(new URL('/api/respond', this.endpoint).href, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          origin: this.endpoint.origin
        },
        body: JSON.stringify(validated),
        redirect: 'manual',
        signal: requestSignal
      });
    } catch (error) {
      if (!signal?.aborted) throw new DshAmbiguousTransportError('respond', validated.rpcId, error);
      throw error;
    }
    if (!result.ok) {
      const error = new Error(`DSH respond transport failed with HTTP ${result.status}`);
      throw new DshAmbiguousTransportError('respond', validated.rpcId, error);
    }
    let body: string;
    try {
      body = await result.text();
    } catch (error) {
      throw new DshAmbiguousTransportError('respond', validated.rpcId, error);
    }
    if (Buffer.byteLength(body, 'utf8') > MAX_RPC_RESPONSE_BYTES) {
      throw new DshAmbiguousTransportError('respond', validated.rpcId, new Error('DSH respond receipt is too large'));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch (error) {
      throw new DshAmbiguousTransportError('respond', validated.rpcId, new Error('DSH respond returned invalid JSON', { cause: error }));
    }
    if (!isObject(parsed) || parsed.accepted !== true && parsed.accepted !== false) {
      throw new DshAmbiguousTransportError('respond', validated.rpcId, new Error('Invalid DSH respond receipt'));
    }
    if (parsed.accepted === true) return { accepted: true };
    if (parsed.reason !== 'not-pending' && parsed.reason !== 'bad-response') {
      throw new DshAmbiguousTransportError('respond', validated.rpcId, new Error('Invalid DSH respond rejection'));
    }
    return { accepted: false, reason: parsed.reason };
  }

  async respondQuestion(
    input: { rpcId: string; sessionId: string; answer: DshQuestionAnswer },
    signal?: AbortSignal
  ): Promise<DshRespondReceipt> {
    const rpcId = boundedDshString(input?.rpcId, 'response rpcId', 256);
    const sessionId = boundedDshString(input?.sessionId, 'response sessionId', 256);
    const answer = parseQuestionAnswer(input?.answer);
    return this.respond({
      type: 'client-response',
      rpcId,
      result: { ok: true, value: { sessionId, answer } }
    }, signal);
  }

  async cancelQuestion(
    input: { rpcId: string; message?: string },
    signal?: AbortSignal
  ): Promise<DshRespondReceipt> {
    const rpcId = boundedDshString(input?.rpcId, 'cancel response rpcId', 256);
    const message = input?.message === undefined ? 'cancelled by owner' : boundedDshString(input.message, 'cancel response message', 2_000);
    return this.respond({
      type: 'client-response',
      rpcId,
      result: {
        ok: false,
        error: { code: 'cancelled', message, details: {} }
      }
    }, signal);
  }

  async observeMux(
    onEnvelope: (envelope: DshMuxEnvelope) => void | Promise<void>,
    signal: AbortSignal,
    onOpen?: () => void
  ): Promise<void> {
    if (signal.aborted) throw signal.reason ?? new Error('DSH event stream aborted');
    const url = new URL('/api/events.mux', this.endpoint);
    url.protocol = 'ws:';
    const socket = this.createSocket(url.href, this.endpoint.origin);

    await new Promise<void>((resolve, reject) => {
      let opened = false;
      let settled = false;
      let processing = Promise.resolve();
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(openTimer);
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else processing.then(resolve, reject);
      };
      const abort = () => {
        try { socket.close(1000, 'aborted'); } catch { socket.terminate(); }
        settle(signal.reason instanceof Error ? signal.reason : undefined);
      };
      const openTimer = setTimeout(() => {
        try { socket.terminate(); } catch { /* already closed */ }
        settle(new Error('DSH event stream open timed out'));
      }, this.streamOpenTimeoutMs);

      signal.addEventListener('abort', abort, { once: true });
      socket.on('open', () => {
        if (settled) return;
        opened = true;
        clearTimeout(openTimer);
        onOpen?.();
      });
      socket.on('message', (data) => {
        if (settled) return;
        processing = processing.then(async () => {
          const raw = typeof data === 'string'
            ? data
            : Buffer.isBuffer(data)
              ? data.toString('utf8')
              : Array.isArray(data)
                ? Buffer.concat(data).toString('utf8')
                : Buffer.from(data as ArrayBuffer).toString('utf8');
          if (Buffer.byteLength(raw, 'utf8') > MAX_STREAM_FRAME_BYTES) throw new Error('DSH event frame is too large');
          const parsed = JSON.parse(raw) as unknown;
          if (!isObject(parsed) || parsed.type !== 'server-request' || !isObject(parsed.payload)) {
            throw new Error('Invalid DSH event envelope');
          }
          await onEnvelope({
            rpcId: requiredString(parsed.rpcId, 'event rpcId'),
            payload: parsed.payload,
            ...(parsed.method === undefined ? {} : { method: requiredString(parsed.method, 'event method') })
          });
        }).catch((error: unknown) => {
          try { socket.terminate(); } catch { /* already closed */ }
          settle(error instanceof Error ? error : new Error('DSH event handler failed'));
        });
      });
      socket.on('error', (error) => {
        if (!opened) settle(error);
      });
      socket.on('close', (code, reason) => {
        if (signal.aborted) settle();
        else settle(new Error(`DSH event stream closed (${code} ${reason.toString('utf8').slice(0, 200)})`));
      });
    });
  }

  async observeTypedMux(
    onFrame: (frame: DshTypedMuxFrame, envelope: DshMuxEnvelope) => void | Promise<void>,
    signal: AbortSignal,
    onOpen?: () => void
  ): Promise<void> {
    return this.observeMux(async (envelope) => {
      const frame = parseDshTypedMuxFrame(envelope.payload);
      if (frame !== null) await onFrame(frame, envelope);
    }, signal, onOpen);
  }

  private async call(
    method: string,
    payload: Record<string, unknown>,
    rpcId: string,
    signal: AbortSignal | undefined,
    mutation: boolean
  ): Promise<unknown> {
    requiredString(rpcId, 'rpcId');
    const timeout = AbortSignal.timeout(this.rpcTimeoutMs);
    const requestSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;
    const body = JSON.stringify({ type: 'client-request', rpcId, method, payload });
    let response: DshFetchResponse;
    try {
      response = await this.fetchImpl(new URL(`/api/${method}`, this.endpoint).href, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          origin: this.endpoint.origin
        },
        body,
        redirect: 'manual',
        signal: requestSignal
      });
    } catch (error) {
      if (mutation && !signal?.aborted) throw new DshAmbiguousTransportError(method, rpcId, error);
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`DSH ${method} transport failed with HTTP ${response.status}`);
      if (mutation) throw new DshAmbiguousTransportError(method, rpcId, error);
      throw error;
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      if (mutation) throw new DshAmbiguousTransportError(method, rpcId, error);
      throw error;
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_RPC_RESPONSE_BYTES) throw new Error(`DSH ${method} response is too large`);
    let envelope: unknown;
    try {
      envelope = JSON.parse(text) as unknown;
    } catch (error) {
      if (mutation) throw new DshAmbiguousTransportError(method, rpcId, error);
      throw new Error(`DSH ${method} returned invalid JSON`, { cause: error });
    }
    if (!isObject(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId || !isObject(envelope.result)) {
      const error = new Error(`Invalid DSH ${method} response envelope`);
      if (mutation) throw new DshAmbiguousTransportError(method, rpcId, error);
      throw error;
    }
    if (envelope.result.ok === true) return envelope.result.value;
    if (envelope.result.ok !== false || !isObject(envelope.result.error)) throw new Error(`Invalid DSH ${method} result`);
    const rpcError: DshRpcErrorPayload = {
      code: requiredString(envelope.result.error.code, 'RPC error code'),
      message: requiredString(envelope.result.error.message, 'RPC error message'),
      details: envelope.result.error.details
    };
    throw new DshRpcError(method, rpcId, rpcError);
  }
}
