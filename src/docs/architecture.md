# 系统架构设计

## 1. 架构分层

```
┌─────────────────────────────────────────────────────────────┐
│  Renderer（React SPA）                                       │
│  pages / components / store / wizard                         │
├─────────────────────────────────────────────────────────────┤
│  Preload（contextBridge）                                    │
│  window.aibox.* 类型安全封装                                  │
├─────────────────────────────────────────────────────────────┤
│  Main（Electron 主进程）                                     │
│  ipc.ts（白名单） → services/（业务逻辑）                     │
├─────────────────────────────────────────────────────────────┤
│  Shared（纯类型层）                                          │
│  types.ts — 领域模型，无 Node/Electron 依赖                   │
└─────────────────────────────────────────────────────────────┘
```

**依赖方向**: renderer → preload → main → shared（单向，shared 不依赖任何层）

## 2. 四层状态模型

系统采用严格分层的状态模型，四层状态互不混用：

### 2.1 Agent 生命周期（AgentLifecycle）

```
DISABLED → STARTING → READY → STOPPING
                ↘ ERROR ↗
```

### 2.2 任务状态机（TaskStatus）

```
QUEUED → RUNNING → COMPLETED / FAILED / CANCELLED / INTERRUPTED
              ↕
    WAITING_APPROVAL / PAUSED
```

### 2.3 引擎状态（EngineStatus）

```
NOT_INSTALLED → INSTALLING → AUTH_REQUIRED → HEALTHY / DEGRADED / ERROR
                    ↕
              SETUP_REQUIRED
```

### 2.4 渠道状态（ChannelStatus）

```
UNCONFIGURED → CONNECTING → ONLINE / RECONNECTING / AUTH_EXPIRED / DISABLED / ERROR
```

### 2.5 首页派生状态（DerivedAgentStatus）

由编排器计算，互斥优先级：`error > running > paused > starting > idle`

## 3. 核心服务模块

| 服务 | 文件 | 职责 |
|------|------|------|
| Orchestrator | `orchestrator.ts` | Agent/Task 编排、状态机转换、FIFO 调度 |
| Database | `database.ts` | sql.js 持久化、Schema 迁移、审计日志 |
| ExecutorRegistry | `executor/index.ts` | 执行器选择与路由 |
| EngineManager | `engineManager.ts` | 引擎检测/安装/认证/配置 |
| ProviderManager | `providerManager.ts` | 多供应商 CRUD、密钥管理、模型路由 |
| ChannelManager | `channelManager.ts` | 消息渠道生命周期 |
| WorkflowEngine | `workflowEngine.ts` | DAG 工作流调度与执行 |
| TeamEngine | `teamEngine.ts` | 专家团流水线执行 |
| CollabManager | `collabManager.ts` | 多机协同（Git + MCP） |
| McpManager | `mcpManager.ts` | MCP 服务器进程管理与工具调用 |
| SkillManager | `skillManager.ts` | 可复用技能模板管理 |
| Scheduler | `scheduler.ts` | 定时任务扫描与派发 |
| ApprovalBroker | `approvalBroker.ts` | 人工审批挂起/唤醒 |
| ResourceMonitor | `resourceMonitor.ts` | CPU/内存/GPU/磁盘采集与告警 |
| BrowserManager | `browserManager.ts` | Playwright 浏览器自动化 |
| WebServer | `webServer.ts` | 局域网 REST API 管理服务 |
| ApiBridge | `apiBridge.ts` | OpenAI 兼容 API 反向代理 |

## 4. 执行器架构

```
ExecutorRegistry
├── LlmApiExecutor      # OpenAI 兼容 API 直连（Hermes 内置引擎）
├── CliExecutor         # 本机 CLI 引擎（Codex/Claude/ZCode/OpenCode/Kimi）
├── AcpExecutor         # ACP 协议外部引擎
└── SimulatedExecutor   # 演示模拟（无可用引擎时回退）
```

**选择优先级**：
1. Hermes → LLM API（已配置供应商）
2. CLI 引擎 → 本机 CLI（检测健康）
3. 外部引擎 → ACP 协议（握手健康）
4. 否则 → Simulated（演示模式）

## 5. 安全基线

### 5.1 进程隔离

- `contextIsolation: true` + `nodeIntegration: false`（不可关闭）
- Renderer 无法访问 Node.js API
- 外部链接一律 `shell.openExternal`，禁止 BrowserWindow 内导航

### 5.2 IPC 白名单

- 所有 Renderer→Main 通信必须通过 `ipc.ts` 中 `ipcMain.handle` 显式注册
- Channel 命名规范: `aibox:<动作>`
- Preload 只暴露类型安全函数封装，禁止暴露 `ipcRenderer` 本体

### 5.3 密钥管理（safeStorage）

- 密钥绝不进入 Renderer 进程或 localStorage
- 存储路径: `safeStorage.encryptString()` → base64 → SQLite settings 表（key 前缀 `secret:`）
- Renderer 仅可调用各业务域的专用凭据方法；不暴露可选择任意命名空间的通用密钥接口
- 每次密钥操作写入 AuditLog

### 5.4 工作目录安全

- 工作目录必须通过 `pickDirectory` 对话框由用户选择
- 单实例锁防止 SQLite 争用

## 6. 数据持久化

- **引擎**: sql.js（SQLite WASM），零原生编译
- **存储路径**: `userData/aibox-data/aibox.db`
- **持久化策略**: 变更后防抖导出
- **Schema 版本**: 15（自动迁移）
- **数据保留**: 资源样本 7 天、审计日志 90 天

### 核心数据表

| 表名 | 用途 |
|------|------|
| agents | 数字员工配置 |
| tasks | 任务记录 |
| task_events | 任务执行事件（审计） |
| engines | 引擎配置 |
| channels | 渠道配置 |
| schedules | 定时任务 |
| approvals | 审批记录 |
| audit_log | 操作审计日志 |
| settings | 键值设置（含密钥引用） |
| providers | 模型供应商 |
| mcp_servers | MCP 服务器配置 |
| skills / agent_skills | 技能及绑定 |
| workflows | 工作流定义 |
| workflow_runs | 工作流执行历史 |
| teams / team_runs | 专家团及执行记录 |
| collab_workspaces / collab_tasks / collab_agents | 多机协同 |
| conversations / task_messages | 会话与消息 |
| usage_records | Token 用量统计 |
| resource_samples | 资源监控采样 |
| prompt_templates | Prompt 模板 |

## 7. 实时通信机制

| 通道 | 方向 | 用途 |
|------|------|------|
| `aibox:snapshot` | Main → Renderer | 全量状态快照推送 |
| `aibox:taskOutput` | Main → Renderer | 任务输出流式推送 |
| `aibox:resources` | Main → Renderer | 资源监控实时数据 |
| `aibox:wfNodeEvent` | Main → Renderer | 工作流节点执行状态 |

## 8. 权限模型

四级权限模式（`PermissionMode`）：

| 模式 | 说明 |
|------|------|
| `readonly` | 只读，不可写入任何文件 |
| `standard` | 写入需审批 |
| `trusted` | 全信任，无需审批 |
| `autonomous` | 完全自主，无需任何审批 |

能力开关（`AgentCapabilities`）独立于权限模式：

| 能力 | 说明 |
|------|------|
| `network` | HTTP/HTTPS 网络请求 |
| `shell` | 系统命令执行 |
| `install` | 软件包安装 |
| `browser` | 浏览器自动化（Playwright/CDP） |
| `computer` | 桌面操控（Computer Use） |
