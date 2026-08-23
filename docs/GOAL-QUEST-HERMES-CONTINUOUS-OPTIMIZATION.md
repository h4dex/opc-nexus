# Goal：Quest/Hermes 人类总指挥闭环

目标 ID：`01a010ca-fe9e-7222-a1b5-dbb19c0b274e`

## 交付目标

OPC-Nexus 的默认工作方式必须是：老板下令，Hermes 理解并澄清边界，按真实能力组建数字员工或子 Agent，经过治理和批准后执行，最后交付可打开、可预览、可运行、可发送的真实成果。

Hermes 是 Quest 的唯一调度器；DSH、Codex、Claude、Pi、ACP/A2A 和手机员工只属于受治理的执行层。项目不强制绑定单一员工，但可以设置固定员工池；未设置时由 Hermes 动态组队。

## P0：身份与会话一致性

- 员工卡片上的“在 Quest 中使用”必须携带员工 ID，不得只跳转到项目中心。
- 选择项目后创建带员工身份的独立 Hermes conversation，并把该 conversation 作为嵌入 Web UI 的初始 Tab。
- 会话身份必须同时出现在 Tab、助手消息署名、系统上下文、记忆策略和任务路由中。
- 旧版本没有身份指纹的 Hermes session 不得继续复用；第一次恢复时自动轮换为干净 session。
- `@员工` 和 `/agent` 只改变委派目标，不改变当前对话助手身份。
- 长期、短期、无记忆员工必须在跨 Tab、重启、重试后保持各自边界。
- 从全局员工卡片进入 Quest 时必须先显式选择项目；项目选项要在创建会话前显示动态组队、固定池允许或固定池拒绝，不能先创建坏 Tab、发送后才报错。

验收证据：员工 ID、conversation ID、Hermes session ID、身份指纹、消息署名、实际 Task agent ID 必须可在日志和报告中互相对应。

## P1：老板下令到真实交付

1. 选择项目或从员工卡片进入 Quest。
2. 确认项目目录、Provider、模型、执行权限和员工池。
3. 简单任务直接回复；复杂任务先提出真实澄清问题。
4. 老板回答后生成 Hermes 计划草案，Main/DSH 治理层校验版本、哈希、预算、权限和 DAG。
5. 老板批准后创建真实 Job/Run/Task，显示每个员工、Worker、子 Agent 的状态和进度。
6. 流式回复期间允许继续输入，后续消息按会话 FIFO 排队；失败必须显示真实原因、重试、暂停、取消入口。
7. 交付生成 `DeliveryManifest`，支持目录、文件、Markdown、图片、视频、Mermaid、启动命令、截图和渠道发送。

## P2：渠道与手机监管

- 桌面、手机 Web、微信、企微、飞书必须进入同一个项目 conversation。
- 每条远程指令带 `projectId`、`principalId`、`conversationId`，批准、暂停、取消写入审计。
- 手机二维码只创建当前项目的 Hermes 对话会话；不提供第二套 Viewer、DSH 控制台或全局管理入口。
- Hermes 停止时手机显示真实离线或 `503 runtime_unavailable`，不得伪装在线。
- 没有真实凭据的渠道标记 `BLOCKED`，不能用 Mock 结果代替验收。

## P3：持续质量门禁

- 每轮真实用户验收必须覆盖：卡片选择、项目切换、会话创建、身份、记忆、发送、流式、排队、澄清、批准、派工、交付、预览、手机和渠道。
- 必须执行 `npm run typecheck`、`npm test`、`npm run build`，再执行 Electron 桌面和移动黑盒场景。
- 失败分为 `FAIL`、外部条件不足分为 `BLOCKED`；不把页面可打开等同于功能完成。
- 禁止 Mock、baseline 伪计划、自动伪成功、虚构员工/任务/交付和重复旧调度入口。
- 日志写入软件同目录 `user/logs/`，调试日志不得包含 Provider 密钥、session token 或手机配对密钥。

## 本轮完成

- 修复旧 Hermes session 复用导致的“`@后端工程师` Tab 回复仍自称 Cordis”问题。
- 新增 `identity_key` 绑定字段和旧库兼容迁移；无指纹或指纹变化时自动建立隔离 session。
- 员工卡片现在直接进入 Quest，并预创建该员工 conversation，再由嵌入 Hermes Web UI 打开对应 Tab。
- 新增旧身份轮换回归测试和员工卡片入口契约测试。
- 为项目任务增加显式 `requiresArtifacts` 策略：复杂交付保持真实 Manifest 门禁，明确无文件的简单 `@` 派工可以返回文本并正常完成。
- 收紧身份验收脚本：必须等待任务真实终态，只有 `COMPLETED` 才能通过；仅有任务 ID 或路由正确不再算成功。
- 修复 Nexus 多轮工具历史遇到真实 OpenAI-compatible Provider HTTP 400 时的兼容重试，并将 Hermes 项目/员工 `max_tokens` 收敛到 16384。
- 保留上一轮 HTTP 400 的失败证据，同时完成同一 Provider、同一模型的 compat-r3 真实复验，不使用旧产物覆盖结果。
- 修复全局员工卡片静默猜测“最近项目”的操作逻辑，改为显式项目选择；固定员工池不包含该员工时选项直接禁用。
- Main 在 `createHermesProjectConversation` 再做一次固定员工池 fail-closed 校验，Renderer 绕过或竞态都不能创建无权员工会话。
- 新增真实 Electron 卡片验收：从两张员工卡片点击、选项目、进入对应 Tab、通过可见输入框提交异步队列；运行期间输入框仍可编辑，最终助手署名和回复身份必须一致。
- 将员工 `memoryMode` 从身份提示升级为 Hermes 运行时强约束：`none` 不向模型传递旧历史，`short_term` 只使用当前 Hermes session，`long_term` 使用项目内员工专属文件目录。
- Hermes Session 持久化 `nexus_memory_policy` 和 `nexus_managed`；模式或 scope 不能在同一 Session 内切换，派生 Session 必须继承策略。
- 长期记忆只启用 Hermes 内置文件 MemoryStore；外部记忆 Provider 在 Nexus 员工会话中关闭，避免绕过员工目录隔离。
- `HermesServiceManager` 自己创建会话画像表，不再隐式依赖治理服务初始化顺序。

## 2026-08-20 compat-r3 复验结果

证据：`tmp/acceptance-real/2026-08-20-compat-r3/report.json`

- 真实 Provider `https://api.quya.org` + `deepseek-v4-pro-0813` 完成 24/24 步骤，Renderer console error 为 0。
- 选择不同数字员工后，Tab、Hermes session 身份指纹、固定系统上下文、助手署名、`@` 委派目标和真实 Task `agentId` 一致；三种记忆策略员工均建立独立会话。
- 复杂任务真实走通 `clarify -> PROJECTED plan -> version/hash -> APPROVED -> DISPATCHED -> Worker DAG -> COMPLETED -> verified DeliveryManifest -> 本机预览 -> 桌面/移动截图`。
- 真实 `@员工` 简单派工最终 `COMPLETED`，并生成 `deliverables/acceptance-title.md`；无文件任务不会凭空生成 Manifest。
- 手机 Hermes Chat 项目权限、同源校验、跨项目 403 和 Hermes 停止后的 `503 runtime_unavailable` 通过；DSH 第二调度器被拒绝。
- 本轮仍未覆盖实体手机视觉触控、真实微信/企微/飞书凭据、长期记忆跨重启、暂停/取消/崩溃恢复和生产安装包环境。

## 2026-08-20 card-r11 真实卡片复验

证据：`tmp/acceptance-card-identity/card-r11/report.json`、`tmp/acceptance-card-identity/card-r11/employee-card-tabs.png`

- 从“数字员工”表格真实点击两名员工的“在 Quest 中使用”，项目选择弹层均要求用户明确选择，不再静默绑定最近项目。
- 动态组队项目允许两名员工；已有固定员工池的项目会对池外员工显示禁用原因，避免先创建 Tab、后发送失败。
- `@验收研究员` 与 `@验收文案员` 分别创建独立 conversation，激活 Tab、助手可见署名和模型回复身份一致。
- 消息从 Web UI 输入框进入异步队列，初始状态为 `RUNNING`；运行期间输入框可继续编辑，完成后队列项移除且回复写入会话历史。
- 截图明确显示当前 `@验收文案员` Tab、老板消息、助手署名“验收文案员”和回复“身份=验收文案员”，不再用用户提示词命中代替助手可见证据。

## 2026-08-20 card-r13 记忆契约复验

证据：`tmp/acceptance-card-identity/card-r13-memory-contract/report.json`、`tmp/acceptance-card-identity/card-r13-memory-contract/employee-card-tabs.png`

- 真实 Electron UI 再次完成两名员工的卡片点击、项目选择、Tab 激活、异步发送、运行中继续输入和可见员工署名，Renderer console error 为 0。
- `验收研究员` 的数据库配置为 `long_term`，Hermes Session 保存独立 scope `employee-0247...51c9b`；`验收文案员` 为 `short_term`，保存不同 scope `employee-b897...8746`。
- 两个 Session 均保存 `nexus_managed: true`、确认后的 Provider/model lock 和各自 `nexus_memory_policy`，消息历史各为一组真实用户/助手消息。
- 此证据验证“UI 选择 -> 员工配置 -> conversation -> Hermes session -> 运行时策略”一致；长期记忆跨进程重启后的模型召回仍属于下一轮，不在本轮宣称通过。

## 本轮证据与阻塞

- 身份聚焦回归：PASS。调度、后端工程师、前端工程师的 Tab、回复身份、Hermes session 隔离和 `@` 路由一致，证据见 `tmp/acceptance-identity/2026-08-20-r2/report.json`。
- 纯对话项目任务：PASS。任务明确不创建文件时，状态为 `COMPLETED`，不生成虚构 Manifest。
- 复杂官网交付旧基线：FAIL。`tmp/acceptance-card-identity/full-r1/report.json` 记录真实 HTTP 400；该失败保留用于回归对比。
- 复杂官网交付 compat-r3：PASS。两名真实 Worker 均 `COMPLETED`，计划 hash、真实 Manifest、`npm run preview`、桌面/移动截图均可复核。
- 桌面 Smoke：PASS。Provider 未配置时 Hermes 启动被明确阻断，22 个主导航入口仍存在且无 Renderer console error。
- 员工卡片与记忆契约：PASS。最新证据见 `tmp/acceptance-card-identity/card-r13-memory-contract/report.json`；两名员工的项目选择、Tab、队列、身份、Session 绑定和运行时 memory policy 一致。

## 下一轮执行顺序

1. 在已完成协议隔离的基础上，用真实模型验证长期记忆跨重启召回、短期记忆跨 Tab 不召回和 `none` 模式同一 UI 历史可见但模型不召回；身份、记忆和实际执行 `agentId` 必须能对应。
2. 用真实操作完成暂停、取消、重试、Hermes/Worker 崩溃恢复、预算和权限阻断，确保队列与任务不会卡在伪运行状态。
3. 用实体手机完成扫码、布局、触控输入、流式输出、附件和离线恢复验收。
4. 使用真实飞书、企微、微信凭据完成消息、审批、进度和交付回执；无凭据只记为 `BLOCKED`。
5. 继续清理重复插件、旧 DSH 调度 UI 和任何未实现但可选择的功能；DSH 仅保留经治理的 CLI 执行能力。
6. 重新执行五个业务场景；复杂任务只有在真实 Worker、真实产物、Manifest、预览、截图和渠道回执均有证据时才计为 PASS。

## 2026-08-21 取消、队列与失败恢复回归

证据：`tmp/acceptance-quest-cancellation/cancel-r5/report.json`

- Main 新增持久化 `cancel_requested_at`。运行中任务收到老板取消后保持 `RUNNING`，Quest 明确显示“正在取消，等待 Hermes 停止当前执行”；只有 Hermes executor 和转录 finalizer 结算后才写入 `CANCELLED`。
- 同一 conversation 的后续指令在结算前保持排队。本轮真实 Electron 中取消请求时间为 `1787318487788`，最终取消时间为 `1787318517462`，后续指令在 `1787318518730` 才创建，未与被取消任务并发。
- 迟到的成功响应不能覆盖取消；重复取消请求幂等返回当前状态，手机网络重发或双击不会弹出错误。
- 失败任务必须先点击重试图标，再点击“确认重新执行”；Main 同时要求 `retry-failed-turn` 确认值，并审计 desktop / mobile-operator 来源。无确认请求直接拒绝。
- Hermes SSE 普通连接重置不再抛出 `ClientConnectionResetError` traceback；`asyncio.CancelledError` 仍保持传播，避免吞掉服务端任务取消。
- r5 中被取消任务真实完成 executor 结算，后续指令只执行 1 次；上游随后返回 HTTP 503，因此整轮为 `BLOCKED_EXTERNAL`，不是产品队列超时或自动重试。
- 自动门禁：TypeScript、Electron build、Hermes Web build、Hermes Python 4 个取消用例、全量 Vitest `155 files / 1638 tests` 全部 PASS。

Goal 继续保持 active。下一步优先验证 Hermes/Worker 进程崩溃恢复、暂停语义、实体手机布局与附件，然后再使用真实凭据验收微信、企微和飞书回执。

## 2026-08-22 问答框、附件与移动端增量

- 完成 Quest 原生问答框重构：输入区统一显示员工身份、职责、Hermes 状态、自动增高文本框、附件托盘、`@`、`/` 与发送操作。
- 完成图片、视频和文件的选择、复制粘贴、拖放、预览、删除、大小/数量限制，以及按 conversation 保存草稿和待发附件。
- 完成 Markdown、代码、表格、图片、视频、音频与 Mermaid 的响应式显示样式；桌面嵌入和 377 px 手机视口均无横向溢出。
- 修复手机 Hermes WebSocket 因缺少可选 Fetch Metadata 而被错误拒绝的问题，同时保留严格同源校验；项目模式也不再调用被禁止的全局 Profile API。
- 新增附件服务安全测试和桌面/手机黑盒脚本；全量门禁为 157 个测试文件、1647 个测试通过，类型检查与两侧构建通过。
- Codex CLI 与 Claude Code 已完成真实检测、Provider/模型/协议绑定，但上游认证探测超时，因此委派状态保持 `BLOCKED_PROVIDER_OR_ENGINE`，没有伪造 Worker 或成功结果。

Goal 继续保持 active。下一轮先把 CLI 探测中的插件同步耗时与 Provider 超时拆开诊断，再完成真实委派；实体手机附件/触控和真实微信、企微、飞书回执仍需外部条件验证。

## 2026-08-22 主秘书独立验收闭环

- Hermes 员工任务协议已拆分为 `execution`、`status_inquiry`、`validation`。进度询问不再因没有写文件而失败，验收也不会被错误要求创建报告文件。
- `validation` 必须关联本项目中已经 `COMPLETED` 的真实执行任务，并且验收员工不能是任一关联任务的实现员工。
- 主秘书必须通过 `nexus_task_status` 读取权威终态；仅有派发回执、`QUEUED` 或 `RUNNING` 都不能向老板宣布完成。
- 验收结果只接受首个非空白结论词 `PASS`、`FAIL`、`BLOCKED`，兼容常见 Markdown 包装；没有明确首词或任务非正常完成时统一为 `BLOCKED`。
- 每次权威验收结论写入 `hermes.employee.validation.verdict` 审计。只有 `PASS` 可以进入交付完成；`FAIL` 要求有限返工，`BLOCKED` 必须如实说明缺失条件。
- DAG 每个节点拥有独立 `expectedArtifacts`，计划产物必须恰好归属一个节点，避免研究员、实现员工同时被要求生成整套交付物。
- Browser Manager 可发现系统 Edge/Chrome；真实验收员工已完成 HTTP、浏览器导航、DOM、截图和内容检查。
- `tmp/acceptance-real/2026-08-22-r12/report.json` 完成 24/24 PASS，包含主秘书询问第三名员工验收、权威 PASS 汇总、固定池拒绝、手机项目隔离、跨 Origin、主题同步、DSH 第二调度器拒绝和离线状态证据。
- 自动门禁：TypeScript PASS；全量 Vitest PASS；Electron production build PASS；Hermes Web build PASS；独立验收聚焦测试 52/52 PASS。

Goal 继续保持 active。已完成“老板 -> 主秘书 -> 实现员工 -> 独立验收员工 -> 主秘书权威汇总 -> 交付”的真实主闭环；尚未宣称完成的外部验收仍包括实体手机触控/附件和带真实凭据的微信、企微、飞书收发与交付回执。

## 2026-08-22 Main 交付门禁下沉

- 新增 `HermesDeliveryGate`，复杂 Hermes 计划任务必须关联未参与实现的验收任务，并以 Main 读取到的首词 `PASS` 才允许进入交付完成。
- Quest 项目治理看板不再把未经独立验收的 `COMPLETED` 计划任务计入“已完成”，而是显示在“验收中”。
- 渠道终态发送统一执行同一门禁，未通过时不发送 Manifest 附件，并返回可行动的阻塞原因。
- 简单的无计划一次性 `@员工` 派工保持直达，不强制虚假的多轮验收流程。
- 回归证据：`47/47` 门禁聚焦测试通过；全量 `1667` 测试通过，类型检查、Electron 构建和桌面 Smoke 均通过。

Goal 继续保持 active。仍需用实体手机、真实微信/企微/飞书凭据和真实 CLI 写入权限完成外部条件验收，不能用当前单元测试或桌面模拟替代。

## 2026-08-22 主秘书验收与移动回归补充

- 主秘书独立验收闭环已有最新真实证据：`tmp/acceptance-real/2026-08-22-secretary-validation-current5/report.json`，24/24 PASS；主秘书先查询实现任务、再委派未参与实现的验收子 Agent，验收终态后再次用 `nexus_task_status(waitSeconds=0)` 读取权威 `validationVerdict=PASS`，交付门禁才放行。
- 新增真实移动 Web 黑盒：`scripts/acceptance-mobile-web-ui.cjs`。Electron/Hermes 启动、单一 Chat 配对、旧多角色入口拒绝、390×844 触控仿真和无横向溢出通过。
- 手机附件与历史回读阻塞已修复并重新验收：`tmp/acceptance-mobile-web/2026-08-22-hermes-chat-only/report.json` 为 8/8 PASS；真实上传 `mobile-attachment.md` 后 Hermes 回复可见，历史 API 返回 200，390x844 无横向溢出，Renderer console error 为 0。
- 手机扫码公开协议已收敛为 `createHermesMobilePairing(projectId, config?)`，不再接收或返回 Viewer/Operator 角色；旧多角色调用被拒绝，停止 Hermes 后手机真实返回 503。
- 数字员工卡片真实复验使用 Provider 返回 HTTP 502/503 时保持 FAIL，证据：`tmp/acceptance-card-identity/2026-08-22-r1/report.json`；不能用模型不可用时的页面状态伪造身份验收通过。
- 本轮手机协议收口门禁：`npm run typecheck` PASS；`npm test` 为 138 个测试文件、1450 通过、1 跳过；`npm run build` PASS；手机黑盒 8/8 PASS。

下一步继续处理 Provider 502/503、Codex 真实产物写入和 Claude 协议/模型兼容；实体手机首次证书信任与真实渠道无凭据继续保持明确阻断。

## 2026-08-22 项目共享 Skill/MCP 真实闭环

- 新增 `scripts/acceptance-hermes-project-plugins.cjs` 和确定性 stdio MCP 夹具；每轮动态生成 Skill、MCP、项目和随机标记，避免历史结果或静态 Mock 通过。
- 真实 Provider `https://api.quya.org` + `deepseek-v4-pro-0813` 完成 7/7：项目插件选择、Hermes Skill 文件同步、`/skill` 读取、MCP 工具发现、`/mcp` 调用、子进程记录和 Main 审计均一致。
- Hermes 可见活动明确包含 `skill_view` 与 `nexus_mcp_call`；最终回复分别包含只存在于本轮 `SKILL.md` 和 MCP 子进程返回值中的随机标记。
- SQLite 记录两条 `hermes.quest.command=accepted` 和一条 `hermes.mcp.call=ok`，项目、server、tool 身份均可追溯。
- 门禁：TypeScript PASS；Skill/MCP 聚焦 `33/33`；全量 Vitest `1468 passed / 1 skipped`；Electron production build PASS。

Goal 继续保持 active。Codex CLI 已有真实文件写入和同 Session 续作证据；Claude Code 当前被中转站明确拒绝 Anthropic `/v1/messages`，继续保持外部协议阻断。下一步仍需真实微信/企微/飞书凭据、实体手机首次证书信任，以及更多生产第三方 MCP 的独立验收。
