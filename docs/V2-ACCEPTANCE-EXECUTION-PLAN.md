# OPC-Nexus v2.0.0 修复实施计划(整合版)

> 更新日期:2026-08-18
> 输入依据:[功能与 UX 审计](./FUNCTIONAL-UX-AUDIT-2026-08-18.md)、[DSH/Cordis 实施计划](./V2.0.0-DSH-CORDIS-PROJECT-QUEST-IMPLEMENTATION-PLAN.md)、老板产品口径(自主执行 / 项目产物浏览 / 保留办公室)
> 当前基线:`typecheck` 通过;144 测试文件 / **1540 passed + 2 skipped**;`npm run build` 通过
> 核心判断:**规划主链已解除阻断,交付闭环仍未建立。** 三项新功能已落地且经复核;真实用户验收的关键缺口从「链路不可达」转移到「完成没有证据」。

## 0. 本轮 Codex 修复复核结果

我逐项读代码复核,不采信描述。结论:**三项全部成立**,其中两项超出预期,一项存在需补齐的边角。

| 项目 | 结论 | 复核依据 |
|---|---|---|
| 数字员工默认完全自主 | **成立,设计正确** | `DEFAULT_AGENT_PERMISSION_MODE = 'autonomous'`([types.ts:50](../src/shared/types.ts#L50));schema 默认 `autonomous`([database.ts:64](../src/main/services/database.ts#L64));v44 迁移把历史 `standard` 转为 `autonomous` 且**保留**用户显式选择的 `readonly`([database.ts:2717-2724](../src/main/services/database.ts#L2717)) |
| 项目目录内限制 | **成立,双重校验** | `resolveInWorkspace` 同时拒绝词法越界与符号链接逃逸(`realpathSync.native` 比对)([tools.ts:167-175](../src/main/services/executor/tools.ts#L167));全部文件工具经它解析;项目目录经 `projectWorkspaceResolver` 下发,`orchestrator`([orchestrator.ts:149-170](../src/main/services/orchestrator.ts#L149))与 `teamEngine`([teamEngine.ts:111](../src/main/services/teamEngine.ts#L111))各自持有,专家团同样受约束 |
| 项目产物目录 + 内嵌预览 | **成立,是真实文件系统** | `projectArtifactService.ts` 走 `readdirSync`/`lstatSync`/`realpathSync`/`readFileSync`,不读数据库;独立 `aibox-project:` 特权协议 + 15 分钟 grant token;`ProjectArtifactsPanel.tsx` 挂载在 Quest 工作台工具栏,可由真实用户点开 |
| 办公室模块 | **成立,未被破坏** | 组件、`RouteKey`、懒加载、侧栏项、路由 case 五处齐全([App.tsx:63](../src/renderer/src/App.tsx#L63)、[App.tsx:152](../src/renderer/src/App.tsx#L152)) |
| P0-01 / P0-02 规划阻断 | **成立,已修复且有测试** | 三处长度校验改为显式 `(value, field, 0, N)`;新增专用 `assertPlanningProposalInput`([ipc.ts:388-395](../src/main/ipc.ts#L388));回归测试覆盖空文本、4000 字边界、4001 超限([ipcSecurityBoundary.test.ts:721-740](../tests/ipcSecurityBoundary.test.ts#L721)) |

### 0.1 审批模型:正是你要的语义

`autonomous` 下审批判定翻转为白名单例外制([llmApiExecutor.ts:339-343](../src/main/services/executor/llmApiExecutor.ts#L339)):

```ts
const needApproval = effectiveMode === 'autonomous'
  ? autonomousApproval !== null              // 只有显式标注例外的工具才拦
  : tool.risk !== 'safe' && (...)            // 旧模式:按 risk 逐步拦
```

项目目录内的读、写、建目录、删除文件**都没有** `autonomousApproval` 标注,因此全程无审批。仅四类保留确认:

| 例外类型 | 覆盖工具 |
|---|---|
| `outside_workspace` | shell 执行、桌面控制、越界文件操作([tools.ts:414,507,726,767,798,833](../src/main/services/executor/tools.ts#L414)) |
| `network` | 非 GET 的 `http_request`、外发类工具([tools.ts:375,586,604,645](../src/main/services/executor/tools.ts#L375)) |
| `install` | `install_package`([tools.ts:453](../src/main/services/executor/tools.ts#L453)) |
| `admin` | `danger` 级 MCP 工具、`delegate_task`([mcpTools.ts:38](../src/main/services/executor/mcpTools.ts#L38)) |

这与你的要求一致:**人类只做最终验收,中间步骤不打扰;不可逆和外发动作仍需一次确认。**

### 0.2 复核中发现的新问题(需修)

| # | 问题 | 位置 | 判断 |
|---|---|---|---|
| N-1 | 两套 CSP 不一致:主进程协议响应放行 `script-src aibox-project: 'unsafe-inline'`,渲染进程注入的是 `script-src 'none'` | [projectArtifactService.ts:276](../src/main/services/projectArtifactService.ts#L276) vs [ProjectArtifactsPanel.tsx:45](../src/renderer/src/pages/ProjectArtifactsPanel.tsx#L45) | **当前不可利用**(DOMParser 不执行脚本、CSP meta、iframe `sandbox` 未给 `allow-scripts`,三层独立防护);但整个设计依赖 CSP,主进程这一行应收紧为 `'none'`,避免后续任何直接经协议加载 HTML 的改动打开缺口 |
| N-2 | 文件类型判定纯靠扩展名,无 magic byte、无内容 hash | [projectArtifactService.ts:123-137](../src/main/services/projectArtifactService.ts#L123) | 弱于同仓已有的 `artifactRef.ts`(SHA-256 + magic byte 校验)。预览侧靠 `nosniff` + 严格 CSP 兜住,但产物**交付**必须补 hash |
| N-3 | `readFileSync` 同步读最大 128 MB,在主进程线程内 | [projectArtifactService.ts:267](../src/main/services/projectArtifactService.ts#L267) | 大文件预览会卡住主进程(UI 冻结)。应改流式响应或下调阈值 |
| N-4 | 服务已算出 `modifiedAt`,UI 未展示;无 hash 列 | [ProjectArtifactsPanel.tsx:210-212](../src/renderer/src/pages/ProjectArtifactsPanel.tsx#L210) | 产物可信度缺少时间与指纹线索 |
| N-5 | 与 `artifactRef.ts`、`deliverableManager.ts` 形成**第三套**产物体系,三者互不相通 | — | 见 2.1,这是交付闭环的主要结构债 |

## 1. 已确认的产品语义(作为约束,不再讨论)

后续所有实施都必须服从这四条,不得在实现中悄悄回退:

1. **默认完全自主。** 新建、内置、市场员工与专家团一律 `autonomous`。项目目录内的文件读写删除、子 Agent 委派、长任务续跑**不产生步骤审批**。
2. **目录即边界。** 每个员工/专家团只能在其绑定的项目目录内动作,词法与 `realpath` 双重校验。越界不是弹审批,是先拒绝再由老板显式授权。
3. **人类只做最终验收。** 中间过程不打扰。仅 `outside_workspace` / `network` / `install` / `admin` 四类保留一次确认。
4. **办公室模块保留。** 它提供可视化与情绪价值,不承担业务逻辑。审计报告建议删除的意见**不采纳**。

> 这四条已推翻审计报告 P2-02 中「删除办公室」与隐含的「增加逐步确认」两项建议。

## 2. 剩余缺口(按对真实用户验收的阻断程度排序)

### 2.1 交付没有证据 —— 唯一实质阻断(原 P0-04)

现在有**三套**互不相通的产物体系,这是最大的结构问题:

| 体系 | 输入 | 产出 | 现状 |
|---|---|---|---|
| `deliverableManager.ts` | `task.result` **字符串** | `README.md` + `manifest.json` + 若干 `.md` | 驱动成果页与导出([ipc.ts:1120-1139](../src/main/ipc.ts#L1120));**从不访问文件系统** |
| `artifactRef.ts` | 内容寻址存储 | SHA-256 + magic byte + 大小校验 + grant | **已完整实现,但从未接入交付链路** |
| `projectArtifactService.ts` | 项目目录实时文件 | 目录浏览 + 内嵌预览 | 本轮新增,只读浏览,不产出 manifest |

结论:**不是从零建设,是把已有三块接上。** 新的产物浏览器证明了文件系统侧可行,`artifactRef.ts` 证明了校验侧可行,缺的是把两者合成一份 Manifest 并让任务完成前必须过验收。

具体缺失(与审计一致,已复核):不收集工作区真实文件;不校验声明路径是否存在;不记录大小/类型/SHA-256/来源任务/版本;不实际运行启动命令查退出码;不打开预览验证页面非空;不生成验收截图;不区分「说明文档」与「真正交付文件」。

### 2.2 假就绪 —— 阻断「新装只显示真实状态」(原 P1-02)

**未修复,且根因比审计描述更硬:** `resourceMonitor.setServiceHealth()` 在**全仓库零调用点**,`health.runtime` 结构上永远停在 `'healthy'`。

- [store.ts:62](../src/renderer/src/store.ts#L62) 初始状态硬编码三项 healthy
- [resourceMonitor.ts:115](../src/main/services/resourceMonitor.ts#L115) 构造即 healthy,唯一 setter 无人调用
- [Dashboard.tsx:193-197](../src/renderer/src/pages/Dashboard.tsx#L193) 直接把它渲染成「模型服务状态:全部正常」
- 真实派发闸门在另一处:`lifecycle === 'READY' && engine.status === 'HEALTHY'`([channelControlPlane.ts:222-231](../src/main/services/channelControlPlane.ts#L222))

两套「就绪」信号结构上完全没有连线,因此可以同屏出现「全部正常」与「无可用引擎」。

### 2.3 失败留下孤立记录 —— 阻断验收标准 6(原 P1-03)

`ingest()` 自带事务并**先提交**带 `task_id = NULL` 的入站消息([desktopIngressService.ts:68,140-155](../src/main/services/desktopIngressService.ts#L68)),之后 `dispatchCanonical` 才抛「没有已就绪且引擎健康的执行员工」([channelControlPlane.ts:175](../src/main/services/channelControlPlane.ts#L175))。消息行已落库且无任何回填路径。渠道侧 [common.ts:430](../src/main/services/channels/common.ts#L430) 同一顺序问题。

同时原始 IPC 错误文本直接进 Toast,弹窗不关闭,没有「现在配置引擎」动作。

### 2.4 多机协同入口即失败(原 P1-06)

`collab:checkGit` 为查 Git 调了整个 `checkRuntime()`([ipc.ts:2648](../src/main/ipc.ts#L2648)),该方法串行探测 Node/npm/Python/Git 且**全程无 try/catch**([engineManager.ts:1116-1139](../src/main/services/engineManager.ts#L1116))。`locateBin` 在 Windows 上会定位到 `npm.cmd`,`execFile(shell:false)` 抛 `EINVAL`,在轮到 Git 之前就让整个调用 reject。项目自己的 [cliLauncher.ts:1-22](../src/main/services/cliLauncher.ts#L1) 早已注明这个限制并提供了安全的 `runCli`,但这里没用。

### 2.5 校验器盲区 —— 会让 P0 类缺陷重现

`assertKeys` 只拒绝**未知**字段,不检查**缺失**字段([ipc.ts:181-184](../src/main/ipc.ts#L181))。P0-02 正是校验器与载荷形状不匹配,而 TypeScript 与该断言都覆盖不到。已修的两个 P0 是症状,这是病灶。

> Codex 已用 AST 遍历 `src/main/**/*.ts`,枚举全部 50 个校验助手与 14 个 `*Input` 断言函数,确认**当前无同类遗漏**。但机制不变,新字段仍会复发。

### 2.6 演示路径代码留存(原 P0-03,已降级)

四条演示路径**默认全部关闭**且需显式改配置才可达(`executionMode: production`、`demoAutoTasks: false`、`seedDemoData: false`)。真实风险是代码留存而非默认可达,优先级低于以上各项。

### 2.7 文档漂移(原 P2-05)

`README.md:23` 仍标 `1.8.1`(实际 `2.0.0`);`README.md:66,220`、`docs/USER-GUIDE.md:53`、`src/docs/README.md:85`、`src/docs/features.md:137` 仍把「模拟执行」当可选执行器宣传。

## 3. 实施阶段

顺序原则:先补住会让已修缺陷复发的机制,再建交付闭环,最后清理。每阶段结束跑 `typecheck` → `test` →(涉构建)`build`,并按仓库约定单独提交。

### 阶段 A:巩固本轮成果(小、可立即做完)

前置条件已满足,这阶段只是把本轮三项功能的边角补齐。

| # | 工作项 | 状态 | 完成依据 |
|---|---|---|---|
| A.1 | 主进程协议 CSP 的 `script-src` 收紧为 `'none'`(N-1) | **已完成** | [projectArtifactService.ts:276](../src/main/services/projectArtifactService.ts#L276) 与渲染侧 [ProjectArtifactsPanel.tsx:45](../src/renderer/src/pages/ProjectArtifactsPanel.tsx#L45) 的 `script-src` 均为 `'none'`;测试断言协议响应头不含 `unsafe-inline`。两者 `base-uri` **有意不同**:渲染侧注入 `<base href>` 让相对资源经 grant URL 解析,故允许 `aibox-project:`;主进程响应不注入 base,保持 `'none'` |
| A.2 | 预览大文件改流式(N-3) | **已完成** | `resolveAuthorizedUrl` 返回已校验的 fd,协议处理器经 `Readable.toWeb` 流式响应;主进程不再同步读满 128 MB |
| A.3 | 产物列表展示 `modifiedAt` + SHA-256(N-2/N-4) | **已完成** | 服务侧流式 `fingerprint()`;UI 条目显示修改时间([ProjectArtifactsPanel.tsx:217](../src/renderer/src/pages/ProjectArtifactsPanel.tsx#L217))与指纹([:230](../src/renderer/src/pages/ProjectArtifactsPanel.tsx#L230)) |
| A.4 | `assertKeys` 增加必需字段校验(2.5) | **已完成(经 Codex 独立复核)** | 助手支持 `required` 并对"必需字段不在允许列表"自检([ipc.ts:185-198](../src/main/ipc.ts#L185));P0-02 所在的规划链路两处已启用([:377](../src/main/ipc.ts#L377)、[:405](../src/main/ipc.ts#L405));其余 19 处经逐点判定确认为冗余,不改 |

**A.4 已收口,结论与最初预期不同,值得记录。**

我最初判断"24 个调用点仅 4 处启用,剩余 20 处需补"。逐点核验后修正为:**23 个调用点**(原计数把 [ipc.ts:185](../src/main/ipc.ts#L185) 的函数定义算成了调用),其中 4 处启用、19 处未启用。Codex 用 AST 独立复核全部 19 处,结论与我的抽样一致:**无一处需要补**。

原因是这套校验器有一条隐含惯例 —— 每个必需字段声明后立即交给会对 `undefined` 抛错的断言(`assertString` / `assertId` / `positiveInteger` / `parseAttachmentRef` 等),因此缺失字段在断言处就已拦住;真正被条件读取的字段,在共享类型里本就是可选的。**无差别添加 `required` 只会制造噪音,不增加保护。**

因此 A.4 的实质价值不在"提高采纳率",而在两点:

1. **机制到位**,下一个走条件读取的新字段有现成手段可用;
2. **不变量被测试锁定** —— 这是防止 P0-02 复发的真正屏障,因为惯例本身不会自我执行。

核验中另有一项发现:DSH Quest 链路的必需字段**不走** `assertKeys` 的 `required`,而是由 [parseDshQuestIdentity](../src/main/ipc.ts#L446) 自带的 `hasOwnProperty` 循环拦住,报错文本为 `missing <key>` 而非 `缺少必需字段`。两套机制并存、文案不一致,属于可接受的一致性债,但测试必须同时覆盖 —— 否则重构其中一套时另一套会静默失去保护。新增测试已覆盖两者([ipcSecurityBoundary.test.ts:756](../tests/ipcSecurityBoundary.test.ts#L756) 起),并顺带锁定了一个易错点:`dispatchDshQuestPlan` 是 `async`,同样的校验失败以 **rejection** 而非同步抛出呈现。

### A.2 的附带发现:描述符所有权

改流式后出现一个原实现不存在的风险类别:fd 泄漏与重复关闭。已处理两处:

- `openVerified()` 在 `fstat`/身份校验/超限任一失败时关闭 fd 再抛出,不泄漏。
- 协议处理器在 `createReadStream` 成功后立即清空 `unowned` 标记,避免 `catch` 与 `autoClose` 重复关闭同一 fd —— 重复关闭可能命中 Node 已复用该编号的无关文件。

同时 fd 化带来一项安全增益:响应从**已校验的 inode** 读取而非按路径重开,校验后被换成符号链接无法改变响应内容;`content-length` 也改由 `fstat` 得出,与实际发送字节一致。

### 阶段 B:真实交付闭环(工作量最大,是验收核心)

目标:让「完成」有证据。**向 `artifactRef.ts` 收敛,不扩展 `deliverableManager.ts` 的文本包装路径。**

| # | 工作项 | 完成定义 |
|---|---|---|
| B.1 | 定义结构化 Artifact Manifest:相对路径、类型、大小、SHA-256、来源任务、版本、验收结果、启动方式 | 字段齐全且被测试断言 |
| B.2 | 交付收集改为遍历任务工作区真实文件 | 源码/表格/图片/PDF/可执行文件均可进入成果;复用 `projectArtifactService` 的遍历与 `resolveInWorkspace` 的边界校验,不新写路径逻辑 |
| B.3 | 产物校验:存在性 + 授权目录内 + `realpath` 防逃逸 + magic byte | 越界与类型不符的路径被拒绝并审计 |
| B.4 | 验收执行:运行启动命令查退出码、打开预览验证页面非空、生成验收截图 | **未通过验收的任务不得进入 `COMPLETED`** |
| B.5 | 成果页四个动作:打开交付目录 / 运行预览 / 查看截图 / 复制启动命令 | 四者均对真实文件生效;预览直接复用本轮的产物面板,不做第二套 |
| B.6 | 渠道附件改为消费同一 Manifest,移除 `wecomChannel.ts` 的正则猜路径 | 附件来源唯一;上传失败有可追踪回执 |
| B.7 | `deliverableManager.ts` 降级为兼容投影,不再作为交付权威 | 三套产物体系收敛为一套权威 + 一层兼容 |

### 阶段 C:真实状态与失败路径

| # | 工作项 | 完成定义 |
|---|---|---|
| C.1 | 拆分五类状态:设备在线 / 基础服务 / 模型连接 / Agent 生命周期 / 执行可用性 | 空白安装不再同屏出现「全部正常」与「无可用引擎」 |
| C.2 | 把真实引擎与生命周期信号接入 `setServiceHealth`,或直接移除该死字段改由派生计算 | `health.runtime` 能随真实引擎状态变化;补测试锁定 |
| C.3 | `store.ts` 默认不再假定 runtime 健康且在线 | 首屏无假就绪 |
| C.4 | 启动引入 `BOOTSTRAPPING`,探测与 Cordis 投影完成后再发首个 authoritative snapshot | 不再先显示 0 员工再跳成 1 |
| C.5 | 未完成最小真实任务验证前,Cordis 显示「待配置」而非「就绪」 | 生命周期与执行可用性不再冲突 |
| C.6 | readiness preflight 前置到写库之前;失败不写消息/任务副作用 | 失败派发后 `tasks` 与 `messages` 均无孤立记录;桌面与渠道两条路径同时修 |
| C.7 | 派发失败返回结构化错误 + 恢复动作 | 文案为「尚未连接可执行模型」并提供「打开连接设置」,不暴露原始 IPC 文本 |
| C.8 | `collab:checkGit` 只探测 Git,统一走 `runCli`;单项失败不中止其他探测 | Windows 上不再 `spawn EINVAL` |

### 阶段 D:清理与加固

| # | 工作项 | 完成定义 |
|---|---|---|
| D.1 | 移除 `simulatedExecutor.ts`、`executionMode: demo`、`demoAutoTasks`、`seedDemoData`、QQ 演示渠道 | 生产源码与 bundle 中均不存在 |
| D.2 | 构建静态门禁:bundle 中不得出现 `simulatedExecutor` / `演示模式产物` / `demoAutoTasks` / `seedDemoData` | 门禁进入流水线并可失败构建(注意 `.cnb.yml` 当前只跑 typecheck + test,需先扩流水线) |
| D.3 | 一次性迁移清理历史 `is_demo=1` 数据,之后移除产品入口 | 老数据不残留虚构记录 |
| D.4 | 未就绪引擎不可选、不显示「演示模式」;本地语音未实现前不可选 `local` | 入口在能力真实可用后才出现 |
| D.5 | 修正文档漂移:README 版本号与「模拟执行」宣传、USER-GUIDE、`src/docs/` | 指定一份用户手册为权威,旧架构文档归档 |
| D.6 | 崩溃恢复:等待审批的内存 waiter、瞬时状态、副作用幂等 | 故障注入 E2E 通过 |

### 阶段 E:导航收敛(**不排期,需你确认**)

审计建议把 22 个一级入口收敛为 6 个。我不会未经确认就执行,理由有二:

1. 它改变用户心智模型与既有习惯;
2. 你已明确要求保留办公室,说明审计的收敛清单与你的产品意图存在分歧,不能整体照搬。

建议顺序:先完成 A-C 让主链真实可用,再依据真实使用情况收敛导航。

## 4. 与 12 项发布验收标准的映射

| 验收标准 | 对应阶段 | 当前状态 |
|---|---|---|
| 1. 新装只显示真实状态 | C.1-C.5 | **未开始**(2.2 根因已定位) |
| 2. 无模拟执行/虚构任务/假完成 | D.1-D.3 | 默认已关闭,代码待移除 |
| 3. 简单润色任务经真实引擎完成 | C.6-C.7 | 待做 |
| 4. 官网场景批准后创建有依赖的真实任务 | — | **已解除阻断**(P0-01/02 已修,有回归测试) |
| 5. 不可逆节点进入 `WAITING_APPROVAL` | B.4 + D.6 | 部分:四类例外已生效,策略 broker 未覆盖全动作 |
| 6. 失败 preflight 不写孤立记录 | C.6 | **未开始** |
| 7. 暂停/继续/取消在桌面与渠道一致 | B.6 | 部分 |
| 8. 成果可打开、命令返回 0、预览可访问、截图非空 | B.2-B.5 | 部分:**预览已可用**(本轮新增),运行与截图未做 |
| 9. Manifest 字段齐全 | B.1 | 未开始 |
| 10. 渠道收到结构化摘要与真实附件 | B.6 | 未开始 |
| 11. 真实引擎跑通一简一复杂场景 | A-C 全部 | 待做 |
| 12. typecheck + unit + IPC contract + E2E + build 全通过 | A.4 + D.6 | IPC contract 部分补齐,Electron E2E 缺失 |

## 5. 关键风险

- **交付闭环是接线而非重写。** 三套产物体系已各自可用,风险在于再加第四套。B 阶段任何新代码都应先问:`artifactRef.ts` 或 `projectArtifactService.ts` 是否已有该能力。
- **`autonomous` 的安全性完全依赖 `resolveInWorkspace`,已逐项核验通过。** 我审计了 `executor/` 下全部 `fs` 调用点:所有由模型参数决定的路径都经该函数解析(`read_file`/`list_dir`/`write_file`/`make_dir`/`delete` 及 `computer_screenshot` 的截图目录),其余 `mkdirSync` 只创建宿主下发的 workspace 本身,不接受模型输入。**当前无绕过。** 另经 AST 枚举确认:`risk` 为 `write`/`danger` 且**缺少** `autonomousApproval` 标注的工具数为 **0** —— 自主模式下没有"既危险又不拦"的工具。新增文件类工具必须经 `resolveInWorkspace`,不得直接调 `fs`;建议加测试锁定这两条不变量(全部 fs 路径经解析、非 safe 工具必有标注)。
- **能力开关是真实闸门,且同时约束暴露与执行。** `toolsForPermission`([tools.ts:878-887](../src/main/services/executor/tools.ts#L878))过滤未授权能力的工具,`llmApiExecutor` 的执行查找走的是**同一份过滤后列表**([llmApiExecutor.ts:306](../src/main/services/executor/llmApiExecutor.ts#L306)),因此模型即使凭空写出工具名也查不到、执行不了。`readonly` 模式另外只保留 `safe`。
- **一处例外:`computer_screenshot` 逃出了"目录即边界"。** 它 `risk: 'safe'` 且无审批标注,自主模式下静默执行,但截取的是**整个桌面**(可能含其他应用的敏感内容),不受项目目录约束。当前仅由 `computer` 能力开关兜住(未授权则工具不存在),截图落盘路径与 PowerShell 脚本均无模型可控字符串,不存在注入。设计上可接受,但**既然审批已默认关闭,能力开关就是它唯一的闸门** —— 授予 `computer` 能力时应视同授予桌面可视范围内的读取权,建议在 UI 授权文案中说明。
- **CSP 是产物预览的唯一防线。** 产物由 AI 写入,可能被提示注入污染。当前三层防护有效,但 A.1 的不一致必须消除,否则后续改动容易踩空。
- **`assertKeys` 的盲区是系统性的。** 它只拦未知字段,所有「校验器复用」都可能重演 P0-02。这是 A.4 优先于功能开发的原因。
- **Playwright 未声明依赖。** E2E 脚本 `require('playwright')`,但它只是 `@playwright/mcp` 的传递依赖。写标准 12 的 E2E 前必须先锁版本。
- **`.cnb.yml` 只跑 typecheck + test。** 构建、打包与 smoke 都不在 CI 内,D.2 的静态门禁需先确定落在哪条流水线。

## 6. 建议起点

**阶段 A 全部四项作为第一个提交。** 改动小、可立即验证,且 A.4 直接防止已修 P0 复发。A.1/A.3 复用同仓已有实现,不引入新体系。

随后进入 B.1-B.3(Manifest 定义 + 真实文件收集 + 校验),这是唯一实质阻断真实用户验收的部分,也是工作量重心。C 阶段可与 B 并行,因为二者触及的文件基本不重叠。


