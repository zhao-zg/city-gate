#!/usr/bin/env node
/**
 * Cloudflare WAF Custom Rules 配置脚本（多账户版）
 *
 * 自动化配置 WAF Custom Rules：
 *   1. 地理围栏规则：cities/provinces 非 ALL 的 group → Block 非指定省份的请求
 *   2. 时段控制规则：有 schedule 的 group → 创建 Block 规则（默认 disabled）
 *      时段开关由 Docker 容器定时调用 CF API enable/disable 实现
 *
 * 配置来源：workers/ 下的 wrangler.toml 中的 DOMAIN_CONFIG_JSON
 *   cities/provinces 字段 → 地理围栏规则
 *   schedule 字段 → 时段控制规则（默认 disabled，Docker 定时切换）
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN   — 账户1 Token（需 Zone WAF:Edit 权限）
 *   CLOUDFLARE_API_TOKEN_2 — 账户2 Token
 *   TOKEN_KEY（可选）       — 只处理指定 tokenKey 的 zone（'default' 或 'account2'），不设则全部处理
 *   DRY_RUN（可选）        — 设为 1 则只预览不执行
 *   ZONE_CONFIG_JSON（可选）— 覆盖 wrangler.toml 配置
 *
 * 用法：
 *   node scripts/setup-firewall.js             # 执行配置
 *   DRY_RUN=1 node scripts/setup-firewall.js   # 预览模式
 */

const sc = require('./sync-cname');

const CF_API = 'https://api.cloudflare.com/client/v4';

// 省名 → ISO 3166-2 代码映射（CF Ruleset Engine 使用 ip.src.subdivision_1_iso_code）
// 注意：CF 返回的是 ISO 3166-2 代码（如 "CN-ZJ"），不是英文省份名
// 参考: https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/ip.src.subdivision_1_iso_code/
const PROVINCE_CN_TO_CODE = {
  '浙江': 'CN-ZJ',
  '江苏': 'CN-JS',
  '广东': 'CN-GD',
  '北京': 'CN-BJ',
  '上海': 'CN-SH',
  '山东': 'CN-SD',
  '河南': 'CN-HA',
  '河北': 'CN-HE',
  '四川': 'CN-SC',
  '湖北': 'CN-HB',
  '湖南': 'CN-HN',
  '福建': 'CN-FJ',
  '安徽': 'CN-AH',
  '江西': 'CN-JX',
  '辽宁': 'CN-LN',
  '陕西': 'CN-SN',
  '重庆': 'CN-CQ',
  '天津': 'CN-TJ',
  '广西': 'CN-GX',
  '黑龙江': 'CN-HL',
  '吉林': 'CN-JL',
  '云南': 'CN-YN',
  '贵州': 'CN-GZ',
  '甘肃': 'CN-GS',
  '内蒙古': 'CN-NM',
  '新疆': 'CN-XJ',
  '海南': 'CN-HI',
  '宁夏': 'CN-NX',
  '青海': 'CN-QH',
  '西藏': 'CN-XZ',
  '山西': 'CN-SX',
  '香港': 'CN-HK',
  '澳门': 'CN-MO',
  '台湾': 'CN-TW',
  // 兼容英文写法（配置中可能同时包含中文和英文）
  'Zhejiang': 'CN-ZJ',
  'Jiangsu': 'CN-JS',
  'Guangdong': 'CN-GD',
  'Beijing': 'CN-BJ',
  'Shanghai': 'CN-SH',
  'Shandong': 'CN-SD',
  'Henan': 'CN-HA',
  'Hebei': 'CN-HE',
  'Sichuan': 'CN-SC',
  'Hubei': 'CN-HB',
  'Hunan': 'CN-HN',
  'Fujian': 'CN-FJ',
  'Anhui': 'CN-AH',
  'Jiangxi': 'CN-JX',
  'Liaoning': 'CN-LN',
  'Shaanxi': 'CN-SN',
  'Chongqing': 'CN-CQ',
  'Tianjin': 'CN-TJ',
  'Guangxi': 'CN-GX',
  'Heilongjiang': 'CN-HL',
  'Jilin': 'CN-JL',
  'Yunnan': 'CN-YN',
  'Guizhou': 'CN-GZ',
  'Gansu': 'CN-GS',
  'Nei Mongol': 'CN-NM',
  'Xinjiang': 'CN-XJ',
  'Hainan': 'CN-HI',
  'Ningxia': 'CN-NX',
  'Qinghai': 'CN-QH',
  'Xizang': 'CN-XZ',
  'Shanxi': 'CN-SX',
  'Hong Kong': 'CN-HK',
  'Macao': 'CN-MO',
  'Taiwan': 'CN-TW',
};

const dryRun = process.env.DRY_RUN === '1';

// ── 工具函数 ──────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function cfApi(path, options = {}) {
  const tokenKey = options.tokenKey || 'default';
  const token = sc.getToken(tokenKey);

  const { tokenKey: _, ...fetchOptions } = options;
  const res = await fetch(`${CF_API}${path}`, {
    ...fetchOptions,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...fetchOptions.headers,
    },
  });

  const json = await res.json();
  if (!json.success) {
    const err = json.errors?.map(e => e.message).join('; ') || '未知错误';
    throw new Error(`Cloudflare API 错误: ${err} (path: ${path})`);
  }
  return json;
}

// ── WAF Ruleset 操作 ─────────────────────────────────

/**
 * 获取 zone 的 WAF Custom Rules 入口 ruleset
 */
async function getCustomRuleset(zoneId, tokenKey) {
  const json = await cfApi(`/zones/${zoneId}/rulesets/phases/http_request_firewall_custom/entrypoint`, { tokenKey });
  return json.result;
}

/**
 * 更新 zone 的 WAF Custom Rules 入口 ruleset
 * rules 格式: [{ expression, action, description, enabled, ... }]
 */
async function putCustomRuleset(zoneId, rulesetId, rules, tokenKey) {
  const body = {
    rules: rules.map(r => ({
      expression: r.expression,
      action: r.action,
      description: r.description,
      enabled: r.enabled,
      ...r.logging ? { logging: r.logging } : {},
    })),
  };
  const json = await cfApi(`/zones/${zoneId}/rulesets/${rulesetId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
    tokenKey,
  });
  return json.result;
}

/**
 * 创建 WAF Custom Rules 入口 ruleset（首次配置）
 */
async function createCustomRuleset(zoneId, rules, tokenKey) {
  const body = {
    name: 'default',
    kind: 'zone',
    phase: 'http_request_firewall_custom',
    rules: rules.map(r => ({
      expression: r.expression,
      action: r.action,
      description: r.description,
      enabled: r.enabled,
    })),
  };
  const json = await cfApi(`/zones/${zoneId}/rulesets`, {
    method: 'POST',
    body: JSON.stringify(body),
    tokenKey,
  });
  return json.result;
}

// ── 配置解析 ─────────────────────────────────────────

/**
 * 从 wrangler.toml 提取需要 Firewall 规则的配置
 * 返回 [{ zoneName, tokenKey, rules: [{ type, fqdn, expression, action, description, enabled }] }]
 */
function buildFirewallConfig() {
  const fs = require('fs');
  const path = require('path');

  // 从环境变量或 wrangler.toml 获取完整配置
  // 需要保留 Worker 名（目录名）以正确映射 tokenKey
  let allConfigs = [];
  if (process.env.ZONE_CONFIG_JSON) {
    const parsed = JSON.parse(process.env.ZONE_CONFIG_JSON);
    allConfigs = Array.isArray(parsed) ? parsed : [parsed];
  } else {
    const workersDir = path.join(__dirname, '..', 'workers');
    const dirs = fs.readdirSync(workersDir)
      .filter(name => fs.existsSync(path.join(workersDir, name, 'wrangler.toml')));
    for (const dir of dirs) {
      const tomlText = fs.readFileSync(path.join(workersDir, dir, 'wrangler.toml'), 'utf8');
      const config = sc.parseDomainConfig(tomlText);
      if (config) {
        // 用 Worker 名映射 tokenKey（与 autoDetectZoneMap 逻辑一致）
        const workerName = sc.parseWorkerName(tomlText) || dir;
        const tokenKey = sc.WORKER_TOKEN_KEYS[workerName] || 'default';
        allConfigs.push({ config, tokenKey });
      }
    }
  }

  // 按 tokenKey 分组的 zone 配置
  // { tokenKey: { zoneName: [{ prefix, origin, cities, provinces, schedule }] } }
  const zoneConfigs = {};

  for (const entry of allConfigs) {
    // 环境变量方式：entry 直接是 config 对象
    // wrangler.toml 方式：entry = { config, tokenKey }
    const config = entry.config || entry;
    let tokenKey = entry.tokenKey || 'default';

    // 环境变量方式 fallback：检查 zones 中是否有 tokenKey 指定的
    if (!entry.tokenKey && config.zones) {
      for (const zone of config.zones) {
        if (typeof zone === 'object' && zone.tokenKey) {
          tokenKey = zone.tokenKey;
          break;
        }
      }
    }

    if (!zoneConfigs[tokenKey]) zoneConfigs[tokenKey] = {};

    const zones = config.zones || [];
    const groups = config.groups || [];

    for (const zone of zones) {
      const zoneName = sc.zoneNameOf(zone);
      if (!zoneName) continue;
      const zoneTokenKey = (typeof zone === 'object' && zone.tokenKey) || tokenKey;

      if (!zoneConfigs[zoneTokenKey][zoneName]) {
        zoneConfigs[zoneTokenKey][zoneName] = [];
      }

      for (const group of groups) {
        zoneConfigs[zoneTokenKey][zoneName].push(group);
      }
    }
  }

  // 构建规则列表
  const zoneRules = [];

  for (const [tokenKey, zones] of Object.entries(zoneConfigs)) {
    for (const [zoneName, groups] of Object.entries(zones)) {
      const rules = [];

      for (const group of groups) {
        const fqdn = `${group.prefix}.${zoneName}`;
        const cities = group.cities || [];
        const provinces = group.provinces || [];
        const schedule = group.schedule;

        // ── 地理围栏规则 ──
        // cities 非 ALL 且有 provinces → 省级围栏
        if (!cities.includes('ALL') && provinces.length > 0) {
          // 提取 ISO 3166-2 代码（CF ip.src.subdivision_1_iso_code 返回如 "CN-ZJ"）
          // 配置中可能同时包含中文和英文（如 ["浙江", "Zhejiang"]），映射后去重
          const isoCodes = [...new Set(provinces.map(p => PROVINCE_CN_TO_CODE[p] || p))];

          // 构建表达式：匹配该 hostname 且不在指定省份
          // 使用 ip.src.subdivision_1_iso_code 字段（Business 计划以上可用）
          const provinceExprs = isoCodes.map(c => `ip.src.subdivision_1_iso_code eq "${c}"`).join(' or ');
          const expression = `(http.host eq "${fqdn}") and not (${provinceExprs})`;

          rules.push({
            type: 'geo-restrict',
            fqdn,
            expression,
            action: 'block',
            description: `${group.prefix}-geo-restrict (block non-${isoCodes.join('/')})`,
            enabled: true,
          });
        }

        // ── 时段控制规则 ──
        // 有 schedule → 创建 Block 规则，默认 disabled
        // Docker 容器定时 enable/disable 实现时段控制
        if (schedule && schedule.periods && schedule.periods.length > 0) {
          // 规则只做 Block，不做时间判断
          // 时段控制由 Docker cron 定时 enable/disable 实现
          const expression = `(http.host eq "${fqdn}")`;
          const periods = schedule.periods.join(', ');

          rules.push({
            type: 'schedule',
            fqdn,
            expression,
            action: 'block',
            description: `${group.prefix}-schedule (${periods}, Docker controlled)`,
            enabled: false, // 默认 disabled，Docker 定时切换
          });
        }
      }

      if (rules.length > 0) {
        zoneRules.push({ zoneName, tokenKey, rules });
      }
    }
  }

  return zoneRules;
}

// ── 主逻辑 ──────────────────────────────────────────

async function processZone(zoneName, tokenKey, desiredRules) {
  console.log(`\n━━━ Zone: ${zoneName}${tokenKey ? ` (账户: ${tokenKey})` : ''} ━━━`);

  let zoneId;
  try {
    zoneId = await sc.getZoneId(zoneName, tokenKey);
  } catch (e) {
    console.error(`  ✗ 获取 Zone ID 失败: ${e.message}`);
    return { errors: desiredRules.length, created: 0, updated: 0, skipped: 0 };
  }

  // 获取现有 WAF Custom Rules
  let existingRuleset = null;
  try {
    existingRuleset = await getCustomRuleset(zoneId, tokenKey);
  } catch (e) {
    // Ruleset 不存在，需要创建
    console.log(`  现有 WAF Custom Ruleset 不存在，将创建`);
  }

  // 打印现有规则
  if (existingRuleset && existingRuleset.rules) {
    console.log(`  现有规则 (${existingRuleset.rules.length} 条):`);
    for (const r of existingRuleset.rules) {
      console.log(`    [${r.enabled ? 'enabled' : 'disabled'}] ${r.description || '(无描述)'}: ${r.expression}`);
    }
  }

  // 构建新规则集
  console.log(`\n  目标规则 (${desiredRules.length} 条):`);
  for (const r of desiredRules) {
    const status = r.enabled ? 'enabled' : 'disabled';
    console.log(`    [${status}] ${r.description}`);
    console.log(`           ${r.expression}`);
  }

  // 检查 CF 免费版 5 条规则限制
  if (desiredRules.length > 5) {
    console.error(`  ✗ 规则数 ${desiredRules.length} 超过 CF 免费版限制 (5 条/zone)`);
    return { errors: desiredRules.length, created: 0, updated: 0, skipped: 0 };
  }

  if (dryRun) {
    console.log(`\n  [DRY_RUN] 跳过实际执行`);
    return { errors: 0, created: desiredRules.length, updated: 0, skipped: 0 };
  }

  // 执行更新
  try {
    if (!existingRuleset) {
      // 首次创建
      console.log(`\n  创建 WAF Custom Ruleset...`);
      const result = await createCustomRuleset(zoneId, desiredRules, tokenKey);
      console.log(`  ✓ Ruleset 已创建 (id: ${result.id})`);
      return { errors: 0, created: desiredRules.length, updated: 0, skipped: 0 };
    } else {
      // 更新现有 ruleset
      // 保留现有规则的 enabled 状态（对于 schedule 规则，可能被 Docker 改过）
      const existingByDesc = new Map();
      for (const r of existingRuleset.rules || []) {
        existingByDesc.set(r.description, r);
      }

      // 合并：用 desired 规则的 expression/action/description，
      // 但保留现有规则的 enabled 状态（Docker 可能改过 schedule 规则的 enabled）
      const mergedRules = desiredRules.map(dr => {
        const existing = existingByDesc.get(dr.description);
        if (existing) {
          // 保留现有 enabled 状态
          return { ...dr, enabled: existing.enabled };
        }
        return dr;
      });

      console.log(`\n  更新 WAF Custom Ruleset...`);
      await putCustomRuleset(zoneId, existingRuleset.id, mergedRules, tokenKey);
      console.log(`  ✓ Ruleset 已更新`);

      let created = 0, updated = 0, skipped = 0;
      for (const dr of desiredRules) {
        if (existingByDesc.has(dr.description)) {
          updated++;
        } else {
          created++;
        }
      }
      return { errors: 0, created, updated, skipped };
    }
  } catch (e) {
    console.error(`  ✗ 更新 Ruleset 失败: ${e.message}`);
    return { errors: desiredRules.length, created: 0, updated: 0, skipped: 0 };
  }
}

// ── 主入口 ──────────────────────────────────────────

async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  Cloudflare WAF Custom Rules 配置脚本            ║');
  console.log('║  地理围栏 + 时段控制（Docker 定时开关）            ║');
  console.log('╚════════════════════════════════════════════════╝');

  if (dryRun) {
    console.log('\n⚠  DRY_RUN 模式 — 仅预览，不执行任何修改\n');
  }

  // Step 1: 解析配置
  console.log('\n── 解析 Firewall 配置 ──');
  let zoneRules = buildFirewallConfig();
  if (zoneRules.length === 0) {
    console.log('  无需配置 Firewall 规则（所有 group 均为 cities:ALL 且无 schedule）');
    return;
  }

  // 按 TOKEN_KEY 过滤（CI 多账户 Job 隔离）
  const filterTokenKey = process.env.TOKEN_KEY;
  if (filterTokenKey) {
    const before = zoneRules.length;
    zoneRules = zoneRules.filter(zr => zr.tokenKey === filterTokenKey);
    console.log(`  TOKEN_KEY=${filterTokenKey} 过滤: ${before} → ${zoneRules.length} 个 Zone`);
  }

  if (zoneRules.length === 0) {
    console.log('  过滤后无需处理任何 Zone');
    return;
  }
  console.log(`  共 ${zoneRules.length} 个 Zone 需配置 Firewall 规则\n`);

  // 打印配置概览
  console.log('┌──────────────────────────────────────────────────────────────────┐');
  console.log('│  WAF Custom Rules 配置计划                                       │');
  console.log('├──────────────────────────────────────────────────────────────────┤');
  for (const zr of zoneRules) {
    console.log(`│  Zone: ${zr.zoneName} (${zr.tokenKey})`);
    for (const r of zr.rules) {
      const status = r.enabled ? '●' : '○';
      console.log(`│    ${status} ${r.type.padEnd(14)} ${r.description}`);
    }
  }
  console.log('└──────────────────────────────────────────────────────────────────┘');

  // Step 2: 逐 zone 处理
  let totalErrors = 0;
  let totalCreated = 0;
  let totalUpdated = 0;

  for (const zr of zoneRules) {
    const result = await processZone(zr.zoneName, zr.tokenKey, zr.rules);
    totalErrors += result.errors;
    totalCreated += result.created;
    totalUpdated += result.updated;
  }

  // 汇总
  console.log('\n━━━ 汇总 ━━━');
  console.log(`  Zones: ${zoneRules.length}  创建: ${totalCreated}  更新: ${totalUpdated}  错误: ${totalErrors}`);

  if (totalErrors > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error('致命错误:', e.message);
    process.exit(1);
  });
}

// ── 导出 ──
module.exports = {
  buildFirewallConfig,
  processZone,
  getCustomRuleset,
  putCustomRuleset,
  createCustomRuleset,
  PROVINCE_CN_TO_CODE,
};
