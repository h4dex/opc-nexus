'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const https = require('node:https');
const { _electron: electron, chromium } = require('playwright');
const initSqlJs = require('sql.js');

const root = path.resolve(__dirname, '..');
const seedUserData = (process.env.OPCNEXUS_MOBILE_UI_SEED_USER_DATA || '').trim();
if (!seedUserData || !fs.statSync(seedUserData).isDirectory()) {
  throw new Error('OPCNEXUS_MOBILE_UI_SEED_USER_DATA must point to a seeded user-data directory');
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const evidenceRoot = path.resolve(
  process.env.OPCNEXUS_MOBILE_UI_OUTPUT || path.join(root, 'tmp', 'acceptance-mobile-web', stamp)
);
const userData = path.join(evidenceRoot, 'user-data');
const workspace = path.join(evidenceRoot, 'workspace');
const reportPath = path.join(evidenceRoot, 'report.json');
const uploadPath = path.join(evidenceRoot, 'mobile-attachment.md');
fs.mkdirSync(evidenceRoot, { recursive: true });
fs.cpSync(seedUserData, userData, { recursive: true, force: true });
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(uploadPath, '# Mobile Web attachment\n\n真实移动端附件回归。\n', 'utf8');

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  evidenceRoot,
  userData,
  steps: [],
  consoleErrors: [],
  screenshots: [],
  result: 'RUNNING'
};

function safeText(value, max = 8_000) {
  return String(value ?? '').slice(0, max);
}

async function rebindCopiedProjectWorkspace() {
  const databasePath = path.join(userData, 'aibox-data', 'aibox.db');
  if (!fs.existsSync(databasePath)) throw new Error('Seed user data has no OPC-Nexus database');
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(root, 'node_modules', 'sql.js', 'dist', file)
  });
  const database = new SQL.Database(fs.readFileSync(databasePath));
  try {
    const projectResult = database.exec("SELECT id FROM projects WHERE status <> 'archived' ORDER BY updated_at DESC, id DESC LIMIT 1");
    const projectId = projectResult[0]?.values?.[0]?.[0];
    if (typeof projectId !== 'string' || !projectId) throw new Error('Seed user data has no active project');
    const key = `project:workbench:${projectId}`;
    const preferenceResult = database.exec(`SELECT value_json FROM settings WHERE key = '${key.replaceAll("'", "''")}' LIMIT 1`);
    let preference = {};
    const raw = preferenceResult[0]?.values?.[0]?.[0];
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) preference = parsed;
      } catch { /* a corrupt test preference is replaced below */ }
    }
    preference.workspacePath = workspace;
    database.run(
      `INSERT INTO settings(key, value_json, updated_at) VALUES(?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [key, JSON.stringify(preference), Date.now()]
    );
    database.run('UPDATE tasks SET workspace_override = ? WHERE project_id = ?', [workspace, projectId]);
    fs.writeFileSync(databasePath, Buffer.from(database.export()));
    return projectId;
  } finally {
    database.close();
  }
}

async function step(name, action) {
  const startedAt = Date.now();
  console.error(`[mobile-acceptance] START ${name}`);
  try {
    const evidence = await action();
    report.steps.push({ name, status: 'PASS', durationMs: Date.now() - startedAt, evidence });
    console.error(`[mobile-acceptance] PASS ${name}`);
    return evidence;
  } catch (error) {
    report.steps.push({
      name,
      status: 'FAIL',
      durationMs: Date.now() - startedAt,
      error: safeText(error instanceof Error ? error.message : error)
    });
    console.error(`[mobile-acceptance] FAIL ${name}`);
    throw error;
  }
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

function httpsJson(url, options = {}) {
  const target = new URL(url);
  const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
  const requestLabel = `${options.method || (body ? 'POST' : 'GET')} ${target.pathname}`;
  const trace = process.env.OPCNEXUS_MOBILE_UI_TRACE === '1';
  if (trace) console.error(`[mobile-acceptance] HTTP START ${requestLabel}`);
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
        try { json = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
        if (trace) console.error(`[mobile-acceptance] HTTP END ${requestLabel} status=${response.statusCode || 0}`);
        resolve({ status: response.statusCode || 0, headers: response.headers, json, text: safeText(text) });
      });
    });
    request.once('error', reject);
    request.setTimeout(options.timeoutMs ?? 15_000, () => {
      if (trace) console.error(`[mobile-acceptance] HTTP TIMEOUT ${requestLabel}`);
      request.destroy(new Error(`HTTPS request timed out: ${target.pathname}`));
    });
    if (body) request.write(body);
    request.end();
  });
}

function cookieHeader(headers) {
  const values = Array.isArray(headers['set-cookie'])
    ? headers['set-cookie']
    : headers['set-cookie'] ? [headers['set-cookie']] : [];
  return values.map((value) => value.split(';', 1)[0]).join('; ');
}

function cookieObject(value, origin) {
  const [name, ...parts] = value.split('=');
  const parsed = new URL(origin);
  return {
    name,
    value: parts.join('='),
    url: `${parsed.origin}/`,
    secure: parsed.protocol === 'https:',
    httpOnly: true,
    sameSite: 'Strict'
  };
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} timed out`);
}

async function closeWithTimeout(resource, timeoutMs = 8_000) {
  if (!resource) return;
  await Promise.race([
    Promise.resolve().then(() => resource.close()),
    new Promise((resolve) => setTimeout(resolve, timeoutMs))
  ]).catch(() => undefined);
}

async function main() {
  let app;
  let browser;
  let project;
  let operatorOffer;
  let operatorCookie;
  try {
    report.seedProjectId = await rebindCopiedProjectWorkspace();
    const appEnv = { ...process.env, AIBOX_USER_DATA_DIR: userData, AIBOX_DISABLE_HARDWARE_ACCELERATION: '1' };
    delete appEnv.ELECTRON_RUN_AS_NODE;
    // `require('electron')` resolves to the platform binary. The package's
    // `index.js` is only a Node launcher and cannot be used as Playwright's
    // Electron executable on Windows.
    app = await electron.launch({ executablePath: require('electron'), args: ['.'], cwd: root, env: appEnv, timeout: 60_000 });
    const desktop = await app.firstWindow({ timeout: 60_000 });
    desktop.on('console', (message) => {
      if (message.type() === 'error') report.consoleErrors.push(safeText(message.text()));
    });
    desktop.on('pageerror', (error) => report.consoleErrors.push(safeText(error.message)));
    await desktop.locator('.app-shell').waitFor({ timeout: 30_000 });
    if (process.env.OPCNEXUS_MOBILE_UI_DEBUG === '1') {
      await desktop.evaluate(() => window.aibox.setDebugMode(true));
    }

    const snapshot = await step('读取真实项目', () => desktop.evaluate(() => window.aibox.getSnapshot()));
    project = [...(snapshot.projects || [])]
      .filter((item) => item.status !== 'archived')
      .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))[0];
    if (!project?.id) throw new Error('Seed user data has no active project');

    const runtime = await step('启动真实 Hermes 项目服务', async () => {
      await desktop.evaluate((projectId) => window.aibox.startHermesProject(projectId), project.id);
      return waitFor(async () => {
        const status = await desktop.evaluate((projectId) => window.aibox.getHermesRuntimeStatus(projectId), project.id);
        if (status.state === 'error' || status.state === 'stopped') throw new Error(status.lastError || `Hermes state=${status.state}`);
        return status.state === 'healthy' ? status : null;
      }, 120_000, 'Hermes runtime health');
    });

    await step('Quest 右上角二维码弹窗层级与布局', async () => {
      await desktop.locator('.nav-item').filter({ hasText: /^Quest$/ }).click();
      await desktop.locator('.quest-workbench').waitFor({ timeout: 30_000 });
      const phone = desktop.getByRole('button', { name: '连接手机 Hermes 对话' });
      await phone.waitFor({ timeout: 30_000 });
      await phone.click();
      const modal = desktop.locator('.quest-mobile-modal');
      await modal.waitFor({ timeout: 30_000 });
      const pairingState = await Promise.race([
        modal.locator('img[alt="手机 Hermes 对话二维码"]').waitFor({ timeout: 30_000 }).then(() => 'ready'),
        modal.locator('.quest-mobile-error').waitFor({ timeout: 30_000 }).then(() => 'error')
      ]);
      if (pairingState === 'error') {
        const diagnostics = await desktop.evaluate(async (projectId) => ({
          projectId,
          modalText: document.querySelector('.quest-mobile-modal')?.textContent?.trim() ?? '',
          status: await window.aibox.getHermesMobileAccessStatus(projectId),
          addresses: await window.aibox.listHermesMobileLanAddresses()
        }), project.id);
        const screenshot = path.join(evidenceRoot, 'desktop-hermes-qr-modal-error.png');
        await desktop.screenshot({ path: screenshot });
        report.screenshots.push(screenshot);
        throw new Error(`Quest mobile pairing failed: ${JSON.stringify({ ...diagnostics, screenshot })}`);
      }
      const layout = await desktop.evaluate(() => {
        const element = document.querySelector('.quest-mobile-modal');
        const backdrop = document.querySelector('.quest-mobile-modal-backdrop');
        if (!(element instanceof HTMLElement) || !(backdrop instanceof HTMLElement)) return null;
        const rect = element.getBoundingClientRect();
        return {
          viewport: { width: innerWidth, height: innerHeight },
          modal: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
          backdropPosition: getComputedStyle(backdrop).position,
          backdropZIndex: Number(getComputedStyle(backdrop).zIndex)
        };
      });
      if (!layout
        || layout.modal.left < 0 || layout.modal.top < 0
        || layout.modal.right > layout.viewport.width + 1
        || layout.modal.bottom > layout.viewport.height + 1
        || layout.backdropPosition !== 'fixed'
        || layout.backdropZIndex < 1000) {
        throw new Error(`Quest mobile modal layout invalid: ${JSON.stringify(layout)}`);
      }
      const embedded = await desktop.evaluate(() => window.aibox.getEmbeddedHermesWorkbenchStatus());
      if (embedded.visible) throw new Error('Embedded Hermes View remained visible above the QR modal');
      const screenshot = path.join(evidenceRoot, 'desktop-hermes-qr-modal.png');
      await desktop.screenshot({ path: screenshot });
      report.screenshots.push(screenshot);
      await modal.getByRole('button', { name: '关闭手机 Hermes 对话' }).click();
      await modal.waitFor({ state: 'detached', timeout: 10_000 });
      return { layout, embeddedVisible: embedded.visible, screenshot };
    });

    const lanPort = await reservePort();
    operatorOffer = await step('生成真实 Hermes Chat 配对', () => desktop.evaluate(({ projectId, port }) =>
      window.aibox.createHermesMobilePairing(projectId, {
        bindHost: '127.0.0.1', port, publicHost: '127.0.0.1'
      }), { projectId: project.id, port: lanPort }));
    const paired = await httpsJson(`${operatorOffer.origin}/api/v1/auth/pair`, {
      method: 'POST',
      headers: { Origin: operatorOffer.origin, 'Sec-Fetch-Site': 'same-origin' },
      body: { code: operatorOffer.code }
    });
    if (paired.status !== 200) throw new Error(`Hermes Chat pairing failed: ${paired.status} ${paired.text}`);
    operatorCookie = cookieHeader(paired.headers);
    if (!operatorCookie) throw new Error('Operator pairing did not return a session cookie');
    await step('Hermes Chat 会话 API 同源认证', async () => {
      const state = await httpsJson(`${operatorOffer.origin}/__opc_nexus/project/state`, { headers: { Cookie: operatorCookie } });
      if (state.status !== 200 || state.json?.result?.projectId !== project.id) throw new Error(`state=${state.status}`);
      return { status: state.status, projectId: state.json.result.projectId, surface: 'hermes-chat' };
    });
    await step('手机网关仅开放当前项目 Hermes 对话', async () => {
      const deniedPaths = ['/sessions', '/files', '/logs', '/api/memory', '/api/ws'];
      const evidence = [];
      for (const pathname of deniedPaths) {
        const response = await httpsJson(`${operatorOffer.origin}${pathname}`, {
          headers: { Cookie: operatorCookie }
        });
        evidence.push({ pathname, status: response.status });
        if (response.status !== 403) throw new Error(`${pathname} should be denied, status=${response.status}`);
      }
      const chat = await httpsJson(`${operatorOffer.origin}/chat`, { headers: { Cookie: operatorCookie } });
      if (chat.status !== 200) throw new Error(`/chat should be available, status=${chat.status}`);
      return { allowed: { pathname: '/chat', status: chat.status }, denied: evidence };
    });

    const browserExecutable = process.env.OPCNEXUS_MOBILE_UI_BROWSER || [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    ].find((candidate) => fs.existsSync(candidate));
    browser = await chromium.launch({ headless: true, ...(browserExecutable ? { executablePath: browserExecutable } : {}) });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      screen: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      ignoreHTTPSErrors: true,
      userAgent: 'OPC-Nexus-Mobile-Web-Acceptance/1.0'
    });
    const mobile = await context.newPage();
    mobile.on('console', (message) => {
      if (message.type() === 'error') report.consoleErrors.push(`mobile: ${safeText(message.text())}`);
    });
    mobile.on('pageerror', (error) => report.consoleErrors.push(`mobile: ${safeText(error.message)}`));
    // Pair through the real mobile page so the browser receives the hardened
    // __Host- session cookie using the gateway's own Set-Cookie response.
    const browserOffer = await desktop.evaluate((projectId) => window.aibox.createHermesMobilePairing(projectId), project.id);
    const pairingResponse = await mobile.goto(browserOffer.pairingUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (!pairingResponse || pairingResponse.status() !== 200) throw new Error(`mobile pairing status=${pairingResponse?.status()}`);
    await mobile.locator('input[name="code"]').fill(browserOffer.code);
    await mobile.getByRole('button', { name: '打开 Hermes 对话' }).click();
    // The stable marker belongs to the composer container; the editable
    // control is its textarea child. Keep this scoped so other Hermes pages
    // cannot satisfy the mobile acceptance check by accident.
    await mobile.locator('[data-nexus-composer] textarea').waitFor({ timeout: 30_000 });
    if (new URL(mobile.url()).pathname !== '/chat') {
      throw new Error(`Mobile pairing did not land on Hermes chat: ${mobile.url()}`);
    }
    const browserCookies = await context.cookies(browserOffer.origin);
    operatorCookie = browserCookies.map((item) => `${item.name}=${item.value}`).join('; ');
    if (!operatorCookie) throw new Error('Mobile pairing did not establish a browser session cookie');
    const historyBefore = await httpsJson(`${operatorOffer.origin}/__opc_nexus/project/conversations`, { headers: { Cookie: operatorCookie } });
    let conversationId = historyBefore.json?.result?.[0]?.conversationId;
    if (!conversationId) throw new Error('Operator project has no conversation');
    const initialHistory = await httpsJson(`${operatorOffer.origin}/__opc_nexus/project/chat-history`, {
      method: 'POST', headers: { Cookie: operatorCookie, Origin: operatorOffer.origin, 'Sec-Fetch-Site': 'same-origin' },
      body: { conversationId }
    });
    if (initialHistory.status !== 200 || initialHistory.json?.result?.conversationId !== conversationId) {
      throw new Error(`Initial mobile chat history failed: ${initialHistory.status} ${initialHistory.text}`);
    }
    let initialMessageCount = Array.isArray(initialHistory.json.result.messages) ? initialHistory.json.result.messages.length : 0;

    await step('移动 Web 响应式布局与输入框', async () => {
      const response = await mobile.goto(`${operatorOffer.origin}/chat`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (!response || response.status() !== 200) throw new Error(`mobile /chat status=${response?.status()}`);
      const input = mobile.locator('[data-nexus-composer] textarea');
      await input.waitFor({ timeout: 30_000 });
      await mobile.locator('[data-nexus-runtime-state="healthy"]').waitFor({ timeout: 20_000 });
      const layout = await mobile.evaluate(() => ({
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        bodyText: document.body.innerText.slice(0, 240),
        inputVisible: (() => { const rect = document.querySelector('textarea')?.getBoundingClientRect(); return Boolean(rect && rect.width > 0 && rect.height > 0); })(),
        touch: matchMedia('(pointer: coarse)').matches
      }));
      if (layout.scrollWidth > layout.width + 1 || !layout.inputVisible) throw new Error(`mobile layout overflow: ${JSON.stringify(layout)}`);
      if (layout.bodyText.includes('历史员工会话')) throw new Error('Retired employee conversation leaked into Hermes mobile tabs');
      const screenshot = path.join(evidenceRoot, 'mobile-chat-empty.png');
      await mobile.screenshot({ path: screenshot, fullPage: true });
      report.screenshots.push(screenshot);
      return layout;
    });

    await step('移动 Web 附件选择与发送', async () => {
      await mobile.locator('input[type="file"]').setInputFiles(uploadPath);
      const tray = mobile.locator('[data-nexus-attachment-tray]');
      await tray.waitFor({ timeout: 10_000 });
      if (!(await tray.getByText('mobile-attachment.md').count())) throw new Error('Attachment tray did not show the selected file');
      const message = '请只回复：移动 Web 消息已收到。';
      await mobile.locator('[data-nexus-composer] textarea').fill(message);
      const sendButton = mobile.getByRole('button', { name: '发送' });
      const readiness = await waitFor(async () => {
        const [mainState, mobileState, button] = await Promise.all([
          desktop.evaluate((projectId) => window.aibox.getHermesRuntimeStatus(projectId), project.id),
          httpsJson(`${operatorOffer.origin}/__opc_nexus/project/state`, { headers: { Cookie: operatorCookie } }),
          sendButton.evaluate((element) => ({
            disabled: element.hasAttribute('disabled'),
            title: element.getAttribute('title')
          }))
        ]);
        const evidence = {
          mainRuntimeState: mainState.state,
          mobileRuntimeState: mobileState.json?.result?.runtimeState ?? null,
          mobileStatus: mobileState.status,
          sendDisabled: button.disabled,
          sendTitle: button.title
        };
        return mainState.state === 'healthy'
          && mobileState.status === 200
          && mobileState.json?.result?.runtimeState === 'healthy'
          && !button.disabled
          ? evidence
          : null;
      }, 20_000, 'Mobile Hermes composer readiness');
      await sendButton.click();
      const selectedConversationId = await mobile.evaluate(() => document.documentElement.dataset.nexusConversationId || '');
      if (selectedConversationId && selectedConversationId !== conversationId) {
        conversationId = selectedConversationId;
        const selectedHistory = await httpsJson(`${operatorOffer.origin}/__opc_nexus/project/chat-history`, {
          method: 'POST', headers: { Cookie: operatorCookie, Origin: operatorOffer.origin, 'Sec-Fetch-Site': 'same-origin' },
          body: { conversationId }
        });
        if (selectedHistory.status !== 200) throw new Error(`Selected mobile chat history failed: ${selectedHistory.status} ${selectedHistory.text}`);
        initialMessageCount = Array.isArray(selectedHistory.json?.result?.messages) ? selectedHistory.json.result.messages.length : 0;
      }
      await mobile.waitForTimeout(20_000);
      const debugBody = await mobile.evaluate(() => document.body.innerText.slice(-2_000));
      console.error(`[mobile-acceptance] post-send body tail ${JSON.stringify(debugBody)}`);
      const updated = await httpsJson(`${operatorOffer.origin}/__opc_nexus/project/chat-history`, {
        method: 'POST', headers: { Cookie: operatorCookie, Origin: operatorOffer.origin, 'Sec-Fetch-Site': 'same-origin' },
        body: { conversationId }, timeoutMs: 15_000
      });
      if (updated.status !== 200) throw new Error(`Mobile chat history failed after UI reply: ${updated.status} ${updated.text}`);
      const updatedMessages = updated.json?.result?.messages;
      if (!Array.isArray(updatedMessages) || updatedMessages.length <= initialMessageCount || !updatedMessages.some((item) => item.role === 'assistant')) {
        throw new Error(`Mobile chat history did not persist the UI reply: ${updated.text}`);
      }
      const assistantMessage = mobile.locator('article.mr-auto').filter({ hasText: '移动 Web 消息已收到' }).last();
      const uiAssistantVisible = await assistantMessage.isVisible().catch(() => false);
      if (!uiAssistantVisible) throw new Error('Hermes reply is persisted by the gateway but is not visible in the mobile chat UI');
      const after = await mobile.evaluate(() => ({
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        trayVisible: Boolean(document.querySelector('[data-nexus-attachment-tray]'))
      }));
      if (after.scrollWidth > after.width + 1) throw new Error(`mobile layout overflow after send: ${JSON.stringify(after)}`);
      const screenshot = path.join(evidenceRoot, 'mobile-chat-after-send.png');
      await mobile.screenshot({ path: screenshot, fullPage: true });
      report.screenshots.push(screenshot);
      const messages = updated.json?.result?.messages;
      const lastAssistant = Array.isArray(messages)
        ? [...messages].reverse().find((item) => item.role === 'assistant')?.content ?? null
        : null;
      return {
        readiness,
        historyStatus: updated.status,
        assistantReply: safeText(lastAssistant, 500),
        attachmentConsumed: !after.trayVisible,
        layout: after
      };
    });

    await step('拒绝旧版多角色手机入口', async () => {
      const error = await desktop.evaluate(async (projectId) => {
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
    await step('移动网关真实离线状态', async () => {
      await desktop.evaluate((projectId) => window.aibox.stopHermesProject(projectId), project.id);
      const stopped = await desktop.evaluate((projectId) => window.aibox.getHermesRuntimeStatus(projectId), project.id);
      const offline = await httpsJson(`${operatorOffer.origin}/__opc_nexus/project/state`, { headers: { Cookie: operatorCookie } });
      if (stopped.state !== 'stopped' || offline.status !== 503) throw new Error(`offline mismatch: ${JSON.stringify({ stopped: stopped.state, status: offline.status })}`);
      return { runtimeState: stopped.state, mobileStatus: offline.status };
    });
  } finally {
    report.consoleErrors = report.consoleErrors.slice(0, 100);
    report.result = report.steps.some((item) => item.status === 'FAIL') ? 'FAIL' : 'PASS';
    report.completedAt = new Date().toISOString();
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await closeWithTimeout(browser);
    await closeWithTimeout(app);
  }
  console.log(JSON.stringify({ result: report.result, reportPath, evidenceRoot, steps: report.steps.length, failed: report.steps.filter((item) => item.status === 'FAIL').map((item) => item.name) }, null, 2));
  if (report.result !== 'PASS') process.exitCode = 1;
}

main().catch((error) => {
  report.result = 'FAIL';
  report.completedAt = new Date().toISOString();
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
