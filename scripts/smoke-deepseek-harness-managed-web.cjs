'use strict';

const { randomUUID } = require('node:crypto');
const { existsSync, mkdirSync, mkdtempSync, rmSync } = require('node:fs');
const { request } = require('node:http');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawn } = require('node:child_process');
const { thirdPartyAuditEnvironment } = require('./prepare-deepseek-harness-managed.cjs');

const DEFAULT_RUNTIME_ROOT = resolve(__dirname, '..', 'runtime', 'deepseek-harness-managed', 'dist');
const CLI_ENTRY = join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const POLICY_PATCH = join('opc-managed', 'managed-web.patch.yml');
const STARTUP_TIMEOUT_MS = 45_000;
const REQUEST_TIMEOUT_MS = 10_000;
const TOOL_CATALOG_TIMEOUT_MS = 10_000;
const TOOL_CATALOG_POLL_MS = 25;
const MAX_LOG_CHARS = 8_000;
const MANAGED_PRESET_IDS = ['code', 'cordis', 'minimal', 'standard'];
const FORBIDDEN_PRESET_PACKAGES = [
  '@deepseek-ai/dsh-tool-bash',
  '@deepseek-ai/dsh-tool-pwsh',
  '@deepseek-ai/dsh-tool-bash-persistent',
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-fs-local',
  '@deepseek-ai/dsh-tool-str-replace-editor',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-tool-skill',
  '@deepseek-ai/dsh-tool-workflow',
  '@deepseek-ai/dsh-workflow-worker-thread',
  '@deepseek-ai/dsh-tool-web',
  '@deepseek-ai/dsh-tool-cordis',
  '@deepseek-ai/dsh-agent-tool-presentation',
  '@deepseek-ai/dsh-terminal',
  '@deepseek-ai/dsh-terminal-bash',
  '@deepseek-ai/dsh-tool-ralph',
];
const EXPECTED_MANAGED_TOOL_NAMES = Object.freeze([
  'ask_user_question',
  'create_goal',
  'exit_plan_mode',
  'get_goal',
  'interrupt_agent',
  'job_kill',
  'job_list',
  'job_output',
  'list_agents',
  'send_message',
  'subagent',
  'subagent_fork',
  'todo_write',
  'update_goal',
]);
const FORBIDDEN_MANAGED_TOOL_NAMES = new Set([
  'bash',
  'pwsh',
  'bash_persistent',
  'read',
  'write',
  'edit',
  'read_image',
  'glob',
  'grep',
  'str_replace_editor',
  'web_search',
  'web_fetch',
  'skill',
  'workflow',
  'ralph',
]);

function requestText(url, options = {}, body) {
  return new Promise((resolveRequest, rejectRequest) => {
    const target = new URL(url);
    const req = request(target, {
      method: options.method ?? 'GET',
      headers: options.headers,
      timeout: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes <= 1_000_000) chunks.push(chunk);
      });
      response.once('end', () => resolveRequest({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      response.once('error', rejectRequest);
    });
    req.once('timeout', () => req.destroy(new Error(`request timed out: ${target.href}`)));
    req.once('error', rejectRequest);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function parseStartupEndpoint(output) {
  const matches = [...output.matchAll(/dsh web:\s*(http:\/\/127\.0\.0\.1:(\d+))\b/g)];
  if (matches.length !== 1) return null;
  const port = Number(matches[0][2]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
  return matches[0][1];
}

function appendLog(current, chunk) {
  const next = `${current}${String(chunk)}`;
  return next.length <= MAX_LOG_CHARS ? next : next.slice(-MAX_LOG_CHARS);
}

function toolNamesFromHistory(history) {
  if (!Array.isArray(history?.events)) return null;
  const requestHeader = history.events.find((entry) => entry?.event?.type === 'request/header');
  const tools = requestHeader?.event?.data?.header?.tools;
  if (!Array.isArray(tools) || tools.some((tool) => typeof tool?.name !== 'string')) return null;
  return tools.map((tool) => tool.name).sort();
}

function assertManagedToolCatalog(toolNames, agentPreset) {
  const forbidden = toolNames.filter((name) =>
    FORBIDDEN_MANAGED_TOOL_NAMES.has(name) || name.startsWith('cordis_'));
  if (forbidden.length > 0) {
    throw new Error(`managed DSH preset ${agentPreset} exposed forbidden tools: ${forbidden.join(', ')}`);
  }
  if (JSON.stringify(toolNames) !== JSON.stringify(EXPECTED_MANAGED_TOOL_NAMES)) {
    throw new Error(`managed DSH preset ${agentPreset} tool catalog drifted: ${JSON.stringify(toolNames)}`);
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function callRpcEnvelope(origin, method, payload = {}) {
  const rpcId = randomUUID();
  const body = JSON.stringify({ type: 'client-request', rpcId, method, payload });
  const response = await requestText(`${origin}/api/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      origin,
    },
  }, body);
  let envelope;
  try { envelope = JSON.parse(response.body); } catch { /* validated below */ }
  if (response.status !== 200
    || envelope?.type !== 'server-response'
    || envelope?.rpcId !== rpcId
    || typeof envelope?.result?.ok !== 'boolean') {
    throw new Error(`managed DSH Web ${method} contract failed: HTTP ${response.status}`);
  }
  return envelope;
}

function assertDirectoryPickerUnavailable(envelope, method) {
  if (envelope?.result?.ok !== false
    || envelope.result.error?.code !== 'directory-picker-unavailable'
    || envelope.result.error?.details?.capability !== 'none') {
    throw new Error(`managed DSH Web ${method} did not fail closed without a directory picker`);
  }
}

async function callRpc(origin, method, payload = {}) {
  const envelope = await callRpcEnvelope(origin, method, payload);
  if (envelope.result.ok !== true) {
    throw new Error(`managed DSH Web ${method} failed: ${envelope.result.error?.code ?? 'unknown'}`);
  }
  return envelope.result.value;
}

async function probeManagedToolCatalog(origin, sessionId, agentPreset) {
  try {
    await callRpc(origin, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'Inspect the managed tool catalog.' }],
    });
    const deadline = Date.now() + TOOL_CATALOG_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const history = await callRpc(origin, 'session.history', { sessionId, maxMessages: 256 });
      const toolNames = toolNamesFromHistory(history);
      if (toolNames !== null) {
        assertManagedToolCatalog(toolNames, agentPreset);
        return toolNames;
      }
      await delay(TOOL_CATALOG_POLL_MS);
    }
    throw new Error(`managed DSH preset ${agentPreset} did not record a request/header tool catalog`);
  } finally {
    await callRpc(origin, 'session.cancel', { sessionId });
  }
}

function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveStop) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(abandonTimer);
      resolveStop();
    };
    const forceTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* process already exited */ }
    }, 3_000);
    const abandonTimer = setTimeout(finish, 6_000);
    child.once('close', finish);
    try { child.kill('SIGTERM'); } catch { finish(); }
  });
}

async function smokeManagedHarnessWeb(options = {}) {
  const executable = resolve(options.executable ?? process.execPath);
  const runtimeRoot = resolve(options.runtimeRoot ?? DEFAULT_RUNTIME_ROOT);
  const entry = join(runtimeRoot, CLI_ENTRY);
  const policyPatch = join(runtimeRoot, POLICY_PATCH);
  if (!existsSync(executable)) throw new Error(`managed Web smoke executable is missing: ${executable}`);
  if (!existsSync(entry)) throw new Error(`managed Web smoke CLI is missing: ${entry}`);
  if (!existsSync(policyPatch)) {
    throw new Error(`managed Web smoke policy assets are missing below: ${runtimeRoot}`);
  }

  const scratch = mkdtempSync(join(tmpdir(), 'opc-nexus-dsh-web-smoke-'));
  const home = join(scratch, 'home');
  const workspace = join(scratch, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });

  const child = spawn(executable, [
    entry,
    '--profile', 'web',
    '--patch', policyPatch,
    '--host', '127.0.0.1',
    '--port', '0',
  ], {
    cwd: workspace,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: thirdPartyAuditEnvironment({
      DSH_HOME: home,
      DSH_AGENTS_HOME: join(home, 'agents'),
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: `dshp_${'A'.repeat(43)}`,
      DEEPSEEK_BASE_URL: 'http://127.0.0.1:9/v1',
      AIBOX_DSH_MODEL: 'opc-managed-smoke-model',
    }),
  });

  let logs = '';
  let endpoint = null;
  let resolveStarted;
  let rejectStarted;
  const started = new Promise((resolveValue, rejectValue) => {
    resolveStarted = resolveValue;
    rejectStarted = rejectValue;
  });
  const inspect = (chunk) => {
    logs = appendLog(logs, chunk);
    endpoint = endpoint ?? parseStartupEndpoint(logs);
    if (endpoint) resolveStarted(endpoint);
  };
  child.stdout.on('data', inspect);
  child.stderr.on('data', inspect);
  child.once('error', rejectStarted);
  child.once('close', (code, signal) => {
    if (!endpoint) rejectStarted(new Error(
      `managed DSH Web exited before startup (${code ?? signal ?? 'unknown'}): ${logs.trim()}`
    ));
  });

  const startupTimer = setTimeout(() => {
    rejectStarted(new Error(`managed DSH Web startup timed out: ${logs.trim()}`));
  }, options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);

  try {
    const origin = await started;
    clearTimeout(startupTimer);

    const page = await requestText(`${origin}/`);
    if (page.status !== 200
      || !String(page.headers['content-type'] ?? '').startsWith('text/html')
      || !page.body.includes('<title>DeepSeek Harness</title>')) {
      throw new Error(`managed DSH Web root contract failed: HTTP ${page.status}`);
    }

    const sessions = await callRpc(origin, 'session.list');
    if (!Array.isArray(sessions?.items)) {
      throw new Error('managed DSH Web session.list returned an invalid value');
    }

    const blockedDirectory = join(workspace, 'must-not-create');
    for (const [method, payload] of [
      ['host.pickDirectory', {}],
      ['host.listDirectory', {}],
      ['host.createDirectory', { path: workspace, name: 'must-not-create' }],
    ]) {
      assertDirectoryPickerUnavailable(await callRpcEnvelope(origin, method, payload), method);
    }
    if (existsSync(blockedDirectory)) {
      throw new Error('managed DSH Web created a directory through its disabled picker surface');
    }

    const managedSessions = [];
    for (const agentPreset of MANAGED_PRESET_IDS) {
      const sessionId = `managed-smoke-${agentPreset}-${randomUUID()}`;
      const created = await callRpc(origin, 'session.create', {
        sessionId,
        cwd: workspace,
        agentPreset,
      });
      if (created?.sessionId !== sessionId || created?.agentPreset !== agentPreset) {
        throw new Error(`managed DSH Web session.create did not mount ${agentPreset}`);
      }
      const models = await callRpc(origin, 'session.models', { sessionId });
      if (models?.current?.provider !== 'deepseek-official'
        || models?.current?.model !== 'opc-managed-smoke-model') {
        throw new Error(`managed DSH model route escaped Nexus policy: ${JSON.stringify(models?.current)}`);
      }
      managedSessions.push({ agentPreset, sessionId });
    }
    for (const { agentPreset, sessionId } of managedSessions) {
      await probeManagedToolCatalog(origin, sessionId, agentPreset);
    }

    const settings = await callRpcEnvelope(origin, 'settings.describe');
    const credentials = await callRpcEnvelope(origin, 'credentials.set', {
      ref: 'DEEPSEEK_API_KEY',
      value: 'must-not-persist',
    });
    if (settings.result.ok !== false || !String(settings.result.error?.message).includes('settings service is absent')
      || credentials.result.ok !== false || !String(credentials.result.error?.message).includes('credentials service is absent')
      || existsSync(join(home, 'settings.yaml')) || existsSync(join(home, '.credentials.yaml'))) {
      throw new Error('managed DSH exposed a writable local settings or credential store');
    }

    const roster = await callRpc(origin, 'agentPreset.list');
    const presetIds = roster?.presets?.map((preset) => preset.id).sort();
    if (JSON.stringify(presetIds) !== JSON.stringify(MANAGED_PRESET_IDS)
      || roster.authorable !== false
      || roster.presets.some((preset) => preset.trust !== 'system' || preset.broken !== undefined)) {
      throw new Error(`managed DSH preset roster is not fail-closed: ${JSON.stringify(roster)}`);
    }
    for (const agentPreset of MANAGED_PRESET_IDS) {
      const preset = await callRpc(origin, 'agentPreset.read', { agentPreset });
      if (preset?.agentPreset !== agentPreset || preset?.trust !== 'system'
        || typeof preset?.content !== 'string'
        || FORBIDDEN_PRESET_PACKAGES.some((name) => preset.content.includes(name))) {
        throw new Error(`managed DSH preset exposes an unreviewed capability: ${agentPreset}`);
      }
    }

    const crossSiteRpcId = randomUUID();
    const payload = JSON.stringify({
      type: 'client-request', rpcId: crossSiteRpcId, method: 'session.list', payload: {},
    });
    const rejected = await requestText(`${origin}/api/session.list`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        origin: 'https://cross-site.invalid',
      },
    }, payload);
    if (rejected.status !== 403) {
      throw new Error(`managed DSH Web accepted a cross-origin RPC: HTTP ${rejected.status}`);
    }

    return { origin, version: '0.1.0-rc.6' };
  } finally {
    clearTimeout(startupTimer);
    await stopChild(child);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
}

if (require.main === module) {
  smokeManagedHarnessWeb().then(({ origin }) => {
    console.log(`[deepseek-harness-managed] Web smoke passed: ${origin}`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_RUNTIME_ROOT,
  EXPECTED_MANAGED_TOOL_NAMES,
  assertDirectoryPickerUnavailable,
  assertManagedToolCatalog,
  parseStartupEndpoint,
  requestText,
  smokeManagedHarnessWeb,
  toolNamesFromHistory,
};
