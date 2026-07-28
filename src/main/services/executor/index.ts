/**
 * 执行器注册表：主辅引擎策略（P1）。
 * 解析顺序：主引擎（agent.engineId）就绪 → 用主引擎；
 * 否则辅助引擎（user/config.yaml engine.fallbackEngineId，默认 eng-opencode）就绪 → 回退辅助引擎；
 * 两者均不可用时按执行模式分流：production = 返回 null（任务如实 FAILED，绝不伪装完成）；
 * demo = SimulatedExecutor（UI 标注演示模式）。
 * Codex 使用专属 JSONL 解析；Hermes CLI / OpenCode 走泛化 CLI（参数可配置文件覆写）。
 *
 * @author liyingjie <y@senke.com>
 */
import type { Agent, ExecutorKind, Task } from '../../../shared/types.js';
import type { Database } from '../database.js';
import type { ApprovalBroker } from '../approvalBroker.js';
import { LlmApiExecutor } from './llmApiExecutor.js';
import { CliExecutor } from './cliExecutor.js';
import { HermesAgentExecutor } from './hermesAgentExecutor.js';
import { AcpExecutor } from './acpExecutor.js';
import { SimulatedExecutor } from './simulatedExecutor.js';
import { loadUserConfig } from '../userConfig.js';
import type { ToolHost } from './tools.js';
import type { ExecutorAdapter, ExecutorCallbacks } from './types.js';

export class ExecutorRegistry {
  private llm: LlmApiExecutor;
  private acp: AcpExecutor;
  private sim: SimulatedExecutor;
  /** 真实 Hermes Agent CLI（专属执行器：-z headless + usage-file 会话锚点） */
  private hermes: HermesAgentExecutor;
  /** 引擎类型 → CLI 执行器 */
  private cliByType = new Map<string, CliExecutor>();
  /** taskId → 正在执行它的适配器（用于 abort） */
  private running = new Map<string, ExecutorAdapter>();

  constructor(private db: Database, broker: ApprovalBroker, providerMgr?: import('../providerManager.js').ProviderManager) {
    this.llm = new LlmApiExecutor(db, broker, providerMgr);
    this.acp = new AcpExecutor(db, broker);
    this.sim = new SimulatedExecutor();
    this.hermes = new HermesAgentExecutor(db);
    this.cliByType.set('codex', new CliExecutor('codex-cli', db, 'eng-codex'));
    this.cliByType.set('opencode', new CliExecutor('generic-cli', db, 'eng-opencode', ['run', '{prompt}']));
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

  /** 单引擎就绪解析：就绪返回适配器，否则 null（不做任何回退） */
  private adapterFor(engineId: string): ExecutorAdapter | null {
    const type = this.engineType(engineId);
    if (type === 'hermes-cli' && this.hermes.isReady()) return this.hermes;
    const cli = this.cliByType.get(type);
    if (cli && cli.isReady()) return cli;
    if (type === 'hermes' && this.llm.isReady()) return this.llm;
    if (type === 'external' && this.acp.engineReady(engineId)) return this.acp;
    return null;
  }

  /** 主辅解析：主引擎 → 辅助引擎 →（demo 模式）模拟器 / （production 模式）null */
  private resolve(engineId: string): ExecutorAdapter | null {
    const primary = this.adapterFor(engineId);
    if (primary) return primary;
    const cfg = loadUserConfig();
    // 辅助引擎仅在与主引擎不同且就绪时生效（基础设施级回退，业务失败不换引擎）
    if (cfg.engine.fallbackEngineId && cfg.engine.fallbackEngineId !== engineId) {
      const fallback = this.adapterFor(cfg.engine.fallbackEngineId);
      if (fallback) return fallback;
    }
    return cfg.engine.executionMode === 'production' ? null : this.sim;
  }

  /** 该引擎当前会使用的执行方式（供 UI 标注 真实/演示；production 无可用引擎显示 unavailable） */
  kindFor(engineId: string): ExecutorKind {
    const adapter = this.resolve(engineId);
    if (!adapter) {
      const cfg = loadUserConfig();
      return cfg.engine.executionMode === 'production' ? 'unavailable' : 'simulated';
    }
    return adapter.kind;
  }

  /** 派发任务执行；production 模式无可用引擎 → 直接回报错误（任务 FAILED，不伪装成功） */
  dispatch(task: Task, agent: Agent, cb: ExecutorCallbacks): ExecutorKind {
    // P1 修复：编码委派优先 —— task.engineOverride 覆盖 agent.engineId
    const targetEngineId = task.engineOverride || agent.engineId;
    const adapter = this.resolve(targetEngineId);
    if (!adapter) {
      cb.onError(task.id, '无可用执行引擎（production 模式不允许演示回退）：请检查主引擎与辅助引擎的安装/配置状态');
      return 'unavailable';
    }
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
