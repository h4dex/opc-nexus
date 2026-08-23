# OPC-Nexus Quest 手机 Web 修复验收报告

日期：2026-08-19

## 验收结论

本轮已修复 Quest 手机入口混用旧 DSH Gateway 的问题，并完成代码、TLS 网关、Hermes Web、IPC 与桌面运行验证。

当前隔离预览数据目录未配置可用 Provider，因此 Hermes 项目服务按策略拒绝启动，无法在该隔离数据上完成真实手机扫码后的模型对话。报告不将此项记录为已通过，也不生成伪成功结果。

## 已修复问题

1. Quest 手机面板改为创建当前项目的 Hermes 手机访问，不再生成旧 DSH Web 二维码。
2. 手机访问配置独立保存到 `hermes:mobile:gateway`，不再依赖启动 DSH 调度 Web。
3. 新增项目级手机访问状态与关闭 IPC，关闭一个项目不会紧急停止全局 DSH Gateway。
4. Quest 底部手机状态灯改为读取当前项目 Hermes Gateway，不再读取旧 DSH 状态。
5. 补齐 Hermes 手机聊天初始化路由：会话列表、聊天历史 POST、新建会话。
6. 手机端禁止“打开主机项目目录”，并隐藏会话弹出独立窗口入口。
7. 配对页面改为简体中文，按钮改为“打开 Quest”。
8. 配对页使用 `same-origin` Referrer Policy，修复部分扫码浏览器不发送 `Origin` 时的 `origin_denied`。
9. 项目中心配置失败后进入对应项目 Quest，不再跳到旧 DSH LAN 设置。

## 自动化验证

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm --prefix vendor/hermes-agent/web run typecheck` | 通过 |
| 手机相关定向测试 | 50/50 通过 |
| `npm test` | 153 个文件通过，1605 个测试通过，2 个跳过 |
| `npm run build` | 通过 |
| Hermes Web 生产构建 | 通过 |
| `npm run hermes:smoke` | Dashboard 与 API Server 均通过，版本 0.19.0 |
| `npm run desktop:smoke` | 通过，无控制台错误 |

## HTTPS 黑盒覆盖

- 配对 URL 不携带一次性验证码。
- 同源 `Origin` 表单配对通过。
- 缺少 `Origin`、仅携带同源 `Referer` 的移动表单配对通过。
- 跨域 Origin、伪造 Host、重复 Cookie 和非法路由继续拒绝。
- operator 可访问项目会话、历史、创建会话和任务队列接口。
- viewer 不获得聊天写权限。
- 手机端 `open-project-directory` 路由被拒绝。
- Hermes 停止后上游解析失败，不返回伪在线页面。

## 实际桌面验证

已定向重启开发 Electron 实例，确认 Main、preload、Renderer 使用同一版本。Quest 页面实际检查结果：

- `window.aibox.getHermesMobileAccessStatus` 可用。
- `window.aibox.createHermesMobilePairing` 可用。
- `window.aibox.stopHermesMobileAccess` 可用。
- 不再出现 `getHermesMobileAccessStatus is not a function` 的页面崩溃。
- 手机面板显示 Hermes 项目服务状态，不再显示 `DSH / Cordis`。

## 未完成的真机门禁

隔离预览数据当前报错：`Hermes cannot start until an OPC-Nexus Provider with API key, endpoint, and model is configured`。

完成真实手机验收需要在当前预览数据中配置 Provider，然后执行：

1. 启动项目 Hermes 服务。
2. 在 Quest 打开手机 Web，生成 operator 二维码。
3. 手机扫码并输入一次性验证码。
4. 验证会话列表、历史、新建会话、发送消息、流式输出和任务队列。
5. 再生成 viewer 二维码，确认只读权限。
6. 关闭项目手机访问，确认手机立即离线且桌面 Hermes 不被误停。

## 环境说明

`hermes:prepare` 的全量 Python staging 重建因下载 `pillow` 超时而回滚；现有 runtime 未被替换。随后 `hermes:smoke` 使用现有 Python 3.11.15 runtime 和本轮新构建的 Hermes Web 资源通过，因此不影响本轮桌面运行验证。

## 后续边界更新（2026-08-22）

Quest 手机二维码现在只创建当前项目 Hermes 的 operator 对话连接，并在配对成功后直接进入 `/chat`。旧 DSH LAN Gateway 不再作为 Quest 手机产品入口，也不向 Hermes 继承已保存的 DSH LAN 授权。Android 执行设备仍保留为实体手机 worker 控制页面，二者不再混用。
