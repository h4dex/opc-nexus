# OPC-Nexus 小说团队真实验收报告

日期：2026-08-24
范围：两个目标 30 万字的小说项目、Hermes 动态组队、数字员工执行、独立验收、Office Skills

## 结论

本次不能宣称“两部 30 万字小说已完成”。最终结论为 **BLOCKED（长篇试产未完成）**。

这不是 Mock 结果：测试通过 Electron、preload、Hermes 项目代理和 OPC-Nexus Main 的真实入口发起请求；没有直接写 SQLite、创建假员工、创建假任务或用重复文本填充字数。早期运行曾被上游中转站 502 阻断；本轮改用官方 DeepSeek Provider 后，Hermes 和真实员工均已确认走 `https://api.deepseek.com/v1`。但长篇试产仍未在门禁时间内完成，不能把部分文件或仍在运行的任务标成完成。

此前的真实短篇闭环基线仍然有效：[`tmp/acceptance-creative-studios/run18/report.json`](../tmp/acceptance-creative-studios/run18/report.json) 记录过 Hermes 创建 4 名员工、澄清、计划版本/hash、批准、派工、4 个任务真实完成、交付文件和独立验收。该基线证明 OPC-Nexus 的短篇创作闭环可以运行，但不能替代本次 60 万字门禁。

## 目标与防失控边界

| 项目 | 目标 |
|---|---:|
| 小说数量 | 2 |
| 每部目标字数 | 300,000 |
| 总目标字数 | 600,000 |
| 本轮试产 | 每部世界观、人物卡、长篇大纲、前 2 章 |
| 字数统计 | 实际读取项目 Markdown/TXT 文件，去除空白后的字符数 |

长篇任务被明确分为“30 万字生产目标”和“真实试产批次”。在没有确认模型配额、失败恢复和单章质量前，不启动无人监管的 60 万字长跑；报告中不把试产当成全量交付。

## 真实运行记录

### 运行 1：默认模型 `deepseek-v4-flash-0731`

证据目录：[`tmp/acceptance-novel-studio/run-current`](../tmp/acceptance-novel-studio/run-current)

- 两个项目的 Hermes Gateway 和项目代理均启动，并分别同步了 `docx/xlsx/powerpoint` 上游 Skill。
- Provider 模型列表读取成功，连通性探测延迟约 267ms。
- 两个项目在员工建档前收到 HTTP 502/503（`Upstream service temporarily unavailable`），Hermes 按 3 次策略重试后返回真实错误。
- 小说 A 运行约 162 秒，小说 B 运行约 31 秒。
- 员工调用：0；任务回执：0；实际字数：0。

### 运行 2：`deepseek-v4-pro-0813`

证据目录：[`tmp/acceptance-novel-studio/run-pro`](../tmp/acceptance-novel-studio/run-pro)

小说 A 的真实进展：

- 项目创建：`project-95f02e23`。
- Hermes 创建 6 名真实数字员工，均由 Main 返回并持久化：总编秘书、世界观架构师、人物与关系设计师、长篇大纲编辑、章节写手、独立文学验收编辑。
- 记忆策略真实落库：总编/设定/人物/大纲为长期记忆，写手为短期记忆，验收编辑为无记忆。
- Hermes 提出澄清问题：“30 万字长篇希望按哪种体量切分章节与分卷”。
- 由于第一次脚本回答没有给出明确章节体量，Hermes 正确保持澄清未完成，计划没有被提交；该行为被记录为流程阻断而非伪成功。
- 耗时约 352 秒；Hermes 对话 2 次；任务回执 0；实际字数 0。

小说 B 在员工建档阶段受到同一中转站 HTTP 502 `Upstream access forbidden, please contact administrator` 阻断；耗时约 52 秒，员工和任务均为 0。

### 运行 3：`qwen3.6-max-preview`

证据目录：[`tmp/acceptance-novel-studio/run-qwen`](../tmp/acceptance-novel-studio/run-qwen)

- 两个项目均在首次 Hermes 对话前收到 HTTP 502 `Upstream access forbidden, please contact administrator`。
- 每个项目约 52 秒；员工调用 0；任务回执 0；实际字数 0。

### 运行 4：官方 DeepSeek `deepseek-v4-flash`

证据目录：[`tmp/acceptance-novel-studio/run-deepseek-official6`](../tmp/acceptance-novel-studio/run-deepseek-official6)

- Provider 通过真实 `/v1/models` 和最小对话探测；报告记录 3 个官方模型，运行时 `hasKey=true`，密钥未写入报告。
- 发现并修正了旧的显式 `eng-nexus` 路由：此前 Worker 仍绑定 `api.quya.org / deepseek-v4-pro-0813`，所以 Hermes 能回复但员工任务在 5% 收到上游 502。脚本现在在本次 Provider 配置后同步保存 `eng-nexus` 的 `providerId/modelOverride/protocol` 并重载引擎。
- 小说 A 真实创建 6 名员工，计划成功经历 `PROJECTED -> APPROVED -> DISPATCHED`，创建 6 个真实任务；世界观员工真实写入 `bible/world.md`，Main 生成并校验了 26,424 bytes 的 Artifact Manifest 和 SHA-256。人物任务也已真实完成。
- 任务曾真实进入 `WAITING_APPROVAL`（`make_dir`），验收脚本随后通过 `window.aibox.decideApproval` 模拟老板批准，保留了审批与审计记录；没有直接写 SQLite。
- 由于单个 DeepSeek 员工批次响应时间较长，旧版 900 秒任务门禁到期，脚本报告 `BLOCKED`，Electron 关闭后剩余任务仍可能停留在 `RUNNING/QUEUED`。这属于恢复/收尾问题，不能视为完成；脚本已改为默认 2,400 秒，并在失败时通过正式 `cancelTask` 接口收尾。
- 小说 B 在小说 A 超时后仅完成启动/建档阶段，没有进入可验收的生产批次。

## Hermes 调度与子代理统计

本次新建的验收脚本为 [`scripts/acceptance-novel-studio.cjs`](../scripts/acceptance-novel-studio.cjs)，统计来源是 Main 返回的员工/任务状态和 Hermes 真实响应：

- 目标项目：2 个。
- 真实创建员工：运行 2 的小说 A 为 6 名；其他运行因 Provider 阻断为 0。
- 可观察 Hermes 对话：运行 2 的小说 A 为 2 次（建档、澄清/计划准备）。
- 可观察任务回执：0 个，原因是计划尚未通过澄清/Provider 门禁。
- 独立验收调用：0 个，原因是没有产生可验收的试产任务。
- 重试：每次上游请求由 Hermes 执行 3 次真实重试；业务层没有擅自重试或伪造成功。
- 失败/阻断：全部保留在报告 `error` 和 Hermes `errors.log` 中。

“子代理调用次数”在没有 `nexus_delegate_task` 任务回执时不虚构为 0 次成功调用；本次以 Main 可验证的任务回执为准，明确为 **0 个已创建的子任务**。

## Office Skills

### 已内置并同步

每个新建项目的 Hermes Home 都存在完整上游文件：

- `skills/productivity/docx/SKILL.md`（8,178 bytes）
- `skills/productivity/xlsx/SKILL.md`（9,126 bytes）
- `skills/productivity/powerpoint/SKILL.md`（20,539 bytes）

此外，`seedSkills()` 已改为幂等的 `ensureBuiltinSkills()`：升级时即使数据库已有其他技能，也会补齐缺失的 Word/Excel/PPT 条目；旧版同名技能不重复插入、不覆盖用户修改或禁用状态。

### 真实运行时依赖

Hermes Runtime 已安装并通过校验：

- `python-docx 1.1.2`
- `openpyxl 3.1.5`
- `python-pptx 1.0.2`

校验命令：`npm run hermes:verify:office`，结果为 `READY_WITHOUT_LIBREOFFICE`。真实文件 smoke 命令：`npm run acceptance:office`，结果为 `PASS`，产物在 [`tmp/acceptance-office-skills/2026-08-24T05-05-55-403Z`](../tmp/acceptance-office-skills/2026-08-24T05-05-55-403Z)。

该 smoke 真实生成并检查了 `.docx`、`.xlsx`、`.pptx` 文件和 SHA-256。当前机器没有 `soffice`/LibreOffice，因此 Office 转 PDF、公式重算和渲染缩略图仍是 **未放行能力**，不能在 UI 中宣称已验证。

## 当前放行判断

| 能力 | 结论 | 证据 |
|---|---|---|
| Hermes 项目隔离启动 | 通过 | 三轮项目 Home 和 Gateway 日志 |
| 上游 Office Skills 同步 | 通过 | 每项目三份 `SKILL.md` |
| Office Python 生成 | 通过 | `acceptance:office` 三个真实文件 |
| Provider 模型列表读取 | 通过 | 三轮报告 `modelCount=15` |
| Provider 对话稳定性 | 通过（官方端点） | `run-deepseek-official6` Hermes 日志全程为 `https://api.deepseek.com/v1` |
| 长篇试产执行时限与恢复 | 阻断 | 小说 A 900 秒门禁超时，剩余任务未完成收尾 |
| 两部 30 万字完整交付 | 未完成 | 无完整章节任务和真实字数 |
| 独立验收 | 未执行 | 没有可验收任务 |
| LibreOffice 转换/渲染 | 未放行 | 本机未安装 `soffice` |

## 下一轮必须做

1. 先在 Provider 控制台确认当前 key 所属分组对 `deepseek-v4-pro-0813`、`qwen3.6-max-preview` 的 `/v1/chat/completions` 权限，不能只看 `/models` 能返回。
2. 重新运行 `npm run acceptance:novel-studio`，并明确回答章节体量；脚本现在使用“2500-3000 字/章、约 120 章、12 卷”的明确答案。
3. 只有试产批次完成并通过独立验收后，才按分卷逐批派工；每批完成后读取真实 manifest 和字数，失败批次暂停，不自动伪造补齐。
4. 安装并纳入打包的 LibreOffice，重新验证 Office 转换、公式重算和 PPT/Word 预览。
