# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

OPC-Nexus(package 名 `aibox-control-center`)— 本地优先的桌面 AI Agent 管理器。技术栈:Electron 37 + electron-vite 3 + React 19 + Zustand 5 + sql.js(SQLite WASM)+ TypeScript strict。目标平台 Windows 10/11 与 Ubuntu 22.04+。

更详细的约定与检查清单见 `AGENTS.md`,深入文档见 `src/docs/`(architecture / features / api-reference)。

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
| `npm run pack:win` / `pack:linux` | 构建并打包安装程序 |

- 依赖安装走 npmmirror 镜像(`.npmrc` 已配置)
- CI(`.cnb.yml`,CNB 平台)在 push/PR 时执行 typecheck + test;提交前两者必须通过
- 验证顺序:`typecheck` → `test` →(涉及构建配置时)`build` →(涉及 UI 时)`dev`

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

### 四层状态模型(不得混用)

| 层 | 状态流转 |
|---|---|
| Agent(`AgentLifecycle`) | DISABLED → STARTING → READY → STOPPING;异常 → ERROR |
| Task(`TaskStatus`) | QUEUED → RUNNING → COMPLETED/FAILED/CANCELLED/INTERRUPTED;可经 WAITING_APPROVAL/PAUSED |
| Engine(`EngineStatus`) | NOT_INSTALLED → INSTALLING → SETUP_REQUIRED/AUTH_REQUIRED → HEALTHY/DEGRADED/ERROR |
| Channel(`ChannelStatus`) | UNCONFIGURED → CONNECTING → ONLINE/RECONNECTING/AUTH_EXPIRED/DISABLED/ERROR |

状态转换只能发生在主进程 `orchestrator.ts` 或对应 Manager 中,Renderer 不可直接修改。首页派生状态 `DerivedAgentStatus` 由编排器计算,互斥优先级 `error > running > paused > starting > idle`。**状态机变更必须有对应测试覆盖。**

### 执行器选择(`executor/index.ts`,按优先级)

1. Nexus 内置 Worker → `LlmApiExecutor`(已配置供应商时)
2. Hermes / Pi → 专用 CLI Executor
3. Codex / Claude Code / OpenCode → 对应 CLI Executor
4. DeepSeek Harness / 自定义引擎 → `AcpExecutor`(ACP 协议)
5. 回退 → `SimulatedExecutor`(仅演示模式)

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
