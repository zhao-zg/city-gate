---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '3589a442-bf56-4c7a-ba59-362fbdc6e5dd'
  PropagateID: '3589a442-bf56-4c7a-ba59-362fbdc6e5dd'
  ReservedCode1: '3483df74-b653-4b90-90f7-aebf6cc3ca41'
  ReservedCode2: '3483df74-b653-4b90-90f7-aebf6cc3ca41'
---

# 域名组开放时间段（Schedule）功能设计

## 需求

在每个域名组（group）上新增可选的 `schedule` 字段，控制：
- 一周哪几天开放（周一到周日）
- 每天哪几个时段开放（支持多时段，如 09:00-12:00 + 14:00-18:00）
- 默认时区：Asia/Shanghai（UTC+8）
- 未配置 schedule 的域名组：全天候开放（向后兼容）

## 配置格式

```json
{
  "prefix": "books",
  "origin": "https://books-em3.pages.dev",
  "cities": ["杭州", "Hangzhou"],
  "provinces": ["浙江", "Zhejiang"],
  "schedule": {
    "timezone": "Asia/Shanghai",
    "days": [1, 2, 3, 4, 5],
    "periods": ["09:00-12:00", "14:00-18:00"]
  }
}
```

| 字段 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `schedule.timezone` | string | IANA 时区 | `"Asia/Shanghai"` (UTC+8) |
| `schedule.days` | number[] | 开放日，1=周一…7=周日 | 未配置=全周开放 |
| `schedule.periods` | string[] | 开放时段，`HH:MM-HH:MM` | 未配置=全天开放 |

### 边界规则

- `schedule` 缺失或为 `null`：全天候开放（向后兼容）
- `days` 缺失或空数组：视为全周开放
- `periods` 缺失或空数组：视为全天 00:00-24:00
- `days` 和 `periods` 同时存在：当天且在时段内才放行
- 仅配 `days` 无 `periods`：指定日全天开放
- 仅配 `periods` 无 `days`：每天在指定时段开放
- 时段跨午夜（如 `22:00-06:00`）：不支持，配置校验时拒绝（end <= start 视为无效）

## 架构：方案 B — 独立 schedule 模块

### 新增文件

- `workers/shared/schedule.js` — 时间判断模块（可独立测试、city-gate/city-gate-2 复用）

### 判断流程

```
请求进入 → 查找域名组配置
  → 有 schedule 且 schedule 配置了 days 或 periods？
     ├─ 否 → 沿用原逻辑（地理围栏）
     └─ 是 → isInOpenSchedule(schedule, now)？
              ├─ 否 → 403（非开放时段）
              └─ 是 → 沿用原逻辑（地理围栏）
```

时间判断在地理围栏之前。未到开放时段直接返回 403，无需查 IP。

### schedule.js 模块 API

```js
/**
 * 判断当前时间是否在开放时段内
 * @param {object} schedule - { timezone, days, periods }
 * @param {Date} [now] - 可选，用于测试注入
 * @returns {boolean}
 */
export function isInOpenSchedule(schedule, now) { ... }

/**
 * 解析 HH:MM 为分钟数
 * @param {string} hhmm
 * @returns {number}
 */
export function parseTime(hhmm) { ... }
```

### 403 页面

非开放时段的 403 使用独立的提示页面，不显示具体开放时间信息。
在 `deny-page.js` 中新增 `denySchedulePage()` 函数，风格与现有 403 保持一致。

### worker.js 改动

在地理围栏判断之前，插入 schedule 检查：

```js
// 新增：schedule 时间判断（优先于地理围栏）
if (domainCfg.schedule) {
  const scheduleCheck = isInOpenSchedule(domainCfg.schedule);
  if (!scheduleCheck) {
    return new Response(denySchedulePage(), {
      status: 403,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}
```

### 配置校验

在 `scripts/validate-config.js` 中新增 schedule 字段校验：
- `days` 元素必须是 1-7 的整数
- `periods` 元素必须是 `HH:MM-HH:MM` 格式
- `periods` 的结束时间必须大于开始时间

## 不做什么

- 不支持跨午夜时段（如 22:00-06:00），简化逻辑
- 403 页面不显示具体开放时间
- 不支持节假日特殊配置