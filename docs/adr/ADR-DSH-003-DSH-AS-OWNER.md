# ADR-DSH-003: DSH 作为主 AI 与数字员工组织者

- 状态：Accepted, supersedes the role split in ADR-DSH-001
- 日期：2026-08-17

## 决策

DSH/Cordis 是 OPC-Nexus 产品中的主 AI（用户面对的“老板”）：

- 接收桌面和手机 Web 的主对话
- 负责澄清需求、提出选择题、生成计划和调度
- 维护长任务、Jobs、Goals、Session、Run、事件流和子 Agent 树
- 按计划选择固定数字员工，或创建受预算限制的临时子 Agent
- 汇总员工结果并向用户交付

Nexus 不再提供第二个秘书、业务规划中枢或并列执行内核。原 Nexus 产品能力整体收敛为 DSH/Cordis 的内置核心特色插件 `opc-nexus-governance`：

- 提供项目工作台、员工目录以及 Hermes/Codex/Pi/Claude 等 CLI、ACP、A2A 适配器
- 提供权限/预算/沙箱策略、渠道接入、审计、记忆归档和必要的宿主状态投影
- 通过版本化 Host Contract 请求 safeStorage、文件、进程、网络和原生能力

Electron/Main 中另保留无业务智能的 `aibox-native-host`。它只执行凭据、窗口、设备、网络、数据库、进程隔离和系统资源等特权操作，不具备对话、规划、派工或任务汇总权，因此不构成第二个 Nexus Core。

因此两层的职责不能通过复制代码或再造一套“秘书 UI”来合并。DSH/Cordis 保持核心 AI
能力的单一事实源，AiBox/Nexus 保持本地治理和特色适配能力的单一事实源：

| 平面 | 权威能力 |
|---|---|
| DSH/Cordis 核心 AI | 对话上下文、Quest/问题集、计划版本、root/child Session、Jobs、Goals、Subagent 树、事件时间线、团队拆分和结果汇总 |
| `opc-nexus-governance` Cordis 插件 | 组织/项目、员工目录、渠道、权限/预算/沙箱策略、兼容 TaskStatus 投影、审批、审计、记忆归档、artifact admission、插件目录及 Local CLI/ACP/A2A/MCP/Skill/Vision adapter |
| `aibox-native-host` 薄宿主 | safeStorage/Provider proxy、文件、网络、进程和资源隔离、SQLite、TLS/Origin、native DLL/SO/WASM；无 AI 与调度职责 |

治理插件通过版本化 `opc-dsh-gateway` 做受控命令和只读 projection；它不 fork 或抓取 DSH
Web UI，也不把临时 DSH 子 Agent 自动登记为正式数字员工。桌面 DSH 窗口和 LAN Web
仍由 DSH 提供工作台体验；`opc-nexus-governance` 负责策略与审计，`aibox-native-host` 负责租约和 TLS/Origin 闸门。

## 员工插件合同

每个固定数字员工以 DSH/Cordis manifest 注册；旧 Agent 表只保留治理插件的兼容投影：

```json
{
  "id": "employee.codex",
  "transport": "cli",
  "capabilities": ["coding", "workspace"],
  "concurrency": 1,
  "resourceBudget": { "maxMinutes": 60, "maxTokens": 200000 }
}
```

DSH 负责业务选择；治理插件校验 manifest、权限和资源策略，薄宿主执行进程隔离。适配器通过版本化的 Host Contract 返回事件、结果和 Artifact；任何失败都必须可恢复或明确标记为中断。

### 特色插件与适配器边界

- **Plugin Catalog** 聚合 DSH/Cordis plugin、MCP server、Skill、Local CLI、ACP/A2A
  adapter、Vision 和原生 host adapter；发现、安装、启用、执行、重启和故障是分离状态。
- **Vision/Artifact** 是治理插件与原生宿主的 admission/渲染安全边界：图片、视频、Mermaid、图表和
  Markdown 以受限 `ArtifactRef` 投影给 DSH/Renderer，凭据、宿主路径和任意 URL 不跨边界。
- **Provider proxy** 由 `aibox-native-host` 持有长期密钥并向 DSH 发放短期、可撤销的调用能力；DSH 只
 看到 provider/model 与配额结果。
- **ACP/A2A** 分别用于单会话兼容控制和部门/远程团队边界；治理插件提供 adapter、组织/权限
  校验与审计，DSH 仍决定何时派工和如何汇总结果。
- **Native host adapter** 负责 DLL/SO/WASM/纯 JS fallback 的健康检查与 utility/worker
  隔离；Renderer 永远不能直接加载原生库。

## 迁移顺序

1. DSH 员工 Chat 直接进入 managed DSH root Session；Local CLI 员工暂保留兼容路径。
2. 手机 Web 与桌面 Workbench 使用同一 DSH 会话时间线和事件订阅。
3. Scheduler 由“创建 Nexus Task”逐步迁移为“恢复/触发 DSH Job 或 Run”，Nexus Task 只做宿主投影和审计关联。
4. Hermes/Codex/Pi 适配器接入 DSH plugin registry，逐个替换旧的直接 CLI 分支。
5. 只有在 DSH 长稳恢复、资源限制和插件合同通过后，才收窄旧 Nexus Secretary 路由。

## 不变的安全边界

DSH 作为主 AI 不等于获得宿主 root 权限。文件、进程、网络、密钥、设备和破坏性操作仍必须经过 `opc-nexus-governance` 策略与 `aibox-native-host` 特权闸门；Renderer 和浏览器永远不能读取密钥或直接调用 Node API。
