'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const userData = path.resolve(process.env.AIBOX_COMPOSER_ACCEPTANCE_USER_DATA || '');
const projectIdInput = (process.env.AIBOX_COMPOSER_ACCEPTANCE_PROJECT_ID || '').trim();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = path.resolve(
  process.env.AIBOX_COMPOSER_ACCEPTANCE_OUTPUT || path.join(root, 'tmp', 'acceptance-quest-composer', stamp)
);
if (!fs.statSync(userData, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error('AIBOX_COMPOSER_ACCEPTANCE_USER_DATA must point to an isolated configured user-data directory');
}
fs.mkdirSync(output, { recursive: true });

const reportPath = path.join(output, 'report.json');
const desktopScreenshotPath = path.join(output, 'composer-desktop.png');
const mobileScreenshotPath = path.join(output, 'composer-mobile.png');
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  userData,
  project: null,
  runtime: null,
  desktop: null,
  mobile: null,
  consoleErrors: [],
  result: 'RUNNING'
};

function fail(message) {
  throw new Error(`[quest-composer] ${message}`);
}

function safeText(value) {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .slice(0, 8_000);
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
  const env = {
    ...process.env,
    AIBOX_USER_DATA_DIR: userData,
    AIBOX_DISABLE_HARDWARE_ACCELERATION: '1'
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({
    executablePath: require('electron'),
    args: ['.'],
    cwd: root,
    env,
    timeout: 60_000
  });
  let page;
  let mobilePage;
  try {
    page = await application.firstWindow({ timeout: 60_000 });
    const collectConsole = (surface) => {
      surface.on('console', (message) => {
        if (message.type() === 'error') report.consoleErrors.push(safeText(`console: ${message.text()}`));
      });
      surface.on('pageerror', (error) => report.consoleErrors.push(safeText(`page: ${error.message}`)));
    };
    collectConsole(page);
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });
    await page.setViewportSize({ width: 1440, height: 940 });

    const snapshot = await page.evaluate(() => window.aibox.getSnapshot());
    const projects = snapshot.projects
      .filter((item) => item.status !== 'archived')
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const project = projectIdInput
      ? projects.find((item) => item.id === projectIdInput)
      : projects[0];
    if (!project) fail('No active project is available');
    report.project = { id: project.id, name: project.name };

    await page.locator('.nav-item').filter({ hasText: 'Quest' }).click();
    await page.locator('.topbar-title').filter({ hasText: 'Quest' }).waitFor({ timeout: 15_000 });
    const contextSelect = page.locator('select[aria-label="Quest 项目上下文"]');
    if (await contextSelect.count()) await contextSelect.selectOption(project.id);
    await page.locator('[aria-label="Quest 项目与员工上下文"]').waitFor({ timeout: 30_000 });

    const initialRuntime = await page.evaluate((id) => window.aibox.getHermesRuntimeStatus(id), project.id);
    if (initialRuntime.state === 'stopped' || initialRuntime.state === 'error') {
      await page.evaluate((id) => window.aibox.startHermesProject(id), project.id);
    }

    const runtime = await waitFor(async () => {
      const value = await page.evaluate((id) => window.aibox.getHermesRuntimeStatus(id), project.id);
      report.runtime = {
        state: value.state,
        startupPhase: value.startupPhase || null,
        startupElapsedMs: value.startupElapsedMs || null,
        proxyPort: value.proxyPort,
        lastError: value.lastError || null
      };
      return value.state === 'healthy' && value.proxyPort ? value : null;
    }, 120_000, 'Hermes runtime health');

    const contentsId = await waitFor(() => application.evaluate(({ webContents }, port) => {
      const match = webContents.getAllWebContents().find((contents) => {
        try { return new URL(contents.getURL()).port === String(port); } catch { return false; }
      });
      return match?.id || null;
    }, runtime.proxyPort), 20_000, 'embedded Hermes WebContents');

    const execute = (expression, label) => withTimeout(application.evaluate(({ webContents }, input) => {
      const contents = webContents.fromId(input.id);
      if (!contents || contents.isDestroyed()) throw new Error('Embedded Hermes WebContents is unavailable');
      return contents.executeJavaScript(input.expression, true);
    }, { id: contentsId, expression }), 20_000, label);

    await waitFor(() => execute(`(() => {
      const composer = document.querySelector('[data-nexus-composer]');
      const input = composer?.querySelector('textarea');
      const send = composer?.querySelector('button[aria-label="发送"]');
      return composer instanceof HTMLElement
        && input instanceof HTMLTextAreaElement
        && send instanceof HTMLButtonElement
        && (composer.firstElementChild?.textContent || '').includes('就绪');
    })()`, 'locate ready desktop composer'), 20_000, 'ready desktop composer');
    const desktop = await execute(`new Promise((resolve, reject) => {
      const composer = document.querySelector('[data-nexus-composer]');
      const input = composer?.querySelector('textarea');
      if (!(composer instanceof HTMLElement) || !(input instanceof HTMLTextAreaElement)) {
        reject(new Error('Composer is unavailable'));
        return;
      }
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (!setter) {
        reject(new Error('Textarea setter is unavailable'));
        return;
      }
      setter.call(input, Array.from({ length: 12 }, (_, index) => '第' + (index + 1) + '行验收内容').join('\\n'));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const pasteFiles = (files) => {
        const transfer = new DataTransfer();
        files.forEach((file) => transfer.items.add(file));
        const event = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', { value: transfer });
        input.dispatchEvent(event);
      };
      const pngBytes = Uint8Array.from(
        atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),
        (value) => value.charCodeAt(0)
      );
      pasteFiles([
        new File([pngBytes], 'clipboard-proof.png', { type: 'image/png', lastModified: 1 }),
        new File(['real attachment'], 'brief.txt', { type: 'text/plain', lastModified: 2 })
      ]);
      setTimeout(() => {
        pasteFiles([new File([new Uint8Array(32 * 1024 * 1024 + 1)], 'too-large.bin', { type: 'application/octet-stream', lastModified: 3 })]);
        setTimeout(() => {
          const tray = document.querySelector('[data-nexus-attachment-tray]');
          const rect = composer.getBoundingClientRect();
          const controls = [...composer.querySelectorAll('button')].map((button) => {
            const box = button.getBoundingClientRect();
            return { label: button.getAttribute('aria-label') || button.getAttribute('title') || '', left: box.left, right: box.right, top: box.top, bottom: box.bottom };
          });
          resolve({
            viewport: { width: innerWidth, height: innerHeight, bodyScrollWidth: document.body.scrollWidth },
            composer: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
            input: { height: input.getBoundingClientRect().height, scrollHeight: input.scrollHeight, valueLength: input.value.length },
            target: composer.querySelector(':scope > div strong')?.textContent?.trim() || '',
            attachmentCount: tray?.children.length || 0,
            attachmentText: tray?.textContent || '',
            imagePreviewCount: tray?.querySelectorAll('img').length || 0,
            notice: composer.parentElement?.querySelector('.text-warning')?.textContent?.trim() || '',
            controls,
            sendDisabled: Boolean(composer.querySelector('button[aria-label="发送"]')?.disabled)
          });
        }, 150);
      }, 100);
    })`, 'exercise desktop composer');

    if (desktop.attachmentCount !== 2 || desktop.imagePreviewCount !== 1) {
      fail(`Clipboard attachments were not rendered correctly: ${JSON.stringify(desktop)}`);
    }
    if (!desktop.attachmentText.includes('clipboard-proof.png') || !desktop.attachmentText.includes('brief.txt')) {
      fail(`Attachment names are missing: ${JSON.stringify(desktop)}`);
    }
    if (!desktop.notice.includes('32 MB')) fail(`Oversized attachment was not rejected visibly: ${JSON.stringify(desktop)}`);
    if (desktop.input.height <= 64 || desktop.input.height > 192) fail(`Composer auto-resize is outside bounds: ${JSON.stringify(desktop.input)}`);
    if (desktop.composer.left < 0 || desktop.composer.right > desktop.viewport.width + 1 || desktop.viewport.bodyScrollWidth > desktop.viewport.width + 1) {
      fail(`Desktop composer overflows the viewport: ${JSON.stringify(desktop)}`);
    }
    if (desktop.controls.some((control) => control.left < desktop.composer.left - 1 || control.right > desktop.composer.right + 1)) {
      fail(`Desktop composer control overflow: ${JSON.stringify(desktop.controls)}`);
    }
    report.desktop = desktop;

    await execute(`(() => {
      const input = document.querySelector('[data-nexus-composer] textarea');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (!(input instanceof HTMLTextAreaElement) || !setter) return false;
      setter.call(input, '/');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`, 'open slash menu');
    const slashMenu = await waitFor(() => execute(`(() => {
      const menu = document.querySelector('[data-nexus-slash-menu]');
      const composer = document.querySelector('[data-nexus-composer]');
      if (!(menu instanceof HTMLElement) || !(composer instanceof HTMLElement)) return null;
      const rect = menu.getBoundingClientRect();
      const composerRect = composer.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, composerTop: composerRect.top, viewportWidth: innerWidth, viewportHeight: innerHeight, text: menu.textContent || '' };
    })()`, 'inspect slash menu'), 5_000, 'slash command menu');
    if (slashMenu.bottom > slashMenu.composerTop + 1 || slashMenu.left < 0 || slashMenu.right > slashMenu.viewportWidth + 1 || slashMenu.top < 0) {
      fail(`Slash menu overlaps or escapes the viewport: ${JSON.stringify(slashMenu)}`);
    }
    if (!slashMenu.text.includes('/research')) fail(`Slash menu does not expose /research: ${JSON.stringify(slashMenu)}`);
    report.desktop.slashMenu = slashMenu;

    const slashCandidates = await execute(`(async () => {
      const input = document.querySelector('[data-nexus-composer] textarea');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (!(input instanceof HTMLTextAreaElement) || !setter) throw new Error('Composer is unavailable');
      const inspect = async (value) => {
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 80));
        const menu = document.querySelector('[data-nexus-slash-menu]');
        return [...(menu?.querySelectorAll('button') || [])].map((button) => ({
          text: button.textContent?.trim() || '',
          visible: button.getBoundingClientRect().height > 0
        }));
      };
      return {
        modes: await inspect('/mode '),
        agents: await inspect('/agent '),
        skills: await inspect('/skill '),
        mcp: await inspect('/mcp ')
      };
    })()`, 'inspect project slash candidates');
    for (const mode of ['auto', 'plan', 'execute', 'research']) {
      if (!slashCandidates.modes.some((item) => item.visible && item.text.includes(mode))) {
        fail(`Slash mode candidate is missing (${mode}): ${JSON.stringify(slashCandidates.modes)}`);
      }
    }
    if (slashCandidates.agents.length === 0) fail('Slash employee candidates are empty for a project with eligible employees');
    report.desktop.slashCandidates = slashCandidates;

    const slashSelection = await execute(`new Promise((resolve, reject) => {
      const input = document.querySelector('[data-nexus-composer] textarea');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (!(input instanceof HTMLTextAreaElement) || !setter) return reject(new Error('Composer is unavailable'));
      setter.call(input, '/mode ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      setTimeout(() => {
        const button = [...document.querySelectorAll('[data-nexus-slash-menu] button')]
          .find((candidate) => candidate.textContent?.trim().startsWith('auto'));
        if (!(button instanceof HTMLButtonElement)) return reject(new Error('Auto mode suggestion is unavailable'));
        button.click();
        setTimeout(() => resolve({
          value: input.value,
          focused: document.activeElement === input,
          selectionStart: input.selectionStart,
          selectionEnd: input.selectionEnd
        }), 80);
      }, 80);
    })`, 'select slash candidate');
    if (slashSelection.value !== '/mode auto ' || !slashSelection.focused
      || slashSelection.selectionStart !== slashSelection.value.length
      || slashSelection.selectionEnd !== slashSelection.value.length) {
      fail(`Slash candidate did not preserve focus and task insertion point: ${JSON.stringify(slashSelection)}`);
    }
    report.desktop.slashSelection = slashSelection;

    const invalidUi = await execute(`new Promise((resolve, reject) => {
      const composer = document.querySelector('[data-nexus-composer]');
      const input = composer?.querySelector('textarea');
      const form = composer?.closest('form');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (!(input instanceof HTMLTextAreaElement) || !(form instanceof HTMLFormElement) || !setter) {
        return reject(new Error('Composer is unavailable'));
      }
      const originalFetch = window.fetch;
      const uploads = [];
      window.fetch = (...args) => {
        if (String(args[0]).includes('/upload-attachment')) uploads.push(String(args[0]));
        return originalFetch(...args);
      };
      setter.call(input, '/plan');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      form.requestSubmit();
      setTimeout(() => {
        window.fetch = originalFetch;
        resolve({
          value: input.value,
          uploads,
          attachmentCount: document.querySelector('[data-nexus-attachment-tray]')?.children.length || 0,
          errorVisible: (document.body.textContent || '').includes('Quest 命令无效：/plan 后还需要任务描述')
        });
      }, 200);
    })`, 'reject invalid slash before attachment upload');
    if (invalidUi.value !== '/plan' || invalidUi.uploads.length !== 0 || invalidUi.attachmentCount !== 2 || !invalidUi.errorVisible) {
      fail(`Invalid slash command was not blocked before attachment upload: ${JSON.stringify(invalidUi)}`);
    }
    report.desktop.invalidUi = invalidUi;

    const slashProtocol = await execute(`(async () => {
      const csrfCookie = document.cookie.split(';').map((part) => part.trim())
        .find((part) => part.startsWith('__Host-opc_hermes_csrf='));
      const csrf = csrfCookie ? decodeURIComponent(csrfCookie.slice(csrfCookie.indexOf('=') + 1)) : '';
      const request = async (operation, payload) => {
        const response = await fetch('/__opc_nexus/project/' + operation, {
          method: payload === undefined ? 'GET' : 'POST',
          credentials: 'include',
          headers: payload === undefined ? undefined : { 'content-type': 'application/json', 'x-opc-csrf': csrf },
          body: payload === undefined ? undefined : JSON.stringify(payload)
        });
        const body = await response.json();
        return { status: response.status, body };
      };
      const stateResponse = await request('state');
      if (!stateResponse.body?.ok) throw new Error('Project state is unavailable');
      const state = stateResponse.body.result;
      const created = await request('create-conversation', {});
      if (!created.body?.ok) throw new Error(created.body?.error || 'Cannot create conversation');
      const conversation = created.body.result;
      const before = (await request('chat-queue')).body?.result || [];
      const invalidMessages = ['/', '/plan', '/execute', '/research', '/mode', '/mode auto', '/unknown task'];
      const invalid = [];
      for (const message of invalidMessages) {
        const response = await request('enqueue-chat-turn', { message, conversationId: conversation.conversationId });
        invalid.push({ message, status: response.status, error: response.body?.error || '' });
      }
      const afterInvalid = (await request('chat-queue')).body?.result || [];
      const employee = state.employees.find((item) => !/[?？�]/u.test(item.name + item.role)) || state.employees[0];
      const commands = [
        { input: '/plan 创建官网并提供预览', expected: '创建官网并提供预览' },
        { input: '/research 调研三家竞品并核验来源', expected: '调研三家竞品并核验来源' },
        { input: '/mode execute 修复顶部标签', expected: '修复顶部标签' },
        ...(employee ? [{ input: '/agent ' + employee.id + ' 验证员工身份', expected: '@' + employee.name + ' 验证员工身份' }] : [])
      ];
      const accepted = [];
      for (const command of commands) {
        const response = await request('enqueue-chat-turn', { message: command.input, conversationId: conversation.conversationId });
        accepted.push({ input: command.input, expected: command.expected, status: response.status, item: response.body?.result || null, error: response.body?.error || '' });
        const queueId = response.body?.result?.id;
        if (queueId) await request('cancel-chat-message', { queueId });
      }
      return {
        employee: employee ? { id: employee.id, name: employee.name } : null,
        pluginCandidates: state.plugins,
        beforeQueueCount: before.length,
        afterInvalidQueueCount: afterInvalid.length,
        invalid,
        accepted
      };
    })()`, 'exercise Main slash command protocol');
    if (slashProtocol.afterInvalidQueueCount !== slashProtocol.beforeQueueCount) {
      fail(`Invalid slash commands created queue entries: ${JSON.stringify(slashProtocol)}`);
    }
    if (slashProtocol.invalid.some((item) => item.status !== 422 || !item.error.includes('Quest 命令无效'))) {
      fail(`Invalid slash command was not rejected explicitly: ${JSON.stringify(slashProtocol.invalid)}`);
    }
    if (slashProtocol.accepted.some((item) => item.status !== 200 || item.item?.message !== item.expected)) {
      fail(`Accepted slash command lost or changed its task body: ${JSON.stringify(slashProtocol.accepted)}`);
    }
    report.desktop.slashProtocol = slashProtocol;

    const desktopPng = await application.evaluate(async ({ webContents }, id) => {
      const contents = webContents.fromId(id);
      if (!contents || contents.isDestroyed()) throw new Error('Embedded Hermes WebContents is unavailable');
      return (await contents.capturePage()).toPNG().toString('base64');
    }, contentsId);
    fs.writeFileSync(desktopScreenshotPath, Buffer.from(desktopPng, 'base64'));

    const pairing = await page.evaluate((id) => window.aibox.createHermesMobilePairing(id, {
      bindHost: '127.0.0.1', port: 18_766, publicHost: '127.0.0.1', publicPort: 18_766
    }), project.id);
    const mobileWindowPromise = application.waitForEvent('window');
    await application.evaluate(async ({ BrowserWindow, session }, input) => {
      const mobileSession = session.fromPartition(`aibox-mobile-acceptance-${Date.now()}`);
      mobileSession.setCertificateVerifyProc((_request, callback) => callback(0));
      const win = new BrowserWindow({
        width: 390,
        height: 844,
        show: true,
        backgroundColor: '#101318',
        webPreferences: { session: mobileSession, contextIsolation: true, nodeIntegration: false, sandbox: true }
      });
      await win.loadURL(input.url);
    }, { url: pairing.pairingUrl });
    mobilePage = await mobileWindowPromise;
    collectConsole(mobilePage);
    await mobilePage.locator('input[name="code"]').fill(pairing.code);
    await mobilePage.getByRole('button', { name: '打开 Quest' }).click();
    await mobilePage.locator('[data-nexus-composer]').waitFor({ state: 'visible', timeout: 30_000 });
    await mobilePage.waitForTimeout(500);
    const mobile = await mobilePage.evaluate(() => {
      const composer = document.querySelector('[data-nexus-composer]');
      const textarea = composer?.querySelector('textarea');
      if (!(composer instanceof HTMLElement) || !(textarea instanceof HTMLTextAreaElement)) return null;
      const rect = composer.getBoundingClientRect();
      const controls = [...composer.querySelectorAll('button')].map((button) => {
        const box = button.getBoundingClientRect();
        return { label: button.getAttribute('aria-label') || button.getAttribute('title') || '', left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      });
      return {
        viewport: { width: innerWidth, height: innerHeight, bodyScrollWidth: document.body.scrollWidth, documentScrollWidth: document.documentElement.scrollWidth },
        composer: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
        input: { width: textarea.getBoundingClientRect().width, height: textarea.getBoundingClientRect().height },
        target: composer.querySelector(':scope > div strong')?.textContent?.trim() || '',
        controls
      };
    });
    if (!mobile) fail('Mobile composer is unavailable after pairing');
    if (mobile.viewport.width > 430 || mobile.composer.left < 0 || mobile.composer.right > mobile.viewport.width + 1) {
      fail(`Mobile composer escapes the viewport: ${JSON.stringify(mobile)}`);
    }
    if (mobile.viewport.bodyScrollWidth > mobile.viewport.width + 1 || mobile.viewport.documentScrollWidth > mobile.viewport.width + 1) {
      fail(`Mobile page has horizontal overflow: ${JSON.stringify(mobile.viewport)}`);
    }
    if (mobile.controls.some((control) => control.left < mobile.composer.left - 1 || control.right > mobile.composer.right + 1)) {
      fail(`Mobile composer control overflow: ${JSON.stringify(mobile.controls)}`);
    }
    const mobileInput = mobilePage.locator('[data-nexus-composer] textarea');
    await mobileInput.fill('/');
    const mobileSlashMenu = mobilePage.locator('[data-nexus-slash-menu]');
    await mobileSlashMenu.waitFor({ state: 'visible', timeout: 5_000 });
    const mobileSlash = await mobileSlashMenu.evaluate((menu) => {
      const rect = menu.getBoundingClientRect();
      return {
        text: menu.textContent || '',
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight
      };
    });
    if (!mobileSlash.text.includes('/research')) fail(`Mobile slash menu does not expose /research: ${JSON.stringify(mobileSlash)}`);
    if (mobileSlash.left < 0 || mobileSlash.right > mobileSlash.viewportWidth + 1 || mobileSlash.top < 0 || mobileSlash.bottom > mobileSlash.viewportHeight + 1) {
      fail(`Mobile slash menu escapes the viewport: ${JSON.stringify(mobileSlash)}`);
    }
    mobile.slashMenu = mobileSlash;
    report.mobile = mobile;
    await mobilePage.screenshot({ path: mobileScreenshotPath, fullPage: false });

    const seriousErrors = report.consoleErrors.filter((value) => !/favicon|ERR_ABORTED/i.test(value));
    if (seriousErrors.length > 0) fail(`Renderer errors: ${seriousErrors.join(' | ')}`);
    report.result = 'PASS';
  } catch (error) {
    report.result = 'FAIL';
    report.error = safeText(error instanceof Error ? error.stack || error.message : error);
    throw error;
  } finally {
    report.completedAt = new Date().toISOString();
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await mobilePage?.close().catch(() => undefined);
    await withTimeout(application.close(), 15_000, 'close Electron').catch(() => application.process().kill());
  }
  process.stdout.write(`${JSON.stringify({ result: report.result, reportPath, desktopScreenshotPath, mobileScreenshotPath }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(safeText(error instanceof Error ? error.stack || error.message : error));
  process.exitCode = 1;
});
