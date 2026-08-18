# ADR-DSH-002: Cordis 插件运行时与 DSH 执行内核

- 状态：Superseded by ADR-DSH-003（保留为 v1.x 迁移记录）
- 日期：2026-08-17
- 适用版本：OPC-Nexus 1.8.x / managed DSH 0.1.0-rc.6

## 背景

Nexus 当前的编排路径以一次性 `Task -> Executor -> terminal result` 为中心。
这条路径适合短任务和本地 CLI，但不适合长时间运行、进程重启恢复、子 Agent、事件回放和移动端持续观察。
DeepSeek Harness 已经用 `@deepseek-ai/cordis` 提供插件化运行时，并把持久 Session、Run、事件流和 Web 工作台作为一等概念。

## 决策

采用三层架构，按能力逐步迁移。产品交互上的“老板/主 AI”是 DSH，Nexus 不再承担秘书或第二套规划中枢：

```text
Nexus Host / Governance Boundary
  └─ Cordis Plugin Runtime
       └─ DSH Control & Execution Kernel (用户的主 AI)
```

### Cordis Plugin Runtime

Cordis 负责插件生命周期、依赖声明、能力发现和运行时扩展。插件只能通过版本化 Host Contract 申请能力，不能直接写 Nexus SQLite、读取 safeStorage 或修改状态机。

首批插件边界：

- `engine`: Local CLI、DSH managed、未来 A2A 适配器
- `tool`: OCR、Vision、浏览器和受控 MCP 工具
- `skill`: 员工技能和提示模板
- `artifact`: Markdown、Mermaid、图表、图片和音视频制品
- `channel`: 桌面、手机 Web、消息渠道
- `protocol`: ACP、A2A、MCP 适配器

### DSH Control & Execution Kernel

DSH/Cordis 是用户直接对话的主 AI，也是长任务和 Agent 执行的权威运行时：

- 持久 Runtime / Session / Run / Event
- 子 Agent 树、Jobs、Goals 和调度
- 事件游标、恢复、暂停、取消和持续输出
- 官方 DSH Web UI 与手机控制面所需的会话视图
- 根据任务选择固定的 CLI 员工，或创建受预算/权限约束的临时子 Agent
- 维护计划、调度、子 Agent 树和跨员工结果汇总

Nexus 通过固定版本的 `opc-dsh-gateway` 合同提供宿主能力，不抓取 DOM、不读 DSH 私有数据库，也不依赖未稳定的内部类。

### Nexus Host / Governance Boundary

Nexus 不再是用户的主 AI；它保留不可插件化的系统边界和治理权威：

- 员工、组织、角色和工作区归属
- `AgentLifecycle`、`TaskStatus`、审批、预算和 DAG 派工
- Provider 密钥、safeStorage、凭据代理和审计
- 员工目录与 CLI/ACP/A2A 执行适配器的进程隔离
- 资源、预算、权限和最终制品的安全验收
- Electron 生命周期、设备桥接和系统资源保护

DSH 事件由 Nexus 投影为宿主可观测状态；Nexus 不重新规划 DSH 的任务，也不与 DSH 争夺输入控制权。涉及系统安全的执行闸门仍必须由 Nexus Main 进程最终裁决。

### 固定数字员工适配器

Hermes、Codex、Pi、Claude 等固定数字员工以 DSH 插件 manifest 注册：

```text
DSH planner -> employee adapter (CLI / ACP / A2A)
             -> Nexus process + credential boundary
             -> result/event/artifact back to DSH
```

适配器声明 `id`, `transport`, `capabilities`, `health`, `concurrency` 和 `resourceBudget`。
DSH 可以在计划中指定固定员工，也可以选择同一插件提供的临时子 Agent；Nexus 只验证声明、权限和资源，不替 DSH 决定业务分工。

## 长任务迁移规则

1. 新的 DSH 员工默认创建一个持久 root Session；一次用户消息对应一个可恢复 Run，而不是新建并销毁 ACP 子进程。
2. Scheduler 保存 `sessionId/runId/checkpoint/eventCursor`，重启后先恢复 Session，再继续 Run。
3. 旧 CLI 员工继续走兼容路径；无法恢复时标记 `INTERRUPTED`，不得伪报 `COMPLETED`。
4. 复杂任务先由 DSH 主 AI 生成带 hash 的计划和预算；需要系统权限或高风险动作时，Nexus 提供审批闸门后才允许执行。

## 安全与回退

- Managed profile 默认关闭动态 Cordis 代码、远程插件安装和未审核 Shell 能力。
- 插件能力必须有 manifest、版本范围、权限集合和资源预算；缺少合同或能力协商失败时 fail closed。
- DSH、手机 Web 和桌面 Workbench 使用独立会话/租约；关闭窗口不能停止 Runtime。
- DSH 不可用时回退到 Local CLI/ACP，不迁移或泄露长期 Provider Key。

## 不做的事情

- 不把 `@deepseek-ai/cordis` 的未稳定内部 API 直接加入 Electron Renderer。
- 不一次性删除 Nexus 旧 Task 表或 Scheduler；先建立事件投影和恢复路径，再逐步收窄旧入口。
- 不把“DSH 是老板”理解为绕过 Nexus 的权限、审计和资源闸门。

## 验收指标

- 长任务在主进程重启后能从持久 Session/Run 恢复或明确进入 `INTERRUPTED`。
- 桌面、手机 Web 和 DSH Workbench 读取同一 DSH conversation/event timeline；Nexus 只保存必要的宿主投影。
- 插件清单可枚举能力、版本和权限，未授权能力无法被调用。
- 旧 CLI 路径行为和已有安全测试保持不变。
