/**
 * MCP 协同服务器（Streamable HTTP 传输）：
 * - 实现 MCP 2024-11-05 协议的 HTTP 端点（POST /mcp）
 * - 暴露协同工具供远程 Agent 调用：获取任务/认领/提交/心跳等
 * - Bearer Token 认证（与协同工作区 invite_token 一致）
 * - JSON-RPC 2.0 请求/响应格式
 */
import express from 'express';
import type { Server } from 'node:http';
import type { CollabManager } from './collabManager.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const COLLAB_TOOLS: McpToolDef[] = [
  {
    name: 'get_project_context',
    description: '获取当前协同工作区的团队规范、Git 规范和项目信息',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'list_available_tasks',
    description: '获取当前可领取的子任务列表（status=pending）',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'claim_task',
    description: '认领一个子任务，系统会自动创建对应的 Git 分支',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '要认领的任务 ID' },
        agent_name: { type: 'string', description: '你的 Agent 名称标识' }
      },
      required: ['task_id', 'agent_name']
    }
  },
  {
    name: 'get_task_detail',
    description: '获取指定任务的完整描述、验收标准和分支信息',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: '任务 ID' } },
      required: ['task_id']
    }
  },
  {
    name: 'report_progress',
    description: '上报任务进度百分比和中间说明',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 ID' },
        progress: { type: 'number', description: '进度百分比 0-100' },
        note: { type: 'string', description: '进度说明' }
      },
      required: ['task_id', 'progress']
    }
  },
  {
    name: 'submit_task',
    description: '标记任务完成并提交，等待主 Agent 验收。提交前请确保代码已 push 到对应分支',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: '任务 ID' } },
      required: ['task_id']
    }
  },
  {
    name: 'get_git_endpoint',
    description: '获取 Git Server 连接信息（URL、认证 Token、当前任务分支名）',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: '任务 ID（可选，用于获取对应分支）' } },
      required: []
    }
  },
  {
    name: 'heartbeat',
    description: '心跳上报，维持在线状态。建议每 30 秒调用一次',
    inputSchema: {
      type: 'object',
      properties: { agent_id: { type: 'string', description: 'Agent ID（首次注册后获得）' } },
      required: ['agent_id']
    }
  },
  {
    name: 'register_agent',
    description: '注册为协同 Agent，获取 agent_id 用于后续心跳和任务操作',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent 名称' },
        endpoint: { type: 'string', description: 'Agent 回调地址（可选）' }
      },
      required: ['name']
    }
  },
  {
    name: 'upload_artifact',
    description: '上传文件产物到工作区（Base64 编码内容），用于提交非代码文件（如文档、图片、配置等）',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: '文件名（含相对路径，如 docs/readme.md）' },
        content_base64: { type: 'string', description: '文件内容的 Base64 编码' },
        task_id: { type: 'string', description: '关联的任务 ID（可选）' }
      },
      required: ['filename', 'content_base64']
    }
  }
];

export class McpCollabServer {
  private app: ReturnType<typeof express>;
  private server: Server | null = null;

  constructor(
    private port: number,
    private collab: CollabManager,
    private workspaceId: string,
    private token: string
  ) {
    this.app = express();
    this.app.use(express.json({ limit: '10mb' }));
    this.setupRoutes();
  }

  private setupRoutes() {
    // MCP 端点：POST /mcp
    this.app.post('/mcp', (req, res) => {
      // 认证
      const auth = req.headers.authorization ?? '';
      const provided = auth.replace(/^Bearer\s+/i, '');
      if (provided !== this.token) {
        res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
        return;
      }

      const rpc = req.body as JsonRpcRequest;
      if (!rpc || rpc.jsonrpc !== '2.0' || !rpc.method) {
        res.status(400).json({ jsonrpc: '2.0', id: rpc?.id ?? null, error: { code: -32600, message: 'Invalid Request' } });
        return;
      }

      const result = this.handleMethod(rpc.method, rpc.params ?? {});
      res.json({ jsonrpc: '2.0', id: rpc.id ?? null, result });
    });

    // 健康检查
    this.app.get('/health', (_req, res) => {
      res.json({ ok: true, protocol: 'mcp-2024-11-05', transport: 'streamable-http' });
    });
  }

  private handleMethod(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'aibox-collab-server', version: '1.0.0' }
        };

      case 'notifications/initialized':
        return {};

      case 'tools/list':
        return { tools: COLLAB_TOOLS };

      case 'tools/call':
        return this.handleToolCall(params.name as string, (params.arguments ?? {}) as Record<string, unknown>);

      default:
        return { error: `Unknown method: ${method}` };
    }
  }

  private handleToolCall(toolName: string, args: Record<string, unknown>): { content: { type: string; text: string }[]; isError?: boolean } {
    try {
      const result = this.executeTool(toolName, args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `错误：${err instanceof Error ? err.message : String(err)}` }],
        isError: true
      };
    }
  }

  private executeTool(name: string, args: Record<string, unknown>): unknown {
    switch (name) {
      case 'get_project_context': {
        const ws = this.collab.getWorkspace(this.workspaceId);
        if (!ws) return { error: '工作区不存在' };
        return {
          workspace: ws.name,
          conventions: ws.conventions || '（未设置团队规范）',
          gitRules: ws.gitRules || '（未设置 Git 规范）',
          instructions: '请先阅读团队规范和 Git 规范，然后调用 list_available_tasks 查看可领取的任务。认领任务后通过 get_git_endpoint 获取 Git 连接信息进行开发。完成后 push 代码并调用 submit_task 提交验收。'
        };
      }

      case 'list_available_tasks': {
        const tasks = this.collab.listTasks(this.workspaceId).filter((t) => t.status === 'pending');
        return { tasks: tasks.map((t) => ({ id: t.id, title: t.title, description: t.description, branch: t.branchName })) };
      }

      case 'claim_task': {
        const taskId = args.task_id as string;
        const agentName = args.agent_name as string;
        if (!taskId || !agentName) return { error: '缺少 task_id 或 agent_name' };
        // 先注册 Agent
        this.collab.registerAgent(this.workspaceId, agentName);
        return this.collab.claimTask(taskId, agentName);
      }

      case 'get_task_detail': {
        const taskId = args.task_id as string;
        if (!taskId) return { error: '缺少 task_id' };
        const task = this.collab.getTask(taskId);
        if (!task) return { error: '任务不存在' };
        const ws = this.collab.getWorkspace(this.workspaceId);
        return {
          ...task,
          conventions: ws?.conventions ?? '',
          gitRules: ws?.gitRules ?? '',
          instructions: `请在分支 ${task.branchName} 上开发，完成后 git push 并调用 submit_task`
        };
      }

      case 'report_progress': {
        const taskId = args.task_id as string;
        const progress = args.progress as number;
        const note = args.note as string | undefined;
        if (!taskId) return { error: '缺少 task_id' };
        return this.collab.updateTaskProgress(taskId, progress, note);
      }

      case 'submit_task': {
        const taskId = args.task_id as string;
        if (!taskId) return { error: '缺少 task_id' };
        return this.collab.submitTask(taskId);
      }

      case 'get_git_endpoint': {
        const info = this.collab.getConnectInfo(this.workspaceId);
        if (!info) return { error: '工作区不存在' };
        const taskId = args.task_id as string | undefined;
        let branch: string | undefined;
        if (taskId) {
          const task = this.collab.getTask(taskId);
          branch = task?.branchName;
        }
        return {
          git_url: info.gitUrl,
          token: info.token,
          branch: branch ?? '（请通过 claim_task 获取分支）',
          usage: `git clone ${info.gitUrl} && cd <repo> && git checkout <branch>`
        };
      }

      case 'heartbeat': {
        const agentId = args.agent_id as string;
        if (!agentId) return { error: '缺少 agent_id' };
        return this.collab.heartbeat(agentId);
      }

      case 'register_agent': {
        const agentName = args.name as string;
        const endpoint = args.endpoint as string | undefined;
        if (!agentName) return { error: '缺少 name' };
        const agent = this.collab.registerAgent(this.workspaceId, agentName, endpoint);
        return { agent_id: agent.id, name: agent.name, message: '注册成功，请定期调用 heartbeat 保持在线' };
      }

      case 'upload_artifact': {
        const filename = args.filename as string;
        const contentBase64 = args.content_base64 as string;
        if (!filename || !contentBase64) return { error: '缺少 filename 或 content_base64' };
        return this.collab.saveArtifact(this.workspaceId, filename, contentBase64);
      }

      default:
        return { error: `未知工具：${name}` };
    }
  }

  async start(): Promise<{ ok: boolean; message: string }> {
    return new Promise((resolve) => {
      try {
        this.server = this.app.listen(this.port, '0.0.0.0', () => {
          resolve({ ok: true, message: `MCP Collab Server 已启动 :${this.port}` });
        });
        this.server.on('error', (err: NodeJS.ErrnoException) => {
          resolve({ ok: false, message: `端口 ${this.port} 监听失败：${err.message}` });
        });
      } catch (err) {
        resolve({ ok: false, message: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}
