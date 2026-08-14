# 全部功能模块开发文档

## 目录

1. [数字员工管理](#1-数字员工管理)
2. [任务编排与执行](#2-任务编排与执行)
3. [引擎中心](#3-引擎中心)
4. [多供应商模型路由](#4-多供应商模型路由)
5. [可视化工作流引擎](#5-可视化工作流引擎)
6. [专家团协作](#6-专家团协作)
7. [多机协同](#7-多机协同)
8. [MCP 服务器管理](#8-mcp-服务器管理)
9. [技能管理](#9-技能管理)
10. [消息渠道](#10-消息渠道)
11. [定时任务](#11-定时任务)
12. [人工审批](#12-人工审批)
13. [对话系统](#13-对话系统)
14. [执行监控](#14-执行监控)
15. [资源监控](#15-资源监控)
16. [用量统计](#16-用量统计)
17. [员工市场](#17-员工市场)
18. [浏览器自动化](#18-浏览器自动化)
19. [API Bridge](#19-api-bridge)
20. [局域网 Web 管理服务](#20-局域网-web-管理服务)
21. [虚拟办公室](#21-虚拟办公室)
22. [系统设置](#22-系统设置)

---

## 1. 数字员工管理

**服务文件**: `src/main/services/orchestrator.ts`
**前端页面**: `src/renderer/src/pages/Agents.tsx`

### 1.1 功能概述

数字员工（Agent）是系统的核心实体，代表一个可独立执行任务的 AI 助手。每个员工拥有独立的人设配置、权限模式、能力开关和执行引擎绑定。

### 1.2 核心能力

- **创建/编辑/归档**: 通过创建向导或 API 创建员工，支持完整的人设配置
- **人设三文件**: `soul.md`（身份性格）、`agents.md`（行为指令）、`user.md`（用户画像）
- **AI 辅助生成人设**: 调用 LLM 根据描述自动生成人设配置
- **生命周期管理**: DISABLED → STARTING → READY → STOPPING
- **权限模式**: readonly / standard / trusted / autonomous
- **能力开关**: network / shell / install / browser / computer
- **标签分组**: 支持按组分类管理
- **模型覆盖**: 每个员工可独立设置 temperature/topP/maxTokens 和模型名
- **克隆/导入/导出**: 支持 JSON 格式的员工配置导入导出
- **批量操作**: 批量启用/停用/删除

### 1.3 数据模型

```typescript
interface Agent {
  id: string;
  name: string;
  role: string;              // 职责描述
  systemPrompt: string;
  soulMd: string;            // 身份/性格/语气
  agentsMd: string;          // 行为指令/约束
  userMd: string;            // 用户画像
  lifecycle: AgentLifecycle;
  engineId: string;
  workspace: string;
  permissionMode: PermissionMode;
  capabilities: AgentCapabilities;
  tags: string[];
  modelOverrides?: { temperature?: number; topP?: number; maxTokens?: number };
  modelOverride?: string;
  concurrencyLimit: number;
  archived: boolean;
  avatarColor: string;
}
```

### 1.4 IPC 接口

| Channel | 说明 |
|---------|------|
| `aibox:createAgent` | 创建数字员工 |
| `aibox:startAgent` | 启用员工 |
| `aibox:stopAgent` | 停用员工 |
| `aibox:updateAgentPersona` | 更新人设配置 |
| `aibox:generatePersona` | AI 生成人设 |
| `aibox:cloneAgent` | 克隆员工 |
| `aibox:exportAgent` | 导出为 JSON |
| `aibox:importAgent` | 从 JSON 导入 |
| `aibox:batchAgentAction` | 批量操作 |
| `aibox:getAgentDetail` | 获取员工详情（任务/用量/事件） |

---

## 2. 任务编排与执行

**服务文件**: `src/main/services/orchestrator.ts`, `src/main/services/executor/`
**前端页面**: `src/renderer/src/pages/Tasks.tsx`

### 2.1 功能概述

任务（Task）是数字员工执行工作的基本单元。编排器负责 FIFO 队列调度、并发控制、状态机转换和崩溃恢复。

### 2.2 核心能力

- **任务创建**: 手动创建、定时触发、渠道消息触发、委派（A2A）、团队分派
- **FIFO 调度**: 固定并发数，按优先级和创建时间排序
- **状态机**: QUEUED → RUNNING → COMPLETED/FAILED/CANCELLED/INTERRUPTED
- **暂停/恢复**: 运行中任务可暂停和恢复
- **追问/续跑**: 新任务继承父任务的会话锚点（sessionId）
- **任务事件时间线**: 完整记录执行过程（started/progress/output/result/completed/failed）
- **流式输出**: 执行输出实时推送到前端逐字显示
- **崩溃恢复**: 启动时扫描 RUNNING 记录，标记为 INTERRUPTED
- **调度保护**: 资源监控超限时阻止新任务派发
- **委派深度限制**: 最大 10 层防止无限递归

### 2.3 任务来源（TaskSource）

| 来源 | 说明 |
|------|------|
| `desktop` | 桌面端手动创建 |
| `channel` | 消息渠道触发 |
| `schedule` | 定时任务触发 |
| `webhook` | Webhook 触发 |
| `delegated` | A2A 委派 |
| `team` | 专家团分派 |

### 2.4 执行器类型

| 类型 | 说明 |
|------|------|
| `llm-api` | OpenAI 兼容 API 直连（支持工具调用） |
| `codex-cli` | Codex CLI 引擎 |
| `claude-cli` | Claude Code CLI |
| `generic-cli` | 泛化 CLI（ZCode/OpenCode/Kimi） |
| `acp` | ACP 协议外部引擎 |
| `simulated` | 演示模拟 |

### 2.5 IPC 接口

| Channel | 说明 |
|---------|------|
| `aibox:createTask` | 创建任务 |
| `aibox:cancelTask` | 取消任务 |
| `aibox:pauseTask` | 暂停任务 |
| `aibox:resumeTask` | 恢复任务 |
| `aibox:createFollowUpTask` | 追问/续跑 |
| `aibox:getTaskEvents` | 获取事件时间线 |
| `aibox:getTaskResult` | 获取执行产物 |
| `aibox:decideApproval` | 审批决策 |

---

## 3. 引擎中心

**服务文件**: `src/main/services/engineManager.ts`
**前端页面**: `src/renderer/src/pages/Engines.tsx`

### 3.1 功能概述

引擎中心管理所有 AI 执行引擎的安装、检测、认证和配置。支持 7 种引擎类型。

### 3.2 支持的引擎

| 引擎 | 类型标识 | 说明 |
|------|----------|------|
| Hermes | `hermes` | 内置 LLM API 引擎（需配置供应商） |
| Codex | `codex` | OpenAI Codex CLI |
| Claude Code | `claude-code` | Anthropic Claude Code CLI |
| ZCode | `zcode` | 智谱 ZCode CLI |
| OpenCode | `opencode` | OpenCode CLI |
| Kimi Code | `kimicode` | Moonshot Kimi Code CLI |
| 外部引擎 | `external` | ACP 协议自定义引擎 |

### 3.3 核心能力

- **自动检测**: 扫描系统 PATH 检测已安装引擎
- **一键安装**: npm -g 自动安装（下载地址可配置）
- **版本管理**: 检测当前版本、查询最新版本、一键更新
- **卸载**: 安全卸载引擎
- **认证管理**: 标记认证状态
- **默认引擎**: 设置全局默认引擎
- **运行配置**: runArgs / env / maxConcurrency
- **性能指标**: avgLatencyMs / successRate / totalRuns
- **日志查看**: 引擎运行日志
- **自定义引擎注册**: 通过 ACP 命令注册外部引擎
- **引擎路由规则**: 按条件路由到不同引擎
- **Runtime 检测**: Node.js / Python / Git 运行环境检测与安装

### 3.4 IPC 接口

| Channel | 说明 |
|---------|------|
| `aibox:installEngine` | 安装引擎 |
| `aibox:detectEngines` | 重新检测 |
| `aibox:updateEngine` | 更新引擎 |
| `aibox:uninstallEngine` | 卸载引擎 |
| `aibox:restartEngine` | 重启引擎 |
| `aibox:setDefaultEngine` | 设为默认 |
| `aibox:getEngineConfig` | 获取配置 |
| `aibox:saveEngineConfig` | 保存配置 |
| `aibox:getEngineLogs` | 查看日志 |
| `aibox:getEngineMetrics` | 性能指标 |
| `aibox:registerCustomEngine` | 注册自定义引擎 |
| `aibox:checkRuntime` | 检测运行环境 |
| `aibox:installRuntime` | 安装运行环境 |

---

## 4. 多供应商模型路由

**服务文件**: `src/main/services/providerManager.ts`
**前端页面**: `src/renderer/src/pages/Settings.tsx`（供应商配置区域）

### 4.1 功能概述

支持添加多个 OpenAI 兼容 API 供应商（DeepSeek/OpenAI/Moonshot/Ollama 等），每个助手可独立选择供应商和模型。

### 4.2 核心能力

- **多供应商 CRUD**: 添加/编辑/删除供应商
- **默认供应商**: 全局默认，未指定时使用
- **按员工路由**: 每个员工可绑定独立供应商 + 模型覆盖
- **API Key 安全存储**: safeStorage 加密，Renderer 仅见脱敏视图
- **连接测试**: 按 ID 取密钥测试连通性
- **模型列表获取**: 从供应商 API 获取可用模型列表

### 4.3 数据模型

```typescript
interface Provider {
  id: string;
  name: string;
  baseUrl: string;      // OpenAI 兼容 API 地址
  model: string;        // 默认模型
  isDefault: boolean;
  hasKey: boolean;      // 脱敏：仅显示是否已配置
  createdAt: number;
}
```

### 4.4 IPC 接口

| Channel | 说明 |
|---------|------|
| `aibox:listProviders` | 列出所有供应商 |
| `aibox:createProvider` | 创建供应商 |
| `aibox:updateProvider` | 更新供应商 |
| `aibox:removeProvider` | 删除供应商 |
| `aibox:testProviderById` | 按 ID 测试连接 |
| `aibox:fetchProviderModels` | 获取模型列表 |

---

## 5. 可视化工作流引擎

**服务文件**: `src/main/services/workflowEngine.ts`, `src/main/services/wfPlatformManager.ts`
**前端页面**: `src/renderer/src/pages/Workflows.tsx`

### 5.1 功能概述

基于 DAG（有向无环图）的可视化工作流编排引擎，支持拖拽式节点编辑、变量插值、条件分支、循环和子工作流。

### 5.2 节点类型

| 类型 | 说明 |
|------|------|
| `start` | 起始节点 |
| `end` | 结束节点 |
| `ai` | AI 模型调用（Prompt + 模型选择） |
| `cli` | CLI 命令执行 |
| `python` | Python 脚本执行 |
| `http` | HTTP 请求 |
| `coze` | Coze 工作流调用 |
| `dify` | Dify 工作流调用 |
| `condition` | 条件分支 |
| `loop` | 循环 |
| `delay` | 延时 |
| `subflow` | 子工作流 |

### 5.3 核心能力

- **DAG 拓扑调度**: 无入边节点并行启动，下游依赖满足后自动触发
- **变量插值**: `{{nodeId.output}}` 从上游节点输出取值
- **全局变量**: 工作流级别变量定义与默认值
- **实时状态广播**: 节点执行状态实时推送到前端（变色显示）
- **执行历史**: 完整记录每次运行的节点结果
- **发布为 Skill**: 工作流可发布为技能供数字员工引用
- **导入/导出**: JSON 格式工作流导入导出
- **校验**: 结构校验（无环检测、必要配置检查）
- **错误处理**: 重试次数/间隔、降级目标节点
- **版本管理**: 工作流版本号

### 5.4 外部工作流平台（Coze / Dify）

- 平台凭据配置（Token 走 safeStorage）
- 连接测试
- 作为工作流节点调用

### 5.5 IPC 接口

| Channel | 说明 |
|---------|------|
| `aibox:listWorkflows` | 列出工作流 |
| `aibox:createWorkflow` | 创建工作流 |
| `aibox:updateWorkflow` | 更新工作流 |
| `aibox:removeWorkflow` | 删除工作流 |
| `aibox:triggerWorkflow` | 触发执行 |
| `aibox:getWorkflowRunState` | 获取运行状态 |
| `aibox:listWorkflowRuns` | 执行历史 |
| `aibox:publishWorkflowAsSkill` | 发布为 Skill |
| `aibox:exportWorkflow` | 导出 |
| `aibox:importWorkflow` | 导入 |
| `aibox:validateWorkflow` | 校验 |
| `aibox:saveWfVariables` | 保存全局变量 |
| `aibox:listWfPlatforms` | 列出外部平台 |
| `aibox:saveWfPlatform` | 保存平台配置 |
| `aibox:testWfPlatform` | 测试平台连接 |

---

## 6. 专家团协作

**服务文件**: `src/main/services/teamEngine.ts`
**前端页面**: `src/renderer/src/pages/Teams.tsx`

### 6.1 功能概述

专家团执行引擎支持多个数字员工组成团队，以流水线方式协作完成复杂任务。

### 6.2 协作模式

| 模式 | 说明 |
|------|------|
| `coordinate` | 主专家协调：拆解任务 → 分派子任务 → 验收综合 |
| `roundtable` | 专家圆桌：各专家依次发表观点 → 协调者总结 |

### 6.3 核心能力

- **团队 CRUD**: 创建/编辑/删除团队（协调者 + 成员）
- **流水线执行**: clarify → decompose → execute → review → done
- **共享工作空间**: MD 交接协议（OUTLINE.md + handoffs/ + PROGRESS.md）
- **子任务追踪**: 每个子任务独立状态（pending/running/done/failed）
- **执行历史**: 完整记录每次团队执行
- **团队配置**: 超时/重试/并行度
- **统计信息**: 成功率、平均耗时
- **模板系统**: 保存为预设模板，一键组建团队
- **子任务输出查看**: 查看每个子任务的执行输出

### 6.4 IPC 接口

| Channel | 说明 |
|---------|------|
| `aibox:listTeams` | 列出团队 |
| `aibox:createTeam` | 创建团队 |
| `aibox:updateTeam` | 更新团队 |
| `aibox:removeTeam` | 删除团队 |
| `aibox:triggerTeam` | 触发执行 |
| `aibox:getTeamRuns` | 执行历史 |
| `aibox:getTeamConfig` | 获取配置 |
| `aibox:saveTeamConfig` | 保存配置 |
| `aibox:getTeamStats` | 统计信息 |
| `aibox:getSubtaskOutput` | 子任务输出 |
| `aibox:saveTeamAsTemplate` | 保存为模板 |
| `aibox:listTeamTemplates` | 模板列表 |

---

## 7. 多机协同

**服务文件**: `src/main/services/collabManager.ts`, `gitHttpServer.ts`, `mcpCollabServer.ts`
**前端页面**: `src/renderer/src/pages/Collab.tsx`

### 7.1 功能概述

支持多台机器上的 AI Agent 通过 Git + MCP 协议协同工作，实现分布式任务执行。

### 7.2 核心能力

- **工作区管理**: 创建协同工作区（初始化 bare repo + 生成邀请 Token）
- **子任务管理**: 创建/分配/状态流转（pending → claimed → in_progress → submitted → accepted/rejected）
- **远程 Agent 注册**: 远程 Agent 通过 MCP 连接注册
- **心跳检测**: 60 秒无心跳视为离线
- **验收流程**: 主 Agent 对提交的任务执行 review
- **Git 操作封装**: init bare repo、创建分支、merge、查看 diff
- **连接信息**: 提供 MCP URL + Git URL + Token 供远程配置

### 7.3 数据模型

```typescript
interface CollabWorkspace {
  id: string;
  name: string;
  repoPath: string;
  conventions: string;    // 编码规范
  gitRules: string;       // Git 规则
  mcpPort: number;
  gitPort: number;
  status: 'idle' | 'active' | 'stopped';
}
```

### 7.4 IPC 接口

| Channel | 说明 |
|---------|------|
| `aibox:collab:checkGit` | 检测 Git 环境 |
| `aibox:collab:listWorkspaces` | 列出工作区 |
| `aibox:collab:createWorkspace` | 创建工作区 |
| `aibox:collab:startWorkspace` | 启动工作区 |
| `aibox:collab:stopWorkspace` | 停止工作区 |
| `aibox:collab:listTasks` | 列出子任务 |
| `aibox:collab:createTask` | 创建子任务 |
| `aibox:collab:reviewTask` | 验收任务 |
| `aibox:collab:listAgents` | 列出远程 Agent |
| `aibox:collab:getConnectInfo` | 获取连接信息 |

---

## 8. MCP 服务器管理

**服务文件**: `src/main/services/mcpManager.ts`
**前端页面**: `src/renderer/src/pages/Mcp.tsx`

### 8.1 功能概述

管理 Model Context Protocol 服务器，为数字员工提供外部工具能力扩展。

### 8.2 核心能力

- **服务器 CRUD**: 添加/删除 MCP 服务器配置
- **进程管理**: spawn stdio 子进程，JSON-RPC 2.0 通信
- **工具发现**: initialize → tools/list 获取工具列表
- **工具执行**: tools/call 调用指定工具
- **启用/禁用**: 按需开关服务器
- **作用域**: global（全局）或按助手绑定
- **Hermes 同步**: 从 ~/.hermes/ 导入/导出 MCP 配置

### 8.3 IPC 接口

| Channel | 说明 |
|---------|------|
| `aibox:listMcpServers` | 列出服务器 |
| `aibox:createMcpServer` | 创建服务器 |
| `aibox:removeMcpServer` | 删除服务器 |
| `aibox:toggleMcpServer` | 启用/禁用 |
| `aibox:startMcpServer` | 启动服务器 |
| `aibox:stopMcpServer` | 停止服务器 |
| `aibox:getMcpTools` | 获取所有工具 |
| `aibox:callMcpTool` | 调用工具 |

---

## 9. 技能管理

**服务文件**: `src/main/services/skillManager.ts`
**前端页面**: `src/renderer/src/pages/Skills.tsx`

### 9.1 功能概述

Skills 是可复用的指令模板（Markdown），按助手绑定后注入 system prompt，增强员工能力。

### 9.2 核心能力

- **技能 CRUD**: 创建/编辑/删除技能
- **绑定/解绑**: 将技能绑定到指定员工
- **启用/禁用**: 按需开关技能
- **Hermes 同步**: 从 ~/.hermes/skills/ 导入
- **工作流发布**: 工作流可发布为技能

### 9.3 IPC 接口

| Channel | 说明 |
|---------|------|
| `aibox:listSkills` | 列出技能 |
| `aibox:createSkill` | 创建技能 |
| `aibox:updateSkill` | 更新技能 |
| `aibox:removeSkill` | 删除技能 |
| `aibox:bindSkill` | 绑定到员工 |
| `aibox:unbindSkill` | 解绑 |
| `aibox:getAgentSkills` | 获取员工技能 |

---

## 10. 消息渠道

**服务文件**: `src/main/services/channelManager.ts`, `channels/`
**前端页面**: `src/renderer/src/pages/Channels.tsx`

### 10.1 功能概述

连接外部消息平台，使数字员工可通过即时通讯接收和回复消息。

### 10.2 支持的渠道

| 渠道 | 接入方式 | 说明 |
|------|----------|------|
| 飞书 | 官方 SDK 长连接 | AppID + AppSecret |
| 企业微信 | 官方长连接 API | BotID + Secret |
| 微信 iLink Bot | 腾讯 ClawBot HTTP 长轮询 | 微信扫码授权（Token 仅进 safeStorage） |

### 10.3 核心能力

- **凭据配置**: 密钥走 safeStorage 加密存储
- **连接管理**: 连接/断开/重连
- **Agent 绑定**: 将渠道绑定到指定员工
- **消息路由**: 收到消息自动创建任务派发给绑定员工
- **ASR 语音**: 企微渠道支持语音消息识别
- **文件收发**: 支持文件类型消息

### 10.4 IPC 接口

| Channel | 说明 |
|---------|------|
| `aibox:configureFeishu` | 配置飞书 |
| `aibox:configureWecom` | 配置企微 |
| `aibox:startWeixinLogin` / `getWeixinLoginState` | 微信 iLink 扫码连接与状态查询 |
| `aibox:submitWeixinVerifyCode` / `cancelWeixinLogin` | 微信配对码提交与扫码取消 |
| `aibox:setupChannel` | 通用渠道设置 |
| `aibox:disconnectChannel` | 断开渠道 |
| `aibox:bindChannel` | 绑定员工 |
| `aibox:unbindChannel` | 解绑员工 |

---

## 11. 定时任务

**服务文件**: `src/main/services/scheduler.ts`
**前端页面**: `src/renderer/src/pages/Schedules.tsx`

### 11.1 功能概述

定时任务调度器，每 30 秒扫描 schedules 表，到期自动创建任务并派发。

### 11.2 调度类型

| 类型 | cronValue 格式 | 说明 |
|------|----------------|------|
| `interval` | 小时数 | 每 N 小时执行 |
| `daily` | "HH:mm" | 每天定时执行 |
| `weekly` | "星期(0-6)\|HH:mm" | 每周定时执行 |
| `monthly` | "日(1-28)\|HH:mm" | 每月定时执行 |

### 11.3 核心能力

- **CRUD**: 创建/编辑/删除/启用/禁用
- **自动补跑**: 启动时对过期项立即补跑一次
- **执行历史**: 记录每次触发的任务
- **岗位分组**: 按员工分组展示

### 11.4 IPC 接口

| Channel | 说明 |
|---------|------|
| `aibox:createSchedule` | 创建定时任务 |
| `aibox:toggleSchedule` | 启用/禁用 |
| `aibox:deleteSchedule` | 删除 |
| `aibox:updateSchedule` | 更新 |
| `aibox:getScheduleHistory` | 执行历史 |

---

## 12. 人工审批

**服务文件**: `src/main/services/approvalBroker.ts`
**前端页面**: `src/renderer/src/pages/Tasks.tsx`（审批区域）

### 12.1 功能概述

当数字员工执行需要人工确认的操作时，系统自动挂起任务并发起审批请求。

### 12.2 审批类型

| 类型 | 说明 |
|------|------|
| `write_workspace` | 写入工作区文件 |
| `outside_workspace` | 操作工作区外文件 |
| `delete` | 删除操作 |
| `network` | 网络请求 |
| `install` | 安装软件包 |
| `admin` | 管理员操作 |

### 12.3 风险等级

`low` / `medium` / `high`

### 12.4 工作流程

1. 执行器触发权限请求
2. ApprovalBroker 写入 approvals 表
3. 任务状态转为 `WAITING_APPROVAL`
4. 前端展示审批卡片
5. 用户批准/拒绝
6. 唤醒执行器继续/终止

---

## 13. 对话系统

**服务文件**: `src/main/services/orchestrator.ts`
**前端页面**: `src/renderer/src/pages/Chat.tsx`

### 13.1 功能概述

支持与数字员工进行持续多轮对话，上下文跨任务保持。

### 13.2 核心能力

- **多轮对话**: 每个助手支持多个会话
- **会话管理**: 创建/重命名/删除会话
- **上下文继承**: 追问时继承会话锚点
- **流式响应**: 实时输出 AI 回复

### 13.3 IPC 接口

| Channel | 说明 |
|---------|------|
| `aibox:listConversations` | 列出会话 |
| `aibox:chatWithAgent` | 发送消息 |
| `aibox:renameConversation` | 重命名会话 |
| `aibox:deleteConversation` | 删除会话 |

---

## 14. 执行监控

**服务文件**: `src/main/services/orchestrator.ts`
**前端页面**: `src/renderer/src/pages/Console.tsx`

### 14.1 功能概述

实时展示任务执行过程，包括工具调用轨迹、输出流和审批状态。

### 14.2 核心能力

- **实时输出流**: 逐字显示执行输出
- **工具调用轨迹**: 展示每次工具调用的名称、参数和结果
- **事件时间线**: 完整的执行事件记录
- **产物查看**: 查看任务执行产物全文
- **工作目录打开**: 一键打开任务产物目录

### 14.3 执行事件类型

| 事件 | 说明 |
|------|------|
| `started` | 任务开始 |
| `message_delta` | 消息增量 |
| `tool_call` | 工具调用 |
| `tool_result` | 工具结果 |
| `approval_required` | 需要审批 |
| `progress` | 进度更新 |
| `artifact` | 产物生成 |
| `usage` | Token 用量 |
| `completed` | 完成 |
| `failed` | 失败 |
| `cancelled` | 取消 |
| `heartbeat` | 心跳 |

---

## 15. 资源监控

**服务文件**: `src/main/services/resourceMonitor.ts`
**前端页面**: `src/renderer/src/pages/System.tsx`

### 15.1 功能概述

跨平台系统资源采集与告警，支持 Windows（WMI）和 Linux（/proc、sysfs）。

### 15.2 监控指标

| 指标 | 说明 |
|------|------|
| CPU | 总利用率 %、核心数 |
| 内存 | 已用/总量/百分比 |
| GPU | 名称/利用率/显存/温度（NVIDIA） |
| 磁盘 | 数据目录剩余/总量 |
| 网络 | 在线状态 |

### 15.3 核心能力

- **实时采集**: 每 2 秒采样一次
- **历史图表**: 内存保留最近 300 条（10 分钟）
- **持久化**: 每 30 秒写入数据库，保留 7 天
- **阈值告警**: CPU/内存持续超限 5 分钟触发告警
- **磁盘告警**: 剩余 < 10GB 警告，< 2GB 阻止
- **调度保护**: 资源超限自动阻止新任务派发
- **服务健康**: runtime / gateway / database 三维度

---

## 16. 用量统计

**前端页面**: `src/renderer/src/pages/Usage.tsx`

### 16.1 功能概述

统计 Token 消耗和模型调用情况。

### 16.2 核心能力

- **总量统计**: input/output/total tokens
- **按模型统计**: 每个模型的调用次数和 Token 消耗
- **按员工统计**: 每个员工的 Token 消耗
- **7 日趋势**: 每日 Token 使用趋势图
- **最近记录**: 最近 50 条调用明细
- **时间筛选**: 按时间范围过滤

### 16.3 IPC 接口

| Channel | 说明 |
|---------|------|
| `aibox:getUsageStats` | 基础统计 |
| `aibox:getUsageStatsEnhanced` | 增强统计（支持时间筛选） |

---

## 17. 员工市场

**前端页面**: `src/renderer/src/pages/Market.tsx`
**数据文件**: `src/renderer/src/data/marketRoles.ts`

### 17.1 功能概述

预设岗位模板市场，一键创建特定角色的数字员工。

### 17.2 核心能力

- **岗位模板**: 预设多种行业/职能角色模板
- **一键创建**: 从模板快速创建数字员工
- **分类浏览**: 按行业/职能分类

---

## 18. 浏览器自动化

**服务文件**: `src/main/services/browserManager.ts`

### 18.1 功能概述

基于 Playwright + CDP 的浏览器自动化能力，为数字员工提供网页操作能力。

### 18.2 核心能力

- **按需启动**: headless Chromium 实例
- **Agent 隔离**: 每个 agent 独立浏览器上下文（隔离 cookie/storage）
- **CDP 直连**: 支持连接已有 Chrome（--remote-debugging-port）
- **页面操作原语**: 导航、点击、输入、截图、JS 执行、等待
- **空闲回收**: 5 分钟无操作自动关闭释放资源

### 18.3 工具列表

| 工具 | 说明 |
|------|------|
| `browser_navigate` | 导航到 URL |
| `browser_click` | 点击元素 |
| `browser_type` | 输入文本 |
| `browser_screenshot` | 页面截图 |
| `browser_evaluate` | 执行 JavaScript |
| `browser_wait` | 等待元素/时间 |

---

## 19. API Bridge

**服务文件**: `src/main/services/apiBridge.ts`

### 19.1 功能概述

本地 OpenAI 兼容 API 反向代理服务，让外部工具（Claude Code / Codex / OpenCode）通过统一入口使用系统内配置的供应商。

### 19.2 核心能力

- **监听地址**: `127.0.0.1:29998`
- **认证**: Bridge Key 验证（`sk-bridge-*`）
- **模型路由**: 按请求中的 model 字段路由到对应供应商
- **SSE 流式透传**: 完整支持流式响应
- **Key 管理**: 自动生成/重新生成 Bridge Key
- **开关控制**: 可启用/停用

### 19.3 使用方式

外部工具配置：
```
base_url = http://127.0.0.1:29998/v1
api_key = <bridge_key>
```

### 19.4 IPC 接口

| Channel | 说明 |
|---------|------|
| `aibox:getBridgeStatus` | 获取状态 |
| `aibox:toggleBridge` | 启用/停用 |
| `aibox:regenerateBridgeKey` | 重新生成 Key |

---

## 20. 局域网 Web 管理服务

**服务文件**: `src/main/services/webServer.ts`

### 20.1 功能概述

支持局域网远程访问的 Web 管理服务，适用于工控机无人值守场景。

### 20.2 核心能力

- **复用前端**: 与桌面端完全一致的 UI
- **REST API**: 镜像关键 IPC 通道
- **Token 认证**: Bearer Token（默认 `aibox-admin`）
- **会话管理**: 登录后颁发 session token，24h 过期
- **频率限制**: 单 IP 每分钟 120 次，认证接口 10 次
- **监听**: `0.0.0.0:28889`（可配置）
- **自动启动**: 主进程启动时自动开启

---

## 21. 虚拟办公室

**前端页面**: `src/renderer/src/pages/Office.tsx`

### 21.1 功能概述

2D 虚拟办公室可视化，以拟人化方式展示数字员工的工作状态。

### 21.2 核心能力

- **拟人化展示**: 员工以角色形象显示在办公室中
- **状态动画**: 根据工作状态显示不同动画
- **交互**: 点击员工查看详情
- **实时同步**: 状态变化实时反映

---

## 22. 系统设置

**前端页面**: `src/renderer/src/pages/Settings.tsx`

### 22.1 功能概述

全局系统配置管理。

### 22.2 配置项

| 配置 | 说明 |
|------|------|
| 模型供应商 | Hermes 默认供应商配置 |
| 多供应商管理 | 添加/管理多个 API 供应商 |
| API Bridge | 代理服务开关与 Key |
| npm 下载源 | 引擎安装使用的 registry |
| 主题切换 | 亮色/暗色 |
| 数据库维护 | 完整性检查 + 手动清理 |
| 全屏模式 | F11 切换 |
| Web 服务端口 | 局域网管理服务端口 |

### 22.3 IPC 接口

| Channel | 说明 |
|---------|------|
| `aibox:getSetting` | 获取设置 |
| `aibox:setSetting` | 保存设置 |
| `aibox:getAppConfig` | 获取应用配置 |
| `aibox:setAppConfig` | 保存应用配置 |
| `aibox:integrityCheck` | 数据库完整性检查 |
| `aibox:manualCleanup` | 手动数据清理 |
| `aibox:storeSecret` | 存储密钥 |
| `aibox:hasSecret` | 检查密钥是否存在 |
| `aibox:pickDirectory` | 选择工作目录 |
| `aibox:toggleFullscreen` | 全屏切换 |

---

## 23. Android 设备操作

**前端页面**: `src/renderer/src/pages/Mobile.tsx`

**主进程服务**: `src/main/services/mobileGatewayService.ts`、`mobileAdbService.ts`、`mobileCatalog.ts`

### 23.1 功能概述

通过 Android Bridge + 局域网 Mobile Gateway 接入 Android 设备，为人工控制台和 `android_operator` Agent 提供受策略约束的设备操作能力。当前协议版本为 `1`，工具目录包含 42 个工具，目录源文件为 `mobile/tool-catalog.json`。

### 23.2 核心能力

- ADB 设备发现、APK 构建/校验/安装/导出。
- WSS Gateway、一次性二维码配对、TLS 证书指纹和设备身份认证。
- 屏幕预览、Accessibility UI Tree、节点观察、点击、输入、滑动、滚动和应用启动。
- 通知、联系人、位置、剪贴板、事件流、SMS、电话、Intent、Broadcast、媒体和 TTS。
- 截图、MP4 屏幕录制、WAV 麦克风录音和媒体产物下载。
- 最多 100 步的控制脚本，步骤 Schema 校验、等待预算和失败策略。
- 命令/会话审计、敏感字段脱敏、媒体大小与 SHA-256 校验、紧急停止。

### 23.3 状态与权限

设备状态：`offline`、`pairing`、`authenticating`、`online`、`busy`、`error`。工具调用还受到 Agent `capabilities.mobile`、Agent `allowedTools` 和 Android 系统权限三重限制。

### 23.4 详细文档与截图

安装、配对、权限映射、实时控制、脚本、日志、媒体、故障排查和安全设计见 [Android 设备操作功能文档](../../docs/ANDROID-DEVICE-OPERATIONS.md)。
