---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'ff0f8472-16ec-4f4a-87c2-3aa067242e04'
  PropagateID: 'ff0f8472-16ec-4f4a-87c2-3aa067242e04'
  ReservedCode1: '1433034a-9cbf-46a6-86c9-e5869fe03318'
  ReservedCode2: '1433034a-9cbf-46a6-86c9-e5869fe03318'
---

# 实现计划：去 Worker 化重构

> 日期：2026-08-14
> 设计文档：`docs/plans/2026-08-14-pages-direct-design.md`

## Task 概览

| # | 任务 | 文件 | 预计时间 |
|---|------|------|---------|
| 1 | 创建 setup-saas.js | `scripts/setup-saas.js` | 5 min |
| 2 | 创建 setup-firewall.js | `scripts/setup-firewall.js` | 5 min |
| 3 | 改造 deploy.yml | `.github/workflows/deploy.yml` | 5 min |
| 4 | 更新 Dockerfile | `docker/Dockerfile` | 2 min |
| 5 | 更新 README.md | `README.md` | 5 min |
| 6 | 清理 wrangler.generated.toml | `workers/city-gate*/wrangler.generated.toml` | 1 min |

---

## Task 1: 创建 setup-saas.js

**文件:** `scripts/setup-saas.js`

**目标:** 自动化配置 CF for SaaS — Fallback Origin + Custom Hostnames

**实现:**

1. 复用 sync-cname.js 的 `autoDetectZoneMap()` 和 `parseDomainConfig()` 提取 zone + prefix + origin
2. 对每个 zone:
   a. 查询 zone ID（复用 `getZoneId()`）
   b. 创建/更新 Fallback Origin DNS 记录：`proxy-fallback.{zone}` → `A 192.0.2.1` (proxied=true)
   c. 设置 Fallback Origin（CF API: `PUT /zones/{zone_id}/custom_hostnames/fallback_origin`）
   d. 等待 Fallback Origin 状态 Active（轮询，超时 30s）
3. 对每个 FQDN (prefix.zone):
   a. 从 wrangler.toml 提取对应的 `origin`（如 `https://sg-f3b.pages.dev`）
   b. 创建 Custom Hostname（CF API: `POST /zones/{zone_id}/custom_hostnames`）
      - `hostname`: FQDN（如 `sg.1189.dpdns.org`）
      - `custom_origin`: origin 域名（如 `sg-f3b.pages.dev`）
      - `ssl.method`: `http` (自动证书)
   c. 如果 Custom Hostname 已存在 → 跳过（检查 status=active）
   d. 等待 Custom Hostname 状态 Active（轮询，超时 60s）
4. 输出汇总报告

**API 端点:**
- `GET /zones/{zone_id}/custom_hostnames/fallback_origin` — 查询当前 Fallback Origin
- `PUT /zones/{zone_id}/custom_hostnames/fallback_origin` — 设置 Fallback Origin
- `GET /zones/{zone_id}/custom_hostnames` — 列出 Custom Hostnames
- `POST /zones/{zone_id}/custom_hostnames` — 创建 Custom Hostname
- `DELETE /zones/{zone_id}/custom_hostnames/{id}` — 删除 Custom Hostname

**环境变量:**
- `CLOUDFLARE_API_TOKEN` — 账户1 Token（需 Zone:Edit + SSL and Certificates:Edit 权限）
- `CLOUDFLARE_API_TOKEN_2` — 账户2 Token
- `DRY_RUN` — 1=仅预览
- `ZONE_CONFIG_JSON` — 可选，覆盖 wrangler.toml 配置

**多账户支持:** 复用 sync-cname.js 的 `WORKER_TOKEN_KEYS` 映射和 `getToken()` 函数

**验证:** `DRY_RUN=1 node scripts/setup-saas.js` 输出配置计划不执行

---

## Task 2: 创建 setup-firewall.js

**文件:** `scripts/setup-firewall.js`

**目标:** 自动化配置 WAF Custom Rules — 地理围栏 + 时段控制

**实现:**

1. 复用 `autoDetectZoneMap()` 提取 zone + prefix 配置
2. 从 DOMAIN_CONFIG_JSON 提取需要 Firewall 规则的 group:
   - `cities` 非 ALL → 地理围栏规则
   - `schedule` 存在 → 时段控制规则
3. 对每个需要规则的 zone:
   a. 查询现有 WAF Custom Rules（`GET /zones/{zone_id}/rulesets/phases/http_request_firewall_custom/entrypoint`）
   b. 构建规则表达式:
      - 地理围栏: `(hostname eq "{fqdn}") and (ip.geo.subdivision ne "{province}")` → Block
      - 时段控制: `(hostname eq "{fqdn}") and not (cf.clock.hour >= {start} and cf.clock.hour < {end})` → Block
   c. 创建/更新 WAF Ruleset（`PUT /zones/{zone_id}/rulesets/phases/http_request_firewall_custom/entrypoint`）
4. 输出汇总报告

**API 端点:**
- `GET /zones/{zone_id}/rulesets/phases/http_request_firewall_custom/entrypoint` — 查询当前规则集
- `PUT /zones/{zone_id}/rulesets/phases/http_request_firewall_custom/entrypoint` — 更新规则集

**规则表达式示例:**

bible 地理围栏（账户2, zhaozg.de5.net zone）:
```
(hostname eq "bible.zhaozg.de5.net") and (ip.geo.subdivision ne "Zhejiang")
→ action: block
```

books 时段控制（所有 zone）:
```
(hostname eq "books.1189.dpdns.org") and not (cf.clock.hour >= 1 and cf.clock.hour < 22)
→ action: block
```

**注意:**
- CF 免费 WAF Custom Rules 限 5 条/zone
- 当前仅需 2 条（bible 围栏 + books 时段），远在限制内
- `ip.geo.subdivision` 返回 ISO 3166-2 代码（如 "Zhejiang"）
- `cf.clock.hour` 使用 UTC 时间，需要转换（books schedule 01:00-22:00 Asia/Shanghai = 17:00-14:00 UTC，跨日）
  - 实际上 schedule periods "01:00-22:00" 在 Asia/Shanghai 时区
  - UTC 偏移 +8h，01:00 CST = 17:00 UTC（前一天），22:00 CST = 14:00 UTC
  - 规则: `not (cf.clock.hour >= 17 or cf.clock.hour < 14)` → 不在开放时段
  - 更简洁: 开放时段 = 17:00-23:59 UTC + 00:00-14:00 UTC = 全天，不对
  - 正确: 01:00-22:00 CST = 17:00 UTC（前日）到 14:00 UTC（当日）= 跨日
  - 规则: Block when NOT in 01:00-22:00 CST
  - Block when: cf.clock.hour < 1 or cf.clock.hour >= 22 (in CST)
  - 但 cf.clock 是 UTC，需要用 `cf.clock.hour` 配合时区转换
  - **替代方案**: 不用 cf.clock，改用 Docker cron 定时 enable/disable Firewall Rule
  - 或者直接用 schedule 的 UTC 等效时间

  **最终决定**: schedule 时段控制改由 Docker 容器定时 enable/disable WAF rule 实现。setup-firewall.js 只负责创建规则（默认 disabled），Docker entrypoint 新增一个模式定时切换。

  这样更可靠：
  - setup-firewall.js 创建 WAF rule (disabled)
  - Docker 容器按 schedule 定时调用 CF API enable/disable 该 rule
  - 规则只做 Block，不做时间判断

  简化后 WAF 规则:
  ```
  (hostname eq "books.1189.dpdns.org")
  → action: block
  ```
  Docker 定时 enable/disable。

**验证:** `DRY_RUN=1 node scripts/setup-firewall.js` 输出规则计划不执行

---

## Task 3: 改造 deploy.yml

**文件:** `.github/workflows/deploy.yml`

**改动:**

1. 删除 Job:
   - `update-xdb-1`
   - `update-xdb-2`
   - `deploy-account-1`（Worker 部署）
   - `deploy-account-2`（Worker 部署）

2. 新增 Job:
   - `setup-saas-1`: 账户1 SaaS 配置
   - `setup-saas-2`: 账户2 SaaS 配置
   - `setup-firewall-1`: 账户1 Firewall 配置
   - `setup-firewall-2`: 账户2 Firewall 配置

3. 保留 Job:
   - `deploy-pages` (cxapk Pages 部署)
   - `deploy-pages-2`
   - `deploy-summary` (更新 needs 列表)

4. workflow_dispatch inputs 更新:
   - 删除 `update_xdb` 参数
   - 删除 `worker` 参数
   - 保留 `accounts` 参数

5. schedule 触发: 保留每周一定时（跑 SaaS + Firewall 配置幂等检查）

**Job 依赖:**
```
setup-saas-1 ─┐
setup-saas-2 ─┤
setup-firewall-1 ─┤
setup-firewall-2 ─┤
deploy-pages ─┤
deploy-pages-2 ─┤
               └→ deploy-summary
```

**验证:** `yamllint .github/workflows/deploy.yml` 语法检查

---

## Task 4: 更新 Dockerfile

**文件:** `docker/Dockerfile`

**改动:**
- 删除 `COPY workers/ ./workers/` 行（不再需要 Worker 代码在容器中）
- 保留 `COPY scripts/ ./scripts/` 和 `COPY package.json ./`
- 环境变量不变

**验证:** Docker 构建成功

---

## Task 5: 更新 README.md

**文件:** `README.md`

**改动:**
- 更新架构说明：去掉 Worker，改为 CF for SaaS + A 记录直连
- 更新部署流程：SaaS 配置 → Firewall 配置 → DNS 同步 → Pages 部署
- 保留 Worker 回退说明
- 更新 GitHub Secrets 列表（标注哪些不再需要）

**验证:** 文档可读性检查

---

## Task 6: 清理 wrangler.generated.toml

**文件:**
- `workers/city-gate/wrangler.generated.toml`
- `workers/city-gate-2/wrangler.generated.toml`

**改动:**
- 删除这两个文件（CI 不再生成，Worker 不再部署）
- 确保 `.gitignore` 中已有 `*.generated.toml`（如果还没有则添加）

**验证:** `git status` 确认文件已删除

---

## 执行顺序

```
Task 1 (setup-saas.js) ──┐
Task 2 (setup-firewall.js) ─┤
                           ├──→ Task 3 (deploy.yml) ──→ Task 4 (Dockerfile) ──→ Task 5 (README) ──→ Task 6 (清理)
                           │
Task 1 和 Task 2 可并行执行
```

## 验证清单

- [ ] `DRY_RUN=1 node scripts/setup-saas.js` 输出正确
- [ ] `DRY_RUN=1 node scripts/setup-firewall.js` 输出正确
- [ ] deploy.yml 语法正确
- [ ] Dockerfile 构建成功
- [ ] README 内容准确
- [ ] wrangler.generated.toml 已删除
- [ ] git diff 无遗漏