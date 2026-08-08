const fs = require('fs');
const path = require('path');

/**
 * 校验 schedule 字段
 * @param {object} schedule
 * @param {string} prefix - 用于错误提示的域名组标识
 * @returns {string[]} 错误信息数组
 */
function validateSchedule(schedule, prefix) {
  const errors = [];
  if (!schedule || typeof schedule !== 'object') return errors;

  // 校验 timezone
  if (schedule.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: schedule.timezone });
    } catch {
      errors.push(`${prefix}: schedule.timezone "${schedule.timezone}" 不是合法 IANA 时区`);
    }
  }

  // 校验 days
  if (schedule.days !== undefined) {
    if (!Array.isArray(schedule.days)) {
      errors.push(`${prefix}: schedule.days 必须是数组`);
    } else {
      for (const d of schedule.days) {
        if (!Number.isInteger(d) || d < 1 || d > 7) {
          errors.push(`${prefix}: schedule.days 元素必须是 1-7 整数，得到 ${d}`);
        }
      }
    }
  }

  // 校验 periods
  if (schedule.periods !== undefined) {
    if (!Array.isArray(schedule.periods)) {
      errors.push(`${prefix}: schedule.periods 必须是数组`);
    } else {
      for (const p of schedule.periods) {
        const match = p.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
        if (!match) {
          errors.push(`${prefix}: schedule.periods 元素格式错误 "${p}"，应为 HH:MM-HH:MM`);
        } else {
          const [, sh, sm, eh, em] = match.map(Number);
          const startMin = sh * 60 + sm;
          const endMin = eh * 60 + em;
          if (endMin <= startMin) {
            errors.push(`${prefix}: schedule.periods "${p}" 结束时间必须大于开始时间`);
          }
          // 24:00 仅允许作为终值
          const startValid = sh <= 23 && sm <= 59;
          const endValid = (eh === 24 && em === 0) || (eh <= 23 && em <= 59);
          if (!startValid || !endValid) {
            errors.push(`${prefix}: schedule.periods "${p}" 包含无效时间值`);
          }
        }
      }
    }
  }

  return errors;
}

for (const dir of ['workers/city-gate', 'workers/city-gate-2', 'workers/cxapk', 'workers/cxapk-2']) {
  const file = path.join(dir, 'wrangler.toml');
  if (!fs.existsSync(file)) { console.log(file, '-> 不存在'); continue; }
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/DOMAIN_CONFIG_JSON\s*=\s*"""([\s\S]*?)"""/);
  if (!m) { console.log(file, '-> 未找到 DOMAIN_CONFIG_JSON'); continue; }
  try {
    const config = JSON.parse(m[1]);
    let groups = [];
    let format = '';

    if (config.zones && Array.isArray(config.groups)) {
      groups = config.groups;
      format = 'zones+prefixes';
    } else if (Array.isArray(config)) {
      groups = config;
      format = '域名组数组';
    } else {
      console.log(file, '-> 未知格式');
      continue;
    }

    // 基本信息输出
    const domainCount = groups.reduce((sum, g) => {
      const zones = g.zones || config.zones || [];
      return sum + (zones.length || (g.domains || []).length);
    }, 0);
    console.log(file, '->', format, '格式, 分组数:', groups.length, '域名数:', domainCount);

    // 校验 schedule
    let hasErrors = false;
    for (const g of groups) {
      if (!g.schedule) continue;
      const prefix = g.prefix || g.domains?.[0] || 'unknown';
      const errs = validateSchedule(g.schedule, prefix);
      for (const e of errs) {
        console.error('  ERROR:', e);
        hasErrors = true;
      }
    }
    if (hasErrors) {
      console.log(file, '-> schedule 校验失败!');
    }
  } catch (e) {
    console.log(file, '-> JSON 非法:', e.message);
  }
}
