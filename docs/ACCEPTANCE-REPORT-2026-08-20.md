# OPC-Nexus Quest / Hermes 验收报告

- 验收日期：2026-08-22（Asia/Shanghai）
- 平台：Windows x64
- 产品版本：2.0.0
- Hermes：v0.19.0，内置 Python 3.11.15
- 真实模型：`https://api.quya.org`，密钥未写入报告、源码或日志
- 最新真实工作流报告：`tmp/acceptance-real/2026-08-22-r12/report.json`
- 历史兼容复验：`tmp/acceptance-real/2026-08-20-compat-r3/report.json`
- 员工卡片与记忆契约报告：`tmp/acceptance-card-identity/card-r13-memory-contract/report.json`

## 结论

本报告保留此前失败记录，同时以最新真实验收 `tmp/acceptance-real/2026-08-22-r12/report.json` 作为当前状态：**桌面、嵌入式 Hermes、数字员工派工、主秘书独立验收和模拟手机 Web 闭环 PASS（24/24）；实体手机触控和真实微信/企微/飞书仍未放行。** 本轮使用真实 Provider 与 `qwen3.6-max-preview`，重新从老板命令开始生成澄清、计划、DAG、真实文件、预览和截图，并首次把“另一名员工验收 -> 主秘书读取权威结论 -> PASS 后交付”纳入硬门禁。原始失败证据继续保留，不能被新报告覆盖。

## 2026-08-22 r12 主秘书独立验收复验

证据：`tmp/acceptance-real/2026-08-22-r12/report.json`

- 完整结果为 24/24 PASS、0 FAIL；Provider 密钥未进入 Renderer、报告或调试日志。
- 老板复杂任务先产生真实澄清，回答后生成 DSH 权威计划版本 `1` 和 SHA-256 hash，再批准并派发给两名实现员工。
- 研究节点只拥有 `deliverables/site-research.md`；实现节点拥有 `web/index.html`、`web/package.json`、`web/server.cjs`，不再把全计划产物重复要求给每个员工。
- 两名实现员工终态均为 `COMPLETED`，交付 Manifest 校验通过；`npm run preview` 启动真实随机端口，HTTP 返回 200，并生成 1440x900 与 390x844 两张截图。
- 主秘书在实现结束后选择第三名 `验收校对员`，以 `intent=validation` 和两个真实实现任务 ID 派发独立验收；系统禁止实现员工自我验收。
- 验收员工真实调用 `http_request`、`browser_navigate`、`browser_get_content`、`browser_screenshot` 和 DOM 检查，任务终态为 `COMPLETED`。
- 主秘书随后调用 `nexus_task_status`，读取 Main 返回的权威 `validationVerdict: PASS` 后才向老板汇总；`FAIL/BLOCKED` 不会被正文中的乐观措辞覆盖。
- 验收结论允许以 `PASS`、`**PASS**`、`__PASS__` 或 `` `PASS` `` 开头，但不从正文中间猜测结论；没有明确首词时权威结果为 `BLOCKED`。
- 状态询问使用独立 `status_inquiry` 意图，不要求新产物，修复了截图中“汇报进度因未写文件而失败”的错误流程。
- 固定员工池越界请求返回 422；Operator 可配对、读取会话并异步发消息，Viewer 写操作返回 403，恶意跨 Origin 返回 403。
- Hermes 设置变更后先显示 Dashboard，再等待 Gateway 完整健康；服务停止后手机返回明确离线状态，不显示假在线。
- Quest 继续拒绝 DSH 成为第二调度器；DSH 仅可作为经过 Hermes/主进程策略校验的执行 CLI。

关键截图：

- `tmp/acceptance-real/2026-08-22-r12/hermes-workbench-light.png`
- `tmp/acceptance-real/2026-08-22-r12/project-workspace/.opc-nexus/delivery/5f017d70-b2d4-4251-8d8b-a690716bc009/preview-desktop.png`
- `tmp/acceptance-real/2026-08-22-r12/project-workspace/.opc-nexus/delivery/5f017d70-b2d4-4251-8d8b-a690716bc009/preview-mobile.png`

员工卡片入口最新以 `card-r13-memory-contract` 完成真实鼠标/UI 队列复验：选择不同员工后，项目选择、conversation、激活 Tab、可见助手署名、回复身份和异步队列一致；运行期间输入框可继续编辑。验收后直接核对 Hermes `state.db`，确认长期/短期员工使用不同 scope，且 Session 均持久化 `nexus_managed`。

已经确认通过的能力包括：

1. Provider 可以安全配置，一键读取 15 个真实上游模型并手动选择模型。
2. 项目可以不绑定固定员工，由 Hermes 动态派工；固定员工池会阻止越界员工。
3. 长期、短期、无记忆三种数字员工可独立创建，并拥有独立会话 Tab。
4. 简单指令直达真实回复；复杂任务已真实生成澄清、计划版本/hash、批准、DAG、Manifest、预览和截图。
5. `@数字员工` 生成真实 OPC-Nexus Task，任务 agent 路由、员工身份和结果一致；无文件简单任务现在不会被错误的 Artifact 门禁判失败。
6. Quest 只允许 Hermes 调度；DSH 第二调度器配置和已退休 DSH Quest IPC 均被拒绝或隐藏。
7. Hermes 手机 Operator/Viewer 的项目隔离、同源校验、跨域拒绝和队列访问通过。
8. Hermes 与主程序的亮色/暗色主题同步，默认简体中文，聊天输入框真实可用。
9. 调试日志写入 `user/logs/`，本轮检查未发现 Provider 密钥泄漏。
10. Hermes 停止后手机网关仍在线并返回明确的 `503 runtime_unavailable`，不再出现 `ECONNREFUSED` 或假在线。

## 本轮修复

### 员工卡片、项目选择与身份前置约束

此前全局员工卡片会静默使用最近项目。若该项目配置固定员工池且未包含所选员工，系统仍先创建 Tab，直到首次发送才报“员工已不在当前项目授权范围内”。这是操作顺序错误，不是单纯提示文案问题。

现已改为：

- 所有员工卡片、表格、右键菜单和详情入口先打开项目选择弹层。
- 动态组队项目可选择；固定池包含员工时可选择；固定池不包含员工时禁用并显示原因。
- Main 的 `aibox:createHermesProjectConversation` 在创建 conversation 前再次校验固定员工池，阻止绕过 Renderer 的非法状态。
- 无可用项目时保留弹层并给出下一步，不创建无法使用的空 Tab。

真实证据：`tmp/acceptance-card-identity/card-r11/report.json`。两名员工均通过可见输入框发送，队列初始为 `RUNNING`，输入框执行中仍可编辑，回复持久化后可见署名分别为“验收研究员”和“验收文案员”。截图：`tmp/acceptance-card-identity/card-r11/employee-card-tabs.png`。

### 手机访问与 Hermes 生命周期解耦

`stopHermesProject`、`restartHermesProject`、`emergencyStopHermesProject` 和 Quest 设置变更现在只操作 Hermes runtime，不会关闭手机 HTTPS listener。手机访问只有在用户明确调用“关闭手机访问”时才撤销。

Hermes runtime 停止时，手机请求保持可达并返回：

```json
{"error":"runtime_unavailable"}
```

这样手机 UI 可以显示“项目服务离线”，而不是把网络连接错误误显示成应用崩溃。

### 员工记忆运行时隔离

此前员工的长期、短期、无记忆选项主要体现在系统提示词，Hermes Agent 的真实历史和 MemoryStore 没有按员工策略强制隔离。这会造成 UI 显示员工已切换，但模型仍可能沿用旧会话或项目共享记忆。

现已改为：

- Main 在 Session 创建和每轮请求中下发 `nexus_memory_mode` 与不可猜测的员工 scope。
- `none` 模式不把旧消息传给模型，但 SessionDB 继续追加新消息，因此 UI 历史仍可查看。
- `short_term` 只读取当前 Hermes Session，不启用持久 MemoryStore 或 memory 工具。
- `long_term` 使用 `<HERMES_HOME>/memories/employees/<scope>/` 下独立的 `MEMORY.md`、`USER.md`，不同员工目录不能互读。
- Session 保存 `nexus_managed` 和 `nexus_memory_policy`；Hermes 将 `source: nexus` 归一化为 `api_server` 后仍保持强制策略，Fork/压缩派生 Session 也必须续接。
- Nexus 员工会话关闭外部记忆 Provider，防止其绕过项目和员工文件命名空间。

真实证据：`tmp/acceptance-card-identity/card-r13-memory-contract/report.json`。研究员 `long_term` 与文案员 `short_term` 的 UI 身份、conversation、Hermes session、员工 scope 和数据库策略一一对应，console error 为 0。此轮没有宣称长期记忆跨重启模型召回已经放行。

### 回归测试

- `tests/ipcSecurityBoundary.test.ts`：验证停止、重启、紧急停止和设置变更不调用 `hermesMobile.stopProject`。
- `tests/dshLanGateway.test.ts`：验证上游为空时 listener 仍运行，已配对请求得到 HTTP 503 和 JSON 错误。
- `tests/questRoute.test.ts`：更新源码契约，明确手机网关不属于 Hermes runtime 停止操作。

## 最新真实工作流证据（compat-r3）

报告：`tmp/acceptance-real/2026-08-20-compat-r3/report.json`

同一真实 Provider `https://api.quya.org`、模型 `deepseek-v4-pro-0813` 完成 24 个步骤，全部 PASS：

- 15 个上游模型真实读取，Provider safeStorage 配置和手动模型选择通过。
- 三种记忆策略员工、无固定员工池动态组队项目和项目级 Hermes 配置通过。
- Hermes v0.19.0 嵌入 WebContents 可用；简体中文、暗色/亮色主题同步、聊天输入和 WebSocket 队列通过。
- 员工会话分别携带真实 `employeeId`；`@员工` 任务最终为 `COMPLETED`，真实 `agentId` 和 `acceptance-title.md` 一致。
- 复杂官网任务完成 `clarify -> PROJECTED plan -> version/hash -> APPROVED -> DISPATCHED -> 两个真实 Worker -> verified Manifest -> 本机启动预览 -> 桌面/手机截图`。
- 手机 Operator 配对、同源项目会话和队列通过；Viewer 的会话/聊天写入口为 403；跨项目请求为 403。
- Hermes 停止后手机端返回真实 `503 {"error":"runtime_unavailable"}`；DSH 第二调度器配置被明确拒绝。
- `user/logs/` 调试日志密钥扫描通过，Renderer console error 为 0。

## 真实工作流证据

| 场景 | 结果 | 关键证据 |
|---|---|---|
| Provider 与模型列表 | PASS | 15 个真实模型；`deepseek-v4-flash-0731` 连通 |
| 简单任务 | PASS | 一句中文真实回复，不进入强制规划 |
| 多 Tab 与员工身份 | PASS | Hermes 主会话 + 3 个独立员工会话 |
| 员工卡片到 Quest | PASS | `card-r13-memory-contract`：真实点击、显式项目选择、异步队列、可继续输入、可见员工署名与回复一致 |
| 员工记忆协议隔离 | PASS | 长期/短期员工使用不同 scope；Session 持久化 `nexus_managed` 与 memory policy；`none` 历史输入单测验证 |
| 身份聚焦回归 | PASS | `tmp/acceptance-identity/2026-08-20-r2/report.json`：调度/后端/前端身份、Tab 竞态和 agentId 一致 |
| `@数字员工` 无文件派工 | PASS | 真实 Task 终态为 COMPLETED；不再强制生成文件 Manifest |
| 复杂官网交付 | PASS（compat-r3） | `tmp/acceptance-real/2026-08-20-compat-r3/report.json`：2 个真实 Worker 均 COMPLETED，计划 hash、Manifest 和截图可复核 |
| 本地预览 | PASS（compat-r3） | 真实 `npm run preview` 返回 `http://127.0.0.1:57690/`，桌面/移动截图均生成 |
| 固定员工池越界 | PASS | HTTP 422，明确拒绝未授权员工 |
| Operator 手机 | PASS | 配对、项目状态、会话、队列、跨域 403 |
| Viewer 手机 | PASS | 项目状态可读，会话和聊天写入口 403 |
| Hermes 停止后的手机状态 | PASS | HTTP 503，`runtime_unavailable` |

## 自动化门禁

```text
npm run typecheck                         PASS
npm test                                  155 files passed, 1 skipped；1632 passed, 2 skipped
npm run build                             PASS
npm run hermes:verify                     PASS；Hermes v0.19.0 + Python 3.11.15
Hermes Python 记忆回归                   108 passed（MemoryStore/API policy/Agent init）
npm --prefix vendor/hermes-agent/web run build  PASS
真实 Electron 工作流                    compat-r3：24/24 PASS
员工卡片真实 UI + 记忆契约               card-r13：2/2 员工 PASS；console error 0
桌面 Smoke                               22 个主导航；console error 0；PASS
```

截图证据：

- `tmp/acceptance-real/2026-08-20-compat-r3/hermes-workbench-dark.png`
- `tmp/acceptance-real/2026-08-20-compat-r3/hermes-workbench-light.png`
- `tmp/acceptance-card-identity/card-r13-memory-contract/employee-card-tabs.png`
- `tmp/desktop-smoke/2026-08-19T21-57-22-693Z/quest-workbench.png`

## 持续优化 Goal

Goal `01a010ca-fe9e-7222-a1b5-dbb19c0b274e` 保持 active。后续每轮按真实用户顺序验收，不以“页面能打开”作为完成标准：

本轮已关闭：员工会话身份串用、旧 Hermes session 复用、复杂任务的错误 Artifact 门禁、Nexus 多轮工具历史 HTTP 400 兼容、Hermes 过大 `max_tokens`、DSH 第二调度入口、手机 runtime 停止时的假离线/连接拒绝、全局员工卡片静默猜项目，以及员工记忆仅有提示词而无运行时约束的问题。“员工卡片 -> 项目选择 -> Quest -> Tab -> UI 异步队列 -> 可见助手回复 -> Hermes Session memory policy”已由 `card-r13` 真实点击和数据库证据补证。

### P0：老板下令闭环

- 继续验证澄清问题的重启恢复、过期、重复回答和多渠道统一回答。
- 验证 Hermes 动态组队、员工记忆策略和执行引擎选择在跨项目、跨重启后仍一致。
- 验证暂停、取消、重试、崩溃恢复和预算/权限阻断不会伪成功。

### P1：真实交付与监管

- 用实体手机浏览器完成扫码、布局、输入、流式输出、附件和离线恢复验收。
- 使用真实飞书、企微、微信凭据完成消息、审批、进度和交付回执验收；没有凭据时标记 BLOCKED，不隐藏为 PASS。
- 验证图片、视频、文件、Markdown、Mermaid 和交付目录的真实预览与发送。

### P2：长期质量

- 验证长期记忆跨重启召回、短期记忆边界和 `none` 模式不读取历史。
- 持续清理重复插件入口、旧 DSH UI 和任何 Mock/伪成功路径。
- 每轮保留真实日志、截图、Manifest、启动命令和审计记录，按 PASS/FAIL/BLOCKED 分类。

## 当前边界

本报告没有把以下内容宣称为完成：实体手机的视觉触控回归、真实飞书/企微/微信收发、长期记忆跨重启、暂停与进程崩溃恢复、Provider 恢复后的取消后续回复、生产环境安装包签名和多机网络环境下的长期稳定性。这些属于下一轮真实验收，不应通过模拟数据或旧产物替代。

## 2026-08-21 增量验收：Quest 取消与队列

报告：`tmp/acceptance-quest-cancellation/cancel-r5/report.json`

本轮按真实老板路径从员工卡片进入 Quest，通过可见输入框提交长任务并点击可见取消按钮。产品侧结果如下：

- `cancel_requested_at` 在 Main 数据库持久化，UI 在 Hermes 尚未退出时只显示“正在取消”，没有提前宣称成功。
- Hermes executor 结算后才显示“已由老板取消”；后续 FIFO 指令随后启动，没有与旧任务并发。
- Hermes transcript 写入取消闭合消息，错误日志未出现 `ClientConnectionResetError` 或连接关闭 traceback。
- 后续任务 `attempts = 1`，没有再次出现未确认的第二次执行。
- 失败任务重试改为 UI 二次确认 + Main 确认协议，并新增调用来源审计。

上游模型站在后续指令中连续返回 HTTP 502/503，所以报告总结果为 `BLOCKED_EXTERNAL`。这不影响取消协议本身的实证，但无法把“取消后的下一条模型回复成功”宣称为 PASS；Provider 恢复后必须用相同脚本复跑。

增量门禁：

```text
npm run typecheck                         PASS
npm test                                  155 files passed, 1 skipped；1638 passed, 2 skipped
npm run build                             PASS
Hermes Web build                          PASS
Hermes Python cancellation tests          4 passed
Electron cancellation r5                  product cancellation PASS；follow-up BLOCKED_EXTERNAL (HTTP 503)
```

## 2026-08-22 Quest 问答框与手机连接回归

证据：`tmp/acceptance-quest-composer/composer-r4/report.json`、`composer-desktop.png`、`composer-mobile.png`

- Quest 问答框改为与主程序一致的工作台式输入面板，显示当前数字员工、职责、Hermes 运行状态和发送状态；输入框自动增高并限制最大高度，长任务不再持续撑高页面。
- 支持通过文件按钮、剪贴板粘贴和拖放加入图片、视频与普通文件；附件按 conversation 隔离，提供预览、文件名、大小和移除操作。单个文件上限为 32 MiB，每条消息最多 8 个附件，越限时显示真实拒绝原因。
- `@` 员工、`/` 命令、附件和发送操作保留在输入面板底部；斜杠菜单固定显示在输入框上方，窄屏时没有被遮挡或超出视口。
- 老板消息、员工回复、Markdown、代码块、表格、图片、视频、音频和 Mermaid 使用响应式消息样式，不再把 Hermes 原始页面和 OPC-Nexus 输入区表现成两套界面。
- 桌面实测嵌入宽度为 706 px，手机实测宽度为 377 px；两端 `body.scrollWidth` 均未超过视口，所有输入控件保持可见，Renderer console error 为 0。
- 修复手机 WebSocket `origin denied`：Chromium Upgrade 请求不保证携带 `Sec-Fetch-Site`，现在仍强制校验唯一且精确匹配的 `Origin`，仅将该可选请求头改为“存在时必须为 same-origin”。伪造 Origin 和显式 cross-site 请求继续返回 403。
- 修复项目模式仍访问机器级 `/api/profiles` 的错误；项目 Quest 不再读取或切换全局 Hermes Profile，避免项目代理正确拒绝后出现误导性错误弹窗。
- 新增真实附件落盘验收：文件只能写入当前项目与 conversation 的受控目录，跨项目/跨会话访问、哈希篡改和超过 32 MiB 的文件全部拒绝；模型上下文只引用校验后的真实文件路径。

自动门禁：

```text
npm run typecheck                         PASS
npm test                                  157 files passed, 2 skipped；1647 passed, 2 skipped
npm run build                             PASS
Hermes Web typecheck                      PASS
Hermes Web build                          PASS
Quest composer desktop/mobile black-box   PASS
```

真实 CLI Worker 接入报告：`tmp/acceptance-hermes-cli-workers/2026-08-22-r1/report.json`

- `https://api.quya.org` 的上游模型列表真实读取成功，共 18 个模型；Provider 密钥未写入报告或 Renderer。
- Codex CLI `0.145.0` 与 Claude Code `2.1.220` 均被真实检测，并保存各自 Provider、模型与协议绑定。
- 两个真实认证探测均在 60 秒超时，Codex 探测期间还发生官方插件仓库同步；本轮结论为 `BLOCKED_PROVIDER_OR_ENGINE`，没有创建 Worker，也没有把超时伪装成调度成功。
- 之前 Hermes 模型调用仍有上游 HTTP 503 证据。Provider 或 CLI 探测恢复前，不能宣称 Codex/Claude 实际委派已通过。
