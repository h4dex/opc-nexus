# OPC-Nexus 完整修复计划与修复前测试反馈

日期：2026-08-19

## 目标口径

本轮以以下产品边界作为唯一放行口径：

- Quest 只有 Hermes 一个调度器。
- DSH 只是一种数字员工执行 CLI，不拥有 Quest 调度、计划审批、手机入口或第二套业务状态机。
- 项目可不绑定员工，由 Hermes 动态选择；配置固定员工池时必须严格限制选择范围。
- 手机 Web 与桌面使用同一项目、会话、问题、计划、任务和交付事实。
- 所有失败显示真实原因；未配置、未实现或未连接的能力不得显示在线或成功。
- 插件、MCP、Skills 由统一插件中心管理，Quest 只选择项目允许使用的能力，不再重复安装插件。

## 修复前测试反馈

### 已通过的基础门禁

- TypeScript 主工程类型检查通过。
- Hermes Web 类型检查通过。
- 全量单元测试最近一次结果为 153 个文件、1605 项通过、2 项跳过。
- Electron 主程序与 Hermes Web 生产构建通过。
- Hermes v0.19.0 Dashboard/API Server smoke 通过。
- 桌面 smoke 通过，未发现 Renderer 控制台错误。
- 手机 TLS 配对、同源 Origin、同源 Referer 回退、跨域拒绝已有自动化覆盖。

### 未达到完整放行的项目

| 优先级 | 问题 | 修复前状态 |
|---|---|---|
| P0 | DSH 仍参与 Quest 治理 | `HermesDshBridge` 仍将计划、问题和投影视为 DSH-owned facts |
| P0 | DSH Quest IPC 仍公开 | preload/Main 仍注册 answer/approve/reject/dispatch DSH Quest 接口 |
| P0 | 手机真机闭环 | 当前预览数据无 Provider，无法完成真实模型扫码对话 |
| P1 | 重复插件模块 | Quest 内仍直接安装/更新/卸载 DSH 社区插件，与插件中心重复 |
| P1 | 用户界面泄露旧架构 | Hermes 计划仍显示 `dshVersion`，类型仍暴露 DSH plan/session 字段 |
| P1 | 复杂任务真实闭环 | 缺少新版本的澄清、计划、批准、多员工 DAG、交付目录和预览证据 |
| P1 | 交付运行 | 缺少真实 Web 项目启动、运行地址和桌面/手机截图证据 |
| P1 | 外部渠道 | 飞书/企微/微信未使用真实凭据重新验收 |
| P2 | 长期记忆质量 | 已验证配置隔离，未验证跨重启召回和损坏恢复 |

## 实施计划

### 阶段 1：调度边界收敛

1. 将 Hermes 计划、澄清和委派治理改为 Nexus/Hermes 原生持久化事实。
2. 计划版本、hash、批准与派发继续由 Main 控制，但不再依赖 DSH Quest projector。
3. 删除 Renderer 可访问的 DSH Quest IPC 和 preload API。
4. 保留 DSH executor、DSH CLI 会话与运行回执，作为可选员工执行引擎。
5. 迁移旧 `dshVersion` 等投影字段到中性 `version`、`planId`、`sessionId`。

### 阶段 2：界面与插件去重

1. Quest 删除 DSH 社区插件安装/更新/卸载面板。
2. Quest 仅展示统一插件中心中可用于当前项目的 MCP、Skill、CLI、ACP/A2A 能力，并允许项目级启用。
3. 插件实际安装和机器级生命周期统一进入“插件中心”。
4. 清除老板界面中的 DSH 调度术语，仅在员工执行引擎详情中显示 DSH CLI。

### 阶段 3：手机 Web 完整闭环

1. 项目级 Provider 缺失时提供明确桌面配置入口，不创建二维码、不伪在线。
2. 验证 operator 的会话、流式输出、消息插队、澄清、批准、暂停、取消和交付。
3. 验证 viewer 只能查看状态、日志和交付。
4. 验证服务停止、应用重启、二维码过期、网络断线和 WebSocket 重连。
5. 保证关闭一个项目手机访问不会停止 Hermes 桌面服务或其他项目。

### 阶段 4：交付和真实场景

1. 简单文案任务：不强制澄清和计划。
2. 官网交付：澄清、计划批准、多人执行、真实目录、启动命令、运行地址、双端截图。
3. 电商运营方案：研究与内容员工协同，交付结构化文档。
4. 视频生产计划：30 条任务分批并发，验证队列和进度。
5. 高风险文件清理/外发：独立审批、拒绝后不可执行、审计完整。

## 放行门禁

- `npm run typecheck`
- `npm test`
- `npm run build`
- Hermes Web typecheck/build
- `npm run hermes:verify`
- `npm run hermes:smoke`
- `npm run desktop:smoke`
- HTTPS 手机黑盒
- 至少一个真实简单任务和一个真实复杂交付任务
- 新报告必须区分 PASS、FAIL、BLOCKED，不把缺少凭据或实体设备写成 PASS
