---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '4f8cd1c2-15d6-4d8d-9413-72757d7ba71f'
  PropagateID: '4f8cd1c2-15d6-4d8d-9413-72757d7ba71f'
  ReservedCode1: 'd0d32f16-aeaa-4ec1-919a-15ec7ea298a3'
  ReservedCode2: 'd0d32f16-aeaa-4ec1-919a-15ec7ea298a3'
---

# 动态 TOKEN_MAP 设计：支持任意多 CF 账户

> 日期: 2026-08-20
> 状态: 已确认
> 触发: 新增华为云 zone 11891189.xyz（CF 账户3，华为云同一账户）

## 背景

当前系统支持两个 CF 账户（default / account2），通过硬编码 `TOKEN_MAP` 映射 tokenKey → 环境变量。
用户需要新增第三个 CF 账户（account3）用于 zone 11891189.xyz，每次加账户都要改代码。

## 目标

将 `getToken()` 改为约定式映射，支持任意 `accountN` → `CLOUDFLARE_API_TOKEN_N`，无需改代码。

## 设计

### 约定式映射规则

```
tokenKey          → 环境变量
─────────────────────────────────────
"default"         → CLOUDFLARE_API_TOKEN
"account2"        → CLOUDFLARE_API_TOKEN_2
"account3"        → CLOUDFLARE_API_TOKEN_3
"accountN"        → CLOUDFLARE_API_TOKEN_N
```

tokenKey 格式必须为 `default` 或 `accountN`（N 为正整数）。

### 改动点

#### 1. sync-cname.js — getToken()（第 837-846 行）

当前：
```js
const TOKEN_MAP = {
  default: process.env.CLOUDFLARE_API_TOKEN,
  account2: process.env.CLOUDFLARE_API_TOKEN_2,
};
```

改为动态查找：
```js
function getToken(tokenKey) {
  const key = tokenKey || 'default';
  let token;
  if (key === 'default') {
    token = process.env.CLOUDFLARE_API_TOKEN;
  } else {
    // accountN → CLOUDFLARE_API_TOKEN_N
    const match = key.match(/^account(\d+)$/);
    if (!match) throw new Error(`无效 tokenKey: ${key}（格式应为 default 或 accountN）`);
    token = process.env[`CLOUDFLARE_API_TOKEN_${match[1]}`];
  }
  if (!token) throw new Error(`API Token 未设置 (key: ${key})`);
  return token;
}
```

#### 2. cleanup-worker-routes.js — getToken()（第 26-37 行）

同上逻辑。但保留 `WRANGLER_OAUTH_TOKEN` 优先：
```js
function getToken(tokenKey) {
  const key = tokenKey || 'default';
  let token;
  if (key === 'default') {
    token = process.env.WRANGLER_OAUTH_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  } else {
    const match = key.match(/^account(\d+)$/);
    if (!match) throw new Error(`无效 tokenKey: ${key}`);
    token = process.env[`CLOUDFLARE_API_TOKEN_${match[1]}`];
  }
  if (!token) throw new Error(`API Token 未设置 (key: ${key})`);
  return token;
}
```

#### 3. check-dns.js — hasToken()（第 24-26 行）

当前只检测两个 Token，改为扫描所有 `CLOUDFLARE_API_TOKEN*`：
```js
function hasToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return true;
  for (let i = 2; i <= 20; i++) {
    if (process.env[`CLOUDFLARE_API_TOKEN_${i}`]) return true;
  }
  return false;
}
```

#### 4. Docker 配置透传

| 文件 | 改动 |
|------|------|
| `.env.example` | 新增 `CLOUDFLARE_API_TOKEN_3=` |
| `docker-compose.yml` | 新增 `CLOUDFLARE_API_TOKEN_3` 透传行 |
| `Dockerfile` | ENV 预留 `CLOUDFLARE_API_TOKEN_3=""` |

#### 5. wrangler.toml — 新增 zone

```json
{ "name": "11891189.xyz", "dnsProvider": "huaweicloud", "tokenKey": "account3", "ispSources": {
  "telecom": "ct.877774.xyz",
  "unicom": "cu.877774.xyz",
  "mobile": "cmcc.877774.xyz"
}}
```

### 不改动的部分

- `WORKER_TOKEN_KEYS`（第 51-54 行）：Docker 模式走 ZONE_CONFIG_JSON 覆盖，不读 Worker 映射
- `setup-firewall.js` / `setup-saas.js`：调用 `sc.getToken()`，自动受益
- `sync-dns.js`：调用 `sc.getToken()`，自动受益

### 向后兼容

- `default` → `CLOUDFLARE_API_TOKEN`（不变）
- `account2` → `CLOUDFLARE_API_TOKEN_2`（不变）
- 新增 `accountN` 自动映射，无上限

## 风险

| 风险 | 缓解 |
|------|------|
| tokenKey 格式错误（如拼写 `acount3`） | 正则校验 + 明确报错信息 |
| 忘记在 .env / compose 中设置 TOKEN_3 | 报错信息含 key 和 env 变量名 |
| Docker 镜像未透传 TOKEN_3 | compose/Dockerfile 同步更新 |