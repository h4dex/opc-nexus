# DeepSeek Harness Sidecar Third-Party Notices

This sidecar redistributes the npm dependency closure recorded in
`package-lock.json`. Every installed package remains under its own license.
The lockfile records exact names, versions, tarball integrity values, and
declared SPDX licenses. License files published in npm tarballs are retained in
`node_modules`; packages whose tarballs omit a stand-alone license file are
covered explicitly below.

## Primary Components

| Component | Version | License | Source |
| --- | ---: | --- | --- |
| DeepSeek Harness ACP demo and `@deepseek-ai/dsh-*` packages | 0.1.0-rc.6 | MIT | https://github.com/deepseek-ai/deepseek-harness |
| DeepSeek Harness Cordis packages | versions in lockfile | MIT | https://github.com/deepseek-ai/deepseek-harness |
| DeepSeek Harness pi-ai adapter | 0.1.0-rc.6 | MIT | https://github.com/deepseek-ai/deepseek-harness |
| pi-ai multi-provider library | 0.82.1 | MIT | https://www.npmjs.com/package/@earendil-works/pi-ai |
| Agent Client Protocol TypeScript SDK | 0.25.1 | Apache-2.0 | https://github.com/agentclientprotocol/typescript-sdk |
| node-addon-require-builtin | 0.1.4 | MIT | https://www.npmjs.com/package/node-addon-require-builtin |
| Koffi and platform payload | 3.1.4 | MIT | https://github.com/Koromix/koffi |

The supporting multi-provider closure contains packages under MIT, ISC,
Apache-2.0, BSD-3-Clause, 0BSD, and Python-2.0 terms. Representative non-MIT
entries are:

| Package | Version | License |
| --- | ---: | --- |
| `@agentclientprotocol/sdk` | 0.25.1 | Apache-2.0 |
| `argparse` | 2.0.1 | Python-2.0 |
| `yaml` | 2.9.0 | ISC |
| Google and AWS SDK packages | versions in lockfile | Apache-2.0 |
| Smithy utility packages | versions in lockfile | Apache-2.0 or BSD-3-Clause |

The following published package directories do not contain a stand-alone
`LICENSE`, `COPYING`, or `NOTICE` file. Their license coverage in this
redistribution is:

| Package | License | Redistributed license text or notice |
| --- | --- | --- |
| `@aws-sdk/credential-provider-http@3.972.70` | Apache-2.0 | Complete Apache 2.0 text at `node_modules/@agentclientprotocol/sdk/LICENSE` |
| `@aws-sdk/credential-provider-login@3.972.75` | Apache-2.0 | Complete Apache 2.0 text at `node_modules/@agentclientprotocol/sdk/LICENSE` |
| `@aws-sdk/nested-clients@3.997.42` | Apache-2.0 | Complete Apache 2.0 text at `node_modules/@agentclientprotocol/sdk/LICENSE` |
| `@earendil-works/pi-ai@0.82.1` | MIT | pi-ai notice and complete MIT text below |
| `@koromix/koffi-<platform>-<arch>@3.1.4` | MIT | Complete Koffi MIT text at `node_modules/koffi/LICENSE.txt` |
| `data-uri-to-buffer@4.0.1` | MIT | Complete Nathan Rajlich MIT notice in `node_modules/data-uri-to-buffer/README.md` |

The pi-ai library's generic provider closure installs `@anthropic-ai/sdk`
0.91.1. This composition registers no Anthropic provider route and does not
install or mount the distinct Claude Code/Claude Agent SDK integration.

## pi-ai MIT Notice

Copyright (c) 2025 Mario Zechner

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

## DeepSeek Harness MIT Notice

Copyright (c) 2026 DeepSeek

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

## Apache License 2.0

The Agent Client Protocol TypeScript SDK is distributed under Apache License
2.0. Its complete license text is retained at
`node_modules/@agentclientprotocol/sdk/LICENSE` in the staged runtime and is
available at https://www.apache.org/licenses/LICENSE-2.0.
