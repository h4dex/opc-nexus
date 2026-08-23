'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = path.resolve(
  process.env.AIBOX_IDENTITY_ACCEPTANCE_OUTPUT || path.join(root, 'tmp', 'acceptance-identity', stamp)
);
const cdpUrl = (process.env.AIBOX_IDENTITY_ACCEPTANCE_CDP || 'http://127.0.0.1:9333').trim();
const requestedProjectId = (process.env.AIBOX_IDENTITY_ACCEPTANCE_PROJECT || '').trim();
fs.mkdirSync(output, { recursive: true });

function fail(message) {
  throw new Error(`[hermes-identity] ${message}`);
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail(`${label} timed out${lastError ? `: ${lastError.message || lastError}` : ''}`);
}

async function main() {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];
  if (!context) fail('Electron CDP context is unavailable');
  const mainPage = context.pages().find((page) => page.url().startsWith('file:'));
  if (!mainPage) fail('OPC-Nexus main Renderer is unavailable');

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    cdpUrl,
    project: null,
    employees: [],
    replies: {},
    tabRace: null,
    delegation: null,
    screenshot: path.join(output, 'quest-identity-tabs.png'),
    result: 'RUNNING'
  };

  try {
    const snapshot = await mainPage.evaluate(() => window.aibox.getSnapshot());
    const project = requestedProjectId
      ? snapshot.projects.find((item) => item.id === requestedProjectId)
      : snapshot.projects.find((item) => item.status === 'active') || snapshot.projects[0];
    if (!project) fail('No active project is available');
    report.project = { id: project.id, name: project.name };

    const questNav = mainPage.locator('.nav-item').filter({ hasText: 'Quest' });
    await questNav.click();
    await mainPage.locator('.topbar-title').filter({ hasText: 'Quest' }).waitFor({ timeout: 15_000 });

    const hermesPage = await waitFor(async () => {
      const page = context.pages().find((candidate) => /^https?:\/\/127\.0\.0\.1:\d+\/chat/.test(candidate.url()));
      if (!page) return null;
      const input = page.locator('textarea[placeholder="给 Hermes 下达任务"]');
      return await input.isVisible().catch(() => false) ? page : null;
    }, 60_000, 'embedded Hermes chat');

    const projectRequest = async (operation, payload) => hermesPage.evaluate(async ({ operation, payload }) => {
      const response = await fetch(`/__opc_nexus/project/${operation}`, {
        method: payload === undefined ? 'GET' : 'POST',
        credentials: 'include',
        ...(payload === undefined ? {} : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        })
      });
      return { status: response.status, body: await response.json() };
    }, { operation, payload });

    const stateResponse = await projectRequest('state');
    if (stateResponse.status !== 200 || !stateResponse.body?.ok) {
      fail(stateResponse.body?.error || 'Project state is unavailable');
    }
    const employees = stateResponse.body.result.employees.filter((employee) => (
      employee.name !== 'Cordis' && employee.engineId !== 'eng-deepseek-harness-managed'
    ));
    const frontend = employees.find((employee) => /前端/.test(`${employee.name} ${employee.role}`));
    const backend = employees.find((employee) => /后端/.test(`${employee.name} ${employee.role}`));
    if (!frontend || !backend) fail('Both READY frontend and backend employees are required');
    report.employees = [backend, frontend].map(({ id, name, role, engineId, memoryMode }) => ({
      id, name, role, engineId, memoryMode
    }));

    const createConversation = async (employee) => {
      const response = await projectRequest('create-conversation', employee ? { employeeId: employee.id } : {});
      if (response.status !== 200 || !response.body?.ok) fail(response.body?.error || 'Conversation creation failed');
      return response.body.result;
    };
    const schedulerConversation = await createConversation();
    const backendConversation = await createConversation(backend);
    const frontendConversation = await createConversation(frontend);

    const turn = async (conversationId, message) => {
      const response = await projectRequest('chat-turn', { conversationId, message });
      if (response.status !== 200 || !response.body?.ok || !response.body.result?.content) {
        fail(response.body?.error || `Hermes turn failed (${response.status})`);
      }
      return response.body.result;
    };

    const schedulerReply = await turn(
      schedulerConversation.conversationId,
      '不要调用工具。请严格只输出一行：身份=Hermes；职责=OPC-Nexus项目调度。不要添加其他文字。'
    );
    if (!/身份\s*[=：:]\s*Hermes/i.test(schedulerReply.content)
      || /身份\s*[=：:]\s*(?:Cordis|前端工程师|后端工程师)/i.test(schedulerReply.content)) {
      fail(`Scheduler identity leaked: ${schedulerReply.content}`);
    }

    const backendReply = await turn(
      backendConversation.conversationId,
      `不要调用工具。请严格只输出一行：身份=${backend.name}；角色=${backend.role}。不要添加其他文字。`
    );
    if (!backendReply.content.includes(backend.name) || /身份\s*[=：:]\s*(?:Hermes|Cordis)/i.test(backendReply.content)) {
      fail(`Backend identity leaked: ${backendReply.content}`);
    }

    const frontendReply = await turn(
      frontendConversation.conversationId,
      `不要调用工具。请严格只输出一行：身份=${frontend.name}；角色=${frontend.role}。不要添加其他文字。`
    );
    if (!frontendReply.content.includes(frontend.name) || /身份\s*[=：:]\s*(?:Hermes|Cordis)/i.test(frontendReply.content)) {
      fail(`Frontend identity leaked: ${frontendReply.content}`);
    }
    report.replies = {
      scheduler: schedulerReply.content,
      backend: backendReply.content,
      frontend: frontendReply.content
    };

    await hermesPage.waitForTimeout(4_500);
    const backendTab = hermesPage.locator('[data-nexus-conversation-tabs] button').filter({ hasText: `@${backend.name}` }).last();
    const frontendTab = hermesPage.locator('[data-nexus-conversation-tabs] button').filter({ hasText: `@${frontend.name}` }).last();
    await backendTab.waitFor({ timeout: 15_000 });
    await frontendTab.waitFor({ timeout: 15_000 });
    let delayedBackendHistory = false;
    await hermesPage.route('**/__opc_nexus/project/chat-history', async (route) => {
      let conversationId = '';
      try { conversationId = route.request().postDataJSON()?.conversationId || ''; } catch { /* no body */ }
      if (!delayedBackendHistory && conversationId === backendConversation.conversationId) {
        delayedBackendHistory = true;
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
      await route.continue();
    });
    await backendTab.click();
    await hermesPage.waitForTimeout(50);
    await frontendTab.click();
    await hermesPage.waitForTimeout(2_200);
    const activeTabText = await hermesPage.locator('[data-nexus-conversation-tabs] > div')
      .filter({ has: hermesPage.locator('button', { hasText: `@${frontend.name}` }) }).last().getAttribute('class');
    const conversationArticles = await hermesPage.locator('article').allTextContents();
    const conversationText = conversationArticles.join('\n');
    if (!activeTabText?.includes('bg-background-base') || !conversationText.includes(frontendReply.content)) {
      fail('A late backend history response replaced the selected frontend tab');
    }
    report.tabRace = {
      delayedConversationId: backendConversation.conversationId,
      selectedConversationId: frontendConversation.conversationId,
      selectedReplyVisible: true
    };

    const before = await mainPage.evaluate(() => window.aibox.getSnapshot());
    const beforeTaskIds = new Set(before.tasks.map((task) => task.id));
    const delegationReply = await turn(backendConversation.conversationId, [
      `你必须保持当前固定身份 ${backend.name}。`,
      `@${frontend.name} 请调用 nexus_delegate_task，把“返回一句路由验收完成，不创建文件”的简单任务真实派给该员工。`,
      'expectedArtifacts 使用空数组。工具返回后只输出一行：',
      `回复者=${backend.name}；接收者=${frontend.name}；任务ID=<真实任务ID>。`
    ].join('\n'));
    const delegatedTask = await waitFor(async () => {
      const current = await mainPage.evaluate(() => window.aibox.getSnapshot());
      return current.tasks.find((task) => !beforeTaskIds.has(task.id) && task.projectId === project.id) || null;
    }, 30_000, 'delegated employee task');
    if (delegatedTask.agentId !== frontend.id) {
      fail(`@mention routed to ${delegatedTask.agentId} instead of ${frontend.id}`);
    }
    if (!delegationReply.content.includes(backend.name)
      || !delegationReply.content.includes(frontend.name)
      || !delegationReply.content.includes(delegatedTask.id)) {
      fail(`Delegation reply does not preserve responder/receiver identity: ${delegationReply.content}`);
    }
    const terminalDelegatedTask = await waitFor(async () => {
      const current = await mainPage.evaluate(() => window.aibox.getSnapshot());
      const task = current.tasks.find((item) => item.id === delegatedTask.id);
      return task && ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(task.status) ? task : null;
    }, 60_000, 'delegated employee task completion');
    report.delegation = {
      responder: backend.name,
      receiver: frontend.name,
      taskId: delegatedTask.id,
      taskAgentId: delegatedTask.agentId,
      initialStatus: delegatedTask.status,
      finalStatus: terminalDelegatedTask.status,
      finalError: terminalDelegatedTask.error,
      reply: delegationReply.content
    };
    if (terminalDelegatedTask.status !== 'COMPLETED') {
      fail(`@mention task did not complete: ${terminalDelegatedTask.error || terminalDelegatedTask.status}`);
    }
    if (!['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(terminalDelegatedTask.status)) {
      await mainPage.evaluate((taskId) => window.aibox.cancelTask(taskId), delegatedTask.id).catch(() => undefined);
    }

    await frontendTab.click();
    await hermesPage.screenshot({ path: report.screenshot, fullPage: true });
    report.result = 'PASS';
    fs.writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ ...report, reportPath: path.join(output, 'report.json') }, null, 2)}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
