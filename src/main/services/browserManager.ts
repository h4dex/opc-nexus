/**
 * 浏览器自动化管理器（Playwright + CDP）：
 * - 按需启动一个共享 Chromium 实例（headless），每个 agent 独立浏览器上下文（隔离 cookie/storage）
 * - 支持 CDP 直连已有 Chrome（--remote-debugging-port）
 * - 提供页面操作原语：导航、点击、输入、截图、JS 执行、等待
 * - 空闲超时自动关闭（5 分钟无操作释放资源）
 */
import { join, win32 } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

/** 延迟加载 playwright-core（避免未安装时阻塞启动） */
let pw: typeof import('playwright-core') | null = null;
async function getPw() {
  if (!pw) pw = await import('playwright-core');
  return pw;
}

type PlaywrightLoader = () => Promise<typeof import('playwright-core')>;

interface BrowserSession {
  browser: import('playwright-core').Browser;
  context: import('playwright-core').BrowserContext;
  page: import('playwright-core').Page;
  lastActive: number;
  source: 'local' | 'cdp';
  releasePromise?: Promise<void>;
}

interface PendingBrowserSession {
  source: BrowserSession['source'];
  promise: Promise<BrowserSession>;
}

const IDLE_TIMEOUT_MS = 5 * 60_000; // 5 分钟空闲自动关闭

export function resolveBrowserExecutable(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  pathExists: (path: string) => boolean = existsSync
): string | null {
  // Use the path syntax of the target platform. This keeps the resolver
  // deterministic when tests exercise a platform different from the host.
  const pathJoin = platform === 'win32' ? win32.join : join;
  const candidates = platform === 'win32'
    ? [
        env.PROGRAMFILES && pathJoin(env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        env['PROGRAMFILES(X86)'] && pathJoin(env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        env.LOCALAPPDATA && pathJoin(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        env.PROGRAMFILES && pathJoin(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        env['PROGRAMFILES(X86)'] && pathJoin(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
        env.LOCALAPPDATA && pathJoin(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
      ]
    : platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
        ]
      : [
          '/usr/bin/microsoft-edge',
          '/usr/bin/microsoft-edge-stable',
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser'
        ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && pathExists(candidate))) ?? null;
}

export class BrowserManager {
  /** agentId → 浏览器会话 */
  private sessions = new Map<string, BrowserSession>();
  /** 合并同一 agent 的并发创建，避免重复 Context/连接。 */
  private pendingSessions = new Map<string, PendingBrowserSession>();
  /** 本地会话共享一个 Chromium 进程，各自使用独立 BrowserContext。 */
  private localBrowser: import('playwright-core').Browser | null = null;
  private localBrowserPromise: Promise<import('playwright-core').Browser> | null = null;
  private localContextCount = 0;
  private sessionReleases = new Set<Promise<void>>();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(private readonly loadPlaywright: PlaywrightLoader = getPw) {
    this.cleanupTimer = setInterval(() => { void this.cleanupIdle(); }, 60_000);
    this.cleanupTimer.unref?.();
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    this.disposePromise = this.disposeAll();
    return this.disposePromise;
  }

  /** 获取或创建 agent 专属浏览器会话 */
  async getSession(agentId: string, cdpUrl?: string): Promise<BrowserSession> {
    if (this.disposed) throw new Error('浏览器管理器已关闭');

    const existing = this.sessions.get(agentId);
    if (existing) {
      existing.lastActive = Date.now();
      return existing;
    }

    const pending = this.pendingSessions.get(agentId);
    if (pending) return pending.promise;

    const source: BrowserSession['source'] = cdpUrl ? 'cdp' : 'local';
    let tracked!: Promise<BrowserSession>;
    tracked = this.createSession(cdpUrl).then(async (session) => {
      if (session.source === 'cdp') {
        session.browser.once('disconnected', () => {
          if (this.sessions.get(agentId) !== session) return;
          this.sessions.delete(agentId);
          void this.releaseSession(session);
        });
      }
      if (this.disposed || !session.browser.isConnected()) {
        await this.releaseSession(session);
        throw new Error(this.disposed ? '浏览器管理器已关闭' : '浏览器连接已断开');
      }
      this.sessions.set(agentId, session);
      return session;
    }).finally(async () => {
      if (this.pendingSessions.get(agentId)?.promise === tracked) {
        this.pendingSessions.delete(agentId);
      }
      if (source === 'local') await this.closeLocalBrowserIfUnused();
    });
    this.pendingSessions.set(agentId, { source, promise: tracked });
    return tracked;
  }

  /** 关闭指定 agent 的浏览器 */
  async closeSession(agentId: string): Promise<void> {
    const pending = this.pendingSessions.get(agentId)?.promise;
    if (pending) {
      try { await pending; } catch { /* 创建失败时已完成资源回收 */ }
    }

    const s = this.sessions.get(agentId);
    if (s) {
      this.sessions.delete(agentId);
      await this.releaseSession(s);
    }
    await this.closeLocalBrowserIfUnused();
  }

  /** 清理空闲超时的会话 */
  private async cleanupIdle(): Promise<void> {
    const now = Date.now();
    const idleAgentIds: string[] = [];
    for (const [id, s] of this.sessions) {
      if (now - s.lastActive > IDLE_TIMEOUT_MS) idleAgentIds.push(id);
    }
    await Promise.allSettled(idleAgentIds.map((id) => this.closeSession(id)));
  }

  private async createSession(cdpUrl?: string): Promise<BrowserSession> {
    const source: BrowserSession['source'] = cdpUrl ? 'cdp' : 'local';
    const playwright = await this.loadPlaywright();
    const browser = cdpUrl
      ? await playwright.chromium.connectOverCDP(cdpUrl)
      : await this.getLocalBrowser();
    let context: import('playwright-core').BrowserContext | null = null;
    let localContextTracked = false;

    try {
      context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
      });
      if (source === 'local') {
        this.localContextCount += 1;
        localContextTracked = true;
      }
      const page = await context.newPage();
      if (!browser.isConnected()) throw new Error('浏览器连接已断开');
      return { browser, context, page, lastActive: Date.now(), source };
    } catch (error) {
      if (context) {
        try { await context.close(); } catch { /* ignore cleanup errors */ }
      }
      if (localContextTracked) this.localContextCount -= 1;
      if (source === 'cdp') await this.disconnectCdp(browser);
      throw error;
    }
  }

  private async getLocalBrowser(): Promise<import('playwright-core').Browser> {
    if (this.disposed) throw new Error('浏览器管理器已关闭');
    if (this.localBrowser?.isConnected()) return this.localBrowser;
    this.localBrowser = null;
    if (this.localBrowserPromise) return this.localBrowserPromise;

    let launchPromise!: Promise<import('playwright-core').Browser>;
    launchPromise = (async () => {
      const playwright = await this.loadPlaywright();
      const executablePath = resolveBrowserExecutable();
      const browser = await playwright.chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
        ...(executablePath ? { executablePath } : {})
      });
      if (this.disposed) {
        try { await browser.close(); } catch { /* ignore cleanup errors */ }
        throw new Error('浏览器管理器已关闭');
      }
      browser.once('disconnected', () => {
        if (this.localBrowser === browser) this.localBrowser = null;
        const disconnectedSessions: BrowserSession[] = [];
        for (const [id, session] of this.sessions) {
          if (session.source !== 'local' || session.browser !== browser) continue;
          this.sessions.delete(id);
          disconnectedSessions.push(session);
        }
        void Promise.allSettled(disconnectedSessions.map((session) => this.releaseSession(session)));
      });
      this.localBrowser = browser;
      return browser;
    })().finally(() => {
      if (this.localBrowserPromise === launchPromise) this.localBrowserPromise = null;
    });
    this.localBrowserPromise = launchPromise;
    return launchPromise;
  }

  private hasLocalSessions(): boolean {
    if (this.localContextCount > 0) return true;
    for (const session of this.sessions.values()) {
      if (session.source === 'local') return true;
    }
    for (const pending of this.pendingSessions.values()) {
      if (pending.source === 'local') return true;
    }
    return false;
  }

  private async closeLocalBrowserIfUnused(): Promise<void> {
    if (this.hasLocalSessions()) return;
    if (this.localBrowserPromise) {
      try { await this.localBrowserPromise; } catch { return; }
      if (this.hasLocalSessions()) return;
    }

    const browser = this.localBrowser;
    if (!browser || this.hasLocalSessions()) return;
    this.localBrowser = null;
    try { await browser.close(); } catch { /* ignore cleanup errors */ }
  }

  private async releaseSession(session: BrowserSession): Promise<void> {
    if (session.releasePromise) return session.releasePromise;
    let releasePromise!: Promise<void>;
    releasePromise = (async () => {
      try {
        await session.context.close();
      } catch {
        /* ignore cleanup errors */
      } finally {
        if (session.source === 'local') this.localContextCount = Math.max(0, this.localContextCount - 1);
        else await this.disconnectCdp(session.browser);
      }
    })().finally(() => {
      this.sessionReleases.delete(releasePromise);
    });
    session.releasePromise = releasePromise;
    this.sessionReleases.add(releasePromise);
    return releasePromise;
  }

  private async disconnectCdp(browser: import('playwright-core').Browser): Promise<void> {
    // 对 connectOverCDP 返回的 Browser，close() 仅释放本客户端创建的 Context
    // 并断开协议连接，不会终止用户启动的外部 Chrome 进程。
    try { await browser.close(); } catch { /* ignore cleanup errors */ }
  }

  private async disposeAll(): Promise<void> {
    await Promise.allSettled([...this.pendingSessions.values()].map((pending) => pending.promise));
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => this.releaseSession(session)));
    await Promise.allSettled([...this.sessionReleases]);
    await this.closeLocalBrowserIfUnused();
  }

  // ---------- 页面操作原语 ----------

  async navigate(agentId: string, url: string, cdpUrl?: string): Promise<string> {
    const { page } = await this.getSession(agentId, cdpUrl);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const title = await page.title();
    return `已导航到 ${url}\n页面标题：${title}`;
  }

  async click(agentId: string, selector: string): Promise<string> {
    const { page } = await this.getSession(agentId);
    await page.click(selector, { timeout: 10_000 });
    return `已点击元素：${selector}`;
  }

  async type(agentId: string, selector: string, text: string): Promise<string> {
    const { page } = await this.getSession(agentId);
    await page.fill(selector, text, { timeout: 10_000 });
    return `已在 ${selector} 输入文本（${text.length} 字符）`;
  }

  async screenshot(agentId: string, selector?: string, outputDir?: string): Promise<{ path: string; base64: string }> {
    const { page } = await this.getSession(agentId);
    if (!outputDir) throw new Error('浏览器截图需要项目产物目录');
    const screenshotDir = outputDir;
    mkdirSync(screenshotDir, { recursive: true });
    const filePath = join(screenshotDir, `agent_${agentId}_${Date.now()}.png`);
    const opts = selector
      ? { path: filePath, type: 'png' as const }
      : { path: filePath, fullPage: false, type: 'png' as const };

    if (selector) {
      const el = await page.$(selector);
      if (el) await el.screenshot(opts);
      else await page.screenshot(opts);
    } else {
      await page.screenshot(opts);
    }
    const { readFileSync } = await import('node:fs');
    const base64 = readFileSync(filePath).toString('base64');
    return { path: filePath, base64 };
  }

  async evaluate(agentId: string, script: string): Promise<string> {
    const { page } = await this.getSession(agentId);
    const result = await page.evaluate(script);
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return (text ?? 'undefined').slice(0, 16_000);
  }

  async getContent(agentId: string): Promise<string> {
    const { page } = await this.getSession(agentId);
    const text = await page.innerText('body').catch(() => '');
    return text.slice(0, 16_000) || '（页面无文本内容）';
  }

  async waitFor(agentId: string, selector: string, timeoutMs = 10_000): Promise<string> {
    const { page } = await this.getSession(agentId);
    await page.waitForSelector(selector, { timeout: timeoutMs });
    return `元素 ${selector} 已出现`;
  }
}
