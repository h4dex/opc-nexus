# 创作团队真实验收报告

日期：2026-08-24
分支：`codex/v2.0.1-builtin-runtimes`
测试命令：`npm run acceptance:creative-studios`

## 结论

**部分通过，未最终放行。**

run18 完成了“老板描述团队 -> Hermes 创建真实员工 -> 澄清 -> 计划版本/hash -> 老板批准 -> DAG 派工 -> 多员工真实执行 -> 文件 Manifest”的主链路。独立验收员工确实被创建并执行，但本轮脚本错误地选择了章节写手再次验收，Main 返回 HTTP 422 并阻止了非法验收委派。系统没有伪造 PASS，这是符合治理要求的阻断。

## 通过证据

证据目录：`tmp/acceptance-creative-studios/run18/`

- Provider：`https://api.quya.org`，模型 `deepseek-v4-pro-0813`，真实模型列表 15 个。
- Hermes 创建 4 名真实员工，均为 `eng-nexus`：世界观架构师（`long_term`）、角色设计师（`long_term`）、章节写手（`short_term`）、独立文学验收编辑（`none`）。四个 ID 由 Main 返回并写入数据库，未加入固定项目池。
- 澄清问题持久化后得到老板回答，状态为 `ANSWERED`。
- 计划 `hermes-draft-a133e645-ca04-4261-9851-8305de34fb0a` 获得 version `1` 和 hash `605f4e9819b350b2c9d7861328015cc8443c3fe5c9446d8b261a1d94540eac7a`，随后状态为 `APPROVED`、`DISPATCHED`。
- 三名实现员工真实完成任务，写入：
  - `research/world-bible.md`
  - `research/character-bible.md`
  - `draft/chapter-01.md`
- Main 为任务生成真实 Manifest，包含相对路径、SHA-256、预览标志；截图：`2-novel-team-staffing.png`、`2-novel-team-delivery.png`。
- Renderer console errors：0。

run16 还证明了独立验收员工能真实读取三个文件并输出一致性检查；由于验收文本较长，在 6 分钟门禁时处于 `RUNNING 52%`，该轮按规则记为阻断，未把中间结果算作完成。

## 阻断和修正

1. 验收脚本原先用员工列表最后一项作为验收员工，实际选中了章节写手；系统正确拒绝“实现员工再次验收”。脚本已改为按“验收/审校/校对”职责选择，并要求计划 DAG 只包含三个实现节点，验收员工只能在实现完成后单独委派。
2. run17 的真实 Provider 返回 HTTP 503，员工创建首轮直接阻断；没有伪造员工或任务。
3. run19/run20 的 Hermes Gateway 在启动阶段收到 SIGTERM，未进入业务步骤。该现象来自验收环境中的 runtime 启动竞态，已保留为 BLOCKED，不作为业务 PASS。

## 当前放行边界

已可以依赖：Hermes 通过自然语言创建真实数字员工、记忆策略持久化、动态项目组队、真实 DAG 执行、项目目录写入和 Manifest。
尚不能宣称：本轮小说和影视两个场景均完成独立 `PASS` 验收；需要在 Provider 稳定、Hermes runtime 无启动竞态后重新执行 run19+，并确认独立验收结论、交付目录和手机状态。

## 最新复测补充

- `run21`、`run22`：Provider 模型列表和连通性测试通过，但新项目首次启动时 Dashboard/Gateway 未在原 45 秒门禁内监听，业务步骤未开始，记录为 `BLOCKED`。
- 已将 Hermes 冷启动门禁调整为 120 秒，并保留 `starting-dashboard`/`starting-gateway` 状态；不把延迟启动显示成在线或成功。
- `run23`：Dashboard/Gateway 约 55 秒后真实监听，健康接口均返回 Hermes `0.19.0`；Hermes 已真实完成员工组建、澄清、老板回答和计划提交，并生成 `2-novel-team-staffing.png`。随后中转站第二次模型调用长时间无响应，未进入派工和独立验收；按真实结果记为未放行。验收脚本已增加 180 秒请求超时，避免上游卡住时遗留测试进程。

因此，最新证据进一步确认“自然语言创建员工”链路可用，但完整的“组队 -> 多员工执行 -> 独立验收 -> 复杂交付”仍需在 Provider 响应稳定后重新跑完，不能仅凭 `run23` 的部分证据宣称全部通过。
