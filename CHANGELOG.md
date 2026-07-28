# 更新日志 (Changelog)

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。每次功能变更须在此记录,并同步更新 `package.json` 的 `version` 字段。

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
