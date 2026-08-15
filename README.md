# OPC-Nexus · 单人公司的智能枢纽

> 本地优先的桌面 AI Agent 管理器，为单人公司提供 AI 数字员工统一智能枢纽。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![CI](https://github.com/h4dex/opc-nexus/actions/workflows/ci.yml/badge.svg)](https://github.com/h4dex/opc-nexus/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/h4dex/opc-nexus?display_name=tag)](https://github.com/h4dex/opc-nexus/releases)
[![Electron](https://img.shields.io/badge/Electron-37-47848F?logo=electron)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-lightgrey)]()

---

## 简介

**OPC-Nexus**（One Person Company Nexus）是一款本地优先的桌面 AI Agent 管理器。它为单人公司 / 独立开发者提供统一的 AI 数字员工管理平台 —— 从 Agent 创建、任务编排、多引擎接入，到消息渠道集成、工作流自动化和专家团协作，一站式覆盖。

所有数据存储在本地（SQLite WASM），密钥通过 Electron safeStorage 加密，**无需云端依赖**，保障数据主权与隐私安全。

| 组件 | 当前版本 | 说明 |
|------|----------|------|
| OPC-Nexus 桌面端 | `1.8.1` | Windows / Linux Agent 管理与手机控制中心 |
| OPC-Nexus 手机桥 | `0.4.3` | Android 8.0+、无需 Root，重点验证 API 34 |

桌面端与手机桥独立维护版本号。每次功能变更验证通过后递增受影响组件的版本；用户指定版本时以指定版本为准。

## 界面预览

### 工作台

![工作台仪表盘](./docs/screenshots/dashboard.png)

### 任务中心

![任务中心](./docs/screenshots/tasks.png)

### 数字员工管理

![数字员工](./docs/screenshots/agents.png)

> 更多界面与操作说明请参阅 [用户使用手册](./docs/USER-GUIDE.md)

## 核心能力

### 数字员工管理
- 可视化创建 / 配置 / 启停 AI Agent
- 四层状态机驱动（Agent / Task / Engine / Channel）
- 独立工作区隔离，支持人设 / 权限 / 模型绑定
- Agent 克隆、市场模板一键部署
- 员工列表直接安排任务，支持通用员工与 Android 手机操作员身份

### Android 手机员工
- 无 Root Android 8.0+ Bridge，通过局域网 WSS 与桌面端配对
- Hermes Agent 独立 Profile，按设备和员工授权 42 个 `android_*` 工具
- 屏幕预览、Accessibility UI Tree、点击/输入/滑动、应用与系统操作
- 受限控制脚本、脱敏命令日志、截图/录屏/WAV 媒体产物
- 二维码、完整配置复制/粘贴和逐项手动配置三种配对方式

![OPC-Nexus 手机控制台](./docs/screenshots/mobile-console.png)

### 任务编排与执行
- 队列调度、优先级管理、有限 Worker 池与嵌套委派环路保护
- 人工审批流程（WAITING_APPROVAL 状态）
- 任务中断 / 恢复 / 取消
- 多执行器：LLM API / CLI / ACP 协议 / 模拟执行
- OPC Orchestrator 统一持有任务、审批、长期记忆和状态；DSH 作为受限 ACP Worker/Advisor，Hermes 负责 Android 手机任务

### 专家团协作
- 主 Agent 全局调度循环
- 多角色协同（产品经理、架构师、开发者、测试等）
- 预设团队模板，一键组建专家团
- 任务拆解 → 分发 → 验收闭环

### 消息渠道
- 企业微信（WebSocket 长连接）
- 飞书机器人
- 微信 iLink Bot（扫码授权，仅 AI Bot 私聊）
- 渠道状态机：连接 / 重连 / 认证过期自动处理

### 工作流引擎
- 可视化 DAG 拖拽编排（@xyflow/react）
- 内置节点：LLM 调用 / 条件分支 / 循环 / 代码执行
- 集成 Coze / Dify 工作流平台节点
- 定时触发 / 手动触发 / Webhook 触发

### MCP & 技能系统
- MCP Server 生命周期管理（安装 / 启动 / 停止）
- 技能市场：预置 + 自定义技能
- 工具调用轨迹追踪

### 多供应商模型路由
- 多 LLM 供应商管理（DeepSeek / OpenAI / 自定义）
- API Key 隔离加密存储
- 按模型 ID 智能路由
- 连接测试与健康检查

### 多机协同
- 局域网节点自动发现
- Git 仓库同步
- 跨节点任务分发与状态同步
- MCP 协作服务器

### 系统监控
- CPU / 内存 / GPU / 磁盘实时采集
- 进程级资源占用追踪
- 历史趋势图表

### 其他
- 局域网 Web 管理后台（Express + WebSocket）
- OpenAI 兼容 API 代理（apiBridge）
- 浏览器自动化（Playwright + CDP）
- 定时任务调度（Cron 表达式）
- Token / 模型调用统计
- 数据备份与恢复

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Electron 37 |
| 构建工具 | electron-vite 3 + Vite 6 |
| 前端框架 | React 19 + Zustand 5 |
| 数据库 | sql.js（SQLite WASM） |
| 语言 | TypeScript 5.8（strict） |
| 工作流可视化 | @xyflow/react 12 |
| 浏览器自动化 | playwright-core |
| Web 服务 | Express 5 + ws 8 |
| 系统信息 | systeminformation |
| 测试 | vitest 3 |
| 打包 | electron-builder 26 |
| CI/CD | GitHub Actions + CNB 云原生构建 |

## 目标平台

| 平台 | 版本 | 架构 |
|------|------|------|
| Windows | 10 / 11 | x64 |
| Ubuntu | 22.04+ | x64 |

## 环境要求

- **Node.js** >= 20.x
- **npm** >= 10.x
- **Git** >= 2.x（多机协同功能需要）
- **Android 开发工具（可选）** Java 17 + Android SDK / Build Tools（仅构建或 ADB 安装手机桥时需要）

## 快速开始

```bash
# 克隆仓库
git clone https://github.com/h4dex/opc-nexus.git
cd opc-nexus

# 安装依赖
npm install

# 开发模式（HMR 热更新）
npm run dev

# 类型检查
npm run typecheck

# 单元测试
npm test

# 生产构建
npm run build

# 打包 Windows 安装程序
npm run pack:win

# 打包 Linux
npm run pack:linux
```

## 可用脚本

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动开发模式（electron-vite，HMR） |
| `npm run build` | 生产构建（输出到 `out/`） |
| `npm run typecheck` | TypeScript 全量类型检查 |
| `npm test` | 运行单元测试（vitest） |
| `npm run test:watch` | 监听模式测试 |
| `npm run mobile:icons` | 重新生成 Android Launcher 图标资源 |
| `npm run mobile:apk:debug` | 构建并校验 Android Debug APK |
| `npm run mobile:apk:release` | 使用仓库外生产 keystore 构建 Android Release APK |
| `npm run mobile:apk:verify` | 校验内置 APK 的包名、版本、摘要与签名 |
| `npm run mobile:e2e` | 在 Android 模拟器执行 Mobile Gateway 端到端验证 |
| `npm run pack:win` | 打包 Windows x64 安装程序 |
| `npm run pack:linux` | 打包 Linux x64 |

## 项目结构

```
opc-nexus/
├── src/
│   ├── main/                   # Electron 主进程（Node.js）
│   │   ├── index.ts            # 入口：窗口、托盘、单实例锁
│   │   ├── ipc.ts              # IPC 白名单注册（唯一合法入口）
│   │   └── services/           # 业务服务层
│   │       ├── orchestrator.ts     # Agent/Task 编排与状态机
│   │       ├── database.ts         # sql.js 持久化（WASM SQLite）
│   │       ├── engineManager.ts    # 引擎安装/认证/管理
│   │       ├── channelManager.ts   # 消息渠道管理
│   │       ├── providerManager.ts  # 多供应商模型路由
│   │       ├── workflowEngine.ts   # 可视化工作流引擎
│   │       ├── teamEngine.ts       # 专家团执行引擎
│   │       ├── collabManager.ts    # 多机协同管理
│   │       ├── mcpManager.ts       # MCP Server 管理
│   │       ├── skillManager.ts     # 技能管理
│   │       ├── scheduler.ts        # 定时任务调度
│   │       ├── approvalBroker.ts   # 人工审批代理
│   │       ├── resourceMonitor.ts  # 系统资源监控
│   │       ├── browserManager.ts   # 浏览器自动化
│   │       ├── webServer.ts        # 局域网 Web 管理服务
│   │       ├── apiBridge.ts        # OpenAI 兼容 API 代理
│   │       ├── gitHttpServer.ts    # Git HTTP 服务
│   │       ├── executor/           # 执行器（LLM/CLI/ACP/模拟）
│   │       └── channels/           # 渠道实现（飞书/企微/微信）
│   ├── preload/                # contextBridge 桥接层
│   │   └── index.ts            # 暴露 window.aibox 类型安全 API
│   ├── renderer/               # React SPA（浏览器沙箱）
│   │   └── src/
│   │       ├── App.tsx             # 布局 + 路由切换
│   │       ├── store.ts            # Zustand 全局状态
│   │       ├── pages/              # 18+ 功能页面
│   │       ├── components/         # 通用 UI 组件
│   │       ├── wizard/             # 创建 Agent 向导
│   │       └── styles/             # CSS 变量主题
│   └── shared/                 # 跨进程共享类型（纯类型）
│       └── types.ts
├── tests/                      # 单元测试（vitest）
├── .github/workflows/          # GitHub CI 与跨平台 Release
├── .cnb.yml                    # CNB CI/CD 配置
├── electron-builder.yml        # 打包配置
└── electron.vite.config.ts     # 构建配置
```

## 架构设计

### 分层架构

```
┌─────────────────────────────────────────┐
│           Renderer (React SPA)          │  浏览器沙箱
├─────────────────────────────────────────┤
│         Preload (contextBridge)         │  类型安全桥接
├─────────────────────────────────────────┤
│         Main (Electron + Node)          │  业务逻辑
│  ┌─────────────────────────────────┐    │
│  │  orchestrator / engines / channels │  │
│  │  workflow / team / collab / mcp    │  │
│  └─────────────────────────────────┘    │
├─────────────────────────────────────────┤
│          Shared (纯类型定义)             │  零依赖
└─────────────────────────────────────────┘
```

### 安全基线

- `contextIsolation: true` + `nodeIntegration: false`
- 密钥通过 `safeStorage` 加密，永不进入 Renderer
- IPC 白名单机制，Preload 不暴露 `ipcRenderer` 本体
- 外部链接一律 `shell.openExternal`
- 单实例锁防止 SQLite 争用

### 四层状态模型

| 层 | 状态流转 |
|----|----------|
| Agent | DISABLED → STARTING → READY → STOPPING / ERROR |
| Task | QUEUED → RUNNING → COMPLETED / FAILED / CANCELLED |
| Engine | NOT_INSTALLED → INSTALLING → SETUP_REQUIRED / AUTH_REQUIRED → HEALTHY / DEGRADED / ERROR |
| Channel | UNCONFIGURED → CONNECTING → ONLINE / RECONNECTING / ERROR |

## CI/CD

项目同时使用 GitHub Actions 与 [CNB 云原生构建](https://docs.cnb.cool/zh/build/)：

- **Push 到 main / master**：在 Windows 与 Ubuntu 上执行 `typecheck`、`test` 和生产构建
- **Pull Request 到 main**：执行同等的双平台质量门禁
- **推送 `v*` 标签**：自动构建 Windows NSIS、Linux AppImage / DEB，并创建 GitHub Release
- **手动重跑 Release**：可在 Actions 页面输入已有标签，重新生成并覆盖安装包
- 构建环境统一使用 Node.js 22，Release 产物附带 SHA-256 校验文件

完整发布步骤、代码签名和产物说明见 [GitHub Release 发布指南](./docs/RELEASING.md)。

## 文档

| 文档 | 说明 |
|------|------|
| [用户使用手册](./docs/USER-GUIDE.md) | 界面说明、操作指南、常见问题 |
| [Android 设备操作文档](./docs/ANDROID-DEVICE-OPERATIONS.md) | Android Bridge、手机控制台、设备操作、脚本、日志、媒体与安全说明 |
| [更新日志](./CHANGELOG.md) | 版本历史与变更记录 |
| [GitHub Release 发布指南](./docs/RELEASING.md) | CI/CD、版本标签、代码签名与发布产物 |
| [架构设计](./src/docs/architecture.md) | 系统架构、分层模型、安全基线 |
| [功能文档](./src/docs/features.md) | 全部功能模块开发文档 |
| [API 参考](./src/docs/api-reference.md) | IPC 接口与 Preload API 参考 |
| [第三方组件声明](./THIRD-PARTY-NOTICES.md) | 开源依赖许可证与版权声明 |

## 作者

**feryice** <y@senke.com>

## License

[MIT](./LICENSE) © 2025 feryice

自由使用、复制、修改和商用，衍生作品可选择不开源。

本项目使用了多个开源组件，详见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。
