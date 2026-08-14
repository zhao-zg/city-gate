---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'c974f917-8f0d-4b19-bb20-cd2c0d7a56fe'
  PropagateID: 'c974f917-8f0d-4b19-bb20-cd2c0d7a56fe'
  ReservedCode1: '98aac054-c0e3-4e70-87eb-bb5d33ef8bc0'
  ReservedCode2: '98aac054-c0e3-4e70-87eb-bb5d33ef8bc0'
---

# A 记录直连方案设计

> 日期：2026-08-14
> 状态：待确认

## 1. 背景与动机

### 当前 CNAME 模式的问题

```
sg.1189.dpdns.org → CNAME cf.090227.xyz → CNAME cf.hw.090227.xyz → CNAME openai.com.cdn.cloudflare.net → A 172.64.153.208
```

- CNAME 链经过**不受控的第三方域名**，随时可能 CNAME 到触发验证码的域名（如 `openai.com`）
- 优选域名被回收/换 IP/指向变化，完全被动
- 国内用户可能命中 Cloudflare WAF 挑战页（验证码），而海外 CI 检测不到
- 多一跳 DNS 解析，增加延迟

### A 记录模式的优势

```
sg.1189.dpdns.org → A 172.64.152.241（自己验证过的 CF 边缘 IP）
sg.1189.dpdns.org → A 104.18.35.15
```

- 完全受控，只写自己验证过的 IP
- 消除 CNAME 链不确定性
- 少一跳 DNS，解析更快
- 国内 Docker 检测环境与用户环境一致，检测即真实体验

## 2. 设计决策

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 每 FQDN A 记录数 | **2 条** | 冗余够用，检测快 |
| 同 zone IP 分配 | **共享 IP 组** | 同 zone 内 7 个 FQDN 共用 2 个 IP，减少 IP 需求 |
| CNAME 兼容 | **纯 A 记录** | 删除 CNAME 逻辑，代码简洁 |
| IP 来源 | **解析 CNAME_POOL + cfIpTop20 补充** | 复用现有池，补充来源丰富 |
| IP 质量检测 | **延迟 + 1034 + 挑战页** | 不仅检测可用性，还测响应速度 |

## 3. 架构设计

### 3.1 整体流程

```
                    ┌─────────────────────────┐
                    │   IP 收集阶段            │
                    │  CNAME_POOL 解析 IP      │
                    │  + cfIpTop20 补充        │
                    │  + 多 DNS 解析器收集     │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │   IP 质量检测阶段         │
                    │  1. 1034 错误检测        │
                    │  2. 挑战页(验证码)检测    │
                    │  3. 延迟测量(TCP握手)     │
                    │  4. 逐 IP 用自家域名验证  │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │   IP 排序与选取           │
                    │  按延迟排序              │
                    │  去重（同段 IP 只取1个）  │
                    │  取 Top N（N=zone数×2）  │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │   Zone 分配              │
                    │  每 zone 分 2 个 IP      │
                    │  不同 zone 尽量分散      │
                    │  noPreferred zone 跳过   │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │   DNS 同步               │
                    │  对比现有 A 记录          │
                    │  删除旧/创建新/跳过不变   │
                    │  CNAME → A 记录迁移      │
                    └─────────────────────────┘
```

### 3.2 IP 质量评分

每个候选 IP 检测三个维度：

| 维度 | 检测方式 | 权重 | 硬判定 |
|------|---------|------|--------|
| 1034 错误 | 响应体含 `error code: 1034` | — | 任一 IP 触发 → 淘汰 |
| 挑战页 | 响应体含 CF 挑战页特征 | — | 任一 IP 触发 → 淘汰 |
| 连接延迟 | TCP 握手耗时 (ms) | 排序用 | 超时 → 淘汰 |

通过 1034 + 挑战页检测的 IP 才算可用，延迟用于排序选优。

### 3.3 IP 去重策略

避免选到同一 CIDR 段的 IP（同段 IP 同时挂的概率高）：

```
172.64.152.241 和 172.64.152.242 → 同 /24 段，只取延迟更低的一个
172.64.152.241 和 104.18.35.15  → 不同段，都保留
```

规则：按 /24 前缀去重，同段只保留延迟最低的 IP。

### 3.4 Zone 分配策略

```
6 个需要 A 记录的 zone（排除 noPreferred）：
  zone-0: 1189.dpdns.org     → IP-A, IP-B
  zone-1: zhaozg.dpdns.org   → IP-C, IP-D
  zone-2: 1189.de5.net       → IP-E, IP-F
  zone-3: zzg.cc.cd          → IP-A, IP-C  ← 轮转复用
  zone-4: 1189.kdns.fr       → IP-B, IP-D
  zone-5: zhaozg.de5.net     → IP-E, IP-F
```

- 需要 `zoneCount × 2` 个 IP，但如果 IP 池不够，允许跨 zone 复用
- 不同 zone 尽量分到不同 IP，实现容灾
- 同 zone 内所有 FQDN 共享这 2 个 IP

### 3.5 DNS 记录同步逻辑

对每个 FQDN：
1. 查询现有 DNS 记录（A + CNAME）
2. 如果存在 CNAME 记录 → **删除 CNAME**（迁移到 A 记录）
3. 对比现有 A 记录与目标 IP 列表：
   - 已存在且匹配 → 跳过
   - 已存在但不匹配 → 删除多余的，创建缺少的
   - 不存在 → 创建

### 3.6 增量更新策略

为避免每次运行都全量换 IP（DNS 缓存抖动）：

- 如果当前 A 记录的 IP 仍然可用（通过检测） → **保留不动**
- 只有当当前 IP 不可用时才替换
- 替换时优先选延迟最低的可用 IP

## 4. 环境变量设计

新增环境变量（向后兼容）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `RECORD_MODE` | `a` | `a`=A记录模式, `cname`=CNAME模式(兼容) |
| `IP_PER_ZONE` | `2` | 每 zone 分配几个 IP |
| `IP_DEDUP_PREFIX` | `/24` | IP 去重的前缀长度 |
| `IP_LATENCY_TIMEOUT` | `4000` | IP 延迟检测超时(ms) |
| `IP_MIN_POOL` | `12` | IP 池最小可用数量(6 zone × 2) |

## 5. 文件改动范围

### 5.1 新增

- `scripts/sync-dns.js` — 新主脚本，A 记录模式
  - 复用 sync-cname.js 的: `resolveIps`, `testIp1034`, `isChallengePage`, `autoDetectZoneMap`, `getZoneId`, `getDnsRecords`, `cfFetch`, `deleteDnsRecord`, `fetchCfIpTop20`
  - 新增: `measureLatency`, `dedupIps`, `buildIpPool`, `assignIpsToZones`, `createARecord`, `processARecords`

### 5.2 修改

- `docker/Dockerfile` — 默认脚本改为 `sync-dns.js`
- `docker/entrypoint.sh` — 默认脚本改为 `sync-dns.js`
- `docker/.env.example` — 新增 `IP_PER_ZONE` 等变量
- `.github/workflows/sync-cname.yml` — workflow 改名/新增，调用新脚本

### 5.3 保留不动

- `scripts/sync-cname.js` — 保留原文件，作为 CNAME 模式 fallback
- `scripts/check-cname.js` — 保留原文件
- `workers/` — Worker 代码不变，只读 wrangler.toml

## 6. Docker 部署

```yaml
# docker/.env
RECORD_MODE=a           # A 记录模式
IP_PER_ZONE=2           # 每 zone 2 个 IP
CRON_SCHEDULE=0 */6 * * *  # 每 6 小时
CLOUDFLARE_API_TOKEN=xxx
```

国内服务器部署后，定时从国内环境检测 IP 质量，自动更新 DNS A 记录。

## 7. 风险与缓解

| 风险 | 缓解 |
|------|------|
| CF 边缘 IP 变不可用 | 定时检测 + 自动替换 |
| IP 池不够 | cfIpTop20 自动补充 |
| DNS 缓存导致切换慢 | TTL 设为 1（自动）|
| 误删所有 A 记录 | 增量更新，只删不匹配的，先建后删 |
| 迁移期 CNAME 和 A 冲突 | 先删 CNAME 再建 A 记录 |

## 8. 待确认

1. noPreferred zone 是否也改 A 记录直连源站 IP？（当前方案保持原样，直连源站）
2. 是否需要在 IP 替换时发通知？
3. CI（GitHub Actions）是否也切换到新脚本，还是只在国内 Docker 跑？