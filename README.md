# OPC-Nexus · 单人公司的智能枢纽

> 本地优先的桌面 AI Agent 管理器，为单人公司提供 AI 数字员工统一智能枢纽。

## 简介

OPC-Nexus（One Person Company Nexus）基于 Electron + React 构建，管理 AI Agent 的全生命周期：任务编排、引擎接入、消息渠道、工作流自动化、专家团协作和系统资源监控。

## 核心能力

- **数字员工管理** — Agent 创建/配置/启停，四层状态机驱动
- **任务编排** — 队列调度、人工审批、中断恢复
- **多引擎接入** — CLI / LLM API / ACP 协议 / 模拟执行
- **专家团协作** — 主 Agent 调度、多角色协同、模板快速组建
- **消息渠道** — 企业微信 / 飞书 / 个人微信长连接
- **工作流引擎** — 可视化 DAG 编排，支持 Coze / Dify 节点
- **MCP & Skills** — MCP Server 管理、技能市场
- **多供应商路由** — 多 LLM 供应商 API Key 隔离、按模型路由
- **多机协同** — 局域网节点发现、Git 同步、任务分发
- **系统监控** — CPU / 内存 / GPU / 磁盘实时采集

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
| 测试 | vitest 3 |
| 打包 | electron-builder 26 |

## 目标平台

- Windows 10/11（首发）
- Ubuntu 22.04+

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

# 打包 Linux
npm run pack:linux
```

## 项目结构

```
src/
├── main/               # Electron 主进程
│   ├── index.ts        # 入口：窗口、托盘、单实例锁
│   ├── ipc.ts          # IPC 白名单注册
│   └── services/       # 业务服务层
│       ├── orchestrator.ts     # Agent/Task 编排与状态机
│       ├── database.ts         # sql.js 持久化
│       ├── engineManager.ts    # 引擎管理
│       ├── channelManager.ts   # 消息渠道
│       ├── providerManager.ts  # 多供应商管理
│       ├── workflowEngine.ts   # 工作流引擎
│       ├── teamEngine.ts       # 专家团引擎
│       ├── collabManager.ts    # 多机协同
│       ├── mcpManager.ts       # MCP 管理
│       ├── skillManager.ts     # 技能管理
│       ├── scheduler.ts        # 定时调度
│       ├── approvalBroker.ts   # 审批代理
│       ├── resourceMonitor.ts  # 资源监控
│       ├── webServer.ts        # 局域网 Web 服务
│       ├── executor/           # 执行器
│       └── channels/           # 渠道实现
├── preload/            # contextBridge 桥接
├── renderer/           # React SPA
│   └── src/
│       ├── App.tsx             # 布局 + 路由
│       ├── store.ts            # Zustand 全局状态
│       ├── pages/              # 功能页面
│       ├── components/         # UI 组件
│       └── wizard/             # 创建向导
└── shared/             # 跨进程共享类型
    └── types.ts
```

## 架构原则

- **四层状态模型** — Agent / Task / Engine / Channel 各自独立状态机
- **IPC 白名单** — 所有 Renderer→Main 通信经 `ipc.ts` 显式注册
- **密钥安全** — safeStorage 加密，密钥永不进入 Renderer
- **单向依赖** — renderer → preload → main → shared

## 文档

详细文档见 [src/docs/](./src/docs/)：

- [架构设计](./src/docs/architecture.md)
- [功能文档](./src/docs/features.md)
- [API 参考](./src/docs/api-reference.md)

## 作者

**feryice** <y@senke.com>

## License

Private — All Rights Reserved
