/**
 * 可视化工作流引擎（v2）：
 * - 支持 6 种节点类型：AI 模型调用 / CLI 命令 / Python 脚本 / HTTP 请求 / Coze 工作流 / Dify 工作流
 * - DAG 拓扑调度：无入边节点并行启动，下游依赖全部满足后自动触发
 * - 变量插值：{{nodeId.output}} 从上游节点输出中取值
 * - 执行状态实时广播到前端（节点变色）
 * - 工作流可发布为 Skill 供数字员工引用
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Database } from './database.js';
import type { ProviderManager } from './providerManager.js';
import type { WfPlatformManager } from './wfPlatformManager.js';
import type { WfNode, WfEdge, WorkflowDef, WfNodeConfig, WfNodeEvent, WfValidationResult, WfRunRecord, WfVariable } from '../../shared/types.js';
import { appendProcessOutput, createProcessOutputBuffer, finishProcessOutput } from './textEncoding.js';

type NodeStatus = 'pending' | 'running' | 'completed' | 'failed';

interface RunState {
  workflowId: string;
  runId: string;
  nodeStatuses: Map<string, NodeStatus>;
  context: Map<string, string>; // nodeId → output
}

export class WorkflowEngine {
  private activeRuns = new Map<string, RunState>();
  private broadcastFn: ((channel: string, payload: unknown) => void) | null = null;

  constructor(
    private db: Database,
    private providerMgr: ProviderManager,
    private platformMgr: WfPlatformManager
  ) {}

  /** 注册广播函数（由 ipc.ts 注入） */
  onBroadcast(fn: (channel: string, payload: unknown) => void) {
    this.broadcastFn = fn;
  }

  // ---------- CRUD ----------

  list(): WorkflowDef[] {
    return (this.db.raw.prepare('SELECT * FROM workflows ORDER BY created_at DESC').all() as unknown as {
      id: string; name: string; description: string; steps_json: string; nodes_json: string;
      edges_json: string; variables_json: string; version: number; status: string; published_as_skill: number; skill_id: string | null;
      created_at: number; last_run_at: number | null;
    }[]).map((r) => {
      let nodes: WfNode[] = [];
      let edges: WfEdge[] = [];
      let variables: WfVariable[] = [];
      try { nodes = JSON.parse(r.nodes_json || '[]') as WfNode[]; } catch { /* empty */ }
      try { edges = JSON.parse(r.edges_json || '[]') as WfEdge[]; } catch { /* empty */ }
      try { variables = JSON.parse(r.variables_json || '[]') as WfVariable[]; } catch { /* empty */ }
      return {
        id: r.id, name: r.name, description: r.description ?? '', nodes, edges, variables,
        version: r.version ?? 1,
        status: r.status as WorkflowDef['status'],
        publishedAsSkill: (r.published_as_skill ?? 0) === 1,
        skillId: r.skill_id ?? null,
        createdAt: r.created_at, lastRunAt: r.last_run_at
      };
    });
  }

  create(input: { name: string; description?: string; nodes: WfNode[]; edges: WfEdge[] }): WorkflowDef {
    const id = `wf-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    this.db.raw.prepare(
      'INSERT INTO workflows(id, name, description, steps_json, nodes_json, edges_json, status, published_as_skill, created_at, last_run_at) VALUES(?,?,?,?,?,?,?,0,?,NULL)'
    ).run(id, input.name, input.description ?? '', '[]', JSON.stringify(input.nodes), JSON.stringify(input.edges), 'idle', now);
    return { id, name: input.name, description: input.description ?? '', nodes: input.nodes, edges: input.edges, status: 'idle', publishedAsSkill: false, skillId: null, createdAt: now, lastRunAt: null };
  }

  update(id: string, patch: { name?: string; description?: string; nodes?: WfNode[]; edges?: WfEdge[] }) {
    const fields: string[] = [];
    const values: (string | number)[] = [];
    if (patch.name !== undefined) { fields.push('name = ?'); values.push(patch.name); }
    if (patch.description !== undefined) { fields.push('description = ?'); values.push(patch.description); }
    if (patch.nodes !== undefined) { fields.push('nodes_json = ?'); values.push(JSON.stringify(patch.nodes)); }
    if (patch.edges !== undefined) { fields.push('edges_json = ?'); values.push(JSON.stringify(patch.edges)); }
    if (fields.length === 0) return;
    values.push(id);
    this.db.raw.prepare(`UPDATE workflows SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  remove(id: string) {
    this.db.raw.prepare('DELETE FROM workflows WHERE id = ?').run(id);
    this.activeRuns.delete(id);
  }

  // ---------- 发布为 Skill ----------

  publishAsSkill(wfId: string): { ok: boolean; message: string; skillId?: string } {
    const wf = this.list().find((w) => w.id === wfId);
    if (!wf) return { ok: false, message: '工作流不存在' };
    if (wf.publishedAsSkill && wf.skillId) return { ok: true, message: '已发布', skillId: wf.skillId };

    const skillId = `skill-${randomUUID().slice(0, 8)}`;
    this.db.raw.prepare('INSERT INTO skills(id, name, description, content, enabled, created_at) VALUES(?,?,?,?,1,?)')
      .run(skillId, wf.name, wf.description || `工作流: ${wf.name}`, `workflow:${wfId}`, Date.now());
    this.db.raw.prepare('UPDATE workflows SET published_as_skill = 1, skill_id = ? WHERE id = ?').run(skillId, wfId);
    return { ok: true, message: `已发布为 Skill「${wf.name}」`, skillId };
  }

  unpublishSkill(wfId: string): { ok: boolean; message: string } {
    const wf = this.list().find((w) => w.id === wfId);
    if (!wf) return { ok: false, message: '工作流不存在' };
    if (wf.skillId) {
      this.db.raw.prepare('DELETE FROM agent_skills WHERE skill_id = ?').run(wf.skillId);
      this.db.raw.prepare('DELETE FROM skills WHERE id = ?').run(wf.skillId);
    }
    this.db.raw.prepare('UPDATE workflows SET published_as_skill = 0, skill_id = NULL WHERE id = ?').run(wfId);
    return { ok: true, message: '已取消发布' };
  }

  // ---------- 校验 / 导入 / 导出 ----------

  /** 校验工作流结构 */
  validate(wf: { nodes: WfNode[]; edges: WfEdge[] }): WfValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const { nodes, edges } = wf;

    if (nodes.length === 0) { errors.push('工作流没有任何节点'); return { valid: false, errors, warnings }; }

    const hasStart = nodes.some((n) => n.type === 'start');
    const hasEnd = nodes.some((n) => n.type === 'end');
    if (!hasStart) errors.push('缺少「开始」节点');
    if (!hasEnd) warnings.push('缺少「结束」节点，工作流将在所有叶子节点执行完毕后自动结束');

    // 孤立节点检测（无入边且无出边，且不是 start）
    const hasInEdge = new Set(edges.map((e) => e.target));
    const hasOutEdge = new Set(edges.map((e) => e.source));
    for (const n of nodes) {
      if (n.type === 'start') continue;
      if (!hasInEdge.has(n.id) && !hasOutEdge.has(n.id)) {
        warnings.push(`节点「${n.label || n.id}」是孤立节点（无连接）`);
      }
    }

    // 环检测
    if (this.hasCycle(nodes, edges)) errors.push('节点连接存在循环依赖，请检查');

    // 条件节点配置检查
    for (const n of nodes) {
      if (n.type === 'condition' && !n.config.condition) warnings.push(`条件节点「${n.label}」未配置条件表达式`);
      if (n.type === 'subflow' && !n.config.subflowId) warnings.push(`子工作流节点「${n.label}」未选择工作流`);
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  /** 导出工作流为 JSON 字符串 */
  exportWorkflow(wfId: string): string | null {
    const wf = this.list().find((w) => w.id === wfId);
    if (!wf) return null;
    const exportable = {
      _type: 'aibox-workflow', _version: 1,
      name: wf.name, description: wf.description,
      nodes: wf.nodes, edges: wf.edges,
      variables: wf.variables ?? [], version: wf.version ?? 1
    };
    return JSON.stringify(exportable, null, 2);
  }

  /** 从 JSON 导入工作流 */
  importWorkflow(json: string): { ok: boolean; message: string; workflow?: WorkflowDef } {
    try {
      const data = JSON.parse(json) as { _type?: string; name?: string; description?: string; nodes?: WfNode[]; edges?: WfEdge[]; variables?: WfVariable[] };
      if (data._type !== 'aibox-workflow') return { ok: false, message: '文件格式不正确（缺少 _type: aibox-workflow）' };
      if (!data.nodes || !Array.isArray(data.nodes)) return { ok: false, message: '文件缺少 nodes 数组' };
      const wf = this.create({
        name: data.name ?? '导入的工作流',
        description: data.description ?? '',
        nodes: data.nodes,
        edges: data.edges ?? []
      });
      // 保存变量
      if (data.variables?.length) {
        this.db.raw.prepare('UPDATE workflows SET variables_json = ? WHERE id = ?').run(JSON.stringify(data.variables), wf.id);
      }
      return { ok: true, message: `已导入工作流「${wf.name}」`, workflow: wf };
    } catch (e) {
      return { ok: false, message: `JSON 解析失败: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /** 保存工作流全局变量 */
  saveVariables(wfId: string, variables: WfVariable[]) {
    this.db.raw.prepare('UPDATE workflows SET variables_json = ? WHERE id = ?').run(JSON.stringify(variables), wfId);
  }

  // ---------- DAG 执行 ----------

  /** 触发工作流执行 */
  trigger(workflowId: string, inputs?: Record<string, string>): { ok: boolean; message: string } {
    const wf = this.list().find((w) => w.id === workflowId);
    if (!wf) return { ok: false, message: '工作流不存在' };
    if (wf.status === 'running') return { ok: false, message: '工作流正在运行中' };
    if (wf.nodes.length === 0) return { ok: false, message: '工作流无节点' };
    if (this.hasCycle(wf.nodes, wf.edges)) return { ok: false, message: '节点依赖存在环，请检查' };
  
    const now = Date.now();
    const runId = `wfrun-${randomUUID().slice(0, 8)}`;
    this.db.raw.prepare("UPDATE workflows SET status = 'running', last_run_at = ? WHERE id = ?").run(now, workflowId);
    // 记录执行历史
    this.db.raw.prepare('INSERT INTO workflow_runs(id, workflow_id, status, node_results, error, started_at, ended_at) VALUES(?,?,?,?,NULL,?,NULL)')
      .run(runId, workflowId, 'running', '{}', now);
  
    const state: RunState = {
      workflowId,
      runId,
      nodeStatuses: new Map(wf.nodes.map((n) => [n.id, 'pending' as NodeStatus])),
      context: new Map(Object.entries(inputs ?? {}))
    };
    this.activeRuns.set(workflowId, state);
  
    // 异步执行 DAG
    void this.executeDag(wf, state);
  
    return { ok: true, message: `工作流「${wf.name}」已触发` };
  }
  
  /** 查询工作流执行历史（最近 50 条） */
  listRuns(workflowId: string): WfRunRecord[] {
    return (this.db.raw.prepare('SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT 50').all(workflowId) as unknown as {
      id: string; workflow_id: string; status: string; error: string | null; node_results: string; started_at: number; ended_at: number | null;
    }[]).map((r) => {
      let nodeResults: Record<string, { status: string; output?: string; error?: string }> = {};
      try { nodeResults = JSON.parse(r.node_results || '{}'); } catch { /* empty */ }
      return {
        id: r.id, workflowId: r.workflow_id, status: r.status as WfRunRecord['status'],
        error: r.error, nodeResults,
        startedAt: r.started_at, endedAt: r.ended_at,
        durationMs: r.ended_at ? r.ended_at - r.started_at : null
      };
    });
  }

  /** 获取运行状态 */
  getRunState(workflowId: string): { nodeId: string; status: NodeStatus }[] | null {
    const state = this.activeRuns.get(workflowId);
    if (!state) return null;
    return [...state.nodeStatuses.entries()].map(([nodeId, status]) => ({ nodeId, status }));
  }

  private async executeDag(wf: WorkflowDef, state: RunState) {
    const { nodes, edges } = wf;
    const inDegree = new Map<string, number>();
    const adjList = new Map<string, string[]>(); // source → targets

    for (const n of nodes) { inDegree.set(n.id, 0); adjList.set(n.id, []); }
    for (const e of edges) {
      inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
      adjList.get(e.source)?.push(e.target);
    }

    // 找到所有入度为 0 的节点（排除 start/end 类型的纯标记节点也参与执行）
    const readyQueue = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0).map((n) => n.id);
    const completedCount = { value: 0 };

    const processNode = async (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;

      state.nodeStatuses.set(nodeId, 'running');
      this.emitNodeEvent(wf.id, nodeId, 'running');

      try {
        const output = await this.executeNode(node, state.context);
        state.context.set(node.config.outputVar || nodeId, output);
        state.nodeStatuses.set(nodeId, 'completed');
        this.emitNodeEvent(wf.id, nodeId, 'completed', output);
      } catch (err) {
        state.nodeStatuses.set(nodeId, 'failed');
        this.emitNodeEvent(wf.id, nodeId, 'failed', undefined, err instanceof Error ? err.message : String(err));
        // 标记工作流失败 + 更新运行记录
        this.db.raw.prepare("UPDATE workflows SET status = 'failed' WHERE id = ?").run(wf.id);
        this.db.raw.prepare("UPDATE workflow_runs SET status = 'failed', error = ?, ended_at = ? WHERE id = ?")
          .run(err instanceof Error ? err.message : String(err), Date.now(), state.runId);
        this.activeRuns.delete(wf.id);
        return;
      }

      completedCount.value++;

      // 检查下游节点
      const targets = adjList.get(nodeId) ?? [];
      for (const target of targets) {
        const deg = (inDegree.get(target) ?? 1) - 1;
        inDegree.set(target, deg);
        if (deg === 0) {
          await processNode(target);
        }
      }

      // 全部完成
      if (completedCount.value === nodes.length) {
        this.db.raw.prepare("UPDATE workflows SET status = 'completed' WHERE id = ?").run(wf.id);
        this.db.raw.prepare("UPDATE workflow_runs SET status = 'completed', ended_at = ? WHERE id = ?")
          .run(Date.now(), state.runId);
        this.activeRuns.delete(wf.id);
      }
    };

    // 并行启动所有入度为 0 的节点
    await Promise.all(readyQueue.map((id) => processNode(id)));

    // 如果没有节点执行（空图），标记完成
    if (nodes.length === 0 || completedCount.value === nodes.length) {
      this.db.raw.prepare("UPDATE workflows SET status = 'completed' WHERE id = ?").run(wf.id);
      this.db.raw.prepare("UPDATE workflow_runs SET status = 'completed', ended_at = ? WHERE id = ?")
        .run(Date.now(), state.runId);
      this.activeRuns.delete(wf.id);
    }
  }

  // ---------- 节点执行器 ----------

  private async executeNode(node: WfNode, context: Map<string, string>): Promise<string> {
    // start/end 节点直接通过
    if (node.type === 'start' || node.type === 'end') return '';

    const cfg = node.config;
    const timeout = (cfg.timeout ?? 120) * 1000;
    const retryCount = cfg.retryCount ?? 0;
    const retryDelay = (cfg.retryDelay ?? 2) * 1000;

    const doExecute = async (): Promise<string> => {
      switch (node.type) {
        case 'ai': return this.executeAiNode(cfg, context, timeout);
        case 'cli': return this.executeCliNode(cfg, context, timeout);
        case 'python': return this.executePythonNode(cfg, context, timeout);
        case 'http': return this.executeHttpNode(cfg, context, timeout);
        case 'coze': return this.executeCozeNode(cfg, context, timeout);
        case 'dify': return this.executeDifyNode(cfg, context, timeout);
        case 'condition': return this.executeConditionNode(cfg, context);
        case 'loop': return this.executeLoopNode(cfg, context, timeout);
        case 'delay': return this.executeDelayNode(cfg);
        case 'subflow': return this.executeSubflowNode(cfg, context);
        default: return '';
      }
    };

    // 重试逻辑
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= retryCount; attempt++) {
      try {
        return await doExecute();
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < retryCount) {
          await new Promise((r) => setTimeout(r, retryDelay));
        }
      }
    }
    throw lastErr ?? new Error('节点执行失败');
  }

  /** 条件分支节点：评估表达式，返回 'true' 或 'false' */
  private executeConditionNode(cfg: WfNodeConfig, context: Map<string, string>): string {
    const expr = this.interpolate(cfg.condition ?? '', context);
    // 支持简单比较: != '', == 'xxx', contains 'xxx', 非空即 true
    let result = false;
    if (expr.includes('!=')) {
      const [left, right] = expr.split('!=').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
      result = left !== right;
    } else if (expr.includes('==')) {
      const [left, right] = expr.split('==').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
      result = left === right;
    } else if (expr.includes('contains')) {
      const [left, right] = expr.split('contains').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
      result = left.includes(right);
    } else {
      // 非空即 true
      result = expr.trim() !== '' && expr.trim() !== 'false' && expr.trim() !== '0';
    }
    return result ? 'true' : 'false';
  }

  /** 循环节点：遍历列表项，将每项存入 context[loopVariable_item] */
  private async executeLoopNode(cfg: WfNodeConfig, context: Map<string, string>, _timeout: number): Promise<string> {
    const itemsStr = this.interpolate(cfg.loopItems ?? '', context);
    const items = itemsStr.split(',').map((s) => s.trim()).filter(Boolean);
    const varName = cfg.loopVariable ?? 'item';
    const results: string[] = [];
    for (let i = 0; i < items.length; i++) {
      context.set(`${varName}`, items[i]);
      context.set(`${varName}_index`, String(i));
      results.push(items[i]);
    }
    return JSON.stringify(results);
  }

  /** 延时节点 */
  private async executeDelayNode(cfg: WfNodeConfig): Promise<string> {
    const seconds = cfg.delaySeconds ?? 1;
    await new Promise((r) => setTimeout(r, seconds * 1000));
    return `delayed ${seconds}s`;
  }

  /** 子工作流节点：触发另一个工作流并等待完成 */
  private async executeSubflowNode(cfg: WfNodeConfig, context: Map<string, string>): Promise<string> {
    const subId = cfg.subflowId;
    if (!subId) throw new Error('子工作流未配置');
    const inputs: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.subflowInputs ?? {})) inputs[k] = this.interpolate(v, context);
    const r = this.trigger(subId, inputs);
    if (!r.ok) throw new Error(`子工作流触发失败: ${r.message}`);
    // 等待子工作流完成（轮询，最多 5 分钟）
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
      const sub = this.list().find((w) => w.id === subId);
      if (sub && sub.status !== 'running') {
        if (sub.status === 'failed') throw new Error('子工作流执行失败');
        return `subflow ${subId} completed`;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('子工作流执行超时');
  }

  /** AI 模型调用 */
  private async executeAiNode(cfg: WfNodeConfig, context: Map<string, string>, timeout: number): Promise<string> {
    const resolved = this.providerMgr.resolveForAgent(null, cfg.model || null);
    if (!resolved) throw new Error('未配置 LLM 供应商');
    const prompt = this.interpolate(cfg.prompt ?? '', context);
    const res = await fetch(`${resolved.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resolved.key}` },
      body: JSON.stringify({
        model: resolved.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: cfg.temperature ?? 0.7,
        max_tokens: 4096
      }),
      signal: AbortSignal.timeout(timeout),
      redirect: 'error'
    });
    if (!res.ok) throw new Error(`LLM 请求失败: HTTP ${res.status}`);
    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? '';
  }

  /** CLI 命令执行 */
  private executeCliNode(cfg: WfNodeConfig, context: Map<string, string>, timeout: number): Promise<string> {
    const command = this.interpolate(cfg.command ?? '', context);
    const args = (cfg.args ?? []).map((a) => this.interpolate(a, context));
    return this.spawnProcess(command, args, cfg.cwd, timeout);
  }

  /** Python 脚本执行 */
  private executePythonNode(cfg: WfNodeConfig, context: Map<string, string>, timeout: number): Promise<string> {
    const pythonBin = process.platform === 'win32' ? 'python' : 'python3';
    if (cfg.scriptPath) {
      const args = [this.interpolate(cfg.scriptPath, context), ...(cfg.pythonArgs ?? []).map((a) => this.interpolate(a, context))];
      return this.spawnProcess(pythonBin, args, cfg.cwd, timeout);
    }
    // 内联脚本：写入临时执行
    const script = this.interpolate(cfg.script ?? '', context);
    return this.spawnProcess(pythonBin, ['-c', script], cfg.cwd, timeout);
  }

  /** HTTP 请求 */
  private async executeHttpNode(cfg: WfNodeConfig, context: Map<string, string>, timeout: number): Promise<string> {
    const url = this.interpolate(cfg.url ?? '', context);
    const method = cfg.method ?? 'GET';
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.headers ?? {})) headers[k] = this.interpolate(v, context);
    const body = cfg.body ? this.interpolate(cfg.body, context) : undefined;

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: method !== 'GET' ? body : undefined,
      signal: AbortSignal.timeout(timeout),
      redirect: Object.keys(headers).some((key) => key.toLowerCase() === 'authorization') ? 'error' : 'follow'
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    return text;
  }

  /** Coze 工作流调用 */
  private async executeCozeNode(cfg: WfNodeConfig, context: Map<string, string>, timeout: number): Promise<string> {
    const platformId = cfg.platformRef ?? '';
    const meta = this.platformMgr.getMeta(platformId);
    if (!meta) throw new Error('Coze 平台未配置');
    const token = this.platformMgr.decryptToken(platformId);
    if (!token) throw new Error('Coze Token 未配置');

    const workflowId = this.interpolate(cfg.cozeWorkflowId ?? '', context);
    const parameters: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.cozeInputs ?? {})) parameters[k] = this.interpolate(v, context);

    const res = await fetch(`${meta.baseUrl}/v1/workflows/${workflowId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ parameters }),
      signal: AbortSignal.timeout(timeout),
      redirect: 'error'
    });
    const data = await res.json() as { code?: number; msg?: string; data?: string };
    if (data.code !== 0) throw new Error(`Coze 错误 [${data.code}]: ${data.msg ?? '未知'}`);
    return data.data ?? '';
  }

  /** Dify 工作流调用 */
  private async executeDifyNode(cfg: WfNodeConfig, context: Map<string, string>, timeout: number): Promise<string> {
    const platformId = cfg.platformRef ?? '';
    const meta = this.platformMgr.getMeta(platformId);
    if (!meta) throw new Error('Dify 平台未配置');
    const token = this.platformMgr.decryptToken(platformId);
    if (!token) throw new Error('Dify API Key 未配置');

    const inputs: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.difyInputs ?? {})) inputs[k] = this.interpolate(v, context);

    const body: Record<string, unknown> = { inputs, response_mode: 'blocking', user: 'aibox' };
    if (cfg.difyWorkflowId) body.workflow_id = this.interpolate(cfg.difyWorkflowId, context);

    const res = await fetch(`${meta.baseUrl}/v1/workflows/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
      redirect: 'error'
    });
    const data = await res.json() as { data?: { outputs?: Record<string, unknown>; status?: string; error?: string } };
    if (data.data?.status === 'failed') throw new Error(`Dify 执行失败: ${data.data.error ?? '未知'}`);
    return JSON.stringify(data.data?.outputs ?? {});
  }

  // ---------- 工具方法 ----------

  /** 变量插值：{{nodeId.output}} → context 取值 */
  private interpolate(template: string, context: Map<string, string>): string {
    return template.replace(/\{\{(.+?)\}\}/g, (_match, key: string) => {
      const trimmed = key.trim();
      // 支持 "nodeId.output" 和 "nodeId" 两种写法
      const varName = trimmed.endsWith('.output') ? trimmed.slice(0, -7) : trimmed;
      return context.get(varName) ?? context.get(trimmed) ?? '';
    });
  }

  /** 子进程执行 */
  private spawnProcess(command: string, args: string[], cwd: string | undefined, timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        cwd: cwd || undefined,
        shell: process.platform === 'win32',
        timeout,
        env: { ...process.env }
      });
      const stdoutBuffer = createProcessOutputBuffer();
      const stderrBuffer = createProcessOutputBuffer();
      proc.stdout?.on('data', (d: Buffer) => appendProcessOutput(stdoutBuffer, d));
      proc.stderr?.on('data', (d: Buffer) => appendProcessOutput(stderrBuffer, d));
      proc.on('close', (code) => {
        const stdout = finishProcessOutput(stdoutBuffer);
        const stderr = finishProcessOutput(stderrBuffer);
        if (code === 0) resolve(stdout.slice(0, 16000));
        else reject(new Error(`退出码 ${code}: ${stderr.slice(0, 500)}`));
      });
      proc.on('error', (err) => reject(err));
    });
  }

  /** 环检测 */
  private hasCycle(nodes: WfNode[], edges: WfEdge[]): boolean {
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const adj = new Map<string, string[]>();
    for (const n of nodes) adj.set(n.id, []);
    for (const e of edges) adj.get(e.source)?.push(e.target);

    const dfs = (id: string): boolean => {
      if (inStack.has(id)) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      inStack.add(id);
      for (const next of adj.get(id) ?? []) {
        if (dfs(next)) return true;
      }
      inStack.delete(id);
      return false;
    };
    return nodes.some((n) => dfs(n.id));
  }

  /** 广播节点执行事件 */
  private emitNodeEvent(workflowId: string, nodeId: string, status: 'running' | 'completed' | 'failed', output?: string, error?: string) {
    const event: WfNodeEvent = { workflowId, nodeId, status, output, error, timestamp: Date.now() };
    this.broadcastFn?.('aibox:wfNodeEvent', event);
  }
}
