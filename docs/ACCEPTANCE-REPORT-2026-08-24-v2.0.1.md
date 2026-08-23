# v2.0.1 验收报告：受管 Codex/Pi 运行时与项目插件

日期：2026-08-24
分支：`codex/v2.0.1-builtin-runtimes`

## 目标

验证 v2.0.1 的两个变化是否是真实可用能力，而不是引擎列表里的占位状态：

1. Codex CLI 与 Pi Agent 能从应用目录中的固定版本运行时启动。
2. Hermes 项目可以使用同一插件中心选择的 Skill 和 MCP，并经过 Main 项目策略与审计。

## 运行时结果

`npm run agents:prepare` 在 Windows x64 本机准备了应用内闭包，未修改全局 npm 安装：

| 引擎 | 包 | 版本 | 入口验证 |
| --- | --- | --- | --- |
| Codex CLI | `@openai/codex` | `0.149.0` | `codex-cli 0.149.0` |
| Pi Agent | `@earendil-works/pi-coding-agent` | `0.84.2` | `0.84.2` |

`npm run agents:verify` 通过。运行时优先级为：安装包 `resources/agent-runtimes` -> 用户目录受管副本 -> PATH；每一级都要经过真实 `--version` 探测，不能仅因发现文件就显示 HEALTHY。

## 自动化门禁

- `npm run typecheck`：通过。
- `npm test -- --run`：127 个测试文件通过，1254 个测试通过，1 个跳过。
- `npm run build`：通过。
- `npm run hermes:smoke`：Dashboard、API Server、session token、bearer token、tool catalog 全部通过。
- 应用内运行时校验：Codex/Pi 包版本、入口、打包目录缺失均有测试覆盖。

## 真实项目插件闭环

命令：`npm run acceptance:plugins`
证据：`tmp/acceptance-hermes-project-plugins/2026-08-23T20-20-23-313Z/report.json`

结果：**PASS**

- 使用真实 Provider 读取上游模型列表。
- 动态创建随机内容 Skill，并绑定到新项目。
- 启动真实 stdio MCP，发现 `echo_marker` 工具。
- 项目只选择本轮 Skill 与 MCP，打开嵌入式 Hermes Workbench。
- Hermes 项目目录中生成了带随机验收标记的 `SKILL.md`。
- 通过 `/skill` 得到随机 Skill 内容，证明不是读取历史或 Mock 文本。
- 通过 `/mcp` 调用真实 MCP 工具，调用日志和返回值均包含本轮随机标记。
- Main 侧产生 3 条审计记录，包含 Hermes 命令和 MCP 调用。
- 截图证据：`tmp/acceptance-hermes-project-plugins/2026-08-23T20-20-23-313Z/quest-project-plugins.png`

## 结论

v2.0.1 的运行时和 MCP/Skills 项目级链路已通过本轮验收。没有把 Codex/Pi 的 `--version` 启动成功错误地宣称为 Provider 任务健康；真实模型探活仍由引擎页的“验证可用性”执行。复杂官网交付的完整多员工闭环仍应继续运行已有 `acceptance-real-workflows.cjs`，并保留独立验收员工的真实 `PASS/FAIL/BLOCKED` 结论。
