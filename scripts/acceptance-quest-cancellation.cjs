'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const evidenceRoot = path.resolve(
  process.env.AIBOX_CANCEL_ACCEPTANCE_OUTPUT
    || path.join(root, 'tmp', 'acceptance-quest-cancellation', stamp)
);
const sourceUserData = (process.env.AIBOX_CANCEL_ACCEPTANCE_SEED_USER_DATA || '').trim();
if (!sourceUserData || !fs.statSync(sourceUserData, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error('AIBOX_CANCEL_ACCEPTANCE_SEED_USER_DATA must point to configured OPC-Nexus user data');
}

const userData = path.join(evidenceRoot, 'user-data');
const reportPath = path.join(evidenceRoot, 'report.json');
const screenshotPath = path.join(evidenceRoot, 'cancelled-turn-and-follow-up.png');
fs.mkdirSync(evidenceRoot, { recursive: true });
fs.cpSync(sourceUserData, userData, { recursive: true, force: true });

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceUserData,
  userData,
  project: null,
  employee: null,
  conversationId: null,
  cancelledTurn: null,
  followUpTurn: null,
  transcript: null,
  cancellationLogEvidence: [],
  screenshotPath,
  consoleErrors: [],
  result: 'RUNNING'
};

function safeText(value) {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/gi, 'sk-[REDACTED]')
    .slice(0, 10_000);
}

function fail(message) {
  throw new Error(`[quest-cancellation] ${message}`);
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
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  fail(`${label} timed out${lastError ? `: ${safeText(lastError.message || lastError)}` : ''}`);
}

class FatalAcceptanceError extends Error {}

async function waitForOrFail(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      if (error instanceof FatalAcceptanceError) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  fail(`${label} timed out${lastError ? `: ${safeText(lastError.message || lastError)}` : ''}`);
}

function collectLogEvidence(searchRoots, marker) {
  const hits = [];
  const seen = new Set();
  const visit = (current, depth) => {
    if (depth > 6 || hits.length >= 20) return;
    const resolved = path.resolve(current);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    let entries;
    try { entries = fs.readdirSync(resolved, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (hits.length >= 20) break;
      const fullPath = path.join(resolved, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', 'Cache', 'Code Cache', 'GPUCache'].includes(entry.name)) {
          visit(fullPath, depth + 1);
        }
        continue;
      }
      if (!/\.(?:log|txt|jsonl)$/i.test(entry.name)) continue;
      let content;
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > 16 * 1024 * 1024) continue;
        content = fs.readFileSync(fullPath, 'utf8');
      } catch { continue; }
      const index = content.indexOf(marker);
      if (index >= 0) {
        hits.push({
          path: fullPath,
          excerpt: safeText(content.slice(Math.max(0, index - 240), index + marker.length + 240))
        });
      }
    }
  };
  for (const searchRoot of searchRoots) visit(searchRoot, 0);
  return hits;
}

async function main() {
  const application = await electron.launch({
    executablePath: process.env.AIBOX_CANCEL_ACCEPTANCE_EXECUTABLE || require('electron'),
    args: process.env.AIBOX_CANCEL_ACCEPTANCE_EXECUTABLE ? [] : ['.'],
    cwd: root,
    env: {
      ...process.env,
      AIBOX_USER_DATA_DIR: userData,
      AIBOX_DISABLE_HARDWARE_ACCELERATION: '1',
      AIBOX_DEBUG_MODE: '1'
    },
    timeout: 60_000
  });
  let page;
  try {
    page = await application.firstWindow({ timeout: 60_000 });
    page.on('console', (message) => {
      if (message.type() === 'error') report.consoleErrors.push(`console: ${safeText(message.text())}`);
    });
    page.on('pageerror', (error) => report.consoleErrors.push(`page: ${safeText(error.message)}`));
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });

    const snapshot = await page.evaluate(() => window.aibox.getSnapshot());
    const employee = snapshot.agentCards
      .map((card) => card.agent)
      .find((agent) => agent.lifecycle === 'READY' && !agent.archived && agent.engineId !== 'eng-deepseek-harness-managed');
    if (!employee) fail('A READY non-DSH employee is required');
    report.employee = { id: employee.id, name: employee.name, role: employee.role };

    const project = await page.evaluate(() => window.aibox.createProject({
      name: 'Quest 真实取消验收',
      objective: '验证老板取消长任务后 Hermes 真正停止且不会污染下一条指令',
      description: '动态组队项目，仅用于隔离的真实取消与后续任务验收。',
      status: 'active',
      workspaceMode: 'automatic'
    }));
    report.project = { id: project.id, name: project.name, workspacePath: project.workspacePath || null };
    const runtimeModel = await page.evaluate(async (projectId) => {
      const providers = await window.aibox.listProviders();
      const provider = providers.find((item) => item.isDefault && item.hasKey)
        || providers.find((item) => item.hasKey);
      if (!provider) throw new Error('No configured Provider is available');
      const models = await window.aibox.fetchProviderModels(provider.id);
      if (!models.ok || models.models.length === 0) {
        throw new Error(models.error || 'The Provider returned no models');
      }
      const model = models.models.includes('deepseek-v4-pro-0813')
        ? 'deepseek-v4-pro-0813'
        : models.models.find((item) => /(?:pro|max|sonnet|gpt-5)/i.test(item))
          || provider.model;
      const probe = await window.aibox.testProviderById(provider.id);
      if (!probe.ok) throw new Error(probe.error || 'The Provider connection probe failed');
      await window.aibox.saveQuestSettings(projectId, {
        mode: 'quest', orchestrator: 'hermes', sandbox: 'workspace', permissionMode: 'standard',
        model, workerAgentIds: [], pluginIds: [], maxParallel: 3, autoApproveLowRisk: false
      });
      return { providerId: provider.id, model, latencyMs: probe.latencyMs };
    }, project.id);
    report.project.runtimeModel = runtimeModel.model;

    // 预热 Quest 页面：嵌入的 Hermes WebContents 只有在 Quest 页面挂载并调用
    // openEmbeddedHermesWorkbench 之后才会创建。若跳过这一步、直接走员工卡片
    // 弹层，第一次解析到的是预热前遗留的旧 WebContents，从弹层跳转到 Quest 时
    // 渲染器先关闭旧 view 再开新的，脚本抓到的 contentId 在提交消息那一刻已经
    // destroyed —— 表现为 "Quest composer unavailable"。
    await page.locator('.nav-item').filter({ hasText: 'Quest' }).click();
    await page.locator('.topbar-title').filter({ hasText: 'Quest' }).waitFor({ timeout: 15_000 });

    await page.locator('.nav-item').filter({ hasText: '数字员工' }).click();
    await page.locator('.topbar-title').filter({ hasText: '数字员工' }).waitFor({ timeout: 15_000 });
    const row = page.locator('tbody tr').filter({ hasText: employee.name }).first();
    await row.waitFor({ state: 'visible', timeout: 15_000 });
    await row.getByRole('button', { name: '在 Quest 中使用' }).click();
    const picker = page.getByRole('dialog', { name: `选择 ${employee.name} 使用的项目` });
    await picker.waitFor({ state: 'visible', timeout: 15_000 });
    const projectOption = picker.locator('label').filter({ hasText: project.name });
    await projectOption.waitFor({ state: 'visible', timeout: 30_000 });
    await projectOption.getByRole('radio').check();
    await picker.getByRole('button', { name: '打开 Quest' }).click();
    await page.locator('.topbar-title').filter({ hasText: 'Quest' }).waitFor({ timeout: 15_000 });

    const embeddedContentsId = async () => {
      const runtime = await page.evaluate((projectId) => window.aibox.getHermesRuntimeStatus(projectId), project.id);
      if (!runtime.proxyPort) return null;
      return withTimeout(application.evaluate(async ({ webContents }, port) => {
        const candidates = webContents.getAllWebContents().filter((candidate) => {
          try { return new URL(candidate.getURL()).port === String(port); }
          catch { return false; }
        }).reverse();
        for (const contents of candidates) {
          if (contents.isDestroyed()) continue;
          try {
            const ready = await contents.executeJavaScript(`(() => ({
              chat: location.pathname === '/chat',
              composer: Boolean(document.querySelector('[data-nexus-composer] textarea')),
              composerReady: document.querySelector('[data-nexus-composer]')?.textContent?.includes('就绪') === true,
              visible: document.visibilityState === 'visible'
            }))()`, true);
            if (ready?.chat && ready?.composer && ready?.composerReady && ready?.visible) return contents.id;
          } catch { /* the view may be between navigation generations */ }
        }
        return null;
      }, runtime.proxyPort), 10_000, 'resolve embedded Hermes WebContents');
    };
    await waitFor(async () => {
      const runtime = await page.evaluate((projectId) => window.aibox.getHermesRuntimeStatus(projectId), project.id);
      if (runtime.state === 'error') throw new FatalAcceptanceError(runtime.lastError || 'Hermes startup failed');
      return runtime.state === 'healthy' && runtime.proxyPort ? runtime : null;
    }, 90_000, 'Hermes execution Gateway health');
    await waitFor(embeddedContentsId, 60_000, 'embedded Hermes');

    const execute = async (expression, label, timeoutMs = 15_000) => {
      const contentId = await waitFor(embeddedContentsId, 20_000, `current embedded Hermes for ${label}`);
      return withTimeout(application.evaluate(({ webContents }, input) => {
        const contents = webContents.fromId(input.id);
        if (!contents || contents.isDestroyed()) throw new Error('Hermes WebContents is unavailable');
        return contents.executeJavaScript(input.expression, true);
      }, { id: contentId, expression }),
      timeoutMs,
      label
      );
    };
    const projectRequest = (operation, payload) => execute(`fetch(${JSON.stringify(`/__opc_nexus/project/${operation}`)}, {
      method: ${payload === undefined ? JSON.stringify('GET') : JSON.stringify('POST')},
      credentials: 'include',
      headers: {'content-type':'application/json'},
      ${payload === undefined ? '' : `body:${JSON.stringify(JSON.stringify(payload))},`}
    }).then(async response => ({status:response.status, body:await response.json()}))`, `project request ${operation}`);

    const conversations = await waitFor(async () => {
      const response = await projectRequest('conversations');
      const conversation = response.body?.ok
        ? response.body.result.find((item) => item.employee?.id === employee.id)
        : null;
      return conversation || null;
    }, 30_000, 'employee conversation');
    report.conversationId = conversations.conversationId;
    const cancelledReceipt = `已由老板取消；${employee.name} 不会继续执行这条指令。`;

    const submitVisibleMessage = async (message) => {
      const contentId = await waitFor(embeddedContentsId, 20_000, 'current embedded Hermes for visible input');
      const entered = await withTimeout(application.evaluate(async ({ webContents }, input) => {
        const contents = webContents.fromId(input.id);
        if (!contents || contents.isDestroyed()) throw new Error('Hermes WebContents is unavailable');
        await contents.executeJavaScript(`(() => {
          const textarea = document.querySelector('[data-nexus-composer] textarea');
          if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Quest composer unavailable');
          textarea.focus();
          textarea.select();
        })()`, true);
        contents.focus();
        await contents.insertText(input.message);
        return contents.executeJavaScript(`(() => {
          const textarea = document.querySelector('[data-nexus-composer] textarea');
          const send = textarea?.form?.querySelector('button[aria-label="发送"]');
          return textarea instanceof HTMLTextAreaElement
            ? {value:textarea.value, disabled:textarea.disabled, sendDisabled:Boolean(send?.disabled)}
            : null;
        })()`, true);
      }, { id: contentId, message }), 15_000, 'type into visible Quest composer');
      if (!entered || entered.value !== message || entered.disabled || entered.sendDisabled) {
        fail(`Visible Quest input did not accept the instruction: ${safeText(JSON.stringify(entered))}`);
      }
      return execute(`new Promise((resolve, reject) => {
        const textarea = document.querySelector('[data-nexus-composer] textarea');
        if (!(textarea instanceof HTMLTextAreaElement) || !textarea.form) return reject(new Error('Quest composer unavailable'));
        textarea.form.requestSubmit();
        const startedAt = Date.now();
        let everDisabled = textarea.disabled;
        const timer = setInterval(() => {
          everDisabled ||= textarea.disabled;
          if (!textarea.value || Date.now() - startedAt >= 3_000) {
            clearInterval(timer);
            resolve({disabled:textarea.disabled, everDisabled, value:textarea.value, admissionMs:Date.now() - startedAt});
          }
        }, 25);
      })`, 'submit visible Quest message');
    };

    const longMessage = [
      '这是取消机制验收。请务必调用 terminal 工具，在项目目录运行：',
      'node -e "setTimeout(() => console.log(\'OLD_TASK_COMPLETED\'), 60000)"',
      '必须等待命令结束后才回复 OLD_TASK_COMPLETED，不要提前回复，不要改用其他方法。'
    ].join('\n');
    const beforeQueue = await projectRequest('chat-queue');
    const beforeIds = new Set((beforeQueue.body?.result || []).map((item) => item.id));
    const submission = await submitVisibleMessage(longMessage);
    if (submission.disabled || submission.everDisabled || submission.value) {
      fail(`Composer was not reusable after queue admission: ${safeText(JSON.stringify(submission))}`);
    }
    const running = await waitFor(async () => {
      const response = await projectRequest('chat-queue');
      return (response.body?.result || []).find((item) => (
        !beforeIds.has(item.id)
        && item.conversationId === conversations.conversationId
        && item.message === longMessage
        && item.status === 'RUNNING'
      )) || null;
    }, 20_000, 'long turn running');

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const cancelClick = await execute(`(() => {
      const buttons = [...document.querySelectorAll('button[aria-label="取消任务"]')];
      const button = buttons.find((candidate) => candidate.getClientRects().length > 0);
      if (!(button instanceof HTMLButtonElement)) return {clicked:false};
      button.click();
      return {clicked:true, title:button.title};
    })()`, 'click visible cancellation button');
    if (!cancelClick.clicked) fail('Visible cancellation button was not found');

    const cancelling = await waitFor(async () => {
      const response = await projectRequest('chat-queue');
      return (response.body?.result || []).find((item) => (
        item.id === running.id
        && item.status === 'RUNNING'
        && Number.isFinite(item.cancelRequestedAt)
      )) || null;
    }, 15_000, 'persisted cancellation request');
    const prematureReceipt = await execute(`(() => document.body.innerText.includes(
      ${JSON.stringify(cancelledReceipt)}
    ))()`, 'inspect premature cancellation receipt');
    if (prematureReceipt) fail('Quest claimed cancellation before Hermes executor settlement');
    const cancelled = await waitFor(async () => {
      const response = await projectRequest('chat-queue');
      return (response.body?.result || []).find((item) => item.id === running.id && item.status === 'CANCELLED') || null;
    }, 45_000, 'cancelled queue receipt');
    const cancellationUi = await waitFor(() => execute(`(() => {
      const text = document.body.innerText;
      return text.includes(${JSON.stringify(cancelledReceipt)})
        ? {visible:true, excerpt:${JSON.stringify(cancelledReceipt)}}
        : null;
    })()`, 'inspect cancellation receipt'), 15_000, 'visible cancellation receipt');
    report.cancelledTurn = {
      id: running.id,
      status: cancelled.status,
      attempts: cancelled.attempts,
      partialContent: cancelled.partialContent,
      cancelRequestedAt: cancelling.cancelRequestedAt,
      visibleReceipt: cancellationUi,
      cancelButton: cancelClick
    };

    const followUpMessage = '上一条任务已经取消，绝对不要继续它。不要调用工具。只回复：NEXT_TASK_OK';
    const queueBeforeFollowUp = await projectRequest('chat-queue');
    const idsBeforeFollowUp = new Set((queueBeforeFollowUp.body?.result || []).map((item) => item.id));
    await submitVisibleMessage(followUpMessage);
    const followUp = await waitFor(async () => {
      const response = await projectRequest('chat-queue');
      return (response.body?.result || []).find((item) => (
        !idsBeforeFollowUp.has(item.id)
        && item.conversationId === conversations.conversationId
        && item.message === followUpMessage
      )) || null;
    }, 15_000, 'follow-up queue item');
    const history = await waitForOrFail(async () => {
      const queueResponse = await projectRequest('chat-queue');
      const queueItem = (queueResponse.body?.result || []).find((item) => item.id === followUp.id);
      if (queueItem?.status === 'FAILED') {
        report.followUpTurn = {
          id: followUp.id,
          finalQueueStatus: 'FAILED',
          error: queueItem.error || 'Hermes upstream failure'
        };
        report.result = 'BLOCKED_EXTERNAL';
        throw new FatalAcceptanceError(`Follow-up failed: ${queueItem.error || 'Hermes upstream failure'}`);
      }
      const response = await projectRequest('chat-history', { conversationId: conversations.conversationId });
      if (!response.body?.ok) return null;
      const messages = response.body.result.messages || [];
      return messages.some((item) => item.role === 'assistant' && item.content.includes('NEXT_TASK_OK'))
        ? response.body.result
        : null;
    }, 120_000, 'follow-up completion');
    const finalQueue = await projectRequest('chat-queue');
    const cancelledClosure = history.messages.find((item) => (
      item.role === 'assistant' && item.content.includes('Do not continue this instruction')
    ));
    const nextReply = history.messages.findLast((item) => item.role === 'assistant' && item.content.includes('NEXT_TASK_OK'));
    const oldTaskCompleted = history.messages.some((item) => item.content.includes('OLD_TASK_COMPLETED') && item.role === 'assistant');
    if (!cancelledClosure) fail('Hermes transcript has no explicit cancelled-turn closure');
    if (!nextReply) fail('Follow-up instruction did not complete');
    if (oldTaskCompleted) fail('Cancelled task still completed in the Hermes transcript');
    report.followUpTurn = {
      id: followUp.id,
      finalQueueStatus: (finalQueue.body?.result || []).find((item) => item.id === followUp.id)?.status || 'REMOVED',
      reply: nextReply.content
    };
    report.transcript = {
      hermesSessionId: history.hermesSessionId,
      messageCount: history.messages.length,
      hasCancelledClosure: true,
      hasOldTaskCompletion: false,
      tail: history.messages.slice(-6).map((item) => ({ role: item.role, content: safeText(item.content) }))
    };

    await page.screenshot({ path: screenshotPath, fullPage: true });
    report.cancellationLogEvidence = collectLogEvidence(
      [userData, path.join(root, 'user', 'logs')],
      'interrupted Nexus session agent after cancellation request'
    );
    if (report.cancellationLogEvidence.length === 0) {
      fail('No redacted Hermes cancellation log evidence was found');
    }
    if (report.consoleErrors.length > 0) fail(`Renderer errors: ${report.consoleErrors.join(' | ')}`);
    report.result = 'PASS';
    report.completedAt = new Date().toISOString();
  } catch (error) {
    if (report.result !== 'BLOCKED_EXTERNAL') report.result = 'FAIL';
    report.error = safeText(error?.stack || error);
    report.completedAt = new Date().toISOString();
    if (page) {
      try { await page.screenshot({ path: screenshotPath, fullPage: true }); }
      catch { /* preserve the primary failure */ }
    }
    throw error;
  } finally {
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    await withTimeout(application.close(), 15_000, 'close Electron').catch(async () => {
      const process = application.process();
      if (process && !process.killed) process.kill();
    });
  }
}

main().catch((error) => {
  console.error(safeText(error?.stack || error));
  process.exitCode = 1;
});
