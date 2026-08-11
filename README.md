---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'b4ef205b-a414-4f13-bff2-6db82249e474'
  PropagateID: 'b4ef205b-a414-4f13-bff2-6db82249e474'
  ReservedCode1: '6ba1b111-172f-4f2d-9804-0b1fa854ca59'
  ReservedCode2: '6ba1b111-172f-4f2d-9804-0b1fa854ca59'
---

# city-gate

基于 Cloudflare Workers 的 IP 访问限制网关。一个 Worker 支持多域名、多地区配置。

## 项目结构

```
workers/
├── shared/
│   ├── ip2region.js     # ip2region xdb 查询器（Worker 适配版）
│   ├── ip-lookup.js     # IP 归属地统一封装层
│   └── schedule.js      # 开放时段判断
├── city-gate/           # 城市访问网关
│   ├── worker.js
│   └── wrangler.toml
└── cxapk/               # APK 下载页（Pages 托管）
    └── index.html
scripts/
├── sync-cname.js        # DNS CNAME 同步脚本
└── update-ip2region.js  # ip2region xdb 更新脚本
```

## 地理匹配策略

城市级匹配：ip2region 离线IP库精确到城市，由运营商IP段决定，精度远高于 Cloudflare GeoIP。

| 策略 | 数据源 | 精度 |
|------|--------|------|
| 城市级匹配 | ip2region（KV+内存缓存） | 精确到城市 |

ip2region 的 xdb 数据文件存储在 Cloudflare KV 中，冷启动时加载到内存，后续查询纯内存操作（~0.01ms）。
如果 ip2region 不可用（xdb 未加载），降级使用 Cloudflare `request.cf` 的城市名。

## 域名组配置

配置通过环境变量 `DOMAIN_CONFIG_JSON` 提供（见 `wrangler.toml` 的 `[vars]`），使用**域名组数组**结构：同一源站/地区规则的域名共享一份配置，无需逐个重复。

```json
[
  {
    "origin": "https://sg-7gj.pages.dev",
    "cities": ["杭州", "Hangzhou"],
    "provinces": ["浙江", "Zhejiang"],
    "domains": ["sg.1189.dpdns.org", "sg.07170501.xyz"]
  },
  {
    "origin": "https://cx-1wd.pages.dev",
    "cities": ["ALL"],
    "domains": ["cx.zhaozg.dpdns.org"]
  }
]
```

- `cities`：城市级匹配（中英文兼容），包含 `"ALL"` 时全部放行
- `provinces`：ip2region 不可用时降级省级匹配
- `domains`：共享以上规则的域名列表
- `origin`：反向代理源站

### zones + prefixes 格式（推荐）

当前仓库采用 `zones + prefixes` 结构（见 `wrangler.toml`）：域名拆分为 zone（注册域）与 prefix（子域名前缀），运行时自动展开 `prefix.zone` 为完整域名，避免逐个重复。

```json
{
  "zones": ["1189.dpdns.org", "zzg.cc.cd"],
  "groups": [
    { "prefix": "sg", "origin": "https://sg-f3b.pages.dev", "cities": ["ALL"] },
    { "prefix": "bible", "origin": "https://bible-bka.pages.dev", "cities": ["杭州"] }
  ]
}
```

### 不使用优选域名（noPreferred）

`zones` 元素支持两种写法：

- 字符串（默认）：使用优选域名。`sync-cname.js` 会从优选域名池为该 zone 分配一个优选域名，子域名 CNAME 指向它。
- 对象：`{ "name": "zzg.cc.cd", "noPreferred": true }` — **不使用优选域名**。同步脚本跳过优选域名池，将该 zone 的子域名直接 CNAME 到各前缀对应的源站 `origin`（如 `sg.zzg.cc.cd → sg-f3b.pages.dev`），适用于不需要优选线路的域名。

```json
{
  "zones": [
    "1189.dpdns.org",
    { "name": "zzg.cc.cd", "noPreferred": true }
  ],
  "groups": [
    { "prefix": "sg", "origin": "https://sg-f3b.pages.dev", "cities": ["ALL"] }
  ]
}
```

> `noPreferred` 仅影响 DNS 同步（`sync-cname.js`）的 CNAME 目标选择，不影响 Worker 网关与路由生成。

## 添加新域名

1. 在 `wrangler.toml` 的 `DOMAIN_CONFIG_JSON` 对应分组中追加域名
2. 在 `wrangler.toml` 中添加路由
3. 部署即可

## 部署

### 自动部署（推荐）

推送 master 分支自动触发 GitHub Actions：
- 自动更新 ip2region xdb 到 KV
- 自动部署全部 Worker

### 手动部署

```bash
cd workers/city-gate
npx wrangler deploy
```

### 首次部署：配置 KV

无需手动创建 KV namespace。`scripts/update-ip2region.js` 脚本会自动：
1. 通过 Cloudflare API 查找名为 `city-gate-IP2REGION` 的 KV namespace
2. 如不存在则自动创建
3. 将 namespace id 写回 `wrangler.toml`
4. 下载并上传最新 xdb 数据到 KV

```bash
# 一键初始化（自动创建 KV + 上传 xdb）
CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=xxx \
  node scripts/update-ip2region.js
```

> 如果已有 KV namespace，可通过 `KV_NAMESPACE_ID` 环境变量指定，脚本会跳过创建步骤。

### 更新 ip2region 数据

```bash
# 自动：检查 GitHub 最新 release 并更新
CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=xxx \
  node scripts/update-ip2region.js

# 已有 KV namespace 时指定 id
CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=xxx \
  KV_NAMESPACE_ID=xxx node scripts/update-ip2region.js

# 指定版本
IP2REGION_VERSION=3.5.1 CLOUDFLARE_API_TOKEN=xxx \
  CLOUDFLARE_ACCOUNT_ID=xxx \
  node scripts/update-ip2region.js
```

## GitHub Secrets

| Secret | 说明 |
|--------|------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（需 Workers、KV、DNS、Account Settings 权限） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账户 ID |
| `KV_IP2REGION_NAMESPACE_ID` | (可选) ip2region KV namespace ID，不配置则脚本自动创建 |

## DNS CNAME 同步

`scripts/sync-cname.js` 脚本自动管理 Cloudflare DNS 中的 CNAME 记录。

### 本地运行

```bash
# 预览模式
CLOUDFLARE_API_TOKEN=xxx DRY_RUN=1 node scripts/sync-cname.js

# 实际执行
CLOUDFLARE_API_TOKEN=xxx node scripts/sync-cname.js
```

## 环境变量

| 变量 | Worker | 说明 |
|------|--------|------|
| `DOMAIN_CONFIG_JSON` | city-gate | JSON 字符串（域名组数组），唯一配置来源，格式见 wrangler.toml |
| `PAGES_ORIGIN` | city-gate | 兜底源站地址 |