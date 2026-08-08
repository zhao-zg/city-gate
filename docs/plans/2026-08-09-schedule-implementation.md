---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '27c1a681-a3e8-4f21-896d-57dd9be31443'
  PropagateID: '27c1a681-a3e8-4f21-896d-57dd9be31443'
  ReservedCode1: '43365ec7-395e-4ff5-866b-98298738c05f'
  ReservedCode2: '43365ec7-395e-4ff5-866b-98298738c05f'
---

# 实现计划：域名组开放时间段（Schedule）

设计文档：`docs/plans/2026-08-09-schedule-design.md`

---

## Task 1: 创建 schedule.js 模块 + 测试

**目标**: 新建 `workers/shared/schedule.js`，实现 `isInOpenSchedule()` 和 `parseTime()`，并编写测试。

**文件**:
- 新建 `workers/shared/schedule.js`
- 新建 `workers/shared/schedule.test.js`

**测试用例**:
1. `parseTime("09:30")` → 570
2. `parseTime("00:00")` → 0
3. `parseTime("23:59")` → 1439
4. `parseTime("invalid")` → 抛错
5. `isInOpenSchedule({ days: [1,2,3,4,5], periods: ["09:00-18:00"] }, 周三 10:00)` → true
6. `isInOpenSchedule({ days: [1,2,3,4,5], periods: ["09:00-18:00"] }, 周三 07:00)` → false
7. `isInOpenSchedule({ days: [1,2,3,4,5], periods: ["09:00-18:00"] }, 周六 10:00)` → false
8. `isInOpenSchedule({ days: [1,2,3,4,5], periods: ["09:00-12:00","14:00-18:00"] }, 周三 13:00)` → false
9. `isInOpenSchedule({ days: [1,2,3,4,5], periods: ["09:00-12:00","14:00-18:00"] }, 周三 15:00)` → true
10. `isInOpenSchedule({ days: [1,2,3,4,5] }, 周三 10:00)` → true（无 periods=全天）
11. `isInOpenSchedule({ periods: ["09:00-18:00"] }, 周日 10:00)` → true（无 days=全周）
12. `isInOpenSchedule({}, 周三 10:00)` → true（空 schedule=全开）
13. 时区测试：`{ timezone: "America/New_York", days: [1], periods: ["09:00-17:00"] }` UTC 14:00（纽约09:00）→ true
14. 时区测试：同上，UTC 22:00（纽约17:00）→ false

**实现要点**:
- `parseTime(hhmm)`: 解析 `HH:MM` 为当天分钟数（0-1439）
- `isInOpenSchedule(schedule, now?)`:
  - `now` 默认 `new Date()`，测试时注入
  - 用 `Intl.DateTimeFormat('en-US', { timeZone: schedule.timezone || 'Asia/Shanghai', weekday: 'narrow', hour: 'numeric', minute: 'numeric', hour12: false })` 获取本地化日期
  - 判断 `days`（用 `weekday` 1=Mon…7=Sun 映射）
  - 判断 `periods`（用 `hour:minute` 转分钟数比较）

**验证**: `node workers/shared/schedule.test.js` 全部通过

---

## Task 2: 新增 denySchedulePage() 到 deny-page.js

**目标**: 在 `workers/shared/deny-page.js` 中新增 `denySchedulePage()` 函数，供非开放时段返回 403。

**文件**:
- 修改 `workers/shared/deny-page.js`

**要点**:
- 风格与现有 `denyPage()` 一致（渐变背景+毛玻璃卡片）
- 不显示具体开放时间
- 提示文案："当前非开放时段，暂无法访问"
- 无需 IP、地区等调试信息

**验证**: 检查函数导出、HTML 结构完整

---

## Task 3: 修改 city-gate/worker.js 集成 schedule

**目标**: 在地理围栏判断前插入 schedule 检查。

**文件**:
- 修改 `workers/city-gate/worker.js`

**改动**:
1. 新增 import: `import { isInOpenSchedule } from '../shared/schedule.js';`
2. 在配置展开阶段，确保 `schedule` 字段被传递到 `domainMap` 中
3. 在步骤 2（查找域名配置）之后、步骤 3（cities ALL 放行）之前，插入 schedule 检查：
```js
// 2.5 schedule 时间判断（优先于地理围栏）
if (domainCfg.schedule) {
  if (!isInOpenSchedule(domainCfg.schedule)) {
    return new Response(denySchedulePage(), {
      status: 403,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}
```

**验证**: 配置中有 schedule 的域名组在非开放时段返回 403；无 schedule 的域名组行为不变

---

## Task 4: 修改 city-gate-2/worker.js 集成 schedule

**目标**: 同 Task 3，但修改容灾版 Worker。

**文件**:
- 修改 `workers/city-gate-2/worker.js`

**改动**: 同 Task 3，import + 配置展开传递 schedule + 插入检查逻辑

**验证**: 同 Task 3

---

## Task 5: 更新 validate-config.js 校验 schedule 字段

**目标**: 配置校验脚本支持 schedule 字段校验。

**文件**:
- 修改 `scripts/validate-config.js`

**校验规则**:
- `schedule.timezone` 必须是合法 IANA 时区（尝试 `Intl.DateTimeFormat(undefined, { timeZone: value })` 不抛错）
- `schedule.days` 元素必须是 1-7 整数
- `schedule.periods` 元素必须是 `HH:MM-HH:MM` 格式，且 end > start

**验证**: 故意写入非法配置，校验脚本报错

---

## Task 6: 更新 wrangler.toml 示例配置

**目标**: 在 city-gate 的 wrangler.toml 中为 books 域名组添加 schedule 示例配置。

**文件**:
- 修改 `workers/city-gate/wrangler.toml`

**示例**:
```json
{
  "prefix": "books",
  "origin": "https://books-em3.pages.dev",
  "cities": ["杭州", "Hangzhou"],
  "provinces": ["浙江", "Zhejiang"],
  "schedule": {
    "days": [1, 2, 3, 4, 5],
    "periods": ["09:00-22:00"]
  }
}
```

**验证**: `node scripts/validate-config.js` 通过

---

## 执行顺序

1 → 2 → 3 → 4 → 5 → 6（串行，每步 TDD）