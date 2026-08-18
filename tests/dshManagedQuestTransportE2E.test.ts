import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

import { Database } from '../src/main/services/database.js';
import { DshControlClient, type DshMuxEnvelope } from '../src/main/services/dshControlClient.js';
import { DshPolicyBroker } from '../src/main/services/dshPolicyBroker.js';
import { resolveBuiltinDshHostPolicy } from '../src/main/services/dshPluginPolicy.js';
import { DshQuestGovernanceService } from '../src/main/services/dshQuestGovernance.js';
import {
  DshTypedQuestBridge,
  type DshQuestionRequestedResult,
  type DshQuestionResolvedResult,
  type DshTypedQuestContext
} from '../src/main/services/dshTypedQuestBridge.js';
import { ProjectManager } from '../src/main/services/projectManager.js';
import { ProjectWorkbenchService } from '../src/main/services/projectWorkbench.js';
import { SecretaryPlanningRepository } from '../src/main/services/secretaryPlanningAdapters.js';
import type {
  DispatchPort,
  PlanningComplexitySignals
} from '../src/main/services/secretaryPlanning.js';

const require = createRequire(import.meta.url);
const { thirdPartyAuditEnvironment } = require('../scripts/prepare-deepseek-harness-managed.cjs') as {
  thirdPartyAuditEnvironment: (
    overrides?: Record<string, string>,
    source?: NodeJS.ProcessEnv
  ) => NodeJS.ProcessEnv;
};

const RUNTIME_ROOT = resolve('runtime/deepseek-harness-managed/dist');
const CLI_ENTRY = join(RUNTIME_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const POLICY_PATCH = join(RUNTIME_ROOT, 'opc-managed', 'managed-web.patch.yml');
const STARTUP_TIMEOUT_MS = 45_000;
const EVENT_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MANAGED_MODEL = 'opc-managed-quest-e2e';
const ASK_CALL_ID = 'call-managed-quest-owner';
const EXPECTED_ANSWER = 'Reviewed delivery';

const enabled = process.env.AIBOX_RUN_MANAGED_QUEST_E2E === '1';
const managedDescribe = enabled ? describe : describe.skip;

type SqlJs = Awaited<ReturnType<typeof initSqlJs>>;
type SqlDatabase = InstanceType<SqlJs['Database']>;
type TestDatabase = Database & { inner: SqlDatabase; scheduleSave: () => void };

interface FakeProviderRequest {
  model?: unknown;
  messages?: Array<Record<string, unknown>>;
  tools?: Array<{ function?: { name?: string } }>;
  stream?: unknown;
}

interface FakeProvider {
  server: Server;
  origin: string;
  requests: FakeProviderRequest[];
  toolResult: Promise<Record<string, unknown>>;
}

interface ManagedRuntime {
  child: ChildProcess;
  origin: string;
  scratch: string;
  workspace: string;
  logs: () => string;
}

let SQL: SqlJs;
const openDatabases: SqlDatabase[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  while (openDatabases.length > 0) openDatabases.pop()!.close();
});

function wrapDatabase(): TestDatabase {
  const inner = new SQL.Database();
  openDatabases.push(inner);
  const db = Reflect.construct(Database as unknown as new () => Database, []) as TestDatabase;
  db.inner = inner;
  db.scheduleSave = () => {};
  (db as unknown as { flush: () => void }).flush = () => {};
  (db as unknown as { migrate: () => void }).migrate();
  return db;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        request.destroy(new Error('fake provider request exceeded the test limit'));
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    request.once('error', rejectBody);
  });
}

function writeSse(response: ServerResponse, chunks: unknown[]): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end('data: [DONE]\n\n');
}

function toolCallChunks(): unknown[] {
  const argumentsJson = JSON.stringify({
    questions: [{
      id: 'delivery-mode',
      header: 'Delivery posture',
      question: 'Which delivery posture should Cordis use?',
      options: [
        { label: EXPECTED_ANSWER, description: 'Add an independent acceptance pass.' },
        { label: 'Fast draft', description: 'Optimize for the first delivery.' }
      ],
      multi_select: false
    }]
  });
  return [
    {
      id: 'chatcmpl-managed-quest-tool',
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: ASK_CALL_ID,
            type: 'function',
            function: { name: 'ask_user_question', arguments: argumentsJson }
          }]
        },
        finish_reason: null
      }]
    },
    {
      id: 'chatcmpl-managed-quest-tool',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 24, completion_tokens: 12, total_tokens: 36 }
    }
  ];
}

function textChunks(text: string): unknown[] {
  return [
    {
      id: 'chatcmpl-managed-quest-text',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }]
    },
    {
      id: 'chatcmpl-managed-quest-text',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 }
    }
  ];
}

async function listen(server: Server): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectPort);
      const address = server.address();
      if (!address || typeof address === 'string') rejectPort(new Error('fake provider has no TCP address'));
      else resolvePort(address.port);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

async function startFakeProvider(): Promise<FakeProvider> {
  const requests: FakeProviderRequest[] = [];
  let resolveToolResult!: (message: Record<string, unknown>) => void;
  const toolResult = new Promise<Record<string, unknown>>((resolveResult) => {
    resolveToolResult = resolveResult;
  });
  let toolResultSeen = false;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
        response.writeHead(404).end('not found');
        return;
      }
      if (!request.headers.authorization?.startsWith('Bearer ')) {
        response.writeHead(401).end('missing bearer capability');
        return;
      }
      const payload = JSON.parse(await readBody(request)) as FakeProviderRequest;
      requests.push(payload);
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const answerMessage = messages.find((message) => message.role === 'tool' && message.tool_call_id === ASK_CALL_ID);
      if (answerMessage) {
        if (!toolResultSeen) {
          toolResultSeen = true;
          resolveToolResult(answerMessage);
        }
        writeSse(response, textChunks('The owner selected a reviewed delivery.'));
        return;
      }
      const hasAskTool = payload.tools?.some((tool) => tool.function?.name === 'ask_user_question') === true;
      writeSse(response, hasAskTool ? toolCallChunks() : textChunks('Managed Quest E2E'));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
    }
  });
  const port = await listen(server);
  cleanups.push(() => closeServer(server));
  return { server, origin: `http://127.0.0.1:${port}`, requests, toolResult };
}

function endpointFromLogs(logs: string): string | null {
  const matches = [...logs.matchAll(/dsh web:\s*(http:\/\/127\.0\.0\.1:(\d+))\b/g)];
  return matches.length === 1 ? matches[0]![1]! : null;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStop) => {
    const force = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
    }, 3_000);
    child.once('close', () => {
      clearTimeout(force);
      resolveStop();
    });
    try { child.kill('SIGTERM'); } catch { resolveStop(); }
  });
}

async function startManagedRuntime(providerOrigin: string): Promise<ManagedRuntime> {
  if (!existsSync(CLI_ENTRY) || !existsSync(POLICY_PATCH)) {
    throw new Error('managed DSH runtime is absent; run npm run harness:managed:prepare first');
  }
  const scratch = mkdtempSync(join(tmpdir(), 'opc-nexus-dsh-quest-e2e-'));
  const home = join(scratch, 'home');
  const workspace = join(scratch, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  let logs = '';
  const child = spawn(process.execPath, [
    CLI_ENTRY,
    '--profile', 'web',
    '--patch', POLICY_PATCH,
    '--host', '127.0.0.1',
    '--port', '0'
  ], {
    cwd: workspace,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: thirdPartyAuditEnvironment({
      DSH_HOME: home,
      DSH_AGENTS_HOME: join(home, 'agents'),
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: `dshp_${'E'.repeat(43)}`,
      DEEPSEEK_BASE_URL: `${providerOrigin}/v1`,
      AIBOX_DSH_MODEL: MANAGED_MODEL
    })
  });
  const origin = await new Promise<string>((resolveOrigin, rejectOrigin) => {
    const timer = setTimeout(() => rejectOrigin(new Error(`managed DSH startup timed out: ${logs.slice(-4_000)}`)), STARTUP_TIMEOUT_MS);
    const inspect = (chunk: Buffer | string) => {
      logs = `${logs}${String(chunk)}`.slice(-16_000);
      const endpoint = endpointFromLogs(logs);
      if (endpoint) {
        clearTimeout(timer);
        resolveOrigin(endpoint);
      }
    };
    child.stdout?.on('data', inspect);
    child.stderr?.on('data', inspect);
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectOrigin(error);
    });
    child.once('close', (code, signal) => {
      if (!endpointFromLogs(logs)) {
        clearTimeout(timer);
        rejectOrigin(new Error(`managed DSH exited before startup (${code ?? signal ?? 'unknown'}): ${logs}`));
      }
    });
  });
  cleanups.push(async () => {
    await stopChild(child);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
  return { child, origin, scratch, workspace, logs: () => logs };
}

function signals(): PlanningComplexitySignals {
  return {
    departmentIds: ['cordis'],
    hasCrossTeamDependencies: false,
    ambiguousObjective: false,
    ambiguousScope: false,
    ambiguousAcceptance: true,
    estimatedDurationMinutes: 90,
    estimatedCost: 1,
    estimatedTokenCount: 12_000,
    requiresNewTeam: false,
    irreversibleOperations: [],
    compareAlternatives: true,
    phasedExecution: true,
    confirmBeforeExecution: true,
    estimatedTaskCount: 2
  };
}

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = EVENT_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    })
  ]);
}

managedDescribe.sequential('managed DSH Quest transport E2E', () => {
  it('projects a real rc.6 ask_user_question and writes the owner answer back through /api/respond', async () => {
    const provider = await startFakeProvider();
    const runtime = await startManagedRuntime(provider.origin);
    const client = new DshControlClient(runtime.origin, { rpcTimeoutMs: EVENT_TIMEOUT_MS });
    const upstreamSessionId = `managed-quest-e2e-${randomUUID()}`;
    const created = await client.createSession({
      sessionId: upstreamSessionId,
      cwd: runtime.workspace,
      agentPreset: 'cordis'
    }, `create-${randomUUID()}`);
    expect(created).toMatchObject({ sessionId: upstreamSessionId, agentPreset: 'cordis' });

    const db = wrapDatabase();
    const now = Date.UTC(2026, 7, 17, 16, 0, 0);
    const runtimeInstanceId = 'runtime-managed-quest-e2e';
    const localSessionId = 'session-managed-quest-e2e';
    const agentId = 'agent-managed-quest-e2e';
    db.inner.exec(`
      INSERT INTO engines(id, type, name, status)
        VALUES('engine-managed-quest-e2e', 'dsh-managed', 'DSH managed Quest E2E', 'HEALTHY');
      INSERT INTO agents(
        id, organization_id, name, role, engine_id, lifecycle, workspace,
        permission_mode, capabilities_json, created_at, updated_at
      ) VALUES(
        '${agentId}', 'org-local', 'Cordis E2E', 'Quest lead', 'engine-managed-quest-e2e',
        'READY', '${runtime.workspace.replaceAll("'", "''")}', 'standard', '{}', ${now}, ${now}
      );
      INSERT INTO dsh_profiles(id, engine_id, version, created_at, updated_at)
        VALUES('profile-managed-quest-e2e', 'engine-managed-quest-e2e', 1, ${now}, ${now});
      INSERT INTO dsh_runtime_instances(id, agent_id, profile_id, process_state, endpoint, created_at, updated_at)
        VALUES(
          '${runtimeInstanceId}', '${agentId}', 'profile-managed-quest-e2e', 'READY',
          '${runtime.origin}', ${now}, ${now}
        );
      INSERT INTO dsh_sessions(
        id, upstream_session_id, runtime_instance_id, agent_id, workspace,
        control_mode, delegation_depth, created_at, updated_at
      ) VALUES(
        '${localSessionId}', '${upstreamSessionId}', '${runtimeInstanceId}', '${agentId}',
        '${runtime.workspace.replaceAll("'", "''")}', 'NEXUS_MANAGED', 0, ${now}, ${now}
      );
    `);
    const projects = new ProjectManager(db);
    const project = projects.create({
      name: 'Managed Quest transport E2E',
      objective: 'Verify the real DSH typed owner interaction transport',
      status: 'active'
    });
    const workbench = new ProjectWorkbenchService(db);
    workbench.saveSettings(project.id, {
      mode: 'quest',
      permissionMode: 'standard',
      workerAgentIds: []
    });
    const repository = new SecretaryPlanningRepository(db);
    const dispatchPort: DispatchPort = {
      createTask: () => { throw new Error('the question transport E2E must not dispatch work'); }
    };
    const governance = new DshQuestGovernanceService({ db, repository, dispatchPort, workbench, now: () => now });
    const context: DshTypedQuestContext = {
      runtimeInstanceId,
      upstreamSessionId,
      dshSessionId: localSessionId,
      planningSessionId: 'quest-managed-transport-e2e',
      projectId: project.id,
      principalId: 'principal-local-admin',
      request: 'Ask the owner to choose a delivery posture before planning.',
      signals: signals()
    };
    const policy = new DshPolicyBroker({ resolve: resolveBuiltinDshHostPolicy });
    const bridge = new DshTypedQuestBridge({
      governance,
      resolveContext: (sessionId) => sessionId === upstreamSessionId ? context : null,
      policyForContext: () => policy.scopeRuntime({
        organizationId: 'org-local', runtimeId: runtimeInstanceId, agentId
      })
    });

    let resolveRequested!: (value: DshQuestionRequestedResult) => void;
    let resolveResolved!: (value: DshQuestionResolvedResult) => void;
    let resolveOpen!: () => void;
    const requestedEvent = new Promise<DshQuestionRequestedResult>((resolveEvent) => { resolveRequested = resolveEvent; });
    const resolvedEvent = new Promise<DshQuestionResolvedResult>((resolveEvent) => { resolveResolved = resolveEvent; });
    const streamOpened = new Promise<void>((resolveEvent) => { resolveOpen = resolveEvent; });
    const streamAbort = new AbortController();
    const muxEnvelopes: DshMuxEnvelope[] = [];
    const stream = client.observeMux(async (envelope) => {
      muxEnvelopes.push(envelope);
      const event = await bridge.handleEnvelope(envelope, streamAbort.signal);
      if (event?.kind === 'question-requested') resolveRequested(event);
      if (event?.kind === 'question-resolved') resolveResolved(event);
    }, streamAbort.signal, resolveOpen);
    cleanups.push(async () => {
      streamAbort.abort('test complete');
      await stream.catch(() => {});
    });
    await withTimeout(streamOpened, 'events.mux open');

    await client.prompt({
      sessionId: upstreamSessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'Ask me to choose the delivery posture before you continue.' }]
    }, `prompt-${randomUUID()}`);
    const requested = await withTimeout(requestedEvent, 'question/requested');
    expect(requested.rpcId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(requested.frame).toMatchObject({
      type: 'question/requested',
      sessionId: upstreamSessionId,
      questions: [{
        id: 'delivery-mode',
        question: 'Which delivery posture should Cordis use?',
        multiSelect: false,
        options: [
          { label: EXPECTED_ANSWER },
          { label: 'Fast draft' }
        ]
      }]
    });
    expect(requested.projection.planReview).toBeNull();
    expect(requested.projection.questions[0]).toMatchObject({
      id: 'delivery-mode',
      kind: 'single',
      prompt: 'Which delivery posture should Cordis use?'
    });
    expect(requested.projection.view.session.status).toBe('NEEDS_INPUT');
    expect(requested.projection.view.binding).toMatchObject({
      planningSessionId: context.planningSessionId,
      projectId: project.id,
      dshSessionId: localSessionId,
      principalId: context.principalId
    });

    const answer = { answers: [{ id: 'delivery-mode', selected: [EXPECTED_ANSWER] }] };
    const answered = await bridge.answerQuestion(client, {
      rpcId: requested.rpcId,
      frame: requested.frame,
      context,
      principalId: context.principalId,
      answer
    });
    expect(answered.receipt).toEqual({ accepted: true });
    expect(answered.view.session.status).toBe('DRAFT');
    expect(answered.answers).toEqual([{
      questionId: 'delivery-mode',
      selectedOptionIds: [expect.stringMatching(/^dsh-option-/)],
      text: null
    }]);

    const providerToolResult = await withTimeout(provider.toolResult, 'provider tool result');
    expect(providerToolResult.role).toBe('tool');
    expect(providerToolResult.tool_call_id).toBe(ASK_CALL_ID);
    expect(JSON.parse(String(providerToolResult.content))).toEqual(answer);
    const resolved = await withTimeout(resolvedEvent, 'question/resolved');
    expect(resolved.frame).toEqual({
      type: 'question/resolved',
      sessionId: upstreamSessionId,
      questionRpcId: requested.rpcId,
      outcome: 'answered'
    });
    expect(resolved.requested?.projection.sourceId).toBe(requested.projection.sourceId);
    expect(muxEnvelopes.some((envelope) => envelope.method === 'question/requested')).toBe(true);
    expect(provider.requests.some((request) => request.model === MANAGED_MODEL
      && request.tools?.some((tool) => tool.function?.name === 'ask_user_question'))).toBe(true);
  }, 90_000);
});
