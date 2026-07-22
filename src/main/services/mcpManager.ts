/**
 * MCP 服务器管理（Model Context Protocol）：
 * - 进程管理：spawn stdio 子进程，JSON-RPC 2.0 通信
 * - 工具发现：initialize → tools/list 获取服务器提供的工具列表
 * - 工具执行：tools/call 调用指定工具并返回结果
 * - 生命周期：启动/停止/健康检测；配置存 mcp_servers 表
 * 参考 Cherry Studio MCP 集成模式：每个 server 独立进程，全局或按助手绑定。
 */
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Database } from './database.js';

export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  scope: string; // 'global' | agentId
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverId: string;
  serverName: string;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface RunningServer {
  proc: ChildProcess;
  nextId: number;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  buffer: string;
  tools: McpTool[];
}

export class McpManager {
  private running = new Map<string, RunningServer>();

  constructor(private db: Database) {}

  // ---------- 配置 CRUD ----------

  list(): McpServerConfig[] {
    return (this.db.raw.prepare('SELECT * FROM mcp_servers ORDER BY rowid').all() as unknown as {
      id: string; name: string; command: string; args: string; env: string; enabled: number; scope: string;
    }[]).map((r) => ({
      id: r.id, name: r.name, command: r.command,
      args: JSON.parse(r.args) as string[], env: JSON.parse(r.env) as Record<string, string>,
      enabled: r.enabled === 1, scope: r.scope
    }));
  }

  create(input: { name: string; command: string; args?: string[]; env?: Record<string, string>; scope?: string }): McpServerConfig {
    const id = `mcp-${randomUUID().slice(0, 8)}`;
    const cfg: McpServerConfig = {
      id, name: input.name, command: input.command,
      args: input.args ?? [], env: input.env ?? {}, enabled: true, scope: input.scope ?? 'global'
    };
    this.db.raw.prepare('INSERT INTO mcp_servers(id, name, command, args, env, enabled, scope) VALUES(?,?,?,?,?,1,?)')
      .run(id, cfg.name, cfg.command, JSON.stringify(cfg.args), JSON.stringify(cfg.env), cfg.scope);
    return cfg;
  }

  remove(id: string) {
    void this.stop(id);
    this.db.raw.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
  }

  toggle(id: string, enabled: boolean) {
    this.db.raw.prepare('UPDATE mcp_servers SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    if (!enabled) void this.stop(id);
  }

  // ---------- 进程管理 ----------

  /** 启动 MCP 服务器进程并完成 initialize 握手 + 工具发现 */
  async start(id: string): Promise<{ ok: boolean; message: string; tools?: McpTool[] }> {
    const cfg = this.list().find((s) => s.id === id);
    if (!cfg) return { ok: false, message: '服务器配置不存在' };
    if (this.running.has(id)) return { ok: true, message: '已在运行', tools: this.running.get(id)!.tools };

    try {
      const proc = spawn(cfg.command, cfg.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...cfg.env },
        shell: process.platform === 'win32'
      });

      const server: RunningServer = { proc, nextId: 1, pending: new Map(), buffer: '', tools: [] };
      this.running.set(id, server);

      // stdout 数据 → JSON-RPC 响应解析（按换行分割）
      proc.stdout?.on('data', (chunk: Buffer) => {
        server.buffer += chunk.toString('utf8');
        let nl: number;
        while ((nl = server.buffer.indexOf('\n')) >= 0) {
          const line = server.buffer.slice(0, nl).trim();
          server.buffer = server.buffer.slice(nl + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line) as JsonRpcResponse;
            if (msg.id !== undefined && server.pending.has(msg.id)) {
              const p = server.pending.get(msg.id)!;
              server.pending.delete(msg.id);
              if (msg.error) p.reject(new Error(msg.error.message));
              else p.resolve(msg.result);
            }
          } catch { /* 非 JSON 行忽略 */ }
        }
      });

      proc.on('exit', () => { this.running.delete(id); });

      // initialize 握手
      await this.rpc(server, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'aibox-control-center', version: '1.0.0' }
      });

      // 发送 initialized 通知
      proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

      // 工具发现
      const toolsResult = await this.rpc(server, 'tools/list', {}) as { tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[] };
      server.tools = (toolsResult.tools ?? []).map((t) => ({
        name: t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? {},
        serverId: id, serverName: cfg.name
      }));

      return { ok: true, message: `已连接，发现 ${server.tools.length} 个工具`, tools: server.tools };
    } catch (err) {
      this.running.delete(id);
      return { ok: false, message: `启动失败：${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async stop(id: string) {
    const server = this.running.get(id);
    if (!server) return;
    server.proc.kill();
    this.running.delete(id);
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  // ---------- 工具发现/执行 ----------

  /** 获取所有已启动服务器的工具列表 */
  allTools(): McpTool[] {
    const out: McpTool[] = [];
    for (const server of this.running.values()) out.push(...server.tools);
    return out;
  }

  /** 执行 MCP 工具调用 */
  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const server = this.running.get(serverId);
    if (!server) return { ok: false, error: '服务器未运行' };
    try {
      const result = await this.rpc(server, 'tools/call', { name: toolName, arguments: args });
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---------- JSON-RPC ----------

  private rpc(server: RunningServer, method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = server.nextId++;
      const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      server.pending.set(id, { resolve, reject });
      server.proc.stdin?.write(JSON.stringify(req) + '\n');
      // 超时 30s
      setTimeout(() => {
        if (server.pending.has(id)) {
          server.pending.delete(id);
          reject(new Error(`RPC 超时：${method}`));
        }
      }, 30_000);
    });
  }
}
