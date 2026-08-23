# ADR-DSH-001: DeepSeek Harness 双运行时与控制边界

- 状态：Accepted
- 日期：2026-08-16
- 上游版本：`@deepseek-ai/dsh@0.1.0-rc.6`

> 角色归属说明：本文关于“谁负责规划/派工”的早期边界已由
> [ADR-DSH-003](./ADR-DSH-003-DSH-AS-OWNER.md) supersede。当前 v2 由 DSH/Cordis
> 持有核心 AI、Quest、计划和 Session owner；Nexus/AiBox 保留治理、TaskStatus 投影、
> 凭据、权限、审计和适配器职责。本文的 runtime、租约和协议约束继续有效。

## 背景

OPC-Nexus 已包含一个裁剪后的 DeepSeek Harness ACP sidecar。它适合一次性文本任务，
但不提供官方 Web UI、持久 Session、Jobs、Goals 或完整多 Agent 工作台。产品同时需要
保留现有任务稳定性，并支持可由人或 Nexus/Hermes 控制的完整 DSH 工作台。

## 决策

1. 保留 `runtime/deepseek-harness` 作为 `ACP_COMPAT` 回退路径。
2. 新增 `runtime/deepseek-harness-managed`，精确锁定 npm 版本、tarball integrity、
   依赖闭包和许可证；升级必须重新通过合同与打包测试。
3. managed DSH 只监听 loopback。桌面通过无 Nexus preload 的 sandboxed
   `BrowserWindow` 访问本地网关；LAN 只能经过 Nexus TLS/Auth 网关。
4. Nexus/Orchestrator 是员工目录、治理策略、Task 状态、审批、密钥、审计和最终制品
   admission 的唯一权威；DSH/Cordis 是核心 AI、计划、原生 Session 日志、Jobs、Goals、
   子 Agent 树和工具执行细节的唯一权威。
5. Phase 1 可以代理官方 Web HTTP/WebSocket transport，但不得把它当作稳定控制合同。
6. 自动派单、恢复和状态同步只允许通过版本化 `opc-dsh-gateway` 合同完成。该插件封装
   Session、Run、Event、Question、Job、Goal、Subagent、Artifact 与命令 receipt；禁止
   抓取 DSH DOM、读取其私有数据库或让 Renderer 直连内部 Remote。
7. ACP 只承担标准化单会话兼容控制；A2A 只承担部门负责人/远程团队边界；MCP 只承担
   受控工具与资源。当前 DSH 没有原生 A2A，A2A Adapter 由 Nexus 提供。
8. 人类、Nexus 与团队负责人向同一 Session 写入前必须持有带 revision 的单写者租约。
9. 在 ProviderCredentialProxy 和 Shell 隔离测试通过前，managed profile 不接收真实长期
   Provider Key，也不开放无人值守 Shell/Jobs。

## ID 与事件映射

```text
Nexus Conversation 1 -> 1 DSH root Session
Nexus Task         1 -> 0..n DSH Run
Plan DAG Node      1 -> 1 Nexus Task -> 0..1 DSH Run or A2A Task
DSH child Session  n -> 1 root Session (不自动创建持久 Agent)
```

事件先以 `(session_id, seq)` 幂等落库，再投影到 UI。DSH 只能请求状态变化，所有
`TaskStatus` 转换仍由 Orchestrator 执行。未知事件保存原始 payload 和协议版本。

## 版本与回退

- `dshManagedRuntime` 默认只开放 loopback Workbench。
- Gateway capability/version 不匹配时禁止创建新的 managed Run，现有 Session 只读导出。
- managed 启动、合同或安全门禁失败时回退 `ACP_COMPAT` 或本地 CLI，不自动调用未审计的
  DSH Web 内部 API。
- schema 只做增量迁移；关闭 managed feature 不删除历史映射、事件或制品。

## 后果

该方案增加一个常驻运行时、隔离窗口和适配层，安装体积与测试面都会扩大；换来的好处是
官方 DSH 体验可独立升级，Nexus 权限域不会暴露给 DSH Renderer，并且上游 RC 破坏性变化
被固定版本、能力 fixture 和 Gateway 合同吸收。
