---
name: cnb
description: CNB(cnb.cool)云原生构建平台操作:Git 推送、.cnb.yml CI 配置、CNB OpenAPI(Release/Issue/PR)。当需要推送代码到 CNB 远端、修改 CI 流水线、发布 Release 或调用 CNB API 时使用。
---

# CNB 平台操作指南

本仓库托管于 CNB:`https://cnb.cool/senke/innovation/opc-nexus`

## 认证约定

- Git 远端 `origin` 已内嵌凭据(用户名 `cnb` + 访问令牌),存于 `.git/config`,**不在提交文件中**
- 需要令牌时从 remote URL 提取,禁止硬编码到任何被提交的文件:

```bash
TOKEN=$(git remote get-url origin | sed -E 's#https://cnb:([^@]+)@.*#\1#')
```

- Git 身份:`liyingjie <y@senke.com>`

## 提交与推送工作流

每完成一个功能:

```bash
npm run typecheck && npm test        # 必须通过
git add <相关文件>
git commit -m "feat: 功能描述"       # 前缀:feat/fix/docs/chore/refactor/test
git push origin master               # 推送到 CNB
```

- 提交信息与仓库历史风格一致(见 `git log --oneline`),一行为主
- 敏感信息(令牌、密钥、Secret)绝不进入提交内容;渠道凭据走 safeStorage,不落盘明文

## CI 配置(.cnb.yml)

仓库根目录 `.cnb.yml`,文档:https://docs.cnb.cool/zh/build/configuration.html

结构:`分支名 → 事件(push / pull_request / tag_push)→ 流水线数组`

```yaml
master:
  push:
    - name: typecheck-and-test
      docker:
        image: node:22
      stages:
        - name: install
          script: npm ci --registry=https://registry.npmmirror.com
        - name: typecheck
          script: npm run typecheck
        - name: test
          script: npm test
```

要点:
- 分支名可用通配:`"$"` 表示所有分支,`"v*"` 匹配 tag
- 每条流水线在独立 Docker 容器中执行;`stages` 顺序执行,失败即终止
- 可用 `imports` 引入密钥仓库中的环境变量(密钥不明文写入 .cnb.yml)
- 常用事件:`push`、`pull_request`、`tag_push`、`api_trigger`(手动/API 触发)

## CNB OpenAPI

Base URL:`https://api.cnb.cool`,认证头:`Authorization: <TOKEN>`
文档:https://api.cnb.cool/swagger.html

仓库路径参数即完整 slug:`senke/innovation/opc-nexus`

```bash
TOKEN=$(git remote get-url origin | sed -E 's#https://cnb:([^@]+)@.*#\1#')
API="https://api.cnb.cool"
REPO="senke/innovation/opc-nexus"

# 查询仓库信息
curl -s -H "Authorization: $TOKEN" "$API/$REPO"

# 创建 Release(先打 tag 并推送)
curl -s -X POST -H "Authorization: $TOKEN" -H "Content-Type: application/json" \
  "$API/$REPO/-/releases" \
  -d '{"tag_name":"v1.0.0","name":"v1.0.0","body":"发布说明"}'

# 列出 Issues
curl -s -H "Authorization: $TOKEN" "$API/$REPO/-/issues?state=open"

# 触发构建(api_trigger 事件)
curl -s -X POST -H "Authorization: $TOKEN" -H "Content-Type: application/json" \
  "$API/$REPO/-/build/start" \
  -d '{"branch":"master","event":"api_trigger"}'
```

## 排障

- `403/401`:令牌过期或权限不足 → 到 CNB 仓库「设置 → 访问令牌」重新生成,`git remote set-url origin "https://cnb:<新令牌>@cnb.cool/senke/innovation/opc-nexus.git"`
- 推送被 CI 拒绝:本地先跑 `npm run typecheck && npm test` 复现
- 构建日志:仓库页「流水线」查看各 stage 输出
