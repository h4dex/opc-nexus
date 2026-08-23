'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.AIBOX_CRASH_ACCEPTANCE_OUTPUT
  || path.join(root, 'tmp', 'acceptance-hermes-crash-recovery', new Date().toISOString().replace(/[:.]/g, '-')));
const seed = path.resolve(process.env.AIBOX_CRASH_ACCEPTANCE_SEED_USER_DATA || '');
if (!fs.statSync(seed, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error('AIBOX_CRASH_ACCEPTANCE_SEED_USER_DATA must point to configured OPC-Nexus user data');
}
const userData = path.join(output, 'user-data');
const screenshotPath = path.join(output, 'runtime-recovered.png');
const reportPath = path.join(output, 'report.json');
fs.mkdirSync(output, { recursive: true });
fs.cpSync(seed, userData, { recursive: true, force: true });

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  seed,
  userData,
  projectId: null,
  crashedPid: null,
  crashedStatus: null,
  visibleRecovery: null,
  recoveredStatus: null,
  consoleErrors: [],
  screenshotPath,
  result: 'RUNNING'
};

function safeText(value) {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/gi, 'sk-[REDACTED]')
    .slice(0, 10_000);
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
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`${label} timed out${lastError ? `: ${safeText(lastError.message || lastError)}` : ''}`);
}

async function main() {
  const application = await electron.launch({
    executablePath: process.env.AIBOX_CRASH_ACCEPTANCE_EXECUTABLE || require('electron'),
    args: process.env.AIBOX_CRASH_ACCEPTANCE_EXECUTABLE ? [] : ['.'],
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
    await page.locator('.nav-item').filter({ hasText: 'Quest' }).click();
    await page.locator('.quest-workbench').waitFor({ state: 'visible', timeout: 30_000 });

    report.projectId = await waitFor(() => page.evaluate(async () => {
      const select = document.querySelector('select[aria-label="Quest 项目上下文"]');
      if (select instanceof HTMLSelectElement && select.value) return select.value;
      const name = document.querySelector('.quest-project-heading strong')?.textContent?.trim();
      if (!name) return null;
      const snapshot = await window.aibox.getSnapshot();
      return snapshot.projects.find((project) => project.name === name)?.id ?? null;
    }), 15_000, 'resolve active Quest project');

    const healthy = await waitFor(async () => {
      const status = await page.evaluate((projectId) => window.aibox.getHermesRuntimeStatus(projectId), report.projectId);
      return status.state === 'healthy' && Number.isInteger(status.pid) ? status : null;
    }, 90_000, 'Hermes healthy before crash');
    await page.locator('.quest-embed-status.is-ready').waitFor({ state: 'visible', timeout: 30_000 });
    report.crashedPid = healthy.pid;

    await application.evaluate((_electron, pid) => {
      process.kill(pid, 'SIGKILL');
    }, healthy.pid);

    report.crashedStatus = await waitFor(async () => {
      const status = await page.evaluate((projectId) => window.aibox.getHermesRuntimeStatus(projectId), report.projectId);
      return status.state === 'error' ? status : null;
    }, 20_000, 'authoritative Hermes crash status');
    const recovery = page.locator('.quest-embedded-state.error');
    await recovery.waitFor({ state: 'visible', timeout: 10_000 });
    report.visibleRecovery = safeText(await recovery.innerText());
    if (!report.visibleRecovery.includes('Hermes 工作区连接失败') || !report.visibleRecovery.includes('重试')) {
      throw new Error(`Crash recovery UI is incomplete: ${report.visibleRecovery}`);
    }

    await recovery.getByRole('button', { name: '重试' }).click();
    report.recoveredStatus = await waitFor(async () => {
      const status = await page.evaluate((projectId) => window.aibox.getHermesRuntimeStatus(projectId), report.projectId);
      return status.state === 'healthy' && status.pid !== report.crashedPid ? status : null;
    }, 90_000, 'Hermes restart after crash');
    await page.locator('.quest-embed-status.is-ready').waitFor({ state: 'visible', timeout: 30_000 });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    if (report.consoleErrors.length > 0) throw new Error(`Renderer errors: ${report.consoleErrors.join(' | ')}`);
    report.result = 'PASS';
    report.completedAt = new Date().toISOString();
  } catch (error) {
    report.result = 'FAIL';
    report.error = safeText(error?.stack || error);
    report.completedAt = new Date().toISOString();
    if (page) {
      try { await page.screenshot({ path: screenshotPath, fullPage: true }); } catch { /* keep primary error */ }
    }
    throw error;
  } finally {
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    let applicationProcess = null;
    try { applicationProcess = application.process(); } catch { /* application may already be closed */ }
    await Promise.race([
      application.close(),
      new Promise((resolve) => setTimeout(resolve, 15_000))
    ]);
    if (applicationProcess && !applicationProcess.killed && applicationProcess.exitCode === null) {
      applicationProcess.kill();
    }
  }
}

main().catch((error) => {
  console.error(safeText(error?.stack || error));
  process.exitCode = 1;
});
