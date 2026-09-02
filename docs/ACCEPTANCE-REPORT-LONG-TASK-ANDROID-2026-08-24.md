# OPC-Nexus 长任务与 Android 执行设备验收报告

日期：2026-08-24  
版本：v2.0.1  
分支：`codex/v2.0.1-builtin-runtimes`  
范围：Hermes 长任务、任务取消、动态组队、Android Worker 配对与设备操作

## 2026-08-25 修复复验

本节记录对原报告两个 P1 阻断的修复，不改写 2026-08-24 的历史验收事实。

### Android 首次配对与证书恢复：已修复

- `Android 执行设备` 页面已增加可见的“配对 Android Worker”入口；网关未启动时明确阻止操作。
- 配对弹窗通过受限 `aibox-mobile://pairing/<id>` 显示真实 PNG 二维码，显示过期倒计时并支持重新生成。
- “复制完整配置”只向 Main 传 pairingId；密钥不进入 Renderer 状态、页面文本或日志。Main 写入系统剪贴板后回读验证，失败时明确报错，不再伪成功。
- 网关栏已增加“连接修复与证书重置”入口和破坏性确认，明确说明网关会停止、旧设备需要重新配对。
- 已保存证书不覆盖新 LAN 地址时，页面显示可执行的重置恢复动作。
- Android 权限值已本地化为“已授权 / 已拒绝 / 受限制 / 未知”。

真实复验使用桌面可见按钮完成“重置证书 -> 启动网关 -> 打开配对弹窗 -> 生成/刷新二维码 -> Android 上线”，随后完成 Hermes 自然语言任务、25 条手机命令及截图/WAV/MP4 三类产物。共 42 个步骤，耗时 77,984 ms，`ok=true`。当前 Windows 桌面会话的系统剪贴板对 PowerShell 和 Electron 都不可用，软件已如实提示；二维码扫码主路径不受影响。

### 重复 validation 派工：已修复

- Main 派工边界现在使用 `projectId + validation + workerAgentId + sorted(unique(relatedTaskIds))` 生成永久语义幂等键。
- 验收标题、描述、requestId、Hermes session 和 relatedTaskIds 顺序变化不再创建第二条任务。
- 旧版本已创建的同语义 validation 任务也会从任务内容中识别并复用。
- 最终提交继续经过 `tasks(source, source_key)` 唯一索引，两个工具调用并发穿透前置查询时仍只能提交一条任务。
- Acceptance Coordinator 会识别同一会话中正在 `QUEUED/RUNNING` 的人工验收 turn，在进入 Hermes 前抑制自动验收 prompt。
- 终态 validation 仍由 `nexus_task_status` 计算权威 `PASS / FAIL / BLOCKED`，Renderer 和 Hermes 文本不能自行改写。

验证结果：`npm run typecheck` 通过；`npm test` 共 130 个测试文件、1268 个测试通过、1 个按原配置跳过；生产构建通过。新增回归覆盖相同请求、乱序/重复 relatedTaskIds、不同验收员工、人工验收 turn 与自动验收冲突。原 18 分 54 秒小说实现 DAG 未在本次聚焦修复中完整重跑，因此本节只放行这两个缺陷，不把原报告其他未通过项改写为整体通过。

## 总结

本轮结论为 **部分通过，不能整体放行**。

- Android Worker 的底层执行链路通过：真实 Android 14 模拟器完成 WSS 配对、Hermes 自然语言工具调用、读屏、截图、定位、通知、录音、录屏、断线重连和脚本执行。
- Android Worker 的新用户操作流程未通过：桌面 UI 没有可见的 Android Bridge 配对按钮，也没有证书地址不匹配时的可见重置入口。本轮只能通过公开 preload API 和 debug APK 的 ADB-only 配对接收器完成自动验收。
- 长任务实现 DAG 通过：Hermes 创建本轮唯一的 6 名员工，完成澄清、老板回答、计划投影、版本/hash、批准、派工，以及 4 个顺序依赖任务和 5 份真实文件。
- 长任务最终交付未通过：自动验收与显式验收同时触发，产生两条重复 validation 任务；180 秒验收请求超时后任务被清理取消，没有形成权威 PASS/FAIL/BLOCKED 验收结论。
- 长任务取消执行部分通过：60 秒终端进程以退出码 130 被真实中断，下一条指令返回 `NEXT_TASK_OK`；但取消事实没有写入 Hermes 原生会话历史，重载后缺少可审计的取消闭环。

## Android Worker

### 环境

- 模拟器：`OPCNexus_API34` / `emulator-5554`
- Android：API 34
- APK：`release/OPC-Nexus-Mobile-Bridge-0.4.3-debug.apk`
- Bridge：v0.4.3 / protocol 1
- Hermes：v0.19.0
- 工具目录：42 个 Android 工具

### 通过项

验收共记录 39 个步骤，耗时 80,904 ms，最终 `ok=true`。

| 能力 | 真实证据 | 结论 |
|---|---|---|
| WSS Gateway | `wss://192.168.121.105:18765/v1/device`，固定 SPKI | 通过 |
| 配对安全 | 一次性 secret、PNG QR、`cache-control: no-store`、剪贴板载荷一致 | 通过 |
| 设备身份 | 断线重连后仍为同一 deviceId | 通过 |
| Hermes 调度 | 自然语言任务真实调用 `android_current_app`、`android_read_screen` | 通过 |
| 读屏 | 返回 39 个 UI nodes，任务事件中敏感 UI 树已脱敏 | 通过 |
| 基础操作 | 打开应用、返回、滑动、截图 | 通过 |
| 定位 | 注入并读取上海坐标 31.2304 / 121.4737 | 通过 |
| 通知 | Notification Listener 返回注入通知 | 通过 |
| 麦克风 | 生成并校验 64,044 bytes WAV，头为 RIFF/WAVE | 通过 |
| 录屏 | 生成并校验 68,932 bytes MP4，包含 `ftyp` | 通过 |
| 自动化脚本 | 2 步 JSON DSL 全部完成 | 通过 |
| 审计 | 25 条命令、3 个媒体 Artifact | 通过 |

证据：

- [`mobile/dist/e2e/result.json`](../mobile/dist/e2e/result.json)
- [`mobile/dist/e2e/desktop-mobile-console.png`](../mobile/dist/e2e/desktop-mobile-console.png)

### Android 阻断

1. **P1：桌面 UI 没有 Android Worker 配对入口。** `createAndroidBridgePairing` 和 `copyAndroidBridgePairingConfig` 已存在于 Main/preload，但 `Android 执行设备` 页面没有对应按钮、二维码或复制配置流程。新用户能启动网关，却无法从可见 UI 完成首次配对。
2. **P1：证书恢复动作不可见。** 已保存证书不覆盖新 LAN 地址时，启动只返回“reset the mobile certificate”；页面没有调用 `resetMobileCertificate` 的操作入口，也没有说明重置会使旧设备需要重新配对。
3. **P2：本轮自动配对依赖 debug APK 的 ADB-only receiver。** 底层协议和设备执行已验证，但真实用户扫码/粘贴配置的完整 UI 流程没有通过。
4. **P3：中文页面混用 `granted` / `denied`。** 权限栏状态未本地化，和主程序中文风格不一致。

## 长任务取消

测试指令要求员工运行一个 60 秒 Node 命令，等待结束后才允许回复 `OLD_TASK_COMPLETED`，随后老板点击“取消任务”并发送新指令。

### 已确认事实

- 队列状态进入 `CANCELLED`。
- 终端工具返回 `[Command interrupted]`，退出码为 130。
- Hermes 日志记录 `reason=interrupted_by_user`。
- 下一条指令约 3 秒后返回 `NEXT_TASK_OK`。
- 旧任务没有返回 `OLD_TASK_COMPLETED`。
- UI 曾显示“已由老板取消；验收研究员不会继续执行这条指令”。

### 未通过项

1. **P1：取消回执没有进入 Hermes 原生 transcript。** `chat-history` 中找不到明确的 cancelled-turn closure；UI 回执是队列层的瞬时合成内容，重载/跨端审计不完整。
2. **P2：取消后的下一轮出现 system prompt 为空。** 日志记录 `Stored system prompt ... is null; rebuilding from scratch this turn`。相同警告也在 clarification answer 和 validation turn 出现，说明跨轮上下文持久化不稳定。
3. **P2：失败截图中央 Hermes WebView 为空白。** 取消测试失败收尾时，主窗口仍显示项目和治理侧栏，但中央对话区为空，用户无法从截图复核对话历史。

证据：

- [`tmp/acceptance-quest-cancellation/long-task-2026-08-24/report.json`](../tmp/acceptance-quest-cancellation/long-task-2026-08-24/report.json)
- [`tmp/acceptance-quest-cancellation/long-task-2026-08-24/cancelled-turn-and-follow-up.png`](../tmp/acceptance-quest-cancellation/long-task-2026-08-24/cancelled-turn-and-follow-up.png)

## 动态团队长任务

### 调度链路

Hermes 为本轮项目创建 6 名唯一员工：总编秘书、世界观架构师、人物与关系设计师、长篇大纲编辑、章节写手、独立文学验收编辑。员工分别使用长期、短期和无记忆策略。

计划权威事实：

- projectId：`project-7eb3bfbe`
- plan version：1
- plan hash：`08f79a1e3e05b710b624022a93bb35a7186502ee433bd7c69f093f7af9cb12f9`
- 最终计划状态：`DISPATCHED`
- 实现 DAG：世界观 -> 人物 -> 大纲 -> 前两章

### 实现任务

| 任务 | 状态 | 耗时 | 真实产物 |
|---|---:|---:|---|
| 世界观圣经 | COMPLETED | 117,265 ms | `bible/world.md`，18,830 bytes |
| 人物与关系卡 | COMPLETED | 422,650 ms | `bible/characters.md`，58,726 bytes |
| 12 卷长篇大纲 | COMPLETED | 342,773 ms | `outline/novel-outline.md`，82,568 bytes |
| 前两章正文 | COMPLETED | 251,435 ms | 两章共 16,673 bytes |

实现 DAG 总耗时 1,134,123 ms（约 18 分 54 秒），总产物 176,797 bytes、66,413 个非空白字符。两个试产章节分别为 2,788 和 2,796 个非空白字符，符合本轮 2,500-3,000 字/章的范围。

证据目录：[`tmp/acceptance-novel-studio/long-task-rerun2-2026-08-24/novel-a/workspace`](../tmp/acceptance-novel-studio/long-task-rerun2-2026-08-24/novel-a/workspace)

### 长任务阻断

1. **P1：同一会话允许自动验收和显式验收并发。** 自动治理消息 `[OPC-NEXUS-AUTO-VALIDATION]` 与老板显式验收消息相差约 1 秒进入同一 Hermes session；日志随后出现 message alternation repair。
2. **P1：validation 派工缺少幂等保护。** Hermes 实际调用 `nexus_delegate_task` 两次，创建两条同 worker、同 relatedTaskIds、同 intent、同标题的验收任务，造成重复成本和状态歧义。
3. **P1：验收未形成权威结论。** 第一条验收运行 155,249 ms 到 32%，第二条排队；180 秒调用超时后的正式清理把两条任务置为 `CANCELLED`，validationVerdict 为 `BLOCKED`。
4. **P1：客户端请求取消没有同步终止直接 `chat-turn`。** 测试请求在 180 秒 abort 后，Hermes turn 仍继续运行约 15 秒并启动 background review。该问题针对直接 `chat-turn` 路径；持久化 queue 路径需要单独验证。
5. **P2：验收员工读取大文件被截断。** 日志明确报告人物卡在约 24k chars 截断；若不支持范围读取或分块索引，独立验收无法证明检查了全部 58 KB 人物卡和 82 KB 大纲。
6. **P2：已有同名员工时 Hermes 对创建事实表述错误。** 首轮六次工具调用复用了旧员工 ID，Hermes 却回复“全部建档完成”；Main 按本轮新增员工计数为 0 并正确阻断。验收脚本改用唯一名称后才真实创建本轮员工。

## 放行判断

| 能力 | 结论 |
|---|---|
| Android 工具执行与媒体采集 | 通过 |
| Android 新用户可见配对流程 | 未通过 |
| Android 断线重连和审计 | 通过 |
| 长任务 DAG 顺序执行与真实文件 | 通过 |
| 长任务取消实际进程 | 通过 |
| 取消事实跨重载会话审计 | 未通过 |
| 主秘书触发独立员工验收 | 已触发但重复 |
| 独立验收最终 verdict | 未通过 |
| 完整“老板下令 -> 组队 -> 执行 -> 独立验收 -> 交付” | 未放行 |

## 建议修复顺序

1. 为 `nexus_delegate_task` 增加由 `projectId + intent + workerAgentId + sorted(relatedTaskIds)` 形成的幂等键；活跃或已终态的同键任务不得重复创建。
2. 统一所有 Hermes 入口到同一个 conversation queue，自动治理、桌面、手机和渠道消息不得并发直写同一 Hermes session。
3. 将取消闭环写入 Hermes 会话历史，并验证应用重启、手机和渠道端都能看到同一取消事实。
4. 为 Android 页面恢复“配对设备”弹窗和“重置证书并重新配对”恢复动作，保留破坏性影响提示。
5. 让 validation worker 使用分页/范围读取或文件索引，报告必须记录读取覆盖率和 SHA-256，不能只检查文件存在。
6. 修复 Hermes session system prompt 的持久化，消除每个后续轮次从 null 重建的警告。
