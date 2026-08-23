'use strict';

const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');
const { _electron: electron } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const evidenceRoot = path.resolve(
  process.env.AIBOX_PLUGIN_ACCEPTANCE_OUTPUT
    || path.join(root, 'tmp', 'acceptance-hermes-project-plugins', stamp)
);
const defaultSeed = path.join(root, 'tmp', 'acceptance-real', '2026-08-20-compat-r3', 'user-data');
const seedUserData = path.resolve(process.env.AIBOX_PLUGIN_ACCEPTANCE_SEED_USER_DATA || defaultSeed);
const userData = path.join(evidenceRoot, 'user-data');
const reportPath = path.join(evidenceRoot, 'report.json');
const screenshotPath = path.join(evidenceRoot, 'quest-project-plugins.png');
const invocationLog = path.join(evidenceRoot, 'mcp-invocations.jsonl');
const mcpServerPath = path.join(root, 'tests', 'fixtures', 'mcp-acceptance-server.cjs');
const marker = randomBytes(10).toString('hex').toUpperCase();
const skillMarker = `SKILL-REAL-CONTEXT::${marker}`;
const mcpMarker = `MCP-INPUT::${marker}`;

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  evidenceRoot,
  seedUserData,
  userData,
  marker,
  provider: null,
  project: null,
  skill: null,
  mcp: null,
  checks: [],
  audits: [],
  consoleErrors: [],
  screenshotPath,
  result: 'RUNNING'
};

function safeText(value, max = 12_000) {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .slice(0, max);
}

function fail(message) {
  throw new Error(`[project-plugins] ${message}`);
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
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail(`${label} timed out${lastError ? `: ${safeText(lastError.message || lastError)}` : ''}`);
}

async function readAudits() {
  const databasePath = path.join(userData, 'aibox-data', 'aibox.db');
  if (!fs.statSync(databasePath, { throwIfNoEntry: false })?.isFile()) return [];
  const SQL = await initSqlJs({ locateFile: (file) => require.resolve(`sql.js/dist/${file}`) });
  const db = new SQL.Database(fs.readFileSync(databasePath));
  try {
    const result = db.exec(`
      SELECT actor, action, target, result, source, created_at
      FROM audit_logs
      WHERE action IN ('hermes.quest.command', 'hermes.mcp.call')
      ORDER BY created_at
    `);
    if (!result[0]) return [];
    return result[0].values.map((row) => Object.fromEntries(
      result[0].columns.map((column, index) => [column, row[index]])
    ));
  } finally {
    db.close();
  }
}

async function main() {
  if (!fs.statSync(seedUserData, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`Configured seed user data is unavailable: ${seedUserData}`);
  }
  fs.mkdirSync(evidenceRoot, { recursive: true });
  fs.cpSync(seedUserData, userData, { recursive: true, force: true });

  const application = await electron.launch({
    executablePath: require('electron'),
    args: ['.'],
    cwd: root,
    env: {
      ...process.env,
      AIBOX_USER_DATA_DIR: userData,
      AIBOX_DISABLE_HARDWARE_ACCELERATION: '1'
    },
    timeout: 60_000
  });

  let page;
  let projectId = null;
  let mcpId = null;
  let hermesContentsId = null;
  const step = async (name, action) => {
    const startedAt = Date.now();
    try {
      const evidence = await action();
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

  const projectRequest = async (operation, payload) => {
    if (!hermesContentsId) fail('Hermes embedded WebContents is unavailable');
    return application.evaluate(async ({ webContents }, input) => {
      const contents = webContents.fromId(input.id);
      if (!contents || contents.isDestroyed()) throw new Error('Hermes embedded WebContents was destroyed');
      const expression = `fetch(${JSON.stringify('/__opc_nexus/project/')}${' + '}${JSON.stringify(input.operation)}, {
        method: ${JSON.stringify(input.hasPayload ? 'POST' : 'GET')},
        credentials: 'include',
        ${input.hasPayload ? `headers: {'content-type':'application/json'}, body: ${JSON.stringify(JSON.stringify(input.payload))},` : ''}
      }).then(async response => ({ status: response.status, body: await response.json() }))`;
      return contents.executeJavaScript(expression, true);
    }, { id: hermesContentsId, operation, payload, hasPayload: payload !== undefined });
  };

  try {
    page = await application.firstWindow({ timeout: 60_000 });
    page.on('console', (message) => {
      if (message.type() === 'error') report.consoleErrors.push(`console: ${safeText(message.text())}`);
    });
    page.on('pageerror', (error) => report.consoleErrors.push(`page: ${safeText(error.message)}`));
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });

    const provider = await step('读取真实 Provider 与模型列表', async () => {
      const providers = await page.evaluate(() => window.aibox.listProviders());
      const selected = providers.find((item) => item.isDefault && item.hasKey)
        || providers.find((item) => item.hasKey);
      if (!selected) fail('No Provider with a safeStorage credential is configured');
      const models = await page.evaluate((providerId) => window.aibox.fetchProviderModels(providerId), selected.id);
      if (!models.ok || models.models.length === 0) fail(models.error || 'Provider model list is unavailable');
      const model = models.models.includes('deepseek-v4-pro-0813')
        ? 'deepseek-v4-pro-0813'
        : models.models.includes(selected.model) ? selected.model : models.models[0];
      const view = { id: selected.id, baseUrl: selected.baseUrl, model, modelCount: models.models.length, hasKey: selected.hasKey };
      report.provider = view;
      return view;
    });

    const skill = await step('创建真实项目 Skill', async () => page.evaluate((input) => window.aibox.createSkill(input), {
      name: `插件验收技能 ${marker.slice(0, 8)}`,
      description: '验证 Quest 项目选择的 Skill 被真实同步并用于当前指令',
      content: [
        '# 项目技能验收契约',
        '',
        '当老板明确调用本技能时，回复必须包含下面这一整行，不得改写：',
        skillMarker,
        '',
        '这是本轮随机生成的验收内容；没有读取本 SKILL.md 就无法知道该值。'
      ].join('\n')
    }));
    report.skill = { id: skill.id, name: skill.name, marker: skillMarker };

    const mcp = await step('创建并启动真实 stdio MCP', async () => {
      const created = await page.evaluate((input) => window.aibox.createMcpServer(input), {
        name: `插件验收 MCP ${marker.slice(0, 8)}`,
        command: process.execPath,
        args: [mcpServerPath],
        env: { MCP_ACCEPTANCE_LOG: invocationLog },
        scope: 'global'
      });
      const started = await page.evaluate((id) => window.aibox.startMcpServer(id), created.id);
      if (!started.ok || !started.tools?.some((tool) => tool.name === 'echo_marker')) {
        fail(started.message || 'MCP echo_marker tool was not discovered');
      }
      return { ...created, tools: started.tools };
    });
    mcpId = mcp.id;
    report.mcp = { id: mcp.id, name: mcp.name, tools: mcp.tools, marker: mcpMarker };

    const project = await step('创建项目并选择 Skill 与 MCP', async () => {
      const created = await page.evaluate(() => window.aibox.createProject({
        name: 'Hermes 项目插件真实验收',
        objective: '验证 Hermes 共享项目 Skill 和 MCP 的真实调用链路',
        description: 'Skill 与 MCP 均为本轮动态创建，不允许使用历史或模拟结果。',
        status: 'active',
        workspaceMode: 'automatic'
      }));
      const settings = await page.evaluate(({ id, model, pluginIds }) => window.aibox.saveQuestSettings(id, {
        mode: 'quest',
        orchestrator: 'hermes',
        sandbox: 'workspace',
        permissionMode: 'standard',
        model,
        workerAgentIds: [],
        pluginIds,
        maxParallel: 2,
        autoApproveLowRisk: false
      }), { id: created.id, model: provider.model, pluginIds: [`skill:${skill.id}`, `mcp:${mcp.id}`] });
      if (!settings.pluginIds.includes(`skill:${skill.id}`) || !settings.pluginIds.includes(`mcp:${mcp.id}`)) {
        fail('Project plugin selection did not persist');
      }
      return { ...created, settings };
    });
    projectId = project.id;
    report.project = { id: project.id, name: project.name, pluginIds: project.settings.pluginIds };

    const opened = await step('打开 Hermes 并验证项目插件投影', async () => {
      const value = await page.evaluate((id) => window.aibox.openEmbeddedHermesWorkbench({
        projectId: id,
        bounds: { x: 8, y: 8, width: 1320, height: 860 },
        theme: 'dark'
      }), project.id);
      if (!value.attached || !value.runtime?.proxyPort) fail(value.runtime?.lastError || 'Hermes Workbench did not attach');
      const runtime = await waitFor(async () => {
        const status = await page.evaluate((id) => window.aibox.getHermesRuntimeStatus(id), project.id);
        if (status.state === 'error') fail(status.lastError || 'Hermes runtime failed');
        return status.state === 'healthy' ? status : null;
      }, 90_000, 'Hermes Gateway health');
      hermesContentsId = await waitFor(() => application.evaluate(({ webContents }, port) => {
        const contents = webContents.getAllWebContents().find((item) => {
          try { return new URL(item.getURL()).port === String(port); } catch { return false; }
        });
        return contents?.id || null;
      }, runtime.proxyPort), 30_000, 'Hermes embedded WebContents');
      const state = await projectRequest('state');
      const plugins = state.body?.result?.plugins || state.body?.plugins || [];
      const skillView = plugins.find((item) => item.id === `skill:${skill.id}`);
      const mcpView = plugins.find((item) => item.id === `mcp:${mcp.id}`);
      if (skillView?.status !== 'ready' || mcpView?.status !== 'ready'
        || !mcpView.tools?.some((tool) => tool.name === 'echo_marker')) {
        fail(`Hermes project plugin state is incomplete: ${safeText(JSON.stringify(plugins))}`);
      }
      const skillPath = path.join(runtime.homePath, 'skills', 'opc-nexus', skill.id, 'SKILL.md');
      const body = fs.readFileSync(skillPath, 'utf8');
      if (!body.includes(skillMarker)) fail('Hermes managed SKILL.md does not contain the selected skill content');
      return { runtime, plugins, skillPath };
    });

    const conversation = await page.evaluate((id) => window.aibox.createHermesProjectConversation(id), project.id);
    await step('通过 /skill 使用真实同步内容', async () => {
      const response = await projectRequest('chat-turn', {
        conversationId: conversation.conversationId,
        message: `/skill ${skill.id} 按已选择技能的输出契约回复，不要调用其他工具。`
      });
      if (response.status !== 200 || !response.body?.ok) fail(response.body?.error || `Skill turn failed (${response.status})`);
      const content = String(response.body.result?.content || '');
      if (!content.includes(skillMarker)) fail(`Hermes did not apply the selected Skill content: ${safeText(content)}`);
      return { conversationId: conversation.conversationId, hermesSessionId: response.body.result?.hermesSessionId, content };
    });

    await step('通过 /mcp 调用真实 Main 治理工具桥', async () => {
      const response = await projectRequest('chat-turn', {
        conversationId: conversation.conversationId,
        message: `/mcp ${mcp.id}/echo_marker 调用该工具，参数 marker 必须精确为 ${mcpMarker}，并把工具返回文本原样回复。`
      });
      if (response.status !== 200 || !response.body?.ok) fail(response.body?.error || `MCP turn failed (${response.status})`);
      const content = String(response.body.result?.content || '');
      const expected = `MCP-REAL-ECHO::${mcpMarker}`;
      if (!content.includes(expected)) fail(`Hermes reply does not contain the real MCP result: ${safeText(content)}`);
      const calls = await waitFor(() => {
        if (!fs.statSync(invocationLog, { throwIfNoEntry: false })?.isFile()) return null;
        const entries = fs.readFileSync(invocationLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
        return entries.some((entry) => entry.name === 'echo_marker' && entry.marker === mcpMarker) ? entries : null;
      }, 10_000, 'MCP invocation log');
      return { content, invocationLog, calls };
    });

    const screenshot = await application.evaluate(async ({ webContents }, id) => {
      const contents = webContents.fromId(id);
      if (!contents || contents.isDestroyed()) throw new Error('Hermes WebContents is unavailable for screenshot');
      return (await contents.capturePage()).toPNG().toString('base64');
    }, hermesContentsId);
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot, 'base64'));
    if (report.consoleErrors.length > 0) fail(`Renderer errors: ${report.consoleErrors.join(' | ')}`);
    report.result = 'PASS';
  } catch (error) {
    report.result = 'FAIL';
    report.error = safeText(error instanceof Error ? error.stack || error.message : error);
    throw error;
  } finally {
    if (page && projectId) {
      await page.evaluate(() => window.aibox.closeEmbeddedHermesWorkbench()).catch(() => undefined);
      await page.evaluate((id) => window.aibox.stopHermesProject(id), projectId).catch(() => undefined);
    }
    if (page && mcpId) await page.evaluate((id) => window.aibox.stopMcpServer(id), mcpId).catch(() => undefined);
    await application.close().catch(() => undefined);
    report.audits = await readAudits().catch((error) => [{ error: safeText(error) }]);
    const commandAudits = report.audits.filter((item) => item.action === 'hermes.quest.command');
    const mcpAudit = report.audits.find((item) => item.action === 'hermes.mcp.call'
      && String(item.target).includes(mcpId || '') && item.result === 'ok');
    if (report.result === 'PASS' && (commandAudits.length < 2 || !mcpAudit)) {
      report.result = 'FAIL';
      report.error = 'Hermes plugin commands completed without the required Main audit records';
    }
    report.completedAt = new Date().toISOString();
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  process.stdout.write(`${JSON.stringify({
    result: report.result,
    reportPath,
    checks: report.checks.map((item) => ({ name: item.name, status: item.status })),
    auditCount: report.audits.length,
    screenshotPath
  }, null, 2)}\n`);
  if (report.result !== 'PASS') process.exitCode = 1;
}

main().catch((error) => {
  console.error(safeText(error instanceof Error ? error.stack || error.message : error));
  process.exitCode = 1;
});
