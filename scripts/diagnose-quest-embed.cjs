'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const userData = path.resolve(process.env.AIBOX_DIAGNOSTIC_USER_DATA || '');
const output = path.resolve(process.env.AIBOX_DIAGNOSTIC_OUTPUT || path.join(root, 'tmp', 'quest-embed-diagnostic'));
if (!fs.statSync(userData, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error('AIBOX_DIAGNOSTIC_USER_DATA must be an existing directory');
}
fs.mkdirSync(output, { recursive: true });

(async () => {
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
  const report = { generatedAt: new Date().toISOString(), console: [] };
  try {
    const page = await application.firstWindow({ timeout: 60_000 });
    page.on('console', (message) => {
      if (message.type() === 'error') report.console.push(message.text());
    });
    page.on('pageerror', (error) => report.console.push(error.message));
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('.nav-item').filter({ hasText: 'Quest' }).click();
    // Hermes cold-start includes Python import, Dashboard and Gateway boot;
    // on Windows this routinely exceeds 15 seconds. Wait for the actual
    // embedded status instead of sampling the transient loading state.
    let embeddedReady = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const status = await page.evaluate(() => window.aibox.getEmbeddedHermesWorkbenchStatus());
      const runtimeReady = status.runtime?.state === 'healthy' || status.runtime?.state === 'degraded';
      if (status.open === true && status.attached === true && status.visible === true && runtimeReady) {
        embeddedReady = true;
        break;
      }
      await page.waitForTimeout(1_000);
    }
    if (!embeddedReady) report.embedWaitError = 'Quest embedded Hermes Workbench did not become visible within 60 seconds';
    const snapshot = await page.evaluate(() => window.aibox.getSnapshot());
    report.ui = await page.evaluate(() => {
      const rect = (selector) => {
        const value = document.querySelector(selector)?.getBoundingClientRect();
        return value ? { x: value.x, y: value.y, width: value.width, height: value.height } : null;
      };
      return {
        topbar: document.querySelector('.topbar-title')?.textContent?.trim() || '',
        mainText: (document.querySelector('main.content')?.textContent || '').trim().slice(0, 8_000),
        context: rect('.quest-context'),
        embedded: rect('.quest-embedded-host'),
        governance: rect('.quest-governance')
      };
    });
    report.embeddedStatus = await page.evaluate(() => window.aibox.getEmbeddedHermesWorkbenchStatus());
    report.projects = [];
    for (const project of snapshot.projects.filter((item) => item.status !== 'archived')) {
      report.projects.push({
        id: project.id,
        name: project.name,
        runtime: await page.evaluate((id) => window.aibox.getHermesRuntimeStatus(id), project.id)
      });
    }
    await page.screenshot({ path: path.join(output, 'quest.png'), fullPage: true });
    fs.writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await application.close().catch(() => undefined);
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
