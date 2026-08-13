/**
 * MCP 服务器管理（Model Context Protocol）：
 * - 进程管理：spawn stdio 子进程，JSON-RPC 2.0 通信
 * - 工具发现：initialize → tools/list 获取服务器提供的工具列表
 * - 工具执行：tools/call 调用指定工具并返回结果
 * - 生命周期：启动/停止/健康检测；配置存 mcp_servers 表
 * 参考 Cherry Studio MCP 集成模式：每个 server 独立进程，全局或按助手绑定。
 */
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { safeStorage } from 'electron';
import type { AgentCapabilities } from '../../shared/types.js';
import type { Database } from './database.js';
import { spawnCli } from './cliLauncher.js';
import { createUtf8StreamDecoder } from './textEncoding.js';

const require = createRequire(import.meta.url);
const BUILTIN_PLAYWRIGHT_COMMAND = 'builtin:playwright-mcp';
const SECRET_ENV_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;
const SECRET_PLACEHOLDER = '***';
const MAX_RESULT_CHARS = 16_000;
const MAX_MCP_LINE_BUFFER_CHARS = 512 * 1024;
const RPC_TIMEOUT_MS = 30_000;

export type McpCapability = 'browser' | '';

export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  scope: string; // 'global' | agentId
  capability: McpCapability;
  running: boolean;
  hasSecrets: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverId: string;
  serverName: string;
  capability: McpCapability;
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
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
  buffer: string;
  decoder: import('node:string_decoder').StringDecoder;
  tools: McpTool[];
}

export class McpManager {
  private running = new Map<string, RunningServer>();

  constructor(private db: Database) {}

  // ---------- 配置 CRUD ----------

  list(): McpServerConfig[] {
    return (this.db.raw.prepare('SELECT * FROM mcp_servers ORDER BY rowid').all() as unknown as {
      id: string; name: string; command: string; args: string; env: string; enabled: number; scope: string; capability?: string;
    }[]).map((r) => ({
      id: r.id, name: r.name, command: r.command,
      args: JSON.parse(r.args) as string[], env: JSON.parse(r.env) as Record<string, string>,
      enabled: r.enabled === 1, scope: r.scope,
      capability: r.capability === 'browser' ? 'browser' : '',
      running: this.running.has(r.id),
      hasSecrets: this.hasSecretEnv(r.id)
    }));
  }

  create(input: { name: string; command: string; args?: string[]; env?: Record<string, string>; scope?: string; capability?: McpCapability }): McpServerConfig {
    const id = `mcp-${randomUUID().slice(0, 8)}`;
    const scope = input.scope?.trim() || 'global';
    if (scope !== 'global' && !this.agentExists(scope)) throw new Error('绑定的数字员工不存在');
    const { safe, secrets } = this.splitEnv(input.env ?? {});
    if (Object.keys(secrets).length > 0 && !safeStorage.isEncryptionAvailable()) {
      throw new Error('系统密钥库不可用，无法保存 MCP 密钥');
    }
    const cfg: McpServerConfig = {
      id, name: input.name, command: input.command,
      args: input.args ?? [], env: safe, enabled: true, scope,
      capability: input.capability === 'browser' ? 'browser' : '', running: false,
      hasSecrets: Object.keys(secrets).length > 0
    };
    this.db.raw.prepare('INSERT INTO mcp_servers(id, name, command, args, env, enabled, scope, capability) VALUES(?,?,?,?,?,1,?,?)')
      .run(id, cfg.name, cfg.command, JSON.stringify(cfg.args), JSON.stringify(cfg.env), cfg.scope, cfg.capability);
    if (Object.keys(secrets).length > 0) this.storeSecretEnv(id, secrets);
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'mcp.create', target: id, result: cfg.capability || 'generic' });
    return cfg;
  }

  createPlaywrightBrowser(input: { agentId: string; extensionToken?: string }): McpServerConfig {
    const existing = this.list().find((cfg) =>
      cfg.command === BUILTIN_PLAYWRIGHT_COMMAND && cfg.scope === input.agentId && cfg.capability === 'browser'
    );
    if (existing) {
      this.db.raw.prepare('UPDATE mcp_servers SET enabled = 1 WHERE id = ?').run(existing.id);
      if (input.extensionToken?.trim()) {
        this.storeSecretEnv(existing.id, { PLAYWRIGHT_MCP_EXTENSION_TOKEN: input.extensionToken.trim() });
      }
      return { ...existing, enabled: true, hasSecrets: existing.hasSecrets || !!input.extensionToken?.trim() };
    }
    const env: Record<string, string> = input.extensionToken?.trim()
      ? { PLAYWRIGHT_MCP_EXTENSION_TOKEN: input.extensionToken.trim() }
      : {};
    return this.create({
      name: 'Playwright 浏览器',
      command: BUILTIN_PLAYWRIGHT_COMMAND,
      args: ['--extension'],
      env,
      scope: input.agentId,
      capability: 'browser'
    });
  }

  remove(id: string) {
    void this.stop(id);
    this.db.raw.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
    this.db.raw.prepare('DELETE FROM settings WHERE key = ?').run(this.secretEnvRef(id));
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'mcp.remove', target: id, result: 'ok' });
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
    if (!cfg.enabled) return { ok: false, message: '服务器已停用' };
    if (this.running.has(id)) return { ok: true, message: '已在运行', tools: this.running.get(id)!.tools };

    try {
      const launch = this.resolveLaunch(cfg);
      const proc = spawnCli(launch.command, launch.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...launch.env, ...this.resolveEnv(cfg) },
        shell: false,
        windowsHide: true
      });

      const server: RunningServer = { proc, nextId: 1, pending: new Map(), buffer: '', decoder: createUtf8StreamDecoder(), tools: [] };
      this.running.set(id, server);

      // stdout 数据 → JSON-RPC 响应解析（按换行分割）
      proc.stdout?.on('data', (chunk: Buffer) => {
        server.buffer += server.decoder.write(chunk);
        if (server.buffer.length > MAX_MCP_LINE_BUFFER_CHARS && !server.buffer.includes('\n')) {
          this.failServer(id, server, 'MCP 服务器输出单行超过 512 KiB');
          return;
        }
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
              clearTimeout(p.timer);
              if (msg.error) p.reject(new Error(msg.error.message));
              else p.resolve(msg.result);
            }
          } catch { /* 非 JSON 行忽略 */ }
        }
      });

      proc.on('exit', () => {
        server.buffer += server.decoder.end();
        this.rejectPending(server, 'MCP 服务器已退出');
        if (this.running.get(id) === server) this.running.delete(id);
      });
      proc.on('error', (error) => {
        this.rejectPending(server, error.message);
        if (this.running.get(id) === server) this.running.delete(id);
      });

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
        serverId: id, serverName: cfg.name, capability: cfg.capability
      }));

      return { ok: true, message: `已连接，发现 ${server.tools.length} 个工具`, tools: server.tools };
    } catch (err) {
      const server = this.running.get(id);
      if (server) {
        this.rejectPending(server, 'MCP 启动失败');
        server.proc.kill();
      }
      this.running.delete(id);
      return { ok: false, message: `启动失败：${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async stop(id: string) {
    const server = this.running.get(id);
    if (!server) return;
    this.running.delete(id);
    this.rejectPending(server, 'MCP 服务器已停止');
    server.proc.stdin?.end();
    server.proc.kill();
  }

  dispose(): void {
    for (const [id, server] of this.running) {
      this.running.delete(id);
      this.rejectPending(server, '应用正在退出');
      server.proc.stdin?.end();
      server.proc.kill();
    }
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

  /** Expose only running servers that are enabled, in scope, and allowed by capabilities. */
  async toolsForAgent(agentId: string, capabilities: AgentCapabilities): Promise<McpTool[]> {
    const configs = this.list().filter((cfg) =>
      cfg.enabled &&
      cfg.running &&
      (cfg.scope === 'global' || cfg.scope === agentId) &&
      (cfg.capability !== 'browser' || capabilities.browser)
    );
    const allowed = new Set(configs.map((cfg) => cfg.id));
    return this.allTools().filter((tool) => allowed.has(tool.serverId));
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

  async callToolForAgent(input: {
    agentId: string;
    taskId: string;
    serverId: string;
    toolName: string;
    args: Record<string, unknown>;
    capabilities: AgentCapabilities;
  }): Promise<string> {
    const cfg = this.list().find((item) => item.id === input.serverId);
    if (!cfg || !cfg.enabled) throw new Error('MCP 服务器未启用');
    if (cfg.scope !== 'global' && cfg.scope !== input.agentId) throw new Error('该数字员工无权使用此 MCP 服务器');
    if (cfg.capability === 'browser' && (!input.capabilities.browser || !this.agentHasBrowserCapability(input.agentId))) {
      throw new Error('该数字员工未开启浏览器权限');
    }
    const response = await this.callTool(input.serverId, input.toolName, input.args);
    this.db.audit({
      id: randomUUID(), actor: `agent:${input.agentId}`, action: 'mcp.tool.call',
      target: `${input.serverId}:${input.toolName}`, result: response.ok ? 'ok' : `error:${response.error ?? 'unknown'}`,
      source: input.taskId
    });
    if (!response.ok) throw new Error(response.error ?? 'MCP 工具调用失败');
    return this.formatResult(response.result);
  }

  // ---------- JSON-RPC ----------

  private rpc(server: RunningServer, method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = server.nextId++;
      const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      const timer = setTimeout(() => {
        if (server.pending.has(id)) {
          server.pending.delete(id);
          reject(new Error(`RPC 超时：${method}`));
        }
      }, RPC_TIMEOUT_MS);
      server.pending.set(id, { resolve, reject, timer });
      server.proc.stdin?.write(JSON.stringify(req) + '\n');
    });
  }

  private failServer(id: string, server: RunningServer, message: string): void {
    this.rejectPending(server, message);
    if (this.running.get(id) === server) this.running.delete(id);
    server.proc.stdin?.end();
    server.proc.kill();
  }

  private resolveLaunch(cfg: McpServerConfig): { command: string; args: string[]; env?: Record<string, string> } {
    if (cfg.command !== BUILTIN_PLAYWRIGHT_COMMAND) return { command: cfg.command, args: cfg.args };
    const packageRoot = dirname(require.resolve('@playwright/mcp/package.json'));
    return {
      command: process.execPath,
      args: [join(packageRoot, 'cli.js'), ...cfg.args],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    };
  }

  private agentExists(agentId: string): boolean {
    return !!this.db.raw.prepare('SELECT id FROM agents WHERE id = ? AND archived = 0').get(agentId);
  }

  private agentHasBrowserCapability(agentId: string): boolean {
    const row = this.db.raw.prepare('SELECT capabilities_json FROM agents WHERE id = ? AND archived = 0').get(agentId) as { capabilities_json?: string } | undefined;
    if (!row) return false;
    try {
      return (JSON.parse(row.capabilities_json || '{}') as Partial<AgentCapabilities>).browser === true;
    } catch {
      return false;
    }
  }

  private splitEnv(env: Record<string, string>): { safe: Record<string, string>; secrets: Record<string, string> } {
    const safe: Record<string, string> = {};
    const secrets: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (SECRET_ENV_PATTERN.test(key)) {
        safe[key] = SECRET_PLACEHOLDER;
        if (value && value !== SECRET_PLACEHOLDER) secrets[key] = value;
      } else {
        safe[key] = value;
      }
    }
    return { safe, secrets };
  }

  private secretEnvRef(id: string): string {
    return `secret:mcp:${id}:env`;
  }

  private storeSecretEnv(id: string, secrets: Record<string, string>): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥库不可用，无法保存 MCP 密钥');
    this.db.setSetting(this.secretEnvRef(id), safeStorage.encryptString(JSON.stringify(secrets)).toString('base64'));
    this.db.audit({ id: randomUUID(), actor: 'admin', action: 'mcp.secret.store', target: id, result: `${Object.keys(secrets).length} keys` });
  }

  private hasSecretEnv(id: string): boolean {
    return !!this.db.getSetting<string>(this.secretEnvRef(id), '');
  }

  private resolveEnv(cfg: McpServerConfig): Record<string, string> {
    const env = Object.fromEntries(Object.entries(cfg.env).filter(([, value]) => value !== SECRET_PLACEHOLDER));
    const encrypted = this.db.getSetting<string>(this.secretEnvRef(cfg.id), '');
    if (!encrypted || !safeStorage.isEncryptionAvailable()) return env;
    try {
      return { ...env, ...JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64'))) as Record<string, string> };
    } catch {
      return env;
    }
  }

  private rejectPending(server: RunningServer, message: string): void {
    for (const pending of server.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    server.pending.clear();
  }

  private formatResult(result: unknown): string {
    if (typeof result === 'string') return result.slice(0, MAX_RESULT_CHARS);
    if (result && typeof result === 'object' && Array.isArray((result as { content?: unknown[] }).content)) {
      const text = (result as { content: { type?: string; text?: string }[] }).content
        .filter((item) => item?.type === 'text' && typeof item.text === 'string')
        .map((item) => item.text)
        .join('\n');
      if (text) return text.slice(0, MAX_RESULT_CHARS);
    }
    return JSON.stringify(result ?? null, null, 2).slice(0, MAX_RESULT_CHARS);
  }
}
