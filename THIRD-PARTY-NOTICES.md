# 第三方开源组件声明 (Third-Party Notices)

本项目 OPC-Nexus 使用了以下开源软件组件。我们对所有原始作者表示感谢，
并在此列出各组件的许可证信息。

---

## 运行时依赖 (Runtime Dependencies)

| 组件 | 版本 | 许可证 | 仓库 |
|------|------|--------|------|
| @larksuiteoapi/node-sdk | ^1.71.1 | MIT | https://github.com/larksuite/node-sdk |
| @xyflow/react | ^12.11.2 | MIT | https://github.com/xyflow/xyflow |
| cors | ^2.8.6 | MIT | https://github.com/expressjs/cors |
| dompurify | ^3.4.12 | MPL-2.0 OR Apache-2.0 | https://github.com/cure53/DOMPurify |
| express | ^5.2.1 | MIT | https://github.com/expressjs/express |
| marked | ^18.0.7 | MIT | https://github.com/markedjs/marked |
| playwright-core | ^1.61.1 | Apache-2.0 | https://github.com/microsoft/playwright |
| sql.js | ^1.14.1 | MIT | https://github.com/nicolo-ribaudo/sql.js |
| systeminformation | ^5.25.11 | MIT | https://github.com/sebhildebrandt/systeminformation |
| ws | ^8.21.1 | MIT | https://github.com/websockets/ws |
| zustand | ^5.0.6 | MIT | https://github.com/pmndrs/zustand |

### Android Bridge Dependencies

| Component | Version | License | Repository |
|---|---:|---|---|
| AndroidX Core | 1.10.1 | Apache-2.0 | https://github.com/androidx/androidx |
| ZXing Android Embedded | 4.3.0 | Apache-2.0 | https://github.com/journeyapps/zxing-android-embedded |
| ZXing Core | 3.4.1 | Apache-2.0 | https://github.com/zxing/zxing |

## 开发依赖 (Dev Dependencies)

| 组件 | 版本 | 许可证 | 仓库 |
|------|------|--------|------|
| electron | ^37.2.0 | MIT | https://github.com/electron/electron |
| electron-builder | ^26.0.12 | MIT | https://github.com/electron-userland/electron-builder |
| electron-vite | ^3.1.0 | MIT | https://github.com/alex8088/electron-vite |
| react | ^19.1.0 | MIT | https://github.com/facebook/react |
| react-dom | ^19.1.0 | MIT | https://github.com/facebook/react |
| typescript | ^5.8.3 | Apache-2.0 | https://github.com/microsoft/TypeScript |
| vite | ^6.3.5 | MIT | https://github.com/vitejs/vite |
| vitest | ^3.2.7 | MIT | https://github.com/vitest-dev/vitest |
| @vitejs/plugin-react | ^4.4.1 | MIT | https://github.com/vitejs/vite-plugin-react |

---

## 许可证全文

### MIT License

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Apache License 2.0

适用于：playwright-core, typescript

```
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

### Mozilla Public License 2.0 (MPL-2.0)

适用于：dompurify（可选，也可选择 Apache-2.0）

```
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
```

---

## 致谢

### hermes-android

`mobile/android-bridge` 与 `mobile/hermes-plugin` 基于
[raulvidis/hermes-android](https://github.com/raulvidis/hermes-android) 提交
`5f2f8ab6a42b8b88a6588f5cda178af8b89f8311` 改造。上游声明采用 MIT License；
原作者版权与 MIT 许可条款随本仓库和安装包保留。上游在该提交中未包含根目录 LICENSE 文件，
来源、固定提交及其公开授权信息因此在此单独记录。

感谢以上所有开源项目的贡献者，正是他们的工作使本项目得以实现。
各组件的完整版权声明和许可证文本可在对应的 GitHub 仓库中找到。
