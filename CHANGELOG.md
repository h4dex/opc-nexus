# 更新日志 (Changelog)

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。每次功能变更须在此记录,并同步更新 `package.json` 的 `version` 字段。

## [2.0.0] - 2026-08-18

> DSH/Cordis 完整接入：OPC-Nexus 升级为本地优先 AI Agent 管理器的 v2 架构，引入 DSH 子智能体运行时、Quest 工作台、Secretary Planning 控制面、插件目录与治理层，以及全自主权限模型。

### 架构

- **DSH/Cordis 控制核**：`CordisControlKernel` 取代旧 Hermes/Nexus 双核设计，统一通过 Cordis 插件协议路由到 DSH 子智能体，`KernelRouter` 保留降级策略。
- **四层运行时分离**：DSH（会话/Run/Job 权威）→ `opc-nexus-governance`（Cordis 插件，有界投影）→ `aibox-native-host`（特权边界）→ Renderer（无 Node.js API）。
- **全自主权限模型**：数字员工与专家团默认获完全自主权限，`autonomousApproval` 白名单机制代替逐步审批；人类只做最终验收。每位数字员工严格限定在对应项目目录内。
- **删除旧内核文件**：移除 `hermesControlKernel.ts`、`nexusControlKernel.ts`、`deepseekPlanningAdvisor.ts`、`planningPrompt.ts`、`simulatedExecutor.ts` 与对应测试。

### 新增服务

- **DSH 集成层**：`dshControlClient`、`dshDelegationService`、`dshDelegationSyncService`、`dshEmbeddedWorkbench`、`dshIntegrationService`、`dshLanGateway`、`dshLanGatewayComposition`、`dshLanGatewayController`、`dshPolicyBroker`、`dshProviderBinding`、`dshQuestGovernance`、`dshQuestSessionBinding`、`dshSessionService`、`dshSessionWriteCoordinator`、`dshSupervisor`、`dshTypedQuestBridge`、`dshWebGateway`、`dshWindowManager`。
- **插件体系**：`pluginCatalog`、`pluginHost`、`opcNexusGovernancePlugin`、`dshCommunityPluginService`、`dshPluginCatalog`、`dshPluginPolicy`、`navigationPolicy`。
- **Secretary Planning**：`secretaryPlanning`、`secretaryPlanningAdapters`、`secretaryPlanningClassifier`、`secretaryPlanningControlPlane`。
- **项目产物管理**：`projectArtifactService`（FS 遍历 + TOCTOU 安全 `openVerified`）、`projectArtifactManifest`、`projectWorkbench`、`artifactRef`（SHA-256 + magic byte）、`artifactProtocol`（`aibox-project:` 特权协议，15 分钟 grant token）。
- **运行时基础设施**：`deepseekHarnessManagedRuntime`、`dshManagedExecutor`、`environmentDiagnostics`、`nativeAdapterHost`、`providerCredentialProxy`、`cordisBootstrap`、`questLaunch`、`questWindowManager`、`visionService`、`chatService`、`mobileConsole`。

### 界面

- **Quest 工作台**：`Quest.tsx`、`QuestWorkbench.tsx`（含内嵌 Webview 产物预览）、`QuestRuntimeSetup.tsx`、`QuestMobileAccess.tsx`。
- **项目产物面板**：`ProjectArtifactsPanel.tsx`，实时目录浏览 + SHA-256 指纹展示。
- **Secretary Planning 页面**：`SecretaryPlanning.tsx`。
- **插件页面**：`Plugins.tsx`。
- **可见性过滤**：`engineVisibility.ts`；运行时模式向导 `runtimeMode.ts`。

### 安全

- **IPC 参数校验**：`assertKeys` 扩展 `required` 参数，`parseDshQuestIdentity` 强制 `principalId` 等必需字段；`aibox:hashProjectArtifact` 新 handler。
- **产物协议 TOCTOU 修复**：`openVerified()` 在 stat 校验后立即 `open()`，通过 dev/ino 对比检测路径替换；`unowned` 标志防止双重关闭。
- **错误文本脱敏**：`errorText()` 对 `api_key`、`token`、`password`、`secret` 等字段值自动 `[REDACTED]`。
- **CSP 维持**：主进程与渲染侧 `script-src 'none'` 保持一致，`aibox-project:` 仅在 Renderer base-uri 中允许。

### 测试

- 新增 145 个测试文件（含 135 个新文件），**1554 tests passed / 2 skipped**（+14 相较于 1.8.1 基线），typecheck 全量通过。
- 新增测试覆盖：DSH 全链路、插件目录/策略/治理、Secretary Planning 分类与控制面、LAN Gateway 组合、Quest 路由/启动/窗口管理、项目产物服务、Cordis 引导、`v2ScenarioAcceptance` 端到端场景。

### 文档

- `docs/V2.0.0-DSH-CORDIS-PROJECT-QUEST-IMPLEMENTATION-PLAN.md`：v2 完整实施规划。
- `docs/V2-ACCEPTANCE-EXECUTION-PLAN.md`：验收执行计划（Phase A 已完成）。
- `docs/FUNCTIONAL-UX-AUDIT-2026-08-18.md`：功能与 UX 审计报告。
- `docs/adr/`：ADR-DSH-001/002/003 决策记录。
- `CLAUDE.md` 更新：v2 架构、自主权限模型、产物浏览、IPC 校验陷阱、安全基线补充。

## [1.8.1] - 2026-08-16

> 配套 Android Bridge 版本保持 `0.4.3`（`versionCode 5`）。本次为嵌套编排安全与调度稳定性补丁，不启用完整的 DSH 子智能体工作流图。

### 调度与并发

- **Team 并发上限生效**：`TeamEngine` 按 `config.concurrency` 使用有限 Worker 池；尚未取得执行槽位的子任务保持 `pending`，领取槽位后才进入 `running`，并发数不会被一次性任务拆解绕过。
- **权限不随来源提升**：来自 `team` 的任务不再自动获得 `autonomous` 权限；Nexus LLM、ACP/DSH、Codex/Claude/通用 CLI 与 Hermes 均保留员工原有权限模式，`standard` 任务仍需经过审批代理。

### 嵌套委派安全

- **环路与死锁保护**：拒绝终态父任务继续委派、损坏的祖先链、同一任务树或独立根任务之间的 A -> B -> A 员工等待环，以及并发槽已满时同员工父子任务互相等待；`engineOverride` 不能借用其他员工或更早的祖先员工绕过检查。
- **超时、重启与终止回收**：委派等待超时会主动取消子任务；应用重启会清理父链已中断的排队委派，派发前也会再次校验父链；父任务取消或员工停止时，仅沿 `source='delegated'` 的后代任务级联回收，并先持久化整棵任务树的 `CANCELLED` 终态，再中止执行器，避免同步回调覆盖终态。
- **终态任务续接**：对已完成委派任务发起人工追问或重试时，创建独立的桌面来源任务，不再把终态任务误用为新的委派父任务。

### 运行时边界

- **DSH 保持受限角色**：DeepSeek Harness 继续作为受限 ACP Worker/Advisor 使用，不在本补丁中取得全局派单、审批、长期记忆或 Android 工具权限。
- **Android 固定执行链路**：Android 手机任务继续由 Hermes Agent 通过 Mobile Gateway 和受策略约束的 `android_*` 工具执行；DSH 本身没有手机工具桥，不能直接操控设备。
- **Hermes 健康状态分类**：只有明确的 Provider、凭据或解密错误才标记 `AUTH_REQUIRED`；profile 路径、权限和磁盘等本地运行时故障不再伪装成 401/403 鉴权问题。
- **Orchestrator 仍是全局权威**：OPC Orchestrator 继续统一持有任务树、审批、长期记忆、取消与状态转换；执行器内部的子任务协作不能绕过该控制面。

## [1.8.0] - 2026-08-15

> 配套 Android Bridge 版本保持 `0.4.3`（`versionCode 5`）。本次完成桌面端 Agent Runtime 控制面整合，版本号与 `package.json` 保持 `1.8.0`。

### 架构与调度

- **Canonical 入站控制面**：微信、企业微信、飞书、桌面聊天、语音确认和 Web API 统一归一化为组织、用户、会话与消息，再进入同一条 `dispatchCanonical()` 路径，避免渠道各自创建任务。
- **Hermes 主控制核**：`KernelRouter` 默认优先使用真实 Hermes Agent CLI 生成结构化 `DispatchPlan`，负责结合员工特征和 OPC 长期记忆选择 Worker；Hermes 不直接创建 Task、写入记忆或执行渠道副作用。
- **Nexus 备用控制核**：Hermes 超时、鉴权失败、输出非法或不可用时，自动切换到确定性的 Nexus 控制核。这里的 Nexus 控制核不依赖 Provider；`eng-nexus` 作为普通 LLM Worker 时仍按引擎/应用 Provider 配置执行。
- **Orchestrator 单一提交点**：Orchestrator 是 DispatchPlan、Task 创建和任务状态转换的唯一权威；控制核、Advisor、Worker 和渠道适配器不能绕过状态机写入任务。
- **DeepSeek Harness 双角色边界**：DSH 作为可选复杂任务 Advisor/Reviewer，也可通过 ACP 作为普通 Worker 执行已提交任务，但没有独立派单权，避免与 Hermes 争用审批、幂等和恢复职责；DSH 当前没有 Android MCP/手机工具桥。

### 执行器

- **Pi Agent CLI**：新增专用 `PiAgentExecutor`，使用 OPC 管理的独立运行配置和显式 Provider 注入，支持任务执行与会话续接边界。
- **统一 ExecutorRegistry**：Codex CLI、Claude Code、Pi Agent、DeepSeek Harness ACP、Hermes Worker 统一注册为可调度执行器；Canonical 计划固定 `(workerAgentId, workerEngineId)`，批准引擎不可用时如实失败，不静默替换执行器。
- **Hermes Worker 隔离**：Hermes 控制核与 Hermes Worker 可同时存在，但分别使用控制面会话和员工级 profile，避免跨员工污染上下文。
- **Android 执行器固定**：`android_operator` 员工和活跃手机任务固定使用 `eng-hermes-cli`。设备离线时任务保持排队，设备上线后唤醒；DSH、Pi、Codex、Claude 等执行器不会静默接管手机任务。

### Harness 与运行时打包

- **DeepSeek Harness Runtime**：内置并固定 `@deepseek-ai/agent-harness@0.1.0-rc.6`，通过 ACP 接入任务编排、取消、暂停、审批、超时与流式输出。
- **受管 Skills**：每次任务创建独立 Skill 快照和 Session 根目录，仅加载 OPC-Nexus 管理的 Skills，为插件权限模型提供稳定边界。
- **多供应商接入**：支持 DeepSeek 官方与 OpenAI-compatible Provider，并通过真实模型探测和 Provider 指纹管理 Harness 就绪状态。
- **发布校验**：固定 Harness 依赖、npm 版本和 lifecycle 脚本白名单，校验许可证、native/Koffi 边界、Electron Node 兼容性与 RunAsNode fuse；Windows/Linux 发布任务复用同一生产签名 Android APK，并在打包后执行 Harness ACP smoke test。

### 记忆与自动化

- **OPC `MemoryService`**：新增按组织、用户、渠道、会话、员工和项目分域的长期记忆，提供版本化 recall、remember、update、forget；OPC 数据库是长期记忆唯一事实源。
- **记忆提案审核**：控制核只能返回 `memoryProposals`，计划提交后进入持久化 `pending` 队列，接受/拒绝均幂等并写入审计；未经接受的提案不会参与召回。
- **定时任务提案审核**：控制核只能返回 `taskScheduleProposals`，接受后由 OPC Scheduler 在事务中创建正式计划；Hermes 原生定时能力不参与 OPC 调度。
- **DSH 记忆边界**：DSH 上游虽有 JSONL、checkpoint 和 SQLite/FTS 等会话基础设施，但当前 ACP 集成每个任务都创建新的 `session/new`，任务结束后清理 session root，不提供跨任务长期记忆或 resume。长期记忆仍由 OPC `MemoryService` 管理。
- **Provider 继承顺序**：员工显式绑定 > 引擎显式绑定（Provider/model/protocol） > 应用默认 Provider。受管 CLI 启动时由 Main 进程注入对应 URL、模型和凭据；协议不匹配或凭据缺失会直接失败，不会串用其他 Provider。
- **引擎 Provider 模式**：Codex、Claude、OpenCode 和自定义 ACP 可选择 CLI 原生登录或 OPC 托管 Provider；Nexus、Hermes、Pi 和 DSH 固定使用托管配置。保存后立即刷新引擎快照并使旧的真实任务验证失效。

### 鉴权、安全与稳定性

- **Hermes 401/403 修复**：为控制核建立独立 `HERMES_HOME` 和显式 `opcnexus` Provider，固定 model/base URL，凭据只通过 Main 进程注入子进程环境，不再串用全局 OpenRouter 配置；明确的鉴权错误会标记 `AUTH_REQUIRED` 并触发 Nexus 控制核回退。
- **数据库 v39 迁移**：旧内置 `eng-hermes`、运行引用和历史 Provider 键迁移到 `eng-nexus`；真实 Hermes CLI 始终保留为 `eng-hermes-cli`。迁移会保留历史终态执行记录，并对结构损坏的数据库 fail-closed。
- **组织边界与幂等**：canonical identity、conversation、message、DispatchPlan、审批和 Task 均带组织边界与持久化去重凭据，渠道重投、进程重启和审批恢复不会重复派单。
- **Windows CLI 探测修复**：关闭 npm PowerShell shim 的 stdin，修复 Pi、Claude、OpenCode 探测被误判为超时的问题；CLI 启动、超时、退出码和中文错误输出均如实回传。
- **密钥隔离**：Provider 密钥继续只存在 Main/safeStorage 边界，不进入 Renderer、localStorage 或持久化日志；控制核和 Worker 使用显式运行时环境变量。
- **自定义 ACP 凭据边界**：外部 ACP 默认自主管理登录，只有显式员工 Provider 绑定、引擎 Provider 绑定或 `managed` 模式才接收 OPC 凭据；模型偏好本身不构成授权。输出、RPC/进程错误、工具名、审批文本和探测结果均按实际运行环境跨分块脱敏。
- **Provider 引用保护**：仍被员工或引擎绑定的 Provider 不允许删除；引擎密钥的增量替换、清空、加密失败与配置写入保持事务一致，缺失密文时 fail-closed。
- **Hermes 恢复边界**：profile/Provider 准备失败会撤销旧健康证明；原生会话失效时清理并重试一次；即使 CLI 退出码为 0，JSON 响应中的 401/403 仍按鉴权失败处理并切换 Nexus。

### 验证与已知限制

- 已通过 `npm run typecheck`、`npm test`（84 个测试文件，979 passed / 1 skipped）、`npm run build`、`npm run harness:verify`（18,023 files，89.63 MiB）、`npm run harness:verify:electron` 和 `git diff --check`。
- 本机已完成 Hermes、Nexus、Pi Agent 和 DeepSeek Harness 的真实健康/鉴权/最小任务验证；Claude Code、Codex CLI、OpenCode 已检测到可启动，但尚未完成在线模型探活，不能标为 `HEALTHY`。Codex 的 Microsoft Store 分发路径仍可能触发 Windows `spawn EPERM`，需使用可直接执行的 CLI 路径。
- 普通浏览器直接打开 Renderer 不具备 Electron preload，不能代替 Electron 运行；本地 Web REST canonical 入口可独立健康检查。

## [1.7.1] - 2026-08-14

> 配套 Android Bridge 版本保持 `0.4.3`（`versionCode 5`），本次仅升级桌面端。

### 新增

- **微信 iLink Bot 渠道**：在「连接中心」选择数字员工并生成二维码，使用微信扫码确认后
  一键完成授权与员工绑定；需要时支持输入手机显示的数字配对码。
- **可靠消息链路**：支持 HTTP 长轮询收信、上下文回复、持久化消息幂等、加密待发队列、
  断线恢复、失败退避和腾讯接口冷却状态恢复。
- **应用内存监控**：系统中心新增 Electron Main、Renderer、GPU 与 Utility 进程的内存明细
  和最近趋势，区分应用自身内存与整机内存。

### 性能与稳定性

- 浏览器自动化改为共享 Chromium 进程，数字员工继续使用隔离 BrowserContext；空闲与退出时
  完整释放页面、Context、CDP 连接和浏览器进程。
- OCR 模型改为按需加载并在空闲后释放；语音音频使用有界缓冲和串行发送，避免积压。
- 资源历史改为有界增量采样；合并项目、成果与知识库的高频刷新，并清理重复订阅、定时器和
  会话生命周期残留，降低桌面端长时间运行时的内存增长。
- 手机截图使用延迟解码，录屏和音频不再预加载媒体内容。

### 兼容性与限制

- 微信 iLink Bot 仅处理扫码账号与 AI Bot 的私聊，不读取现有好友或群聊消息。
- 原个人微信本地 WebSocket 桥接已由 iLink Bot 替代，升级后需在连接中心重新扫码授权。
- 企业微信渠道保持不变；飞书接入代码保留，但本版本未使用真实账号完成端到端验证。

### 验证

- 通过 TypeScript 类型检查、Vitest 全量测试（558 passed / 1 skipped / 0 failed）和 Electron
  生产构建。

## [1.7.0] - 2026-08-14

> 配套 Android Bridge 版本：`0.4.3`（`versionCode 5`）。桌面端与 Android Bridge
> 独立维护版本号；功能变更验证通过后必须递增对应版本，用户指定版本时以指定版本为准。

### 新增

- **Android 手机员工**：新增 `android_operator` 员工身份，固定使用独立 Hermes Agent
  Profile、并发数 1，并可一对一绑定无 Root Android 8.0+ 设备。
- **局域网 Mobile Gateway**：提供 WSS 设备通道、5 分钟一次性配对、TLS SPKI 固定、
  Android Keystore ECDSA 身份认证、设备租约、短期任务令牌和紧急停止。
- **42 个 Android 工具**：覆盖界面观察与操作、应用管理、通知/联系人/位置、通信、截图、
  录屏、录音和 TTS；工具参数统一由版本化 JSON Catalog 校验并按员工策略授权。
- **手机控制台**：新增设备、控制、脚本、日志、媒体和安装视图，支持固定比例屏幕预览、
  独立滚动 UI Tree、ADB 安装内置 APK、媒体校验归档和受限 JSON 脚本。
- **双路配对配置**：桌面端可复制完整配置和查看非敏感详情；Android Bridge 支持扫码、
  粘贴完整 JSON 或逐项手动配置，便于摄像头不可用的设备接入。
- **数字员工快捷派单**：员工卡片、列表和操作菜单新增「安排任务」，可直接指定当前员工创建任务。
- **Android 品牌资源**：Bridge 使用 OPC-Nexus 普通、圆形、自适应和 Android 13 单色图标，
  并提供 `npm run mobile:icons` 可复现生成脚本。
- **统一 Release 流水线**：GitHub Actions 只构建一次生产签名 Android Bridge，并将同一 APK
  内置到 Windows/Linux 桌面包；Windows NSIS、Linux AppImage/DEB、Android APK、签名清单
  和统一 `SHA256SUMS.txt` 发布到同一个 GitHub Release。

### 修复

- 修复中文任务在 IPC、CLI 参数和流式输出链路中的乱码问题，改用 UTF-8 Base64 传递并支持
  跨 chunk 解码。
- 修复 Android 扫码入口依赖不完整时闪退的问题，并为二维码/手动配置解析补充错误处理。
- 修复手机预览与 UI Tree 互相挤压的问题：投影区域保持稳定尺寸，树形框可独立上下滚动。
- 修复应用侧栏品牌文案和顶部工具图标，统一为 `OPC-Nexus`、`www.apptq.com` 和 SVG 图标。

### 性能与安全

- Renderer 页面改为懒加载，并限制任务输出、手机预览和事件缓存，降低长时间运行时的内存增长。
- 资源采样增加互斥和缓存；Windows 磁盘采样改用 Node 原生 `statfs`，避免周期性启动
  PowerShell/WMI 子进程。
- 手机命令按 Schema、工具白名单、设备能力和 Android 权限逐次校验；敏感输入、短信、
  剪贴板和 UI 数据默认不持久化，媒体采用分块长度与 SHA-256 校验。

### 验证

- 通过 TypeScript 类型检查、Vitest 全量测试、Electron 生产构建、Android Gradle 单元测试和
  Debug APK 构建/签名/包名校验。

## [1.6.0] - 2026-07-30

### 修复（第三方引擎全部无法执行任务）

三个 CLI 引擎在引擎中心均显示 HEALTHY,实际派发任务全部失败。根因各不相同,
共性是**健康探测只证明「检测到入口」,不能证明「能启动并完成任务」**:

- **OpenCode `spawn ENOENT`**:`locateBin` 回退到 npm 生成的**无扩展名 shim**
  (`...
pm\opencode`),Windows 不视其为可执行文件。实测三条路径:
  无扩展名 shim → ENOENT;`.cmd` 直接 spawn → EINVAL(Node 安全策略禁止);
  **`cmd.exe /d /s /c <命令>` → 唯一可行**
- **Codex CLI `spawn EPERM`**:解析到 Microsoft Store 分发路径
  (`WindowsApps\...\codex.exe`,reparse point),直接 spawn 被拒
- **Hermes 退出码 2**:`-t files` 传了不存在的工具集名。实测 `hermes tools list`
  确认内置名为**单数 `file`**;传未知名时 hermes 直接拒绝执行整个任务
- **中文 Windows 错误信息乱码**:cmd.exe 以 GBK 写 stderr,按 UTF-8 解码得到 `�`,
  既无法阅读也无法用中文特征匹配「命令未找到」。现按 UTF-8 → GBK 回退解码

### 新增

- **`cliLauncher` 跨平台启动器**:把「怎么正确启动一个 CLI」收敛到一处,
  检测 / 版本探测 / 鉴权探测 / 任务执行共用同一策略,避免各处各写一套而漏掉某种形态
- **四级探活信号**(发布要求):把「健康」拆成 `detected` / `launchable` /
  `authenticated` / `task_verified` 四个可解释维度,逐级递进,任一级失败即停在该级并如实回报。
  **只有最小任务通过才写 HEALTHY** —— 检测只能得到 `AUTH_REQUIRED`,
  起不来得到 `ERROR`。引擎中心逐条展示四个信号 + 最近一次探活的原始输出
- **供应商凭据下发**:第三方 CLI 起来了却读不到凭据,一调用即 401
  (实测 Hermes 报 `HTTP 401: Missing Authentication header`)。现把应用内已配置的
  供应商按 OpenAI 兼容约定(`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_API_BASE`)
  注入子进程 env;用户在引擎配置页手填的同名变量优先。凭据只存活于子进程,不落盘、不进日志
- 探活能区分「参数不被接受」(我方调用方式与 CLI 版本不匹配)与「凭据无效」,并提示可用
  `engines[id].runArgs` 覆写参数
- **测试 +23 项**(合计 391):cliLauncher 三种 Windows 形态与 GBK 解码 16 项、
  供应商凭据下发 7 项

## [1.5.4] - 2026-07-29

### 修复（打包）

- **安装后 OCR 与浏览器自动化必然失效**:`onnxruntime-node` / `sharp` /
  `playwright-core` 由主进程动态 `import()` 加载,`externalizeDepsPlugin` 不内联进产物,
  而 `electron-builder.yml` 的 files 白名单未列入 —— 装完一调用即 `MODULE_NOT_FOUND`。
  开发模式测不出(能直接读 node_modules),只有装完才暴露。现补入三者及传递依赖,
  原生 `.node` 与 `sharp`/`@img` 加入 `asarUnpack`
- **Windows 安装包多打 132MB 无用二进制**:`onnxruntime-node` 自带 darwin/linux/win32
  三平台库(约 260MB),现按 win/linux target 分别剔除另两平台

### 修复

- **API Bridge 带 query 的请求误返 404**:路由用完整 `req.url` 精确比较,
  而 OpenAI 客户端常附加 query(如 `/v1/models?limit=1`),导致匹配失败。
  现只比较 pathname
- **API Bridge key 比较改为定长比较**,消除时序侧信道
- **API Bridge CORS 不再放行任意来源**:原设 `Access-Control-Allow-Origin: *`,
  任意网页都能借用户浏览器打这个回环端口。该代理供本机 CLI 直连,无跨源需求
- **API Bridge 补请求体上限(10MB)与流式背压处理**:原 SSE 透传不检查 `res.write`
  返回值也不响应客户端断开,客户端提前断连会泄漏上游读取器与内存

### 新增

- **API Bridge 测试 24 项**:鉴权(缺失/错误/截断 key 均拒)、bridge key 生成与轮换、
  路由(含带 query)、上游错误 502、状态码透传(429 不被吞成 200)、
  **转发时用供应商密钥替换客户端 key**(不把真实密钥回传调用方)、启停幂等

## [1.5.3] - 2026-07-29

### 修复

- **CLI 事件流报错后仍可能被覆盖为成功**:Codex `error` 事件(及 Claude `result.is_error`)
  只调 `onError` 而未标记中止,进程随后以 `code=0` 退出时 close 分支会再调 `onDone`,
  任务显示成功。现报错即写入 `abortedTasks`,与超时路径一致

### 新增

- **CliExecutor 测试 27 项**(核心执行路径,评审文档标记的覆盖缺口):
  权限→沙箱映射(`readonly`→`read-only` / `standard`→`workspace-write` /
  `trusted`→`danger-full-access`,渠道任务 trusted 降级、专家团提升)、
  会话续跑参数(`exec resume`)、泛化 CLI 模板覆写与 `{prompt}` 缺失兜底、
  JSONL 解析(跨 chunk 分片 / 非 JSON 容错 / 错误事件 / 无产物说明)、
  退出码与 ENOENT 提示、abort 后不回报

### 变更

- `claude-cli` 分支标注为历史兼容(四引擎收敛后已无处实例化)

## [1.5.2] - 2026-07-29

### 安全修复

- **Web 面板鉴权可被路径穿越绕过**(实测确认):免认证判定用 `req.path.startsWith('/assets/')`,
  而裸 socket 请求(`GET /assets/../api/snapshot`)的 `req.path` 不会被规范化,
  该判定返回 true 直接放行鉴权 —— 此前未泄露数据仅因路由层恰好未匹配,
  安全性建立在巧合而非设计上。现改为**先规范化再判定**(解码 + 消解 `.`/`..` + 反斜杠归一),
  并覆盖 `%2e%2e` 等编码穿越
- **Token 比较改为定长比较**(`timingSafeEqual`),消除鉴权与登录接口的时序侧信道;
  长度不等直接判否(`timingSafeEqual` 对不等长入参会抛异常)
- **CORS 不再放行任意来源**:原 `cors()` 默认 `*`,开启局域网暴露后任意网页
  都能在用户浏览器中调用管理 API。面板由本服务同源托管,无跨源需求,现设 `origin: false`
- **请求体上限 1MB**:管理接口无大 body 场景,避免单请求打满内存
- 登录失败写入审计日志(便于发现暴力破解尝试)

### 新增

- **Web 面板安全边界测试 16 项**:含用 `net.Socket` 复现绕过的端到端用例,
  以及「旧 `startsWith` 判定确实会放行」的回归锚点(证明测试有鉴别力)

## [1.5.1] - 2026-07-28

### 新增

- **`LlmApiExecutor` 测试 28 项**(此前零覆盖,却是 Nexus Agent 的核心执行路径):
  SSE 流式解析(跨 chunk 分片 / `[DONE]` / 畸形行)、工具循环与轮次上限、审批门禁
  (拒绝即终止且不执行工具)、权限语义映射、供应商就绪判定、用量落库、abort 中断
- **语音链路离线验证 33 项**:阿里云 RPC 签名(StringToSign 构造、百分号编码规则、
  `+`→`%20` / `*`→`%2A` / `~` 保留、参数字典序、密钥拼接)13 项;
  NLS 协议帧处理(中间结果 / 句末 / 错误码如实上报 / 不带 status 的帧不误判 / 非 JSON 不崩溃)
  与 StartTranscription 载荷契约 20 项

### 修复

- **内置引擎状态语义不一致**:`adapterFor()` 绕过 `engines.status` 自行判断可用性,
  与 `detect()` 维护的状态字段可能矛盾(库里 SETUP_REQUIRED 却仍派发,或反之)。
  现统一以 `engines.status` 为唯一真相来源,与 `isReady()` 判据对齐

### 变更

- 移除 `McpManager.callTool()` 死代码(全项目无调用方;真实工具调用走 `executor/tools.ts`)
- `voiceService.ts` 抽出可测纯函数 `classifyNlsFrame()` 与 `VoiceSession.startPayload()`,
  协议判定由测试直接驱动真实实现,避免测试复刻逻辑后与实现脱钩

> 说明:语音云端链路的**签名算法**已离线验证到 StringToSign 逐字节正确、编码规则完备;
> 但**端到端连通性**(真实 AccessKey → Token → WebSocket 出字)仍需填入真实凭据实测,
> CI 无法覆盖。凭据错误时的表现已有测试锁定(`TaskFailed` + `SignatureNotMatch` 如实上报)。

## [1.5.0] - 2026-07-28

### 新增

- **全双工语音任务下达**:点击顶栏麦克风即可用说话安排任务。边说边出字(流式识别),
  停顿后解析为任务草稿,**用户确认后才派发**(source='voice')
  - 双路策略:云端阿里云 NLS 实时识别(WebSocket 流式)/ 本地离线模型;
    `auto` 模式下云端凭据齐备走云端,否则回退本地,两者都不可用时如实报错
  - 音频经主进程转发而非 Renderer 直连云端 —— 云端凭据必须留在主进程(安全基线 15.1)
  - 凭据(AccessKeyId/Secret)经 safeStorage 加密,设置页只显示「是否已配置」,不回显明文
  - 指令解析以**已知员工名为锚点**切分,支持「让X做Y」「请X帮我Y」「@X Y」「X，Y」等口语句式,
    并处理语音特有形态(口头语前缀、名字被说短、缺句末标点)
  - 会话 5 分钟兜底超时 + 退出时关闭活跃会话,避免麦克风与云端连接残留
- 设置页新增语音配置卡片(通道选择 / 凭据填写 / 可用性检测)
- 语音指令解析测试 17 项

### 变更

- `TaskSource` 新增 `voice`,语音派发的任务在任务中心标注「语音」,与手动派发可区分

## [1.4.1] - 2026-07-28

### 修复

- **P0 数据库损坏导致应用无法启动**(真机测试发现):`flush()` 用 `writeFileSync` 就地覆盖 live 数据库,
  进程在写入中途被终止即留下截断/全零文件;而启动路径无任何容错,sql.js 抛
  `file is not a database` 后整个应用打不开且用户无自救手段(实测本机 aibox.db 已成 41MB 全零文件)。
  现改为**原子落盘**(临时文件 + fsync + rename)并拒绝空导出覆盖既有库;
  启动时校验 SQLite 魔数 + `PRAGMA quick_check`,损坏文件留存为 `.corrupt-<时间戳>` 后以空库启动
- 新增 schema 迁移链路测试(真实 sql.js 跑 v25→v28,9 项)与数据库损坏容错测试(9 项)

## [1.4.0] - 2026-07-28

### 新增

- **编码专家委派**(E-2):主引擎(Hermes/Nexus)遇到改代码、跑测试、分析仓库类工作时,
  可经 `delegate_coding_task` 工具交给 OpenCode 执行。子任务仍归属原员工(审批与审计链路不变),
  仅执行引擎不同;OpenCode 未就绪时该工具不注册给模型,避免必然失败的调用
- **任务级引擎覆盖** `tasks.engine_override`(schema v28):承载编码委派与引擎路由
- **演示数据可查可清**:设置页展示库中演示数据残留量,支持一键清空(只删 `is_demo = 1` 行)
- **编码委派与引擎路由测试** 13 项

### 修复

- **P0 演示种子数据混入生产库**(H-3):12 名虚构员工、23 条「今日完成」任务与真实数据同表且无标记,
  统计口径无法区分真伪。现默认不再写入种子数据(需 `seedDemoData` 显式开启);
  schema v27 增加 `is_demo` 列并按 `project-demo-*` 特征回填历史库;
  首页统计(活跃任务/待办/今日完成)一律排除演示行
- **引擎路由规则形同虚设**:`engine_routing` 此前只存不读,用户配置后无任何效果。
  现按任务来源真实路由,且仅当目标引擎 HEALTHY 时生效;UI 下拉同步只列 HEALTHY 引擎
- 设置页「演示自动派单」开关默认值与主进程不一致(前端默认开、后端默认关),现统一为关

## [1.3.0] - 2026-07-28

### 新增

- **真实 Hermes Agent 执行器** `HermesAgentExecutor`:接入 NousResearch/hermes-agent CLI 的
  headless 模式(`hermes -z`),经 `--usage-file` 捕获 session_id 实现会话续接(`-r` + `--no-restore-cwd`),
  按退出码语义(0/1/2/130)如实分流结果,token 用量落 usage_records
- **引擎鉴权真实探测**:内置引擎校验供应商配置,CLI 引擎跑一次最小 headless 请求验证凭据;
  鉴权类错误标 AUTH_REQUIRED,探测超时标 DEGRADED,不再点一下就标记 HEALTHY
- **引擎层测试**(此前零覆盖,补齐 CLAUDE.md 要求的状态机测试):EngineManager 引擎目录与
  鉴权状态迁移 11 项、HermesAgentExecutor 参数构造与权限映射 16 项

### 变更

- **引擎清单收敛为四种**:Nexus Agent(内置自研 Runtime)/ Hermes Agent(默认主引擎,真实 CLI)/
  OpenCode(编码专家)/ Codex CLI(备选编码引擎);下线 Claude Code / ZCode / Kimi Code
- **schema v26 迁移**:绑定已下线引擎的员工自动改绑内置 Nexus,避免 engine_id 指向不存在的引擎
- Hermes CLI 权限映射:`trusted`/`autonomous` → `--accept-hooks`;`readonly` → `-t` 限制工具集;
  渠道任务 `trusted` 降级为 `standard`;任何情况下都不传 `--yolo`
- 引擎中心「登录授权」按钮改为「验证登录」,如实回报探测结果
- 引擎状态 `SETUP_REQUIRED` 文案去掉「演示模式」(生产模式已是默认)

## [1.2.0] - 2026-07-28

### 新增

- **架构与产品诊断报告** `src/docs/architecture-review.md`:记录诚实性缺陷、安全问题、引擎体系设计、
  架构缺陷与后端迁出 Electron 的演进路径,附录含实测核实的 hermes-agent CLI 接口(v0.19.0)
- **引擎凭据隔离模块** `engineEnv.ts`:统一的敏感环境变量拆分/解密逻辑(含 10 项单元测试)

### 修复

- **P0 生产模式未默认生效**:`executionMode` 默认值为 `demo`,导致引擎不可用时仍生成虚构产物并标记
  任务完成;现默认 `production`,演示模式需显式开启
- **P0 自动补位造假任务**:`demoAutoTasks` 默认开启且水位 8,系统会自动创建用户从未派发的任务并计入
  统计;现默认关闭、水位 0
- **P0 引擎环境变量明文存储凭据**:自定义 env 整体明文写入 `engines.config_json` 并进入引擎日志,
  违反密钥必须走 safeStorage 的安全基线;现敏感键(KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL/AUTH)
  加密存 `secret:engine:<id>:env`,`config_json` 仅留 `***` 占位符,spawn 时还原且仅存活于子进程
- **P0 Web 管理面板默认暴露局域网**:默认监听 `0.0.0.0` 且访问 Token 打印到 console;现默认绑
  `127.0.0.1`,需显式开启 `webExposeLan` 才暴露,Token 不再写入日志
- **P0 Hermes 配置目录冲突**:同步逻辑写死 `~/.hermes/` 并以覆盖方式导出,会破坏真实 hermes-agent 的
  `config.yaml`/`.env`/`skills/`;现划定归属边界(仅写 `mcp_servers.json` 与 `skills/opc-nexus/`),
  并按 `HERMES_HOME` > Windows `%LOCALAPPDATA%\hermes` > `~/.hermes` 解析真实目录
- **看门狗误杀恢复任务**:暂停与审批等待期被计入运行时长,长时间等待后恢复即被中断;现恢复时重置
  `started_at`,按本段运行时长计时

## [1.1.0] - 2026-07-28

### 新增

- **企微机器人渠道增强**:对话指令 `/状态` `/取消` `/取消 全部` `/暂停` `/继续` `/帮助`,聊天侧可直接干预失控任务(企微/个微/飞书三渠道统一支持)
- **长任务看门狗**:任务运行超过 `task.maxRunMinutes`(默认 30 分钟)自动强制中断,防止长任务卡死与模型死循环空耗
- **企微群机器人 webhook 通知**:任务完成结果自动推送到指定群(仅 COMPLETED;官方频控下队列节流)
- **用户配置文件 `user/config.yaml`**:程序运行目录下自动生成,支持企微凭据(启动导入系统密钥库)、webhook 地址、辅助引擎、执行模式、看门狗参数
- **主辅引擎策略**:主引擎不可用时自动回退辅助引擎(默认 OpenCode);`production` 模式下无可用引擎任务直接失败,绝不伪装演示产物
- **真实 Hermes Agent CLI 引擎**:新增 `eng-hermes-cli` 引擎条目(可执行名/运行参数可经配置文件覆写)
- **Skills 组合成数字员工**:技能页多选技能一键生成员工,技能正文注入人设,内置任务拆分规划约定,走真实执行链路

### 修复

- **P0 供应商数据源统一**:设置页(providers 表)与引擎健康检查(旧 settings)数据源不一致,导致配好供应商后引擎仍显示 SETUP_REQUIRED、任务落入演示模式;现统一以 providers 表为唯一数据源,启动时自动迁移旧配置

### 变更

- 内置引擎 `Hermes Runtime` 更名为 **Nexus Agent**(自研 Runtime,与真实 Hermes Agent CLI 区分)

## [1.0.0] - 2026-07-25

### 新增

- 首个正式版:数字员工管理、任务编排、多引擎接入(Codex/Claude Code/ZCode/OpenCode/Kimi)、
  消息渠道(企微长连接/飞书/个微桥接)、可视化工作流、专家团协作、MCP & 技能系统、
  多供应商模型路由、多机协同、系统监控、局域网 Web 管理后台、OpenAI 兼容 API 代理
