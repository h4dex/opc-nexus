'use strict';

const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const evidenceRoot = path.resolve(
  process.env.AIBOX_MEMORY_ACCEPTANCE_OUTPUT
    || path.join(root, 'tmp', 'acceptance-memory-boundaries', stamp)
);
const sourceUserData = (process.env.AIBOX_MEMORY_ACCEPTANCE_SEED_USER_DATA || '').trim();
if (!sourceUserData || !fs.statSync(sourceUserData, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error('AIBOX_MEMORY_ACCEPTANCE_SEED_USER_DATA must point to a configured OPC-Nexus user-data directory');
}

const userData = path.join(evidenceRoot, 'user-data');
const reportPath = path.join(evidenceRoot, 'report.json');
const screenshotPath = path.join(evidenceRoot, 'memory-boundaries.png');
fs.mkdirSync(evidenceRoot, { recursive: true });
fs.cpSync(sourceUserData, userData, { recursive: true, force: true });

const marker = (label) => `${label}-${randomBytes(8).toString('hex').toUpperCase()}`;
const markers = {
  longTerm: marker('LT'),
  shortTerm: marker('ST'),
  none: marker('NM')
};
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceUserData,
  userData,
  evidenceRoot,
  markers,
  provider: null,
  employees: [],
  projects: [],
  checks: [],
  screenshotPath,
  consoleErrors: [],
  result: 'RUNNING'
};

function safeText(value) {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/gi, 'sk-[REDACTED]')
    .slice(0, 12_000);
}

function fail(message) {
  throw new Error(`[memory-boundaries] ${message}`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function employeeScope(employeeId) {
  return `employee-${sha256(employeeId).slice(0, 32)}`;
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  fail(`${label} timed out${lastError ? `: ${safeText(lastError.message || lastError)}` : ''}`);
}

async function main() {
  const application = await electron.launch({
    executablePath: process.env.AIBOX_MEMORY_ACCEPTANCE_EXECUTABLE || require('electron'),
    args: process.env.AIBOX_MEMORY_ACCEPTANCE_EXECUTABLE ? [] : ['.'],
    cwd: root,
    env: {
      ...process.env,
      AIBOX_USER_DATA_DIR: userData,
      AIBOX_DISABLE_HARDWARE_ACCELERATION: '1'
    },
    timeout: 60_000
  });

  let page;
  let activeProject = null;
  let activeContentId = null;
  const createdProjects = [];
  try {
    page = await application.firstWindow({ timeout: 60_000 });
    page.on('console', (message) => {
      if (message.type() === 'error') report.consoleErrors.push(`console: ${safeText(message.text())}`);
    });
    page.on('pageerror', (error) => report.consoleErrors.push(`page: ${safeText(error.message)}`));
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });

    const snapshot = await page.evaluate(() => window.aibox.getSnapshot());
    const candidatesByMode = new Map();
    for (const card of snapshot.agentCards) {
      const employee = card.agent;
      if (employee.lifecycle === 'READY'
        && !employee.archived
        && employee.engineId !== 'eng-deepseek-harness-managed'
        && ['long_term', 'short_term', 'none'].includes(employee.memoryMode)) {
        const candidates = candidatesByMode.get(employee.memoryMode) || [];
        candidates.push(employee);
        candidatesByMode.set(employee.memoryMode, candidates);
      }
    }
    const byMode = new Map();
    for (const mode of ['long_term', 'short_term', 'none']) {
      const candidates = candidatesByMode.get(mode) || [];
      const selected = candidates.find((employee) => employee.name.startsWith('验收'))
        || candidates.find((employee) => !/^(?:Cordis|DSH)$/i.test(employee.name.trim()))
        || candidates[0];
      if (!selected) fail(`A READY ${mode} digital employee is required`);
      byMode.set(mode, selected);
    }
    const employees = Object.fromEntries([...byMode.entries()]);
    report.employees = Object.values(employees).map((employee) => ({
      id: employee.id,
      name: employee.name,
      role: employee.role,
      engineId: employee.engineId,
      memoryMode: employee.memoryMode,
      scope: employeeScope(employee.id)
    }));

    const providers = await page.evaluate(() => window.aibox.listProviders());
    const provider = providers.find((item) => item.isDefault && item.hasKey) || providers.find((item) => item.hasKey);
    if (!provider) fail('Seed user data has no configured Provider');
    const modelCatalog = await page.evaluate((providerId) => window.aibox.fetchProviderModels(providerId), provider.id);
    if (!modelCatalog.ok || modelCatalog.models.length === 0) fail(modelCatalog.error || 'Provider model catalog is unavailable');
    const preferredModel = modelCatalog.models.includes('deepseek-v4-pro-0813')
      ? 'deepseek-v4-pro-0813'
      : modelCatalog.models.includes(provider.model)
        ? provider.model
        : modelCatalog.models[0];
    report.provider = {
      id: provider.id,
      baseUrl: provider.baseUrl,
      model: preferredModel,
      modelCount: modelCatalog.models.length,
      hasKey: provider.hasKey
    };

    const createProject = async (name, objective) => {
      const project = await page.evaluate((input) => window.aibox.createProject(input), {
        name,
        objective,
        description: '真实模型员工记忆边界黑盒验收。',
        status: 'active',
        workspaceMode: 'automatic'
      });
      await page.evaluate(({ projectId, model }) => window.aibox.saveQuestSettings(projectId, {
        mode: 'quest',
        orchestrator: 'hermes',
        sandbox: 'workspace',
        permissionMode: 'standard',
        model,
        workerAgentIds: [],
        pluginIds: [],
        maxParallel: 2,
        autoApproveLowRisk: false
      }), { projectId: project.id, model: preferredModel });
      createdProjects.push(project);
      report.projects.push({ id: project.id, name: project.name });
      return project;
    };

    const openProject = async (project) => {
      await page.evaluate(() => window.aibox.closeEmbeddedHermesWorkbench()).catch(() => undefined);
      const opened = await page.evaluate(({ projectId }) => window.aibox.openEmbeddedHermesWorkbench({
        projectId,
        bounds: { x: 8, y: 8, width: 1280, height: 820 },
        theme: 'dark'
      }), { projectId: project.id });
      if (!opened.attached || !opened.runtime?.proxyPort) {
        fail(opened.runtime?.lastError || `Hermes failed to start for ${project.name}`);
      }
      // Workbench creation can complete while the real Hermes dashboard is
      // visible but its execution Gateway is still warming up. Waiting for
      // Main-owned healthy state avoids treating that normal fail-closed
      // startup window as a product failure.
      const healthyRuntime = await waitFor(async () => {
        const status = await page.evaluate((projectId) => window.aibox.getHermesRuntimeStatus(projectId), project.id);
        if (status.state === 'error') fail(status.lastError || `Hermes failed to start for ${project.name}`);
        return status.state === 'healthy' && status.proxyPort ? status : null;
      }, 90_000, `Hermes Gateway health for ${project.name}`);
      activeProject = project;
      activeContentId = await waitFor(async () => application.evaluate(({ webContents }, port) => {
        const contents = webContents.getAllWebContents().filter((item) => {
          try { return new URL(item.getURL()).port === String(port); } catch { return false; }
        }).at(-1);
        return contents?.id || null;
      }, healthyRuntime.proxyPort), 30_000, `Hermes WebContents for ${project.name}`);
      return healthyRuntime;
    };

    const projectRequest = async (operation, payload = null) => application.evaluate(async ({ webContents }, input) => {
      const contents = webContents.fromId(input.contentId);
      if (!contents || contents.isDestroyed()) throw new Error('Hermes WebContents is unavailable');
      const init = input.payload === null
        ? `{credentials:'include'}`
        : `{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:${JSON.stringify(JSON.stringify(input.payload))}}`;
      return contents.executeJavaScript(
        `fetch(${JSON.stringify('/__opc_nexus/project/') + '+encodeURIComponent(' + JSON.stringify(input.operation) + ')'},${init}).then(async response=>({status:response.status,body:await response.json()}))`,
        true
      );
    }, { contentId: activeContentId, operation, payload });

    const createConversation = async (employee) => {
      const response = await projectRequest('create-conversation', { employeeId: employee.id });
      if (response.status !== 200 || !response.body?.ok || !response.body.result?.conversationId) {
        fail(response.body?.error || `Could not create ${employee.name} conversation`);
      }
      return response.body.result;
    };

    const turn = async (conversationId, message) => {
      const response = await projectRequest('chat-turn', { conversationId, message });
      if (response.status !== 200 || !response.body?.ok || !response.body.result?.content) {
        fail(response.body?.error || `Hermes turn failed (${response.status})`);
      }
      return response.body.result;
    };

    const history = async (conversationId) => {
      const response = await projectRequest('chat-history', { conversationId });
      if (response.status !== 200 || !response.body?.ok) fail(response.body?.error || 'Could not read conversation history');
      return response.body.result;
    };

    const step = async (name, run) => {
      const startedAt = Date.now();
      try {
        const evidence = await run();
        report.checks.push({ name, status: 'PASS', durationMs: Date.now() - startedAt, evidence });
        return evidence;
      } catch (error) {
        report.checks.push({
          name,
          status: 'FAIL',
          durationMs: Date.now() - startedAt,
          error: safeText(error instanceof Error ? error.stack || error.message : error)
        });
        throw error;
      }
    };

    const primary = await createProject('员工记忆边界验收 A', '验证同项目长期、短期和无记忆的真实模型语义');
    const primaryRuntime = await openProject(primary);
    const projectHome = primaryRuntime.homePath;

    const longConversation = await createConversation(employees.long_term);
    const longStored = await step('长期记忆调用真实 memory 工具并落盘', async () => {
      const response = await turn(longConversation.conversationId, [
        `老板要求你长期记住验收代号 ${markers.longTerm}。`,
        '必须调用 Hermes 的 memory 工具，以 action=add、target=memory 保存包含该完整代号的一条记录。',
        '确认工具成功后只回复 STORED；不能仅口头声称已经记住。'
      ].join('\n'));
      if (/^(?:HTTP\s+[45]\d\d\s*:|API call failed|Request payload too large)/i.test(response.content)
        || !/^STORED\b/i.test(response.content.trim())) {
        fail(`Long-term memory tool completed but the user-facing turn failed: ${safeText(response.content)}`);
      }
      const memoryPath = path.join(
        projectHome,
        'memories',
        'employees',
        employeeScope(employees.long_term.id),
        'MEMORY.md'
      );
      const bytes = await waitFor(() => {
        if (!fs.statSync(memoryPath, { throwIfNoEntry: false })?.isFile()) return null;
        const value = fs.readFileSync(memoryPath, 'utf8');
        return value.includes(markers.longTerm) ? value : null;
      }, 20_000, 'long-term employee MEMORY.md write');
      return {
        conversationId: longConversation.conversationId,
        hermesSessionId: response.hermesSessionId,
        memoryMode: response.runtime?.memoryMode,
        memoryScope: response.runtime?.memoryScope,
        memoryPath,
        memorySha256: sha256(bytes),
        reply: response.content
      };
    });

    await step('Hermes 服务停止和重启保留长期记忆文件', async () => {
      await page.evaluate(() => window.aibox.closeEmbeddedHermesWorkbench());
      const stopped = await page.evaluate((projectId) => window.aibox.stopHermesProject(projectId), primary.id);
      if (stopped.state !== 'stopped') fail(`Expected stopped runtime, got ${stopped.state}`);
      const runtime = await openProject(primary);
      const persisted = fs.readFileSync(longStored.memoryPath, 'utf8');
      if (!persisted.includes(markers.longTerm)) fail('Long-term memory file changed or disappeared after restart');
      return { stopped: stopped.state, restarted: runtime.state, memorySha256: sha256(persisted) };
    });

    await step('长期记忆在重启后的新 conversation 中真实召回', async () => {
      const fresh = await createConversation(employees.long_term);
      const response = await turn(fresh.conversationId, [
        '老板之前要求你长期记住的验收代号是什么？',
        '不要读取旧聊天记录，也不要调用工具。只回复完整代号；如果长期记忆中没有，就只回复 UNKNOWN。'
      ].join('\n'));
      if (!response.content.includes(markers.longTerm)) {
        fail(`Long-term employee did not recall the persisted marker: ${safeText(response.content)}`);
      }
      if (fresh.conversationId === longConversation.conversationId || response.hermesSessionId === longStored.hermesSessionId) {
        fail('Long-term recall reused the original conversation or Hermes session');
      }
      return {
        originalConversationId: longConversation.conversationId,
        recallConversationId: fresh.conversationId,
        originalHermesSessionId: longStored.hermesSessionId,
        recallHermesSessionId: response.hermesSessionId,
        reply: response.content
      };
    });

    const shortConversation = await createConversation(employees.short_term);
    await step('短期记忆只在当前 conversation 中召回', async () => {
      const stored = await turn(shortConversation.conversationId, [
        `这是本次对话的临时代号：${markers.shortTerm}。`,
        '不要调用任何工具，不要写入文件或长期记忆，只回复 RECEIVED。'
      ].join('\n'));
      const recalled = await turn(shortConversation.conversationId, [
        '我刚才给你的本次对话临时代号是什么？不要调用工具，只回复完整代号；不知道就回复 UNKNOWN。'
      ].join('\n'));
      if (!recalled.content.includes(markers.shortTerm)) {
        fail(`Short-term employee lost current-conversation context: ${safeText(recalled.content)}`);
      }
      return {
        conversationId: shortConversation.conversationId,
        hermesSessionId: recalled.hermesSessionId,
        memoryMode: recalled.runtime?.memoryMode,
        firstReply: stored.content,
        recallReply: recalled.content
      };
    });

    await step('短期记忆不跨到新的 conversation', async () => {
      const fresh = await createConversation(employees.short_term);
      const response = await turn(fresh.conversationId, [
        '上一个对话中的临时代号是什么？不要调用工具。当前上下文没有明确值时必须只回复 UNKNOWN。'
      ].join('\n'));
      if (response.content.includes(markers.shortTerm)) {
        fail(`Short-term marker leaked into a new conversation: ${safeText(response.content)}`);
      }
      return {
        originalConversationId: shortConversation.conversationId,
        newConversationId: fresh.conversationId,
        reply: response.content,
        markerAbsent: true
      };
    });

    const noneConversation = await createConversation(employees.none);
    await step('无记忆员工保留 UI 历史但模型不读取同会话旧内容', async () => {
      await turn(noneConversation.conversationId, [
        `这是只出现一次的代号：${markers.none}。`,
        '不要调用工具，不要保存记忆，只回复 RECEIVED。'
      ].join('\n'));
      const response = await turn(noneConversation.conversationId, [
        '上一条消息的一次性代号是什么？不要调用工具。当前上下文没有明确值时必须只回复 UNKNOWN。'
      ].join('\n'));
      if (response.content.includes(markers.none)) {
        fail(`Stateless employee received previous model context: ${safeText(response.content)}`);
      }
      const persistedHistory = await history(noneConversation.conversationId);
      const visibleInHistory = persistedHistory.messages.some((item) => (
        item.role === 'user' && String(item.content).includes(markers.none)
      ));
      if (!visibleInHistory) fail('Stateless conversation removed the prior message from visible UI history');
      return {
        conversationId: noneConversation.conversationId,
        hermesSessionId: response.hermesSessionId,
        memoryMode: response.runtime?.memoryMode,
        reply: response.content,
        markerAbsentFromReply: true,
        markerVisibleInUiHistory: true,
        historyMessages: persistedHistory.messages.length
      };
    });

    await page.evaluate(() => window.aibox.closeEmbeddedHermesWorkbench());
    await page.evaluate((projectId) => window.aibox.stopHermesProject(projectId), primary.id);
    const isolated = await createProject('员工记忆边界验收 B', '验证同一员工的长期记忆不能跨项目');
    const isolatedRuntime = await openProject(isolated);

    await step('同一长期记忆员工不能跨项目召回', async () => {
      const fresh = await createConversation(employees.long_term);
      const response = await turn(fresh.conversationId, [
        '另一个项目中老板要求长期记住的验收代号是什么？不要调用工具。当前项目记忆中没有就只回复 UNKNOWN。'
      ].join('\n'));
      if (response.content.includes(markers.longTerm)) {
        fail(`Long-term marker leaked across projects: ${safeText(response.content)}`);
      }
      const isolatedMemoryPath = path.join(
        isolatedRuntime.homePath,
        'memories',
        'employees',
        employeeScope(employees.long_term.id),
        'MEMORY.md'
      );
      const isolatedMemory = fs.statSync(isolatedMemoryPath, { throwIfNoEntry: false })?.isFile()
        ? fs.readFileSync(isolatedMemoryPath, 'utf8')
        : '';
      if (isolatedMemory.includes(markers.longTerm)) fail('Long-term marker exists in the second project memory file');
      return {
        sourceProjectId: primary.id,
        isolatedProjectId: isolated.id,
        conversationId: fresh.conversationId,
        hermesSessionId: response.hermesSessionId,
        reply: response.content,
        isolatedMemoryPath,
        markerAbsent: true
      };
    });

    const screenshot = await application.evaluate(async ({ webContents }, id) => {
      const contents = webContents.fromId(id);
      if (!contents || contents.isDestroyed()) throw new Error('Hermes WebContents is unavailable');
      return (await contents.capturePage()).toPNG().toString('base64');
    }, activeContentId);
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot, 'base64'));
    if (report.consoleErrors.length > 0) fail(`Renderer errors: ${report.consoleErrors.join(' | ')}`);
    report.result = report.checks.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL';
  } catch (error) {
    report.result = 'FAIL';
    report.error = safeText(error instanceof Error ? error.stack || error.message : error);
    throw error;
  } finally {
    if (page) await page.evaluate(() => window.aibox.closeEmbeddedHermesWorkbench()).catch(() => undefined);
    for (const project of createdProjects) {
      if (page) await page.evaluate((projectId) => window.aibox.stopHermesProject(projectId), project.id).catch(() => undefined);
      if (page) await page.evaluate((projectId) => window.aibox.stopHermesMobileAccess(projectId), project.id).catch(() => undefined);
    }
    report.completedAt = new Date().toISOString();
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await application.close().catch(() => undefined);
  }

  process.stdout.write(`${JSON.stringify({
    result: report.result,
    reportPath,
    checks: report.checks.map((item) => ({ name: item.name, status: item.status }))
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(safeText(error instanceof Error ? error.stack || error.message : error));
  process.exitCode = 1;
});
