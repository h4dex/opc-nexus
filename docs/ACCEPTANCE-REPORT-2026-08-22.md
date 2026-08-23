# OPC-Nexus Quest / Hermes 验收报告

> **最新结论（2026-08-22 22:37）**：本文后续章节保留当天迭代过程。凡是写有“DSH 仍作为 CLI Worker、Runtime、Session/Supervisor 或历史任务恢复层保留”的中间结论，均已被文末《DSH 完全退役与 Hermes 手机单入口最终验收》和《旧运行时目录清除与执行取消一致性复验》覆盖，不再代表当前代码。

- 日期：2026-08-22（Asia/Shanghai）
- 平台：Windows x64，Electron 37
- Hermes：v0.19.0，项目级独立服务
- Provider：`https://api.quya.org`
- 模型：`qwen3.6-max-preview`
- 原始机器报告：`tmp/acceptance-real/2026-08-22-r12/report.json`
- 结果：**PASS，24/24，0 FAIL**

## 本轮结论

本轮已真实跑通：

```text
老板命令
  -> Hermes 主秘书澄清
  -> 生成计划草案
  -> Main 分配版本与 hash
  -> 老板批准
  -> 两名数字员工执行 DAG
  -> 真实文件、Manifest、启动命令、预览和截图
  -> 第三名数字员工独立验收
  -> 主秘书读取权威 validationVerdict
  -> PASS 后向老板汇总交付
```

主秘书不是根据实现员工的“已完成”文字直接交付。它在实现任务真实 `COMPLETED` 后，向未参与实现的 `验收校对员` 派发 `validation` 任务；校对员真实使用 HTTP、浏览器、DOM 和截图工具检查结果；主秘书再调用 `nexus_task_status` 读取 Main 的权威终态。只有 `validationVerdict: PASS` 才算验收通过。

## 修复确认

1. 员工任务区分 `execution`、`status_inquiry`、`validation`，进度汇报不再因没有新文件而失败。
2. 验收必须关联已经完成的真实执行任务；实现员工不能验收自己的工作。
3. 验收结论写入审计，主秘书必须查询终态；派发成功、排队中和运行中均不等于完成。
4. `PASS`、`FAIL`、`BLOCKED` 可使用常见 Markdown 包装，但只能出现在首个非空白词位置；正文中间出现 PASS 不会被误采信。
5. DAG 节点分别拥有自己的预期产物，不再把整套产物重复分配给每个员工。
6. 固定员工池越界请求被 Main 以 422 拒绝。
7. 修改员工池后 Hermes Dashboard 可先显示启动状态，Gateway 随后进入完整健康态；验收不再把正常启动窗口误报为失败。

## 真实证据

- 计划：version `1`，hash `7be3906b5b80c90c706392c7372d41b4b8bb097c21e43bda695a86573472a0a5`
- 实现任务：`5f017d70-b2d4-4251-8d8b-a690716bc009`、`30f7c0a7-1ecf-422e-9736-c5cea3e7d195`
- 独立验收任务：`bca32407-1698-449f-895e-86b002b5a6ee`
- 验收员工：`8ebf12dc-f419-4af2-9f4f-614528bb4749`
- 验收结论：`COMPLETED` / `PASS`
- 预览：真实 HTTP 200，包含 `OPC-Nexus Studio`、“预约咨询”和 3 个不同服务卡片
- 交付目录：`tmp/acceptance-real/2026-08-22-r12/project-workspace`
- 启动入口：`web/package.json` 的 `npm run preview`
- 桌面截图：`.opc-nexus/delivery/5f017d70-b2d4-4251-8d8b-a690716bc009/preview-desktop.png`
- 手机截图：`.opc-nexus/delivery/5f017d70-b2d4-4251-8d8b-a690716bc009/preview-mobile.png`
- Hermes 亮色验收界面：`tmp/acceptance-real/2026-08-22-r12/hermes-workbench-light.png`

## 移动与权限

- Operator 配对成功，可读取项目/会话、异步发送消息并收到持久化回复。
- Viewer 写请求返回 403。
- 伪造跨 Origin 请求返回 403。
- Hermes 停止后手机端返回明确的项目服务离线状态，不显示在线或伪成功。
- Quest 拒绝 DSH 成为第二调度器；DSH 只保留受策略约束的执行层能力。

## 自动门禁

- `npm run typecheck`：PASS
- `npm test`：PASS
- `npm run build`：PASS
- `vendor/hermes-agent/web` production build：PASS
- 独立验收聚焦测试：52/52 PASS
- 移动/服务聚焦测试：41/41 PASS
- 调试日志密钥扫描：PASS

## 未放行项

以下项目没有被本轮 24/24 结果覆盖，不能宣称完成：

- 实体手机扫码、触控、软键盘、附件粘贴和弱网恢复。
- 使用真实凭据的微信、企业微信、飞书消息、审批、进度和交付回执。
- Codex CLI、Claude Code 在当前 Provider 下的长任务稳定性和崩溃恢复全场景。
- 多项目同时运行、长时间运行和安装包升级后的记忆迁移压力测试。

这些项目应继续按 `BLOCKED_EXTERNAL` 或待验收处理，不允许用 Mock、页面可打开或单元测试替代真实证据。

## 2026-08-22 CLI Worker 复验

本轮新增真实复验脚本：`scripts/acceptance-hermes-cli-workers.cjs`。它不把二进制存在当作健康，而是先读取真实 Provider 模型列表，再分别执行 Codex Responses 和 Claude Messages 探活，随后让 Hermes 主秘书通过 `nexus_delegate_task` 派发文件任务。

已确认：

- Codex CLI `0.145.0` 在 `qwen3.6-max-preview` 下四级探活通过。
- Claude Code 使用独立 `CLAUDE_CONFIG_DIR`，不再读取用户 `~/.claude/settings.json` 覆盖项目 Provider；受管请求同时使用 `ANTHROPIC_API_KEY` 与 `ANTHROPIC_AUTH_TOKEN`，并保持密钥只在主进程子进程环境中存在。
- CLI 探测超时由 60 秒调整为 120 秒，并保留最近脱敏输出；上游 502 会显示为真实 Provider 错误，不会伪装成 HEALTHY。
- 主秘书验收闭环仍然有效：可派发 `status_inquiry` 询问其他子 Agent，也可派发独立 `validation`；只有校对员工的权威 `validationVerdict=PASS` 才允许交付。

最新证据：

- `tmp/acceptance-hermes-cli-workers/2026-08-22-r5/report.json`
- `tmp/acceptance-hermes-cli-workers/2026-08-22-r4/report.json`

当前真实阻断：

- Codex 子进程的 rollout 明确显示当前桌面受管执行环境强制 `sandbox_policy=read-only`，即使 OPC-Nexus 传入 `--sandbox workspace-write` 也不能写入项目目录；没有使用危险的 `--dangerously-bypass-approvals-and-sandbox` 绕过该策略。
- `api.quya.org` 当前 OpenAI 模型列表可以运行 Codex，但直接给 Claude Code 的 Anthropic Messages 路由拒绝 `qwen3.6-max-preview` 和 `claude-fable-5`。这不是被误报为成功的模型探活，需使用支持 Anthropic Messages 的 Provider 或配置协议转换代理后再放行 Claude 员工。

本轮门禁：

- `npm run typecheck`：PASS
- `npm test`：PASS，158 个测试文件、1662 个测试通过
- `npm run build`：PASS

## 2026-08-22 富媒体协议回归

- 发现并修复嵌入 Hermes WebUI 的真实媒体地址断点：OPC-Nexus 生成的 `aibox-artifact:` / `aibox-mobile:` 图片、视频和音频地址此前会被 Hermes Markdown URI 白名单或项目代理 CSP 拦截。
- Hermes Markdown 现在只额外允许这两个 Main-owned 协议，继续拒绝文件系统 URL 和任意自定义协议；Mermaid 仍保持严格安全级别。
- Hermes 项目代理的 `img-src` 与 `media-src` CSP 同步允许这两个协议，未放宽脚本、导航或外部文件访问权限。
- 回归测试：`tests/markdownView.test.ts`、`tests/hermesProxy.test.ts` 聚焦测试 `13/13 PASS`。
- 本轮完整门禁：`npm run typecheck` PASS；`npm test -- --run` 为 `158` 个测试文件、`1663` 通过、`2` 跳过；`npm run build` PASS；`vendor/hermes-agent/web` production build PASS；`scripts/smoke-desktop-ui.cjs` PASS，Renderer console error `0`。

本修复证明的是协议白名单和代理安全边界，不等同于已完成实体手机浏览器对媒体播放、真实渠道附件回执或真实 Worker 产物发送的验收；这些仍需真实运行条件继续复核。

## 2026-08-22 Main 交付验收硬门禁

- 新增 `HermesDeliveryGate`，由 Main 读取 `hermes_plan_jobs`、真实任务状态和独立验收任务结果；不再只依赖 Hermes 的提示词来决定“已交付”。
- 复杂 Hermes 计划任务即使执行状态为 `COMPLETED`，在未找到未参与实现员工的验收任务、验收仍在运行、返回 `FAIL` 或 `BLOCKED` 时，仍保持“验收中”，不能被看板计入已完成。
- 渠道终态回执在发送 Manifest 附件前执行同一门禁；未通过时只发送真实的“交付暂缓”原因，不附加任务产物文件。
- 简单的一次性 `@员工` 任务没有计划投影时不强制增加验收仪式，保持简单需求直达结果。
- 回归测试：`hermesGovernanceBridge.test.ts`、`projectWorkbench.test.ts`、`channelCommands.test.ts` 共 `47/47 PASS`；覆盖未验收、运行中、`FAIL`、`PASS` 和简单任务放行。
- 自动门禁：`npm run typecheck` PASS；`npm test -- --run` 为 `158` 个测试文件、`1667` 通过、`2` 跳过；`npm run build` PASS；`scripts/smoke-desktop-ui.cjs` PASS，Renderer console error `0`。

这项门禁只证明 Main 的计划交付和渠道附件边界；实体手机、微信/企微/飞书真实附件回执，以及 CLI 长任务稳定性仍需要真实外部条件继续验收。

## 2026-08-22 主秘书独立验收可见性

- Hermes 项目状态投影现在为每个任务携带 `intent`、`validationVerdict` 和 `relatedTaskIds`；`validation` 任务仍由 Main 从真实任务正文和终态结果解析，不能由 Renderer 自行伪造。
- Hermes 调度栏与 OPC-Nexus 桌面右侧“项目治理”同时显示“主秘书验收”：验收员工、关联实现任务数量以及 `PASS`、`FAIL`、`BLOCKED` 或等待状态。
- 没有独立验收任务时明确显示“主秘书尚未派发独立验收”，并提示复杂交付没有 `PASS` 不会正式交付；简单一次性 `@员工` 任务仍保持直达结果。
- 回归：`tests/hermesNexusChat.test.ts` 10/10 PASS；`vendor/hermes-agent/web` 生产构建 PASS；主程序 `npm run typecheck`、`npm test`（159 个测试文件，1669 通过，2 跳过）、`npm run build` 和桌面 Smoke 均 PASS，Renderer console error 为 0。

## 2026-08-22 主秘书自动发起独立验收

- 新增 Main-owned `HermesAcceptanceCoordinator`：同一 Hermes 计划的所有实现任务真实进入 `COMPLETED` 后，自动向项目根会话写入持久化队列提示。
- 该提示明确要求主秘书先用 `nexus_task_status` 查询实现任务，再选择未参与实现的 READY 子 Agent，使用 `intent=validation` 发起独立验收，并再次查询验收任务终态；只有权威 `validationVerdict=PASS` 才能交付。
- 已存在验收、Hermes 服务离线、固定员工会话、一次性 `@员工` 任务不会误触发；服务恢复后通过健康回调重新扫描未验收计划。
- 修正多节点 `Related project tasks` 解析，交付门禁、Main 状态投影和治理面板现在会完整识别全部关联实现任务。
- 新增回归：`tests/hermesAcceptanceCoordinator.test.ts` 5/5 PASS；`tests/hermesGovernanceBridge.test.ts` 13/13 PASS；覆盖自动触发、去重、主秘书会话边界、已有验收和双节点计划门禁。

本轮复用旧隔离数据重新跑真实工作流时，项目模型回落为上游曾返回 502 的 `deepseek-v4-pro-0813`，队列任务在等待窗口内超时；该结果记录为真实 Provider/模型配置问题（证据：`tmp/acceptance-real/2026-08-22-current4/report.json`），不计入产品通过。上一轮使用同一 Provider 的 `qwen3.6-max-preview` 已完成独立校对 `PASS` 闭环（`tmp/acceptance-real/2026-08-22-current3/report.json`）。

## 2026-08-22 主秘书自动验收状态投影修复

- 发现自动协调器同时连接了权威 `hermes_plan_projections`，却又残留 `hermes_plan_drafts.status IN ('APPROVED','DISPATCHED')` 条件。
- 实际状态模型中，草案表在 Main 接纳后保持 `PROJECTED`，批准/派工事实只写入 `hermes_plan_projections`；旧条件会把所有真实已派工计划过滤掉，导致主秘书永远收不到自动验收触发。
- 已移除旧草案状态过滤，并新增回归测试覆盖“draft=PROJECTED、projection=DISPATCHED”的组合。
- 修复后的真实复跑证据：`tmp/acceptance-real/2026-08-22-auto-validation-fixed/`。该次运行真实创建了 `DISPATCHED` 计划，研究节点完成；实现节点随后长时间停在 `RUNNING / 生成产物 / 5%`，没有产生新的 Provider 回执，因此在到达独立验收阶段前被终止，记录为外部执行阻断，不计入 PASS，也不伪造验收结果。
- 代码门禁：`npm run typecheck` PASS；`npm test -- --run` 为 `160` 个测试文件、`1676` 通过、`2` 跳过；`npm run build` PASS；`node scripts/smoke-desktop-ui.cjs` PASS，Renderer console error `0`。

## 2026-08-22 主秘书验收触发补偿与运行证据

- 完成事件现在除检查当前任务外，还会按任务所属项目复扫全部已完成计划任务；这覆盖执行器回调迟到或单次事件丢失的情况，仍使用同一个持久化队列和去重键。
- 自动触发增加 750ms 的稳定窗口，让 Main-owned artifact runtime 的真实 URL 有机会先写入 `task_events`；没有真实 URL 时，自动提示明确要求 `BLOCKED`，禁止猜测端口、使用 `:0` 或 `file://`。
- 自动提示会从 `artifact_runtime` 事件注入真实 `http://127.0.0.1:<port>/` 地址，并要求主秘书将该精确地址传给独立校对员工。
- 真实证据 `tmp/acceptance-real/2026-08-22-auto-validation-seeded/report.json` 对应的旧 bundle 已确认：Main 自动写入 `hermes.acceptance.auto-request`，持久化队列进入 `RUNNING`，并真实创建独立 `validation` 任务；但校对员工没有获得运行地址，调用了错误的 `127.0.0.1:0`/`file://` 路径，未满足 HTTP/浏览器工具验收，结果为 FAIL。
- 重新构建后的真实复跑 `tmp/acceptance-real/2026-08-22-auto-validation-runtime-url-built/` 在实现任务阶段因 Hermes 工具调用轮次超限失败，未进入自动验收；该结果记录为真实执行阻断，不计入 PASS。
- 本轮门禁：`npx vitest run tests/hermesAcceptanceCoordinator.test.ts` 6/6 PASS；`npm run typecheck` PASS；`npm test -- --run` 为 `160` 个测试文件、`1677` 通过、`2` 跳过；`npm run build` PASS；`vendor/hermes-agent/web` production build PASS；`node scripts/smoke-desktop-ui.cjs` PASS，Renderer console error `0`。

## 2026-08-22 主秘书独立子 Agent 验收复核

本轮针对“实现任务完成后，由主秘书询问其他子 Agent 验收”重新使用最新 `out/main` 执行了真实工作流：

```text
$env:AIBOX_ACCEPTANCE_AUTO_VALIDATION='1'
node scripts/acceptance-real-workflows.cjs
```

验收协调器的本地行为已确认：

- 所有实现任务进入真实 `COMPLETED` 后才触发，触发前等待 1500ms，让 Main-owned artifact runtime 有机会写入真实预览 URL。
- 自动提示会注入项目内真实 `READY` 且未参与实现的验收员工 ID、姓名和角色；主秘书必须从该列表精确选择，禁止猜测 UUID。
- 主秘书必须先调用 `nexus_task_status`，再调用 `nexus_delegate_task(intent=validation)`，并关联全部实现任务。
- 验收员工终态必须再次通过权威任务状态查询；只有 `validationVerdict=PASS` 才允许交付，`FAIL`/`BLOCKED` 保持阻断。
- 没有独立 READY 验收员工、Hermes 离线或没有真实预览地址时，Main fail-closed，不生成伪造验收结果。

本次真实复跑未进入验收阶段：上游 Provider 返回 HTTP 502，两个实现任务分别为 `CANCELLED` 和 `FAILED`，因此脚本在“计划任务失败”处停止。这是外部执行阻断，不是协调器失败，也不计入 PASS；未使用旧报告或 Mock 结果覆盖它。证据目录：

`tmp/acceptance-real/2026-08-22-auto-validation-reviewer-fixed/user-data/`

后续需要在 Provider 稳定且模型可用时再次执行，必须取得完整的 `validation` 任务工具事件（HTTP、浏览器、DOM、截图）、权威 `validationVerdict=PASS` 和 `HermesDeliveryGate` 放行证据，才能宣称本轮端到端通过。

本轮代码门禁：

- `npm run typecheck`：PASS
- `npx vitest run tests/hermesAcceptanceCoordinator.test.ts`：7/7 PASS
- `npm test -- --run`：160 个测试文件通过，1678 通过，2 跳过
- `npm run build`：PASS
- `vendor/hermes-agent/web` production build：PASS
- `node scripts/smoke-desktop-ui.cjs`：PASS，Renderer console error `0`

## 2026-08-22 DSH 用户面文案与手机入口最终收口

本轮针对“旧 DSH 内容过多、与 Hermes 形成割裂产品”的体验问题做了最后一层用户面清理：

- 引擎中心、环境诊断和已有历史员工编辑器不再显示 DSH 产品名；历史绑定只显示“历史执行配置（只读）”或“受管执行配置（只读）”。
- 旧 DSH LAN、控制台、计划、插件目录和第二套手机对话 IPC 仍保持未注册；内部受管执行适配器、会话和任务恢复能力保留。
- 手机扫码入口继续只有 Quest 右上角的 Hermes 手机 Web 配对，固定跳转当前项目 Hermes `/chat` Operator 会话；Android 执行设备页只提供实体 Worker 控制，不生成第二个对话二维码。
- 插件中心 Smoke 增加 DSH/Cordis 文案泄漏门禁。

本轮验证：

- `npx vitest run tests/dshManagedExecutor.test.ts tests/dshControlIpc.test.ts tests/engineManager.test.ts tests/environmentDiagnostics.test.ts tests/questMobileAccess.test.ts`：96/96 PASS
- `npm run typecheck`：PASS
- `node scripts/smoke-desktop-ui.cjs`：PASS，22 个用户导航入口，Renderer console error `0`

## 2026-08-22 DSH 产品面清理与 Hermes 手机扫码边界

本轮继续收口旧 DSH 内容，但没有删除仍被历史任务和明确选择的 CLI Worker 使用的底层 Runtime、Session、事件和执行适配器。删除这些底层事实会破坏已有任务恢复；它们现在不再拥有用户侧调度、计划、审批、插件中心或手机对话职责。

- 启动迁移现在清除整个 `dsh:lan:*` / `secret:dsh:lan:*` 设置命名空间，而不是只删除三个已知键；Hermes 的 `hermes:*` 配置和 TLS 密钥保持独立。
- Hermes 手机网关复用受治理的 TLS/WS 传输，但使用独立的 `__Host-opc_hermes_mobile` 与 `__Host-opc_hermes_csrf` Cookie，不再与旧 DSH LAN 会话共用命名空间。
- Quest 右上角二维码仍是唯一的项目手机对话入口，固定创建当前项目 Hermes `/chat` Operator 会话。Android 执行设备页面不生成对话二维码；Android Bridge 配对只服务实体设备 Worker。
- 用户指南、功能文档和架构文档已移除“模拟执行”选项，并明确 Hermes 是唯一调度器、DSH 仅为受治理 CLI/历史执行适配器。

验证：

- `npm run typecheck`：PASS
- `npm test -- --run`：PASS，141 个测试文件，1475 passed，1 skipped
- `npm run build`：PASS
- `node scripts/smoke-desktop-ui.cjs`：PASS，22 个用户导航入口，旧 DSH/Mock 用户入口隐藏，Renderer console errors `0`
- DSH LAN、Hermes Mobile Gateway、旧配置迁移 focused tests：31/31 PASS

## 2026-08-22 DSH 清理后移动 Hermes 状态投影复验

上一轮移动回归中发现的竞态是：Main 已经把 Hermes 项目置为 `healthy`，但 Hermes Web 在等待较慢的 `chat-history` 请求返回后才更新页面状态，导致输入框继续显示“启动中”并禁止发送。该问题已在 Hermes Web 的刷新顺序中修复：项目状态、队列和员工投影先更新，历史记录随后异步回读；历史接口变慢不会再阻塞真实健康状态和发送能力。

本次真实黑盒报告：`tmp/acceptance-mobile-web/2026-08-22-mobile-state-fix/report.json`

结果：**PASS，8/8，Renderer console errors 0**

覆盖证据：

- 真实项目读取与 Hermes 0.19 项目服务启动，runtime state=`healthy`。
- 真实 Operator 配对和同源会话认证成功。
- 390×844 触控移动布局无横向溢出，输入框可见。
- 移动端真实附件选择、发送和 assistant 持久化回复成功，`chat-history` 返回 200，附件已消费。
- Viewer 配对仍为只读，打开对话返回 403。
- 停止 Hermes 后移动网关返回真实离线状态（503），不会继续显示在线。

当前产品边界：

- DSH 的用户级调度、旧控制台、旧插件投影和第二套手机对话入口已清理。
- DSH Runtime、Supervisor、会话和 CLI Worker 执行能力仍保留，供受治理的历史任务和执行层使用，不能误删。
- Quest 的手机扫码只创建当前项目 Hermes `/chat` 的 Operator 会话；Android 执行设备二维码仍仅用于实体 Android Worker 配对。
- 未配置 Provider、Hermes 未健康或网关离线时，发送和对话入口保持阻断并显示真实错误，不使用 Mock 或伪成功。

本次门禁：

- `node scripts/prepare-hermes.cjs --web`：PASS
- `npm run typecheck`：PASS
- `npm test -- --run`：141 个测试文件通过，1475 passed，1 skipped
- `npm run build`：PASS
- `node scripts/smoke-desktop-ui.cjs`：PASS，22 个导航入口，旧 DSH/Mock 用户入口隐藏，Renderer console errors=0
- `node scripts/acceptance-mobile-web-ui.cjs`：PASS，8/8

## 2026-08-22 DSH 用户投影最终收口

针对“旧 DSH 内容太多、与 Hermes 产生第二套产品入口”的问题，又收紧了一层边界：

- 新增共享的 `isQuestVisibleEngine` 规则。`eng-deepseek-harness` 和 `eng-deepseek-harness-managed` 仍可被历史任务、受治理 Worker 和内部执行器按 ID 解析，但不再进入 Main owner snapshot、旧本机 REST 镜像或用户侧引擎/插件投影。
- 不删除底层 DSH Runtime、会话、事件、Supervisor 和 TLS/WS 适配器。删除这些会破坏历史任务恢复和明确选择 DSH CLI Worker 的执行链路；它们不再拥有 Quest 计划、澄清、审批、插件中心或手机对话控制权。
- 手机二维码只有 Quest 右上角的 `aibox:createHermesMobilePairing(projectId, config?)` 入口，固定跳转当前项目 Hermes `/chat`；Renderer 不再传入或接收 Viewer/Operator 角色，Android 执行设备配对继续只服务真实 Android Worker。

本轮门禁：

- `npm run typecheck`：PASS
- `npm test -- --run`：141 个测试文件，1475 passed，1 skipped
- `npm run build`：PASS
- `node scripts/smoke-desktop-ui.cjs`：PASS，22 个导航入口，旧 DSH/Mock 用户入口隐藏，Renderer console errors `0`
- 聚焦 DSH 投影、插件目录和 Hermes 手机边界：15/15 PASS

补充发现：使用同一真实 Provider 隔离数据重跑移动附件黑盒时，Hermes 服务本身已 `healthy`，但移动页面偶发长时间停留“启动中”，发送按钮保持禁用，证据为 `tmp/acceptance-mobile-web/2026-08-22-dsh-cleanup-rerun/report.json`。这不是 DSH 入口问题，属于移动页面启动状态投影竞态，后续仍需单独修复后才能宣称移动附件链路稳定通过。

## 2026-08-22 DSH 用户入口清理与 Hermes 手机连接收敛

本轮进一步收敛了用户可见边界：

- 统一插件中心不再投影历史 DeepSeek Harness 或受管 DSH Runtime，避免它们重新出现为 ACP/CLI 插件或第二套配置入口。
- DSH 运行时、会话和受管 Worker 内核仍保留给已有任务执行，未删除执行能力；它们不能作为 Quest 调度器、插件中心或手机对话入口。
- Android 执行设备页不再生成对话二维码，只负责实体 Android Worker 的网关、设备、脚本、日志和媒体。
- 手机对话二维码只从 Quest 右上角生成，并绑定当前项目 Hermes Operator `/chat`；Viewer、Android Bridge 和旧 DSH LAN 配对不会复用该入口。
- Android Worker 的错误提示和员工向导不再把历史 DSH 产品名暴露给用户。

验证结果：

- `npm run typecheck`：PASS
- `npm test`：141 个测试文件，1474 项通过，1 项跳过
- `npm run build`：PASS
- `node scripts/smoke-desktop-ui.cjs`：PASS，22 个导航入口，旧 DSH/Mock 用户入口隐藏，Renderer console error `0`
- 移动 Web 黑盒：PASS，8/8；证据：`tmp/acceptance-mobile-web/2026-08-22-dsh-cleanup/report.json`

## 2026-08-22 最新移动 Hermes 复验

本轮重新执行真实 Electron + Hermes 0.19 + Operator 配对 + 390x844 触控浏览器验收。此前脚本把 `data-nexus-composer` 容器误当成 textarea 属性，导致“输入框不存在”的假失败；现已改为定位 `[data-nexus-composer] textarea`。

最新证据：`tmp/acceptance-mobile-web/2026-08-22T05-13-55-391Z/report.json`

- 8/8 PASS：服务启动、Operator 同源认证、移动布局、真实附件选择与发送、assistant 回复、Viewer 只读、服务离线状态。
- 真实历史回读 HTTP 200，assistant 回复为“移动 Web 消息已收到”，附件已被 Hermes 消费，移动页面无横向溢出。
- 旧 `current14` 的历史失败记录仍保留用于审计对比，但不代表当前实现状态。
- `npm run typecheck`、`npm test`（141 个文件，1473 通过，1 跳过）、`npm run build` 和 `node scripts/smoke-desktop-ui.cjs` 均通过。

## 2026-08-22 旧 DSH LAN 状态最终清理

针对“旧 DSH 内容过多、手机扫码只连接 Hermes 对话”的边界又做了一次启动迁移收口：

- Hermes 手机网关不再复用 `dsh:lan:*` TLS 配置，改用独立的 `hermes:mobile:*` 配置和证书命名空间。
- 升级启动时删除旧 DSH LAN 配置、证书和加密密钥引用；DSH 执行适配器的运行实例、会话、事件和历史记录不删除。
- Android 执行设备页仍只提供真实设备控制、脚本、日志、媒体和 ADB 安装，不显示第二个二维码入口。
- Quest 右上角是唯一桌面手机扫码入口，二维码固定跳转当前项目 Hermes `/chat` Operator 会话。

验证结果：

- `npm run typecheck`：PASS
- `npm test -- --run`：PASS，141 个测试文件，1472 通过，1 跳过
- `npm run build`：PASS
- `node scripts/smoke-desktop-ui.cjs`：PASS，22 个导航入口，Quest 三栏布局正常，Renderer console error `0`
- 迁移和入口聚焦回归：23/23 PASS

## 2026-08-22 手机扫码入口最终收口

旧 DSH 的用户级调度、控制台、LAN 命令中心和插件入口已经退役。DSH Runtime、会话/事件投影以及 TLS/WebSocket 底层仍保留为受治理执行适配器和 Hermes 手机网关依赖，不能直接删除，否则会破坏历史任务恢复和真实 Worker 执行。

为避免第二套手机入口造成混淆，`Android 执行设备` 页面已移除二维码配对按钮、二维码弹窗和 Android Bridge 配置复制入口；该页只负责真实 Android Worker 的网关状态、设备控制、脚本、日志、媒体和 ADB 安装。手机对话二维码现在只从 Quest 右上角生成，固定绑定当前项目 Hermes `/chat` Operator 会话。

验证：

- `npm run typecheck`：PASS
- `npm test -- --run`：PASS，140 个测试文件，1470 passed，1 skipped
- `npm run build`：PASS
- `node scripts/smoke-desktop-ui.cjs`：PASS，22 个导航入口、Quest 三栏、Renderer console errors `0`
- `tests/dshControlIpc.test.ts` 新增入口契约：Android 页面不包含第二个扫码入口，Hermes 配对仍为项目级 `/chat`

## 2026-08-22 旧 DSH 产品入口清理与 Hermes 手机边界复验

### 清理范围

- 删除/隐藏旧 DSH 调度产品入口：员工创建向导不再提供 DSH 调度模式，引擎中心、员工市场、专家团和技能选择器不再把 managed DSH 作为用户可选产品。
- 保留 DSH CLI/managed runtime 的受管执行能力，用于历史员工配置和明确的执行 Worker；它不再拥有 Quest 计划、澄清、审批、派工或手机控制台入口。
- 升级启动时删除旧 `dsh:lan:gateway` 产品配置并写入迁移审计；不会删除 DSH 执行会话、运行记录或 Hermes 手机 TLS/Origin/WebSocket 底层安全组件。
- Android 执行设备配对和 Quest Hermes 手机对话配对继续分离：前者只服务实体 Android Worker，后者只生成当前项目 `/chat` Operator 路由。

### 真实验证

- `npm run typecheck`：PASS。
- 聚焦回归：36/36 PASS（引擎可见性、Hermes Service、Hermes Mobile Gateway、旧 DSH IPC 边界）。
- `npm test`：140 个测试文件，1469 passed，1 skipped。
- `npm run build`：PASS。
- `node scripts/smoke-desktop-ui.cjs`：PASS；22 个导航入口、Quest 三栏布局、Provider fail-closed、Renderer console error 0。
- `scripts/acceptance-mobile-web-ui.cjs`：Operator 配对、同源认证、`/chat` 390×844 响应式布局、Viewer 只读和历史接口响应通过；本轮附件消息在 20 秒内仍处于 Hermes 工具调用阶段，assistant 正文为空，脚本因此保持 FAIL，不能宣称移动附件端到端已通过。最新证据目录：`tmp/acceptance-mobile-web/2026-08-22T04-00-*/report.json`。

结论：旧 DSH 的用户级调度/控制面已从产品体验中移除；DSH 仍是执行层基础设施，Hermes 手机扫码只进入当前项目 Hermes 对话。移动端剩余阻断是上游工具调用完成时序/回复等待问题，不是旧 DSH LAN 路由重新出现。

## 2026-08-22 DSH 遗留清理与 Hermes 手机入口收敛

本轮针对“旧 DSH 内容过多、手机扫码应只连接 Hermes 对话”的产品边界完成代码收敛：

- 移除 Renderer/Main 白名单中的旧 DSH Runtime 启停、控制接管、事件读取、委派树和 DSH 社区插件安装入口；这些能力不再是可调用的第二产品面。
- DSH CLI 仅保留为可选数字员工执行适配器，不能作为 Quest 调度器、手机入口或插件中心。新安装/启动不再自动创建 Cordis 员工。
- 对历史上由旧启动引导创建的精确 Cordis 员工执行一次性安全迁移：仅当配置、提示词、DSH 引擎和默认工作区完全匹配，且没有活动任务时归档；用户自定义同名员工不会被修改。
- Quest 手机 LAN 配置改为 `HermesMobile*` 公共契约，完全不继承旧 DSH LAN 授权；二维码固定生成当前项目 `operator` 对话连接，并在配对成功后直接进入 `/chat`。
- “viewer” 仍可用于只读审计接口，但不再出现在老板的 Quest 对话扫码面板，避免扫码后进入无发送权限的自相矛盾流程。
- Android 执行设备页面保留。它连接的是实体 Android worker，与 Quest Hermes 对话扫码是两条明确不同的产品能力。

### 本轮追加清理

- 生产控制平面不再注册旧 `CordisControlKernel`；非 Quest 兼容入口只能直达明确选择的执行员工，复杂调度必须进入项目 Quest/Hermes 会话。
- 治理插件不再暴露 `dsh-managed` 产品身份或 `dsh-lan-mobile` 渠道能力，Hermes 手机能力统一显示为项目级 `hermes-mobile-gateway`。
- 旧桌面/移动管理 Web 服务不再因历史配置自动启动，升级时会关闭 `legacyWebAdminEnabled`，避免恢复第二套手机命令中心。
- Android 执行设备二维码改名为 Android Bridge 执行设备配对，和 Quest Hermes 手机对话二维码明确区分。
- DSH Runtime、会话/事件投影、策略边界和 Android Worker 底层保留，仅作为受治理执行层，不再作为调度、规划、插件中心或手机对话入口。

本轮回归：`npm run typecheck`、`npm test`（140 files / 1469 passed / 1 skipped）、`npm run build` 和 `node scripts/smoke-desktop-ui.cjs` 均通过。桌面冒烟仍显示 22 个必要导航入口、Quest 三栏布局和 Hermes 未配置时的真实阻断；Renderer console errors 为 0。

本轮回归证据：

- `npm run typecheck`：PASS
- DSH 退役门禁、Hermes Mobile、LAN 网关、IPC 安全聚焦：`59/59 PASS`
- `npm test -- --run`：PASS，`160` 个测试文件通过，`1675` 通过，`2` 跳过
- `npm run build`：PASS
- 最新移动 Web 黑盒：`tmp/acceptance-mobile-web/2026-08-22T02-45-05-452Z/report.json`，`8/8 PASS`，Renderer console errors `0`

本轮没有宣称实体手机触控、真实渠道收发或 Codex/Claude 长任务已通过；它们仍需真实外部条件和独立报告。

## 2026-08-22 DSH 产品层进一步收口与二维码入口隔离

针对“旧 DSH 内容过多、手机扫码入口容易混淆”的产品问题，本轮完成最后一层用户入口收口：

- Android Bridge 执行设备的二维码 IPC 改为 `aibox:androidBridge:createPairing` / `aibox:androidBridge:copyPairingConfig`，不再使用泛化的 `aibox:mobile:*` 配对命名。
- Quest 手机 Web 仍只调用 `aibox:createHermesMobilePairing`，二维码固定绑定当前项目 Hermes `/chat` Operator 入口；它不创建 DSH 会话，也不打开旧移动控制台。
- 插件中心的移动能力标识统一为 `hermes-mobile-gateway`，不再保留含糊的 `lan-mobile-gateway` 标识。
- `Android 执行设备` 页面保留，是为了连接实体 Android Worker；它与“Quest 手机对话扫码”是两个不同的执行/对话能力，页面文案已明确区分。

本轮回归证据：

- `npm run typecheck`：PASS
- 聚焦 IPC、插件清单、Hermes Mobile：15/15 PASS
- `npm test -- --run`：140 个测试文件，1469 passed，1 skipped
- `npm run build`：PASS
- `node scripts/smoke-desktop-ui.cjs`：PASS；22 个导航入口、旧 DSH/Mock 标签隐藏、Renderer console errors 为 0

结论：可以清理旧 DSH 的用户级调度、控制台、插件和手机命令入口；不能删除仍被 Hermes/Android Worker 使用的底层 DSH 执行、TLS、WebSocket 和会话投影实现。当前所有老板手机扫码都进入 Hermes 项目对话，Android Bridge 只用于明确标注的实体执行设备配对。

旧 `current14` 附件回归中的 `chat-history` 阻塞保留为历史失败证据；最新移动 Web 黑盒已经在真实 Hermes assistant 回复、附件消费、响应式布局、Viewer 只读和服务离线状态上重新通过，不能再把旧报告当作当前状态。

## 2026-08-22 移动 Web 附件真实回归

新增脚本 `scripts/acceptance-mobile-web-ui.cjs` 使用隔离的真实 Provider 数据、真实 Hermes 0.19 服务、真实 Operator 配对和 Edge Chromium 移动仿真（390×844、触控模式）执行用户链路。

已通过：

- Electron 与 Hermes 项目服务真实启动，健康状态为 `healthy`。
- Operator 配对和同源会话认证成功。
- `/chat` 移动布局无横向溢出，输入框可见。
- Viewer 配对仍被限制为只读，打开 `/chat` 返回 `403` 的路径已在脚本中覆盖。

发现阻断（未修复，不计入 PASS）：

- 在移动 Web 选择真实附件并发送后，Hermes 上游日志明确记录模型已返回“移动 Web 消息已收到”，但项目网关的 `POST /__opc_nexus/project/chat-history` 在 15 秒内没有响应，页面仍显示“排队中 · 第 1 位”，没有把完成消息呈现给老板。
- 证据：`tmp/acceptance-mobile-web-ui/current14/report.json`；Hermes 上游 `state.db` 已记录对应 assistant 回复，说明问题位于 Main/移动代理的历史回读或队列状态投影，不是 Provider 没有回答。
- 同类卡片身份黑盒在 Provider 返回真实 HTTP 502/503 时也必须保持失败，不能把身份验收伪装成通过；证据：`tmp/acceptance-card-identity/2026-08-22-r1/report.json`。

后续修复验收必须证明：发送后队列在合理时间内从 `RUNNING` 进入终态，`chat-history` 不得长时间阻塞或返回错误，移动/桌面页面都能显示同一条持久化 assistant 回复；Provider 502/503 则应明确显示真实错误和重试入口。

## 2026-08-22 主秘书验收跟进闭环最终复验

本轮修复了真实模型在独立验收员工返回后直接结束主秘书回合、没有再次读取权威任务状态的边界。Main 现在会在 `validation` 任务进入终态后，写入去重的 `[OPC-NEXUS-AUTO-VALIDATION-STATUS]` 队列回合，要求主秘书调用 `nexus_task_status(waitSeconds=0)`；该回合仍由 Hermes 主秘书面向老板汇总，Main 的 `HermesDeliveryGate` 继续作为最终放行者。

新增的验收任务协议还明确要求：

- 有真实预览 URL 时必须依次使用 `http_request`、`browser_navigate`、`browser_get_content` 检查线上页面。
- URL 缺失、不可达或工具不可用时只能返回 `BLOCKED`，不能用文件阅读代替真实页面检查。
- 验收员工不得创建额外验收文件，首个非空结果词必须是 `PASS`、`FAIL` 或 `BLOCKED`。

真实证据：

- 报告：`tmp/acceptance-real/2026-08-22-secretary-validation-current5/report.json`
- 结果：**PASS，24/24，0 FAIL**
- Provider：`https://api.quya.org`，模型列表读取 15 个，项目模型 `qwen3.6-max-preview`
- 实现任务：`207d8da8-3e7e-414d-8e87-1112250594cc`、`2b731163-af1f-4d1f-9ab0-94d8b13d9bf6`
- 独立验收任务：`139ac947-97ff-431d-b0d3-4a591239e2e0`，员工 `7c9ea8ec-9ed8-4804-b6da-53f4fefd7019`
- 工具事件：`http_request`、`browser_navigate`、`browser_get_content`、`read_file`
- 权威结果：`COMPLETED`、`terminal=true`、`validationVerdict=PASS`
- 主秘书最终回复明确引用 `nexus_task_status` 的权威回执后才汇总交付
- 交付门禁：`HermesDeliveryGate` 放行；本地预览 HTTP 200，桌面/手机截图和 Manifest 均真实生成

本轮代码证据：

- `npx vitest run tests/hermesAcceptanceCoordinator.test.ts`：9/9 PASS
- `npx vitest run tests/hermesEmployeeIntegration.test.ts`：7/7 PASS
- `npm run typecheck`：PASS
- `npm test -- --run`：160 个测试文件通过，1682 通过，2 跳过
- `npm run build`：PASS
- `node scripts/smoke-desktop-ui.cjs`：PASS，Renderer console error `0`

黑盒脚本同时修复了验收竞态：必须等待 Main-owned 状态跟进队列出现并完成后，才读取新增的主秘书消息，不能把验收员工早先的 `PASS` 文字误判为主秘书已查询权威状态。

## 2026-08-22 Hermes 崩溃恢复竞态修复

### 发现的问题

真实 Electron 崩溃恢复场景连续两次复现：Hermes Dashboard 被终止后，Main 已开始重启，但旧实例仍短暂保留 `ERROR` 状态。Quest 的“重试”调用过早读取旧错误，直接把上一次崩溃日志重新显示；另一条竞态路径则可能在代理已停止时复用 `healthy` 状态并报 `Hermes proxy is not running`。这会让用户看到“重试无效”或后台健康、界面失败的不一致状态。

### 修复

- `HermesServiceManager.start()` 不再复用代理已停止的 `healthy/degraded` 实例。
- `startForUi()` 在替换实例的启动操作进行期间不会提前抛出旧 `ERROR`，而是等待清理和新实例启动完成。
- UI Lease、手机 Lease 和移动网关上游都要求真实 Dashboard 与 Main-owned Proxy 可用。
- 增加 `isUiAvailable()`，手机共享在代理断开时不再继续显示在线。
- 增加 2 个回归测试，覆盖陈旧代理和重试期间旧错误抢先显示。

### 修复后真实证据

脚本：`scripts/acceptance-hermes-crash-recovery.cjs`

结果：**PASS**

证据：`tmp/acceptance-hermes-crash-recovery/2026-08-22-retry-fixed/report.json`

验证链路：

```text
正常打开 Quest
→ 真实杀掉 Hermes Dashboard
→ Quest 显示“连接失败”和重试入口
→ 点击重试
→ 等待旧实例清理
→ Dashboard、Gateway、Proxy 全部重新健康
→ Quest 嵌入工作区恢复可用
→ Renderer console error = 0
```

本轮门禁：

- `npx vitest run tests/hermesServiceManager.test.ts`：26/26 PASS
- `npm run typecheck`：PASS
- `npm test -- --run`：160 个测试文件通过，1680 通过，2 跳过
- `npm run build`：PASS
- `vendor/hermes-agent/web` production build：PASS
- `node scripts/smoke-desktop-ui.cjs`：PASS，Renderer console error `0`

## 2026-08-22 Quest 手机 Hermes 对话单入口最终收敛

本节是当前最终状态，覆盖本文前面保留的历史失败记录和旧测试计数。

### 产品边界

- Quest 是唯一老板调度入口，Hermes 是唯一调度器。
- 手机二维码只创建当前项目的 Hermes Chat 会话，配对后固定进入 `/chat`；公开 IPC 不再接收或返回手机角色。
- 手机项目模式不再渲染 Hermes 官方汉堡菜单、Sidebar、Gateway 状态、更新、Files、Sessions、Logs、System 或其他管理页面；未知路径统一返回 `/chat`。
- 手机调度状态默认只显示一行 `Hermes 在线 · 进行中 · 已完成`，点击后才展开数字员工、Worker、子 Agent、计划和主秘书验收详情。
- 旧版 Viewer/Operator 多角色调用在 IPC 配置校验层拒绝，不存在第二种扫码产品入口。
- 旧 DSH 调度、计划、插件目录、LAN 手机控制台、独立 Web Admin 和 Renderer IPC 已移除。DSH 仅保留不可见的历史 Session/Run 恢复与受管 CLI Worker 执行适配器；直接删除这些内部表和适配器会破坏已有任务恢复与 Codex/Claude CLI 执行，不属于产品入口清理。
- Hermes 手机会话使用 `__Host-opc_hermes_mobile` 和 `__Host-opc_hermes_csrf`，Fork UI 中不再出现旧 `opc_dsh_csrf` 命名。

### 真实移动 Web 黑盒

脚本：`scripts/acceptance-mobile-web-ui.cjs`

结果：**PASS，8/8，0 FAIL，Renderer console errors 0**

证据：

- 报告：`tmp/acceptance-mobile-web/2026-08-22-hermes-chat-only/report.json`
- 空会话截图：`tmp/acceptance-mobile-web/2026-08-22-hermes-chat-only/mobile-chat-empty.png`
- 发送后截图：`tmp/acceptance-mobile-web/2026-08-22-hermes-chat-only/mobile-chat-after-send.png`
- Hermes v0.19.0 真实启动并通过 health check，启动耗时约 13 秒。
- HTTPS Hermes Chat 配对、同源认证、REST 和 WebSocket 路由通过。
- Edge Chromium 以 390×844、触控模式打开真实移动地址，`scrollWidth = 390`，无横向溢出。
- 首屏只显示 Quest/Hermes、会话标签、紧凑调度摘要、聊天历史和输入框；没有旧 DSH 或 Hermes 管理导航。
- 真实上传 `mobile-attachment.md` 后，Hermes 返回“移动 Web 消息已收到。”，附件被真实消费，页面正确显示用户消息、活动折叠块和 assistant 回复。
- 调用旧版 Viewer 参数被明确拒绝，公开返回值中不再存在角色字段。
- Hermes Service 停止后，手机项目状态真实返回 HTTP 503，不显示伪在线或伪成功。

### 当前门禁

- `vendor/hermes-agent/web: npm run build --workspace web`：PASS。
- `npm run typecheck`：PASS。
- `npm test`：138 个测试文件，1451 passed，1 skipped。
- `npm run build`：PASS。
- 聚焦 Hermes Chat、Quest 路由、Hermes Mobile、Secure LAN 和旧 DSH IPC 退役契约：59/59 PASS。
- `node scripts/smoke-desktop-ui.cjs`：PASS；22 个必要导航、Quest 左中右三栏、旧 DSH/Mock 标签隐藏，Renderer console errors 0。证据：`tmp/desktop-smoke/2026-08-22T07-45-55-616Z/report.json`。

未覆盖项：本轮使用真实本机 HTTPS 网关和 Chromium 移动触控仿真，没有替代不同品牌实体手机首次信任自签名证书的人工验收；外部微信、企微、飞书的真实账号收发仍受外部账号配置约束。

## 2026-08-22 DSH 用户侧清理与 Hermes 手机状态一致性复验

本节覆盖前文同日移动报告中的旧计数和历史失败记录。

### 清理边界

- Quest/Hermes 是唯一老板调度和手机对话入口；二维码固定绑定当前项目并进入 `/chat`。
- 旧 DSH 调度页面、规划器、Workbench、LAN Gateway、Web Admin、插件目录及公开 IPC 已移除。
- 历史 Session/Run 恢复和受管 CLI Worker 的内部适配器继续保留，不出现在导航、插件中心、二维码或老板对话中。
- 已归档 DSH/Cordis 员工的聊天记录不删除，旧会话标题统一投影为“历史员工会话”，避免误导同时保留真实历史证据。

### 本轮修复

- Hermes 聊天页的 Main-owned 运行时状态改为独立刷新，不再被会话切换、历史读取或队列请求序号取消。
- 手机首屏未取得状态时显示“同步中”；稳定到 `healthy` 后显示“就绪”，不再出现顶部在线而输入框长期启动中的矛盾。
- Quest 手机二维码弹窗打开时隐藏原生 Hermes `WebContentsView`，修复弹窗被原生层覆盖和右侧布局挤压。
- Secure LAN 的剩余 DSH WebSocket 错误文案改为中性传输语义。

### 真实移动黑盒

- 报告：`tmp/acceptance-mobile-web/dsh-cleanup-final/report.json`
- 截图：`tmp/acceptance-mobile-web/dsh-cleanup-final/mobile-chat-empty.png`
- 发送后截图：`tmp/acceptance-mobile-web/dsh-cleanup-final/mobile-chat-after-send.png`
- 结果：**8/8 PASS，0 FAIL**。
- 390×844 触控视口：`scrollWidth = 390`，无横向溢出或控件遮挡。
- 就绪证据：Main `healthy`、手机 `/__opc_nexus/project/state` 为 `healthy`/HTTP 200、发送按钮启用。
- 真实上传 `mobile-attachment.md`，Hermes 调用 `read_file` 后回复“移动 Web 消息已收到。”；历史 HTTP 200，附件托盘已消费。
- 停止 Hermes 后手机状态真实返回 HTTP 503。报告中的 3 条浏览器 503 控制台记录均来自这个故意离线步骤，属于预期失败证据。

### 门禁

- 主项目 `npm run typecheck`：PASS。
- Hermes Web `npm run typecheck` 与 production build：PASS。
- `npm test`：138 个测试文件，1455 passed，1 skipped。
- `npm run build`：PASS。

## 2026-08-22 Quest 旧执行投影清零与 Hermes 手机单入口复验

本节为本报告中关于 DSH 用户侧残留和手机二维码边界的最新结论，覆盖前文“历史员工会话仍显示”的过渡状态。

### 最终边界

- `getProjectWorkbench` 不再读取或返回旧 `dsh_sessions`、`dsh_runs`、`dsh_events`；Quest 左栏、右侧治理和 Hermes 项目状态只显示当前项目的真实 Task、Hermes 计划、数字员工和交付事实。
- 删除未使用的 `aibox:bindProjectRootSession` Main/Preload 公共入口，以及不再使用的 Project Workbench Session/Run/Event Shared DTO。
- Hermes Chat 移除由旧执行 Runtime 投影出来的重复“Worker / 子 Agent 会话”栏；Worker 状态只由权威 Task 状态显示一次。
- 已归档兼容员工的会话仍保留在数据库和审计中，但不再进入当前 Quest 会话 Tab；真实历史种子中不再显示“历史员工会话”。
- DSH Runtime、Session 和执行策略只保留在 Main 内部，用于已有任务恢复与受管 CLI Worker，不拥有调度、插件、手机、会话 Tab 或 Renderer IPC。
- Quest 右上角是唯一手机对话二维码；配置使用 `hermes:mobile:*`，配对 Cookie 使用 `__Host-opc_hermes_mobile`，提交验证码后必须直接进入当前项目 `/chat`。

### 真实证据

- 移动报告：`tmp/acceptance-mobile-web/hermes-only-clean-final/report.json`
- 移动截图：`tmp/acceptance-mobile-web/hermes-only-clean-final/mobile-chat-empty.png`
- 发送后截图：`tmp/acceptance-mobile-web/hermes-only-clean-final/mobile-chat-after-send.png`
- 结果：**8/8 PASS，0 FAIL，无非预期 console error**；报告中的 3 条 503 均来自最后故意停止 Hermes 的离线验证步骤。
- 390x844 触控视口：`scrollWidth = 390`；配对直接落到 `/chat`；会话 Tab 不含“历史员工会话”。
- Main 与手机运行状态均为 `healthy`，真实上传 `mobile-attachment.md` 后 Hermes 调用 `read_file` 并回复“移动 Web 消息已收到。”。
- Hermes Service 停止后，手机 `/__opc_nexus/project/state` 返回 HTTP 503。
- 桌面报告：`tmp/desktop-smoke/hermes-only-clean-final/report.json`；22 个必要导航完整，旧 DSH/Mock 产品标签隐藏，Renderer console errors 0。

### 门禁

- 主项目 `npm run typecheck`：PASS。
- Hermes Web typecheck 与 production build：PASS。
- 聚焦清理和手机边界测试：40/40 PASS。
- 全量 `npm test`：138 个测试文件，1456 passed，1 skipped。
- `npm run build`：PASS。

## 2026-08-22 Quest 斜杠命令协议与真实输入流程复验

本节覆盖老板在 Quest 输入 `/plan`、`/execute`、`/research`、`/mode`、`/agent`、`/skill` 和 `/mcp` 时的真实解析、项目授权和输入体验。

### 修复结果

- Main 不再使用把 `/plan 创建官网` 误拆成“目标=创建官网、任务为空”的统一正则；新增独立 `questSlashCommand` 纯协议模块。
- `/plan <task>`、`/execute <task>`、`/research <task>` 直接保留完整任务正文；`/mode <auto|plan|execute|research> <task>` 需要明确模式和正文。
- `/agent` 只解析当前项目授权且 READY 的真实数字员工；重名员工必须改用 ID，不能静默选择第一项。
- `/skill` 只允许当前项目已选择且为 ready 的 Skill；`/mcp` 只允许当前项目 ready 的 MCP 和真实工具清单。指定 `server/tool` 时固定到该工具，只指定 server 时 Hermes 只能从该服务的真实工具中选择。
- 未知命令、裸 `/`、缺少任务、非法模式、未授权员工、blocked Skill/MCP 均在进入 Hermes 前明确拒绝，不生成伪队列。
- Main 对成功接受的命令写入 `hermes.quest.command` 审计，目标记录项目和解析后的员工、模式或插件 ID。
- Hermes WebUI 的项目状态补齐 `plugins`；补全菜单只使用 Main 返回的员工和 ready 插件，不读取 Hermes 全局插件列表。
- `/mode` 展示四种模式，`/agent` 插入稳定员工 ID，`/skill` 展示 ready Skill，`/mcp` 展示 ready server 和真实 tool。选择后焦点与光标停在尾部，继续等待老板输入任务正文。
- 输入框在上传附件前做无副作用语法预检；缺参 `/plan` 会保留文本和附件、显示明确错误，上传请求为 0。Main 仍重复严格校验并作为最终权威。

### Electron / 手机黑盒证据

- 报告：`tmp/acceptance-quest-composer/slash-protocol-v2/report.json`
- 桌面截图：`tmp/acceptance-quest-composer/slash-protocol-v2/composer-desktop.png`
- 手机截图：`tmp/acceptance-quest-composer/slash-protocol-v2/composer-mobile.png`
- 结果：**PASS，Renderer console errors 0**。
- 真实 Main Proxy 请求验证 7 个非法命令全部返回 HTTP 422；验证前后队列均为 4 项，没有产生任务。
- `/plan 创建官网并提供预览` 入队正文为 `创建官网并提供预览`；`/research`、`/mode execute` 同样保留完整正文。
- `/agent <employeeId> 验证员工身份` 入队正文带 Main 解析后的真实员工名称，没有沿用旧身份或由 Renderer 自行决定员工。
- 选择 `auto` 补全后输入值为 `/mode auto `，输入框保持焦点，光标位于第 11 个字符末尾。
- 缺参 `/plan` 携带两个待发送附件时，错误可见、附件仍为 2 个、真实上传请求为 0。
- 390x844 手机页面可打开完整命令菜单并包含 `/research`，菜单边界未越出视口。
- 有效命令在确认入队正文后立即取消，目的是验证协议和队列事实而不制造无意义的模型执行结果；本节不把取消任务宣称为业务交付完成。
- 隔离项目本轮没有启用 ready Skill/MCP，因此 UI 正确不显示虚假候选；ready/blocked、工具固定和无工具拒绝由协议测试覆盖，真实插件调用仍需在配置真实插件的场景中继续验收。

### 门禁

- 主项目 `npm run typecheck`：PASS。
- Hermes Web `npm run typecheck` 与 production build：PASS。
- 斜杠协议、Hermes Chat 和员工/插件边界聚焦测试：25/25 PASS。
- 全量 `npm test`：139 个测试文件，1464 passed，1 skipped。
- `npm run build`：PASS。

## 2026-08-22 Quest 手机入口与 DSH 用户侧收口复验

### 产品边界

- Quest/Hermes 是唯一老板调度和手机对话入口；二维码位于当前项目 Quest 右上角弹窗。
- 手机配对后固定进入当前项目 Hermes `/chat`，不再提供旧 DSH Workbench、Session、文件、日志、Memory 或原生管理 WebSocket。
- DSH 调度页面、Workbench、LAN/Web Admin、社区插件目录和 Renderer IPC 已退出产品界面。
- 仍保留的 DSH Main 服务仅用于历史任务恢复和明确选用的受管 CLI Worker；它不出现在导航、引擎目录、插件中心或手机入口，也不能取得调度权。
- Android 执行设备页继续服务真实 Android Worker，不再承担老板手机对话配对；页面只引导用户前往 Quest。

### 本轮真实缺陷与修复

真实用户链路 `Quest -> 右上角手机按钮 -> 二维码弹窗` 首次复验失败。根因是历史测试保存的 Hermes 手机 TLS 证书只覆盖 `127.0.0.1`，而本机当前 Wi-Fi 地址为 `192.168.121.105`。网关按安全规则拒绝了地址不匹配的证书，但此前没有为正常换网场景自动轮换证书。

修复后：

- 仅当 Hermes 手机专用 TLS 证书发生主机地址不匹配时，撤销旧身份并生成覆盖当前局域网地址的新证书。
- 密钥损坏、无法解密或 safeStorage 不可用仍然阻断，不自动清空或伪成功。
- 新项目生成手机配对前停止其他项目的手机 Chat 路由，确保二维码只指向当前项目。
- 网关实际绑定并公布用户配置的同一端口，避免输入端口与二维码地址不一致。
- 黑盒失败时记录弹窗正文、项目 ID、网关状态、检测地址和失败截图，后续不再只得到等待超时。

### 黑盒证据

脚本：`scripts/acceptance-mobile-web-ui.cjs`

结果：`PASS 10/10`

证据：

- `tmp/acceptance-mobile-web/hermes-chat-boundary-v6/report.json`
- `tmp/acceptance-mobile-web/hermes-chat-boundary-v6/desktop-hermes-qr-modal.png`
- `tmp/acceptance-mobile-web/hermes-chat-boundary-v6/mobile-chat-empty.png`
- `tmp/acceptance-mobile-web/hermes-chat-boundary-v6/mobile-chat-after-send.png`

验证事实：

- 桌面 Quest 二维码弹窗位于视口内，遮罩为 `fixed` 且层级不低于 `1000`；嵌入 Hermes View 在弹窗期间隐藏。
- 真实 Operator 配对和同源认证成功，项目状态中的 `projectId` 与桌面当前项目一致。
- `/chat` 返回 `200`；`/sessions`、`/files`、`/logs`、`/api/memory`、`/api/ws` 全部返回 `403`。
- 390x844 触控视口无横向溢出，输入框和附件选择可用。
- 真实发送 `mobile-attachment.md`，Hermes 返回“移动 Web 消息已收到。”，不是 Mock 回执。
- 旧版多角色手机配对入口被拒绝。
- 停止 Hermes 项目服务后，手机项目状态返回真实 `503`。

### 回归门禁

- `npm run typecheck`：PASS。
- `npm test`：PASS，`139 files / 1466 passed / 1 skipped`。
- `npm run build`：PASS。
- TLS/手机聚焦测试：`25 passed`。

## 2026-08-22 真实用户库升级与 DSH 产品层最终清理

### 清理结论

- 老板侧唯一调度入口为 Quest/Hermes；旧 DSH 不再拥有导航、Workbench、计划、插件、手机网关或 Renderer IPC。
- Quest 右上角手机按钮是唯一老板手机配对入口，二维码只绑定当前项目的 Hermes `/chat`。
- DSH Main 内部代码只作为已有任务恢复和受管 CLI Worker 的兼容适配器保留；删除这部分会破坏真实历史任务和明确配置的执行器，不把它重新包装为用户功能。
- Hermes 数据库绑定字段已去除 DSH 治理命名，避免新代码继续依赖已经退出产品层的调度概念。

### 真实升级证据

在现有用户数据目录 `C:/Users/A/AppData/Roaming/aibox-control-center/aibox-data/aibox.db` 上重启新 Main 进程后，迁移结果为：

- `hermes_session_bindings`：`project_id, principal_id, conversation_id, hermes_session_id, last_seen_at, identity_key`
- `hermes_run_bindings`：`hermes_run_id, nexus_task_id, worker_run_id, project_id, plan_hash, status, created_at, updated_at`
- `hermes_plan_projections`：`draft_id, project_id, governance_session_id, hermes_session_id, plan_id, plan_version, plan_hash, status, last_error, created_at, updated_at`
- 旧字段 `dsh_session_id`、`dsh_job_id`、`dsh_run_id`、`dsh_plan_id`、`dsh_version` 均已消失；历史值在事务迁移中保留。
- 审计记录存在：`hermes.binding.schema.migrate=legacy-dsh-columns-removed` 和 `hermes.plan.schema.migrate` 的逐字段迁移明细。
- OPC-Nexus 窗口可响应，Hermes Dashboard 与 Gateway 两个项目服务正常恢复；独立 `website:5173` 进程未受重启影响。

### 桌面黑盒

- 报告：`tmp/desktop-smoke/hermes-only-schema-upgrade/report.json`
- 截图：`tmp/desktop-smoke/hermes-only-schema-upgrade/quest-workbench.png`
- 结果：**PASS**；22 个左侧导航完整，旧 DSH/Mock 产品标签隐藏，Renderer console errors 为 0。
- Quest 左/中/右三栏边界无重叠，中间 Hermes 区域宽度为 `705.43px`。
- 手机入口位于 Quest 顶部工具栏；右侧治理栏不再承载常驻扫码面板。
- 隔离测试未配置 Provider 时 Hermes 明确阻断并显示连接设置入口，没有伪在线或伪成功。

### 门禁

- `npm run typecheck`：PASS。
- Hermes 迁移/治理聚焦测试：`48 passed`。
- 全量 `npm test`：`139 files / 1468 passed / 1 skipped`。
- `npm run build`：PASS。

## 2026-08-22 Quest 项目共享 Skill/MCP 真实调用复验

### 验收目的

此前 `/skill` 与 `/mcp` 已有解析、项目白名单和禁用项拒绝测试，但隔离项目没有配置 ready 插件，因此只能证明协议边界。本轮新增 `scripts/acceptance-hermes-project-plugins.cjs`，使用真实 Provider、动态 Skill 和独立 stdio MCP 进程验证完整运行链路。

### 真实执行结果

- 报告：`tmp/acceptance-hermes-project-plugins/current-r1/report.json`
- 截图：`tmp/acceptance-hermes-project-plugins/current-r1/quest-project-plugins.png`
- MCP 子进程记录：`tmp/acceptance-hermes-project-plugins/current-r1/mcp-invocations.jsonl`
- Provider：`https://api.quya.org`，真实读取 15 个上游模型，本轮使用 `deepseek-v4-pro-0813`。
- 结果：**PASS，7/7，Renderer console errors 0**。

本轮为 Skill 生成随机标记 `SKILL-REAL-CONTEXT::FBE9354B206DA93A5271`。项目启动后，Hermes Home 中真实存在 `skills/opc-nexus/<skillId>/SKILL.md`，文件包含该随机值；老板使用 `/skill <skillId>` 后，Hermes 调用 `skill_view` 并准确返回该值。

本轮 MCP 使用独立 Node stdio 进程完成 `initialize -> tools/list -> tools/call`，工具参数为随机值 `MCP-INPUT::FBE9354B206DA93A5271`。Hermes 使用 `/mcp <serverId>/echo_marker` 后调用 `nexus_mcp_call`，子进程记录真实 `tools/call`，最终回复为 `MCP-REAL-ECHO::MCP-INPUT::FBE9354B206DA93A5271`。

### 治理与审计

- 项目设置只选择本轮 `skill:<id>` 与 `mcp:<id>`；Hermes 项目状态投影二者均为 `ready`，MCP 只暴露真实发现的 `echo_marker`。
- SQLite 存在两条 `hermes.quest.command=accepted`，分别固定到 Skill 和具体 MCP 工具。
- SQLite 存在 `hermes.mcp.call=ok`，目标同时包含项目、MCP server 和 tool，不能仅依赖模型正文声称调用成功。
- MCP 未选择、未运行、非 global 或工具不存在时的 fail-closed 行为继续由聚焦测试覆盖。

### 门禁

- `npm run typecheck`：PASS。
- Skill/MCP/Quest 聚焦测试：`33/33 PASS`。
- 全量 `npm test`：`139 files / 1468 passed / 1 skipped`。
- `npm run build`：PASS。

本轮证明项目共享 Skill 与无凭据本机 MCP 的真实调用链路。需要生产账号或密钥的第三方 MCP 仍应逐个按真实凭据验收，不用本轮本机工具结果替代。

## 2026-08-22 DSH 完全退役与 Hermes 手机单入口最终验收

### 最终架构结论

- Hermes 是唯一调度器。旧 DSH/Cordis 不再作为调度器、Worker、CLI、Workbench、插件中心、手机入口或历史任务恢复服务运行。
- 已删除旧 Runtime 源码、准备/验证/打包脚本、Main 服务、Executor、Kernel、Renderer 页面、Preload/IPC 和专用测试；安装包不再携带 Harness Runtime。
- 数据库 v47 只保留一次性升级识别：删除旧私有表、设置和引擎；旧活动任务明确迁移为 `INTERRUPTED`，旧员工迁移为 `ERROR`。历史终态、成果和审计保留，不静默切换至 Hermes。
- 源码中仍出现的旧 ID/表名只位于数据库迁移、旧员工精确识别和“不得重新暴露”的负向门禁，不是可启动能力。
- 本地生成的 `runtime/deepseek-harness*` 缓存已删除，并加入 `.gitignore`，不会重新进入工作树或打包输入。

### 手机入口边界

- Quest 右上角手机按钮是老板手机对话的唯一入口，二维码绑定当前 `projectId` 和 Hermes Operator 会话。
- 配对成功固定进入 `/chat`。`/sessions`、`/files`、`/logs`、`/api/memory`、`/api/ws` 均返回 `403`。
- 手机支持当前项目聊天、任务队列和附件；不开放全局设置、其他项目、原生 Hermes 管理页或 Android 执行设备控制台。
- Hermes 项目服务停止后项目状态返回真实 `503`，不保留伪在线状态。

### 自动门禁

- `npm run typecheck`：PASS。
- 聚焦退役迁移、IPC、Hermes Mobile 和会话身份测试：`68/68 PASS`。
- 全量 `npm test`：`124 files / 1229 passed / 1 skipped`。
- `npm run build`：PASS，Main/Preload/Renderer 生产构建完成。
- 桌面黑盒：PASS；22 个主导航完整，旧产品/Mock 标签隐藏，Quest 左中右布局无重叠，Renderer console errors `0`。报告：`tmp/desktop-smoke/2026-08-22T14-03-19-071Z/report.json`。
- 手机黑盒：PASS `10/10`；真实 Provider 下完成 Hermes 启动、配对、附件发送和回复。报告：`tmp/acceptance-mobile-web/hermes-only-dsh-retired-final/report.json`。

### 结论

旧 DSH 内容过多确实是此前产品边界混乱的重要来源。本轮清理后，DSH 不再参与任何当前用户流程；手机扫码连接也只有一个含义：连接当前项目的 Hermes 对话。历史迁移代码必须保留到升级覆盖范围结束，但它不可注册服务、IPC、菜单、引擎或插件。

## 2026-08-22 旧运行时目录清除与执行取消一致性复验

### 最终清理

- 升级启动除删除旧 DSH 表、设置、引擎和产品入口外，现在还会删除应用自有数据根下的 `aibox-data/deepseek-harness` 与 `aibox-data/deepseek-harness-managed`。
- 清理只匹配这两个固定内部目录，不扫描相似名称，不删除项目工作区、Hermes Home、历史成果、终态任务或审计。
- 删除结果写入 `legacy.runtimeDirectories.remove` 审计；目录被占用或删除失败时记录真实错误并写日志，不伪装为已清理。
- 使用含旧目录的隔离用户数据启动后复核：两个旧目录均不存在，Hermes 目录和 `aibox.db` 仍存在。
- 重启当前真实用户实例后再次复核：两个旧目录均不存在，Hermes 与数据库保留，OPC-Nexus 主窗口正常响应；独立 website 开发进程未被停止。

### 暂停、取消与超时

- `run_command`、`install_package` 和 `run_python_tool` 现在接收所属任务的 `AbortSignal`；Windows 取消会等待 `taskkill /T /F` 完成，POSIX 使用独立进程组并终止整组。
- 工具自己的超时也走同一进程树终止路径，不再只结束最外层 shell。
- LLM 总超时现在明确写入一次 `执行超时（15 分钟）` 失败回调并放弃等待审批，不再可能长期停在 `RUNNING`。
- 暂停后用同一任务 ID 恢复时，旧执行的迟到 `onDone`、`onError`、工具结果和 `finally` 均不能终结或删除新执行代际。
- Windows 真实子进程回归启动了延迟写文件的 Node 子进程；取消并等待进程树清理后，4 秒延迟文件未出现。

### 最终门禁与黑盒

- `npm run typecheck`：PASS。
- `npm test`：PASS，`125 files / 1234 passed / 1 skipped`。
- `npm run build`：PASS。
- 桌面黑盒：PASS；22 个主导航完整，Quest 左中右三栏无重叠，旧 DSH/Mock 标签隐藏，Renderer console errors `0`。报告：`tmp/desktop-smoke/hermes-only-dsh-purge-final/report.json`。
- 手机黑盒：PASS `10/10`；真实 Hermes 启动、二维码弹窗、Operator 同源认证、`/chat` 唯一路由、390x844 布局、附件发送、assistant 回复和离线 503 全部通过，console errors `0`。报告：`tmp/acceptance-mobile-web/hermes-only-dsh-purge-final/report.json`。
- 手机截图：`desktop-hermes-qr-modal.png`、`mobile-chat-empty.png`、`mobile-chat-after-send.png`，均位于上述移动证据目录。

### 仍未替代的外部验收

本轮 Chromium 触控仿真不能替代不同品牌实体手机首次信任本机 TLS 证书的人工测试；微信、企业微信和飞书仍没有配置真实账号凭据，因此真实渠道收发、审批和交付回执继续保持 `BLOCKED_EXTERNAL`，不得用 Mock 代替。
