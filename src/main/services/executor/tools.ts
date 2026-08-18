/**
 * 工具注册表（P1b/P3b，MCP 风格：name + JSON Schema + execute，为后续 MCP 接入打底）
 * - 全部文件工具限定在员工 workspace 内：resolve 后必须落在 workspace 前缀下（7.2 边界）
 * - risk 三级：safe（只读）/ write（写入）/ danger（删除等）；审批策略由执行器按 permissionMode 决定
 * - delegate_task（P3b A2A 内部委托）通过 ToolHost 回调编排器，避免循环依赖
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import type { ApprovalType, Task } from '../../../shared/types.js';
import { childProcessEnv } from '../engineEnv.js';

export type ToolRisk = 'safe' | 'write' | 'danger';

/** 工具所需能力标签（与 AgentCapabilities 字段对应，未标记则无额外要求） */
export type ToolCapability = 'network' | 'shell' | 'install' | 'browser' | 'computer';

export interface ToolContext {
  workspace: string;
  agentId: string;
  taskId: string;
  host: ToolHost | null;
  /** 浏览器管理器（browser 能力工具使用，由执行器注入） */
  browserMgr?: import('../browserManager.js').BrowserManager | null;
  /** OCR 服务（由执行器注入，未启用时为 null） */
  ocrService?: import('../ocrService.js').OcrService | null;
}

/** 编排器能力注入（委托创建/等待子任务），由 main 装配 */
export interface ToolHost {
  findAgentIdByName(name: string, parentTaskId: string): string | null;
  createDelegatedTask(agentId: string, title: string, parentTaskId: string): Task;
  /**
   * Wait for a child task. When parentTaskId is supplied, the host also
   * watches the parent and cancels the child if the parent disappears or
   * reaches a terminal state.
   */
  waitForTask(taskId: string, timeoutMs: number, parentTaskId?: string): Promise<Task | null>;
  /** Cancel a delegated child after timeout/parent cancellation. Optional to
   * preserve compatibility with older external ToolHost implementations. */
  cancelTask?(taskId: string, reason?: string): void;
  /**
   * Capacity check used by same-agent engine delegation. A child that cannot
   * acquire a slot would otherwise wait behind the parent forever.
   */
  delegationCapacity?(agentId: string, parentTaskId: string): {
    available: boolean;
    active: number;
    limit: number;
    reason?: string;
  };
  /** 委托深度（parentId 链长度），防止无限递归 */
  delegationDepth(taskId: string): number;
  /** 主 Agent 全局调度：列出所有在岗员工 */
  listReadyAgents?(): { id: string; name: string; role: string }[];
  /** 主 Agent 全局调度：触发专家团 */
  triggerTeamByName?(teamName: string, task: string): { ok: boolean; message: string };
  /** E-2 编码委派：把编码类子任务交给指定引擎（OpenCode）执行，员工归属不变 */
  createEngineDelegatedTask?(agentId: string, title: string, parentTaskId: string, engineId: string): Task;
  /** E-2：编码引擎是否可用（未安装/未就绪时不注册委派工具，避免模型调用必然失败的工具） */
  codingEngineReady?(): { ready: boolean; engineId: string; name: string };
}

export interface ToolDef {
  name: string;
  description: string;
  risk: ToolRisk;
  /** 需要员工开启对应能力开关才注册该工具（未设置 = 无额外要求） */
  requiresCapability?: ToolCapability;
  /** Autonomous mode still confirms operations that cross the project boundary. */
  autonomousApproval?: ApprovalType | ((args: Record<string, unknown>) => ApprovalType | null);
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

const MAX_READ_CHARS = 24_000;
const MAX_DELEGATE_WAIT_MS = 10 * 60_000;
const RUN_COMMAND_HOST_ENV_ALLOWLIST = new Set([
  'COMSPEC', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'LANG', 'LANGUAGE',
  'LC_ALL', 'LC_CTYPE', 'NODE_EXTRA_CA_CERTS', 'NUMBER_OF_PROCESSORS',
  'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432',
  'SHELL', 'SSL_CERT_DIR', 'SSL_CERT_FILE', 'SYSTEMDRIVE', 'SYSTEMROOT',
  'TEMP', 'TERM', 'TMP', 'TMPDIR', 'TZ', 'USER', 'USERNAME', 'USERPROFILE',
  'WINDIR'
]);

function runCommandProcessEnv(): NodeJS.ProcessEnv {
  const env = childProcessEnv({});
  for (const key of Object.keys(env)) {
    if (!RUN_COMMAND_HOST_ENV_ALLOWLIST.has(key.toUpperCase())) delete env[key];
  }
  return env;
}

// ---------- Web 搜索辅助（国内优先：Bing 中国 → DuckDuckGo 回退） ----------

/** Bing 中国搜索（cn.bing.com 国内可达，无需 API Key，抓取 HTML 解析摘要） */
async function searchBing(query: string): Promise<string | null> {
  try {
    const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=6`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' }
    });
    if (!res.ok) return null;
    const html = await res.text();
    // 解析搜索结果：<li class="b_algo"> 内含 <h2><a href="...">title</a></h2> 和 <p>snippet</p>
    const results: string[] = [];
    const blocks = html.split(/class="b_algo"/).slice(1, 7);
    for (const block of blocks) {
      const titleMatch = block.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
      if (!titleMatch) continue;
      const link = titleMatch[1] ?? '';
      const title = titleMatch[2]?.replace(/<[^>]+>/g, '').trim() ?? '';
      const snippet = snippetMatch?.[1]?.replace(/<[^>]+>/g, '').trim() ?? '';
      if (title) results.push(`- ${title}${snippet ? `：${snippet.slice(0, 150)}` : ''}\n  ${link}`);
    }
    if (results.length === 0) return null;
    return `搜索结果（Bing）：\n${results.join('\n')}`;
  } catch {
    return null; // 网络不可达时静默回退到下一个搜索源
  }
}

/** DuckDuckGo Instant Answer API（海外回退，免费无需 Key） */
async function searchDuckDuckGo(query: string): Promise<string | null> {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const data = await res.json() as {
      AbstractText?: string; AbstractURL?: string; Answer?: string;
      RelatedTopics?: { Text?: string; FirstURL?: string }[];
      Results?: { Text?: string; FirstURL?: string }[];
    };
    const parts: string[] = [];
    if (data.Answer) parts.push(`答案：${data.Answer}`);
    if (data.AbstractText) parts.push(`摘要：${data.AbstractText}\n来源：${data.AbstractURL ?? ''}`);
    const topics = [...(data.Results ?? []), ...(data.RelatedTopics ?? [])].slice(0, 6);
    for (const t of topics) {
      if (t.Text) parts.push(`- ${t.Text}${t.FirstURL ? ` (${t.FirstURL})` : ''}`);
    }
    if (parts.length === 0) return null;
    return parts.join('\n');
  } catch {
    return null;
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function nearestExistingAncestor(path: string): string {
  let candidate = path;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error('工作目录不存在');
    candidate = parent;
  }
  return candidate;
}

/** 拒绝词法路径和符号链接两种 workspace 逃逸。 */
export function resolveInWorkspace(workspace: string, relPath: unknown): string {
  const p = typeof relPath === 'string' ? relPath : '';
  const root = resolve(workspace);
  const full = resolve(root, p);
  if (!isInside(root, full)) {
    throw new Error(`路径越界：仅允许访问工作目录内文件（${p}）`);
  }
  const canonicalRoot = realpathSync.native(root);
  const canonicalAncestor = realpathSync.native(nearestExistingAncestor(full));
  if (!isInside(canonicalRoot, canonicalAncestor)) {
    throw new Error(`路径越界：符号链接指向工作目录外（${p}）`);
  }
  return full;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'read_file',
    description: '读取工作目录内的文本文件内容（最多 24000 字符）',
    risk: 'safe',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作目录的文件路径' } },
      required: ['path']
    },
    async execute(args, ctx) {
      const full = resolveInWorkspace(ctx.workspace, args.path);
      const text = readFileSync(full, 'utf8');
      return text.length > MAX_READ_CHARS ? `${text.slice(0, MAX_READ_CHARS)}\n…（已截断，共 ${text.length} 字符）` : text;
    }
  },
  {
    name: 'list_dir',
    description: '列出工作目录内某个目录的文件与子目录',
    risk: 'safe',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作目录的路径，默认为根目录', default: '.' } }
    },
    async execute(args, ctx) {
      const full = resolveInWorkspace(ctx.workspace, args.path ?? '.');
      const entries = readdirSync(full, { withFileTypes: true }).slice(0, 200);
      if (entries.length === 0) return '（空目录）';
      return entries
        .map((e) => {
          const size = e.isFile() ? ` (${statSync(resolve(full, e.name)).size} B)` : '';
          return `${e.isDirectory() ? '[目录] ' : ''}${e.name}${size}`;
        })
        .join('\n');
    }
  },
  {
    name: 'write_file',
    description: '在工作目录内写入文本文件（覆盖写入，自动创建父目录）',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作目录的文件路径' },
        content: { type: 'string', description: '文件全文内容' }
      },
      required: ['path', 'content']
    },
    async execute(args, ctx) {
      const full = resolveInWorkspace(ctx.workspace, args.path);
      mkdirSync(dirname(full), { recursive: true });
      const content = typeof args.content === 'string' ? args.content : String(args.content ?? '');
      writeFileSync(full, content, 'utf8');
      return `已写入 ${args.path}（${content.length} 字符）`;
    }
  },
  {
    name: 'make_dir',
    description: '在工作目录内创建目录（递归）',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作目录的目录路径' } },
      required: ['path']
    },
    async execute(args, ctx) {
      mkdirSync(resolveInWorkspace(ctx.workspace, args.path), { recursive: true });
      return `已创建目录 ${args.path}`;
    }
  },
  {
    name: 'delete_path',
    description: '删除工作目录内的文件或目录（高危操作，需审批）',
    risk: 'danger',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作目录的路径' } },
      required: ['path']
    },
    async execute(args, ctx) {
      const full = resolveInWorkspace(ctx.workspace, args.path);
      if (full === resolve(ctx.workspace)) throw new Error('不允许删除工作目录本身');
      rmSync(full, { recursive: true, force: true });
      return `已删除 ${args.path}`;
    }
  },
  {
    name: 'delegate_task',
    description: '把一个子任务委托给另一名数字员工执行，等待其完成并返回结果（A2A 协作）',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        agent_name: { type: 'string', description: '目标数字员工名称（必须已存在且在岗）' },
        title: { type: 'string', description: '子任务标题（含足够的执行说明）' }
      },
      required: ['agent_name', 'title']
    },
    async execute(args, ctx) {
      if (!ctx.host) throw new Error('委托能力未启用');
      const name = String(args.agent_name ?? '');
      const targetId = ctx.host.findAgentIdByName(name, ctx.taskId);
      if (!targetId) throw new Error(`未找到在岗（READY）的数字员工「${name}」，无法委派`);
      if (targetId === ctx.agentId) throw new Error('不允许委托给自己');
      if (ctx.host.delegationDepth(ctx.taskId) >= 2) throw new Error('委托深度已达上限（2 级），请直接完成任务');
      const sub = ctx.host.createDelegatedTask(targetId, String(args.title ?? '子任务'), ctx.taskId);
      const done = await ctx.host.waitForTask(sub.id, MAX_DELEGATE_WAIT_MS, ctx.taskId);
      if (!done) {
        // A timed-out delegated task must not remain queued/running after its
        // parent has stopped waiting. The host owns the state transition and
        // treats a terminal child as an idempotent no-op.
        try { ctx.host.cancelTask?.(sub.id, '委派等待超时'); } catch { /* child may have completed concurrently */ }
        throw new Error('子任务等待超时（10 分钟），已取消子任务');
      }
      if (done.status === 'COMPLETED') return `子任务完成。产出：\n${(done.result ?? '（无文本产物）').slice(0, 8000)}`;
      throw new Error(`子任务未成功（${done.status}）：${done.error ?? '无错误信息'}`);
    }
  },
  {
    // E-2 编码专家委派：Nexus 内置 Worker 负责通用任务，
    // 遇到需要真正改代码、跑测试、分析仓库的工作时交给 OpenCode 执行。
    // 与 delegate_task 的区别：不换员工（归属与审批链路不变），只换执行引擎。
    name: 'delegate_coding_task',
    description:
      '把编码类工作交给编码专家引擎（OpenCode）执行，等待完成并返回结果。' +
      '适用于：修改/新增代码文件、重构、跑测试与修复失败、分析代码仓库结构。' +
      '不适用于：纯问答、写文档、数据分析等非编码任务（这些应自己完成）。',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: '编码任务的完整描述：目标、涉及的文件或模块、验收标准。描述要自包含，编码引擎看不到当前对话上下文。'
        }
      },
      required: ['title']
    },
    async execute(args, ctx) {
      if (!ctx.host?.createEngineDelegatedTask || !ctx.host.codingEngineReady) throw new Error('编码委派能力未启用');
      const coding = ctx.host.codingEngineReady();
      if (!coding.ready) throw new Error(`编码引擎「${coding.name}」当前不可用，请自行完成该任务或先在引擎中心完成安装/登录`);
      if (ctx.host.delegationDepth(ctx.taskId) >= 2) throw new Error('委托深度已达上限（2 级），请直接完成任务');
      const title = String(args.title ?? '').trim();
      if (!title) throw new Error('请提供编码任务描述');

      const capacity = ctx.host.delegationCapacity?.(ctx.agentId, ctx.taskId);
      if (capacity && !capacity.available) {
        throw new Error(
          capacity.reason
            ?? `当前员工并发槽已占满（${capacity.active}/${capacity.limit}），编码委派会等待自身释放并发槽而自锁；请提高并发上限或改用 delegate_task 委派给其他员工`
        );
      }

      const sub = ctx.host.createEngineDelegatedTask(ctx.agentId, title, ctx.taskId, coding.engineId);
      const done = await ctx.host.waitForTask(sub.id, MAX_DELEGATE_WAIT_MS, ctx.taskId);
      if (!done) {
        try { ctx.host.cancelTask?.(sub.id, '编码委派等待超时'); } catch { /* child may have completed concurrently */ }
        throw new Error('编码子任务等待超时（10 分钟），已取消子任务');
      }
      if (done.status === 'COMPLETED') {
        return `编码任务已由 ${coding.name} 完成。产出：\n${(done.result ?? '（无文本产物）').slice(0, 8000)}`;
      }
      throw new Error(`编码子任务未成功（${done.status}）：${done.error ?? '无错误信息'}`);
    }
  },
  {
    name: 'web_search',
    description: 'Search the web for real-time information. Returns relevant snippets and URLs.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (1-100 chars)' }
      },
      required: ['query']
    },
    risk: 'safe',
    requiresCapability: 'network',
    async execute(args) {
      const query = String(args.query ?? '').slice(0, 100);
      if (!query) throw new Error('请提供搜索关键词');
      // 策略：Bing 中国（国内可达）→ DuckDuckGo（海外回退）
      const bingResult = await searchBing(query);
      if (bingResult) return bingResult;
      const ddgResult = await searchDuckDuckGo(query);
      if (ddgResult) return ddgResult;
      return `未找到「${query}」的相关结果，建议尝试更具体的关键词或检查网络连接。`;
    }
  },
  {
    name: 'http_request',
    description: '发起 HTTP/HTTPS 网络请求，返回响应体（最多 16000 字符）。支持 GET/POST/PUT/DELETE。',
    risk: 'write',
    autonomousApproval: (args) => String(args.method ?? 'GET').toUpperCase() === 'GET' ? null : 'network',
    requiresCapability: 'network',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整 URL（http:// 或 https://）' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], description: 'HTTP 方法，默认 GET' },
        headers: { type: 'object', description: '请求头（可选）' },
        body: { type: 'string', description: '请求体（可选，POST/PUT 时使用）' }
      },
      required: ['url']
    },
    async execute(args) {
      const url = String(args.url ?? '');
      if (!/^https?:\/\//i.test(url)) throw new Error('仅允许 http:// 或 https:// 协议的请求');
      const method = String(args.method ?? 'GET').toUpperCase();
      const rawHeaders = (args.headers ?? {}) as Record<string, string>;
      // 清洗 header 值：HTTP 规范要求 header 值为 Latin-1（≤255），非 ASCII 字符需剥离或编码
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawHeaders)) {
        headers[k] = String(v).replace(/[^\x20-\x7E]/g, '').trim() || 'AiBoxDash-Agent';
      }
      const body = typeof args.body === 'string' ? args.body : undefined;
      const res = await fetch(url, {
        method,
        headers: { 'User-Agent': 'AiBoxDash-Agent/1.0', ...headers },
        body: method !== 'GET' ? body : undefined,
        signal: AbortSignal.timeout(30_000),
        redirect: Object.keys(headers).some((key) => key.toLowerCase() === 'authorization') ? 'error' : 'follow'
      });
      const text = await res.text();
      const truncated = text.length > 16_000 ? `${text.slice(0, 16_000)}\n…（已截断，共 ${text.length} 字符）` : text;
      return `HTTP ${res.status} ${res.statusText}\n${truncated}`;
    }
  },
  {
    name: 'run_command',
    description: '在工作目录内执行系统命令（shell），返回 stdout+stderr（最多 16000 字符）。超时 5 分钟。',
    risk: 'danger',
    autonomousApproval: 'outside_workspace',
    requiresCapability: 'shell',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令（如 dir / ls / node script.js）' },
        cwd: { type: 'string', description: '工作目录（相对员工 workspace，默认根目录）' }
      },
      required: ['command']
    },
    async execute(args, ctx) {
      const command = String(args.command ?? '').trim();
      if (!command) throw new Error('请提供要执行的命令');
      const cwd = resolveInWorkspace(ctx.workspace, args.cwd ?? '.');
      const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
      const shellArg = process.platform === 'win32' ? '/c' : '-c';
      return new Promise<string>((resolveP, rejectP) => {
        execFile(shell, [shellArg, command], {
          cwd,
          timeout: 5 * 60_000,
          maxBuffer: 1024 * 1024,
          shell: false,
          env: runCommandProcessEnv()
        }, (err, stdout, stderr) => {
          const out = (stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '');
          const truncated = out.length > 16_000 ? `${out.slice(0, 16_000)}\n…（已截断）` : out;
          if (err && !stdout && !stderr) {
            rejectP(new Error(`命令执行失败：${err.message}`));
          } else {
            resolveP(truncated || '（无输出）');
          }
        });
      });
    }
  },
  {
    name: 'install_package',
    description: '安装软件包（支持 npm/pip/apt）。用于安装 MCP 工具、Skills 依赖、Python 库等。',
    risk: 'danger',
    autonomousApproval: 'install',
    requiresCapability: 'install',
    inputSchema: {
      type: 'object',
      properties: {
        manager: { type: 'string', enum: ['npm', 'pip', 'apt'], description: '包管理器' },
        packages: { type: 'array', items: { type: 'string' }, description: '要安装的包名列表' },
        global: { type: 'boolean', description: 'npm 是否全局安装（-g），默认 false' },
        cwd: { type: 'string', description: 'npm 工作目录（相对员工 workspace）' }
      },
      required: ['manager', 'packages']
    },
    async execute(args, ctx) {
      const manager = String(args.manager ?? '');
      const packages = (args.packages ?? []) as string[];
      if (packages.length === 0) throw new Error('请提供要安装的包名');
      // 安全校验：包名只允许合法字符
      for (const pkg of packages) {
        if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(pkg)) {
          throw new Error(`包名不合法：${pkg}（仅允许 npm/pip 标准包名字符）`);
        }
      }
      let bin: string, cmdArgs: string[];
      if (manager === 'npm') {
        bin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        const g = args.global ? ['-g'] : [];
        cmdArgs = ['install', ...g, ...packages];
      } else if (manager === 'pip') {
        bin = process.platform === 'win32' ? 'pip' : 'pip3';
        cmdArgs = ['install', ...packages];
      } else if (manager === 'apt') {
        bin = 'apt-get';
        cmdArgs = ['install', '-y', ...packages];
      } else {
        throw new Error(`不支持的包管理器：${manager}（支持 npm/pip/apt）`);
      }
      const cwd = manager === 'npm' ? resolveInWorkspace(ctx.workspace, args.cwd ?? '.') : undefined;
      return new Promise<string>((resolveP, rejectP) => {
        execFile(bin, cmdArgs, { cwd, timeout: 10 * 60_000, maxBuffer: 2 * 1024 * 1024, shell: false }, (err, stdout, stderr) => {
          const out = (stdout || '') + (stderr ? `\n[stderr]\n${stderr.slice(0, 2000)}` : '');
          if (err) {
            rejectP(new Error(`安装失败：${err.message}\n${(stderr || '').slice(0, 500)}`));
          } else {
            resolveP(`安装完成：${packages.join(', ')}\n${out.slice(0, 4000)}`);
          }
        });
      });
    }
  },
  // ---------- 本地 Python 工具集 ----------
  {
    name: 'run_python_tool',
    description: '调用本地 Python 工具集（local-tools/）。可用工具: http_tool(网络请求/下载), sysinfo_tool(系统信息), office_convert(文件格式转换), file_tool(文件批处理), text_tool(文本处理), image_tool(图片处理), webserver_tool(本地Web服务)。返回 JSON 结构化结果。',
    risk: 'write',
    autonomousApproval: 'outside_workspace',
    requiresCapability: 'shell',
    inputSchema: {
      type: 'object',
      properties: {
        tool: {
          type: 'string',
          enum: ['http_tool', 'sysinfo_tool', 'office_convert', 'file_tool', 'text_tool', 'image_tool', 'webserver_tool'],
          description: '工具名称'
        },
        args: {
          type: 'string',
          description: '命令行参数（如 --action overview --top 5）'
        }
      },
      required: ['tool', 'args']
    },
    async execute(args, ctx) {
      const tool = String(args.tool ?? '');
      const toolArgs = String(args.args ?? '').trim();
      const allowed = ['http_tool', 'sysinfo_tool', 'office_convert', 'file_tool', 'text_tool', 'image_tool', 'webserver_tool'];
      if (!allowed.includes(tool)) throw new Error(`未知工具: ${tool}（可用: ${allowed.join(', ')}）`);
      if (!toolArgs) throw new Error('请提供工具参数（如 --action overview）');

      // 定位 local-tools 目录（项目根目录下）
      const { join: pJoin, dirname: pDirname } = await import('node:path');
      const { existsSync } = await import('node:fs');
      // 开发模式: app.getAppPath() 为项目根；生产模式: 取 resources 路径
      const { app: electronApp } = await import('electron');
      const appRoot = electronApp.getAppPath();
      const toolsDir = pJoin(appRoot, 'local-tools');
      const scriptPath = pJoin(toolsDir, `${tool}.py`);
      if (!existsSync(scriptPath)) throw new Error(`工具脚本不存在: ${scriptPath}`);

      const pythonBin = process.platform === 'win32' ? 'python' : 'python3';
      // 解析参数为数组（简单按空格拆分，引号内不拆分）
      const argArray = toolArgs.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((a) => a.replace(/^"|"$/g, '')) ?? [];

      return new Promise<string>((resolveP, rejectP) => {
        execFile(pythonBin, [scriptPath, ...argArray], {
          cwd: ctx.workspace,
          timeout: 3 * 60_000,
          maxBuffer: 2 * 1024 * 1024,
          shell: false
        }, (err, stdout, stderr) => {
          const out = (stdout || '').trim();
          if (err && !out) {
            rejectP(new Error(`Python 工具执行失败: ${err.message}\n${(stderr || '').slice(0, 1000)}`));
          } else {
            const result = out || (stderr || '').slice(0, 4000) || '（无输出）';
            resolveP(result.length > 16_000 ? `${result.slice(0, 16_000)}\n…（已截断）` : result);
          }
        });
      });
    }
  },
  // ---------- 浏览器自动化（Playwright / CDP） ----------
  {
    name: 'browser_navigate',
    description: '导航到指定 URL（启动或复用浏览器实例）。返回页面标题。',
    risk: 'write',
    requiresCapability: 'browser',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '目标 URL（http:// 或 https://）' },
        cdp_url: { type: 'string', description: '可选：CDP 直连地址（如 http://127.0.0.1:9222），用于连接已有 Chrome' }
      },
      required: ['url']
    },
    async execute(args, ctx) {
      if (!ctx.browserMgr) throw new Error('浏览器管理器未初始化');
      return ctx.browserMgr.navigate(ctx.agentId, String(args.url), args.cdp_url ? String(args.cdp_url) : undefined);
    }
  },
  {
    name: 'browser_click',
    description: '点击页面上的元素（CSS 选择器）',
    risk: 'write',
    autonomousApproval: 'network',
    requiresCapability: 'browser',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS 选择器（如 button.submit / #login-btn / a[href="/next"]）' }
      },
      required: ['selector']
    },
    async execute(args, ctx) {
      if (!ctx.browserMgr) throw new Error('浏览器管理器未初始化');
      return ctx.browserMgr.click(ctx.agentId, String(args.selector));
    }
  },
  {
    name: 'browser_type',
    description: '在页面输入框中填写文本（CSS 选择器定位）',
    risk: 'write',
    autonomousApproval: 'network',
    requiresCapability: 'browser',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS 选择器（如 input[name="q"] / #search-box）' },
        text: { type: 'string', description: '要输入的文本' }
      },
      required: ['selector', 'text']
    },
    async execute(args, ctx) {
      if (!ctx.browserMgr) throw new Error('浏览器管理器未初始化');
      return ctx.browserMgr.type(ctx.agentId, String(args.selector), String(args.text));
    }
  },
  {
    name: 'browser_screenshot',
    description: '对当前页面截图，返回截图文件路径。可指定元素选择器截取局部。',
    risk: 'safe',
    requiresCapability: 'browser',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '可选：截取指定元素（CSS 选择器），不填则截全页' }
      }
    },
    async execute(args, ctx) {
      if (!ctx.browserMgr) throw new Error('浏览器管理器未初始化');
      const outputDir = resolveInWorkspace(ctx.workspace, '.opc-nexus/screenshots');
      const r = await ctx.browserMgr.screenshot(
        ctx.agentId,
        args.selector ? String(args.selector) : undefined,
        outputDir
      );
      return `截图已保存：${r.path}`;
    }
  },
  {
    name: 'browser_evaluate',
    description: '在页面中执行 JavaScript 代码，返回结果。',
    risk: 'write',
    autonomousApproval: 'network',
    requiresCapability: 'browser',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: '要执行的 JS 代码（如 document.title / document.querySelectorAll("a").length）' }
      },
      required: ['script']
    },
    async execute(args, ctx) {
      if (!ctx.browserMgr) throw new Error('浏览器管理器未初始化');
      return ctx.browserMgr.evaluate(ctx.agentId, String(args.script));
    }
  },
  {
    name: 'browser_get_content',
    description: '获取当前页面的文本内容（body innerText，最多 16000 字符）',
    risk: 'safe',
    requiresCapability: 'browser',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args, ctx) {
      if (!ctx.browserMgr) throw new Error('浏览器管理器未初始化');
      return ctx.browserMgr.getContent(ctx.agentId);
    }
  },
  // ---------- OCR 文字识别（PaddleOCR WASM） ----------
  {
    name: 'ocr_recognize',
    description: '识别图片中的文字（支持中英文）。传入工作目录内的图片路径，返回识别到的文本内容及位置。支持 PNG/JPG/BMP/WEBP。',
    risk: 'safe',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作目录的图片文件路径' },
        detail: { type: 'boolean', description: '是否返回详细位置信息（默认 false，仅返回纯文本）' }
      },
      required: ['path']
    },
    async execute(args, ctx) {
      if (!ctx.ocrService) throw new Error('OCR 服务未启用，请在设置中开启「OCR 文字识别」');
      const full = resolveInWorkspace(ctx.workspace, args.path);
      const result = await ctx.ocrService.recognize(full);
      if (!result.ok) throw new Error(result.error ?? 'OCR 识别失败');
      if (args.detail) {
        const lines = result.boxes.map((b) => `[置信度 ${(b.confidence * 100).toFixed(0)}%] ${b.text}`);
        return `识别完成（${result.elapsed}ms，${result.boxes.length} 个文本区域）：\n${lines.join('\n')}`;
      }
      return result.text || '（未检测到文字）';
    }
  },
  // ---------- Computer Use（桌面操控） ----------
  {
    name: 'computer_screenshot',
    description: '截取当前桌面屏幕，返回截图文件路径。用于观察屏幕内容。',
    risk: 'safe',
    requiresCapability: 'computer',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args, ctx) {
      const { join: pJoin } = await import('node:path');
      const { mkdirSync: mk } = await import('node:fs');
      const dir = resolveInWorkspace(ctx.workspace, '.opc-nexus/screenshots');
      mk(dir, { recursive: true });
      const filePath = pJoin(dir, `desktop_${ctx.agentId}_${Date.now()}.png`);
      // Windows: PowerShell 截屏；Linux: scrot/gnome-screenshot
      const script = process.platform === 'win32'
        ? `Add-Type -AssemblyName System.Windows.Forms; $s=[System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp=New-Object System.Drawing.Bitmap($s.Width,$s.Height); $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($s.Location,[System.Drawing.Point]::Empty,$s.Size); $bmp.Save('${filePath.replace(/\\/g, '\\\\')}'); $g.Dispose(); $bmp.Dispose()`
        : `scrot '${filePath}'`;
      const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
      const shellArg = process.platform === 'win32' ? '-NoProfile' : '-c';
      return new Promise<string>((resolveP, rejectP) => {
        execFile(shell, [shellArg, script], { timeout: 15_000, shell: false }, (err) => {
          if (err) rejectP(new Error(`截屏失败：${err.message}`));
          else resolveP(`桌面截图已保存：${filePath}`);
        });
      });
    }
  },
  {
    name: 'computer_click',
    description: '在桌面指定坐标点击鼠标。',
    risk: 'write',
    autonomousApproval: 'outside_workspace',
    requiresCapability: 'computer',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X 坐标（像素）' },
        y: { type: 'number', description: 'Y 坐标（像素）' },
        button: { type: 'string', enum: ['left', 'right'], description: '鼠标按键，默认 left' }
      },
      required: ['x', 'y']
    },
    async execute(args) {
      const x = Number(args.x) || 0;
      const y = Number(args.y) || 0;
      const button = String(args.button ?? 'left');
      const script = process.platform === 'win32'
        ? `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y}); Add-Type @'
using System; using System.Runtime.InteropServices;
public class MouseSim {
  [DllImport("user32.dll")] public static extern void mouse_event(int f,int x,int y,int d,int i);
  public static void Click(bool right){
    int down = right?0x0008:0x0002; int up = right?0x0010:0x0004;
    mouse_event(down,0,0,0,0); mouse_event(up,0,0,0,0);
  }
}
'@; [MouseSim]::Click(${button === 'right' ? '$true' : '$false'})`
        : `xdotool mousemove ${x} ${y} click ${button === 'right' ? 3 : 1}`;
      const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
      const shellArg = process.platform === 'win32' ? '-NoProfile' : '-c';
      return new Promise<string>((resolveP, rejectP) => {
        execFile(shell, [shellArg, script], { timeout: 10_000, shell: false }, (err) => {
          if (err) rejectP(new Error(`点击失败：${err.message}`));
          else resolveP(`已在 (${x}, ${y}) 执行${button === 'right' ? '右键' : '左键'}点击`);
        });
      });
    }
  },
  {
    name: 'computer_type',
    description: '模拟键盘输入文本（在当前焦点位置）',
    risk: 'write',
    autonomousApproval: 'outside_workspace',
    requiresCapability: 'computer',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要输入的文本' }
      },
      required: ['text']
    },
    async execute(args) {
      const text = String(args.text ?? '');
      if (!text) throw new Error('请提供要输入的文本');
      // Windows: SendKeys；Linux: xdotool
      const escaped = text.replace(/[+^%~(){}[\]]/g, '{$&}');
      const script = process.platform === 'win32'
        ? `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped.replace(/'/g, "''")}')`
        : `xdotool type --clearmodifiers '${text.replace(/'/g, "'\\''")}'`;
      const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
      const shellArg = process.platform === 'win32' ? '-NoProfile' : '-c';
      return new Promise<string>((resolveP, rejectP) => {
        execFile(shell, [shellArg, script], { timeout: 10_000, shell: false }, (err) => {
          if (err) rejectP(new Error(`输入失败：${err.message}`));
          else resolveP(`已输入 ${text.length} 个字符`);
        });
      });
    }
  },
  {
    name: 'computer_key',
    description: '模拟按键组合（如 Ctrl+C、Enter、Alt+Tab）',
    risk: 'write',
    autonomousApproval: 'outside_workspace',
    requiresCapability: 'computer',
    inputSchema: {
      type: 'object',
      properties: {
        keys: { type: 'string', description: '按键组合（如 Enter / Ctrl+C / Alt+Tab / Ctrl+Shift+S）' }
      },
      required: ['keys']
    },
    async execute(args) {
      const keys = String(args.keys ?? '');
      if (!keys) throw new Error('请提供按键组合');
      // 转换为 SendKeys 格式：Ctrl→^, Alt→%, Shift→+
      const sendkeys = keys
        .replace(/Ctrl/i, '^').replace(/Alt/i, '%').replace(/Shift/i, '+')
        .replace(/\+/g, '+').replace(/Enter/i, '{ENTER}').replace(/Tab/i, '{TAB}')
        .replace(/Escape|Esc/i, '{ESC}').replace(/Backspace/i, '{BS}')
        .replace(/Delete|Del/i, '{DEL}').replace(/Space/i, ' ');
      const script = process.platform === 'win32'
        ? `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${sendkeys.replace(/'/g, "''")}')`
        : `xdotool key '${keys.toLowerCase().replace(/ctrl/g, 'ctrl').replace(/alt/g, 'alt').replace(/shift/g, 'shift')}'`;
      const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
      const shellArg = process.platform === 'win32' ? '-NoProfile' : '-c';
      return new Promise<string>((resolveP, rejectP) => {
        execFile(shell, [shellArg, script], { timeout: 10_000, shell: false }, (err) => {
          if (err) rejectP(new Error(`按键失败：${err.message}`));
          else resolveP(`已执行按键：${keys}`);
        });
      });
    }
  },
  {
    name: 'computer_scroll',
    description: '在指定坐标滚动鼠标滚轮',
    risk: 'write',
    autonomousApproval: 'outside_workspace',
    requiresCapability: 'computer',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X 坐标' },
        y: { type: 'number', description: 'Y 坐标' },
        direction: { type: 'string', enum: ['up', 'down'], description: '滚动方向' },
        clicks: { type: 'number', description: '滚动格数（默认 3）' }
      },
      required: ['x', 'y', 'direction']
    },
    async execute(args) {
      const x = Number(args.x) || 0;
      const y = Number(args.y) || 0;
      const dir = String(args.direction ?? 'down');
      const clicks = Number(args.clicks) || 3;
      const script = process.platform === 'win32'
        ? `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y}); Add-Type @'
using System; using System.Runtime.InteropServices;
public class WheelSim {
  [DllImport("user32.dll")] public static extern void mouse_event(int f,int x,int y,int d,int i);
  public static void Scroll(int delta){ mouse_event(0x0800,0,0,delta,0); }
}
'@; [WheelSim]::Scroll(${dir === 'up' ? clicks * 120 : -(clicks * 120)})`
        : `xdotool mousemove ${x} ${y} click ${dir === 'up' ? 4 : 5}`;
      const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
      const shellArg = process.platform === 'win32' ? '-NoProfile' : '-c';
      return new Promise<string>((resolveP, rejectP) => {
        execFile(shell, [shellArg, script], { timeout: 10_000, shell: false }, (err) => {
          if (err) rejectP(new Error(`滚动失败：${err.message}`));
          else resolveP(`已在 (${x}, ${y}) 向${dir === 'up' ? '上' : '下'}滚动 ${clicks} 格`);
        });
      });
    }
  }
];

/** 按权限模式 + 能力开关过滤可注册工具 */
export function toolsForPermission(
  mode: 'readonly' | 'standard' | 'trusted' | 'autonomous',
  capabilities?: { network?: boolean; shell?: boolean; install?: boolean; browser?: boolean; computer?: boolean },
  /** 编码引擎是否就绪（E-2）：不就绪则不注册 delegate_coding_task，避免模型调用必然失败的工具 */
  codingEngineReady = false
): ToolDef[] {
  let tools = mode === 'readonly' ? TOOLS.filter((t) => t.risk === 'safe') : TOOLS;
  // 能力开关过滤：未开启对应能力的工具不注册给 LLM
  if (capabilities) {
    tools = tools.filter((t) => {
      if (!t.requiresCapability) return true;
      return capabilities[t.requiresCapability] === true;
    });
  }
  if (!codingEngineReady) tools = tools.filter((t) => t.name !== 'delegate_coding_task');
  return tools;
}

/** OpenAI function calling 声明格式 */
export function toOpenAiTools(defs: ToolDef[]): { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }[] {
  return defs.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema }
  }));
}
