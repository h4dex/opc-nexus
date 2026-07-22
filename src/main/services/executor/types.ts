/**
 * 执行器适配层（PRD 9.4 ExecutorAdapter）
 * 真实执行路径：
 *  - Hermes 内置引擎 → OpenAI 兼容 API 流式调用（参考 Cherry Studio 供应商直连模式）
 *  - Codex CLI / Claude Code → child_process headless 拉起（shell:false）
 *  - simulated → 演示回退（引擎未就绪时保持界面鲜活，UI 明确标注"演示模式"）
 */
import type { Agent, ExecutorKind, Task } from '../../../shared/types.js';

export interface ExecutorCallbacks {
  /** 阶段切换（理解需求/规划步骤/调用工具/生成产物/校验结果） */
  onStage(taskId: string, stage: string): void;
  /** 进度 0-100（实现侧自行节流，仅在有变化时回调） */
  onProgress(taskId: string, progress: number): void;
  /** 增量输出文本（实现侧自行批量合并后回调） */
  onOutput(taskId: string, chunk: string): void;
  /** 会话锚点（P2b：CLI thread/session id 或自生成，用于追问续跑） */
  onSession?(taskId: string, sessionId: string): void;
  /** 正常完成：result 为产物全文（调用方负责截断落库） */
  onDone(taskId: string, result: string): void;
  /** 失败：message 为真实错误信息（不伪装 COMPLETED） */
  onError(taskId: string, message: string): void;
}

export interface ExecutorAdapter {
  readonly kind: ExecutorKind;
  /** 引擎是否就绪（未就绪时 registry 回退到 simulated） */
  isReady(): boolean;
  start(task: Task, agent: Agent, cb: ExecutorCallbacks): void;
  /** 取消执行：中止网络请求或终止子进程 */
  abort(taskId: string): void;
}
