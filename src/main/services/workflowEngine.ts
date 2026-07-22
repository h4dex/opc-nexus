/**
 * 任务 DAG 工作流：多步骤任务编排，步骤间可定义依赖关系（有向无环图）。
 * - 无依赖的步骤立即并行启动
 * - 步骤完成后自动检查下游依赖，全部满足则启动
 * - 任一步骤失败 → 工作流标记 failed（下游不再启动）
 * - 支持手动触发 / 定时触发（复用 scheduler）
 */
import { randomUUID } from 'node:crypto';
import type { Database } from './database.js';
import type { Orchestrator } from './orchestrator.js';

export interface WorkflowStep {
  id: string;
  title: string;
  agentId: string;
  instructions: string;
  dependsOn: string[];  // 前置步骤 id 列表
}

export interface Workflow {
  id: string;
  name: string;
  steps: WorkflowStep[];
  status: 'idle' | 'running' | 'completed' | 'failed';
  createdAt: number;
  lastRunAt: number | null;
}

interface WorkflowRow {
  id: string;
  name: string;
  steps_json: string;
  status: string;
  created_at: number;
  last_run_at: number | null;
}

export class WorkflowEngine {
  /** workflowId → { stepId → taskId } 运行中映射 */
  private activeRuns = new Map<string, Map<string, string>>();

  constructor(private db: Database, private orchestrator: Orchestrator) {}

  // ---------- CRUD ----------

  list(): Workflow[] {
    return (this.db.raw.prepare('SELECT * FROM workflows ORDER BY created_at DESC').all() as unknown as WorkflowRow[]).map(this.mapRow);
  }

  create(input: { name: string; steps: WorkflowStep[] }): Workflow {
    const id = `wf-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    this.db.raw.prepare('INSERT INTO workflows(id, name, steps_json, status, created_at, last_run_at) VALUES(?,?,?,?,?,NULL)')
      .run(id, input.name, JSON.stringify(input.steps), 'idle', now);
    return { id, name: input.name, steps: input.steps, status: 'idle', createdAt: now, lastRunAt: null };
  }

  update(id: string, patch: { name?: string; steps?: WorkflowStep[] }) {
    const fields: string[] = [];
    const values: (string | number)[] = [];
    if (patch.name !== undefined) { fields.push('name = ?'); values.push(patch.name); }
    if (patch.steps !== undefined) { fields.push('steps_json = ?'); values.push(JSON.stringify(patch.steps)); }
    if (fields.length === 0) return;
    values.push(id);
    this.db.raw.prepare(`UPDATE workflows SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  remove(id: string) {
    this.db.raw.prepare('DELETE FROM workflows WHERE id = ?').run(id);
    this.activeRuns.delete(id);
  }

  // ---------- DAG 执行 ----------

  /** 触发工作流执行：启动所有无依赖步骤 */
  trigger(workflowId: string): { ok: boolean; message: string } {
    const wf = this.list().find((w) => w.id === workflowId);
    if (!wf) return { ok: false, message: '工作流不存在' };
    if (wf.status === 'running') return { ok: false, message: '工作流正在运行中' };
    if (wf.steps.length === 0) return { ok: false, message: '工作流无步骤' };

    // 校验 DAG 无环
    if (this.hasCycle(wf.steps)) return { ok: false, message: '步骤依赖存在循环，请检查' };

    this.db.raw.prepare("UPDATE workflows SET status = 'running', last_run_at = ? WHERE id = ?").run(Date.now(), workflowId);
    const stepTasks = new Map<string, string>();
    this.activeRuns.set(workflowId, stepTasks);

    // 启动无依赖步骤
    const ready = wf.steps.filter((s) => s.dependsOn.length === 0);
    for (const step of ready) {
      this.startStep(workflowId, wf, step, stepTasks);
    }

    // 监听任务完成事件，驱动下游
    this.watchCompletion(workflowId, wf);

    return { ok: true, message: `工作流「${wf.name}」已触发，${ready.length} 个步骤并行启动` };
  }

  private startStep(workflowId: string, wf: Workflow, step: WorkflowStep, stepTasks: Map<string, string>) {
    try {
      const task = this.orchestrator.createTask(step.agentId, `[${wf.name}] ${step.title}：${step.instructions}`.slice(0, 200));
      stepTasks.set(step.id, task.id);
    } catch {
      // 步骤启动失败 → 工作流失败
      this.db.raw.prepare("UPDATE workflows SET status = 'failed' WHERE id = ?").run(workflowId);
    }
  }

  /** 轮询监听步骤任务终态，驱动下游步骤 */
  private watchCompletion(workflowId: string, wf: Workflow) {
    const stepTasks = this.activeRuns.get(workflowId);
    if (!stepTasks) return;

    const poll = () => {
      const current = this.activeRuns.get(workflowId);
      if (!current) return; // 已清理

      let allDone = true;
      let anyFailed = false;

      for (const [stepId, taskId] of current) {
        const row = this.db.raw.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string } | undefined;
        if (!row) continue;
        if (['RUNNING', 'QUEUED', 'WAITING_APPROVAL', 'PAUSED'].includes(row.status)) {
          allDone = false;
        } else if (['FAILED', 'CANCELLED', 'INTERRUPTED'].includes(row.status)) {
          anyFailed = true;
        }
      }

      if (anyFailed) {
        this.db.raw.prepare("UPDATE workflows SET status = 'failed' WHERE id = ?").run(workflowId);
        this.activeRuns.delete(workflowId);
        return;
      }

      if (allDone && current.size === wf.steps.length) {
        // 全部步骤完成
        this.db.raw.prepare("UPDATE workflows SET status = 'completed' WHERE id = ?").run(workflowId);
        this.activeRuns.delete(workflowId);
        return;
      }

      // 检查是否有新的步骤可以启动（依赖全部完成）
      for (const step of wf.steps) {
        if (current.has(step.id)) continue; // 已启动
        const depsReady = step.dependsOn.every((depId) => {
          const depTaskId = current.get(depId);
          if (!depTaskId) return false;
          const row = this.db.raw.prepare('SELECT status FROM tasks WHERE id = ?').get(depTaskId) as { status: string } | undefined;
          return row?.status === 'COMPLETED';
        });
        if (depsReady) {
          this.startStep(workflowId, wf, step, current);
          allDone = false;
        }
      }

      setTimeout(poll, 3000);
    };

    setTimeout(poll, 3000);
  }

  // ---------- 工具方法 ----------

  private hasCycle(steps: WorkflowStep[]): boolean {
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const adj = new Map<string, string[]>();
    for (const s of steps) adj.set(s.id, s.dependsOn);

    const dfs = (id: string): boolean => {
      if (inStack.has(id)) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      inStack.add(id);
      for (const dep of adj.get(id) ?? []) {
        if (dfs(dep)) return true;
      }
      inStack.delete(id);
      return false;
    };

    return steps.some((s) => dfs(s.id));
  }

  private mapRow(r: WorkflowRow): Workflow {
    let steps: WorkflowStep[] = [];
    try { steps = JSON.parse(r.steps_json) as WorkflowStep[]; } catch { /* 解析失败按空步骤 */ }
    return {
      id: r.id, name: r.name, steps,
      status: r.status as Workflow['status'],
      createdAt: r.created_at, lastRunAt: r.last_run_at
    };
  }
}
