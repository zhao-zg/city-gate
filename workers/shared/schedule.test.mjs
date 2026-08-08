/**
 * schedule.js 测试
 * 运行：node workers/shared/schedule.test.js
 *
 * 使用 Node.js 内置 assert 模块，无外部依赖。
 * 通过动态 import() 加载 ESM 模块（项目 package.json 无 type:module）。
 */

import { parseTime, isInOpenSchedule } from './schedule.mjs';
import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

// ── parseTime ────────────────────────────────────────

test('parseTime("09:30") → 570', () => {
  assert.strictEqual(parseTime('09:30'), 570);
});

test('parseTime("00:00") → 0', () => {
  assert.strictEqual(parseTime('00:00'), 0);
});

test('parseTime("23:59") → 1439', () => {
  assert.strictEqual(parseTime('23:59'), 1439);
});

test('parseTime("24:00") → 1440 (全天终点)', () => {
  assert.strictEqual(parseTime('24:00'), 1440);
});

test('parseTime("24:01") → throws Error', () => {
  assert.throws(() => parseTime('24:01'), Error);
});

test('parseTime("invalid") → throws Error', () => {
  assert.throws(() => parseTime('invalid'), Error);
});

test('parseTime("25:00") → throws Error', () => {
  assert.throws(() => parseTime('25:00'), Error);
});

// ── isInOpenSchedule ─────────────────────────────────

// 上海时区辅助：构造 UTC Date 使得上海为指定时间
// new Date("2026-01-07T10:00+08:00") → 正确的 UTC 时间点
function shanghaiDate(isoLocal) {
  return new Date(isoLocal + '+08:00');
}

test('days=[1-5] periods=["09:00-18:00"] Wed 10:00 → true', () => {
  const now = shanghaiDate('2026-01-07T10:00'); // Wed
  assert.strictEqual(
    isInOpenSchedule({ days: [1, 2, 3, 4, 5], periods: ['09:00-18:00'] }, now),
    true,
  );
});

test('days=[1-5] periods=["09:00-18:00"] Wed 07:00 → false', () => {
  const now = shanghaiDate('2026-01-07T07:00'); // Wed
  assert.strictEqual(
    isInOpenSchedule({ days: [1, 2, 3, 4, 5], periods: ['09:00-18:00'] }, now),
    false,
  );
});

test('days=[1-5] periods=["09:00-18:00"] Sat 10:00 → false', () => {
  const now = shanghaiDate('2026-01-10T10:00'); // Sat
  assert.strictEqual(
    isInOpenSchedule({ days: [1, 2, 3, 4, 5], periods: ['09:00-18:00'] }, now),
    false,
  );
});

test('multi-period: Wed 13:00 (gap 12:00-14:00) → false', () => {
  const now = shanghaiDate('2026-01-07T13:00'); // Wed
  assert.strictEqual(
    isInOpenSchedule({ days: [1, 2, 3, 4, 5], periods: ['09:00-12:00', '14:00-18:00'] }, now),
    false,
  );
});

test('multi-period: Wed 15:00 (in second period) → true', () => {
  const now = shanghaiDate('2026-01-07T15:00'); // Wed
  assert.strictEqual(
    isInOpenSchedule({ days: [1, 2, 3, 4, 5], periods: ['09:00-12:00', '14:00-18:00'] }, now),
    true,
  );
});

test('only days, no periods: Wed 10:00 → true (all day)', () => {
  const now = shanghaiDate('2026-01-07T10:00'); // Wed
  assert.strictEqual(
    isInOpenSchedule({ days: [1, 2, 3, 4, 5] }, now),
    true,
  );
});

test('only periods, no days: Sun 10:00 → true (all week)', () => {
  const now = shanghaiDate('2026-01-11T10:00'); // Sun
  assert.strictEqual(
    isInOpenSchedule({ periods: ['09:00-18:00'] }, now),
    true,
  );
});

test('empty schedule: Wed 10:00 → true', () => {
  const now = shanghaiDate('2026-01-07T10:00');
  assert.strictEqual(isInOpenSchedule({}, now), true);
});

test('periods=["00:00-24:00"] = 全天开放', () => {
  const now = shanghaiDate('2026-01-07T03:00'); // Wed 03:00
  assert.strictEqual(
    isInOpenSchedule({ periods: ['00:00-24:00'] }, now),
    true,
  );
});
// America/New_York in January = EST (UTC-5)
// 2026-01-05 is Monday

test('timezone NY: UTC Mon 14:00 = NY 09:00 → true', () => {
  const now = new Date('2026-01-05T14:00:00Z'); // UTC Mon 14:00 = NY Mon 09:00 EST
  assert.strictEqual(
    isInOpenSchedule(
      { timezone: 'America/New_York', days: [1], periods: ['09:00-17:00'] },
      now,
    ),
    true,
  );
});

test('timezone NY: UTC Mon 22:00 = NY 17:00 → false (end boundary excluded)', () => {
  const now = new Date('2026-01-05T22:00:00Z'); // UTC Mon 22:00 = NY Mon 17:00 EST
  assert.strictEqual(
    isInOpenSchedule(
      { timezone: 'America/New_York', days: [1], periods: ['09:00-17:00'] },
      now,
    ),
    false,
  );
});

// ── Summary ──────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
