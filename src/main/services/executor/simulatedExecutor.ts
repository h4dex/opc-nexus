/**
 * 演示执行器（回退路径）：引擎未就绪时以模拟方式推进任务，保持工作台鲜活。
 * UI 对该执行器运行的任务必须标注"演示模式"，不与真实执行混淆（PRD 诚实状态原则）。
 */
import type { Agent, ExecutorKind, Task } from '../../../shared/types.js';
import type { ExecutorAdapter, ExecutorCallbacks } from './types.js';

const STAGES = ['理解需求', '规划步骤', '调用工具', '生成产物', '校验结果'];
const TICK_MS = 2000;

export class SimulatedExecutor implements ExecutorAdapter {
  readonly kind: ExecutorKind = 'simulated';
  private timers = new Map<string, NodeJS.Timeout>();

  /** 演示执行器始终可用（兜底） */
  isReady(): boolean {
    return true;
  }

  start(task: Task, _agent: Agent, cb: ExecutorCallbacks): void {
    let progress = Math.max(5, task.progress);
    const timer = setInterval(() => {
      progress = Math.min(100, progress + 1 + Math.floor(Math.random() * 3));
      cb.onStage(task.id, STAGES[Math.min(STAGES.length - 1, Math.floor(progress / 20))]);
      cb.onProgress(task.id, progress);
      if (progress >= 100) {
        clearInterval(timer);
        this.timers.delete(task.id);
        cb.onDone(
          task.id,
          `## ${task.title}\n\n演示模式产物（未接入真实引擎）。\n\n在「设置 → 模型供应商」完成配置后，新任务将由真实 AI 引擎执行并产出真实结果。`
        );
      }
    }, TICK_MS);
    this.timers.set(task.id, timer);
  }

  abort(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(taskId);
    }
  }
}
