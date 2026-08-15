/**
 * 执行器注册表：主辅引擎策略（P1）。
 * 解析顺序：主引擎（agent.engineId）就绪 → 用主引擎；
 * 否则辅助引擎（user/config.yaml engine.fallbackEngineId，默认 eng-opencode）就绪 → 回退辅助引擎；
 * 两者均不可用时按执行模式分流：production = 返回 null（任务如实 FAILED，绝不伪装完成）；
 * demo = SimulatedExecutor（UI 标注演示模式）。
 * Hermes 与 Pi 使用专属执行器；Codex、Claude Code、OpenCode 使用对应 CLI 适配器；DSH 与自定义引擎走 ACP。
 *
 * @author liyingjie <y@senke.com>
 */
import { NEXUS_ENGINE_ID, type Agent, type ExecutorKind, type Task } from '../../../shared/types.js';
import type { Database } from '../database.js';
import type { ApprovalBroker } from '../approvalBroker.js';
import { LlmApiExecutor } from './llmApiExecutor.js';
import { CliExecutor } from './cliExecutor.js';
import { HermesAgentExecutor } from './hermesAgentExecutor.js';
import { PiAgentExecutor } from './piAgentExecutor.js';
import { AcpExecutor } from './acpExecutor.js';
import { SimulatedExecutor } from './simulatedExecutor.js';
import { loadUserConfig } from '../userConfig.js';
import type { ToolHost } from './tools.js';
import type { ExecutionBinding, ExecutorAdapter, ExecutorCallbacks } from './types.js';
import { PiRuntimeProfileService } from '../piRuntimeProfile.js';
import {
  ANDROID_OPERATOR_ENGINE_ID,
  androidOperatorEngineError,
  androidOperatorRuntimeUnavailableError
} from '../mobileEnginePolicy.js';

interface ResolvedExecutor {
  adapter: ExecutorAdapter;
  engineId: string | null;
  usedFallback: boolean;
}

interface RunningExecutor {
  adapter: ExecutorAdapter;
  agentId: string;
}

export class ExecutorRegistry {
  private llm: LlmApiExecutor;
  private acp: AcpExecutor;
  private sim: SimulatedExecutor;
  /** 真实 Hermes Agent CLI（专属执行器：-z headless + usage-file 会话锚点） */
  private hermes: HermesAgentExecutor;
  private pi: PiAgentExecutor;
  /** 引擎类型 → CLI 执行器 */
  private cliByType = new Map<string, CliExecutor>();
  /** taskId → 正在执行它的适配器（用于 abort） */
  private running = new Map<string, RunningExecutor>();

  constructor(private db: Database, broker: ApprovalBroker, providerMgr?: import('../providerManager.js').ProviderManager) {
    this.llm = new LlmApiExecutor(db, broker, providerMgr);
    this.acp = new AcpExecutor(db, broker);
    this.sim = new SimulatedExecutor();
    this.hermes = new HermesAgentExecutor(db);
    this.pi = new PiAgentExecutor(db, new PiRuntimeProfileService(db, providerMgr));
    this.cliByType.set('codex', new CliExecutor('codex-cli', db, 'eng-codex'));
    this.cliByType.set('claude', new CliExecutor('claude-cli', db, 'eng-claude'));
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

  /** 注入 MCP 管理器，供内置 Nexus Agent 动态发现并调用受限工具。 */
  setMcpManager(manager: import('../mcpManager.js').McpManager) {
    this.llm.setMcpManager(manager);
  }

  setMobileGateway(gateway: import('../mobileGatewayService.js').MobileGatewayService) {
    this.hermes.setMobileGateway(gateway);
  }

  /** Dynamic MCP tools currently run inside the built-in Nexus/LLM tool loop. */
  supportsMcp(engineId: string): boolean {
    return this.engineType(engineId) === 'nexus';
  }

  private engineType(engineId: string): string {
    const row = this.db.raw.prepare('SELECT type FROM engines WHERE id = ?').get(engineId) as { type: string } | undefined;
    return row?.type ?? (engineId === NEXUS_ENGINE_ID ? 'nexus' : '');
  }

  /** 单引擎就绪解析：就绪返回适配器，否则 null（不做任何回退） */
  private adapterFor(engineId: string): ExecutorAdapter | null {
    const type = this.engineType(engineId);
    if (type === 'hermes-cli' && this.hermes.isReady()) return this.hermes;
    if (type === 'pi' && this.pi.isReady()) return this.pi;
    const cli = this.cliByType.get(type);
    if (cli && cli.isReady()) return cli;
    // 内置 Nexus：engines.status 由 detect() 按供应商配置维护（HEALTHY / SETUP_REQUIRED），
    // 与 llm.isReady() 判据同源。此处一并校验状态，避免「引擎页显示待配置、任务却照常派发」
    // 的语义分裂 —— 引擎状态必须是唯一真相来源。
    if (type === 'nexus' && this.engineStatus(engineId) === 'HEALTHY' && this.llm.isReady()) return this.llm;
    if (type === 'external' && this.acp.engineReady(engineId)) return this.acp;
    return null;
  }

  private engineStatus(engineId: string): string {
    const row = this.db.raw.prepare('SELECT status FROM engines WHERE id = ?').get(engineId) as { status: string } | undefined;
    return row?.status ?? 'NOT_INSTALLED';
  }

  /** 主辅解析：主引擎 → 辅助引擎 →（demo 模式）模拟器 / （production 模式）null */
  private resolve(engineId: string, allowFallback = true): ResolvedExecutor | null {
    const primary = this.adapterFor(engineId);
    if (primary) return { adapter: primary, engineId, usedFallback: false };
    if (!allowFallback) return null;
    const cfg = loadUserConfig();
    // 辅助引擎仅在与主引擎不同且就绪时生效（基础设施级回退，业务失败不换引擎）
    if (cfg.engine.fallbackEngineId && cfg.engine.fallbackEngineId !== engineId) {
      const fallback = this.adapterFor(cfg.engine.fallbackEngineId);
      if (fallback) return { adapter: fallback, engineId: cfg.engine.fallbackEngineId, usedFallback: true };
    }
    return cfg.engine.executionMode === 'production' ? null : { adapter: this.sim, engineId: null, usedFallback: true };
  }

  /** 该引擎当前会使用的执行方式（供 UI 标注 真实/演示；production 无可用引擎显示 unavailable） */
  kindFor(engineId: string): ExecutorKind {
    const adapter = this.resolve(engineId);
    if (!adapter) {
      const cfg = loadUserConfig();
      return cfg.engine.executionMode === 'production' ? 'unavailable' : 'simulated';
    }
    return adapter.adapter.kind;
  }

  /** 派发任务执行；production 模式无可用引擎 → 直接回报错误（任务 FAILED，不伪装成功） */
  dispatch(
    task: Task,
    agent: Agent,
    cb: ExecutorCallbacks,
    onResolved?: (binding: ExecutionBinding) => void
  ): ExecutorKind {
    // P1 修复：编码委派优先 —— task.engineOverride 覆盖 agent.engineId
    const targetEngineId = task.engineOverride || agent.engineId;
    const mobileEngineError = androidOperatorEngineError(agent.kind, targetEngineId);
    // A canonical DispatchPlan or explicit task-level override approves one
    // concrete Worker engine. Replacing it here would cross the selected
    // provider/permission boundary. Retries intentionally keep the override
    // while receiving a new task identity.
    const exactEngineBinding = Boolean(task.inputMessageId || task.engineOverride);
    // Android tools are exposed only by the managed Hermes + Mobile Gateway
    // path. Never substitute another healthy executor for a mobile task.
    const resolved = mobileEngineError
      ? null
      : this.resolve(targetEngineId, agent.kind !== 'android_operator' && !exactEngineBinding);
    const binding: ExecutionBinding = resolved
      ? {
          requestedEngineId: targetEngineId,
          resolvedEngineId: resolved.engineId,
          executorKind: resolved.adapter.kind,
          usedFallback: resolved.usedFallback
        }
      : {
          requestedEngineId: targetEngineId,
          resolvedEngineId: null,
          executorKind: 'unavailable',
          usedFallback: false
        };
    // Must run before onError or adapter.start: adapters are allowed to invoke
    // callbacks synchronously, and those callbacks need the actual engine.
    onResolved?.(binding);
    if (!resolved) {
      const message = mobileEngineError
        ?? (agent.kind === 'android_operator' && targetEngineId === ANDROID_OPERATOR_ENGINE_ID
          ? androidOperatorRuntimeUnavailableError()
          : exactEngineBinding
            ? `任务固定的执行引擎不可用：${targetEngineId}（已禁止静默切换到其他引擎）`
            : '无可用执行引擎（production 模式不允许演示回退）：请检查主引擎与辅助引擎的安装/配置状态');
      cb.onError(task.id, message);
      return 'unavailable';
    }
    const { adapter, engineId } = resolved;
    const running: RunningExecutor = { adapter, agentId: agent.id };
    this.running.set(task.id, running);
    const release = (id: string): boolean => {
      if (this.running.get(id) !== running) return false;
      this.running.delete(id);
      return true;
    };
    adapter.start(task, { ...agent, engineId: engineId ?? targetEngineId }, {
      onStage: (id, stage) => cb.onStage(id, stage),
      onProgress: (id, pct) => cb.onProgress(id, pct),
      onOutput: (id, chunk) => cb.onOutput(id, chunk),
      onSession: (id, sessionId) => cb.onSession?.(id, sessionId),
      onReleased: (id) => {
        if (release(id)) cb.onReleased?.(id);
      },
      onDone: (id, result) => {
        if (adapter.kind !== 'acp') release(id);
        cb.onDone(id, result);
      },
      onError: (id, message) => {
        if (adapter.kind !== 'acp') release(id);
        cb.onError(id, message);
      }
    });
    return adapter.kind;
  }

  abort(taskId: string): void {
    const current = this.running.get(taskId);
    current?.adapter.abort(taskId);
    if (current?.adapter.kind !== 'acp' && this.running.get(taskId) === current) {
      this.running.delete(taskId);
    }
  }

  isExecuting(taskId: string): boolean {
    return this.running.has(taskId);
  }

  /** Includes ACP children that have a terminal task state but have not closed yet. */
  activeTaskIdsForAgent(agentId: string): string[] {
    return [...this.running.entries()]
      .filter(([, current]) => current.agentId === agentId)
      .map(([taskId]) => taskId);
  }
}
