---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '7388272c-0591-4cfd-a4c5-7d745a0f98e0'
  PropagateID: '7388272c-0591-4cfd-a4c5-7d745a0f98e0'
  ReservedCode1: 'ce8392e3-d1f4-49f7-89ce-268ca1d03a68'
  ReservedCode2: 'ce8392e3-d1f4-49f7-89ce-268ca1d03a68'
---

# 华为云三网分线路 — 域名 DNS 解析 IP 源

**日期**: 2026-08-18
**状态**: 已批准

## 概述

在华为云 zone 级别支持通过**域名 DNS 解析**获取三网分线路 IP，替代/补充现有 `cf.090227.xyz` HTTP API。

## 配置格式

在 `wrangler.toml` 的 zone 配置中新增 `ispSources` 字段：

```json
{
  "name": "zzgxxx.eu.org",
  "dnsProvider": "huaweicloud",
  "ispSources": {
    "telecom": "ct.example.com",
    "unicom": "cu.example.com",
    "mobile": "cmcc.example.com",
    "default": "def.example.com"
  }
}
```

- `ispSources.telecom` → 电信线路 IP 源域名（必填）
- `ispSources.unicom` → 联通线路 IP 源域名（必填）
- `ispSources.mobile` → 移动线路 IP 源域名（必填）
- `ispSources.default` → 默认线路 IP 源域名（**可选**，留空自动合并三网 IP 去重）

未配置 `ispSources` 的华为云 zone → 自动回退到现有 `cf.090227.xyz` HTTP API。

## 数据流

```
Zone 配置了 ispSources
  ├─ 对每个线路域名调用 sc.resolveIps(domain)
  │    └─ 4 个公共 DNS × 3 轮交叉收集（绕过本地缓存）
  ├─ 1034 验证（is1034Ip 快速短路 + testIp1034 真实验证）
  ├─ 截取 ISP_IP_PER_LINE 个
  ├─ default 留空 → 三网 IP 去重合并
  └─ 写入华为云 DNS 分线路 A 记录（复用 processHwIspRecords 后半段）

Zone 未配置 ispSources
  └─ fetchIspIps() → 现有 cf.090227.xyz HTTP API（完全不变）
```

## 实现任务

### Task 1: sync-cname.js — buildZoneMapFromConfig 解析 ispSources

**文件**: `scripts/sync-cname.js`
**修改位置**: `buildZoneMapFromConfig()` 第 190-234 行

在 zone 对象构建时，从 zone 配置中提取 `ispSources` 字段并传递：

```javascript
// 在 zoneInfo 初始化时（第 203 行附近）
info = { noPreferred: false, origins: {}, tokenKey: zoneTokenKey, dnsProvider: zoneDnsProv || DNS_PROVIDER_CF, ispSources: null };

// 在 zone 属性赋值时（第 208 行附近）
if (typeof zone === 'object' && zone.ispSources) info.ispSources = zone.ispSources;

// 在 zones.push 时（第 222 行附近）
zones.push({
  zoneName,
  names,
  tokenKey: info.tokenKey || tokenKey,
  dnsProvider: info.dnsProvider || DNS_PROVIDER_CF,
  ...(info.ispSources ? { ispSources: info.ispSources } : {}),
  // ...其余字段不变
});
```

**验证**: 读 wrangler.toml 带 ispSources 的 zone 配置，确认 zone 对象有 ispSources 字段。

### Task 2: fetch-isp-ips.js — 新增 fetchIspIpsByDns()

**文件**: `scripts/fetch-isp-ips.js`
**修改位置**: 文件末尾新增函数 + 导出

新增函数接收域名组配置，用 `sc.resolveIps()` 解析各线路 IP：

```javascript
/**
 * 通过 DNS 解析域名获取三网分线路 IP
 *
 * 与 fetchIspIps()（HTTP API）不同，本函数直接解析域名 A 记录获取 IP。
 * 适用于任何提供三网分线路 DNS 服务的域名（不依赖 cf.090227.xyz API）。
 *
 * @param {Object} ispSources - 域名组配置
 * @param {string} ispSources.telecom - 电信线路域名（必填）
 * @param {string} ispSources.unicom - 联通线路域名（必填）
 * @param {string} ispSources.mobile - 移动线路域名（必填）
 * @param {string} [ispSources.default] - 默认线路域名（可选，留空自动合并三网 IP 去重）
 * @param {number} perLine - 每条线路取几个 IP（默认 ISP_IP_PER_LINE）
 * @returns {Promise<{telecom: string[], unicom: string[], mobile: string[], default: string[]}>}
 */
async function fetchIspIpsByDns(ispSources, perLine = ISP_IP_PER_LINE) {
  const sc = require('./sync-cname');
  // ... 解析每个域名，返回与 fetchIspIps() 相同格式
}
```

关键逻辑：
1. 对 telecom/unicom/mobile 三个域名分别调用 `sc.resolveIps(domain)` 收集 IP
2. `default` 域名存在则也 resolveIps，留空则合并三网 IP 去重
3. 每条线路截取 `perLine` 个
4. 返回 `{ telecom, unicom, mobile, default }` 格式

导出新增 `fetchIspIpsByDns`。

**验证**: 传入测试域名组，确认返回格式与 `fetchIspIps()` 一致。

### Task 3: sync-dns.js — processHwIspRecords 支持 per-zone ispSources

**文件**: `scripts/sync-dns.js`
**修改位置**: `processHwIspRecords()` 第 974-1060 行

核心改造：从统一的 `fetchIspIps()` 改为 per-zone 的 IP 拉取。

**3a. 修改函数签名，接收 zoneMap 而非 hwAssignments**:

当前 `processHwIspRecords(hwAssignments, testHost)` 按 zoneName 分组 hwAssignments。
改造后需要 per-zone 拉取 IP，因此需要传入 zone 级别的 ispSources 配置。

方案：hwAssignments 中每个 assignment 携带 `ispSources` 字段（在 Task 4 中由 assignIpsToZones 注入），processHwIspRecords 按 zoneName 分组后从同一组的任一 assignment 读取 ispSources。

**3b. 修改 IP 拉取逻辑（第 991-998 行）**:

```javascript
// 旧：统一拉取一次三网 IP
const ispIps = await fetchIspIps(ISP_FETCH_COUNT);

// 新：per-zone 拉取，不同 zone 可有不同 IP 来源
// 按 zoneName 分组后，每组取第一个 assignment 的 ispSources
```

改造为在 `for (const [zoneName, group] of Object.entries(zoneGroups))` 循环内，根据 ispSources 决定 IP 来源：
- 有 `ispSources` → `fetchIspIpsByDns(ispSources, ISP_FETCH_COUNT)`
- 无 `ispSources` → `fetchIspIps(ISP_FETCH_COUNT)`（回退 HTTP API）

**3c. 1034 验证 + 截取 + default 合并逻辑不变**:

第 1000-1060 行的 1034 验证、截取、default 合并逻辑完全复用，只是 `ispIps` 变量来源从全局改为 per-zone。

**3d. zone 循环结构调整**:

当前结构是「全局拉取 IP → 1034 验证 → 遍历 zone 写入」。改造为「遍历 zone → per-zone 拉取 IP → 1034 验证 → 写入」，因为不同 zone 的 IP 来源不同。

但要注意：1034 验证逻辑（第 1000-1060 行）需要移到 zone 循环内部。同时 `lineConfig`（第 1063-1068 行）也需要在 zone 循环内部构建。

**验证**: DRY_RUN 模式运行，确认有 ispSources 的 zone 走 DNS 解析、无的回退 HTTP API。

### Task 4: assignIpsToZones — 传递 ispSources

**文件**: `scripts/sync-dns.js`
**修改位置**: `assignIpsToZones()` 第 892-905 行（华为云 zone assignment 构建）

```javascript
// 旧
for (const zone of zoneMap) {
  if (zone.dnsProvider !== 'huaweicloud' || zone.noPreferred) continue;
  for (const name of zone.names) {
    assignments.push({
      fqdn: `${name}.${zone.zoneName}`,
      zoneName: zone.zoneName,
      name,
      tokenKey: zone.tokenKey,
      dnsProvider: 'huaweicloud',
      ips: [],
    });
  }
}

// 新：增加 ispSources 传递
for (const zone of zoneMap) {
  if (zone.dnsProvider !== 'huaweicloud' || zone.noPreferred) continue;
  for (const name of zone.names) {
    assignments.push({
      fqdn: `${name}.${zone.zoneName}`,
      zoneName: zone.zoneName,
      name,
      tokenKey: zone.tokenKey,
      dnsProvider: 'huaweicloud',
      ips: [],
      ...(zone.ispSources ? { ispSources: zone.ispSources } : {}),
    });
  }
}
```

**验证**: 确认 hwAssignments 中华为云 zone 的 assignment 携带 ispSources。

### Task 5: wrangler.toml 示例配置 + 端到端测试

**文件**: `workers/city-gate/wrangler.toml`

在华为云 zone 配置中添加 ispSources 示例（用户填入实际域名）。

端到端测试：
1. `DRY_RUN=1 node scripts/sync-dns.js` — 验证预览模式正常运行
2. 确认有 ispSources 的 zone 走 DNS 解析路径
3. 确认无 ispSources 的 zone 回退 HTTP API
4. 确认 1034 验证 + 写入逻辑正常

## 不做的事

- 不修改 `fetchIspIps()` 原有函数（保持 HTTP API 逻辑不变）
- 不修改 `processHwIspRecords` 后半段写入逻辑（1034 验证后部分完全复用）
- 不增加新的环境变量（配置走 wrangler.toml）
- 不引入多域名组交叉收集（一组 4 个域名够用）