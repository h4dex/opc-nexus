# OPC-Nexus Quest / Hermes / DSH 验收报告

- 验收日期：2026-08-19（Asia/Shanghai）
- 验收平台：Windows x64
- 产品版本：2.0.0
- Hermes：v0.19.0，内置 Python 3.11.15
- 真实模型服务：`https://api.quya.org`（密钥未写入报告、源码或日志）
- 最终验收对象：Windows `win-unpacked` 与 NSIS 安装包

## 1. 验收结论

**本轮核心闭环通过，可作为内部测试版交付；正式全量发布仍为有条件放行。**

最终在打包程序上执行的真实验收为 **22 PASS / 0 FAIL**。已经证明：

1. Quest 能启动项目隔离的 Hermes v0.19.0 服务，并以内嵌 Web UI 工作。
2. Provider 可安全配置、一键读取 15 个真实上游模型，并手动选择项目模型。
3. 简单任务可以不经过多轮计划，直接得到真实模型回复。
4. Hermes 可以通过 `@数字员工` 调用 OPC-Nexus 中的真实员工和执行引擎。
5. 员工任务进入主进程状态机，经过中风险文件写入审批后生成真实文件。
6. 动态组队项目不强制绑定员工；固定员工池会拒绝越界员工。
7. 长期、短期、无记忆三种员工配置可创建，员工拥有独立会话 Tab。
8. Quest 只允许 Hermes 作为调度器；DSH 保留为执行 CLI/会话事实层，不能再被配置为第二调度器。
9. Hermes 与 DSH 手机入口的同源请求成功，跨域请求被拒绝。
10. 调试日志写入 `user/logs/`，检查未发现 API Key 泄漏。
11. Hermes Chat 不再卡在 `Loading chat...`；亮暗主题真实改变像素并保持稳定。
12. 未实现的 QQ、本地语音和旧直接聊天入口不会以可用能力出现。

本报告不把以下未完成真实验证的能力标记为通过：复杂任务完整计划 DAG、真实飞书/企微/微信收发、实体手机浏览器操作、Web 项目一键启动预览、安装包代码签名。

## 2. 本轮关闭的问题

### 2.1 Hermes 与员工割裂

Hermes API Server 项目会话现在强制启用 Nexus `planning` 工具集，可见并可调用：

- `nexus_delegate_task`
- `nexus_submit_plan`
- `nexus_mcp_call`

真实 `@验收文案员` 测试创建了 OPC-Nexus Task，回执只返回任务真实状态，没有把 `RUNNING` 伪报为完成。员工最终通过 Nexus 执行引擎完成任务，并写入预期交付物。

### 2.2 Quest 内嵌界面卡住

根因是项目模式仍等待 Hermes Dashboard 插件发现接口。当接口未返回时，Chat 永远不挂载。现在项目模式不加载 Hermes 的机器级 Dashboard 插件，插件和 MCP 仍由 OPC-Nexus 主进程统一管理。

验收结果：

```text
Loading chat... = false
聊天输入框可见 = true
默认路由 = /chat
默认语言 = 简体中文
```

### 2.3 主题标记与真实画面不一致

Hermes ThemeProvider 原先会覆盖 Main 注入的主题。本轮增加宿主主题契约，并修复 Main 发出事件早于 React 监听器挂载的竞态。

最终证据：

| 模式 | 背景变量 | 导航文字 | 平均亮度 |
|---|---|---|---:|
| 暗色 | `#0b0e14` | 可见 | 约 15.1 |
| 亮色 | `#f7f8fa` | `rgb(24, 32, 51)`，opacity 1 | 约 241.0 |

中间复测曾真实捕获“先亮后暗”的失败，修复后在源码运行和打包程序上均稳定通过。

### 2.4 DSH 手机 Origin Denied

DSH LAN Gateway 使用真实随机端口并在 Runtime READY 后重新绑定可信上游。本轮结果：

```text
同源 Pairing / Runtime 请求 = HTTP 200
跨域请求 = HTTP 403
```

这证明原来的 `origin denied` 已按安全边界修复，而不是关闭 Origin 校验。

### 2.5 Quest Hermes 调度面板与实时进度

Quest 内嵌 Hermes Chat 现在直接显示项目级调度投影，而不是静态说明：

- 调度器状态、动态组团/限定员工池、并发上限、权限模式和沙箱。
- Hermes 计划版本和当前状态。
- 当前任务对应的数字员工、执行引擎、任务状态和百分比进度。
- Worker/子 Agent 会话、会话类型（固定员工、动态子 Agent、外部 Worker）和运行状态。
- 同一项目的任务状态变化通过 `/__opc_nexus/project/events` WebSocket 推送，面板立即刷新；4 秒轮询仅作为断线兜底。
- DSH 的数据只作为执行层的任务、运行和会话事实投影，页面不再把 DSH 显示为调度入口。

本轮回归验证：`npm run typecheck`、`npm run build`、Hermes Web typecheck/build，以及主工程 **153 个测试文件 / 1603 项通过**；Hermes Chat 调度面板源码契约测试和项目 WebSocket 代理测试均通过。

## 3. 打包版真实场景

最终证据目录：

```text
E:\Develop\AiBoxDash\tmp\acceptance-real-packaged\2026-08-19-final\
```

### 场景 A：个人工作室简单指令

老板指令要求不规划、只用一句中文确认。Hermes 使用真实项目模型 `deepseek-v4-pro-0813` 返回：

```text
已收到真实业务闭环验收项目。
```

结果：通过。简单需求未强制进入多轮确认。

### 场景 B：小型内容工作室派工与交付

老板在员工独立会话中 `@验收文案员`，要求创建不超过 20 字的验收标题并写入指定文件。

真实结果：

```text
Task: 9f3257c6-0bef-46f4-a153-4ff6a93ee9e5
初始回执: RUNNING
最终状态: COMPLETED
审批: write_workspace / medium
交付文件: deliverables/acceptance-title.md
文件内容: 项目验收顺利通过
```

Hermes 在派工时明确说明任务仍为 `RUNNING`，没有提前声称完成。文件存在且非空后才由验收脚本判定通过。

### 场景 C：动态团队与固定员工池

项目初始 `workerAgentIds=[]`，表示允许 Hermes 根据任务动态选择可用员工。随后将项目切换为只允许研究员，再请求文案员执行。

真实结果：HTTP 422，提示“无法使用未授权或不可用的数字员工”。

结果：通过。项目不必绑定员工；一旦配置固定池，越界调度会失败关闭。

### 场景 D：三种员工记忆策略与多 Tab

创建了三个独立员工：

| 员工 | 记忆策略 | 会话 |
|---|---|---|
| 验收研究员 | `long_term` | 独立 Tab |
| 验收文案员 | `short_term` | 独立 Tab |
| 验收校对员 | `none` | 独立 Tab |

Hermes 主会话与三个员工会话共 4 个会话，关闭 Tab 不删除会话，支持右键/按钮弹出独立窗口的接口已存在。

本轮验证了配置、隔离和会话持久化；没有用跨重启长对话验证长期记忆召回质量。

### 场景 E：移动监管与执行层状态

- Hermes Operator 配对成功，项目状态接口返回 HTTP 200。
- Quest 项目始终使用 Hermes 作为调度器；DSH 仅作为允许的执行 CLI，不提供第二个调度入口。
- DSH Provider 预检为 READY，LAN Gateway 成功绑定真实 Runtime。
- DSH 同源访问 200，恶意跨域访问 403。

结果：接口和安全边界通过；未使用实体手机完成视觉与触控验收。

## 4. 自动化门禁

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | PASS，零错误 |
| `npm test` | 152 个文件通过，1 个条件跳过；1595 项通过，2 项跳过 |
| `npm run build` | PASS，生成 main / preload / renderer |
| Hermes Web typecheck/build | PASS |
| Hermes Web tests | 19 个文件、106 项全部通过 |
| `npm run hermes:verify` | PASS，Fork、commit、Python 3.11.15 匹配 |
| `npm run hermes:smoke` | PASS，Dashboard 与 API Server 均要求认证 |
| `npm run desktop:smoke` | PASS，22 个导航、无 Renderer 错误 |
| 打包程序桌面 smoke | PASS |
| 打包程序真实工作流 | 22 PASS / 0 FAIL |
| 手机 APK | 只校验现有 release 产物，通过；未重新构建 |

桌面 smoke 还验证了：没有批准的项目工作目录时，Hermes 保持 `stopped` 并明确拒绝启动，不会伪造健康状态。

## 5. Mock 与安全检查

| 项目 | 结果 |
|---|---|
| QQ 无真实 Adapter 时隐藏 | PASS |
| 未实现本地语音模式隐藏 | PASS |
| 旧直接聊天/Secretary 生产入口移除 | PASS |
| 未选择工作目录时失败关闭 | PASS |
| 固定员工池越界拒绝 | PASS |
| Hermes token 不进入 URL/localStorage | 由代理与测试覆盖，PASS |
| Provider Key 只经 safeStorage/进程环境 | PASS |
| Hermes config 不含 Provider Key | PASS |
| `user/logs` 日志密钥扫描 | 1 个 JSONL，0 个泄漏文件 |
| 跨域手机请求 | HTTP 403 |

## 6. 界面证据

```text
E:\Develop\AiBoxDash\tmp\acceptance-real-packaged\2026-08-19-final\hermes-workbench-dark.png
E:\Develop\AiBoxDash\tmp\acceptance-real-packaged\2026-08-19-final\hermes-workbench-light.png
E:\Develop\AiBoxDash\tmp\desktop-smoke-packaged\2026-08-19-final\project-center.png
E:\Develop\AiBoxDash\tmp\desktop-smoke-packaged\2026-08-19-final\quest-empty.png
```

结构化结果：

```text
E:\Develop\AiBoxDash\tmp\acceptance-real-packaged\2026-08-19-final\report.json
E:\Develop\AiBoxDash\tmp\desktop-smoke-packaged\2026-08-19-final\report.json
```

## 7. 交付物

Windows 安装包：

```text
E:\Develop\AiBoxDash\release\数字员工 AI Box-Setup-2.0.0-x64.exe
大小: 399,234,783 bytes
SHA-256: 03312A30C015AFBA3BCFA50234A7AA22D13E260A76ADD1E3389B068BDFF829F4
```

解压运行目录：

```text
E:\Develop\AiBoxDash\release\win-unpacked\
```

真实场景交付文件：

```text
E:\Develop\AiBoxDash\tmp\acceptance-real-packaged\2026-08-19-final\project-workspace\deliverables\acceptance-title.md
```

## 8. 未放行项与残余风险

### P1：复杂任务完整治理闭环尚缺真实黑盒证据

本轮确认了 Nexus 计划工具可见、Bridge schema/policy 单测通过，但没有用真实模型完整执行一次：

```text
业务澄清 -> HermesPlanDraft -> DSH plan version/hash -> 老板批准 -> 多员工 DAG -> 全部交付
```

因此不能仅凭工具注册和单测宣称复杂规划已最终放行。

### P1：真实外部渠道未验收

没有使用飞书、企微或微信的生产凭据，未验证真实消息接收、远程审批、附件发送和失败重试。当前仅验证 Main/LAN 路由与渠道相关单测。

### P1：安装包未做 Authenticode 签名

`Get-AuthenticodeSignature` 返回 `NotSigned`。外部分发时仍可能触发 Windows SmartScreen 或“未知发布者”提示。

### P2：交付项目一键运行未做打包版真实场景

Windows `npm` / `pnpm` / `yarn` 命令路径已有单测和实现修复，但本轮真实交付物是 Markdown，没有生成并启动一个 Web 项目，也没有验证运行地址及手机预览截图。

### P2：实体手机与长期记忆质量未测

手机只验证了 TLS、配对、角色、Origin 和项目接口；长期记忆只验证配置与隔离，没有验证跨重启召回准确性、遗忘策略和文件损坏恢复。

## 9. 建议的下一轮验收

1. 选择“独立开发工作室官网”作为复杂任务，完整跑通澄清、计划 hash、批准、多员工 DAG、源码目录、启动命令和双端截图。
2. 使用一个专用企微或飞书测试租户，验证下令、回答 Clarify、审批、暂停、取消、交付附件和重试。
3. 使用真实 Android/iOS 浏览器扫码，分别验证 viewer/operator 权限及电脑离线提示。
4. 为 Windows 安装包配置正式代码签名证书，再做一次全新系统安装、升级安装和卸载残留检查。

在上述 P1 项完成前，建议标记版本为“内部验收通过 / 外部发布候选”，不要宣称五类业务场景已全部端到端放行。
