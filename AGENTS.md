# AGENTS.md — 数字员工 AI Box 控制中心

## 项目简介

本地优先的桌面 Agent 管理器（Electron + React），为"数字员工"提供统一控制中心。
管理 AI Agent 的生命周期、任务编排、引擎接入、消息渠道和系统资源监控。

- **技术栈**: Electron 37 + electron-vite + React 19 + Zustand + sql.js + TypeScript (strict)
- **目标平台**: Windows 10/11（首发）、Ubuntu 22.04+（同架构兼容）
- **构建产物**: `out/` 目录（main / preload / renderer 三子目录）

## 架构分层

```
src/
├── main/           # Electron 主进程（Node.js 环境）
│   ├── index.ts        # 入口：窗口、托盘、单实例锁、服务初始化
│   ├── ipc.ts          # IPC 白名单注册（唯一合法 invoke 入口）
│   └── services/       # 业务服务层
│       ├── database.ts       # sql.js 持久化（WASM SQLite）
│       ├── orchestrator.ts   # Agent/Task 编排与状态机
│       ├── engineManager.ts  # 引擎安装/认证/默认选择
│       ├── channelManager.ts # 消息渠道管理
│       ├── resourceMonitor.ts# CPU/内存/GPU/磁盘采集
│       └── seed.ts           # 初始演示数据
├── preload/        # contextBridge 桥接（Renderer 唯一入口）
│   └── index.ts        # 暴露 window.aibox API，不暴露 ipcRenderer 本体
├── renderer/       # React SPA（浏览器沙箱环境）
│   └── src/
│       ├── App.tsx         # 布局 + 路由切换
│       ├── store.ts        # Zustand 全局状态（快照订阅）
│       ├── pages/          # 页面组件（Dashboard/Tasks/Engines/Channels/System/Settings）
│       ├── components/     # 通用 UI 组件（charts/common/icons）
│       ├── wizard/         # 创建 Agent 向导
│       └── styles/         # global.css（CSS 变量主题）
└── shared/         # 跨进程共享类型（四层状态模型、实体、IPC 载荷）
    └── types.ts
```

**依赖方向**: renderer → preload → main → shared（单向，shared 不依赖任何层）

## 关键约定

### 1. 四层状态模型（不得混用）

| 层 | 类型 | 合法值 |
|---|---|---|
| Agent 生命周期 | `AgentLifecycle` | DISABLED → STARTING → READY → STOPPING，异常 → ERROR |
| 任务状态机 | `TaskStatus` | QUEUED → RUNNING → COMPLETED/FAILED/CANCELLED/INTERRUPTED；可经 WAITING_APPROVAL/PAUSED |
| 引擎状态 | `EngineStatus` | NOT_INSTALLED → INSTALLING → AUTH_REQUIRED → HEALTHY/DEGRADED/ERROR |
| 渠道状态 | `ChannelStatus` | UNCONFIGURED → CONNECTING → ONLINE/RECONNECTING/AUTH_EXPIRED/DISABLED/ERROR |

- 首页派生状态 `DerivedAgentStatus` 由编排器计算，互斥优先级：error > running > paused > starting > idle
- 状态转换只能在 `orchestrator.ts`（主进程）中发生，Renderer 不可直接修改

### 2. IPC 白名单

- **所有** Renderer→Main 通信必须通过 `src/main/ipc.ts` 中 `ipcMain.handle` 显式注册的 channel
- Channel 命名规范: `aibox:<动作>`（如 `aibox:createAgent`、`aibox:getSnapshot`）
- Preload 只暴露类型安全的函数封装，**禁止**暴露 `ipcRenderer` 本体或 `send`/`invoke` 通用方法
- 新增 IPC 方法三步走：① ipc.ts 注册 handler → ② preload/index.ts 暴露封装 → ③ renderer 通过 `window.aibox.xxx` 调用

### 3. safeStorage 密钥管理

- 密钥（API Key、Token）**绝不**进入 Renderer 进程或 localStorage
- 存储路径: `safeStorage.encryptString()` → base64 → SQLite `settings` 表（key 前缀 `secret:`）
- Renderer 仅可调用 `storeSecret(ref, secret)` 和 `hasSecret(ref)`，不可读取明文
- 每次密钥操作写入 AuditLog

### 4. 其他安全基线

- `contextIsolation: true` + `nodeIntegration: false`（不可关闭）
- 外部链接一律 `shell.openExternal`，禁止 BrowserWindow 内导航
- 工作目录必须通过 `pickDirectory` 对话框由用户选择
- 单实例锁防止 SQLite 争用

## 可用命令

| 命令 | 用途 |
|---|---|
| `npm run dev` | 启动开发模式（electron-vite dev，HMR） |
| `npm run build` | 生产构建（输出到 out/） |
| `npm run typecheck` | TypeScript 全量类型检查（tsc --noEmit） |
| `npm run start` | 预览生产构建 |
| `npm run pack:win` | 构建 + 打包 Windows x64 安装程序 |
| `npm run pack:linux` | 构建 + 打包 Linux x64 |
| `npm test` | 运行单元测试（vitest） |
| `npm run test:watch` | 监听模式运行测试 |

> 测试框架为 vitest，测试文件位于 `tests/` 目录。验证以 `typecheck` + `test` 为准。

## 禁止操作

1. **禁止**在 Renderer 中直接使用 Node.js API（`require`、`fs`、`child_process` 等）
2. **禁止**绕过 preload 直接访问 `ipcRenderer`
3. **禁止**在 Renderer/localStorage/IndexedDB 中存储任何密钥或凭据
4. **禁止**在 shared/types.ts 中引入 Electron/Node 依赖（保持纯类型）
5. **禁止**修改 `contextIsolation`、`nodeIntegration`、`sandbox` 安全配置
6. **禁止**在状态机之外直接修改 Agent/Task/Engine/Channel 状态字段
7. **禁止**引入新的 IPC channel 而不在 ipc.ts 白名单中注册
8. **禁止**跳过 `npm test` 验证，状态机变更必须有对应测试覆盖

## 验证路由

修改代码后按以下顺序验证：

```bash
# 1. 类型检查（必须通过）
npm run typecheck

# 2. 单元测试（必须通过）
npm test

# 3. 构建验证（涉及构建配置或依赖变更时）
npm run build

# 4. 运行时验证（涉及 UI/交互/状态逻辑时）
npm run dev
```

**检查清单**:
- [ ] 新增 IPC channel 已在 ipc.ts + preload 双侧注册
- [ ] 新增类型已放入 shared/types.ts 且无 Node/Electron 导入
- [ ] 状态变更逻辑在 orchestrator 或对应 Manager 中
- [ ] 无密钥泄露到 Renderer 层
- [ ] `npm run typecheck` 零错误
