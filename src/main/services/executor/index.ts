/**
 * 执行器注册表：按员工所用引擎的就绪状态选择真实执行路径，未就绪回退演示模式。
 * 选择优先级：Hermes→LLM API（已配置供应商） / CLI 引擎→本机 CLI（检测健康） /
 * 外部引擎→ACP 协议（握手健康） / 否则→simulated。
 * Codex/Claude 使用专属 JSONL 解析；ZCode/OpenCode/Kimi Code 走泛化 CLI（参数可配置文件覆写）。
 */
import type { Agent, ExecutorKind, Task } from '../../../shared/types.js';
import type { Database } from '../database.js';
import type { ApprovalBroker } from '../approvalBroker.js';
import { LlmApiExecutor } from './llmApiExecutor.js';
import { CliExecutor } from './cliExecutor.js';
import { AcpExecutor } from './acpExecutor.js';
import { SimulatedExecutor } from './simulatedExecutor.js';
import type { ToolHost } from './tools.js';
import type { ExecutorAdapter, ExecutorCallbacks } from './types.js';

export class ExecutorRegistry {
  private llm: LlmApiExecutor;
  private acp: AcpExecutor;
  private sim: SimulatedExecutor;
  /** 引擎类型 → CLI 执行器 */
  private cliByType = new Map<string, CliExecutor>();
  /** taskId → 正在执行它的适配器（用于 abort） */
  private running = new Map<string, ExecutorAdapter>();

  constructor(private db: Database, broker: ApprovalBroker, providerMgr?: import('../providerManager.js').ProviderManager) {
    this.llm = new LlmApiExecutor(db, broker, providerMgr);
    this.acp = new AcpExecutor(db, broker);
    this.sim = new SimulatedExecutor();
    this.cliByType.set('codex', new CliExecutor('codex-cli', db, 'eng-codex'));
    this.cliByType.set('claude-code', new CliExecutor('claude-cli', db, 'eng-claude'));
    // 真实 Hermes Agent CLI（P0）：非交互运行参数可被配置文件 engines['eng-hermes-cli'].runArgs 覆写
    this.cliByType.set('hermes-cli', new CliExecutor('generic-cli', db, 'eng-hermes-cli', ['run', '{prompt}']));
    this.cliByType.set('zcode', new CliExecutor('generic-cli', db, 'eng-zcode', ['-p', '{prompt}']));
    this.cliByType.set('opencode', new CliExecutor('generic-cli', db, 'eng-opencode', ['run', '{prompt}']));
    this.cliByType.set('kimicode', new CliExecutor('generic-cli', db, 'eng-kimi', ['-p', '{prompt}']));
  }

  /** 注入编排器能力（delegate_task 委派），避免构造期循环依赖 */
  setToolHost(host: ToolHost) {
    this.llm.setToolHost(host);
  }

  /** 注入浏览器管理器（Playwright/CDP 工具使用） */
  setBrowserManager(mgr: import('../browserManager.js').BrowserManager) {
    this.llm.setBrowserManager(mgr);
  }

  /** 注入 OCR 服务（PaddleOCR WASM 工具使用） */
  setOcrService(svc: import('../ocrService.js').OcrService) {
    this.llm.setOcrService(svc);
  }

  private engineType(engineId: string): string {
    const row = this.db.raw.prepare('SELECT type FROM engines WHERE id = ?').get(engineId) as { type: string } | undefined;
    return row?.type ?? 'hermes';
  }

  private resolve(engineId: string): ExecutorAdapter {
    const type = this.engineType(engineId);
    const cli = this.cliByType.get(type);
    if (cli && cli.isReady()) return cli;
    if (type === 'hermes' && this.llm.isReady()) return this.llm;
    if (type === 'external' && this.acp.engineReady(engineId)) return this.acp;
    return this.sim;
  }

  /** 该引擎当前会使用的执行方式（供 UI 标注 真实/演示） */
  kindFor(engineId: string): ExecutorKind {
    return this.resolve(engineId).kind;
  }

  /** 派发任务执行；返回实际使用的执行方式 */
  dispatch(task: Task, agent: Agent, cb: ExecutorCallbacks): ExecutorKind {
    const adapter = this.resolve(agent.engineId);
    this.running.set(task.id, adapter);
    adapter.start(task, agent, {
      onStage: (id, stage) => cb.onStage(id, stage),
      onProgress: (id, pct) => cb.onProgress(id, pct),
      onOutput: (id, chunk) => cb.onOutput(id, chunk),
      onSession: (id, sessionId) => cb.onSession?.(id, sessionId),
      onDone: (id, result) => {
        this.running.delete(id);
        cb.onDone(id, result);
      },
      onError: (id, message) => {
        this.running.delete(id);
        cb.onError(id, message);
      }
    });
    return adapter.kind;
  }

  abort(taskId: string): void {
    this.running.get(taskId)?.abort(taskId);
    this.running.delete(taskId);
  }

  isExecuting(taskId: string): boolean {
    return this.running.has(taskId);
  }
}
