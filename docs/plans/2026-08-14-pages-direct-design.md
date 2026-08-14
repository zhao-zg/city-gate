---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '9c01889e-0435-468f-8e11-a39d180eead2'
  PropagateID: '9c01889e-0435-468f-8e11-a39d180eead2'
  ReservedCode1: '16520e3d-8007-478e-9b7e-531a00cbe55c'
  ReservedCode2: '16520e3d-8007-478e-9b7e-531a00cbe55c'
---

# 去 Worker 化重构：CF for SaaS + A 记录直连优选 IP

> 日期：2026-08-14
> 状态：已确认
> 技能：superpowers (Brainstorming → Plan → Build)

## 1. 背景与动机

### 当前架构的问题

```
用户 → DNS(A记录/CNAME) → CF边缘IP → Worker路由 → Worker运行(IP围栏+schedule)
     → fetch Pages源站 → 返回
```

- **Worker 是多余跳板**：7 个 group 中 6 个 `cities: ["ALL"]`，Worker 仅做纯反代
- **冷启动延迟**：ip2region 从 KV 加载 xdb，冷启动 50-200ms
- **CPU/内存限制**：Worker 50ms CPU / 128MB，高并发易超限
- **双重计费**：Worker 请求 + Pages 请求
- **复杂性高**：ip2region KV、schedule 模块、地理围栏代码维护成本高

### 目标架构

```
用户 → DNS A记录 → CF边缘IP(优选) → CF for SaaS Custom Hostname 路由
     → Fallback Origin(CNAME→pages.dev, proxied) → Origin Rule 重写Host → Pages 返回
```

- 零 Worker、零 KV、零冷启动
- A 记录直连优选 IP（sync-dns.js 已实现）
- CF for SaaS 免费 100 个 Custom Hostnames
- Origin Rules 免费 10 条/zone
- Firewall Rules 替代地理围栏 + schedule

## 2. 已确认决策

| 决策项 | 选择 | 理由 |
|--------|------|------|
| Worker 去留 | **保留代码不部署** | 保留可回退能力，CI 删除部署步骤 |
| 地理围栏 | **CF Firewall Rules** | `ip.geo.subdivision` 省级过滤，免费 |
| Schedule 时段 | **CF Firewall Rules** | 时间条件规则，免费 |
| DNS 方案 | **A 记录直连 IP** | sync-dns.js 已实现，完全受控 |
| Docker 容器 | **保留** | 继续定时同步 DNS |
| SaaS 配置 | **两账户各自独立** | 与当前架构一致 |
| Firewall 配置 | **CI 自动配置** | CF API 自动创建/更新规则 |
| Pages 绑定 | **CF for SaaS** | Custom Hostnames + Origin Rules |

## 3. 技术方案

### 3.1 CF for SaaS 配置流程（每账户一次性）

```
                    ┌──────────────────────────────────────┐
                    │  一次性配置（每账户）                  │
                    │                                      │
                    │  1. 创建 Fallback Origin DNS 记录     │
                    │     A proxy-fallback → 192.0.2.1      │
                    │     (proxied=true, 占位IP)             │
                    │                                      │
                    │  2. 设置 Fallback Origin               │
                    │     SSL/TLS → Custom Hostnames        │
                    │     → Fallback Origin = proxy-fallback│
                    │     .{zone}                           │
                    │                                      │
                    │  3. 为每个 FQDN 创建 Custom Hostname  │
                    │     sg.1189.dpdns.org                 │
                    │     books.1189.dpdns.org              │
                    │     bible.1189.dpdns.org              │
                    │     ... (7 prefix × N zone)            │
                    │     每个 Custom Hostname 指定         │
                    │     custom_origin = {prefix}-{hash}   │
                    │     .pages.dev                        │
                    │                                      │
                    │  4. 为每个 prefix 创建 Origin Rule     │
                    │     匹配: hostname == {prefix}.{zone}  │
                    │     动作: Host header → {prefix}-{hash}│
                    │     .pages.dev                        │
                    │                                      │
                    │  5. DNS A 记录指向优选 IP              │
                    │     sync-dns.js 自动管理               │
                    │     (proxied=false)                   │
                    └──────────────────────────────────────┘
```

### 3.2 请求路由链路

```
用户请求 sg.1189.dpdns.org
  ↓ DNS 解析
  A 记录 → 104.18.35.15 (优选IP, proxied=false)
  ↓
  用户直连 104.18.35.15:443
  Host: sg.1189.dpdns.org
  SNI: sg.1189.dpdns.org
  ↓ CF Edge 收到请求
  1. 查 Custom Hostnames 表 → sg.1189.dpdns.org 匹配
     → custom_origin = sg-f3b.pages.dev
  2. Origin Rule 匹配 hostname == sg.1189.dpdns.org
     → 重写 Host header 为 sg-f3b.pages.dev
  3. Fallback Origin (proxy-fallback.{zone}, proxied=true)
     → CF 内部路由到 Pages 项目 sg-f3b
  ↓
  Pages 返回内容 → 用户
```

### 3.3 配置来源

仍然从 `wrangler.toml` 的 `DOMAIN_CONFIG_JSON` 提取所有配置：

```toml
[vars]
DOMAIN_CONFIG_JSON = """
{
  "zones": ["1189.dpdns.org", "zhaozg.dpdns.org", ...],
  "groups": [
    {
      "prefix": "sg",
      "origin": "https://sg-f3b.pages.dev",
      "cities": ["ALL"]
    },
    {
      "prefix": "bible",
      "origin": "https://bible-2o8.pages.dev",
      "cities": ["杭州"],
      "provinces": ["浙江"],
      "schedule": { "days": [1,2,3,4,5,6,7], "periods": ["01:00-22:00"] }
    }
  ]
}
"""
```

`cities`、`provinces`、`schedule` 字段不再被 Worker 使用，但保留作为 **Firewall Rules 配置来源**——CI 脚本读取这些字段自动创建对应的 Firewall Rules。

### 3.4 新增脚本

| 脚本 | 功能 |
|------|------|
| `scripts/setup-saas.js` | CF for SaaS 配置脚本：创建 Fallback Origin、Custom Hostnames、Origin Rules |
| `scripts/setup-firewall.js` | Firewall Rules 配置脚本：地理围栏 + 时段控制 |

### 3.5 改动文件清单

#### 新增
- `scripts/setup-saas.js` — SaaS Custom Hostnames + Origin Rules 自动配置
- `scripts/setup-firewall.js` — Firewall Rules 自动配置

#### 修改
- `.github/workflows/deploy.yml` — 删除 Worker 部署 Job，新增 SaaS/Firewall 配置 Job
- `docker/Dockerfile` — 移除 workers/ 拷贝（不再需要）
- `docker/entrypoint.sh` — 默认脚本改为 sync-dns.js（已经是）
- `README.md` — 更新架构说明

#### 保留不动
- `workers/` — 保留代码不部署
- `scripts/sync-dns.js` — A 记录同步（已实现）
- `scripts/sync-cname.js` — CNAME 模式 fallback
- `scripts/check-cname.js` — 检测脚本
- `scripts/generate-routes.js` — 保留（Worker 回退时可用）
- `scripts/validate-config.js` — 保留
- `scripts/update-ip2region.js` — 保留（Worker 回退时可用）
- `scripts/obfuscate-cxapk.js` — 保留
- `pages/cxapk/` — 保留

#### 可删除（CI 不再调用）
- `workers/city-gate/wrangler.generated.toml` — CI 不再生成
- `workers/city-gate-2/wrangler.generated.toml` — CI 不再生成

### 3.6 CI/CD 改造

**删除的 Job：**
- `update-xdb-1` — 不再需要 ip2region KV
- `update-xdb-2` — 同上
- `deploy-account-1` — 不再部署 Worker
- `deploy-account-2` — 同上

**保留的 Job：**
- `deploy-pages` — 仍需部署 cxapk Pages
- `deploy-pages-2` — 同上
- `deploy-summary` — 汇总

**新增的 Job：**
- `setup-saas-1` — 账户1 SaaS 配置（Custom Hostnames + Origin Rules）
- `setup-saas-2` — 账户2 SaaS 配置
- `setup-firewall-1` — 账户1 Firewall Rules
- `setup-firewall-2` — 账户2 Firewall Rules

**Docker 容器不变：**
- 继续定时跑 sync-dns.js 同步 A 记录
- Dockerfile 移除 workers/ 拷贝即可

### 3.7 Firewall Rules 设计

**地理围栏（bible.zhaozg.de5.net）：**
```
规则名: bible-geo-restrict
匹配: (hostname eq "bible.zhaozg.de5.net") and (ip.geo.subdivision ne "Zhejiang")
动作: Block
```

**时段控制（books.*）：**
CF 免费 Firewall Rules 不直接支持时间条件。替代方案：
- 方案 A: 用 Cloudflare Rules 的 "Cron Triggers" + Worker 做开关（但又要 Worker）
- 方案 B: 用 CF API 定时更新 Firewall Rule 状态（Docker cron 定时 enable/disable）
- **方案 C: 放弃时段控制**（books 全天开放）

> 注：CF Firewall Rules 的 `cf.clock` 字段在 WAF custom rules 中可用（免费版 5 条），但语法为 `cf.clock.hour >= 1 and cf.clock.hour < 22`。

**最终方案：** 用 WAF Custom Rules（免费版 5 条规则）：
```
规则名: books-schedule
匹配: (hostname eq "books.1189.dpdns.org") and not (cf.clock.hour >= 1 and cf.clock.hour < 22)
动作: Block
```

### 3.8 SaaS Custom Hostname 的 custom_origin 机制

每个 Custom Hostname 可以指定 `custom_origin`，这样不需要 Origin Rule 重写 Host：

```
Custom Hostname: sg.1189.dpdns.org
  → custom_origin: sg-f3b.pages.dev
```

请求到达 CF Edge 后，SaaS 层直接路由到 `sg-f3b.pages.dev`，Pages 看到的 Host 是 `sg-f3b.pages.dev`，无需 Origin Rule。

**但如果 Custom Hostname 没有指定 custom_origin**，则走 Fallback Origin，需要 Origin Rule 重写 Host。

**选择：** 使用 `custom_origin` 参数，避免需要 Origin Rules。每个 Custom Hostname 直接指定对应的 `*.pages.dev` 源站。

这样整个链路简化为：
```
用户 → A记录 → CF边缘IP → SaaS Custom Hostname(custom_origin=sg-f3b.pages.dev)
     → Pages 返回
```

不需要 Fallback Origin（设为占位即可），不需要 Origin Rules。

### 3.9 多 Zone 的 Fallback Origin 问题

CF for SaaS 的 Fallback Origin 是 zone 级别的。每个 zone 需要自己的 Fallback Origin：

```
proxy-fallback.1189.dpdns.org → A 192.0.2.1 (proxied=true)
proxy-fallback.zhaozg.dpdns.org → A 192.0.2.1 (proxied=true)
proxy-fallback.1189.de5.net → A 192.0.2.1 (proxied=true)
...
```

每个 zone 一个 Fallback Origin DNS 记录 + 一个 Fallback Origin 设置。Custom Hostname 的 `custom_origin` 可以跨 zone 指向任意 `*.pages.dev`。

## 4. 数据流总结

```
                    ┌─────────────────────────────┐
                    │  wrangler.toml               │
                    │  DOMAIN_CONFIG_JSON          │
                    │  (zones + groups 配置)        │
                    └──────────┬──────────────────┘
                               │
                    ┌──────────▼──────────────────┐
                    │  setup-saas.js (CI 一次性)    │
                    │  读取 DOMAIN_CONFIG_JSON      │
                    │  → 创建 Fallback Origin        │
                    │  → 创建 Custom Hostnames       │
                    │    (custom_origin=*.pages.dev) │
                    └──────────────────────────────┘

                    ┌─────────────────────────────┐
                    │  setup-firewall.js (CI 一次性)│
                    │  读取 DOMAIN_CONFIG_JSON      │
                    │  → 创建 WAF Custom Rules       │
                    │    (地理围栏 + 时段控制)       │
                    └──────────────────────────────┘

                    ┌─────────────────────────────┐
                    │  sync-dns.js (Docker 定时)   │
                    │  读取 wrangler.toml           │
                    │  → 收集优选 IP                │
                    │  → 检测 1034/挑战页/延迟      │
                    │  → 同步 A 记录                │
                    └──────────────────────────────┘

                    ┌─────────────────────────────┐
                    │  deploy-pages (CI 推送时)    │
                    │  → 部署 cxapk Pages           │
                    └──────────────────────────────┘
```

## 5. 风险与缓解

| 风险 | 缓解 |
|------|------|
| SaaS 配置失败导致全部不可用 | 保留 Worker 代码可回退；setup-saas.js 先 dry-run |
| Custom Hostname 证书签发慢 | CF 内部域名自动验证，通常秒级 |
| Fallback Origin 状态不 Active | 脚本轮询等待 Active，超时告警 |
| Firewall Rules 超过 5 条限制 | 当前仅需 2 条（bible 围栏 + books 时段） |
| A 记录 IP 全部失效 | sync-dns.js 增量更新 + 池自动补充 |
| Pages 源站不可用 | 多账户 Pages 互为备份 |

## 6. 回退方案

如果 SaaS 方案出问题：
1. CI 重新部署 Worker（代码保留）
2. sync-dns.js 改为 sync-cname.js（CNAME 模式）
3. 删除 SaaS Custom Hostnames
4. 恢复 Worker 路由

回退时间预估：< 10 分钟。