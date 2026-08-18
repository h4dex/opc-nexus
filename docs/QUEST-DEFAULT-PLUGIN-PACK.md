# Quest 默认能力包

## 目标

Quest 默认展示用户指定的 10 项 DSH 社区能力，但第三方代码默认启用数为 0。
“已集成”只表示来源、固定版本、兼容性证据和权限边界已经进入 Main 管理的目录；
**目录可见、包已安装、Profile 已启用和运行时 `live` 是四个不同状态**。目录展示不表示
包已执行、获得凭据，或可以绕过 managed DSH 的 `filesystem=false`、`network=false`
和 `runtimeAuthoring=false` 上限。Quest UI 禁止仅因目录项存在或一次 smoke 成功就显示
“已加载/运行中”的绿色状态。

所有状态由 `DshCommunityPluginService` 投影。Renderer 只收到脱敏目录，不能提供
任意 npm/Git URL、命令、环境变量或通用 IPC 调用。

## 固定目录与真实兼容矩阵

| Part | 请求名称 | 固定来源 | rc.6 兼容性证据 | Quest 边界与当前运行事实 |
|---|---|---|---|---|
| 01 | dsh-anchored-standard | `xiaobright/dsh-anchored-standard@25f21aefaf8ddc414da54d2e581e43740d977c6e` | 不是 Cordis plugin，managed policy 冲突 | `blocked`；未加载 |
| 02 | dsh-web-ui | `@linxin666/dsh-web-ui-all@0.1.19` | manifest 与 rc.6 bundle composition 已核验 | `blocked`；官方 DSH Web UI 已内置，社区聚合增强包未挂载、未加载 |
| 03 | DSH-better-sidebar | `dsh-better-sidebar@0.12.3` | peer 对齐 rc.6，包含原生 PTY、终端和文件写入 | `explicit-profile-permission`；权限适配前未加载 |
| 04 | modlens | `@liustack/modlens@3.18.1` | 未声明 rc.6 peer，涉及视觉凭据和本机文件 | `main-adapter-required`；未验证、未加载 |
| 05 | dsh-vision-toolkit | `@anionex/dsh-vision-toolkit@0.1.26` | peer 对齐 rc.6，仍需要进程、附件和网络权限 | `main-adapter-required`；宿主适配前未加载 |
| 06 | dsh-TUI | `@openma/deepseek-harness-tui@0.2.1` | 与 `dsh-tui@0.2.19` 存在名称歧义 | `standalone-only`；不进入 Quest managed profile |
| 07 | dsh-browser | `dsh-browser@0.1.0` | 未验证 rc.6，具备浏览器网络和写操作 | `main-adapter-required`；未验证、未加载 |
| 08 | dsh_workflow | `omdsh-dev/dsh_workflow@44b83c182aa02d1be8a0803e8446cb495f93cd8f` | peer 目标为旧 rc.2，动态 runtime authoring | `blocked`；不兼容、未加载 |
| 09 | dsh-chat-import | `dsh-chat-import@0.5.1` | 固定版本的 rc.6 兼容性元数据已核验 | `explicit-profile-permission`；目录与 Session 写权限未授权前未加载 |
| 10 | dsh-find-plugin | `dsh-find-plugin@0.3.6` | rc.6 启动 smoke 已通过；peer range 仍陈旧 | `main-adapter-required`；仍需宿主网络代理和供应链适配，返回的第三方安装命令不可信，当前未加载 |

`dsh-find-plugin` 的 smoke 只证明该固定包能在 rc.6 启动，不证明其发现结果可直接安装，
也不授予网络或包管理权限。所有搜索结果必须先进入 Main 的来源固定、完整性、许可证、
安装脚本和权限审查，再由受控 Host Adapter 执行。

## 生命周期

- `reviewed-profile`：精确版本和 bundle 通过审核后，可使用一次性确认能力安装。
- `explicit-profile-permission`：兼容性通过，但必须先实现目录、网络或进程的细粒度授权；当前不显示安装入口。
- `main-adapter-required`：复用 `aibox-native-host` 的凭据、附件、浏览器或工作流代理；不能直接加载社区实现。
- `standalone-only`：使用独立 `DSH_HOME`、进程、storage partition 和凭据域，不进入 Quest managed profile。
- `blocked`：不是插件、聚合权限过大、peer 不兼容或供应链风险未闭环。

兼容性 `verified` 只允许 UI 显示“兼容性已验证”；只有包确已挂载到目标 Profile、执行
handler 已 attach、健康探针通过且逐次策略检查已接线时，才可报告 `live`。上述 10 项
当前第三方运行时 `live` 数仍为 0。

包级 `quest-default` 是目录，不提供批量安装操作。每项必须单独通过固定来源、兼容性、
权限和审计检查。第三方代码的存在永远不能把插件状态提升为 `live`。

## 升级门槛

1. 重新固定版本或 40 位 Git commit，并记录发布者和仓库。
2. 验证 Cordis bundle、DSH rc.6 peer、consumer lifecycle scripts 和 native 依赖。
3. 为每项权限接入 `DshPolicyBroker`；密钥只经 Main 的短期代理使用。
4. 覆盖安装、停止/恢复 profile、失败回滚、重启、LAN 和打包后 smoke。
5. 只有执行 handler 已 attach 且逐次权限检查通过，统一目录才能报告 `live`。
