/**
 * 浏览器自动化管理器（Playwright + CDP）：
 * - 按需启动 Chromium 实例（headless），每个 agent 独立浏览器上下文（隔离 cookie/storage）
 * - 支持 CDP 直连已有 Chrome（--remote-debugging-port）
 * - 提供页面操作原语：导航、点击、输入、截图、JS 执行、等待
 * - 空闲超时自动关闭（5 分钟无操作释放资源）
 */
import { join } from 'node:path';
import { app } from 'electron';
import { mkdirSync } from 'node:fs';

/** 延迟加载 playwright-core（避免未安装时阻塞启动） */
let pw: typeof import('playwright-core') | null = null;
async function getPw() {
  if (!pw) pw = await import('playwright-core');
  return pw;
}

interface BrowserSession {
  browser: import('playwright-core').Browser;
  context: import('playwright-core').BrowserContext;
  page: import('playwright-core').Page;
  lastActive: number;
}

const IDLE_TIMEOUT_MS = 5 * 60_000; // 5 分钟空闲自动关闭

export class BrowserManager {
  /** agentId → 浏览器会话 */
  private sessions = new Map<string, BrowserSession>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanupIdle(), 60_000);
  }

  dispose() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    for (const [, s] of this.sessions) {
      try { s.browser.close(); } catch { /* ignore */ }
    }
    this.sessions.clear();
  }

  /** 获取或创建 agent 专属浏览器会话 */
  async getSession(agentId: string, cdpUrl?: string): Promise<BrowserSession> {
    const existing = this.sessions.get(agentId);
    if (existing) {
      existing.lastActive = Date.now();
      return existing;
    }

    const playwright = await getPw();
    let browser: import('playwright-core').Browser;

    if (cdpUrl) {
      // CDP 直连已有 Chrome 实例
      browser = await playwright.chromium.connectOverCDP(cdpUrl);
    } else {
      // 启动新 Chromium（优先用系统 Chrome，回退 playwright 内置）
      const userDataDir = join(app.getPath('userData'), 'aibox-data', 'browser-profiles', agentId);
      mkdirSync(userDataDir, { recursive: true });
      browser = await playwright.chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
      });
    }

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    const session: BrowserSession = { browser, context, page, lastActive: Date.now() };
    this.sessions.set(agentId, session);
    return session;
  }

  /** 关闭指定 agent 的浏览器 */
  async closeSession(agentId: string) {
    const s = this.sessions.get(agentId);
    if (s) {
      try { await s.browser.close(); } catch { /* ignore */ }
      this.sessions.delete(agentId);
    }
  }

  /** 清理空闲超时的会话 */
  private cleanupIdle() {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.lastActive > IDLE_TIMEOUT_MS) {
        try { s.browser.close(); } catch { /* ignore */ }
        this.sessions.delete(id);
      }
    }
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

  async screenshot(agentId: string, selector?: string): Promise<{ path: string; base64: string }> {
    const { page } = await this.getSession(agentId);
    const screenshotDir = join(app.getPath('userData'), 'aibox-data', 'screenshots');
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
