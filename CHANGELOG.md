# 更新日志 (Changelog)

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。每次功能变更须在此记录,并同步更新 `package.json` 的 `version` 字段。

## [1.5.3] - 2026-07-29

### 修复

- **CLI 事件流报错后仍可能被覆盖为成功**:Codex `error` 事件(及 Claude `result.is_error`)
  只调 `onError` 而未标记中止,进程随后以 `code=0` 退出时 close 分支会再调 `onDone`,
  任务显示成功。现报错即写入 `abortedTasks`,与超时路径一致

### 新增

- **CliExecutor 测试 27 项**(核心执行路径,评审文档标记的覆盖缺口):
  权限→沙箱映射(`readonly`→`read-only` / `standard`→`workspace-write` /
  `trusted`→`danger-full-access`,渠道任务 trusted 降级、专家团提升)、
  会话续跑参数(`exec resume`)、泛化 CLI 模板覆写与 `{prompt}` 缺失兜底、
  JSONL 解析(跨 chunk 分片 / 非 JSON 容错 / 错误事件 / 无产物说明)、
  退出码与 ENOENT 提示、abort 后不回报

### 变更

- `claude-cli` 分支标注为历史兼容(四引擎收敛后已无处实例化)

## [1.5.2] - 2026-07-29

### 安全修复

- **Web 面板鉴权可被路径穿越绕过**(实测确认):免认证判定用 `req.path.startsWith('/assets/')`,
  而裸 socket 请求(`GET /assets/../api/snapshot`)的 `req.path` 不会被规范化,
  该判定返回 true 直接放行鉴权 —— 此前未泄露数据仅因路由层恰好未匹配,
  安全性建立在巧合而非设计上。现改为**先规范化再判定**(解码 + 消解 `.`/`..` + 反斜杠归一),
  并覆盖 `%2e%2e` 等编码穿越
- **Token 比较改为定长比较**(`timingSafeEqual`),消除鉴权与登录接口的时序侧信道;
  长度不等直接判否(`timingSafeEqual` 对不等长入参会抛异常)
- **CORS 不再放行任意来源**:原 `cors()` 默认 `*`,开启局域网暴露后任意网页
  都能在用户浏览器中调用管理 API。面板由本服务同源托管,无跨源需求,现设 `origin: false`
- **请求体上限 1MB**:管理接口无大 body 场景,避免单请求打满内存
- 登录失败写入审计日志(便于发现暴力破解尝试)

### 新增

- **Web 面板安全边界测试 16 项**:含用 `net.Socket` 复现绕过的端到端用例,
  以及「旧 `startsWith` 判定确实会放行」的回归锚点(证明测试有鉴别力)

## [1.5.1] - 2026-07-28

### 新增

- **`LlmApiExecutor` 测试 28 项**(此前零覆盖,却是 Nexus Agent 的核心执行路径):
  SSE 流式解析(跨 chunk 分片 / `[DONE]` / 畸形行)、工具循环与轮次上限、审批门禁
  (拒绝即终止且不执行工具)、权限语义映射、供应商就绪判定、用量落库、abort 中断
- **语音链路离线验证 33 项**:阿里云 RPC 签名(StringToSign 构造、百分号编码规则、
  `+`→`%20` / `*`→`%2A` / `~` 保留、参数字典序、密钥拼接)13 项;
  NLS 协议帧处理(中间结果 / 句末 / 错误码如实上报 / 不带 status 的帧不误判 / 非 JSON 不崩溃)
  与 StartTranscription 载荷契约 20 项

### 修复

- **内置引擎状态语义不一致**:`adapterFor()` 绕过 `engines.status` 自行判断可用性,
  与 `detect()` 维护的状态字段可能矛盾(库里 SETUP_REQUIRED 却仍派发,或反之)。
  现统一以 `engines.status` 为唯一真相来源,与 `isReady()` 判据对齐

### 变更

- 移除 `McpManager.callTool()` 死代码(全项目无调用方;真实工具调用走 `executor/tools.ts`)
- `voiceService.ts` 抽出可测纯函数 `classifyNlsFrame()` 与 `VoiceSession.startPayload()`,
  协议判定由测试直接驱动真实实现,避免测试复刻逻辑后与实现脱钩

> 说明:语音云端链路的**签名算法**已离线验证到 StringToSign 逐字节正确、编码规则完备;
> 但**端到端连通性**(真实 AccessKey → Token → WebSocket 出字)仍需填入真实凭据实测,
> CI 无法覆盖。凭据错误时的表现已有测试锁定(`TaskFailed` + `SignatureNotMatch` 如实上报)。

## [1.5.0] - 2026-07-28

### 新增

- **全双工语音任务下达**:点击顶栏麦克风即可用说话安排任务。边说边出字(流式识别),
  停顿后解析为任务草稿,**用户确认后才派发**(source='voice')
  - 双路策略:云端阿里云 NLS 实时识别(WebSocket 流式)/ 本地离线模型;
    `auto` 模式下云端凭据齐备走云端,否则回退本地,两者都不可用时如实报错
  - 音频经主进程转发而非 Renderer 直连云端 —— 云端凭据必须留在主进程(安全基线 15.1)
  - 凭据(AccessKeyId/Secret)经 safeStorage 加密,设置页只显示「是否已配置」,不回显明文
  - 指令解析以**已知员工名为锚点**切分,支持「让X做Y」「请X帮我Y」「@X Y」「X，Y」等口语句式,
    并处理语音特有形态(口头语前缀、名字被说短、缺句末标点)
  - 会话 5 分钟兜底超时 + 退出时关闭活跃会话,避免麦克风与云端连接残留
- 设置页新增语音配置卡片(通道选择 / 凭据填写 / 可用性检测)
- 语音指令解析测试 17 项

### 变更

- `TaskSource` 新增 `voice`,语音派发的任务在任务中心标注「语音」,与手动派发可区分

## [1.4.1] - 2026-07-28

### 修复

- **P0 数据库损坏导致应用无法启动**(真机测试发现):`flush()` 用 `writeFileSync` 就地覆盖 live 数据库,
  进程在写入中途被终止即留下截断/全零文件;而启动路径无任何容错,sql.js 抛
  `file is not a database` 后整个应用打不开且用户无自救手段(实测本机 aibox.db 已成 41MB 全零文件)。
  现改为**原子落盘**(临时文件 + fsync + rename)并拒绝空导出覆盖既有库;
  启动时校验 SQLite 魔数 + `PRAGMA quick_check`,损坏文件留存为 `.corrupt-<时间戳>` 后以空库启动
- 新增 schema 迁移链路测试(真实 sql.js 跑 v25→v28,9 项)与数据库损坏容错测试(9 项)

## [1.4.0] - 2026-07-28

### 新增

- **编码专家委派**(E-2):主引擎(Hermes/Nexus)遇到改代码、跑测试、分析仓库类工作时,
  可经 `delegate_coding_task` 工具交给 OpenCode 执行。子任务仍归属原员工(审批与审计链路不变),
  仅执行引擎不同;OpenCode 未就绪时该工具不注册给模型,避免必然失败的调用
- **任务级引擎覆盖** `tasks.engine_override`(schema v28):承载编码委派与引擎路由
- **演示数据可查可清**:设置页展示库中演示数据残留量,支持一键清空(只删 `is_demo = 1` 行)
- **编码委派与引擎路由测试** 13 项

### 修复

- **P0 演示种子数据混入生产库**(H-3):12 名虚构员工、23 条「今日完成」任务与真实数据同表且无标记,
  统计口径无法区分真伪。现默认不再写入种子数据(需 `seedDemoData` 显式开启);
  schema v27 增加 `is_demo` 列并按 `project-demo-*` 特征回填历史库;
  首页统计(活跃任务/待办/今日完成)一律排除演示行
- **引擎路由规则形同虚设**:`engine_routing` 此前只存不读,用户配置后无任何效果。
  现按任务来源真实路由,且仅当目标引擎 HEALTHY 时生效;UI 下拉同步只列 HEALTHY 引擎
- 设置页「演示自动派单」开关默认值与主进程不一致(前端默认开、后端默认关),现统一为关

## [1.3.0] - 2026-07-28

### 新增

- **真实 Hermes Agent 执行器** `HermesAgentExecutor`:接入 NousResearch/hermes-agent CLI 的
  headless 模式(`hermes -z`),经 `--usage-file` 捕获 session_id 实现会话续接(`-r` + `--no-restore-cwd`),
  按退出码语义(0/1/2/130)如实分流结果,token 用量落 usage_records
- **引擎鉴权真实探测**:内置引擎校验供应商配置,CLI 引擎跑一次最小 headless 请求验证凭据;
  鉴权类错误标 AUTH_REQUIRED,探测超时标 DEGRADED,不再点一下就标记 HEALTHY
- **引擎层测试**(此前零覆盖,补齐 CLAUDE.md 要求的状态机测试):EngineManager 引擎目录与
  鉴权状态迁移 11 项、HermesAgentExecutor 参数构造与权限映射 16 项

### 变更

- **引擎清单收敛为四种**:Nexus Agent(内置自研 Runtime)/ Hermes Agent(默认主引擎,真实 CLI)/
  OpenCode(编码专家)/ Codex CLI(备选编码引擎);下线 Claude Code / ZCode / Kimi Code
- **schema v26 迁移**:绑定已下线引擎的员工自动改绑内置 Nexus,避免 engine_id 指向不存在的引擎
- Hermes CLI 权限映射:`trusted`/`autonomous` → `--accept-hooks`;`readonly` → `-t` 限制工具集;
  渠道任务 `trusted` 降级为 `standard`;任何情况下都不传 `--yolo`
- 引擎中心「登录授权」按钮改为「验证登录」,如实回报探测结果
- 引擎状态 `SETUP_REQUIRED` 文案去掉「演示模式」(生产模式已是默认)

## [1.2.0] - 2026-07-28

### 新增

- **架构与产品诊断报告** `src/docs/architecture-review.md`:记录诚实性缺陷、安全问题、引擎体系设计、
  架构缺陷与后端迁出 Electron 的演进路径,附录含实测核实的 hermes-agent CLI 接口(v0.19.0)
- **引擎凭据隔离模块** `engineEnv.ts`:统一的敏感环境变量拆分/解密逻辑(含 10 项单元测试)

### 修复

- **P0 生产模式未默认生效**:`executionMode` 默认值为 `demo`,导致引擎不可用时仍生成虚构产物并标记
  任务完成;现默认 `production`,演示模式需显式开启
- **P0 自动补位造假任务**:`demoAutoTasks` 默认开启且水位 8,系统会自动创建用户从未派发的任务并计入
  统计;现默认关闭、水位 0
- **P0 引擎环境变量明文存储凭据**:自定义 env 整体明文写入 `engines.config_json` 并进入引擎日志,
  违反密钥必须走 safeStorage 的安全基线;现敏感键(KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL/AUTH)
  加密存 `secret:engine:<id>:env`,`config_json` 仅留 `***` 占位符,spawn 时还原且仅存活于子进程
- **P0 Web 管理面板默认暴露局域网**:默认监听 `0.0.0.0` 且访问 Token 打印到 console;现默认绑
  `127.0.0.1`,需显式开启 `webExposeLan` 才暴露,Token 不再写入日志
- **P0 Hermes 配置目录冲突**:同步逻辑写死 `~/.hermes/` 并以覆盖方式导出,会破坏真实 hermes-agent 的
  `config.yaml`/`.env`/`skills/`;现划定归属边界(仅写 `mcp_servers.json` 与 `skills/opc-nexus/`),
  并按 `HERMES_HOME` > Windows `%LOCALAPPDATA%\hermes` > `~/.hermes` 解析真实目录
- **看门狗误杀恢复任务**:暂停与审批等待期被计入运行时长,长时间等待后恢复即被中断;现恢复时重置
  `started_at`,按本段运行时长计时

## [1.1.0] - 2026-07-28

### 新增

- **企微机器人渠道增强**:对话指令 `/状态` `/取消` `/取消 全部` `/暂停` `/继续` `/帮助`,聊天侧可直接干预失控任务(企微/个微/飞书三渠道统一支持)
- **长任务看门狗**:任务运行超过 `task.maxRunMinutes`(默认 30 分钟)自动强制中断,防止长任务卡死与模型死循环空耗
- **企微群机器人 webhook 通知**:任务完成结果自动推送到指定群(仅 COMPLETED;官方频控下队列节流)
- **用户配置文件 `user/config.yaml`**:程序运行目录下自动生成,支持企微凭据(启动导入系统密钥库)、webhook 地址、辅助引擎、执行模式、看门狗参数
- **主辅引擎策略**:主引擎不可用时自动回退辅助引擎(默认 OpenCode);`production` 模式下无可用引擎任务直接失败,绝不伪装演示产物
- **真实 Hermes Agent CLI 引擎**:新增 `eng-hermes-cli` 引擎条目(可执行名/运行参数可经配置文件覆写)
- **Skills 组合成数字员工**:技能页多选技能一键生成员工,技能正文注入人设,内置任务拆分规划约定,走真实执行链路

### 修复

- **P0 供应商数据源统一**:设置页(providers 表)与引擎健康检查(旧 settings)数据源不一致,导致配好供应商后引擎仍显示 SETUP_REQUIRED、任务落入演示模式;现统一以 providers 表为唯一数据源,启动时自动迁移旧配置

### 变更

- 内置引擎 `Hermes Runtime` 更名为 **Nexus Agent**(自研 Runtime,与真实 Hermes Agent CLI 区分)

## [1.0.0] - 2026-07-25

### 新增

- 首个正式版:数字员工管理、任务编排、多引擎接入(Codex/Claude Code/ZCode/OpenCode/Kimi)、
  消息渠道(企微长连接/飞书/个微桥接)、可视化工作流、专家团协作、MCP & 技能系统、
  多供应商模型路由、多机协同、系统监控、局域网 Web 管理后台、OpenAI 兼容 API 代理
