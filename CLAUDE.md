# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

OPC-Nexus(package 名 `aibox-control-center`)— 本地优先的桌面 AI Agent 管理器。技术栈:Electron 37 + electron-vite 3 + React 19 + Zustand 5 + sql.js(SQLite WASM)+ TypeScript strict。目标平台 Windows 10/11 与 Ubuntu 22.04+。

更详细的约定与检查清单见 `AGENTS.md`,深入文档见 `src/docs/`(architecture / features / api-reference)。

当前正处于 v2.0.0 Quest/Hermes 验收收敛期。动手前先读 [持续优化目标](docs/GOAL-QUEST-HERMES-CONTINUOUS-OPTIMIZATION.md)、[当前验收报告](docs/ACCEPTANCE-REPORT-2026-08-22.md) 和 [用户指南](docs/USER-GUIDE.md)。更早的 DSH/Cordis 文档只记录历史决策，不代表当前架构。

## Git 工作流(必须遵守)

- **每完成一个功能就提交一次**:先本地 `git commit`,再推送到 CNB 远端 `origin`(https://cnb.cool/senke/innovation/opc-nexus)
- 提交信息风格与仓库历史一致:`feat:` / `fix:` / `docs:` / `chore:` 前缀,一行说明(中英文均可,参考 `git log`)
- 提交前必须通过 `npm run typecheck` + `npm test`
- 远端认证已配置在 remote URL 中(用户名 `cnb` + 令牌),**禁止**将令牌写入任何被提交的文件
- Git 身份:`liyingjie <y@senke.com>`(已配置)
- CNB 相关操作(API、CI、Release)使用 `.claude/skills/cnb` skill

## 版本发布约定

- 每次功能发布须同步:① `package.json` 的 `version` 按语义化版本递增(新功能 minor,修复 patch);② 在 `CHANGELOG.md` 顶部追加该版本的变更记录(新增/修复/变更 分节)
- CHANGELOG 是版本历史的唯一权威文档,README 仅链接不重复内容
- **已知文档漂移(待修)**:`README.md:23` 仍写桌面端 `1.8.1`,而 `package.json` 已是 `2.0.0`;`README.md:66,220`、`docs/USER-GUIDE.md:53`、`src/docs/README.md:85`、`src/docs/features.md:137` 仍把「模拟执行」宣传为可选执行模式。触碰这些文件时顺手改正,不要照抄旧表述

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm run dev` | 开发模式(electron-vite,HMR) |
| `npm run typecheck` | `tsc --noEmit` 全量类型检查 |
| `npm test` | 运行全部单元测试(vitest run) |
| `npm test -- tests/orchestrator.test.ts` | 运行单个测试文件 |
| `npx vitest run -t "测试名"` | 按测试名过滤 |
| `npm run test:watch` | 监听模式测试 |
| `npm run build` | 生产构建 → `out/{main,preload,renderer}` |
| `npm run dev:quest` / `start:quest` | 仅 Quest 入口(不创建主控制台) |
| `npm run pack:win` / `pack:linux` | 构建并打包安装程序 |

- **没有 `lint` 脚本**,也没有独立的 `e2e` 脚本;不要在文档或 CI 中引用它们。Playwright 通过 `_electron` 驱动(`scripts/mobile-e2e.cjs`),且 `playwright` 目前是未声明的传递依赖(仅 `@playwright/mcp` 与 `playwright-core` 在 `package.json` 中),写 E2E 前需先显式声明并锁版本。
- 依赖安装走 npmmirror 镜像(`.npmrc` 已配置)
- CI(`.cnb.yml`,CNB 平台)在 push/PR 时**只执行** typecheck + test;构建与打包在 `.github/workflows/`。提交前 typecheck 与 test 必须通过
- 验证顺序:`typecheck` → `test` →(涉及构建配置时)`build` →(涉及 UI 时)`dev` →桌面/手机黑盒脚本。
- 当前基线以最新命令输出和 `docs/ACCEPTANCE-REPORT-2026-08-22.md` 为准。**全绿不等于闭环可用**，还必须验证「老板下令 → Hermes 调度 → 真实 Worker → 可打开成果」和手机项目对话边界。

## 架构

### 分层与依赖方向(单向)

```
renderer → preload → main → shared
```

- `src/main/index.ts` — 主进程入口:窗口、托盘、单实例锁;实例化全部服务后通过 `registerIpc(deps)` 注入 `ipc.ts`(依赖注入集中在 `IpcDeps` 接口)
- `src/main/ipc.ts` — **IPC 白名单**:所有 Renderer→Main 通信的唯一合法入口,channel 命名 `aibox:<动作>`;入口处做轻量参数校验(`assertString`/`assertId`)
- `src/main/services/` — 30+ 业务服务(orchestrator、database、engineManager、channelManager、workflowEngine、teamEngine、collabManager、mcpManager、scheduler、providerManager、webServer、apiBridge 等);`executor/` 为执行器实现,`channels/` 为消息渠道实现(飞书/企微/微信)
- `src/preload/index.ts` — contextBridge 暴露类型安全的 `window.aibox` API,**不暴露** `ipcRenderer` 本体
- `src/renderer/src/` — React SPA:`App.tsx` 按 `store.ts` 的 `RouteKey` 切换 `pages/` 下 20+ 页面(无路由库);`store.ts` 为 Zustand 全局状态
- `src/shared/types.ts` — 跨进程纯类型定义(四层状态模型、实体、IPC 载荷),**禁止引入 Node/Electron 依赖**

路径别名 `@shared/*`、`@renderer/*` 在 tsconfig.json、electron.vite.config.ts、vitest.config.ts 三处保持一致。

### 数据流:快照推送模式

主进程状态变化(`orchestrator.onChange` / `broker.onChange`)→ `ipc.ts` 中节流(~400ms trailing)广播 `aibox:snapshot` 全量快照 → Renderer 在 `store.init()` 中经 `window.aibox.onSnapshot` 订阅并更新 Zustand。Renderer 不轮询、不直接修改状态。任务输出经 `aibox:taskOutput` 流式推送,资源样本经 `aibox:resources` 推送。

### 新增 IPC 方法三步走

1. `src/main/ipc.ts` 注册 `ipcMain.handle('aibox:xxx', ...)`
2. `src/preload/index.ts` 暴露类型安全封装
3. Renderer 通过 `window.aibox.xxx()` 调用

### IPC 参数校验陷阱(已导致 P0,务必注意)

校验助手的签名是 **`(value, field, min, max)`**,`min`/`max` 都有默认值:

```ts
decodeUtf8Text(v, field, min = 0, max = 500)   // services/textEncoding.ts
assertString(v, field, min = 1, max = 500)     // ipc.ts
```

**第三个位置参数是 `min`,不是 `max`。** 只传一个数字(如 `decodeUtf8Text(x, 'text', 4_000)`)会把 4000 当作最小长度、500 仍为最大长度,形成不可能区间,任何输入都抛 `需 4000-500 字符`。写长文本字段必须显式传两个值:`decodeUtf8Text(x, 'text', 0, 4_000)`。

另一类同源缺陷:**校验器与载荷形状不匹配**。给不同 payload 复用同一个 `assertXxxInput` 时,若该校验器要求目标类型并不声明的字段(例如对只有 `sessionId + expectedRevision` 的提案输入复用要求 `version + hash` 的决策校验器),该 IPC 将永远不可达。每个 IPC 输入类型应有与之一一对应的校验器。

这两类缺陷**类型检查和现有单测都发现不了**(`assertKeys` 只拒绝未知字段,不检查缺失字段;测试若传 `text: null` 会短路长度校验)。因此新增/修改 IPC 校验时,必须补一条从 **preload 公开 API** 驱动的用例,覆盖:典型中文短文本、空文本、上限边界、超限。禁止只在 service 层测试而绕过 IPC 校验。

### 四层状态模型(不得混用)

| 层 | 状态流转 |
|---|---|
| Agent(`AgentLifecycle`) | DISABLED → STARTING → READY → STOPPING;异常 → ERROR |
| Task(`TaskStatus`) | QUEUED → RUNNING → COMPLETED/FAILED/CANCELLED/INTERRUPTED;可经 WAITING_APPROVAL/PAUSED |
| Engine(`EngineStatus`) | NOT_INSTALLED → INSTALLING → SETUP_REQUIRED/AUTH_REQUIRED → HEALTHY/DEGRADED/ERROR |
| Channel(`ChannelStatus`) | UNCONFIGURED → CONNECTING → ONLINE/RECONNECTING/AUTH_EXPIRED/DISABLED/ERROR |

状态转换只能发生在主进程 `orchestrator.ts` 或对应 Manager 中,Renderer 不可直接修改。首页派生状态 `DerivedAgentStatus` 由编排器计算,互斥优先级 `error > running > paused > starting > idle`。**状态机变更必须有对应测试覆盖。**

### v2.0.0 产品分层:Hermes 为唯一调度平面

v2 的主轴是「主控制台管理项目 → Quest 打开项目会话 → Hermes 澄清、规划和组队 → Nexus 治理后交给真实 Worker 执行」。三层职责不可混淆:

- **Hermes** — 唯一面向老板的调度器，负责对话、澄清、计划内容、长期会话和动态子 Agent 推理。
- **`opc-nexus-governance`** — 项目/员工目录、权限预算、任务状态、审批、审计、渠道和 artifact admission 的权威层；它不作为第二调度器。
- **`aibox-native-host`** — safeStorage、文件、进程、TLS/Origin、数据库和原生扩展的薄特权边界；它不对话、不规划、不组队。

关键约束:

- 旧调度器、Workbench、手机网关、插件目录、Runtime 和 Renderer IPC 已退出生产运行图，不得重新引入。
- 数据库只保留一次性升级识别：旧活动任务迁移为 `INTERRUPTED`，旧员工迁移为 `ERROR`，历史终态和审计证据保留，不静默改绑 Hermes。
- Codex、Claude Code、Pi、Hermes CLI、ACP/A2A 适配器都是 Worker 能力，不能取得调度权或直接伪造完成状态。
- 手机二维码只由当前项目 Quest 右上角生成，只开放该项目 Hermes `/chat` Operator 会话；Android 执行设备配对是独立链路。

产物交付相关服务当前**并未打通**:`deliverableManager.ts` 只把任务 `result` 文本包装为 Markdown;`artifactRef.ts` / `projectArtifactService.ts` 是内容寻址(SHA-256/magic/大小/grant)的独立体系,尚未接入交付与导出链路。新增交付能力时应向 ArtifactRef 收敛,不要扩展文本包装路径。

### 执行器选择(`executor/index.ts`,按优先级)

1. Nexus 内置 Worker → `LlmApiExecutor`(已配置供应商时)
2. Hermes / Pi → 专用 CLI Executor
3. Codex / Claude Code / OpenCode → 对应 CLI Executor
4. 其他明确配置的 ACP/A2A 或自定义 CLI → 对应受治理执行适配器
5. 无可用引擎 → `resolve()` 返回 `null`,任务转 `FAILED`

`executionMode` 默认 `production`(`userConfig.ts`),此时**不存在**任何模拟回退。`SimulatedExecutor` 仅在 `executionMode !== 'production'` 时可达(`executor/index.ts:160`),属于**待移除的历史路径**,不要为其新增功能或在文档中把它描述为可选执行模式。

### 自主执行与目录边界(产品决议,不得回退)

**默认完全自主。** `DEFAULT_AGENT_PERMISSION_MODE = 'autonomous'`(`shared/types.ts`),数据库 schema 默认同值,v44 迁移已把历史 `standard` 转为 `autonomous`(保留用户显式选择的 `readonly`)。新建、内置、市场员工与专家团一律自主。

**审批语义在 `autonomous` 下翻转为白名单例外制**(`llmApiExecutor.ts:339-343`):

```ts
const needApproval = effectiveMode === 'autonomous'
  ? autonomousApproval !== null              // 只有显式标注例外的工具才拦
  : tool.risk !== 'safe' && (...)            // 旧模式:按 risk 逐步拦
```

项目目录内的读、写、建目录、删除**一律不产生审批**。人类只做最终验收。仅四类保留一次确认,由工具上的 `autonomousApproval` 声明:

| 例外类型 | 覆盖范围 |
|---|---|
| `outside_workspace` | shell 执行、桌面控制、越界文件操作 |
| `network` | 非 GET 的 `http_request`、外发类工具 |
| `install` | `install_package` |
| `admin` | `danger` 级 MCP 工具、`delegate_task` |

**新增工具时,若动作发生在项目目录内且可逆,不要加 `autonomousApproval`**;属于上述四类才加,并选准类型。

**目录即唯一边界。** 既然不再逐步审批,`resolveInWorkspace`(`executor/tools.ts:167`)就是唯一安全边界:它同时拒绝词法越界与符号链接逃逸(`realpathSync.native` 比对最近存在祖先)。**所有文件类工具必须经它解析,禁止直接调 `fs`。** 项目目录经 `projectWorkspaceResolver` 下发(`orchestrator.ts:149-170`、`teamEngine.ts:111`),员工与专家团各自继承所属项目目录。

维护这三条不变量(已核验通过,改动 `executor/` 时必须复查):

1. **模型参数决定的路径 100% 经 `resolveInWorkspace`。** 其余 `mkdirSync` 只创建宿主下发的 workspace 本身。
2. **`risk` 为 `write`/`danger` 的工具必须有 `autonomousApproval` 标注。** 当前违反数为 0 —— 不存在"既危险又不拦"的工具。
3. **能力开关同时约束暴露与执行。** `toolsForPermission` 过滤后的列表既给 LLM,也是 `llmApiExecutor.ts:306` 执行查找的依据,模型凭空写出的工具名查不到。

**已知例外:`computer_screenshot`** 为 `risk: 'safe'` 且无审批标注,自主模式下静默执行,但截取整个桌面,**不受项目目录约束**。唯一闸门是 `computer` 能力开关。授予该能力等同于授予桌面可视范围的读取权。

### 项目产物浏览(`projectArtifactService.ts`)

真实文件系统浏览 + 内嵌预览,独立 `aibox-project:` 特权协议 + 15 分钟 grant token,挂载于 Quest 工作台。安全依赖三层:主进程协议响应头 CSP、渲染侧注入的 CSP meta、iframe `sandbox`(未给 `allow-scripts`)。**产物由 AI 写入、可能被提示注入污染,修改预览逻辑时不得削弱任一层。** 已知待修:两处 CSP 的 `script-src` 不一致;类型判定仅靠扩展名(无 magic byte/hash);128 MB 同步读会阻塞主进程。

### 诚实执行原则(不可违反)

引擎不可用时必须如实停在 `SETUP_REQUIRED` / `FAILED`,**绝不允许**生成 `COMPLETED` 或虚构产物。任务文本不等于成果:声明产出文件时必须真实存在、可打开、可校验。

以下为默认关闭的历史演示路径,新代码不得依赖,修改相关模块时优先移除:`SimulatedExecutor`、`executionMode: demo`、`demoAutoTasks`(orchestrator)、`seedDemoData`(seed.ts,写入行标记 `is_demo=1`)、QQ 演示渠道(`Channels.tsx`)。测试替身只能放在 `tests/` 并经依赖注入进入,不得被生产配置选中。

### 持久化

sql.js(SQLite WASM,零原生编译),数据库位于 `userData/aibox-data/aibox.db`,变更后防抖导出;`database.ts` 负责 schema 迁移与审计日志。

## 安全基线(不可违反)

- `contextIsolation: true` + `nodeIntegration: false`,禁止修改;Renderer 中禁用任何 Node.js API
- 密钥只经 `safeStorage.encryptString()` → base64 → SQLite `settings` 表(key 前缀 `secret:`);**绝不**进入 Renderer/localStorage;Renderer 仅可调用 `storeSecret(ref, secret)` / `hasSecret(ref)`,不可读取明文;每次密钥操作写 AuditLog
- 外部链接一律 `shell.openExternal`,禁止 BrowserWindow 内导航
- 新 IPC channel 必须在 `ipc.ts` 白名单注册,禁止绕过 preload 访问 `ipcRenderer`

## 测试约定

- vitest 3,node 环境,`globals: true`,测试位于 `tests/**/*.test.ts`
- Electron mock:`tests/__mocks__/electron.ts`(配合 `vi.mock('electron')` 使用)
- Database mock:`tests/helpers/mockDb.ts`(内存 Map 模拟 prepare/get/all/run 接口,含 seed 辅助函数)
- 现有测试文件普遍以 `// @ts-nocheck` 开头,主进程模块以 `.js` 后缀导入(ESM)

### 已知覆盖缺口(修改相关代码时必须补齐)

当前基线 1554 passed + 2 skipped(145 测试文件)。曾出现「全绿却漏掉两个确定性 P0」,原因是覆盖面偏向模块内部行为:

**`.mjs` 不得带 shebang。** `runtime/**/*.mjs` 一律以 `node <path>` 显式调用,`#!` 只是装饰;但 Vitest 的 ESM transform 会把 `#!` 当作非法 token,导致**导入它的测试文件整体解析失败**,报错却指向 import 语句所在行,极易误判为 vitest/vite 的解析 bug(曾因此让 8 个测试静默失效)。

- **IPC 契约层无测试**:多数 IPC 只在 service 层被测,绕过了 `ipc.ts` 的参数校验。新增或修改 IPC 时必须从 `window.aibox.*` 公开 API 驱动。
- **跨模块业务闭环无测试**:没有任何测试覆盖「下令 → 澄清 → 计划 → 批准 → 派工 → 产出可打开成果」的完整链路。
- **确定性 fixture 只证明治理与持久化契约**，不证明真实 Provider、Hermes transport、CLI、桌面 UI 或手机 UI 可用。产品级结论必须引用真实黑盒证据和错误日志。
