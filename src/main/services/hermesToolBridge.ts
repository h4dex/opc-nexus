import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { PermissionMode, QuestSandbox } from '../../shared/types.js';
import type { BrowserManager } from './browserManager.js';
import { TOOLS, type ToolContext } from './executor/tools.js';

const execFileAsync = promisify(execFile);
const MAX_RESULT_CHARS = 16_000;
const MAX_VIDEO_INPUTS = 32;
const MAX_SEARCH_QUERY_CHARS = 200;
const MAX_SEARCH_RESULTS = 12;
const MAX_RESEARCH_SOURCES = 8;
const MAX_PAGE_BYTES = 512 * 1024;
const MAX_PAGE_CHARS = 8_000;
const MAX_IMAGE_PROMPT_CHARS = 12_000;
const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_INPUTS = 16;
const MAX_IMAGE_OUTPUTS = 4;
const MAX_IMAGE_RESPONSE_BYTES = 40 * 1024 * 1024;

export type HermesToolPolicy = {
  permissionMode: PermissionMode;
  sandbox: QuestSandbox;
};

export type HermesToolBridgeOptions = {
  getWorkspace: (projectId: string) => string | null;
  getPolicy: (projectId: string) => HermesToolPolicy;
  browserManager: BrowserManager;
  resolveRuntime?: () => { pythonPath: string; sourcePath: string };
  getHermesHome?: (projectId: string) => string | null;
  getImageProvider?: (projectId: string) => { baseUrl: string; model: string; key: string } | null;
  audit?: (event: { projectId: string; operation: string; result: string }) => void;
};

type ToolOperation = {
  tool: string;
  capability: 'network' | 'browser' | 'computer';
  write?: boolean;
  hostOnly?: boolean;
};

type SearchHit = {
  engine: 'Bing' | 'DuckDuckGo';
  title: string;
  url: string;
  snippet: string;
};

type SearchEngineReport = {
  engine: SearchHit['engine'];
  status: 'ok' | 'unavailable';
  resultCount: number;
  error?: string;
};

const TOOL_OPERATIONS: Record<string, ToolOperation> = {
  'web-search': { tool: 'web_search', capability: 'network' },
  'http-request': { tool: 'http_request', capability: 'network' },
  'browser-navigate': { tool: 'browser_navigate', capability: 'browser' },
  'browser-snapshot': { tool: 'browser_get_content', capability: 'browser' },
  'browser-get-content': { tool: 'browser_get_content', capability: 'browser' },
  'browser-click': { tool: 'browser_click', capability: 'browser', write: true },
  'browser-type': { tool: 'browser_type', capability: 'browser', write: true },
  'browser-screenshot': { tool: 'browser_screenshot', capability: 'browser' },
  'browser-evaluate': { tool: 'browser_evaluate', capability: 'browser', write: true },
  'computer-screenshot': { tool: 'computer_screenshot', capability: 'computer', hostOnly: true },
  'computer-click': { tool: 'computer_click', capability: 'computer', write: true, hostOnly: true },
  'computer-type': { tool: 'computer_type', capability: 'computer', write: true, hostOnly: true },
  'computer-key': { tool: 'computer_key', capability: 'computer', write: true, hostOnly: true },
};

function trimResult(value: string): string {
  return value.length > MAX_RESULT_CHARS ? `${value.slice(0, MAX_RESULT_CHARS)}\n...[truncated]` : value;
}

function mediaType(path: string): string {
  const extension = extname(path).toLowerCase();
  const types: Record<string, string> = {
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp'
  };
  return types[extension] ?? 'application/octet-stream';
}

function hashFile(path: string): { size: number; sha256: string } {
  const data = readFileSync(path);
  return { size: data.byteLength, sha256: createHash('sha256').update(data).digest('hex') };
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/gi, '"').replace(/&apos;|&#39;/gi, "'")
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function cleanHtmlText(value: string): string {
  return decodeHtml(value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSearchUrl(value: string): string | null {
  try {
    const url = new URL(decodeHtml(value));
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    // Search engines add tracking parameters which make the same source look
    // different. Keep functional query parameters but drop common trackers.
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|gclid$|fbclid$|msclkid$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function parseBingResults(html: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const block of html.split(/class=["'][^"']*b_algo[^"']*["']/i).slice(1, limit + 1)) {
    const match = block.match(/<h2[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/i)
      ?? block.match(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!match) continue;
    const url = normalizeSearchUrl(match[1]);
    const title = cleanHtmlText(match[2]);
    const snippet = cleanHtmlText(block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? '');
    if (url && title) hits.push({ engine: 'Bing', title, url, snippet: snippet.slice(0, 500) });
  }
  return hits;
}

function parseDuckDuckGoResults(html: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const blocks = html.split(/result__body/i).slice(1, limit + 1);
  for (const block of blocks) {
    const match = block.match(/class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!match) continue;
    let rawUrl = match[1];
    try {
      const redirect = new URL(rawUrl, 'https://duckduckgo.com');
      rawUrl = redirect.searchParams.get('uddg') ?? redirect.toString();
    } catch { /* normalizeSearchUrl below reports malformed links */ }
    const url = normalizeSearchUrl(rawUrl);
    const title = cleanHtmlText(match[2]);
    const snippet = cleanHtmlText(block.match(/class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1] ?? '');
    if (url && title) hits.push({ engine: 'DuckDuckGo', title, url, snippet: snippet.slice(0, 500) });
  }
  return hits;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('..'));
}

export class HermesToolBridge {
  private readonly byName = new Map(TOOLS.map((tool) => [tool.name, tool]));

  constructor(private readonly options: HermesToolBridgeOptions) {}

  async execute(projectId: string, operation: string, payload: unknown): Promise<unknown> {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Hermes 工具参数必须是对象');
    }
    const args = payload as Record<string, unknown>;
    const operationSpec = TOOL_OPERATIONS[operation];
    try {
      if (operationSpec) {
        const result = await this.executeExecutorTool(projectId, operation, operationSpec, args);
        this.audit(projectId, operation, 'ok');
        return result;
      }
      let result: unknown;
      switch (operation) {
        case 'web-search-aggregate': result = await this.searchAggregate(projectId, args); break;
        case 'research-search': result = await this.researchSearch(projectId, args); break;
        case 'audio-synthesize': result = await this.synthesizeAudio(projectId, args); break;
        case 'video-probe': result = await this.videoProbe(projectId, args); break;
        case 'video-trim': result = await this.videoTrim(projectId, args); break;
        case 'video-concat': result = await this.videoConcat(projectId, args); break;
        case 'video-extract-audio': result = await this.videoExtractAudio(projectId, args); break;
        case 'video-thumbnail': result = await this.videoThumbnail(projectId, args); break;
        case 'image-generate': result = await this.imageGenerate(projectId, args); break;
        default: throw new Error(`Hermes 工具不存在：${operation}`);
      }
      this.audit(projectId, operation, 'ok');
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.audit(projectId, operation, `error:${message.slice(0, 500)}`);
      throw error;
    }
  }

  private audit(projectId: string, operation: string, result: string): void {
    this.options.audit?.({ projectId, operation, result });
  }

  private async querySearchEngine(
    engine: SearchHit['engine'],
    query: string,
    limit: number
  ): Promise<{ hits: SearchHit[]; error?: string }> {
    const encoded = encodeURIComponent(query);
    const endpoint = engine === 'Bing'
      ? `https://cn.bing.com/search?q=${encoded}&count=${limit}`
      : `https://html.duckduckgo.com/html/?q=${encoded}`;
    try {
      const response = await fetch(endpoint, {
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'user-agent': 'OPC-Nexus-Research/1.0'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) return { hits: [], error: `HTTP ${response.status}` };
      const html = (await response.text()).slice(0, 2 * 1024 * 1024);
      return {
        hits: engine === 'Bing'
          ? parseBingResults(html, limit)
          : parseDuckDuckGoResults(html, limit)
      };
    } catch (error) {
      return { hits: [], error: error instanceof Error ? error.message.slice(0, 300) : String(error) };
    }
  }

  private validateSearchArgs(args: Record<string, unknown>): { query: string; maxResults: number } {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query || query.length > MAX_SEARCH_QUERY_CHARS) {
      throw new Error(`搜索关键词不能为空且不能超过 ${MAX_SEARCH_QUERY_CHARS} 个字符`);
    }
    const maxResults = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Math.trunc(Number(args.maxResults ?? 8))));
    return { query, maxResults };
  }

  private async searchAggregate(projectId: string, args: Record<string, unknown>): Promise<unknown> {
    this.workspace(projectId);
    const { query, maxResults } = this.validateSearchArgs(args);
    const engineResults = await Promise.all((['Bing', 'DuckDuckGo'] as const).map(async (engine) => {
      const result = await this.querySearchEngine(engine, query, maxResults);
      const report: SearchEngineReport = {
        engine,
        status: result.hits.length > 0 ? 'ok' : 'unavailable',
        resultCount: result.hits.length,
        ...(result.error ? { error: result.error } : {})
      };
      return { report, hits: result.hits };
    }));
    const reports = engineResults.map((entry) => entry.report);
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const entry of engineResults) {
      for (const hit of entry.hits) {
        if (seen.has(hit.url)) continue;
        seen.add(hit.url);
        hits.push(hit);
        if (hits.length >= maxResults) break;
      }
      if (hits.length >= maxResults) break;
    }
    return {
      query,
      generatedAt: new Date().toISOString(),
      engines: reports,
      results: hits.map((hit, index) => ({ id: `S${index + 1}`, ...hit }))
    };
  }

  private async readLimitedResponse(response: Response): Promise<string> {
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_PAGE_BYTES) throw new Error(`响应超过 ${MAX_PAGE_BYTES} 字节上限`);
    if (!response.body) return (await response.text()).slice(0, MAX_PAGE_BYTES);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let value = '';
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_PAGE_BYTES) {
          await reader.cancel();
          throw new Error(`响应超过 ${MAX_PAGE_BYTES} 字节上限`);
        }
        value += decoder.decode(part.value, { stream: true });
      }
      return `${value}${decoder.decode()}`;
    } finally {
      reader.releaseLock();
    }
  }

  private async fetchResearchSource(hit: SearchHit, id: string): Promise<Record<string, unknown>> {
    const fetchedAt = new Date().toISOString();
    try {
      const response = await fetch(hit.url, {
        headers: {
          accept: 'text/html, text/plain, application/json;q=0.8',
          'user-agent': 'OPC-Nexus-Research/1.0'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000)
      });
      const contentType = response.headers.get('content-type') ?? '';
      if (!response.ok) {
        return { id, ...hit, fetchedAt, fetchStatus: 'failed', httpStatus: response.status, error: `HTTP ${response.status}` };
      }
      if (contentType && !/(text\/html|text\/plain|application\/json|application\/xml)/i.test(contentType)) {
        return { id, ...hit, fetchedAt, fetchStatus: 'skipped', httpStatus: response.status, error: `不支持的内容类型：${contentType}` };
      }
      const raw = await this.readLimitedResponse(response);
      const content = cleanHtmlText(raw).slice(0, MAX_PAGE_CHARS);
      return {
        id, ...hit, fetchedAt, fetchStatus: content ? 'fetched' : 'empty',
        httpStatus: response.status, content
      };
    } catch (error) {
      return {
        id, ...hit, fetchedAt, fetchStatus: 'failed',
        error: error instanceof Error ? error.message.slice(0, 500) : String(error)
      };
    }
  }

  private async researchSearch(projectId: string, args: Record<string, unknown>): Promise<unknown> {
    this.workspace(projectId);
    const { query, maxResults } = this.validateSearchArgs(args);
    const maxSources = Math.min(MAX_RESEARCH_SOURCES, Math.max(1, Math.trunc(Number(args.maxSources ?? Math.min(maxResults, 6)))));
    const domains = Array.isArray(args.domains)
      ? args.domains.filter((value): value is string => typeof value === 'string' && !!value.trim()).map((value) => value.trim().toLowerCase()).slice(0, 20)
      : [];
    const aggregate = await this.searchAggregate(projectId, { query, maxResults });
    const aggregateResults = (aggregate as { results?: SearchHit[] }).results ?? [];
    const selected = aggregateResults.filter((hit) => {
      if (domains.length === 0) return true;
      try { return domains.some((domain) => new URL(hit.url).hostname.toLowerCase().endsWith(domain)); } catch { return false; }
    }).slice(0, maxSources);
    const sources = await Promise.all(selected.map((hit, index) => this.fetchResearchSource(hit, `S${index + 1}`)));
    const citations = sources.map((source) => {
      const title = String(source.title ?? source.url);
      const status = String(source.fetchStatus ?? 'unknown');
      const content = typeof source.content === 'string' ? source.content : String(source.error ?? '');
      return `[${source.id}] ${title}\nURL: ${source.url}\n状态: ${status}\n${content.slice(0, 2_000)}`;
    }).join('\n\n');
    return {
      query,
      generatedAt: new Date().toISOString(),
      search: aggregate,
      sources,
      citationText: citations,
      instructions: '引用资料时保留 [S#] 标记；只使用 fetchStatus=fetched/empty 的来源支持事实，failed/skipped 只能作为检索失败记录。'
    };
  }

  private policy(projectId: string, spec: { write?: boolean; hostOnly?: boolean }, args: Record<string, unknown>): void {
    const policy = this.options.getPolicy(projectId);
    if (spec.write && policy.permissionMode === 'readonly') {
      throw new Error('当前 Quest 为只读权限，不能执行写入工具');
    }
    if (spec.hostOnly && policy.sandbox !== 'host') {
      throw new Error('电脑控制需要将 Quest 沙箱切换为“主机”并重新确认');
    }
    if (spec.write && args.ownerConfirmed !== true) {
      throw new Error('写入工具需要 ownerConfirmed=true；只有老板明确要求该动作时才允许调用');
    }
  }

  private workspace(projectId: string): string {
    const root = this.options.getWorkspace(projectId);
    if (!root) throw new Error('项目尚未配置工作目录，无法执行 Hermes 工具');
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error('项目工作目录不存在或不是目录');
    return realpathSync(root);
  }

  private pathInWorkspace(root: string, value: unknown, label: string, mustExist: boolean): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`);
    const candidate = resolve(root, value.trim());
    if (!isInside(root, candidate)) throw new Error(`${label}必须位于项目工作目录内`);
    if (mustExist) {
      if (!existsSync(candidate)) throw new Error(`${label}不存在：${value}`);
      const real = realpathSync(candidate);
      if (!isInside(root, real)) throw new Error(`${label}不能通过符号链接逃逸工作目录`);
      return real;
    }
    // Output directories may be created by the operation. Resolve the nearest
    // existing ancestor first so a not-yet-created `out/media/file.mp4` is
    // still checked for symlink escape before mkdir is allowed.
    let parentPath = dirname(candidate);
    while (!existsSync(parentPath) && parentPath !== root) parentPath = dirname(parentPath);
    const parent = realpathSync(parentPath);
    if (!isInside(root, parent)) throw new Error(`${label}父目录不能通过符号链接逃逸工作目录`);
    if (existsSync(candidate)) {
      const existing = realpathSync(candidate);
      if (!isInside(root, existing)) throw new Error(`${label}不能通过符号链接逃逸工作目录`);
    }
    return candidate;
  }

  private async executeExecutorTool(
    projectId: string,
    operation: string,
    spec: ToolOperation,
    args: Record<string, unknown>
  ): Promise<string> {
    const method = operation === 'http-request'
      ? String(args.method ?? '').trim().toUpperCase() || 'GET'
      : '';
    this.policy(projectId, { write: spec.write || (operation === 'http-request' && method !== 'GET'), hostOnly: spec.hostOnly }, args);
    const tool = this.byName.get(spec.tool);
    if (!tool) throw new Error(`OPC-Nexus 执行器没有注册工具：${spec.tool}`);
    const workspace = this.workspace(projectId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Hermes 工具执行超时')), 120_000);
    try {
      const context: ToolContext = {
        workspace,
        agentId: `hermes-${projectId}`,
        taskId: `hermes-tool-${randomUUID()}`,
        host: null,
        signal: controller.signal,
        browserMgr: this.options.browserManager,
      };
      return trimResult(await tool.execute(args, context));
    } finally {
      clearTimeout(timer);
    }
  }

  private async runFfmpeg(args: string[], timeoutMs = 5 * 60_000): Promise<{ stdout: string; stderr: string }> {
    const command = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    try {
      return await execFileAsync(command, ['-hide_banner', ...args], {
        timeout: timeoutMs, windowsHide: true, shell: false, maxBuffer: 4 * 1024 * 1024
      });
    } catch (error) {
      const detail = error as { stderr?: string; message?: string; code?: string | number };
      if (detail.code === 'ENOENT') throw new Error('FFmpeg 未安装或不在 PATH 中，视频工具不可用');
      throw new Error(`FFmpeg 执行失败：${String(detail.stderr || detail.message || error).slice(-4000)}`);
    }
  }

  private artifact(root: string, path: string): Record<string, unknown> {
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`媒体工具未生成真实文件：${path}`);
    const meta = hashFile(path);
    return { path: relative(root, path).replaceAll('\\', '/'), mediaType: mediaType(path), ...meta };
  }

  private async synthesizeAudio(projectId: string, args: Record<string, unknown>): Promise<unknown> {
    this.policy(projectId, { write: true }, args);
    const root = this.workspace(projectId);
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text || text.length > 20_000) throw new Error('音频文本不能为空且不能超过 20000 字符');
    const output = this.pathInWorkspace(root, args.outputPath ?? '.opc-nexus/audio/tts.mp3', '输出文件', false);
    mkdirSync(dirname(output), { recursive: true });
    const voice = typeof args.voice === 'string' && args.voice.trim() ? args.voice.trim() : 'zh-CN-XiaoxiaoNeural';
    const command = process.platform === 'win32' ? 'edge-tts.cmd' : 'edge-tts';
    try {
      await execFileAsync(command, ['--text', text, '--voice', voice, '--write-media', output], {
        cwd: root, timeout: 120_000, windowsHide: true, shell: false, maxBuffer: 512 * 1024
      });
    } catch (error) {
      const detail = error as { stderr?: string; message?: string; code?: string | number };
      if (detail.code !== 'ENOENT') {
        throw new Error(`音频合成失败：${String(detail.stderr || detail.message || error).slice(-4000)}`);
      }
      // The bundled Hermes runtime may have edge-tts as a Python module even
      // when its CLI entrypoint is not on the host PATH. Reuse that configured
      // provider before reporting an unavailable capability.
      const launch = this.options.resolveRuntime?.();
      const home = this.options.getHermesHome?.(projectId);
      if (!launch || !home) throw new Error('Edge TTS 未安装，且 Hermes 运行时没有可用的 TTS 配置');
      const script = [
        'import json, os',
        'from tools.tts_tool import text_to_speech_tool',
        'result = text_to_speech_tool(os.environ["OPC_NEXUS_TTS_TEXT"], os.environ["OPC_NEXUS_TTS_OUTPUT"])',
        'print(result)',
      ].join('; ');
      const result = await execFileAsync(launch.pythonPath, ['-c', script], {
        cwd: root,
        timeout: 180_000,
        windowsHide: true,
        shell: false,
        maxBuffer: 512 * 1024,
        env: {
          ...process.env,
          HERMES_HOME: home,
          PYTHONPATH: [launch.sourcePath, process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
          OPC_NEXUS_TTS_TEXT: text,
          OPC_NEXUS_TTS_OUTPUT: output,
        }
      });
      const raw = String(result.stdout ?? '').trim();
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as { success?: boolean; error?: string };
          if (parsed.success === false) throw new Error(parsed.error || 'Hermes TTS provider rejected the request');
        } catch (parseError) {
          if (parseError instanceof Error && /TTS|provider|音频/i.test(parseError.message)) throw parseError;
        }
      }
    }
    return this.artifact(root, output);
  }

  private async videoProbe(projectId: string, args: Record<string, unknown>): Promise<unknown> {
    const root = this.workspace(projectId);
    const input = this.pathInWorkspace(root, args.inputPath, '输入视频', true);
    try {
      const result = await this.runFfmpeg(['-i', input, '-f', 'null', '-'], 120_000);
      return trimResult(result.stderr || result.stdout || '视频探测完成');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/FFmpeg 执行失败/.test(message) && /Duration:|Stream #/.test(message)) return trimResult(message);
      throw error;
    }
  }

  private async videoTrim(projectId: string, args: Record<string, unknown>): Promise<unknown> {
    this.policy(projectId, { write: true }, args);
    const root = this.workspace(projectId);
    const input = this.pathInWorkspace(root, args.inputPath, '输入视频', true);
    const output = this.pathInWorkspace(root, args.outputPath, '输出视频', false);
    const start = Number(args.startSec ?? 0);
    const duration = args.durationSec === undefined ? null : Number(args.durationSec);
    if (!Number.isFinite(start) || start < 0 || (duration !== null && (!Number.isFinite(duration) || duration <= 0))) {
      throw new Error('剪切时间参数无效');
    }
    mkdirSync(dirname(output), { recursive: true });
    const ffArgs = ['-y', '-ss', String(start), '-i', input];
    if (duration !== null) ffArgs.push('-t', String(duration));
    ffArgs.push('-map', '0', '-c', 'copy', output);
    await this.runFfmpeg(ffArgs);
    return this.artifact(root, output);
  }

  private async videoConcat(projectId: string, args: Record<string, unknown>): Promise<unknown> {
    this.policy(projectId, { write: true }, args);
    const root = this.workspace(projectId);
    if (!Array.isArray(args.inputPaths) || args.inputPaths.length < 2 || args.inputPaths.length > MAX_VIDEO_INPUTS) {
      throw new Error(`拼接至少需要 2 个、最多 ${MAX_VIDEO_INPUTS} 个视频`);
    }
    const inputs = args.inputPaths.map((value, index) => this.pathInWorkspace(root, value, `输入视频[${index}]`, true));
    const output = this.pathInWorkspace(root, args.outputPath, '输出视频', false);
    mkdirSync(dirname(output), { recursive: true });
    const listPath = resolve(root, `.opc-nexus/.concat-${randomUUID()}.txt`);
    mkdirSync(dirname(listPath), { recursive: true });
    writeFileSync(listPath, inputs.map((input) => `file '${input.replaceAll("'", "'\\''")}'`).join('\n'), 'utf8');
    try {
      await this.runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', output]);
    } finally {
      rmSync(listPath, { force: true });
    }
    return this.artifact(root, output);
  }

  private async videoExtractAudio(projectId: string, args: Record<string, unknown>): Promise<unknown> {
    this.policy(projectId, { write: true }, args);
    const root = this.workspace(projectId);
    const input = this.pathInWorkspace(root, args.inputPath, '输入视频', true);
    const output = this.pathInWorkspace(root, args.outputPath, '输出音频', false);
    mkdirSync(dirname(output), { recursive: true });
    await this.runFfmpeg(['-y', '-i', input, '-map', '0:a:0', '-vn', '-c:a', 'copy', output]);
    return this.artifact(root, output);
  }

  private async videoThumbnail(projectId: string, args: Record<string, unknown>): Promise<unknown> {
    this.policy(projectId, { write: true }, args);
    const root = this.workspace(projectId);
    const input = this.pathInWorkspace(root, args.inputPath, '输入视频', true);
    const output = this.pathInWorkspace(root, args.outputPath, '输出图片', false);
    const at = Number(args.timeSec ?? 0);
    if (!Number.isFinite(at) || at < 0) throw new Error('缩略图时间参数无效');
    mkdirSync(dirname(output), { recursive: true });
    await this.runFfmpeg(['-y', '-ss', String(at), '-i', input, '-frames:v', '1', '-vf', 'scale=1280:-2', output]);
    return this.artifact(root, output);
  }

  private validateImageSize(value: unknown): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || !/^(1024x1024|1536x1024|1024x1536|auto)$/.test(value)) {
      throw new Error('图片尺寸只支持 1024x1024、1536x1024、1024x1536 或 auto');
    }
    return value;
  }

  private async readLimitedBinary(response: Response): Promise<Buffer> {
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_IMAGE_RESPONSE_BYTES) throw new Error(`图片响应超过 ${MAX_IMAGE_RESPONSE_BYTES} 字节上限`);
    if (!response.body) {
      const data = Buffer.from(await response.arrayBuffer());
      if (data.byteLength > MAX_IMAGE_RESPONSE_BYTES) throw new Error(`图片响应超过 ${MAX_IMAGE_RESPONSE_BYTES} 字节上限`);
      return data;
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_IMAGE_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error(`图片响应超过 ${MAX_IMAGE_RESPONSE_BYTES} 字节上限`);
        }
        chunks.push(Buffer.from(part.value));
      }
      return Buffer.concat(chunks);
    } finally {
      reader.releaseLock();
    }
  }

  private imageExtension(value: string | null | undefined): string {
    const contentType = String(value ?? '').toLowerCase().split(';', 1)[0];
    if (contentType === 'image/jpeg' || contentType === 'image/jpg') return '.jpg';
    if (contentType === 'image/webp') return '.webp';
    if (contentType === 'image/avif') return '.avif';
    return '.png';
  }

  private async imageBytesFromEntry(entry: Record<string, unknown>): Promise<{ bytes: Buffer; extension: string }> {
    const b64 = typeof entry.b64_json === 'string' ? entry.b64_json.trim() : '';
    if (b64) {
      if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
        throw new Error('图片 Provider 返回了无效的 b64_json');
      }
      let bytes: Buffer;
      try { bytes = Buffer.from(b64, 'base64'); } catch { throw new Error('图片 Provider 返回了无效的 b64_json'); }
      if (!bytes.byteLength) throw new Error('图片 Provider 返回了空的 b64_json');
      if (bytes.byteLength > MAX_IMAGE_RESPONSE_BYTES) throw new Error(`图片响应超过 ${MAX_IMAGE_RESPONSE_BYTES} 字节上限`);
      return { bytes, extension: this.imageExtension(typeof entry.mime_type === 'string' ? entry.mime_type : null) };
    }
    const url = typeof entry.url === 'string' ? entry.url.trim() : '';
    if (!url) throw new Error('图片 Provider 返回项缺少 b64_json 或 url');
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error('图片 Provider 返回了无效的下载 URL'); }
    if (parsed.protocol !== 'https:') throw new Error('图片 Provider 返回的 URL 必须使用 HTTPS');
    const response = await fetch(parsed, {
      headers: { accept: 'image/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(60_000)
    });
    if (!response.ok) throw new Error(`下载图片结果失败：HTTP ${response.status}`);
    const contentType = response.headers.get('content-type');
    if (contentType && !/^image\//i.test(contentType)) throw new Error(`图片结果内容类型无效：${contentType}`);
    return { bytes: await this.readLimitedBinary(response), extension: this.imageExtension(contentType) };
  }

  private imageOutputPath(root: string, requested: unknown, index: number, extension: string): string {
    const fallback = `.opc-nexus/images/image-${Date.now()}-${randomUUID().slice(0, 8)}${extension}`;
    const candidate = requested === undefined || requested === null || requested === ''
      ? fallback
      : String(requested);
    const withExtension = extname(candidate) ? candidate : `${candidate}${extension}`;
    if (index === 0) return this.pathInWorkspace(root, withExtension, '输出图片', false);
    const extensionName = extname(withExtension);
    const stem = withExtension.slice(0, -extensionName.length);
    return this.pathInWorkspace(root, `${stem}-${index + 1}${extensionName}`, '输出图片', false);
  }

  private writeImageArtifact(root: string, output: string, bytes: Buffer): Record<string, unknown> {
    mkdirSync(dirname(output), { recursive: true });
    const temporary = `${output}.tmp-${randomUUID()}`;
    writeFileSync(temporary, bytes, { flag: 'wx' });
    // A completed image is only exposed after the write is complete.
    rmSync(output, { force: true });
    renameSync(temporary, output);
    return this.artifact(root, output);
  }

  private async imageGenerate(projectId: string, args: Record<string, unknown>): Promise<unknown> {
    this.policy(projectId, { write: true }, args);
    const root = this.workspace(projectId);
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!prompt || prompt.length > MAX_IMAGE_PROMPT_CHARS) {
      throw new Error(`图片提示词不能为空且不能超过 ${MAX_IMAGE_PROMPT_CHARS} 个字符`);
    }
    const provider = this.options.getImageProvider?.(projectId);
    if (!provider?.baseUrl || !provider.model || !provider.key) {
      throw new Error('未配置可用的图片 Provider；请先在 Provider 中配置支持 images API 的真实模型和 API Key');
    }
    const model = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : provider.model;
    if (model.length > 160 || /[\u0000-\u001f\u007f]/.test(model)) throw new Error('图片模型名称无效');
    const size = this.validateImageSize(args.size);
    const quality = args.quality === undefined ? undefined : String(args.quality);
    if (quality !== undefined && !['auto', 'low', 'medium', 'high'].includes(quality)) throw new Error('图片质量只支持 auto、low、medium、high');
    const requestedCount = Number(args.count ?? args.n ?? 1);
    if (!Number.isSafeInteger(requestedCount) || requestedCount < 1) throw new Error('图片数量无效');
    const count = Math.min(MAX_IMAGE_OUTPUTS, requestedCount);
    const rawInputs = args.imagePaths ?? (args.imagePath === undefined ? [] : [args.imagePath]);
    if (!Array.isArray(rawInputs) || rawInputs.length > MAX_IMAGE_INPUTS) throw new Error(`参考图片最多 ${MAX_IMAGE_INPUTS} 张`);
    const inputs = rawInputs.map((value, index) => {
      const path = this.pathInWorkspace(root, value, `参考图片[${index}]`, true);
      const stat = statSync(path);
      if (stat.size > MAX_IMAGE_INPUT_BYTES) throw new Error(`参考图片[${index}]超过 ${MAX_IMAGE_INPUT_BYTES} 字节上限`);
      if (!/^\.(png|jpe?g|webp)$/i.test(extname(path))) throw new Error(`参考图片[${index}]只支持 PNG、JPEG 或 WebP`);
      return path;
    });
    const headers = { Authorization: `Bearer ${provider.key}` };
    const endpoint = `${provider.baseUrl.replace(/\/+$/, '')}/${inputs.length ? 'images/edits' : 'images/generations'}`;
    // GPT Image models always return b64_json and reject the legacy DALL-E
    // response_format parameter. Keep response_format for other OpenAI-
    // compatible models that still require it to request binary-safe output.
    const isGptImageModel = /^gpt-image-/i.test(model);
    let response: Response;
    if (!inputs.length) {
      const body: Record<string, unknown> = { model, prompt, n: count };
      if (!isGptImageModel) body.response_format = 'b64_json';
      if (size && size !== 'auto') body.size = size;
      if (quality) body.quality = quality;
      response = await fetch(endpoint, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(5 * 60_000)
      });
    } else {
      const form = new FormData();
      form.append('model', model);
      form.append('prompt', prompt);
      form.append('n', String(count));
      if (!isGptImageModel) form.append('response_format', 'b64_json');
      if (size && size !== 'auto') form.append('size', size);
      if (quality) form.append('quality', quality);
      for (const input of inputs) {
        const bytes = readFileSync(input);
        const blob = new Blob([bytes], { type: mediaType(input) });
        form.append(inputs.length === 1 ? 'image' : 'image[]', blob, input.slice(input.lastIndexOf(sep) + 1));
      }
      response = await fetch(endpoint, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(5 * 60_000) });
    }
    let payload: unknown;
    try { payload = JSON.parse((await this.readLimitedBinary(response)).toString('utf8')); } catch { payload = null; }
    if (!response.ok) {
      const detail = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).error
        : null;
      const message = detail && typeof detail === 'object' && !Array.isArray(detail)
        ? String((detail as Record<string, unknown>).message ?? '')
        : String(detail ?? '');
      throw new Error(`图片 Provider 请求失败（HTTP ${response.status}）${message ? `：${message.slice(0, 1_000)}` : ''}`);
    }
    const entries = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).data
      : null;
    if (!Array.isArray(entries) || entries.length === 0) throw new Error('图片 Provider 未返回任何图片结果');
    const artifacts: Record<string, unknown>[] = [];
    for (let index = 0; index < Math.min(entries.length, MAX_IMAGE_OUTPUTS); index += 1) {
      const entry = entries[index];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`图片 Provider 返回项 ${index + 1} 无效`);
      const decoded = await this.imageBytesFromEntry(entry as Record<string, unknown>);
      const output = this.imageOutputPath(root, args.outputPath, index, decoded.extension);
      artifacts.push(this.writeImageArtifact(root, output, decoded.bytes));
    }
    return { model, mode: inputs.length ? 'image-to-image' : 'text-to-image', count: artifacts.length, images: artifacts };
  }
}
