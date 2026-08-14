# GitHub Release 发布指南

GitHub Actions 负责验证、跨平台打包和 Release 发布。正常发布只需要更新版本并推送版本标签，不需要在本机上传安装包。

## 自动化流程

- `.github/workflows/ci.yml`：推送到 `main` / `master` 或向 `main` 提交 Pull Request 时，在 Windows 与 Ubuntu 上执行依赖安装、类型检查、单元测试和生产构建。
- `.github/workflows/release.yml`：推送 `v*` 标签后，验证标签与 `package.json` 版本一致；先构建一次生产签名 Android Bridge，再由 Windows 与 Linux 任务下载同一 APK 并内置到桌面安装包，最后统一发布到 GitHub Release。
- Release 校验会准备固定版本的 DeepSeek Harness，以 Electron 内置 Node 验证依赖边界，并在 Windows/Linux 打包后执行 ACP smoke test。
- Release 同时包含 `SHA256SUMS.txt`，用于校验下载文件完整性。

## 发布新版本

1. 更新 `package.json` 和 `package-lock.json` 中的版本。
2. 在 `CHANGELOG.md` 顶部记录新版本内容和日期。
3. 完成变更提交并确保 GitHub CI 通过。
4. 创建并推送与版本一致的标签。

```bash
git tag -a v1.8.0 -m "OPC-Nexus 1.8.0"
git push github main
git push github v1.8.0
```

标签必须严格等于 `v` 加 `package.json` 的版本，例如 `package.json` 为 `1.8.0` 时只能发布 `v1.8.0`。不匹配时 Release 工作流会在打包前失败。

## 手动重跑

在 GitHub 仓库的 **Actions > Release > Run workflow** 中输入已存在的标签，可以重新构建该版本。已有 Release 会保留说明并覆盖同名安装包。

## Windows 代码签名

没有证书时工作流仍可生成安装包，但 Windows SmartScreen 可能显示未知发布者。取得代码签名证书后，在仓库的 **Settings > Secrets and variables > Actions** 中添加：

- `WIN_CSC_LINK`：electron-builder 支持的证书 URL、文件路径或 Base64 内容。
- `WIN_CSC_KEY_PASSWORD`：证书密码。

工作流不会把证书写入仓库或构建产物。Linux AppImage 与 DEB 当前不做发行签名。

## Android 生产签名

Android Bridge 的生产 keystore 必须放在仓库外。首次发布前，在 GitHub 仓库的
**Settings > Secrets and variables > Actions** 中配置：

- `OPCNEXUS_ANDROID_KEYSTORE_BASE64`：PKCS12/JKS keystore 文件的 Base64 内容。
- `OPCNEXUS_ANDROID_STORE_PASSWORD`：keystore 口令。
- `OPCNEXUS_ANDROID_KEY_ALIAS`：发布密钥别名。
- `OPCNEXUS_ANDROID_KEY_PASSWORD`：发布私钥口令。

`build-android` 任务只在临时 Runner 中恢复 keystore，构建并验证 Release APK 后上传为短期
Actions Artifact。Windows 与 Linux 任务下载同一个已签名 APK，因此独立下载的 APK、Windows
安装包和 Linux 包内置的 Bridge 具有完全相同的 SHA-256 与签名证书。

Android 应用发布后必须永久保留同一 keystore；丢失密钥将无法为已有安装用户提供覆盖升级。

## 产物

| 平台 | 格式 | 用途 |
|---|---|---|
| Windows x64 | `Setup-*.exe` | NSIS 图形安装程序 |
| Linux x64 | `*.AppImage` | 免安装运行包 |
| Linux x64 | `*.deb` | Ubuntu / Debian 安装包 |
| Android 8.0+ | `OPC-Nexus-Mobile-Bridge-*-release.apk` | 无 Root 手机桥安装包 |
| Android 元数据 | `OPC-Nexus-Mobile-Bridge-*-manifest.json` | APK 包名、版本、摘要和签名证书摘要 |
| 全部 | `SHA256SUMS.txt` | SHA-256 完整性校验 |

GitHub Actions 的中间构建产物保留 14 天，GitHub Release 中的正式附件长期保留。
