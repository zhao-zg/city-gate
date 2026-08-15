/**
 * ⚠ DEPRECATED — 本文件已废弃（2026-08-15）
 * 原因：Worker 重构为透明传输模式，不再使用时段控制。
 * 保留仅供历史参考。
 *
 * 域名组开放时间段判断模块
 *
 * @module schedule
 */

/**
 * 解析 "HH:MM" 格式字符串为当天分钟数
 * @param {string} hhmm — 如 "09:30"
 * @returns {number} 分钟数 0-1440（24:00=1440）
 * @throws {Error} 格式非法或数值越界
 */
export function parseTime(hhmm) {
  if (typeof hhmm !== 'string') {
    throw new Error(`Invalid time format: ${hhmm}`);
  }
  const m = hhmm.match(/^(\d{2}):(\d{2})$/);
  if (!m) {
    throw new Error(`Invalid time format: ${hhmm}`);
  }
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  // 允许 24:00 作为终值（全天终点），其余 24:xx 非法
  if (hour === 24 && minute === 0) {
    return 1440;
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid time format: ${hhmm}`);
  }
  return hour * 60 + minute;
}

/** 周英文缩写 → 1(周一)…7(周日) */
const DAY_MAP = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/**
 * 判断当前时间是否在开放时段内
 * @param {object} schedule — { timezone?, days?, periods? }
 * @param {Date} [now] — 可选，用于测试注入，默认 new Date()
 * @returns {boolean}
 */
export function isInOpenSchedule(schedule, now) {
  now = now || new Date();
  const tz = schedule.timezone || 'Asia/Shanghai';

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now);

  const get = (type) => parts.find((p) => p.type === type)?.value;

  const weekday = DAY_MAP[get('weekday')];
  const hour = parseInt(get('hour'), 10);
  const minute = parseInt(get('minute'), 10);
  // hour12:false 下 24:xx 表示午夜，归零
  const currentMinutes = (hour === 24 ? 0 : hour) * 60 + minute;

  // days 检查：配置了且当前日不在列表 → 关闭
  const days = schedule.days;
  if (days && days.length > 0 && !days.includes(weekday)) {
    return false;
  }

  // periods 检查：配置了且当前时间不在任何时段 → 关闭
  const periods = schedule.periods;
  if (periods && periods.length > 0) {
    let inPeriod = false;
    for (const period of periods) {
      const [start, end] = period.split('-');
      if (currentMinutes >= parseTime(start) && currentMinutes < parseTime(end)) {
        inPeriod = true;
        break;
      }
    }
    if (!inPeriod) return false;
  }

  return true;
}
