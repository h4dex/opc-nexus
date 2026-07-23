/**
 * 多机协同管理器：
 * - 工作区 CRUD（创建时初始化 bare repo + 生成 invite_token）
 * - 子任务管理（创建/拆解/分配/状态流转）
 * - 远程 Agent 注册/心跳/离线检测
 * - 验收流程（主 Agent 对 submitted 任务执行 review）
 * - Git 操作封装（init bare repo、创建分支、merge、查看 diff）
 */
import { randomUUID, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import type { Database } from './database.js';
import type { GitHttpServer } from './gitHttpServer.js';
import type { McpCollabServer } from './mcpCollabServer.js';
import type {
  CollabWorkspace, CollabTask, CollabAgent, CollabConnectInfo,
  CollabWorkspaceStatus, CollabTaskStatus
} from '../../shared/types.js';

interface WorkspaceRow {
  id: string; name: string; repo_path: string; conventions: string; git_rules: string;
  mcp_port: number; git_port: number; invite_token: string; status: string; created_at: number;
}

interface TaskRow {
  id: string; workspace_id: string; title: string; description: string; branch_name: string;
  status: string; assigned_agent: string | null; assigned_at: number | null;
  submitted_at: number | null; review_result: string | null; created_at: number;
}

interface AgentRow {
  id: string; workspace_id: string; name: string; endpoint: string;
  status: string; last_heartbeat: number; connected_at: number;
}

interface RunningWorkspace {
  gitServer: GitHttpServer;
  mcpServer: McpCollabServer;
}

export class CollabManager {
  private running = new Map<string, RunningWorkspace>();
  /** 离线超时：60 秒无心跳视为离线 */
  private static HEARTBEAT_TIMEOUT_MS = 60_000;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(private db: Database) {
    // 定期检测远程 Agent 心跳超时
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), 15_000);
  }

  dispose() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const [id] of this.running) this.stopWorkspace(id);
  }

  // ---------- 工作区 CRUD ----------

  listWorkspaces(): CollabWorkspace[] {
    return (this.db.raw.prepare('SELECT * FROM collab_workspaces ORDER BY created_at DESC').all() as unknown as WorkspaceRow[]).map(this.mapWorkspace);
  }

  getWorkspace(id: string): CollabWorkspace | null {
    const row = this.db.raw.prepare('SELECT * FROM collab_workspaces WHERE id = ?').get(id) as unknown as WorkspaceRow | undefined;
    return row ? this.mapWorkspace(row) : null;
  }

  createWorkspace(input: { name: string; repoPath: string; conventions?: string; gitRules?: string; mcpPort?: number; gitPort?: number }): CollabWorkspace {
    const id = `cw-${randomUUID().slice(0, 8)}`;
    const token = randomBytes(24).toString('hex');
    const now = Date.now();
    const ws: CollabWorkspace = {
      id,
      name: input.name,
      repoPath: input.repoPath,
      conventions: input.conventions ?? '',
      gitRules: input.gitRules ?? '',
      mcpPort: input.mcpPort ?? 28890,
      gitPort: input.gitPort ?? 28891,
      status: 'idle',
      createdAt: now
    };
    this.db.raw.prepare(
      'INSERT INTO collab_workspaces(id, name, repo_path, conventions, git_rules, mcp_port, git_port, invite_token, status, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)'
    ).run(id, ws.name, ws.repoPath, ws.conventions, ws.gitRules, ws.mcpPort, ws.gitPort, token, 'idle', now);
    return ws;
  }

  removeWorkspace(id: string) {
    this.stopWorkspace(id);
    this.db.raw.prepare('DELETE FROM collab_agents WHERE workspace_id = ?').run(id);
    this.db.raw.prepare('DELETE FROM collab_tasks WHERE workspace_id = ?').run(id);
    this.db.raw.prepare('DELETE FROM collab_workspaces WHERE id = ?').run(id);
  }

  async startWorkspace(id: string): Promise<{ ok: boolean; message: string }> {
    const row = this.db.raw.prepare('SELECT * FROM collab_workspaces WHERE id = ?').get(id) as unknown as WorkspaceRow | undefined;
    if (!row) return { ok: false, message: '工作区不存在' };
    if (this.running.has(id)) return { ok: true, message: '已在运行' };

    // 确保 bare repo 存在
    if (!existsSync(join(row.repo_path, 'HEAD'))) {
      const initResult = await this.gitInitBare(id);
      if (!initResult.ok) return initResult;
    }

    try {
      // 动态导入避免循环依赖
      const { GitHttpServer } = await import('./gitHttpServer.js');
      const { McpCollabServer } = await import('./mcpCollabServer.js');

      const gitServer = new GitHttpServer(row.git_port, row.repo_path, row.invite_token);
      const mcpServer = new McpCollabServer(row.mcp_port, this, id, row.invite_token);

      const gitResult = await gitServer.start();
      if (!gitResult.ok) return { ok: false, message: `Git Server 启动失败：${gitResult.message}` };

      const mcpResult = await mcpServer.start();
      if (!mcpResult.ok) {
        gitServer.stop();
        return { ok: false, message: `MCP Server 启动失败：${mcpResult.message}` };
      }

      this.running.set(id, { gitServer, mcpServer });
      this.db.raw.prepare("UPDATE collab_workspaces SET status = 'active' WHERE id = ?").run(id);
      return { ok: true, message: `已启动（Git :${row.git_port} / MCP :${row.mcp_port}）` };
    } catch (err) {
      return { ok: false, message: `启动失败：${err instanceof Error ? err.message : String(err)}` };
    }
  }

  stopWorkspace(id: string) {
    const r = this.running.get(id);
    if (!r) return;
    r.gitServer.stop();
    r.mcpServer.stop();
    this.running.delete(id);
    this.db.raw.prepare("UPDATE collab_workspaces SET status = 'stopped' WHERE id = ?").run(id);
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  updateRules(id: string, patch: { conventions?: string; gitRules?: string }) {
    const fields: string[] = [];
    const values: (string | number)[] = [];
    if (patch.conventions !== undefined) { fields.push('conventions = ?'); values.push(patch.conventions); }
    if (patch.gitRules !== undefined) { fields.push('git_rules = ?'); values.push(patch.gitRules); }
    if (fields.length === 0) return;
    values.push(id);
    this.db.raw.prepare(`UPDATE collab_workspaces SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  // ---------- 子任务管理 ----------

  listTasks(workspaceId: string): CollabTask[] {
    return (this.db.raw.prepare('SELECT * FROM collab_tasks WHERE workspace_id = ? ORDER BY created_at DESC').all(workspaceId) as unknown as TaskRow[]).map(this.mapTask);
  }

  getTask(taskId: string): CollabTask | null {
    const row = this.db.raw.prepare('SELECT * FROM collab_tasks WHERE id = ?').get(taskId) as unknown as TaskRow | undefined;
    return row ? this.mapTask(row) : null;
  }

  createTask(workspaceId: string, input: { title: string; description?: string; branchName?: string }): CollabTask {
    const id = `ct-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const branchName = input.branchName ?? `task/${id}`;
    const task: CollabTask = {
      id, workspaceId, title: input.title, description: input.description ?? '',
      branchName, status: 'pending', assignedAgent: null, assignedAt: null,
      submittedAt: null, reviewResult: null, createdAt: now
    };
    this.db.raw.prepare(
      'INSERT INTO collab_tasks(id, workspace_id, title, description, branch_name, status, created_at) VALUES(?,?,?,?,?,?,?)'
    ).run(id, workspaceId, task.title, task.description, branchName, 'pending', now);
    return task;
  }

  claimTask(taskId: string, agentName: string): { ok: boolean; message: string } {
    const row = this.db.raw.prepare('SELECT * FROM collab_tasks WHERE id = ?').get(taskId) as unknown as TaskRow | undefined;
    if (!row) return { ok: false, message: '任务不存在' };
    if (row.status !== 'pending') return { ok: false, message: `任务状态为 ${row.status}，无法认领` };
    const now = Date.now();
    this.db.raw.prepare("UPDATE collab_tasks SET status = 'claimed', assigned_agent = ?, assigned_at = ? WHERE id = ?")
      .run(agentName, now, taskId);
    // 异步创建 Git 分支
    void this.gitCreateBranch(row.workspace_id, row.branch_name);
    return { ok: true, message: `已认领，分支：${row.branch_name}` };
  }

  updateTaskProgress(taskId: string, _progress: number, _note?: string): { ok: boolean; message: string } {
    const row = this.db.raw.prepare('SELECT status FROM collab_tasks WHERE id = ?').get(taskId) as { status: string } | undefined;
    if (!row) return { ok: false, message: '任务不存在' };
    if (row.status === 'claimed') {
      this.db.raw.prepare("UPDATE collab_tasks SET status = 'in_progress' WHERE id = ?").run(taskId);
    }
    return { ok: true, message: '进度已更新' };
  }

  submitTask(taskId: string): { ok: boolean; message: string } {
    const row = this.db.raw.prepare('SELECT status FROM collab_tasks WHERE id = ?').get(taskId) as { status: string } | undefined;
    if (!row) return { ok: false, message: '任务不存在' };
    if (!['claimed', 'in_progress'].includes(row.status)) return { ok: false, message: `当前状态 ${row.status} 不可提交` };
    this.db.raw.prepare("UPDATE collab_tasks SET status = 'submitted', submitted_at = ? WHERE id = ?")
      .run(Date.now(), taskId);
    return { ok: true, message: '已提交，等待主 Agent 验收' };
  }

  reviewTask(taskId: string, result: 'accept' | 'reject', comment: string): { ok: boolean; message: string } {
    const row = this.db.raw.prepare('SELECT * FROM collab_tasks WHERE id = ?').get(taskId) as unknown as TaskRow | undefined;
    if (!row) return { ok: false, message: '任务不存在' };
    if (row.status !== 'submitted') return { ok: false, message: `当前状态 ${row.status}，仅 submitted 可验收` };
    const newStatus: CollabTaskStatus = result === 'accept' ? 'accepted' : 'rejected';
    this.db.raw.prepare('UPDATE collab_tasks SET status = ?, review_result = ? WHERE id = ?')
      .run(newStatus, comment, taskId);
    // 验收通过则自动 merge 分支
    if (result === 'accept') {
      void this.gitMergeBranch(row.workspace_id, row.branch_name);
    }
    return { ok: true, message: result === 'accept' ? '验收通过，已合并分支' : '已驳回' };
  }

  // ---------- 远程 Agent ----------

  listAgents(workspaceId: string): CollabAgent[] {
    return (this.db.raw.prepare('SELECT * FROM collab_agents WHERE workspace_id = ? ORDER BY connected_at DESC').all(workspaceId) as unknown as AgentRow[]).map(this.mapAgent);
  }

  registerAgent(workspaceId: string, name: string, endpoint?: string): CollabAgent {
    // 同名 Agent 重连：更新心跳和状态
    const existing = this.db.raw.prepare('SELECT id FROM collab_agents WHERE workspace_id = ? AND name = ?').get(workspaceId, name) as { id: string } | undefined;
    if (existing) {
      const now = Date.now();
      this.db.raw.prepare("UPDATE collab_agents SET status = 'online', last_heartbeat = ?, endpoint = ? WHERE id = ?")
        .run(now, endpoint ?? '', existing.id);
      return this.mapAgent(this.db.raw.prepare('SELECT * FROM collab_agents WHERE id = ?').get(existing.id) as unknown as AgentRow);
    }
    const id = `ca-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    this.db.raw.prepare(
      'INSERT INTO collab_agents(id, workspace_id, name, endpoint, status, last_heartbeat, connected_at) VALUES(?,?,?,?,?,?,?)'
    ).run(id, workspaceId, name, endpoint ?? '', 'online', now, now);
    return { id, workspaceId, name, endpoint: endpoint ?? '', status: 'online', lastHeartbeat: now, connectedAt: now };
  }

  heartbeat(agentId: string): { ok: boolean } {
    const r = this.db.raw.prepare('UPDATE collab_agents SET last_heartbeat = ?, status = ? WHERE id = ?')
      .run(Date.now(), 'online', agentId);
    return { ok: r.changes > 0 };
  }

  // ---------- 连接信息 ----------

  getConnectInfo(workspaceId: string): CollabConnectInfo | null {
    const row = this.db.raw.prepare('SELECT * FROM collab_workspaces WHERE id = ?').get(workspaceId) as unknown as WorkspaceRow | undefined;
    if (!row) return null;
    const lanIp = getLanIp();
    return {
      mcpUrl: `http://${lanIp}:${row.mcp_port}/mcp`,
      gitUrl: `http://${lanIp}:${row.git_port}/${row.name}.git`,
      token: row.invite_token,
      workspaceName: row.name
    };
  }

  // ---------- Git 操作 ----------

  async gitInitBare(workspaceId: string): Promise<{ ok: boolean; message: string }> {
    const row = this.db.raw.prepare('SELECT repo_path FROM collab_workspaces WHERE id = ?').get(workspaceId) as { repo_path: string } | undefined;
    if (!row) return { ok: false, message: '工作区不存在' };
    const result = await this.execGit(['init', '--bare', row.repo_path], undefined);
    if (!result.ok) return result;
    // 安装 pre-receive hook：仅允许 task/* 前缀分支 push，保护 main/master
    this.installPreReceiveHook(row.repo_path);
    return result;
  }

  async gitCreateBranch(workspaceId: string, branch: string, from?: string): Promise<{ ok: boolean; message: string }> {
    const row = this.db.raw.prepare('SELECT repo_path FROM collab_workspaces WHERE id = ?').get(workspaceId) as { repo_path: string } | undefined;
    if (!row) return { ok: false, message: '工作区不存在' };
    // bare repo 中创建分支：git branch <name> [from]
    const args = ['branch', branch];
    if (from) args.push(from);
    return this.execGit(args, row.repo_path);
  }

  async gitMergeBranch(workspaceId: string, branch: string, target?: string): Promise<{ ok: boolean; message: string }> {
    const row = this.db.raw.prepare('SELECT repo_path FROM collab_workspaces WHERE id = ?').get(workspaceId) as { repo_path: string } | undefined;
    if (!row) return { ok: false, message: '工作区不存在' };
    const targetBranch = target ?? 'main';
    // bare repo merge: checkout target + merge branch
    const checkout = await this.execGit(['symbolic-ref', 'HEAD', `refs/heads/${targetBranch}`], row.repo_path);
    if (!checkout.ok) return checkout;
    return this.execGit(['merge', branch, '--no-edit'], row.repo_path);
  }

  async gitDiff(workspaceId: string, branch: string): Promise<string> {
    const row = this.db.raw.prepare('SELECT repo_path FROM collab_workspaces WHERE id = ?').get(workspaceId) as { repo_path: string } | undefined;
    if (!row) return '';
    const result = await this.execGit(['diff', 'main', branch], row.repo_path);
    return result.message;
  }

  // ---------- 文件产物 ----------

  saveArtifact(workspaceId: string, filename: string, contentBase64: string): { ok: boolean; message: string } {
    const row = this.db.raw.prepare('SELECT repo_path, name FROM collab_workspaces WHERE id = ?').get(workspaceId) as { repo_path: string; name: string } | undefined;
    if (!row) return { ok: false, message: '工作区不存在' };
    // 安全校验：禁止路径穿越
    if (filename.includes('..') || filename.startsWith('/') || filename.startsWith('\\')) {
      return { ok: false, message: '文件名不合法（禁止路径穿越）' };
    }
    try {
      const artifactsDir = join(row.repo_path, '..', `${row.name}-artifacts`);
      const targetPath = join(artifactsDir, filename);
      mkdirSync(join(targetPath, '..'), { recursive: true });
      writeFileSync(targetPath, Buffer.from(contentBase64, 'base64'));
      return { ok: true, message: `文件已保存：${filename}` };
    } catch (err) {
      return { ok: false, message: `保存失败：${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // ---------- 内部工具 ----------

  /** 安装 pre-receive hook：仅允许 task/* 前缀分支 push，保护 main/master */
  private installPreReceiveHook(repoPath: string) {
    const hookDir = join(repoPath, 'hooks');
    const hookPath = join(hookDir, 'pre-receive');
    const hookContent = `#!/bin/sh
# AiBox 协同分支保护：仅允许 task/* 前缀分支 push
while read oldrev newrev refname; do
  branch=$(echo "$refname" | sed 's|refs/heads/||')
  case "$branch" in
    task/*) ;;
    *) echo "ERROR: 禁止直接 push 到 $branch，请使用 task/<id> 分支"; exit 1 ;;
  esac
done
exit 0
`;
    try {
      mkdirSync(hookDir, { recursive: true });
      writeFileSync(hookPath, hookContent, { mode: 0o755 });
    } catch { /* hook 安装失败不阻塞主流程 */ }
  }

  private execGit(args: string[], cwd: string | undefined): Promise<{ ok: boolean; message: string }> {
    return new Promise((resolve) => {
      execFile('git', args, { cwd, timeout: 30_000, shell: false }, (err, stdout, stderr) => {
        if (err) resolve({ ok: false, message: (stderr || err.message).slice(0, 500) });
        else resolve({ ok: true, message: (stdout || stderr || 'ok').slice(0, 500) });
      });
    });
  }

  private checkHeartbeats() {
    const threshold = Date.now() - CollabManager.HEARTBEAT_TIMEOUT_MS;
    this.db.raw.prepare("UPDATE collab_agents SET status = 'offline' WHERE last_heartbeat < ? AND status = 'online'").run(threshold);
  }

  private mapWorkspace(r: WorkspaceRow): CollabWorkspace {
    return {
      id: r.id, name: r.name, repoPath: r.repo_path, conventions: r.conventions,
      gitRules: r.git_rules, mcpPort: r.mcp_port, gitPort: r.git_port,
      status: r.status as CollabWorkspaceStatus, createdAt: r.created_at
    };
  }

  private mapTask(r: TaskRow): CollabTask {
    return {
      id: r.id, workspaceId: r.workspace_id, title: r.title, description: r.description,
      branchName: r.branch_name, status: r.status as CollabTaskStatus,
      assignedAgent: r.assigned_agent, assignedAt: r.assigned_at,
      submittedAt: r.submitted_at, reviewResult: r.review_result, createdAt: r.created_at
    };
  }

  private mapAgent(r: AgentRow): CollabAgent {
    return {
      id: r.id, workspaceId: r.workspace_id, name: r.name, endpoint: r.endpoint,
      status: r.status as 'online' | 'offline', lastHeartbeat: r.last_heartbeat, connectedAt: r.connected_at
    };
  }
}

/** 获取本机局域网 IP */
function getLanIp(): string {
  const nets = networkInterfaces();
  for (const addrs of Object.values(nets)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '127.0.0.1';
}
