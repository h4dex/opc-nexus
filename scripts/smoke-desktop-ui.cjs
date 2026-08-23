'use strict';

const { mkdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { _electron: electron } = require('playwright-core');

const root = resolve(__dirname, '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const evidenceRoot = resolve(process.env.AIBOX_DESKTOP_SMOKE_OUTPUT || join(root, 'tmp', 'desktop-smoke', stamp));
const userData = join(evidenceRoot, 'user-data');
const screenshotPath = join(evidenceRoot, 'project-center.png');
const questScreenshotPath = join(evidenceRoot, 'quest-empty.png');
const questWorkbenchScreenshotPath = join(evidenceRoot, 'quest-workbench.png');
const reportPath = join(evidenceRoot, 'report.json');
mkdirSync(userData, { recursive: true });

const expectedNavigation = [
  'Quest', '项目中心', '待我处理', '经营概览', '办公室', '任务中心', '成果库', '项目知识库', '经营自动化',
  '专家团', '工作流', '多机协同', '数字员工', '员工市场', '引擎中心', '插件中心', '连接中心',
  '执行监控', 'Android 执行设备', '用量统计', '系统状态', '设置'
];
const removedPrimaryNavigation = [
  'Secretary Planning', '兼容规划', 'Local CLI'
];

function fail(message) {
  throw new Error(`[desktop-smoke] ${message}`);
}

(async () => {
  const env = {
    ...process.env,
    AIBOX_DISABLE_HARDWARE_ACCELERATION: '1',
    AIBOX_USER_DATA_DIR: userData
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const packagedExecutable = (process.env.AIBOX_DESKTOP_EXECUTABLE || '').trim();

  const application = await electron.launch({
    executablePath: packagedExecutable || require('electron'),
    args: packagedExecutable ? [] : ['.'],
    cwd: root,
    env,
    timeout: 60_000
  });
  const consoleErrors = [];
  const attached = new WeakSet();
  const attachPage = (page) => {
    if (attached.has(page)) return;
    attached.add(page);
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(`console: ${message.text()}`);
    });
    page.on('pageerror', (error) => consoleErrors.push(`page: ${error.message}`));
  };
  application.on('window', attachPage);

  let report;
  try {
    const page = await application.firstWindow({ timeout: 60_000 });
    attachPage(page);
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('.topbar-title').filter({ hasText: '项目中心' }).waitFor({ timeout: 30_000 });

    const navigation = (await page.locator('.nav-item').allTextContents()).map((value) => value.trim());
    if (navigation.length !== expectedNavigation.length) fail(`expected ${expectedNavigation.length} primary routes, received ${navigation.length}`);
    for (const label of expectedNavigation) {
      if (!navigation.includes(label)) fail(`missing primary route: ${label}`);
    }
    for (const label of removedPrimaryNavigation) {
      if (navigation.includes(label)) fail(`legacy primary route is still visible: ${label}`);
    }
    const openPrimaryRoute = (label) => page.locator('.nav-item').filter({ hasText: label }).click();

    await openPrimaryRoute('Quest');
    await page.locator('.topbar-title').filter({ hasText: 'Quest' }).waitFor();
    await page.locator('[aria-label="Quest 暂无项目"]').waitFor();
    await page.screenshot({ path: questScreenshotPath, fullPage: true });

    await openPrimaryRoute('项目中心');
    await page.locator('.topbar-title').filter({ hasText: '项目中心' }).waitFor();

    await openPrimaryRoute('连接中心');
    await page.locator('.topbar-title').filter({ hasText: '连接中心' }).waitFor();
    const channelText = await page.locator('main.content').innerText();
    if (channelText.includes('QQ')) fail('QQ is visible without a real adapter');

    await openPrimaryRoute('插件中心');
    await page.locator('.topbar-title').filter({ hasText: '插件中心' }).waitFor();
    const pluginText = await page.locator('main.content').innerText();
    if (/dsh|cordis/i.test(pluginText)) {
      fail('DSH/Cordis internal plugin labels leaked into the user plugin center');
    }

    await openPrimaryRoute('设置');
    await page.locator('.topbar-title').filter({ hasText: '设置' }).waitFor();
    const settingsText = await page.locator('main.content').innerText();
    if (settingsText.includes('仅本地')) fail('unimplemented local voice mode is visible');

    await openPrimaryRoute('数字员工');
    await page.locator('.topbar-title').filter({ hasText: '数字员工' }).waitFor();
    const agentsText = await page.locator('main.content').innerText();
    if (agentsText.includes('兼容对话') || agentsText.includes('安排任务')) {
      fail('digital employee page still exposes a second command entry');
    }

    await openPrimaryRoute('项目中心');
    await page.locator('.topbar-title').filter({ hasText: '项目中心' }).waitFor();
    const project = await page.evaluate(() => window.aibox.createProject({
      name: 'Hermes Runtime Acceptance',
      objective: 'Verify the project-scoped Hermes fail-closed boundary.',
      status: 'active',
      workspaceMode: 'automatic'
    }));
    await page.getByText('Hermes Runtime Acceptance', { exact: true }).first().waitFor({ timeout: 10_000 });

    const artifacts = await page.evaluate((projectId) => window.aibox.listProjectArtifacts(projectId), project.id);
    if (!artifacts.workspaceConfigured) fail('new project did not receive an automatic workspace');

    const initialHermesStatus = await page.evaluate((projectId) => window.aibox.getHermesRuntimeStatus(projectId), project.id);
    let startError = null;
    try {
      await page.evaluate((projectId) => window.aibox.startHermesProject(projectId), project.id);
    } catch (error) {
      startError = error instanceof Error ? error.message : String(error);
    }
    const finalHermesStatus = await page.evaluate((projectId) => window.aibox.getHermesRuntimeStatus(projectId), project.id);
    if (!startError) fail('Hermes started without a configured Provider');
    if (finalHermesStatus.state === 'healthy') fail('Hermes reported healthy after a rejected start');
    await page.screenshot({ path: screenshotPath, fullPage: true });

    await openPrimaryRoute('Quest');
    await page.locator('.topbar-title').filter({ hasText: 'Quest' }).waitFor();
    await page.locator('[aria-label="Quest 项目与员工上下文"]').waitFor({ timeout: 10_000 });
    await page.locator('[aria-label="项目治理"]').waitFor({ timeout: 10_000 });
    const questLayout = await page.evaluate(() => {
      const sidebar = document.querySelector('.app-shell > .sidebar')?.getBoundingClientRect();
      const context = document.querySelector('.quest-context')?.getBoundingClientRect();
      const center = document.querySelector('.quest-embedded-column')?.getBoundingClientRect();
      const governance = document.querySelector('.quest-governance')?.getBoundingClientRect();
      const topbar = document.querySelector('.main-area > .topbar')?.getBoundingClientRect();
      const serialize = (rect) => rect ? ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right }) : null;
      return {
        sidebar: serialize(sidebar),
        context: serialize(context),
        center: serialize(center),
        governance: serialize(governance),
        topbar: serialize(topbar),
        questFocus: document.documentElement.dataset.questFocus ?? null
      };
    });
    if (!questLayout.sidebar || !questLayout.topbar) fail('Quest hid the OPC-Nexus shell');
    if (!questLayout.context || !questLayout.center || !questLayout.governance) fail('Quest did not render all three workspace columns');
    if (questLayout.questFocus !== null) fail('Quest left the legacy global focus flag enabled');
    if (questLayout.context.right > questLayout.center.x + 1 || questLayout.center.right > questLayout.governance.x + 1) {
      fail('Quest workspace columns overlap');
    }
    if (questLayout.center.width < 320) fail(`Quest center column is too narrow: ${questLayout.center.width}`);
    await page.screenshot({ path: questWorkbenchScreenshotPath, fullPage: true });
    report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      navigation,
      defaultRoute: '项目中心',
      hiddenMockSurfaces: { qq: true, localVoice: true, legacyDirectChat: true, dshPluginLabels: true },
      hermesFailClosedGate: {
        automaticWorkspace: artifacts.workspaceConfigured,
        initialState: initialHermesStatus.state,
        finalState: finalHermesStatus.state,
        startError
      },
      questLayout,
      consoleErrors,
      screenshotPath,
      questScreenshotPath,
      questWorkbenchScreenshotPath,
      userData
    };
    if (consoleErrors.length > 0) fail(`renderer errors: ${consoleErrors.join(' | ')}`);
  } finally {
    await application.close().catch(() => undefined);
  }

  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
})().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
