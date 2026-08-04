---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'a021f8a6-bbd4-463b-a974-ef33260a65bc'
  PropagateID: 'a021f8a6-bbd4-463b-a974-ef33260a65bc'
  ReservedCode1: '3c522aa5-bcb2-46d8-ad60-b17b75802293'
  ReservedCode2: '3c522aa5-bcb2-46d8-ad60-b17b75802293'
---

# city-gate

基于 Cloudflare Workers 的城市 IP 访问限制网关。

## 架构

```
用户请求 → Cloudflare Worker → 判断 IP 城市 → 放行 / 403
```

## Workers

| Worker | 说明 | 允许城市 | 代理目标 |
|--------|------|----------|----------|
| hangzhou-gate | 杭州 IP 限制网关 | Hangzhou | sg.pages.dev |

## 添加新 Worker

1. 在 `workers/` 下创建目录，例如 `workers/beijing-gate/`
2. 编写 `worker.js` 和 `wrangler.toml`
3. 在 `.github/workflows/deploy.yml` 的 `WORKERS` 列表中添加名称
4. 推送后自动部署

## 部署

推送代码到 master 分支即可自动部署，也可手动：

```bash
cd workers/hangzhou-gate
npx wrangler deploy
```

## 环境变量

每个 Worker 支持通过环境变量覆盖配置：

| 变量 | 说明 |
|------|------|
| `ALLOWED_CITIES` | 允许的城市，逗号分隔 |
| `PAGES_ORIGIN` | 代理的 Pages 源站地址 |