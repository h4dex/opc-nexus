'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const evidenceRoot = path.resolve(
  process.env.AIBOX_ACCEPTANCE_OUTPUT || path.join(root, 'tmp', 'acceptance-real', stamp)
);
const userData = path.join(evidenceRoot, 'user-data');
const seedUserData = (process.env.AIBOX_ACCEPTANCE_SEED_USER_DATA || '').trim();
const workspace = path.join(evidenceRoot, 'project-workspace');
const reportPath = path.join(evidenceRoot, 'report.json');
const hermesDarkScreenshotPath = path.join(evidenceRoot, 'hermes-workbench-dark.png');
const hermesLightScreenshotPath = path.join(evidenceRoot, 'hermes-workbench-light.png');

const baseUrl = (process.env.AIBOX_ACCEPTANCE_BASE_URL || '').trim();
const apiKey = (process.env.AIBOX_ACCEPTANCE_API_KEY || '').trim();
const preferredModel = (process.env.AIBOX_ACCEPTANCE_MODEL || '').trim();
const autoValidation = process.env.AIBOX_ACCEPTANCE_AUTO_VALIDATION === '1';
if ((!baseUrl || !apiKey) && !seedUserData) {
  throw new Error('Provider credentials or AIBOX_ACCEPTANCE_SEED_USER_DATA are required');
}

if (seedUserData) {
  if (!fs.statSync(seedUserData).isDirectory()) throw new Error('AIBOX_ACCEPTANCE_SEED_USER_DATA is not a directory');
  fs.cpSync(seedUserData, userData, { recursive: true, errorOnExist: false, force: true });
} else {
  fs.mkdirSync(userData, { recursive: true });
}
fs.mkdirSync(workspace, { recursive: true });

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  evidenceRoot,
  userData,
  workspace,
  provider: { baseUrl, modelCount: 0, defaultModel: null, projectModel: null, reachable: false },
  steps: [],
  consoleErrors: [],
  screenshots: [],
  result: 'RUNNING'
};

function safeText(value, max = 8_000) {
  const text = String(value ?? '');
  return (apiKey ? text.split(apiKey).join('[REDACTED]') : text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .slice(0, max);
}

function serializable(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item === 'string') return safeText(item);
    return item;
  }));
}

async function meanLuminance(png) {
  const { data, info } = await sharp(png)
    .removeAlpha()
    .resize({ width: 64, height: 64, fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    sum += (0.2126 * data[offset]) + (0.7152 * data[offset + 1]) + (0.0722 * data[offset + 2]);
  }
  return sum / (data.length / info.channels);
}

async function step(name, action, required = true) {
  const startedAt = Date.now();
  try {
    const value = await action();
    report.steps.push({ name, status: 'PASS', durationMs: Date.now() - startedAt, evidence: serializable(value) });
    return value;
  } catch (error) {
    report.steps.push({
      name,
      status: 'FAIL',
      durationMs: Date.now() - startedAt,
      error: safeText(error instanceof Error ? error.message : error)
    });
    if (required) throw error;
    return null;
  }
}

function chooseModels(models) {
  const normalized = [...new Set(models.filter((model) => typeof model === 'string' && model.trim()))];
  if (normalized.length === 0) throw new Error('Provider returned no models');
  const exact = [
    preferredModel,
    'gpt-5.4',
    'gpt-5.2',
    'claude-sonnet-4-6',
    'claude-sonnet-4-5',
    'gemini-3.1-pro-preview',
    'gemini-2.5-pro',
    'deepseek-v4-pro-0813',
    'qwen3.6-max-preview',
    'glm-5.2',
    'deepseek-chat',
    'gpt-4o-mini'
  ].filter(Boolean);
  const projectModel = exact.find((candidate) => normalized.includes(candidate))
    || normalized.find((model) => /(?:gpt-5|sonnet|gemini.*pro|deepseek)/i.test(model))
    || normalized[0];
  const defaultModel = normalized.find((model) => model !== projectModel && /(?:mini|flash|haiku|chat)/i.test(model))
    || normalized.find((model) => model !== projectModel)
    || projectModel;
  return { defaultModel, projectModel };
}

function httpsJson(url, options = {}) {
  const target = new URL(url);
  const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: target.hostname,
      port: Number(target.port),
      path: `${target.pathname}${target.search}`,
      method: options.method || (body ? 'POST' : 'GET'),
      rejectUnauthorized: false,
      headers: {
        Host: target.host,
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': String(body.length) } : {}),
        ...(options.headers || {})
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* keep raw text */ }
        resolve({ status: response.statusCode || 0, headers: response.headers, json, text: safeText(text) });
      });
    });
    request.once('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function readUrl(url) {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(target, {
      method: 'GET',
      rejectUnauthorized: false,
      headers: { Host: target.host }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => resolve({
        status: response.statusCode || 0,
        contentType: String(response.headers['content-type'] || ''),
        // Preview assertions must inspect complete HTML below the fold while
        // retaining credential redaction.
        text: safeText(Buffer.concat(chunks).toString('utf8'), 128_000)
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

function pairingCookies(headers) {
  const values = Array.isArray(headers['set-cookie'])
    ? headers['set-cookie']
    : headers['set-cookie'] ? [headers['set-cookie']] : [];
  return values.map((value) => value.split(';', 1)[0]).join('; ');
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('LAN port allocation failed'));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} timed out${last ? `: ${safeText(JSON.stringify(last))}` : ''}`);
}

async function main() {
  const appEnv = { ...process.env, AIBOX_DISABLE_HARDWARE_ACCELERATION: '1', AIBOX_USER_DATA_DIR: userData };
  const packagedExecutable = (process.env.AIBOX_ACCEPTANCE_EXECUTABLE || '').trim();
  delete appEnv.AIBOX_ACCEPTANCE_API_KEY;
  delete appEnv.AIBOX_ACCEPTANCE_BASE_URL;
  delete appEnv.AIBOX_ACCEPTANCE_MODEL;
  delete appEnv.AIBOX_ACCEPTANCE_OUTPUT;
  delete appEnv.ELECTRON_RUN_AS_NODE;

  const application = await electron.launch({
    executablePath: packagedExecutable || require('electron'),
    args: packagedExecutable ? [] : ['.'],
    cwd: root,
    env: appEnv,
    timeout: 60_000
  });
  let page;
  let project;
  let hermesContentsId = null;
  let hermesProxyPort = null;
  let embeddedBounds;
  let operatorMobile = null;

  const isTransientHermesContextError = (error) => /WebContents was destroyed|WebContents is unavailable|Execution context was destroyed|most likely because of a navigation/i.test(String(error?.message || error));

  const locateHermesContents = async () => {
    if (!hermesProxyPort) return null;
    try {
      return await application.evaluate(({ webContents }, port) => {
        const match = webContents.getAllWebContents().find((contents) => {
          if (contents.isDestroyed()) return false;
          try { return new URL(contents.getURL()).port === String(port); } catch { return false; }
        });
        return match?.id || null;
      }, hermesProxyPort);
    } catch (error) {
      if (isTransientHermesContextError(error)) return null;
      throw error;
    }
  };

  // The Quest layout can change after a drawer, preview, or runtime restart.
  // Never reuse the bounds captured during initial startup when reopening the
  // embedded view; Main validates them against the host's current content
  // area and should reject genuinely out-of-window coordinates.
  const readCurrentEmbeddedBounds = async () => application.evaluate(({ BrowserWindow }) => {
    const host = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
    if (!host) throw new Error('Main window is unavailable');
    const [width, height] = host.getContentSize();
    if (width < 336 || height < 256) {
      throw new Error(`Main window content is too small for Hermes (${width}x${height})`);
    }
    return {
      x: 8,
      y: 8,
      width: width - 16,
      height: height - 16
    };
  });

  const recoverHermesContents = async () => {
    const current = await locateHermesContents();
    if (current) {
      hermesContentsId = current;
      return current;
    }
    if (!page || !project || !hermesProxyPort || !embeddedBounds) return null;
    // The embedded view can legitimately be replaced after a Quest navigation
    // or host renderer reload. Re-open the same project once, then re-discover
    // the new WebContents id. The project proxy/runtime remains authoritative.
    let opened = false;
    for (let attempt = 0; attempt < 2 && !opened; attempt += 1) {
      try {
        const bounds = await readCurrentEmbeddedBounds();
        embeddedBounds = bounds;
        await page.evaluate(({ projectId, bounds: nextBounds }) => window.aibox.openEmbeddedHermesWorkbench({
          projectId, bounds: nextBounds, theme: 'dark'
        }), { projectId: project.id, bounds });
        opened = true;
      } catch (error) {
        const message = String(error?.message || error);
        if (/request was superseded/i.test(message)) {
          opened = true;
        } else if (attempt === 0 && isTransientHermesContextError(error)) {
          await new Promise((resolve) => setTimeout(resolve, 750));
        } else {
          throw error;
        }
      }
    }
    const recovered = await waitFor(locateHermesContents, 60_000, 'recovered Hermes WebContents');
    hermesContentsId = recovered;
    return recovered;
  };

  const projectRequest = async (operation, payload) => {
    let retried = false;
    while (true) {
      const id = await recoverHermesContents();
      if (!id) throw new Error('Hermes embedded WebContents is unavailable');
      try {
        return await application.evaluate(async ({ webContents }, input) => {
          const contents = webContents.fromId(input.id);
          if (!contents || contents.isDestroyed()) throw new Error('Hermes WebContents was destroyed');
          const expression = `(() => fetch(${JSON.stringify('/__opc_nexus/project/')}${' + '}${JSON.stringify(input.operation)}, {
            method: ${JSON.stringify(input.hasPayload ? 'POST' : 'GET')},
            credentials: 'include',
            ${input.hasPayload ? `headers: {'content-type':'application/json'}, body: ${JSON.stringify(JSON.stringify(input.payload))},` : ''}
          }).then(async response => ({ status: response.status, body: await response.json() })))()`;
          return contents.executeJavaScript(expression, true);
        }, { id, operation, payload, hasPayload: payload !== undefined });
      } catch (error) {
        const message = String(error?.message || error);
        if (retried && !isTransientHermesContextError(error)) throw error;
        if (!isTransientHermesContextError(error)) throw error;
        retried = true;
        hermesContentsId = null;
      }
    }
  };

  try {
    page = await application.firstWindow({ timeout: 60_000 });
    page.on('console', (message) => {
      if (message.type() === 'error') report.consoleErrors.push(safeText(`console: ${message.text()}`));
    });
    page.on('pageerror', (error) => report.consoleErrors.push(safeText(`page: ${error.message}`)));
    await page.locator('.app-shell').waitFor({ timeout: 30_000 });
    await page.setViewportSize({ width: 1440, height: 940 });
    embeddedBounds = await readCurrentEmbeddedBounds();

    await application.evaluate(({ dialog }, selectedDirectory) => {
      const original = dialog.showOpenDialog.bind(dialog);
      dialog.showOpenDialog = async (...args) => {
        const options = args[args.length - 1];
        if (options && Array.isArray(options.properties) && options.properties.includes('openDirectory')) {
          return { canceled: false, filePaths: [selectedDirectory] };
        }
        return original(...args);
      };
    }, workspace);

    await step('调试模式启用', async () => {
      const status = await page.evaluate(() => window.aibox.setDebugMode(true));
      if (!status.enabled || !status.currentFile) throw new Error('Debug log did not become active');
      return status;
    });

    const provider = await step('Provider safeStorage 配置', async () => {
      if (baseUrl && apiKey) {
        return page.evaluate((input) => window.aibox.createProvider(input), {
          name: '真实验收中转站', baseUrl, model: 'gpt-4o-mini', apiKey, isDefault: true
        });
      }
      const existing = await page.evaluate(() => window.aibox.listProviders());
      const selected = existing.find((item) => item.isDefault && item.hasKey)
        || existing.find((item) => item.hasKey);
      if (!selected) throw new Error('Seed user data has no usable Provider');
      report.provider.baseUrl = selected.baseUrl;
      return selected;
    });

    const modelResult = await step('一键读取上游模型列表', async () => {
      const result = await page.evaluate((id) => window.aibox.fetchProviderModels(id), provider.id);
      if (!result.ok || result.models.length === 0) throw new Error(result.error || 'Provider returned no models');
      const selected = chooseModels(result.models);
      report.provider.modelCount = result.models.length;
      report.provider.defaultModel = selected.defaultModel;
      report.provider.projectModel = selected.projectModel;
      return { count: result.models.length, sample: result.models.slice(0, 12), ...selected };
    });

    await step('手动模型选择与 Provider 连通', async () => {
      await page.evaluate(({ id, model }) => window.aibox.updateProvider(id, { model }), {
        id: provider.id, model: modelResult.defaultModel
      });
      const result = await page.evaluate((id) => window.aibox.testProviderById(id), provider.id);
      if (!result.ok) throw new Error(result.error || 'Provider connection test failed');
      report.provider.reachable = true;
      return result;
    });

    const engineProbe = await step('Nexus 执行引擎绑定真实 Provider', async () => {
      await page.evaluate(({ providerId, model }) => window.aibox.saveEngineConfig('eng-nexus', {
        runArgs: [], env: {}, maxConcurrency: 3, providerMode: 'managed', providerId,
        modelOverride: model, protocol: 'openai-chat'
      }), { providerId: provider.id, model: modelResult.projectModel });
      const result = await page.evaluate(() => window.aibox.authEngine('eng-nexus'));
      if (!result.ok) throw new Error(result.message);
      return result;
    });

    const agents = await step('创建三种记忆策略的独立数字员工', async () => page.evaluate(async () => {
      const base = {
        systemPrompt: '只执行收到的真实任务，不虚构结果。', engineId: 'eng-nexus', workspace: '',
        permissionMode: 'standard', concurrencyLimit: 1, channelIds: []
      };
      const created = [];
      created.push(await window.aibox.createAgent({ ...base, name: '验收研究员', role: '研究与事实核查', memoryMode: 'long_term' }));
      created.push(await window.aibox.createAgent({ ...base, name: '验收文案员', role: '简短商业文案', memoryMode: 'short_term' }));
      created.push(await window.aibox.createAgent({ ...base, name: '验收校对员', role: '单次校对，不保留历史', memoryMode: 'none' }));
      const configured = [];
      for (const agent of created) {
        configured.push(await window.aibox.updateAgentPersona(agent.id, {
          capabilities: { network: true, browser: true }
        }));
      }
      return configured.map((agent) => ({
        id: agent.id, name: agent.name, engineId: agent.engineId,
        lifecycle: agent.lifecycle, memoryMode: agent.memoryMode, capabilities: agent.capabilities
      }));
    }));

    project = await step('创建动态组队项目', async () => page.evaluate(() => window.aibox.createProject({
      name: '真实业务闭环验收',
      objective: '验证老板下令、Hermes 调度、数字员工执行与移动监管',
      description: '验收项目，不绑定固定员工池；由 Hermes 按任务选择员工。',
      status: 'active',
      workspaceMode: 'custom'
    })));

    await step('选择 Hermes 与项目级模型', async () => page.evaluate(({ projectId, model }) =>
      window.aibox.saveQuestSettings(projectId, {
        mode: 'quest', orchestrator: 'hermes', sandbox: 'workspace', permissionMode: 'standard',
        model, workerAgentIds: [], pluginIds: [], maxParallel: 3, autoApproveLowRisk: false
      }), { projectId: project.id, model: modelResult.projectModel }));

    const embedded = await step('启动嵌入式 Hermes Workbench', async () => {
      try {
        await page.evaluate(({ projectId, bounds }) => window.aibox.openEmbeddedHermesWorkbench({
          projectId, bounds, theme: 'dark'
        }), { projectId: project.id, bounds: embeddedBounds });
      } catch (error) {
        if (!/Quest embedded Workbench request was superseded/i.test(String(error?.message || error))) throw error;
      }
      const status = await waitFor(async () => {
        const current = await page.evaluate(() => window.aibox.getEmbeddedHermesWorkbenchStatus());
        return current.attached ? current : null;
      }, 60_000, 'Hermes embedded Workbench attachment');
      const runtime = await waitFor(async () => {
        const current = await page.evaluate((projectId) => window.aibox.getHermesRuntimeStatus(projectId), project.id);
        if (current.state === 'error' || current.state === 'stopped') {
          throw new Error(current.lastError || `Hermes runtime entered ${current.state}`);
        }
        return current.state === 'healthy' ? current : null;
      }, 120_000, 'Hermes execution Gateway health');
      return { ...status, runtime };
    });

    await step('项目模型真实写入 Hermes Runtime', async () => {
      const configPath = path.join(userData, 'aibox-data', 'hermes', 'projects', project.id, 'config.yaml');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.model?.default !== modelResult.projectModel) {
        throw new Error(`Expected ${modelResult.projectModel}, found ${config.model?.default || 'empty'}`);
      }
      if (apiKey && fs.readFileSync(configPath, 'utf8').includes(apiKey)) throw new Error('Provider key leaked into Hermes config');
      return { configPath, model: config.model.default, provider: config.model.provider };
    });

    hermesContentsId = await step('定位 Hermes 嵌入 WebContents', async () => {
      hermesProxyPort = embedded.runtime.proxyPort;
      const id = await waitFor(async () => application.evaluate(({ webContents }, port) => {
        const match = webContents.getAllWebContents().find((contents) => {
          try { return new URL(contents.getURL()).port === String(port); } catch { return false; }
        });
        return match?.id || null;
      }, embedded.runtime.proxyPort), 20_000, 'Hermes WebContents');
      return id;
    });

    const darkVisual = await step('Hermes 中文、暗色主题与可用聊天界面', async () => {
      const value = await waitFor(async () => {
        const state = await application.evaluate(async ({ webContents }, id) => {
          const contents = webContents.fromId(id);
          if (!contents) return null;
          return contents.executeJavaScript(`(() => {
          const input = document.querySelector('textarea[placeholder="给 Hermes 下达任务"]');
          const style = getComputedStyle(document.documentElement);
          const bodyText = document.body.innerText;
          return {
            lang: document.documentElement.lang,
            theme: document.documentElement.dataset.theme,
            hostTheme: window.__OPC_NEXUS_THEME__,
            locale: localStorage.getItem('hermes-locale'),
            pathname: location.pathname,
            background: style.getPropertyValue('--background-base').trim(),
            inputVisible: Boolean(input && input.getBoundingClientRect().width > 0 && input.getBoundingClientRect().height > 0),
            loadingChat: bodyText.includes('Loading chat...'),
            body: bodyText.slice(0, 500)
          };
          })()`, true);
        }, hermesContentsId);
        return state?.inputVisible && !state.loadingChat ? state : null;
      }, 20_000, 'Hermes chat input');
      if (value.lang !== 'zh' && value.lang !== 'zh-CN') throw new Error(`Unexpected language ${value.lang}`);
      if (value.locale !== 'zh' || value.theme !== 'dark' || value.hostTheme !== 'dark' || value.pathname !== '/chat') {
        throw new Error(`Unexpected Hermes UI state: ${JSON.stringify(value)}`);
      }
      if (!value.inputVisible || value.loadingChat) throw new Error(`Hermes chat is not usable: ${JSON.stringify(value)}`);
      const png = await application.evaluate(async ({ webContents }, id) => {
        const contents = webContents.fromId(id);
        const image = await contents.capturePage();
        return image.toPNG().toString('base64');
      }, hermesContentsId);
      const bytes = Buffer.from(png, 'base64');
      const luminance = await meanLuminance(bytes);
      if (bytes.length < 1_024 || luminance >= 100) throw new Error(`Hermes dark screenshot is invalid (luminance ${luminance.toFixed(1)})`);
      fs.writeFileSync(hermesDarkScreenshotPath, bytes);
      report.screenshots.push(hermesDarkScreenshotPath);
      return { ...value, screenshotPath: hermesDarkScreenshotPath, bytes: bytes.length, luminance };
    });

    const simpleTurn = await step('Hermes 简单需求直达', async () => {
      const response = await projectRequest('chat-turn', {
        message: '这是简单需求，不要规划也不要调用工具。请用一句简体中文回复：已收到真实业务闭环验收项目。'
      });
      if (response.status !== 200 || !response.body?.ok || !response.body.result?.content) {
        throw new Error(response.body?.error || `Hermes chat failed (${response.status})`);
      }
      return {
        conversationId: response.body.result.conversationId,
        model: response.body.result.runtime?.model,
        content: response.body.result.content,
        usage: response.body.result.usage
      };
    });

    await step('Hermes 同会话消息队列与 WebSocket 流式输出', async () => {
      await application.evaluate(async ({ webContents }, id) => {
        const contents = webContents.fromId(id);
        if (!contents) throw new Error('Hermes WebContents is unavailable');
        return contents.executeJavaScript(`new Promise((resolve, reject) => {
          window.__OPC_NEXUS_ACCEPTANCE_EVENTS__ = [];
          const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
          const socket = new WebSocket(protocol + '//' + location.host + '/__opc_nexus/project/events');
          socket.addEventListener('message', (event) => {
            try { window.__OPC_NEXUS_ACCEPTANCE_EVENTS__.push(JSON.parse(String(event.data))); } catch {}
          });
          socket.addEventListener('open', () => resolve(true), { once: true });
          socket.addEventListener('error', () => reject(new Error('project event WebSocket failed')), { once: true });
        })`, true);
      }, hermesContentsId);

      const first = await projectRequest('enqueue-chat-turn', {
        conversationId: simpleTurn.conversationId,
        message: '不要调用工具。用一句简体中文回复：队列任务一已处理。'
      });
      const second = await projectRequest('enqueue-chat-turn', {
        conversationId: simpleTurn.conversationId,
        message: '不要调用工具。用一句简体中文回复：队列任务二已处理。'
      });
      if (first.status !== 200 || second.status !== 200 || !first.body?.ok || !second.body?.ok) {
        throw new Error(`Hermes queue rejected a message: ${JSON.stringify({ first, second })}`);
      }
      const immediate = await projectRequest('chat-queue');
      const queuedIds = new Set((immediate.body?.result ?? []).map((item) => item.id));
      if (!queuedIds.has(first.body.result.id) || !queuedIds.has(second.body.result.id)) {
        throw new Error('Both messages were not accepted before the first turn completed');
      }
      await waitFor(async () => {
        const current = await projectRequest('chat-queue');
        const ids = new Set((current.body?.result ?? []).map((item) => item.id));
        return !ids.has(first.body.result.id) && !ids.has(second.body.result.id);
      }, 180_000, 'Hermes queued turn completion');
      const events = await application.evaluate(async ({ webContents }, id) => {
        const contents = webContents.fromId(id);
        return contents?.executeJavaScript('window.__OPC_NEXUS_ACCEPTANCE_EVENTS__ || []', true) ?? [];
      }, hermesContentsId);
      const deltas = events.filter((event) => event.type === 'chat.queue.delta');
      if (deltas.length === 0) throw new Error('No streaming delta arrived through the project WebSocket');
      return {
        first: { id: first.body.result.id, initialStatus: first.body.result.status },
        second: { id: second.body.result.id, initialStatus: second.body.result.status },
        immediateQueueSize: immediate.body.result.length,
        websocketDeltaCount: deltas.length
      };
    });

    const conversationEvidence = await step('Hermes 多 Tab 与员工独立会话', async () => {
      const created = [];
      for (const agent of agents) {
        const response = await projectRequest('create-conversation', { employeeId: agent.id });
        if (response.status !== 200 || !response.body?.ok) throw new Error(response.body?.error || 'Conversation creation failed');
        created.push(response.body.result);
      }
      const listed = await projectRequest('conversations');
      if (!listed.body?.ok || listed.body.result.length < 4) throw new Error('Independent conversation tabs were not persisted');
      return {
        created: created.map((item) => ({ conversationId: item.conversationId, employee: item.employee })),
        total: listed.body.result.length
      };
    });

    const employeeTask = await step('Hermes @数字员工真实派工', async () => {
      const before = await page.evaluate(() => window.aibox.getSnapshot());
      const beforeIds = new Set(before.tasks.map((task) => task.id));
      const writerConversation = conversationEvidence.created.find((item) => item.employee.id === agents[1].id);
      if (!writerConversation) throw new Error('Writer employee conversation is unavailable');
      const queuedTurn = await projectRequest('enqueue-chat-turn', {
        conversationId: writerConversation.conversationId,
        message: '@验收文案员 请把这个简单任务真实派给该数字员工：写一句不超过20字的项目验收标题，并调用 write_file 把标题写入 deliverables/acceptance-title.md。必须调用 nexus_delegate_task，expectedArtifacts 必须为 ["deliverables/acceptance-title.md"]；不要自己代写，不要虚构任务完成。'
      });
      if (queuedTurn.status !== 200 || !queuedTurn.body?.ok || !queuedTurn.body.result?.id) {
        throw new Error(queuedTurn.body?.error || 'Hermes employee dispatch turn was not queued');
      }
      const dispatchState = await waitFor(async () => {
        const queue = await projectRequest('chat-queue');
        const queuedItem = Array.isArray(queue.body?.result)
          ? queue.body.result.find((item) => item.id === queuedTurn.body.result.id)
          : null;
        if (queuedItem?.status === 'FAILED') {
          return { kind: 'failed', error: queuedItem.error || 'Hermes employee dispatch turn failed without an error' };
        }
        const snapshot = await page.evaluate(() => window.aibox.getSnapshot());
        const task = snapshot.tasks.find((item) => !beforeIds.has(item.id) && item.projectId === project.id);
        return task ? { kind: 'task', task } : null;
      }, 90_000, 'Hermes employee task creation');
      if (dispatchState.kind === 'failed') {
        throw new Error(`Hermes employee dispatch turn failed: ${dispatchState.error}`);
      }
      const task = dispatchState.task;
      const approved = [];
      const terminal = await waitFor(async () => {
        const snapshot = await page.evaluate(() => window.aibox.getSnapshot());
        const current = snapshot.tasks.find((item) => item.id === task.id);
        const pending = snapshot.approvals.filter((item) => item.taskId === task.id && item.status === 'pending');
        for (const approval of pending) {
          await page.evaluate((id) => window.aibox.decideApproval(id, true), approval.id);
          approved.push({ id: approval.id, type: approval.type, risk: approval.risk });
        }
        return current && ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(current.status) ? current : null;
      }, 180_000, 'Hermes employee task completion');
      if (terminal.status !== 'COMPLETED') throw new Error(`Employee task ended as ${terminal.status}: ${terminal.error || ''}`);
      const artifactPath = path.join(workspace, 'deliverables', 'acceptance-title.md');
      if (!fs.existsSync(artifactPath) || fs.statSync(artifactPath).size === 0) {
        throw new Error('Employee task completed without the expected delivery file');
      }
      await waitFor(async () => {
        const current = await projectRequest('chat-queue');
        return Array.isArray(current.body?.result)
          && !current.body.result.some((item) => item.id === queuedTurn.body.result.id);
      }, 180_000, 'Hermes employee dispatch turn completion');
      const history = await projectRequest('chat-history', { conversationId: writerConversation.conversationId });
      const hermesReply = [...(history.body?.result?.messages ?? [])]
        .reverse()
        .find((message) => message.role === 'assistant')?.content || '';
      if (!hermesReply) throw new Error('Hermes employee dispatch reply was not persisted');
      return {
        taskId: terminal.id,
        agentId: terminal.agentId,
        status: terminal.status,
        result: terminal.result,
        queuedTurnId: queuedTurn.body.result.id,
        hermesReply,
        approved,
        artifactPath,
        artifact: fs.readFileSync(artifactPath, 'utf8')
      };
    });

    const complexDelivery = await step('复杂任务澄清、计划、批准、DAG 派工与真实交付', async () => {
      const before = await page.evaluate(() => window.aibox.getSnapshot());
      const beforeIds = new Set(before.tasks.map((task) => task.id));
      const researchAgent = agents[0];
      const writerAgent = agents[1];
      const request = await projectRequest('chat-turn', {
        conversationId: simpleTurn.conversationId,
        message: [
          '这是一个复杂任务：制作一个可在本机启动预览的单页工作室官网。',
          '本轮必须先且只调用 clarify，询问老板首页主行动按钮应使用“预约咨询”还是“查看案例”；不要在本轮提交计划。',
          '老板回答后必须调用 nexus_submit_plan，且只能使用以下真实员工：',
          `研究节点使用 ${researchAgent.id}（${researchAgent.name}），写入 deliverables/site-research.md。`,
          `实现节点使用 ${writerAgent.id}（${writerAgent.name}），依赖研究节点，读取研究结果并创建 web/index.html、web/package.json、web/server.cjs。`,
          'DAG 中研究节点 expectedArtifacts 只能是 ["deliverables/site-research.md"]；实现节点 expectedArtifacts 只能是 ["web/index.html","web/package.json","web/server.cjs"]。每个计划产物必须恰好归属一个节点。',
          'package.json 必须包含 preview 脚本：node server.cjs；server.cjs 只使用 Node 内置 http，在 127.0.0.1 的随机端口监听，并输出完整 http://127.0.0.1:<port>/ 地址。',
          '官网必须显示 OPC-Nexus Studio、老板选择的行动按钮和三个真实服务区块。不要声称批准或完成。'
        ].join('\n')
      });
      if (request.status !== 200 || !request.body?.ok) {
        throw new Error(request.body?.error || `Complex Hermes turn failed (${request.status})`);
      }
      const clarification = await waitFor(async () => {
        const state = await projectRequest('state');
        return state.body?.result?.clarifications?.find((item) => item.conversationId === simpleTurn.conversationId) || null;
      }, 90_000, 'Hermes clarification');
      const answered = await projectRequest('answer-clarify', {
        clarifyId: clarification.clarifyId,
        answer: '预约咨询。只做本机预览，不发布到公网。'
      });
      if (answered.status !== 200 || !answered.body?.ok || answered.body.result?.status !== 'ANSWERED') {
        throw new Error(answered.body?.error || 'Hermes clarification answer was not persisted');
      }
      const plan = await waitFor(async () => {
        const state = await projectRequest('state');
        return state.body?.result?.plans?.find((item) => item.status === 'PROJECTED') || null;
      }, 180_000, 'Hermes projected plan');
      if (!Number.isInteger(plan.version) || plan.version < 1 || !/^[a-f0-9]{64}$/.test(plan.hash)) {
        throw new Error(`Hermes plan has invalid host identity: ${JSON.stringify(plan)}`);
      }
      const approvedPlan = await projectRequest('approve-plan', { draftId: plan.draftId });
      if (approvedPlan.status !== 200 || approvedPlan.body?.result?.status !== 'APPROVED') {
        throw new Error(approvedPlan.body?.error || 'Hermes plan approval failed');
      }
      const dispatchedPlan = await projectRequest('dispatch-plan', { draftId: plan.draftId });
      if (dispatchedPlan.status !== 200 || dispatchedPlan.body?.result?.status !== 'DISPATCHED') {
        throw new Error(dispatchedPlan.body?.error || 'Hermes plan dispatch failed');
      }
      const planTasks = await waitFor(async () => {
        const snapshot = await page.evaluate(() => window.aibox.getSnapshot());
        const created = snapshot.tasks.filter((task) => !beforeIds.has(task.id) && task.projectId === project.id);
        return created.length >= 2 ? created : null;
      }, 30_000, 'Hermes plan tasks');
      const selectedWorkers = new Set(planTasks.map((task) => task.agentId));
      if (!selectedWorkers.has(researchAgent.id) || !selectedWorkers.has(writerAgent.id)) {
        throw new Error(`Hermes plan did not dispatch both selected employees: ${JSON.stringify(planTasks)}`);
      }
      const approvals = [];
      const terminals = await waitFor(async () => {
        const snapshot = await page.evaluate(() => window.aibox.getSnapshot());
        const current = snapshot.tasks.filter((task) => planTasks.some((planned) => planned.id === task.id));
        for (const approval of snapshot.approvals.filter((item) => (
          current.some((task) => task.id === item.taskId) && item.status === 'pending'
        ))) {
          await page.evaluate((id) => window.aibox.decideApproval(id, true), approval.id);
          approvals.push({ id: approval.id, taskId: approval.taskId, type: approval.type, risk: approval.risk });
        }
        return current.length === planTasks.length && current.every((task) => (
          ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(task.status)
        )) ? current : null;
      }, 360_000, 'Hermes plan task completion');
      const failed = terminals.filter((task) => task.status !== 'COMPLETED');
      if (failed.length > 0) throw new Error(`Hermes plan tasks failed: ${JSON.stringify(failed)}`);
      const manifests = [];
      for (const task of terminals) {
        const manifest = await page.evaluate((taskId) => window.aibox.getTaskManifest(taskId), task.id);
        if (!manifest || manifest.validation?.status !== 'verified' || manifest.entries.length === 0) {
          throw new Error(`Task ${task.id} completed without a verified delivery manifest`);
        }
        manifests.push({ task, manifest });
      }
      const runnable = manifests.find((item) => item.manifest.entries.some((entry) => entry.run));
      if (!runnable) throw new Error('Complex delivery has no verified runnable package script');
      const runtimeStart = await page.evaluate((taskId) => window.aibox.runArtifactCommand(taskId), runnable.task.id);
      if (!runtimeStart.ok || !runtimeStart.runtime) {
        throw new Error(runtimeStart.error || 'Artifact runtime did not start');
      }
      const runtime = await waitFor(async () => {
        const current = await page.evaluate((taskId) => window.aibox.getArtifactRuntimeStatus(taskId), runnable.task.id);
        if (current?.state === 'FAILED' || current?.state === 'EXITED') {
          throw new Error(current.error || `Artifact runtime ended as ${current.state}`);
        }
        return current?.state === 'RUNNING' && current.url
          && (current.screenshots.length >= 2 || current.screenshotError)
          ? current
          : null;
      }, 90_000, 'artifact runtime and screenshots');
      if (runtime.screenshotError || runtime.screenshots.length < 2) {
        throw new Error(runtime.screenshotError || 'Artifact runtime did not produce desktop and mobile screenshots');
      }
      const preview = await readUrl(runtime.url);
      const serviceCount = [...preview.text.matchAll(/class=["']([^"']*)["']/g)]
        .filter((match) => match[1].split(/\s+/).some((name) => name === 'service-card' || name === 'card'))
        .length;
      const previewMeetsAcceptance = preview.status === 200
        && preview.text.includes('OPC-Nexus Studio')
        && preview.text.includes('预约咨询')
        && serviceCount >= 3;

      const reviewer = agents[2];
      const beforeValidation = await page.evaluate(() => window.aibox.getSnapshot());
      const beforeValidationIds = new Set(beforeValidation.tasks.map((task) => task.id));
      const implementationTaskIds = terminals.map((task) => task.id);
      let validationTrigger = null;
      if (autoValidation) {
        validationTrigger = { mode: 'main-auto-acceptance', marker: '[OPC-NEXUS-AUTO-VALIDATION]' };
      } else {
        const validationDispatch = await projectRequest('chat-turn', {
          conversationId: simpleTurn.conversationId,
          message: [
            '你是本项目的主秘书。实现员工已经结束，现在必须问询另一名未参与实现的数字员工做独立验收，不能自己验收，也不能先宣布完成。',
            `只调用一次 nexus_delegate_task，workerAgentId 必须是 ${reviewer.id}（${reviewer.name}）。`,
            'intent 必须是 validation，expectedArtifacts 必须是 []，不要要求校对员新建验收报告文件。',
            `relatedTaskIds 必须是 ${JSON.stringify(implementationTaskIds)}。`,
            '验收标准：真实预览 HTTP 200；页面显示 OPC-Nexus Studio；主行动按钮精确显示“预约咨询”；至少三个内容不同的真实服务卡片（CSS 类名可为 card 或 service-card，以 DOM 结构和可见内容为准）；交付清单、启动命令、桌面和手机截图均真实可用。',
            `真实预览地址是 ${runtime.url}，截图是 ${runtime.screenshots.join('、')}。`,
            '该地址中的端口是宿主启动进程后读取到的真实随机端口，随机端口本身不是失败。必须先使用 http_request 对这个精确 URL 发起 GET，再使用 browser_navigate 打开同一 URL 并用 browser_get_content 检查真实 DOM；不要委派一个名为 browser 的虚构员工。',
            'deliverables/acceptance-title.md 属于更早的独立简单任务，不是本次官网交付清单，不得用它否决本次相关任务。',
            '要求校对员检查项目目录、相关任务交付和可访问的运行证据，并以 PASS、FAIL 或 BLOCKED 开头返回事实和证据。',
            '收到真实任务回执后，本轮只说明已派发和任务 ID，不要代替校对员给结论。'
          ].join('\n')
        });
        if (validationDispatch.status !== 200 || !validationDispatch.body?.ok) {
          throw new Error(validationDispatch.body?.error || 'Secretary failed to dispatch independent validation');
        }
        validationTrigger = { mode: 'owner-requested', queueId: validationDispatch.body.result?.id || null };
      }
      const validationTasks = await waitFor(async () => {
        const snapshot = await page.evaluate(() => window.aibox.getSnapshot());
        const matches = snapshot.tasks.filter((task) => (
          !beforeValidationIds.has(task.id)
          && task.projectId === project.id
          && task.agentId === reviewer.id
          && String(task.content || '').startsWith('Task intent: validation')
        ));
        return matches.length > 0 ? matches : null;
      }, autoValidation ? 180_000 : 90_000, 'secretary independent validation dispatch');
      if (validationTasks.some((task) => implementationTaskIds.includes(task.id))
        || terminals.some((task) => validationTasks.some((validationTask) => task.agentId === validationTask.agentId))) {
        throw new Error('Secretary validation was not assigned to an independent employee');
      }
      const validationApprovals = [];
      const validationTerminals = await waitFor(async () => {
        const snapshot = await page.evaluate(() => window.aibox.getSnapshot());
        // A model may call nexus_delegate_task more than once in one secretary
        // turn. All newly-created validation tasks belong to this acceptance
        // attempt; approve and wait for every one so a duplicate cannot leave
        // the workflow permanently parked in WAITING_APPROVAL/QUEUED.
        const current = snapshot.tasks.filter((task) => validationTasks.some((validationTask) => task.id === validationTask.id));
        for (const approval of snapshot.approvals.filter((item) => (
          current.some((task) => task.id === item.taskId) && item.status === 'pending'
        ))) {
          await page.evaluate((id) => window.aibox.decideApproval(id, true), approval.id);
          validationApprovals.push({ id: approval.id, taskId: approval.taskId, type: approval.type, risk: approval.risk });
        }
        return current.length > 0 && current.every((task) => ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(task.status))
          ? current
          : null;
      }, 240_000, 'independent validation completion');
      const failedValidation = validationTerminals.filter((task) => task.status !== 'COMPLETED');
      if (failedValidation.length > 0) {
        throw new Error(`Independent validation ended unsuccessfully: ${JSON.stringify(failedValidation)}`);
      }
      const validationEvents = [];
      for (const validationTerminal of validationTerminals) {
        validationEvents.push(...await page.evaluate((taskId) => window.aibox.getTaskEvents(taskId), validationTerminal.id));
      }
      const validationToolNames = validationEvents
        .filter((event) => event.eventType === 'tool_call')
        .map((event) => String(event.payload?.name || ''));
      for (const requiredTool of ['http_request', 'browser_navigate', 'browser_get_content']) {
        if (!validationToolNames.includes(requiredTool)) {
          throw new Error(`Independent validator did not perform required tool check: ${requiredTool}`);
        }
      }
      const expectedVerdict = previewMeetsAcceptance ? 'PASS' : 'FAIL';

      const logPath = path.join(userData, 'aibox-data', 'hermes', 'projects', project.id, 'logs', 'agent.log');
      const logOffset = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
      let validationSummary = null;
      let secretaryContent = '';
      if (autoValidation) {
        // The initial automatic secretary turn may still be finishing while
        // Main queues the status follow-up. Wait for that exact durable queue
        // item to appear and leave the queue before reading chat history;
        // otherwise the initial PASS races the authoritative status turn.
        const statusMarker = '[OPC-NEXUS-AUTO-VALIDATION-STATUS]';
        const beforeSummary = await projectRequest('chat-history', { conversationId: simpleTurn.conversationId });
        const beforeMessages = Array.isArray(beforeSummary.body?.result?.messages)
          ? beforeSummary.body.result.messages
          : [];
        const beforeMessageCount = beforeMessages.length;
        let statusTurnSeen = false;
        await waitFor(async () => {
          const current = await projectRequest('chat-queue');
          const item = (current.body?.result ?? []).find((entry) => String(entry.message || '').includes(statusMarker));
          if (!item) return null;
          statusTurnSeen = true;
          if (item.status === 'FAILED') throw new Error(item.error || 'Automatic validation status follow-up failed');
          return item;
        }, 180_000, 'automatic secretary status follow-up queued');
        await waitFor(async () => {
          const current = await projectRequest('chat-queue');
          const item = (current.body?.result ?? []).find((entry) => String(entry.message || '').includes(statusMarker));
          if (item) {
            if (item.status === 'FAILED') throw new Error(item.error || 'Automatic validation status follow-up failed');
            return null;
          }
          return statusTurnSeen ? { completed: true } : null;
        }, 300_000, 'automatic secretary status follow-up completion');
        const history = await waitFor(async () => {
          const current = await projectRequest('chat-history', { conversationId: simpleTurn.conversationId });
          const messages = current.body?.result?.messages ?? [];
          const assistant = messages.slice(beforeMessageCount).reverse().find((message) => (
            message.role === 'assistant' && /validationVerdict|验收结论|验收通过|PASS|FAIL|BLOCKED/i.test(String(message.content || ''))
          ));
          return assistant ? current : null;
        }, 240_000, 'automatic secretary validation summary');
        secretaryContent = [...(history.body?.result?.messages ?? []).slice(beforeMessageCount)]
          .reverse()
          .find((message) => message.role === 'assistant' && /validationVerdict|验收结论|验收通过|PASS|FAIL|BLOCKED/i.test(String(message.content || '')))?.content || '';
        validationSummary = { status: 200, body: { ok: true, result: { content: secretaryContent } } };
      } else {
        const validationTerminal = validationTerminals[validationTerminals.length - 1];
        validationSummary = await projectRequest('chat-turn', {
          conversationId: simpleTurn.conversationId,
          message: [
            `独立验收员工的任务 ID 是 ${validationTerminal.id}。`,
            '你仍然是主秘书。现在必须调用 nexus_task_status，waitSeconds 设为 0，读取该任务的权威终态和 validationVerdict。',
            '只能根据工具回执汇总 PASS、FAIL 或 BLOCKED；validationVerdict 不是 PASS 时不得宣称交付完成；不要重新派发任务。'
          ].join('\n')
        });
        if (validationSummary.status !== 200 || !validationSummary.body?.ok) {
          throw new Error(validationSummary.body?.error || 'Secretary failed to query the validation employee');
        }
        secretaryContent = String(validationSummary.body.result?.content || '');
      }
      const secretaryVerdict = /\b(PASS|FAIL|BLOCKED)\b/i.exec(secretaryContent)?.[1]?.toUpperCase();
      if (secretaryVerdict !== expectedVerdict) {
        throw new Error(`Secretary did not aggregate the authoritative ${expectedVerdict} verdict: ${validationSummary.body.result?.content || ''}`);
      }
      const statusLog = fs.existsSync(logPath)
        ? fs.readFileSync(logPath).subarray(logOffset).toString('utf8')
        : '';
      if (!statusLog.includes('nexus_task_status')) {
        throw new Error('Secretary response did not call nexus_task_status');
      }
      if (statusLog.includes('Tool nexus_task_status returned error')) {
        throw new Error(`nexus_task_status was falsely classified as an error: ${safeText(statusLog)}`);
      }
      const stopped = await page.evaluate((taskId) => window.aibox.stopArtifactRuntime(taskId), runnable.task.id);
      if (!stopped.ok || stopped.runtime?.state !== 'STOPPED') {
        throw new Error(stopped.error || 'Artifact runtime did not stop cleanly');
      }
      return {
        clarification: { id: clarification.clarifyId, prompt: clarification.prompt, answer: answered.body.result.status },
        plan: { draftId: plan.draftId, planId: plan.planId, version: plan.version, hash: plan.hash },
        tasks: terminals.map((task) => ({ id: task.id, agentId: task.agentId, status: task.status })),
        approvals,
        manifests: manifests.map((item) => ({
          taskId: item.task.id,
          files: item.manifest.entries.map((entry) => ({ relativePath: entry.relativePath, sha256: entry.sha256, run: entry.run }))
        })),
        runtime: { command: runtime.command, url: runtime.url, screenshots: runtime.screenshots },
        preview: { status: preview.status, contentType: preview.contentType, serviceCount, meetsAcceptance: previewMeetsAcceptance },
        independentValidation: {
          taskId: validationTerminals.at(-1)?.id,
          taskIds: validationTerminals.map((task) => task.id),
          agentId: validationTerminals.at(-1)?.agentId,
          implementationTaskIds,
          verdict: secretaryVerdict,
          secretaryVerdict,
          approvals: validationApprovals,
          toolCalls: validationToolNames,
          secretaryReply: secretaryContent,
          validationTrigger,
          statusToolLog: safeText(statusLog, 4_000)
        }
      };
    });

    await step('固定员工池越界阻止', async () => {
      await page.evaluate(() => window.aibox.closeEmbeddedHermesWorkbench());
      await page.evaluate(({ projectId, employeeId }) => window.aibox.saveQuestSettings(projectId, {
        workerAgentIds: [employeeId]
      }), { projectId: project.id, employeeId: agents[0].id });
      const runtime = await page.evaluate((projectId) => window.aibox.getHermesRuntimeStatus(projectId), project.id);
      if (runtime.state !== 'stopped') throw new Error(`Hermes did not stop after worker-pool change: ${runtime.state}`);
      embeddedBounds = await readCurrentEmbeddedBounds();
      const reopened = await page.evaluate(({ projectId, bounds }) => window.aibox.openEmbeddedHermesWorkbench({
        projectId, bounds, theme: 'dark'
      }), { projectId: project.id, bounds: embeddedBounds });
      if (!reopened.attached || !reopened.runtime?.proxyPort) {
        throw new Error(reopened.runtime?.lastError || 'Hermes did not restart after worker-pool change');
      }
      const restartedRuntime = await waitFor(async () => {
        const current = await page.evaluate((projectId) => window.aibox.getHermesRuntimeStatus(projectId), project.id);
        if (current.state === 'error') throw new Error(current.lastError || 'Hermes restart failed');
        return current.state === 'healthy' && current.proxyPort ? current : null;
      }, 60_000, 'Hermes full health after worker-pool change');
      hermesContentsId = await waitFor(async () => application.evaluate(({ webContents }, port) => {
        const match = webContents.getAllWebContents().find((contents) => {
          try { return new URL(contents.getURL()).port === String(port); } catch { return false; }
        });
        return match?.id || null;
      }, restartedRuntime.proxyPort), 20_000, 'restarted Hermes WebContents');
      const rejected = await projectRequest('chat-turn', { message: '@验收文案员 请执行越界任务。' });
      if (rejected.status < 400 || rejected.body?.ok !== false || !String(rejected.body?.error).includes('未授权')) {
        throw new Error(`Restricted employee was not rejected: ${JSON.stringify(rejected)}`);
      }
      return { status: rejected.status, error: rejected.body.error };
    });

    await step('Hermes 手机 Chat 同源配对与会话权限', async () => {
      const lanPort = await reservePort();
      const offer = await page.evaluate(({ projectId, port }) => window.aibox.createHermesMobilePairing(projectId, {
        bindHost: '127.0.0.1', port, publicHost: '127.0.0.1'
      }), { projectId: project.id, port: lanPort });
      const paired = await httpsJson(`${offer.origin}/api/v1/auth/pair`, {
        method: 'POST',
        headers: { Origin: offer.origin, 'Sec-Fetch-Site': 'same-origin' },
        body: { code: offer.code }
      });
      if (paired.status !== 200) throw new Error(`Hermes mobile pairing failed: ${paired.status} ${paired.text}`);
      const cookie = pairingCookies(paired.headers);
      const state = await httpsJson(`${offer.origin}/__opc_nexus/project/state`, { headers: { Cookie: cookie } });
      if (state.status !== 200 || state.json?.result?.projectId !== project.id) {
        throw new Error(`Hermes mobile project state failed: ${state.status} ${state.text}`);
      }
      const conversations = await httpsJson(`${offer.origin}/__opc_nexus/project/conversations`, {
        headers: { Cookie: cookie }
      });
      if (conversations.status !== 200 || !Array.isArray(conversations.json?.result)) {
        throw new Error(`Hermes mobile conversations failed: ${conversations.status} ${conversations.text}`);
      }
      const conversationId = conversations.json.result[0]?.conversationId;
      if (!conversationId) throw new Error('Hermes mobile has no project conversation');
      const history = await httpsJson(`${offer.origin}/__opc_nexus/project/chat-history`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: offer.origin, 'Sec-Fetch-Site': 'same-origin' },
        body: { conversationId }
      });
      if (history.status !== 200 || history.json?.result?.conversationId !== conversationId) {
        throw new Error(`Hermes mobile chat history failed: ${history.status} ${history.text}`);
      }
      const queued = await httpsJson(`${offer.origin}/__opc_nexus/project/enqueue-chat-turn`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: offer.origin, 'Sec-Fetch-Site': 'same-origin' },
        body: {
          conversationId,
          message: '不要调用工具。请只回复：手机端真实消息已收到。'
        }
      });
      if (queued.status !== 200 || !queued.json?.result?.id) {
        throw new Error(`Hermes mobile queue failed: ${queued.status} ${queued.text}`);
      }
      await waitFor(async () => {
        const queue = await httpsJson(`${offer.origin}/__opc_nexus/project/chat-queue`, { headers: { Cookie: cookie } });
        if (queue.status !== 200) throw new Error(`Hermes mobile queue status failed: ${queue.status} ${queue.text}`);
        return Array.isArray(queue.json?.result)
          && !queue.json.result.some((item) => item.id === queued.json.result.id);
      }, 180_000, 'Hermes mobile queued turn completion');
      const updatedHistory = await httpsJson(`${offer.origin}/__opc_nexus/project/chat-history`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: offer.origin, 'Sec-Fetch-Site': 'same-origin' },
        body: { conversationId }
      });
      if (updatedHistory.status !== 200 || !updatedHistory.json?.result?.messages?.some((item) => (
        item.role === 'assistant' && String(item.content).includes('手机端真实消息已收到')
      ))) {
        throw new Error(`Hermes mobile response was not persisted: ${updatedHistory.status} ${updatedHistory.text}`);
      }
      const denied = await httpsJson(`${offer.origin}/__opc_nexus/project/enqueue-chat-turn`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: 'https://evil.invalid', 'Sec-Fetch-Site': 'cross-site' },
        body: { conversationId, message: '越权请求' }
      });
      if (denied.status !== 403) throw new Error(`Cross-origin mobile request was not denied: ${denied.status}`);
      operatorMobile = { offer, cookie, conversationId };
      return {
        surface: 'hermes-chat',
        origin: offer.origin,
        pairingStatus: paired.status,
        stateStatus: state.status,
        conversationsStatus: conversations.status,
        historyStatus: history.status,
        queuedTurnId: queued.json.result.id,
        updatedHistoryStatus: updatedHistory.status,
        crossOriginStatus: denied.status,
        projectId: state.json.result.projectId
      };
    });

    await step('拒绝旧版多角色手机入口', async () => {
      const error = await page.evaluate(async (projectId) => {
        try {
          await window.aibox.createHermesMobilePairing(projectId, 'viewer');
          return '';
        } catch (reason) {
          return reason instanceof Error ? reason.message : String(reason);
        }
      }, project.id);
      if (!error) throw new Error('Legacy Viewer pairing was not rejected');
      return { rejected: true, error };
    });

    await step('Hermes 亮色主题同步与截图', async () => {
      await page.evaluate(() => window.aibox.setEmbeddedHermesWorkbenchTheme('light'));
      const state = await waitFor(async () => application.evaluate(async ({ webContents }, id) => {
        const contents = webContents.fromId(id);
        const value = await contents.executeJavaScript(`(() => {
          const style = getComputedStyle(document.documentElement);
          const nav = document.querySelector('nav a');
          const navLabel = nav?.querySelector('span');
          return {
            theme: document.documentElement.dataset.theme,
            hostTheme: window.__OPC_NEXUS_THEME__,
            background: style.getPropertyValue('--background-base').trim(),
            midground: style.getPropertyValue('--midground-base').trim(),
            navColor: nav ? getComputedStyle(nav).color : null,
            navOpacity: nav ? getComputedStyle(nav).opacity : null,
            navLabelOpacity: navLabel ? getComputedStyle(navLabel).opacity : null,
            inputVisible: Boolean(document.querySelector('textarea[placeholder="给 Hermes 下达任务"]')),
            loadingChat: document.body.innerText.includes('Loading chat...')
          };
        })()`, true);
        return value.theme === 'light' && value.hostTheme === 'light'
          && /#f7f8fa|rgb\(247,\s*248,\s*250\)/i.test(value.background)
          ? value
          : null;
      }, hermesContentsId), 10_000, 'Hermes light theme paint');
      await new Promise((resolve) => setTimeout(resolve, 500));
      const capture = await application.evaluate(async ({ webContents }, id) => {
        const contents = webContents.fromId(id);
        const stableState = await contents.executeJavaScript(`(() => {
          const style = getComputedStyle(document.documentElement);
          const nav = document.querySelector('nav a');
          const navLabel = nav?.querySelector('span');
          return {
            theme: document.documentElement.dataset.theme,
            hostTheme: window.__OPC_NEXUS_THEME__,
            background: style.getPropertyValue('--background-base').trim(),
            midground: style.getPropertyValue('--midground-base').trim(),
            navColor: nav ? getComputedStyle(nav).color : null,
            navOpacity: nav ? getComputedStyle(nav).opacity : null,
            navLabelOpacity: navLabel ? getComputedStyle(navLabel).opacity : null,
            inputVisible: Boolean(document.querySelector('textarea[placeholder="给 Hermes 下达任务"]')),
            loadingChat: document.body.innerText.includes('Loading chat...')
          };
        })()`, true);
        const image = await contents.capturePage();
        return { stableState, png: image.toPNG().toString('base64') };
      }, hermesContentsId);
      if (capture.stableState.theme !== 'light' || capture.stableState.hostTheme !== 'light'
        || !/#f7f8fa|rgb\(247,\s*248,\s*250\)/i.test(capture.stableState.background)) {
        throw new Error(`Hermes theme was not stable: ${JSON.stringify(capture.stableState)}`);
      }
      if (!capture.stableState.inputVisible || capture.stableState.loadingChat) {
        throw new Error(`Hermes chat became unavailable: ${JSON.stringify(capture.stableState)}`);
      }
      const bytes = Buffer.from(capture.png, 'base64');
      const luminance = await meanLuminance(bytes);
      if (bytes.length < 1_024 || luminance <= 170 || luminance - darkVisual.luminance <= 80) {
        throw new Error(`Hermes light screenshot is invalid (dark ${darkVisual.luminance.toFixed(1)}, light ${luminance.toFixed(1)}; ${JSON.stringify(capture.stableState)})`);
      }
      fs.writeFileSync(hermesLightScreenshotPath, bytes);
      report.screenshots.push(hermesLightScreenshotPath);
      return { ...capture.stableState, screenshotPath: hermesLightScreenshotPath, bytes: bytes.length, luminance };
    });

    await step('Quest 拒绝 DSH 成为第二调度器', async () => {
      let rejected = '';
      try {
        await page.evaluate((projectId) => window.aibox.saveQuestSettings(projectId, { orchestrator: 'dsh' }), project.id);
      } catch (error) {
        rejected = error instanceof Error ? error.message : String(error);
      }
      if (!rejected.includes('只支持 Hermes')) throw new Error(`DSH scheduler was not rejected: ${rejected || 'accepted'}`);
      const status = await page.evaluate((projectId) => window.aibox.getHermesRuntimeStatus(projectId), project.id);
      if (status.state !== 'healthy') throw new Error(`Hermes changed state after rejected DSH scheduler: ${status.state}`);
      const retired = await page.evaluate(() => ({
        retiredDshLanSurface: typeof window.aibox.startDshLanGateway,
        dshQuestPreflight: typeof window.aibox.preflightQuestProvider
      }));
      if (retired.dshLan !== 'undefined' || retired.dshQuestPreflight !== 'undefined') {
        throw new Error(`Retired DSH Quest APIs are still exposed: ${JSON.stringify(retired)}`);
      }
      return { rejected, runtimeState: status.state, retired };
    });

    await step('Hermes 停止后手机端显示项目服务离线', async () => {
      if (!operatorMobile) throw new Error('Hermes operator mobile route is unavailable');
      await page.evaluate((projectId) => window.aibox.stopHermesProject(projectId), project.id);
      const stopped = await page.evaluate((projectId) => window.aibox.getHermesRuntimeStatus(projectId), project.id);
      if (stopped.state !== 'stopped') throw new Error(`Hermes runtime did not stop: ${stopped.state}`);
      const offline = await httpsJson(`${operatorMobile.offer.origin}/__opc_nexus/project/state`, {
        headers: { Cookie: operatorMobile.cookie }
      });
      if (offline.status < 500 || offline.status > 599 || /\"ok\"\s*:\s*true/.test(offline.text)) {
        throw new Error(`Mobile route did not fail closed while Hermes was offline: ${offline.status} ${offline.text}`);
      }
      return { runtimeState: stopped.state, mobileStatus: offline.status, response: offline.text };
    });

    report.result = report.steps.some((item) => item.status === 'FAIL') ? 'FAIL' : 'PASS';
  } finally {
    if (page && project) await page.evaluate((id) => window.aibox.stopHermesMobileAccess(id), project.id).catch(() => undefined);
    if (page && project) await page.evaluate((id) => window.aibox.stopHermesProject(id), project.id).catch(() => undefined);
    if (page) await page.evaluate(() => window.aibox.setDebugMode(false)).catch(() => undefined);
    await application.close().catch(() => undefined);

    const logRoot = path.join(root, 'user', 'logs');
    const logFiles = fs.existsSync(logRoot)
      ? fs.readdirSync(logRoot).filter((name) => name.endsWith('.jsonl')).map((name) => path.join(logRoot, name))
      : [];
    const leakedFiles = apiKey
      ? logFiles.filter((file) => fs.readFileSync(file, 'utf8').includes(apiKey))
      : [];
    report.steps.push({
      name: '调试日志密钥脱敏',
      status: leakedFiles.length === 0 ? 'PASS' : 'FAIL',
      durationMs: 0,
      evidence: { logDirectory: logRoot, filesChecked: logFiles.length, leakedFiles }
    });
    if (leakedFiles.length > 0) report.result = 'FAIL';
    if (report.result === 'RUNNING') report.result = 'FAIL';
    report.completedAt = new Date().toISOString();
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  process.stdout.write(`${JSON.stringify({
    result: report.result,
    reportPath,
    evidenceRoot,
    passed: report.steps.filter((item) => item.status === 'PASS').length,
    failed: report.steps.filter((item) => item.status === 'FAIL').map((item) => ({ name: item.name, error: item.error }))
  }, null, 2)}\n`);
  if (report.result === 'FAIL') process.exitCode = 1;
}

main().catch((error) => {
  report.result = 'FAIL';
  report.fatalError = safeText(error instanceof Error ? error.stack || error.message : error);
  report.completedAt = new Date().toISOString();
  fs.mkdirSync(evidenceRoot, { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.error(safeText(error instanceof Error ? error.stack : error));
  process.exitCode = 1;
});
