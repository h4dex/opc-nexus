'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const evidenceRoot = path.resolve(
  process.env.AIBOX_CARD_ACCEPTANCE_OUTPUT || path.join(root, 'tmp', 'acceptance-card-identity', stamp)
);
const sourceUserData = (process.env.AIBOX_CARD_ACCEPTANCE_SEED_USER_DATA || '').trim();
if (!sourceUserData || !fs.statSync(sourceUserData, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error('AIBOX_CARD_ACCEPTANCE_SEED_USER_DATA must point to a configured OPC-Nexus user-data directory');
}

const userData = path.join(evidenceRoot, 'user-data');
const reportPath = path.join(evidenceRoot, 'report.json');
const screenshotPath = path.join(evidenceRoot, 'employee-card-tabs.png');
fs.mkdirSync(evidenceRoot, { recursive: true });
fs.cpSync(sourceUserData, userData, { recursive: true, force: true });

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceUserData,
  userData,
  project: null,
  employees: [],
  projectOptions: [],
  screenshotPath,
  result: 'RUNNING',
  consoleErrors: []
};

function safeText(value) {
  return String(value ?? '').replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]').slice(0, 8_000);
}

function fail(message) {
  throw new Error(`[card-identity] ${message}`);
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

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function main() {
  const application = await electron.launch({
    executablePath: process.env.AIBOX_CARD_ACCEPTANCE_EXECUTABLE || require('electron'),
    args: process.env.AIBOX_CARD_ACCEPTANCE_EXECUTABLE ? [] : ['.'],
    cwd: root,
    env: {
      ...process.env,
      AIBOX_USER_DATA_DIR: userData,
      AIBOX_DISABLE_HARDWARE_ACCELERATION: '1'
    },
    timeout: 60_000
  });
  let page;
  let project;
  try {
    page = await application.firstWindow({ timeout: 60_000 });
    page.on('console', (message) => {
      if (message.type() === 'error') report.consoleErrors.push(`console: ${safeText(message.text())}`);
    });
    page.on('pageerror', (error) => report.consoleErrors.push(`page: ${safeText(error.message)}`));
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });

    const snapshot = await page.evaluate(() => window.aibox.getSnapshot());
    const employees = snapshot.agentCards
      .map((card) => card.agent)
      .filter((agent) => agent.lifecycle === 'READY' && !agent.archived && agent.engineId !== 'eng-deepseek-harness-managed')
      .slice(0, 2);
    if (employees.length < 2) fail('At least two READY non-DSH employees are required');

    project = await page.evaluate(() => window.aibox.createProject({
      name: '员工卡片身份验收',
      objective: '验证从数字员工卡片进入 Quest 后会话身份和任务路由一致',
      description: '动态组队项目，不预先绑定固定员工。',
      status: 'active',
      workspaceMode: 'automatic'
    }));
    report.project = { id: project.id, name: project.name };

    const embeddedContents = async () => {
      const runtime = await page.evaluate((projectId) => window.aibox.getHermesRuntimeStatus(projectId), project.id);
      report.lastRuntime = {
        projectId: runtime.projectId,
        state: runtime.state,
        proxyPort: runtime.proxyPort,
        lastError: runtime.lastError || null
      };
      if (!runtime.proxyPort) return null;
      return withTimeout(application.evaluate(({ webContents }, port) => {
        const matches = webContents.getAllWebContents().filter((contents) => {
          try { return new URL(contents.getURL()).port === String(port); } catch { return false; }
        });
        const contents = matches.at(-1);
        return contents?.id || null;
      }, runtime.proxyPort), 10_000, 'resolve current embedded Hermes WebContents');
    };

    const projectRead = async (contentId, operation) => withTimeout(application.evaluate(async ({ webContents }, input) => {
      const contents = webContents.fromId(input.id);
      if (!contents || contents.isDestroyed()) throw new Error('Hermes WebContents is unavailable');
      const expression = `fetch('/__opc_nexus/project/${input.operation}', {credentials:'include'}).then(async response => ({status:response.status, body:await response.json()}))`;
      return contents.executeJavaScript(expression, true);
    }, { id: contentId, operation }), 15_000, `read project operation ${operation}`);

    const projectRequest = async (contentId, operation, payload) => withTimeout(application.evaluate(async ({ webContents }, input) => {
      const contents = webContents.fromId(input.id);
      if (!contents || contents.isDestroyed()) throw new Error('Hermes WebContents is unavailable');
      const expression = `fetch(${JSON.stringify(`/__opc_nexus/project/${input.operation}`)}, {
        method: 'POST', credentials: 'include', headers: {'content-type':'application/json'},
        body: ${JSON.stringify(JSON.stringify(input.payload))}
      }).then(async response => ({status:response.status, body:await response.json()}))`;
      return contents.executeJavaScript(expression, true);
    }, { id: contentId, operation, payload }), 15_000, `write project operation ${operation}`);

    await page.locator('.nav-item').filter({ hasText: 'Quest' }).click();
    await page.locator('.topbar-title').filter({ hasText: 'Quest' }).waitFor({ timeout: 15_000 });
    const initialContentId = await waitFor(embeddedContents, 120_000, 'initial embedded Hermes');
    const initialConversations = await waitFor(async () => {
      const response = await projectRead(initialContentId, 'conversations');
      return response.status === 200 && response.body?.ok ? response.body.result : null;
    }, 20_000, 'initial project conversations');
    report.runtimeReady = await waitFor(async () => {
      const runtime = await page.evaluate((projectId) => window.aibox.getHermesRuntimeStatus(projectId), project.id);
      report.lastRuntime = {
        projectId: runtime.projectId,
        state: runtime.state,
        startupPhase: runtime.startupPhase || null,
        startupElapsedMs: runtime.startupElapsedMs || null,
        proxyPort: runtime.proxyPort,
        lastError: runtime.lastError || null
      };
      return runtime.state === 'healthy' ? report.lastRuntime : null;
    }, 120_000, 'Hermes execution Gateway health');
    let previousConversationIds = new Set(initialConversations.map((item) => item.conversationId));
    const expectedDrafts = new Map();

    for (const employee of employees) {
      await page.locator('.nav-item').filter({ hasText: '数字员工' }).click();
      await page.locator('.topbar-title').filter({ hasText: '数字员工' }).waitFor({ timeout: 15_000 });
      const row = page.locator('tbody tr').filter({ hasText: employee.name }).first();
      await row.waitFor({ state: 'visible', timeout: 15_000 });
      await row.getByRole('button', { name: '在 Quest 中使用' }).click();
      const picker = page.getByRole('dialog', { name: `选择 ${employee.name} 使用的项目` });
      await picker.waitFor({ state: 'visible', timeout: 15_000 });
      const projectRadio = picker.locator(`input[type="radio"][value="${project.id}"]`);
      const projectOption = projectRadio.locator('xpath=ancestor::label');
      await projectOption.waitFor({ state: 'visible', timeout: 30_000 });
      report.projectOptions.push({
        employeeId: employee.id,
        employeeName: employee.name,
        options: await picker.locator('label').evaluateAll((labels) => labels.map((label) => ({
          text: label.textContent?.trim() || '',
          disabled: Boolean(label.querySelector('input[type="radio"]')?.disabled)
        })))
      });
      await projectRadio.check();
      await picker.getByRole('button', { name: '打开 Quest' }).click();
      await page.locator('.topbar-title').filter({ hasText: 'Quest' }).waitFor({ timeout: 15_000 });
      await page.locator('[aria-label="Quest 项目与员工上下文"]').waitFor({ timeout: 15_000 });

      const contentId = await waitFor(embeddedContents, 30_000, `embedded Hermes for ${employee.name}`);
      const conversation = await waitFor(async () => {
        const response = await projectRead(contentId, 'conversations');
        if (response.status !== 200 || !response.body?.ok) return null;
        const candidates = (response.body.result || []).filter((item) => (
          item.employee?.id === employee.id && !previousConversationIds.has(item.conversationId)
        ));
        return candidates.sort((left, right) => right.updatedAt - left.updatedAt)[0] || null;
      }, 30_000, `conversation for ${employee.name}`);
      const selectedTab = await waitFor(async () => withTimeout(application.evaluate(({ webContents }, input) => {
        const contents = webContents.fromId(input.id);
        if (!contents || contents.isDestroyed()) return null;
        return contents.executeJavaScript(`(() => {
          const tabs = [...document.querySelectorAll('[data-nexus-conversation-tabs] > div')];
          const tab = tabs.find((item) => item.querySelector('button')?.textContent?.trim() === ${JSON.stringify(`@${input.name}`)});
          if (!tab || !tab.classList.contains('bg-background-base')) return null;
          return {
            text: tab.textContent?.trim() || '',
            className: tab.className,
            conversationId: document.documentElement.dataset.nexusConversationId || null,
            url: location.href
          };
        })()`, true);
      }, { id: contentId, name: employee.name }), 10_000, `inspect selected Tab for ${employee.name}`), 30_000, `selected Tab for ${employee.name}`);
      if (selectedTab.conversationId !== conversation.conversationId) {
        fail(`Main/Web UI conversation acknowledgement is stale for ${employee.name}: ${safeText(JSON.stringify(selectedTab))}`);
      }
      const composerIdentity = await withTimeout(application.evaluate(({ webContents }, input) => {
        const contents = webContents.fromId(input.id);
        if (!contents || contents.isDestroyed()) throw new Error('Hermes WebContents is unavailable');
        return contents.executeJavaScript(`(() => {
          const textarea = document.querySelector('textarea');
          return textarea instanceof HTMLTextAreaElement
            ? { placeholder: textarea.placeholder, value: textarea.value }
            : null;
        })()`, true);
      }, { id: contentId }), 10_000, `inspect composer identity for ${employee.name}`);
      if (!composerIdentity || composerIdentity.placeholder !== `给 ${employee.name} 下达任务` || composerIdentity.value) {
        fail(`Composer identity did not switch cleanly to ${employee.name}: ${safeText(JSON.stringify(composerIdentity))}`);
      }

      const message = `不要调用工具。只回复：身份=${employee.name}`;
      const beforeQueue = await projectRead(contentId, 'chat-queue');
      if (beforeQueue.status !== 200 || !beforeQueue.body?.ok) fail(`Could not read chat queue for ${employee.name}`);
      const beforeQueueIds = new Set(beforeQueue.body.result.map((item) => item.id));
      const uiSubmission = await withTimeout(application.evaluate(async ({ webContents }, input) => {
        const contents = webContents.fromId(input.id);
        if (!contents || contents.isDestroyed()) throw new Error('Hermes WebContents is unavailable');
        const expression = `new Promise((resolve, reject) => {
          const textarea = document.querySelector('textarea');
          if (!(textarea instanceof HTMLTextAreaElement) || textarea.placeholder !== ${JSON.stringify(`给 ${input.employeeName} 下达任务`)} || !textarea.form) {
            reject(new Error('Quest chat composer is unavailable'));
            return;
          }
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          if (!setter) {
            reject(new Error('Quest chat composer value setter is unavailable'));
            return;
          }
          setter.call(textarea, ${JSON.stringify(input.message)});
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          textarea.focus();
          setTimeout(() => {
            textarea.form.requestSubmit();
            setTimeout(() => resolve({
              inputDisabled: textarea.disabled,
              inputValueAfterSubmit: textarea.value,
              sendDisabled: Boolean(textarea.form?.querySelector('button[aria-label="发送"]')?.disabled)
            }), 150);
          }, 50);
        })`;
        return contents.executeJavaScript(expression, true);
      }, { id: contentId, message, employeeName: employee.name }), 15_000, `submit visible message for ${employee.name}`);
      if (uiSubmission.inputDisabled || uiSubmission.inputValueAfterSubmit) {
        fail(`Quest composer did not return to an editable empty state for ${employee.name}: ${safeText(JSON.stringify(uiSubmission))}`);
      }
      const queuedItem = await waitFor(async () => {
        const current = await projectRead(contentId, 'chat-queue');
        if (current.status !== 200 || !current.body?.ok) return null;
        return current.body.result.find((item) => (
          !beforeQueueIds.has(item.id)
          && item.conversationId === conversation.conversationId
          && item.message === message
        )) || null;
      }, 15_000, `queued UI message for ${employee.name}`);
      const editableDuringRun = await withTimeout(application.evaluate(async ({ webContents }, input) => {
        const contents = webContents.fromId(input.id);
        if (!contents || contents.isDestroyed()) throw new Error('Hermes WebContents is unavailable');
        const expression = `(() => {
          const textarea = document.querySelector('textarea');
          if (!(textarea instanceof HTMLTextAreaElement)) return null;
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          if (!setter) return null;
          setter.call(textarea, '队列执行期间仍可继续输入');
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          const evidence = { disabled: textarea.disabled, value: textarea.value };
          setter.call(textarea, '');
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          return evidence;
        })()`;
        return contents.executeJavaScript(expression, true);
      }, { id: contentId, employeeName: employee.name }), 10_000, `inspect composer while ${employee.name} runs`);
      if (!editableDuringRun || editableDuringRun.disabled || editableDuringRun.value !== '队列执行期间仍可继续输入') {
        fail(`Quest composer was blocked while ${employee.name} was running`);
      }
      const completed = await waitFor(async () => {
        const current = await projectRead(contentId, 'chat-queue');
        const item = current.body?.ok ? current.body.result.find((candidate) => candidate.id === queuedItem.id) : null;
        if (item && ['FAILED', 'CANCELLED'].includes(item.status)) {
          throw new Error(item.error || `Queue item ended as ${item.status}`);
        }
        const historyResponse = await projectRequest(contentId, 'chat-history', {
          conversationId: conversation.conversationId
        });
        if (historyResponse.status !== 200 || !historyResponse.body?.ok) return null;
        const assistant = [...(historyResponse.body.result.messages || [])].reverse().find((entry) => (
          entry.role === 'assistant' && String(entry.content || '').includes(employee.name)
        ));
        return assistant ? { assistant, queueStatus: item?.status || 'REMOVED' } : null;
      }, 180_000, `completed UI reply for ${employee.name}`);
      const content = String(completed.assistant.content);
      if (!content.includes(employee.name) || /(?:Hermes|Cordis|DSH)/i.test(content.replace(employee.name, ''))) {
        fail(`Card conversation used a stale identity for ${employee.name}: ${safeText(content)}`);
      }
      const visibleAssistantReply = await waitFor(async () => withTimeout(application.evaluate(({ webContents }, input) => {
        const contents = webContents.fromId(input.id);
        if (!contents || contents.isDestroyed()) return null;
        return contents.executeJavaScript(`(() => {
          const expectedName = ${JSON.stringify(input.name)};
          const expectedContent = ${JSON.stringify(input.content)};
          const articles = [...document.querySelectorAll('article')];
          const article = articles.find((item) => {
            const header = item.querySelector('div')?.textContent?.trim() || '';
            return header === expectedName && (item.innerText || '').includes(expectedContent);
          });
          if (!article) return null;
          return {
            assistantName: article.querySelector('div')?.textContent?.trim() || '',
            text: article.innerText?.trim() || ''
          };
        })()`, true);
      }, { id: contentId, name: employee.name, content }), 10_000, `inspect visible reply for ${employee.name}`), 30_000, `visible assistant reply for ${employee.name}`);
      report.employees.push({
        id: employee.id,
        name: employee.name,
        role: employee.role,
        conversationId: conversation.conversationId,
        tab: selectedTab,
        reply: content,
        visibleAssistantReply,
        composerIdentity,
        queue: {
          id: queuedItem.id,
          initialStatus: queuedItem.status,
          statusWhenReplyPersisted: completed.queueStatus,
          composerEditableDuringRun: true
        }
      });
      const draftMarker = `未发送草稿-${employee.name}`;
      await withTimeout(application.evaluate(({ webContents }, input) => {
        const contents = webContents.fromId(input.id);
        if (!contents || contents.isDestroyed()) throw new Error('Hermes WebContents is unavailable');
        return contents.executeJavaScript(`(() => {
          const textarea = document.querySelector('textarea[placeholder=${JSON.stringify(`给 ${input.name} 下达任务`)}]');
          if (!(textarea instanceof HTMLTextAreaElement)) return null;
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          if (!setter) return null;
          setter.call(textarea, ${JSON.stringify(input.marker)});
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          return textarea.value;
        })()`, true);
      }, { id: contentId, name: employee.name, marker: draftMarker }), 10_000, `store draft for ${employee.name}`);
      expectedDrafts.set(conversation.conversationId, { name: employee.name, value: draftMarker });
      const after = await projectRead(contentId, 'conversations');
      if (after.status !== 200 || !after.body?.ok) fail(`Could not refresh conversations after ${employee.name}`);
      previousConversationIds = new Set(after.body.result.map((item) => item.conversationId));
    }
    const finalContentId = await waitFor(embeddedContents, 10_000, 'final embedded Hermes');
    for (const [conversationId, expected] of expectedDrafts) {
      const restored = await waitFor(async () => withTimeout(application.evaluate(({ webContents }, input) => {
        const contents = webContents.fromId(input.id);
        if (!contents || contents.isDestroyed()) return null;
        return contents.executeJavaScript(`(() => {
          const tabs = [...document.querySelectorAll('[data-nexus-conversation-tabs] button')];
          const tab = tabs.find((button) => button.textContent?.trim() === ${JSON.stringify(`@${input.name}`)});
          if (!(tab instanceof HTMLButtonElement)) return null;
          tab.click();
          return new Promise((resolve) => setTimeout(() => {
            const textarea = document.querySelector('textarea');
            resolve(textarea instanceof HTMLTextAreaElement
              ? { placeholder: textarea.placeholder, value: textarea.value }
              : null);
          }, 150));
        })()`, true);
      }, { id: finalContentId, name: expected.name }), 10_000, `restore draft for ${expected.name}`), 10_000, `restore draft for ${expected.name}`);
      if (restored.placeholder !== `给 ${expected.name} 下达任务` || restored.value !== expected.value) {
        fail(`Tab draft or identity leaked for ${expected.name}: ${safeText(JSON.stringify(restored))}`);
      }
      const employeeReport = report.employees.find((item) => item.conversationId === conversationId);
      if (employeeReport) employeeReport.restoredDraft = restored;
    }
    await withTimeout(application.evaluate(({ webContents }, id) => {
      const contents = webContents.fromId(id);
      if (!contents || contents.isDestroyed()) return null;
      return contents.executeJavaScript(`(() => {
        const textarea = document.querySelector('textarea');
        if (!(textarea instanceof HTMLTextAreaElement)) return null;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (!setter) return null;
        setter.call(textarea, '');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`, true);
    }, finalContentId), 10_000, 'clear acceptance draft');
    const screenshot = await withTimeout(application.evaluate(async ({ webContents }, id) => {
      const contents = webContents.fromId(id);
      if (!contents || contents.isDestroyed()) throw new Error('Hermes WebContents is unavailable');
      return (await contents.capturePage()).toPNG().toString('base64');
    }, finalContentId), 15_000, 'capture final embedded Hermes screenshot');
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot, 'base64'));
    if (report.consoleErrors.length > 0) fail(`Renderer errors: ${report.consoleErrors.join(' | ')}`);
    report.result = 'PASS';
  } catch (error) {
    report.result = 'FAIL';
    report.error = safeText(error instanceof Error ? error.stack || error.message : error);
    throw error;
  } finally {
    report.completedAt = new Date().toISOString();
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await withTimeout(application.close(), 15_000, 'close Electron acceptance instance').catch(() => {
      application.process().kill();
    });
  }
  process.stdout.write(`${JSON.stringify({ result: report.result, reportPath, project: report.project, employees: report.employees }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(safeText(error instanceof Error ? error.stack || error.message : error));
  process.exitCode = 1;
});
