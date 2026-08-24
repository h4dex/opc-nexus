# 生图插件验收报告（2026-08-24）

## 结论

本地 `nexus_image_generate` 已接入 Hermes 项目 Host Contract，支持真实 OpenAI 兼容图片接口的文生图和图生图。代码、权限、项目目录隔离和产物哈希门禁通过。

项目模式已 fail-closed：Hermes 原生 `image_generate` 不会进入项目会话工具 schema，唯一生图入口是受 OPC-Nexus Provider、项目目录和审计约束的 `nexus_image_generate`。

真实电商素材生成未放行，原因是当前 Provider 分组未开通图片能力，且本次 Hermes 对话上游同时出现临时 `502/503`。

## 已实现

- Hermes 工具：`nexus_image_generate`。
- 文生图：`POST /images/generations`。
- 图生图：`POST /images/edits`，支持项目内 PNG/JPEG/WebP 参考图。
- 支持模型、尺寸、质量、数量、输出路径；默认可选择 `gpt-image-2`。
- 所有写入要求 `ownerConfirmed=true`。
- 输入和输出必须位于项目工作目录，限制图片数量、文件大小和响应大小。
- Provider API Key 只在 Main 进程读取，不进入 Renderer、Hermes 记忆或日志。
- `b64_json` 和远程 `url` 结果都会下载/解码为真实项目文件。
- 采用临时文件写入后替换目标，并返回相对路径、媒体类型、字节数和 SHA-256。
- Provider HTTP 错误原样转为可操作错误，不生成占位图片。
- 项目模式移除原生 `image_gen` 工具集，防止旧 Hermes 配置绕过 OPC-Nexus 治理。

## 验证结果

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm test -- --run` | PASS：128 个测试文件，1261 个测试通过，1 个跳过 |
| Hermes Python 工具测试 | PASS：17 个 |
| `npm run build` | PASS |
| `npm run hermes:verify` | PASS |
| `npm run hermes:smoke` | PASS：Hermes 0.19.0，工具目录包含 `nexus_image_generate` |
| Hermes API Server project toolset regression | PASS：17 个测试；schema 包含 `nexus_image_generate`，不包含原生 `image_generate` |
| 本地图片桥接单测 | PASS：路径隔离、owner 确认、文生图、图生图、真实产物哈希 |
| Hermes 真实对话生成 | BLOCKED：`api.quya.org` 对话上游连续返回 502/503 |
| Provider 真实图片接口 | BLOCKED：`api.quya.org` + `gpt-image-2` 返回 HTTP 403，`Image generation is not enabled for this group`（证据：`tmp/image-provider-probe-quya-final/report.json`） |

## 复现命令

使用包含真实 Provider 配置的临时用户数据目录，不要把 API Key 写入命令或仓库：

```powershell
$env:AIBOX_ACCEPTANCE_SEED_USER_DATA = 'C:\path\to\user-data'
npm run acceptance:image
npm run acceptance:image:provider
```

验收脚本会把报告和真实产物写入 `tmp/acceptance-image-generation/` 或 `tmp/image-provider-probe/`。本次没有生成图片文件，因此没有用 Mock 或占位资源伪造交付。

## 放行条件

为完成剃须刀电商素材验收，需要给当前 Provider 分组开通图片生成权限，或切换到已开通图片 API 的 Provider/Key。开通后重新执行 `npm run acceptance:image`，应获得白底主图、浴室场景、细节特写和生活方式图四个真实文件及 SHA-256。
