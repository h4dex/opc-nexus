# IPC 接口与 Preload API 参考

## 概述

所有 Renderer → Main 通信通过 `src/main/ipc.ts` 中 `ipcMain.handle` 显式注册。
Renderer 通过 `window.aibox.*` 调用（由 `src/preload/index.ts` 暴露）。

**命名规范**: `aibox:<动作>` 或 `aibox:<模块>:<动作>`

---

## 查询类

| Channel | 参数 | 返回值 | 说明 |
|---------|------|--------|------|
| `aibox:getSnapshot` | 无 | `Snapshot` | 获取全量状态快照 |
| `aibox:getResourceHistory` | 无 | `{ history, health }` | 资源监控历史 |
| `aibox:getSystemInfo` | 无 | `SystemInfo` | 系统信息 |
| `aibox:getAppMemory` | 无 | `AppMemorySnapshot` | Electron Main/Renderer/GPU/Utility 进程内存快照（不含外部 CLI/Playwright 子进程） |

### Snapshot 结构

```typescript
{
  stats: DashboardStats;
  agentCards: AgentCardView[];
  tasks: Task[];
  todos: TodoItem[];
  approvals: Approval[];
  engines: Engine[];
  channels: Channel[];
  schedules: Schedule[];
  executorAvailable: boolean;
}
```

---

## 数字员工

| Channel | 参数 | 返回值 | 说明 |
|---------|------|--------|------|
| `aibox:createAgent` | `CreateAgentInput` | `Agent` | 创建员工 |
| `aibox:startAgent` | `id: string` | `void` | 启用 |
| `aibox:stopAgent` | `id: string` | `void` | 停用 |
| `aibox:updateAgentPersona` | `id, AgentPersonaPatch` | `Agent` | 更新人设 |
| `aibox:generatePersona` | `description: string` | `PersonaResult` | AI 生成人设 |
| `aibox:cloneAgent` | `id, newName` | `Agent` | 克隆 |
| `aibox:exportAgent` | `id: string` | `string` (JSON) | 导出 |
| `aibox:importAgent` | `json: string` | `{ ok, message, agent? }` | 导入 |
| `aibox:batchAgentAction` | `ids[], action` | `{ ok, message }` | 批量操作 |
| `aibox:getAgentDetail` | `agentId: string` | `{ tasks, usage, events }` | 详情 |

### CreateAgentInput

```typescript
{
  name: string;           // 2-30 字符
  role: string;           // 2-500 字符
  systemPrompt: string;
  soulMd?: string;
  agentsMd?: string;
  userMd?: string;
  engineId: string;
  workspace: string;
  permissionMode: PermissionMode;
  concurrencyLimit: number;
  channelIds: string[];
}
```

### AgentPersonaPatch

```typescript
{
  name?: string;
  role?: string;
  systemPrompt?: string;
  soulMd?: string;
  agentsMd?: string;
  userMd?: string;
  permissionMode?: PermissionMode;
  capabilities?: Partial<AgentCapabilities>;
  tags?: string[];
  modelOverrides?: { temperature?; topP?; maxTokens? };
  engineId?: string;
  modelOverride?: string;
}
```

---

## 任务

| Channel | 参数 | 返回值 | 说明 |
|---------|------|--------|------|
| `aibox:createTask` | `agentId, title` | `Task` | 创建任务 |
| `aibox:cancelTask` | `id: string` | `void` | 取消 |
| `aibox:pauseTask` | `id: string` | `void` | 暂停 |
| `aibox:resumeTask` | `id: string` | `void` | 恢复 |
| `aibox:decideApproval` | `id, approve: boolean` | `void` | 审批决策 |
| `aibox:createFollowUpTask` | `parentTaskId, title` | `Task` | 追问/续跑 |
| `aibox:getTaskEvents` | `taskId: string` | `TaskEvent[]` | 事件时间线 |
| `aibox:getTaskResult` | `taskId: string` | `string \| null` | 执行产物 |

---

## 对话

| Channel | 参数 | 返回值 | 说明 |
|---------|------|--------|------|
| `aibox:listConversations` | `agentId: string` | `Conversation[]` | 列出会话 |
| `aibox:chatWithAgent` | `agentId, message, conversationId?` | `Task` | 发送消息 |
| `aibox:renameConversation` | `id, title` | `void` | 重命名 |
| `aibox:deleteConversation` | `id: string` | `void` | 删除 |

---

## 引擎

| Channel | 参数 | 返回值 | 说明 |
|---------|------|--------|------|
| `aibox:installEngine` | `id: string` | `EngineInstallResult` | 安装 |
| `aibox:detectEngines` | 无 | `Engine[]` | 检测 |
| `aibox:getInstallGuide` | `id: string` | `EngineInstallGuide` | 安装指引 |
| `aibox:updateEngine` | `id: string` | `EngineInstallResult` | 更新 |
| `aibox:uninstallEngine` | `id: string` | `EngineInstallResult` | 卸载 |
| `aibox:getEngineLatestVersion` | `id: string` | `string \| null` | 最新版本 |
| `aibox:restartEngine` | `id: string` | `EngineInstallResult` | 重启 |
| `aibox:checkRuntime` | 无 | `RuntimeInfo[]` | 检测运行环境 |
| `aibox:installRuntime` | `name: string` | `EngineInstallResult` | 安装运行环境 |
| `aibox:authEngine` | `id: string` | `{ ok, message }` | 运行最小真实任务验证可用性 |
| `aibox:setDefaultEngine` | `id: string` | `void` | 设为默认 |
| `aibox:getEngineConfig` | `id: string` | `EngineRuntimeConfig \| null` | 获取脱敏运行配置 |
| `aibox:saveEngineConfig` | `id, config` | `{ ok }` | 保存配置 |
| `aibox:getEngineLogs` | `id: string` | `EngineLogEntry[]` | 日志 |
| `aibox:getEngineMetrics` | `id: string` | `EngineMetrics` | 性能指标 |
| `aibox:registerCustomEngine` | `input` | `{ ok, message }` | 注册自定义 |
| `aibox:getEngineRouting` | 无 | `Record<string, string>` | 路由规则 |
| `aibox:saveEngineRouting` | `rules` | `{ ok }` | 保存路由 |

---

## 多供应商

| Channel | 参数 | 返回值 | 说明 |
|---------|------|--------|------|
| `aibox:listProviders` | 无 | `Provider[]` | 列出供应商 |
| `aibox:createProvider` | `input` | `Provider` | 创建 |
| `aibox:updateProvider` | `id, patch` | `void` | 更新 |
| `aibox:removeProvider` | `id: string` | `void` | 删除 |
| `aibox:testProviderById` | `id: string` | `ProviderTestResult` | 测试连接 |
| `aibox:fetchProviderModels` | `id: string` | `{ ok, models, error? }` | 获取模型列表 |

---

## 应用默认模型供应商（兼容接口）

| Channel | 参数 | 返回值 | 说明 |
|---------|------|--------|------|
| `aibox:getProviderConfig` | 无 | `ProviderConfig \| null` | 获取配置 |
| `aibox:saveProviderConfig` | `{ baseUrl, model, apiKey? }` | `ProviderConfig` | 保存配置 |
| `aibox:testProvider` | `override?` | `ProviderTestResult` | 测试连接 |

---

## MCP 服务器

| Channel | 参数 | 返回值 | 说明 |
|---------|------|--------|------|
| `aibox:listMcpServers` | 无 | `McpServerConfig[]` | 列出 |
| `aibox:createMcpServer` | `input` | `McpServerConfig` | 创建 |
| `aibox:removeMcpServer` | `id: string` | `void` | 删除 |
| `aibox:toggleMcpServer` | `id, enabled` | `void` | 开关 |
| `aibox:startMcpServer` | `id: string` | `void` | 启动 |
| `aibox:stopMcpServer` | `id: string` | `void` | 停止 |
| `aibox:getMcpTools` | 无 | `McpTool[]` | 所有工具 |
| `aibox:callMcpTool` | `serverId, toolName, args` | `unknown` | 调用工具 |

---

## Skills

| Channel | 参数 | 返回值 | 说明 |
|---------|------|--------|------|
| `aibox:listSkills` | 无 | `Skill[]` | 列出 |
| `aibox:createSkill` | `input` | `Skill` | 创建 |
| `aibox:updateSkill` | `id, patch` | `void` | 更新 |
| `aibox:removeSkill` | `id: string` | `void` | 删除 |
| `aibox:bindSkill` | `agentId, skillId` | `void` | 绑定 |
| `aibox:unbindSkill` | `agentId, skillId` | `void` | 解绑 |
| `aibox:getAgentSkills` | `agentId: string` | `Skill[]` | 员工技能 |

---

## 工作流

| Channel | 参数 | 返回值 | 说明 |
|---------|------|--------|------|
| `aibox:listWorkflows` | 无 | `WorkflowDef[]` | 列出 |
| `aibox:createWorkflow` | `input` | `WorkflowDef` | 创建 |
| `aibox:updateWorkflow` | `id, patch` | `WorkflowDef` | 更新 |
| `aibox:removeWorkflow` | `id: string` | `void` | 删除 |
| `aibox:triggerWorkflow` | `id, inputs?` | `WfRunRecord` | 触发执行 |
| `aibox:getWorkflowRunState` | `id: string` | `RunState` | 运行状态 |
| `aibox:listWorkflowRuns` | `id: string` | `WfRunRecord[]` | 执行历史 |
| `aibox:publishWorkflowAsSkill` | `id: string` | `{ ok, message }` | 发布为 Skill |
| `aibox:unpublishWorkflowSkill` | `id: string` | `{ ok, message }` | 取消发布 |
| `aibox:exportWorkflow` | `id: string` | `string` (JSON) | 导出 |
| `aibox:importWorkflow` | `json: string` | `{ ok, message }` | 导入 |
| `aibox:validateWorkflow` | `{ nodes, edges }` | `WfValidationResult` | 校验 |
| `aibox:saveWfVariables` | `wfId, variables` | `void` | 保存变量 |

### 外部工作流平台

| Channel | 参数 | 返回值 | 说明 |
|---------|------|--------|------|
| `aibox:listWfPlatforms` | 无 | `WfPlatformConfig[]` | 列出平台 |
| `aibox:saveWfPlatform` | `input` | `WfPlatformConfig` | 保存配置 |
| `aibox:removeWfPlatform` | `id: string` | `void` | 删除 |
| `aibox:testWfPlatform` | `id: string` | `{ ok, error? }` | 测试连接 |

---

## 专家团

| Channel | 参数 | 返回值 | 说明 |
|---------|------|--------|------|
| `aibox:listTeams` | 无 | `Team[]` | 列出 |
| `aibox:createTeam` | `input` | `Team` | 创建 |
| `aibox:updateTeam` | `id, patch` | `Team` | 更新 |
| `aibox:removeTeam` | `id: string` | `void` | 删除 |
| `aibox:triggerTeam` | `id, task` | `TeamRun` | 触发执行 |
| `aibox:getTeamRuns` | `teamId: string` | `TeamRun[]` | 执行历史 |
| `aibox:getTeamConfig` | `teamId: string` | `TeamConfig` | 获取配置 |
| `aibox:saveTeamConfig` | `teamId, config` | `{ ok }` | 保存配置 |
| `aibox:getTeamStats` | `teamId: string` | `TeamStats` | 统计 |
| `aibox:getSubtaskOutput` | `taskId: string` | `string \| null` | 子任务输出 |
| `aibox:saveTeamAsTemplate` | `teamId, name?` | `{ ok }` | 保存模板 |
| `aibox:listTeamTemplates` | 无 | `Template[]` | 模板列表 |
| `aibox:removeTeamTemplate` | `id: string` | `void` | 删除模板 |

---

## 多机协同

| Channel | 参数 | 返回值 | 说明 |
|---------|------|--------|------|
| `aibox:collab:checkGit` | 无 | `RuntimeInfo` | 检测 Git |
| `aibox:collab:installGit` | 无 | `EngineInstallResult` | 安装 Git |
| `aibox:collab:listWorkspaces` | 无 | `CollabWorkspace[]` | 列出工作区 |
| `aibox:collab:createWorkspace` | `input` | `CollabWorkspace` | 创建 |
| `aibox:collab:removeWorkspace` | `id: string` | `void` | 删除 |
| `aibox:collab:startWorkspace` | `id: string` | `void` | 启动 |
| `aibox:collab:stopWorkspace` | `id: string` | `void` | 停止 |
| `aibox:collab:listTasks` | `workspaceId` | `CollabTask[]` | 子任务 |
| `aibox:collab:createTask` | `workspaceId, input` | `CollabTask` | 创建子任务 |
| `aibox:collab:reviewTask` | `taskId, result, comment` | `void` | 验收 |
| `aibox:collab:listAgents` | `workspaceId` | `CollabAgent[]` | 远程 Agent |
| `aibox:collab:getConnectInfo` | `workspaceId` | `CollabConnectInfo` | 连接信息 |
| `aibox:collab:updateRules` | `id, patch` | `void` | 更新规则 |

---

## 定时任务

| Channel | 参数 | 返回值 | 说明 |
|---------|------|--------|------|
| `aibox:createSchedule` | `ScheduleInput` | `Schedule` | 创建 |
| `aibox:toggleSchedule` | `id, enabled` | `void` | 开关 |
| `aibox:deleteSchedule` | `id: string` | `void` | 删除 |
| `aibox:updateSchedule` | `id, patch` | `void` | 更新 |
| `aibox:getScheduleHistory` | `scheduleId` | `Task[]` | 执行历史 |

---

## 渠道

| Channel | 参数 | 返回值 | 说明 |
|---------|------|--------|------|
| `aibox:configureFeishu` | `appId, appSecret` | `{ ok, message }` | 配置飞书 |
| `aibox:configureWecom` | `botId, secret` | `{ ok, message }` | 配置企微 |
| `aibox:startWeixinLogin` | `agentId?: string` | `WeixinLoginState` | 生成微信 iLink 授权二维码并开始轮询；仅在会话最终验证成功后替换渠道绑定，传入员工 ID 时绑定该员工，省略时清除原绑定 |
| `aibox:getWeixinLoginState` | 无 | `WeixinLoginState` | 查询扫码/配对状态（不返回 Token） |
| `aibox:submitWeixinVerifyCode` | `code` | `WeixinLoginState` | 提交手机显示的数字配对码 |
| `aibox:cancelWeixinLogin` | 无 | `void` | 取消尚未提交的扫码会话；`VERIFYING` 阶段会中止远端探测，凭据事务一旦提交则需通过“停用”撤销 |
| `aibox:setupChannel` | `id, accountName` | `void` | 通用设置 |
| `aibox:disconnectChannel` | `id: string` | `void` | 断开 |
| `aibox:bindChannel` | `channelId, agentId` | `void` | 绑定 |
| `aibox:unbindChannel` | `channelId, agentId` | `void` | 解绑 |

`WeixinLoginState.phase` 中，`VERIFY_REQUIRED` 表示等待用户输入手机显示的数字配对码；提交配对码后状态回到 `SCANNED`，由主进程继续二维码状态轮询。`VERIFYING` 表示微信已确认授权，主进程正在通过 `notifyStart` / `getUpdates` 验证新 iLink 会话；此时关闭弹窗会中止尚未完成的探测。探测通过后，凭据与员工绑定在同一事务内提交，随后进入 `CONNECTED`。

---

## API Bridge

| Channel | 参数 | 返回值 | 说明 |
|---------|------|--------|------|
| `aibox:getBridgeStatus` | 无 | `ApiBridgeStatus` | 状态（不含 Key） |
| `aibox:toggleBridge` | `enabled: boolean` | `ApiBridgeStatus` | 开关 |
| `aibox:regenerateBridgeKey` | 无 | `ApiBridgeStatus` | 重新生成 Key（不回传明文） |
| `aibox:copyBridgeKey` | 无 | `{ ok: true }` | 由 Main 进程复制 Key 到剪贴板 |

---

## 用量统计

| Channel | 参数 | 返回值 | 说明 |
|---------|------|--------|------|
| `aibox:getUsageStats` | 无 | `UsageStats` | 基础统计 |
| `aibox:getUsageStatsEnhanced` | `since: number \| null` | `EnhancedStats` | 增强统计 |

---

## Prompt 模板

| Channel | 参数 | 返回值 | 说明 |
|---------|------|--------|------|
| `aibox:listTemplates` | 无 | `Template[]` | 列出 |
| `aibox:createTemplate` | `input` | `Template` | 创建 |
| `aibox:removeTemplate` | `id: string` | `void` | 删除 |

---

## Hermes 同步

| Channel | 参数 | 返回值 | 说明 |
|---------|------|--------|------|
| `aibox:importFromHermes` | 无 | `{ ok, message }` | 导入 |
| `aibox:exportToHermes` | 无 | `{ ok, message }` | 导出 |

---

## 设置与系统

| Channel | 参数 | 返回值 | 说明 |
|---------|------|--------|------|
| `aibox:getSetting` | `key: RendererSettingKey` | 对应设置值或 `null` | 获取 Renderer 设置白名单中的值 |
| `aibox:setSetting` | `key: RendererSettingKey, value` | `void` | 保存经类型与范围校验的 Renderer 设置 |
| `aibox:getAppConfig` | 无 | `AppConfig` | 应用配置 |
| `aibox:setAppConfig` | `patch` | `AppConfig` | 保存配置 |
| `aibox:integrityCheck` | 无 | `{ ok, message }` | 完整性检查 |
| `aibox:manualCleanup` | 无 | `{ ok, message }` | 数据清理 |
| `aibox:getWebAdminStatus` | 无 | `WebAdminStatus` | Web 管理状态（不含 Token） |
| `aibox:regenerateWebToken` | 无 | `WebAdminStatus` | 重新生成 Token（不回传明文） |
| `aibox:copyWebToken` | 无 | `{ ok: true }` | 由 Main 进程复制 Token 到剪贴板 |
| `aibox:pickDirectory` | 无 | `string \| null` | 选择目录 |
| `aibox:toggleFullscreen` | 无 | `boolean` | 全屏切换 |
| `aibox:isFullscreen` | 无 | `boolean` | 全屏状态 |
| `aibox:openExternal` | `url: string` | `void` | 打开外链 |
| `aibox:openTaskWorkspace` | `taskId` | `{ ok, message }` | 打开产物目录 |
| `aibox:openAgentWorkspace` | `agentId` | `{ ok, message }` | 打开工作目录 |

`RendererSettingKey` 仅允许 `theme`、`thresholds`、`notifications`和记忆提案偏好。内部设置、健康状态和 `secret:*` 条目均不可通过 Renderer 或 Web 设置接口访问。

---

## Android 手机控制台

| Channel | 参数 | 返回值 | 说明 |
|---|---|---|---|
| `aibox:mobile:getStatus` | 无 | `MobileGatewayStatus` | 获取 Gateway 状态 |
| `aibox:mobile:listLanAddresses` | 无 | `string[]` | 获取可绑定的局域网 IPv4 |
| `aibox:mobile:startGateway` / `stopGateway` | `host, port?` / 无 | 状态 / `void` | 启停 WSS Gateway |
| `aibox:mobile:createPairing` / `resetCertificate` | 无 | `MobilePairingOffer` / `void` | 创建二维码配对或重置 TLS 身份 |
| `aibox:mobile:getToolCatalog` | 无 | `MobileToolCatalog` | 获取 42 个 Android 工具及 Schema |
| `aibox:mobile:listDevices` | 无 | `MobileDevice[]` | 列出已配对设备 |
| `aibox:mobile:bindAgent` / `unbindAgent` | 绑定输入 / `agentId` | 配置 / `void` | 绑定或解绑 Android 操作员 Agent |
| `aibox:mobile:updateToolPolicy` | Agent 策略输入 | 配置 | 更新 Android 工具白名单 |
| `aibox:mobile:refreshPreview` / `readUiTree` | `deviceId` | URI / UI Tree | 刷新屏幕预览或读取 Accessibility Tree |
| `aibox:mobile:execute` | `{ deviceId, toolName, args }` | `Record<string, unknown>` | 执行已校验的 Android 工具 |
| `aibox:mobile:listCommands` / `listArtifacts` | `deviceId?` | 日志 / 媒体列表 | 查看命令日志和媒体产物 |
| `aibox:mobile:saveScript` / `deleteScript` / `runScript` | 脚本输入 / `id` | 脚本 / `void` / 执行结果 | 控制脚本生命周期 |
| `aibox:mobile:getApkInfo` / `listAdbDevices` | 无 | APK 信息 / ADB 设备列表 | 检测桌面端 APK 和 ADB |
| `aibox:mobile:installApk` / `exportApk` | `serial` / 无 | 结果 | 安装或导出 Bridge APK |
| `aibox:mobile:emergencyStop` | `deviceId` | `void` | 终止设备控制会话 |
| `aibox:mobileEvent` | `MobileEvent` | Main → Renderer | Gateway、设备、命令和媒体事件 |

---

## 实时推送事件（Main → Renderer）

| Channel | 载荷 | 说明 |
|---------|------|------|
| `aibox:snapshot` | `Snapshot` | 全量状态快照 |
| `aibox:taskOutput` | `{ taskId, chunk }` | 任务输出流 |
| `aibox:resources` | `{ history, health }` | 资源监控数据 |
| `aibox:wfNodeEvent` | `WfNodeEvent` | 工作流节点状态 |

---

## 新增 IPC 方法三步走

1. **ipc.ts** 注册 `ipcMain.handle('aibox:xxx', handler)`
2. **preload/index.ts** 暴露封装函数
3. **renderer** 通过 `window.aibox.xxx()` 调用

> 禁止绕过白名单直接暴露 ipcRenderer。
