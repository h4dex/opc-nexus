/**
 * 工具注册表（P1b/P3b，MCP 风格：name + JSON Schema + execute，为后续 MCP 接入打底）
 * - 全部文件工具限定在员工 workspace 内：resolve 后必须落在 workspace 前缀下（7.2 边界）
 * - risk 三级：safe（只读）/ write（写入）/ danger（删除等）；审批策略由执行器按 permissionMode 决定
 * - delegate_task（P3b A2A 内部委托）通过 ToolHost 回调编排器，避免循环依赖
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { Task } from '../../../shared/types.js';

export type ToolRisk = 'safe' | 'write' | 'danger';

export interface ToolContext {
  workspace: string;
  agentId: string;
  taskId: string;
  host: ToolHost | null;
}

/** 编排器能力注入（委托创建/等待子任务），由 main 装配 */
export interface ToolHost {
  findAgentIdByName(name: string): string | null;
  createDelegatedTask(agentId: string, title: string, parentTaskId: string): Task;
  waitForTask(taskId: string, timeoutMs: number): Promise<Task | null>;
  /** 委托深度（parentId 链长度），防止无限递归 */
  delegationDepth(taskId: string): number;
  /** 主 Agent 全局调度：列出所有在岗员工 */
  listReadyAgents?(): { id: string; name: string; role: string }[];
  /** 主 Agent 全局调度：触发专家团 */
  triggerTeamByName?(teamName: string, task: string): { ok: boolean; message: string };
}

export interface ToolDef {
  name: string;
  description: string;
  risk: ToolRisk;
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

const MAX_READ_CHARS = 24_000;
const MAX_DELEGATE_WAIT_MS = 10 * 60_000;

/** 路径防护：拒绝逃逸 workspace 的任何路径（含 ..、绝对路径指向外部） */
function resolveInWorkspace(workspace: string, relPath: unknown): string {
  const p = typeof relPath === 'string' ? relPath : '';
  const root = resolve(workspace);
  const full = resolve(root, p);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`路径越界：仅允许访问工作目录内文件（${p}）`);
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
      const targetId = ctx.host.findAgentIdByName(name);
      if (!targetId) throw new Error(`未找到在岗（READY）的数字员工「${name}」，无法委派`);
      if (targetId === ctx.agentId) throw new Error('不允许委托给自己');
      if (ctx.host.delegationDepth(ctx.taskId) >= 2) throw new Error('委托深度已达上限（2 级），请直接完成任务');
      const sub = ctx.host.createDelegatedTask(targetId, String(args.title ?? '子任务'), ctx.taskId);
      const done = await ctx.host.waitForTask(sub.id, MAX_DELEGATE_WAIT_MS);
      if (!done) throw new Error('子任务等待超时（10 分钟），已放弃等待');
      if (done.status === 'COMPLETED') return `子任务完成。产出：\n${(done.result ?? '（无文本产物）').slice(0, 8000)}`;
      throw new Error(`子任务未成功（${done.status}）：${done.error ?? '无错误信息'}`);
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
    async execute(args) {
      const query = String(args.query ?? '').slice(0, 100);
      if (!query) throw new Error('请提供搜索关键词');
      // DuckDuckGo Instant Answer API（免费无需 Key）+ HTML 搜索回退
      try {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
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
        if (parts.length === 0) return `未找到「${query}」的直接答案，建议尝试更具体的关键词。`;
        return parts.join('\n');
      } catch (err) {
        throw new Error(`搜索失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
];

/** 按权限模式过滤可注册工具：readonly 仅 safe；standard/trusted/autonomous 全量 */
export function toolsForPermission(mode: 'readonly' | 'standard' | 'trusted' | 'autonomous'): ToolDef[] {
  return mode === 'readonly' ? TOOLS.filter((t) => t.risk === 'safe') : TOOLS;
}

/** OpenAI function calling 声明格式 */
export function toOpenAiTools(defs: ToolDef[]): { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }[] {
  return defs.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema }
  }));
}
