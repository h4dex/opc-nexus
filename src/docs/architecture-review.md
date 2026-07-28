# OPC-Nexus 架构与产品诊断报告

> 评审日期：2026-07-28 · 评审基线：`6f61ee5`(v1.1.0) + 后续提交 `4cd2cd3` / `f567cb0`
> 评审视角：AI 产品经理 + 系统架构师
> 维护者：liyingjie \<y@senke.com\>

本文是 OPC-Nexus 的阶段性健康度评审，记录问题、成因判断与优先级建议。
修复进度以本文的「状态」列为准，具体变更记录见 `CHANGELOG.md`。

---

## 一、结论摘要

项目功能广度已显著超出验证深度。核心矛盾是：

- **37 个主进程服务、23 个前端页面、1134 行共享类型定义**
- **18 个测试文件 / 190 个用例**（引擎层从零覆盖补到 EngineManager 状态机 + Hermes 执行器 + 凭据隔离 + 编码委派）

产品的核心价值主张是「本地优先的桌面 AI Agent 管理器」，但直到近期提交前，
默认引擎调用的并非真实 Agent Runtime，而是自研的 OpenAI 兼容工具循环。
主干路径（派发任务 → 真实引擎执行 → 可信产物）是最薄弱的一环。

**建议**：冻结新功能模块，优先把主干路径做扎实，并把重后端能力迁出 Electron。

---

## 二、近期提交已解决的问题

评审基线之后的两个提交已修复部分原始诊断项，此处如实记录：

| 提交 | 已解决 |
|---|---|
| `4cd2cd3` | 统一供应商数据源（`providers` 表为唯一来源）；内置自研运行时更名 **Nexus Agent**，与真实 Hermes 区分 |
| `f567cb0` | 引入主辅引擎策略；新增 `executionMode` 开关用于生产模式禁用模拟回退 |

因此原「Provider 双数据源」与「Hermes 命名语义错误」两项已闭环，不再列为待办。

---

## 三、诚实性缺陷（最高优先级）

此类问题的共同点：**系统会向用户展示不真实的状态**。
对一个托管「数字员工」执行真实工作的产品，这是信任崩塌级别的缺陷。

| 编号 | 问题 | 位置 | 后果 | 状态 |
|---|---|---|---|---|
| H-1 | `executionMode` 默认值为 `demo`，模拟回退在默认配置下仍生效 | `userConfig.ts` | 引擎配错时任务显示 COMPLETED，产物为虚构内容 | ✅ 已改为 `production` |
| H-2 | 自动补位造假任务默认开启（`demoAutoTasks=true`，水位 8） | `orchestrator.ts` `replenishTasks()` | 系统自动生成用户从未派发的任务 | ✅ 已改为默认关闭、水位 0 |
| H-3 | 演示种子数据混入生产库（12 员工 / 23 已完成任务 / 8 待审批） | `seed.ts` | 首次启动即显示 23 条虚假「已完成」，与真实数据同表无隔离标记 | ✅ 默认不再写入（需 `seedDemoData` 显式开启）；v27 增加 `is_demo` 列并回填历史库，首页统计排除演示行，设置页可一键清空 |
| H-4 | 「登录授权」按钮直接改库状态，无真实鉴权 | `engineManager.ts` | 点击即标记 HEALTHY，健康状态不可信 | ✅ 改为 `probeAuth()` 真实探测：内置引擎查供应商配置，CLI 引擎跑最小 headless 请求；鉴权类错误标 AUTH_REQUIRED，超时标 DEGRADED 而非误判已登录 |

**H-3 的严重性高于模拟执行**：演示数据与真实数据共用同一张表且无 `is_demo` 标记，
一旦用户开始真实使用，统计口径永久污染，无法区分。

建议方案：新增 `is_demo` 列，所有统计查询显式排除；或提供「清空演示数据」的首启引导。

---

## 四、安全问题

| 编号 | 问题 | 位置 | 状态 |
|---|---|---|---|
| S-1 | Web 管理面板默认监听 `0.0.0.0`，局域网内任何人可访问派发任务的管理界面 | `webServer.ts` | ✅ 已改为默认 `127.0.0.1`，需显式开启 `webExposeLan` |
| S-2 | 访问 Token 打印到 console，凭据进入日志 | `webServer.ts` | ✅ 已移除 |
| S-3 | `~/.hermes/` 目录与真实 hermes-agent 冲突：后者用同目录存 `config.yaml`/`.env`/`skills/`/会话库，导出逻辑会覆盖用户 skills，`.env` 内含 API 密钥 | `hermesSync.ts` | ✅ 已划定归属边界：我方仅写 `mcp_servers.json` 与 `skills/opc-nexus/`，只读不碰 `config.yaml`/`.env`；支持 `HERMES_HOME` 与 Windows `%LOCALAPPDATA%\hermes` |
| S-4 | 引擎环境变量明文存库，UI 明确提示可填 `API_KEY=sk-...` | `engineManager.ts` `saveConfig` / `Engines.tsx` | ✅ 已拆分：敏感键（`KEY`/`TOKEN`/`SECRET`/`PASSWORD`/`CREDENTIAL`/`AUTH`）经 `safeStorage` 加密存 `secret:engine:<id>:env`，`config_json` 中只留 `***` 占位符；spawn 时由 `engineEnv.ts` 还原，仅存活于子进程 |

Web 面板的鉴权基线本身不差（Bearer Token、会话 24h 过期、分级频率限制、弱口令审计告警），
问题集中在默认暴露面与凭据处理。

---

## 五、引擎体系设计

### 结论：原设计的命名语义是错的，收敛方向正确

原实现把「Hermes」定义为 OpenAI 兼容 API 直连，工具循环由 `llmApiExecutor.ts` 自行实现，
仅同步 `~/.hermes/` 下的 MCP 与 Skills，**从未启动任何 Hermes 进程**。
即：它是一套自研 Agent Runtime，只是借用了 Hermes 的名字。
`4cd2cd3` 已将其更名 **Nexus Agent**，命名语义就此对齐。

### 目标引擎清单（E-1 ✅）

收敛为四种，其余（ZCode、Kimi、Claude Code 等）从种子数据与 UI 移除：

| 引擎 | 定位 | 执行器 | 说明 |
|---|---|---|---|
| **Nexus Agent** | 自研内置运行时 | `LlmApiExecutor` | 工具循环 / 审批门禁 / 会话记忆已实现，零外部依赖，作保底可用引擎 |
| **Hermes Agent** | 默认主引擎 | `HermesAgentExecutor` ✅ | 真实 CLI（`hermes -z` headless），负责规划、记忆、通用任务 |
| **OpenCode** | 编码专家 | `CliExecutor` | 由主引擎委派承接代码修改、仓库分析、测试 |
| **Codex CLI** | 备选编码引擎 | `CliExecutor` | 与 OpenCode 同类，供用户择一 |

### 主辅策略（E-2 ✅）

已确认语义为**编码专家委派**，而非故障回退：

- Hermes 作主脑负责规划与通用任务；判定为编码类任务（代码修改 / 仓库分析 / 测试）时委派 OpenCode。
- **业务失败不切引擎**；仅基础设施级错误（启动失败、超时、限流、服务不可用）才走辅助引擎。
- `agents.engine_id` 保留为主引擎，委派与回退规则收敛到独立的 EnginePolicy。
- ✅ `engine_routing` 已落地消费：按任务来源路由，且**仅当目标引擎 HEALTHY 时生效**；
  UI 下拉同步只列 HEALTHY 引擎，避免「选了不生效」的假开关。
- ✅ 实现方式：任务级 `engineOverride`（v28 `tasks.engine_override`），
  子任务仍归属原员工（审批与审计链路不变），仅执行引擎不同；
  `delegate_coding_task` 工具仅在 OpenCode HEALTHY 时注册给模型。

### 推荐安装方式（UI 待接入）

引擎管理页应为未安装引擎提供一键安装。命令如下（npm 系走 `.npmrc` 已配的 npmmirror 镜像）：

```bash
# Claude Code
npm i -g @anthropic-ai/claude-code@latest
# Codex
npm i -g @openai/codex@latest
# Gemini CLI
npm i -g @google/gemini-cli@latest
# Grok Build
npm i -g @xai-official/grok@latest
# OpenCode
npm i -g opencode-ai@latest
# OpenClaw
npm i -g openclaw@latest
```

Hermes 走 PowerShell 安装脚本（非 npm）：

```powershell
irm https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1 | iex
```

**实现约束**：
1. 安装命令必须**硬编码为白名单常量**，不接受 Renderer 传入任意命令字符串 —— 否则等于开放任意命令执行。
2. 安装为高风险操作（全局装包 / 执行远程脚本），须在 UI 显式确认后执行，并写 AuditLog。
3. Hermes 的远程脚本安装需向用户明示来源域名与「执行远程脚本」的性质，不可静默执行。
4. 四引擎之外的命令（Gemini / Grok / OpenClaw / Claude Code）可保留在安装白名单中供用户自取，
   但**不进入引擎清单**，避免清单再次膨胀。

---

## 六、架构缺陷

### A-1 IPC 层是 880 行的上帝对象 ⬜

`ipc.ts` 注册全部领域的 handler，`IpcDeps` 注入数十个服务。
任何新功能都必须修改此文件 → 天然的合并冲突热点，且无法按领域独立测试。

**建议**：按领域拆为 `registerEngineIpc(deps)` / `registerProjectIpc(deps)` / `registerChannelIpc(deps)` 等，
`ipc.ts` 退化为组装入口。白名单语义与参数校验约定保持不变。

### A-2 全量快照推送模式已不适配当前规模 ⬜

每次状态变化广播全量快照，`agentCards()` 内部执行多条 SQL 与多轮 map 构建。
节流 300–400ms 缓解了频率，但单次 payload 与计算成本均为 O(全库)，随数据增长线性恶化。

**建议**：改增量事件推送，或按当前页面订阅数据切片。

### A-3 sql.js 的容量天花板 ⬜

WASM SQLite + 防抖全库导出，换来「零原生编译」的部署优势，
代价是每次持久化都要全量序列化写盘，数据规模上限低，且导出期间崩溃有丢数据风险。

**建议**：短期明确文档化容量上限与备份策略；中期评估迁移 better-sqlite3（用打包复杂度换可靠性）。

### A-4 引擎层测试 ✅（部分）

`CLAUDE.md` 明确要求「状态机变更必须有对应测试覆盖」，
而引擎状态机（`EngineStatus`）作为四层状态模型之一，连同各 Executor 与主辅路由策略均无测试。
项目自订的规则未被遵守。

已补齐：EngineManager 引擎目录与鉴权状态迁移（11 项）、HermesAgentExecutor 参数构造与
权限映射（16 项）、引擎凭据隔离（10 项）。

**仍缺**：OpenCode 委派路由（E-2 落地后补）、CliExecutor 的 Codex JSONL 解析分支。

---

## 七、后端能力迁出 Electron

当前所有重后端能力都挤在主进程，与 Electron 生命周期强耦合。
问题：主进程崩溃即全部能力中断；CPU 密集任务阻塞 UI 响应；Node 单线程限制；
且这些能力本质上与「桌面壳」无关。

建议按「是否 CPU/IO 密集」与「是否需要独立生命周期」两个维度拆分：

| 能力 | 现状 | 建议承载 | 理由 |
|---|---|---|---|
| OCR、文档解析 | 主进程 | **Python** 边车进程 | 生态成熟（PaddleOCR/RapidOCR），CPU 密集不应阻塞主进程 |
| 浏览器自动化 / Computer Use | 主进程 | **Python** 边车进程 | Playwright Python 生态完善，需独立崩溃域 |
| 知识库检索 / 向量化 | 主进程 | **Python** 边车进程 | 嵌入模型与向量库生态在 Python 侧 |
| 任务调度 / 执行器编排 | 主进程 | **Rust** 常驻服务（中期） | 需要高可靠、长时运行、独立于 UI 生命周期 |
| 数据持久层 | sql.js WASM | **Rust** + SQLite 原生 | 摆脱全量导出模型，获得真正的事务与增量写入 |
| Git HTTP 服务、MCP 服务端 | 主进程 | **Rust** 常驻服务 | 网络服务不应随窗口关闭而中断 |
| 消息渠道（飞书/企微/微信） | 主进程 | 保留或迁 Rust | 长连接需独立生命周期，优先级低于上述 |
| UI、IPC 白名单、托盘、窗口 | 主进程 | **保留 Electron** | 这是 Electron 的本职 |

**迁移原则**：
1. 进程间通过本地 gRPC 或 JSON-RPC over stdio 通信，保持 `renderer → preload → main → sidecar` 单向依赖。
2. 先做**一个**边车验证工程链路（打包、启动、崩溃恢复、日志聚合），再批量迁移。推荐首选 OCR —— 边界清晰、无状态、易回滚。
3. 边车进程的密钥获取仍须经主进程 `safeStorage` 中转，不得让边车直接读凭据文件。
4. 打包体积与跨平台分发是主要成本，需在动手前评估（Python 走 PyInstaller 或嵌入式解释器；Rust 静态编译无此问题）。

---

## 八、产品收敛建议 ⬜

现有功能覆盖：数字员工、项目管理、专家团流水线、可视化工作流引擎、多机协同、
知识库、成果验收、客户交付、经营自动化、预算管理、OCR、浏览器自动化、
Computer Use、Git HTTP 服务、MCP 服务端、Web 管理面板、四种消息渠道。

这已不是单一产品的范围。建议盘点 23 个页面的真实使用率，
对未验证的模块做降级（标记实验特性）或移除，把研发预算集中到主干路径。

---

## 九、优先级路线图

### P0 — 信任基线
1. ✅ 生产模式设为默认（H-1）
2. ✅ 关闭自动补位默认值（H-2）
3. ✅ Web 面板默认绑回环、Token 不入日志（S-1、S-2）
4. ✅ 解决 `~/.hermes/` 目录冲突与 Windows 路径错误（S-3）
5. ✅ 引擎凭据改走 `safeStorage`（S-4，含 10 项隔离测试）
6. ✅ 演示种子数据隔离或移除（H-3）

### P1 — 核心路径可信
7. ✅ 引擎清单收敛为四种（E-1，含 v26 迁移改绑下线引擎的员工）
8. ✅ 接入真实 hermes-agent CLI（`HermesAgentExecutor`：`-z` headless + `--usage-file` 会话锚点）
9. ✅ `markAuthed` 改为真实鉴权探测（H-4）
10. ✅ 引擎层测试补齐（A-4，新增 27 项）
11. ✅ OpenCode 编码委派路由落地（E-2，含 13 项测试）

### P2 — 架构健康
12. ⬜ 拆分 `ipc.ts`（A-1）
13. ⬜ 快照推送改增量（A-2）
14. ⬜ sql.js 容量上限文档化 / 评估迁移（A-3）
15. ⬜ 首个 Python 边车验证工程链路（建议 OCR）

### P3 — 产品收敛
16. ⬜ 页面使用率盘点与模块降级

---

## 附录：真实 hermes-agent CLI 接口

接入 P1-7 所需的接口事实。**核实方式**：本机已安装 hermes-agent，
以下均来自 `hermes --help` / `hermes --version` / `hermes acp --help` 实测输出，非文档推断。

核实版本：`Hermes Agent v0.19.0 (2026.7.20) · upstream 2b0fb72a`，安装方式 git。

**Headless 执行（接入的主路径）**

- `hermes -z "<prompt>"` / `--oneshot`：stdout 仅输出**最终响应纯文本**，无 banner、spinner、
  工具预览、session_id 行；**无 JSONL 事件流**。CWD 下的 AGENTS.md、memory、rules 正常加载，
  审批自动绕过。官方定位即「供脚本 / 管道使用」。
- `--usage-file <PATH>`：仅 `-z` 模式有效，运行后写出 JSON 用量报告
  （估算成本、token 计数、模型、api_calls）。**失败时也会写出**，便于成本核算。
- 无 `--cwd` 参数，工作目录须在 spawn 时通过 `cwd` 选项传入。

**会话与模型**

- `-r <SESSION>` / `--resume`：按 ID 或标题续接；`-c [NAME]` / `--continue` 续指定或最近会话。
- `--no-restore-cwd`：阻止续接时 cd 回会话记录的工作目录（我方托管 workspace 时需显式传入）。
- `-m <MODEL>` / `--model`（如 `anthropic/claude-sonnet-4.6`），亦可用 `HERMES_INFERENCE_MODEL`。
- `--provider <PROVIDER>`：单次覆写供应商；持久值在 `config.yaml` 的 `model.provider`。
- `-t <TOOLSETS>` / `--toolsets`：逗号分隔限制启用的工具集。
- `-s <SKILLS>` / `--skills`：预载 skills（可重复或逗号分隔）——
  可直接预载我方写入的 `opc-nexus` skills，无需改用户 `config.yaml`。

**权限与隔离**

- `--accept-hooks`：免 TTY 自动批准 `config.yaml` 声明的未见 shell hooks
  （等价 `HERMES_ACCEPT_HOOKS=1`）。
- `--yolo`：绕过全部危险命令审批。**接入时不应默认传入。**
- `-w` / `--worktree`：在独立 git worktree 中运行，官方用途为并行 agent —— 与我方并发派发契合。
- `--ignore-user-config`：忽略用户 `config.yaml` 回落内置默认，
  但 **`.env` 中的凭据仍会加载**（这两者是独立的，S-3 的边界划分依此成立）。
- `--safe-mode`：禁用全部定制（含 MCP servers），仅排障用。

**配置目录（实测修正）**

解析优先级 `HERMES_HOME` > Windows `%LOCALAPPDATA%\hermes` > `~/.hermes`。
本机实测 `~/.hermes/` **不存在**，真实目录为 `%LOCALAPPDATA%\hermes\`，
内含 `config.yaml`、`bin/`、`cron/`、`hooks/`、`logs/`、`memories/` 等。
这佐证了 S-3：原实现写死 `~/.hermes/` 在 Windows 上既冲突又指向了错误位置。

**其他入口**

- ACP 模式：`hermes acp`（子命令，非独立 `hermes-acp` 可执行文件），供编辑器集成，
  支持 `--check` / `--setup`。
- `hermes gateway`：消息平台桥接，非通用 HTTP API。
- 另有 `dashboard` / `serve` / `mcp` / `sessions` / `tools` 等子命令可供后续集成。

**权限语义映射建议**（对应项目 readonly / standard / trusted 三级）：

| 应用权限 | 建议参数 |
|---|---|
| `readonly` | 不传 `--accept-hooks`，用 `-t` 限制为只读工具集 |
| `standard` | 传 `--accept-hooks`，保留危险命令审批 |
| `trusted` | 传 `--accept-hooks`，并发场景加 `-w` 隔离 worktree |

`--yolo` 不映射到任何权限级别。
