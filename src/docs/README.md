# OPC-Nexus · 单人公司的智能枢纽 — 项目文档

## 项目简介

OPC-Nexus（One Person Company Nexus）— 本地优先的桌面 Agent 管理器（Electron + React），为单人公司提供 AI 数字员工统一智能枢纽。
管理 AI Agent 的全生命周期、任务编排、引擎接入、消息渠道、工作流自动化和系统资源监控。

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
| 系统信息采集 | systeminformation |
| Web 服务 | Express 5 |
| WebSocket | ws 8 |
| 测试 | vitest 3 |
| 打包 | electron-builder 26 |

## 目标平台

- Windows 10/11（首发）
- Ubuntu 22.04+（同架构兼容）

## 文档索引

| 文档 | 说明 |
|------|------|
| [architecture.md](./architecture.md) | 系统架构设计、分层模型、安全基线 |
| [features.md](./features.md) | 全部功能模块开发文档 |
| [api-reference.md](./api-reference.md) | IPC 接口与 preload API 参考 |
| [../../docs/ANDROID-DEVICE-OPERATIONS.md](../../docs/ANDROID-DEVICE-OPERATIONS.md) | Android Bridge、手机控制台、设备操作与安全说明 |

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式（HMR）
npm run dev

# 类型检查
npm run typecheck

# 单元测试
npm test

# 生产构建
npm run build

# 打包 Windows 安装程序
npm run pack:win
```

## 目录结构

```
src/
├── main/               # Electron 主进程
│   ├── index.ts        # 入口：窗口、托盘、单实例锁、服务初始化
│   ├── ipc.ts          # IPC 白名单注册（唯一合法 invoke 入口）
│   └── services/       # 业务服务层
│       ├── orchestrator.ts     # Agent/Task 编排与状态机
│       ├── database.ts         # sql.js 持久化
│       ├── engineManager.ts    # 引擎安装/认证/管理
│       ├── channelManager.ts   # 消息渠道管理
│       ├── providerManager.ts  # 多供应商管理
│       ├── workflowEngine.ts   # 可视化工作流引擎
│       ├── teamEngine.ts       # 专家团执行引擎
│       ├── collabManager.ts    # 多机协同管理
│       ├── mcpManager.ts       # MCP 服务器管理
│       ├── skillManager.ts     # Skills 技能管理
│       ├── scheduler.ts        # 定时任务调度
│       ├── approvalBroker.ts   # 人工审批代理
│       ├── resourceMonitor.ts  # 系统资源监控
│       ├── browserManager.ts   # 浏览器自动化
│       ├── webServer.ts        # 局域网 Web 管理服务
│       ├── apiBridge.ts        # OpenAI 兼容 API 代理
│       ├── executor/           # 执行器（LLM/CLI/ACP/模拟）
│       └── channels/           # 渠道实现（飞书/企微/微信）
├── preload/            # contextBridge 桥接
├── renderer/           # React SPA
│   └── src/
│       ├── App.tsx             # 布局 + 路由
│       ├── store.ts            # Zustand 全局状态
│       ├── pages/              # 18 个功能页面
│       ├── components/         # 通用 UI 组件
│       └── wizard/             # 创建 Agent 向导
└── shared/             # 跨进程共享类型
    └── types.ts        # 领域模型（纯类型，无 Node 依赖）
```
