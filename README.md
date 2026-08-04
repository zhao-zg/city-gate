---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '5a8e97f8-4ba4-4e4a-8501-31b8a99a3b6a'
  PropagateID: '5a8e97f8-4ba4-4e4a-8501-31b8a99a3b6a'
  ReservedCode1: '8ed10ee2-4718-43eb-aedb-843f97abe382'
  ReservedCode2: '8ed10ee2-4718-43eb-aedb-843f97abe382'
---

# city-gate

基于 Cloudflare Workers 的城市 IP 访问限制网关。一个 Worker 支持多域名、多城市配置。

## 项目结构

```
workers/
├── shared/
│   └── deny-page.js    # 共享 403 页面模板
├── city-gate/          # 城市访问网关
│   ├── worker.js
│   └── wrangler.toml
└── cxapk/              # APK 下载代理
    ├── worker.js
    └── wrangler.toml
```

## Workers

### city-gate — 城市访问网关

一个 Worker 服务所有域名，按源站分组配置，同组域名共享 cities 和 origin：

```js
// 域名组 — 同组域名共享配置，新增域名往组里加即可
const DOMAIN_GROUPS = [
  {
    origin: 'https://sg-7gj.pages.dev',
    domains: [
      'sg.1189.dpdns.org',
      'sg.07170501.xyz',
      'sg.bxg.dpdns.org',
      'sg.zhaozg.dpdns.org',
      'sg.zhaozg.cloudns.org',
    ],
  },
  // 不同源站/城市的新组：
  // {
  //   origin: 'https://bj.pages.dev',
  //   cities: ['Beijing', 'Shanghai'],
  //   domains: ['bj.example.com'],
  // },
];
```

### cxapk — APK 下载代理

带城市检查的 APK 下载代理，通过 URL 路径段动态替换源站前缀。

## 添加新域名/城市

1. 在 `worker.js` 的 `DOMAIN_GROUPS` 中添加域名（同组域名加到 `domains` 数组，新源站则新建组）
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

推送 master 分支会自动部署全部 Worker（GitHub Actions）。

## 环境变量

| 变量 | Worker | 说明 |
|------|--------|------|
| `DOMAIN_CONFIG_JSON` | city-gate | JSON 字符串，覆盖代码内 DOMAIN_CONFIG |
| `PAGES_ORIGIN` | city-gate | 兜底源站地址 |
| `ALLOWED_CITIES` | cxapk | 允许的城市，逗号分隔（不配置则全部允许） |