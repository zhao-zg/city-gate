---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '54723ced-0010-4610-ba6a-6024b8272334'
  PropagateID: '54723ced-0010-4610-ba6a-6024b8272334'
  ReservedCode1: '330021fd-5535-4275-a5da-9ba42dc4f93c'
  ReservedCode2: '330021fd-5535-4275-a5da-9ba42dc4f93c'
---

# city-gate

基于 Cloudflare Workers 的城市 IP 访问限制网关。一个 Worker 支持多域名、多城市配置。

## 架构

```
用户请求 → Cloudflare Worker → 按域名查城市配置 → 放行 / 403
```

## 核心设计

一个 Worker 服务所有域名，通过 `DOMAIN_CONFIG` 字典按域名配置：
- **cities**: 允许访问的城市列表（Cloudflare `request.cf.city` 值）
- **origin**: 反向代理的源站地址

```js
const DOMAIN_CONFIG = {
  'sg.1189.dpdns.org': { cities: ['Hangzhou'],             origin: 'https://sg.pages.dev' },
  'sg.07170501.xyz':   { cities: ['Hangzhou'],             origin: 'https://sg.pages.dev' },
  'sg.bxg.dpdns.org':  { cities: ['Hangzhou'],             origin: 'https://sg.pages.dev' },
  // 新增域名示例：
  // 'bj.example.com':  { cities: ['Beijing', 'Shanghai'],  origin: 'https://sg.pages.dev' },
};
```

## 添加新域名/城市

1. 在 `worker.js` 的 `DOMAIN_CONFIG` 中添加域名配置
2. 在 `wrangler.toml` 中添加路由：
   ```toml
   [[routes]]
   pattern = "bj.example.com/*"
   zone_name = "example.com"
   ```
3. 部署即可

## 部署

```bash
cd workers/city-gate
npx wrangler deploy
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `DOMAIN_CONFIG_JSON` | JSON 字符串，覆盖代码内 DOMAIN_CONFIG |
| `PAGES_ORIGIN` | 兜底源站地址 |