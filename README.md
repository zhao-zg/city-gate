---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '3c707888-94c8-42e0-abbf-9d15fc72e4ca'
  PropagateID: '3c707888-94c8-42e0-abbf-9d15fc72e4ca'
  ReservedCode1: '5ffc6d78-9534-43f2-8d7c-e94413ad186e'
  ReservedCode2: '5ffc6d78-9534-43f2-8d7c-e94413ad186e'
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

## DNS CNAME 同步

`scripts/sync-cname.js` 脚本自动管理 Cloudflare DNS 中的 CNAME 记录，将指定 zone 下的域名指向优选域名。

### 当前配置

| Zone | 域名 | CNAME 目标 |
|------|------|-----------|
| `zhaozg.dpdns.org` | sg / books / bible / cx | `saas.sin.fan` |

### 脚本逻辑

对每个配置的域名：
- 已有 CNAME 且目标正确 → 跳过
- 已有 CNAME 但目标不同 → 删除旧记录，新建指向优选域名
- 无 CNAME → 新建记录

### 本地运行

```bash
# 预览模式（不执行修改）
CLOUDFLARE_API_TOKEN=xxx DRY_RUN=1 node scripts/sync-cname.js

# 实际执行
CLOUDFLARE_API_TOKEN=xxx node scripts/sync-cname.js
```

### GitHub Actions

- **手动触发**：Actions → 同步 DNS CNAME → Run workflow（可选预览模式）
- **自动触发**：`scripts/sync-cname.js` 文件变更推送到 master 时自动同步
- 需要在仓库 Secrets 中配置 `CLOUDFLARE_API_TOKEN`（需 Zone:DNS:Edit 权限）

### 新增优选域名

编辑 `scripts/sync-cname.js` 中的 `CNAME_MAP` 数组：

```js
const CNAME_MAP = [
  {
    zoneName: 'zhaozg.dpdns.org',
    target: 'saas.sin.fan',
    names: ['sg', 'books', 'bible', 'cx'],
  },
  // 新增优选域名示例：
  // {
  //   zoneName: '1189.dpdns.org',
  //   target: 'preferred2.example.com',
  //   names: ['sg', 'books', 'bible'],
  // },
];
```

## 环境变量

| 变量 | Worker | 说明 |
|------|--------|------|
| `DOMAIN_CONFIG_JSON` | city-gate | JSON 字符串，覆盖代码内 DOMAIN_CONFIG |
| `PAGES_ORIGIN` | city-gate | 兜底源站地址 |
| `ALLOWED_CITIES` | cxapk | 允许的城市，逗号分隔（不配置则全部允许） |