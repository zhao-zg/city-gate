---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'c1690028-989e-4423-b93e-1d20c00aecb8'
  PropagateID: 'c1690028-989e-4423-b93e-1d20c00aecb8'
  ReservedCode1: '5dd6b085-9a7d-4ed9-9a45-7aa696530338'
  ReservedCode2: '5dd6b085-9a7d-4ed9-9a45-7aa696530338'
---

# city-gate

基于 Cloudflare for SaaS + A 记录直连优选 IP 的域名管理网关。无 Worker、零冷启动，支持多域名、多账户、地理围栏和时段控制。

## 架构

```
用户 → DNS A记录 → CF边缘IP(优选) → SaaS Custom Hostname 路由
     → custom_origin 指向的 Pages 源站 → 返回
```

- **零 Worker、零 KV、零冷启动**
- A 记录直连优选 IP（sync-dns.js 自动管理）
- CF for SaaS 免费 100 个 Custom Hostnames
- WAF Custom Rules 实现地理围栏 + 时段控制
- 多账户独立配置，互为容灾

## 项目结构

```
workers/                     # Worker 代码（保留不部署，可回退）
├── shared/
│   ├── ip2region.js         # ip2region xdb 查询器（Worker 适配版）
│   ├── ip-lookup.js         # IP 归属地统一封装层
│   └── schedule.js          # 开放时段判断
├── city-gate/               # 账户1 配置
│   ├── worker.js
│   └── wrangler.toml        # ← 唯一配置来源（DOMAIN_CONFIG_JSON）
├── city-gate-2/             # 账户2 配置
│   ├── worker.js
│   └── wrangler.toml        # ← 账户2 配置
└── cxapk/                   # APK 下载页（Pages 托管）
    └── index.html
scripts/
├── setup-saas.js            # DNS 初始化（优选 IP + A 记录创建）
├── setup-firewall.js        # WAF Custom Rules 配置（地理围栏 + 时段控制）
├── sync-dns.js              # DNS A 记录同步（Docker 定时执行）
├── sync-cname.js            # DNS CNAME 同步 + provider 路由层
├── dns-huaweicloud.js       # 华为云 DNS API 客户端（可选 provider）
├── cleanup-saas.js          # SaaS 旧资源清理
├── check-cname.js           # DNS 记录检测
├── generate-routes.js       # Worker 路由生成（回退时使用）
├── validate-config.js       # 配置校验
├── update-ip2region.js      # ip2region xdb 更新（回退时使用）
└── obfuscate-cxapk.js       # Pages JS 混淆
docker/
├── Dockerfile               # Docker 镜像（DNS 同步容器）
├── entrypoint.sh            # 容器入口（cron 定时同步）
└── docker-compose.yml       # Docker Compose 配置
```

## 域名组配置

配置通过环境变量 `DOMAIN_CONFIG_JSON` 提供（见 `wrangler.toml` 的 `[vars]`），使用 `zones + groups` 结构。

```json
{
  "zones": ["1189.dpdns.org", "zhaozg.dpdns.org"],
  "groups": [
    {
      "prefix": "sg",
      "origin": "https://sg-f3b.pages.dev",
      "cities": ["ALL"]
    },
    {
      "prefix": "bible",
      "origin": "https://bible-2o8.pages.dev",
      "cities": ["杭州", "Hangzhou"],
      "provinces": ["浙江", "Zhejiang"]
    },
    {
      "prefix": "books",
      "origin": "https://books-em3.pages.dev",
      "cities": ["ALL"],
      "schedule": { "days": [1,2,3,4,5,6,7], "periods": ["01:00-22:00"] }
    }
  ]
}
```

- `zones`：注册域列表
- `groups`：前缀组，每个 group 展开为 `prefix.zone` 的 FQDN
- `cities`：`["ALL"]` 全部放行，或指定城市列表
- `provinces`：省级匹配，用于 WAF 地理围栏规则
- `schedule`：时段控制，由 Docker 容器定时 enable/disable WAF rule 实现
- `origin`：反向代理源站（Pages 项目地址）

### 不使用优选域名（noPreferred）

`zones` 元素支持两种写法：

- 字符串（默认）：使用优选 IP，`sync-dns.js` 分配 A 记录指向 CF 边缘优选 IP
- 对象：`{ "name": "zzg.cc.cd", "noPreferred": true }` — 不使用优选 IP，直接 CNAME 到源站

### DNS 托管在华为云（可选）

`zones` 元素支持 `dnsProvider` 字段，将 DNS 记录管理从 Cloudflare 迁移到华为云 DNS：

```json
{
  "zones": [
    "1189.dpdns.org",
    { "name": "example.com", "dnsProvider": "huaweicloud" }
  ],
  "groups": [...]
}
```

- 默认 `dnsProvider` 为 `cloudflare`（不写即默认）
- 设为 `huaweicloud` 后，该 zone 的 A/CNAME 记录通过华为云 DNS API 管理
- 架构不变：A 记录仍指向 CF Anycast 优选 IP，只是 DNS 记录托管在华为云
- 华为云 zone 跳过 `_ssl` 保底和 SaaS 旧资源清理（CF 专属机制）
- 需配置华为云环境变量（见下文）

## 部署

### CI/CD 自动部署

推送 master 分支自动触发 GitHub Actions：
- **SaaS 配置**：自动创建/更新 Fallback Origin + Custom Hostnames
- **Firewall 配置**：自动创建/更新 WAF Custom Rules（地理围栏 + 时段控制）
- **Pages 部署**：自动部署 cxapk 下载页

### 手动运行

```bash
# SaaS 配置（预览）
CLOUDFLARE_API_TOKEN=xxx DRY_RUN=1 node scripts/setup-saas.js

# SaaS 配置（执行）
CLOUDFLARE_API_TOKEN=xxx node scripts/setup-saas.js

# Firewall 配置（预览）
CLOUDFLARE_API_TOKEN=xxx DRY_RUN=1 node scripts/setup-firewall.js

# Firewall 配置（执行）
CLOUDFLARE_API_TOKEN=xxx node scripts/setup-firewall.js

# DNS A 记录同步（预览）
CLOUDFLARE_API_TOKEN=xxx DRY_RUN=1 node scripts/sync-dns.js

# DNS A 记录同步（执行）
CLOUDFLARE_API_TOKEN=xxx node scripts/sync-dns.js
```

## Docker 定时同步

Docker 容器每 6 小时执行一次 `sync-dns.js`，自动更新 DNS A 记录指向最新优选 IP。

```bash
# 构建
docker build -t city-gate-cron -f docker/Dockerfile .

# 运行
docker run -d \
  -e CLOUDFLARE_API_TOKEN=xxx \
  -e CLOUDFLARE_API_TOKEN_2=xxx \
  -v /etc/localtime:/etc/localtime:ro \
  city-gate-cron
```

## GitHub Secrets

| Secret | 说明 | 是否必须 |
|--------|------|---------|
| `CLOUDFLARE_API_TOKEN` | 账户1 API Token（需 Zone:Edit + DNS:Edit + SSL/Certs:Edit + WAF:Edit） | 是 |
| `CLOUDFLARE_API_TOKEN_2` | 账户2 API Token（同上权限） | 是 |
| `CLOUDFLARE_ACCOUNT_ID` | 账户1 Account ID（Pages 部署用） | 是 |
| `CLOUDFLARE_ACCOUNT_ID_2` | 账户2 Account ID | 否 |

**华为云 DNS（可选）：**

| Secret | 说明 | 是否必须 |
|--------|------|--------|
| `HUAWEICLOUD_DNS_AK` | 华为云 Access Key Id | 使用华为云 DNS 时必须 |
| `HUAWEICLOUD_DNS_SK` | 华为云 Secret Access Key | 使用华为云 DNS 时必须 |
| `HUAWEICLOUD_DNS_ENDPOINT` | DNS Endpoint（默认 https://dns.myhuaweicloud.com） | 否 |

> 以下 Secrets 仅 Worker 回退模式需要（当前架构不使用）：
> - `KV_IP2REGION_NAMESPACE_ID` / `KV_IP2REGION_NAMESPACE_ID_2`

## 回退方案

如 SaaS 方案出问题，可回退到 Worker 模式：

1. CI 重新部署 Worker（代码保留在 `workers/` 目录）
2. `sync-dns.js` 改为 `sync-cname.js`（CNAME 模式）
3. 删除 SaaS Custom Hostnames
4. 恢复 Worker 路由

回退时间预估：< 10 分钟。

## 环境变量

| 变量 | 说明 |
|------|------|
| `CLOUDFLARE_API_TOKEN` | 账户1 API Token |
| `CLOUDFLARE_API_TOKEN_2` | 账户2 API Token |
| `DRY_RUN` | 1=仅预览不执行 |
| `ZONE_CONFIG_JSON` | 覆盖 wrangler.toml 配置 |
| `IP_PER_ZONE` | 每 zone 分配的 A 记录 IP 数量（默认 2） |
| `IP_DEDUP_PREFIX` | IP 去重前缀长度（默认 /24） |
| `SPEED_TEST_SOURCE` | 测速源：`worker`=自有 Worker 代理（默认）/ `official`=直连 speed.cloudflare.com / 其他=自定义 URL |
| `SPEED_TEST_SOURCE_URL` | 自定义测速源 URL（`SPEED_TEST_SOURCE` 非 worker/official 时使用） |
| `HUAWEICLOUD_DNS_AK` | 华为云 Access Key Id（可选） |
| `HUAWEICLOUD_DNS_SK` | 华为云 Secret Access Key（可选） |
| `HUAWEICLOUD_DNS_ENDPOINT` | DNS Endpoint（默认 https://dns.myhuaweicloud.com） |

> AI生成