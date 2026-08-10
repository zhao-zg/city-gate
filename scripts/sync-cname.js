#!/usr/bin/env node
/**
 * Cloudflare DNS CNAME 同步脚本（多账户版 + 优选域名池轮询分配）
 *
 * 核心改进：同一服务的不同域名指向不同的优选域名，实现容灾分散。
 *   - 定义优选域名池（多个优选域名）
 *   - 将所有 FQDN 展平后按顺序轮流分配池中的优选域名
 *   - 同一服务的不同域名自然分配到不同优选域名
 *
 * Zone & Prefix 自动检测：
 *   自动扫描 workers/ 下所有 wrangler.toml，从 DOMAIN_CONFIG_JSON
 *   提取 zones + groups prefixes，无需手动维护两份配置。
 *   与 generate-routes.js 共用同一解析逻辑，增减前缀只需改 wrangler.toml。
 *
 * 同步策略（三路判断）：
 *   - 已存在 CNAME 且目标已是分配的优选域名 → 跳过
 *   - 已存在 CNAME 但目标不是分配的优选域名 → 删除旧记录，新建
 *   - 不存在 CNAME → 新建
 *
 * 支持多账户：每个 zone 配置可指定不同的 API Token（用于跨账户 DNS 操作）
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN  — 默认 Cloudflare API Token（需 Zone:DNS:Edit 权限）
 *   CLOUDFLARE_API_TOKEN_2 — 账户2的 API Token（可选）
 *   DRY_RUN（可选）       — 设为 1 则只预览不执行
 *
 * 用法：
 *   node scripts/sync-cname.js             # 执行同步
 *   DRY_RUN=1 node scripts/sync-cname.js   # 预览模式
 */

const CF_API = 'https://api.cloudflare.com/client/v4';
const fs = require('fs');
const path = require('path');

// ── Worker → 账户 Token 映射 ──────────────────────────────
// key = wrangler.toml 中的 name（即 Worker 名），value = 环境变量 Token key
const WORKER_TOKEN_KEYS = {
  'city-gate': 'default',
  'city-gate-2': 'account2',
};

// ── 优选域名池 ─────────────────────────────────────────
// 每个 zone 分配池中一个域名，zone 内所有子域名指向同一优选域名
// 注意：saas.sin.fan / eii.at 会触发 CF 1034（CNAME 链嵌套 SaaS），已移除
const CNAME_POOL = [
  'cf.090227.xyz',
  'cf.877774.xyz',
  'cloudflare.seeck.cn',
  'cf.cloudflare.182682.xyz',
  '1.cf.3666888.xyz',
  'anycubic.com',
  'www.shopify.com',
  'cf.yfjc.sbs',
  'mfa.gov.ua'
];

// ── 从 wrangler.toml 自动提取 Zone 配置 ──────────────────
// 与 generate-routes.js 共用同一解析逻辑，增减前缀只需改 wrangler.toml
const dns = require('dns');

/**
 * 解析 wrangler.toml 中的 DOMAIN_CONFIG_JSON
 */
function parseDomainConfig(tomlText) {
  const m = tomlText.match(/DOMAIN_CONFIG_JSON\s*=\s*"""([\s\S]*?)"""/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    console.error('  DOMAIN_CONFIG_JSON 解析失败:', e.message);
    return null;
  }
}

/**
 * 解析 wrangler.toml 中的 Worker name
 */
function parseWorkerName(tomlText) {
  const m = tomlText.match(/^name\s*=\s*"([^"]+)"/m);
  return m ? m[1] : null;
}

/**
 * 从 DOMAIN_CONFIG_JSON 展开为 { zoneName, names, tokenKey } 列表
 */
function buildZoneMapFromConfig(config, workerName) {
  const tokenKey = WORKER_TOKEN_KEYS[workerName] || 'default';
  const zones = [];

  // zones + prefixes 格式
  if (config.zones && Array.isArray(config.groups)) {
    // 按前缀去重收集
    const prefixSet = new Set();
    for (const group of config.groups) {
      prefixSet.add(group.prefix);
    }
    const names = [...prefixSet];
    for (const zone of config.zones) {
      zones.push({ zoneName: zone, names, tokenKey });
    }
    return zones;
  }

  // 旧格式：域名组数组 → 从 domains 反推 zone + prefix
  if (Array.isArray(config)) {
    const zoneMap = {};
    for (const group of config) {
      for (const domain of group.domains || []) {
        const prefix = domain.split('.')[0];
        const zoneName = domain.split('.').slice(1).join('.');
        if (!zoneMap[zoneName]) zoneMap[zoneName] = { zoneName, names: new Set(), tokenKey };
        zoneMap[zoneName].names.add(prefix);
      }
    }
    return Object.values(zoneMap).map(z => ({ ...z, names: [...z.names] }));
  }

  return zones;
}

/**
 * 扫描所有 Worker 目录，自动生成 ZONE_MAP
 */
function autoDetectZoneMap() {
  const workersDir = path.join(__dirname, '..', 'workers');
  const allZones = [];

  const dirs = fs.readdirSync(workersDir)
    .filter(name => fs.existsSync(path.join(workersDir, name, 'wrangler.toml')));

  for (const dir of dirs) {
    const tomlPath = path.join(workersDir, dir, 'wrangler.toml');
    const tomlText = fs.readFileSync(tomlPath, 'utf8');
    const config = parseDomainConfig(tomlText);
    if (!config) {
      console.log(`跳过 ${dir}: 无 DOMAIN_CONFIG_JSON`);
      continue;
    }
    const workerName = parseWorkerName(tomlText) || dir;
    const zones = buildZoneMapFromConfig(config, workerName);
    allZones.push(...zones);
    console.log(`  ${dir} (${workerName}): ${zones.length} zones, prefixes: ${zones.map(z => z.names.join(',')).join('; ') || '(无)'}`);
  }

  return allZones;
}

// ── 优选域名有效性检测 ─────────────────────────────────────
const POOL_CHECK_TIMEOUT = 5000;  // 单个优选域名检测超时（ms）
const POOL_CHECK_HTTPS = false;   // HTTPS 连通检测（仅警告，不影响有效性判定）

/**
 * DNS 解析检测（优先用 Node.js 内置 dns 模块，失败回退 DoH）
 */
async function checkDns(domain) {
  // ── 主路径：Node.js dns.resolve4 ──
  try {
    await dnsResolve4(domain, POOL_CHECK_TIMEOUT);
    return { ok: true };
  } catch (err) {
    if (err.code === 'ENOTFOUND') {
      return { ok: false, reason: 'NXDOMAIN（域名不存在）' };
    }
    // 其他 DNS 错误（超时、SERVFAIL 等），不直接判定无效，回退 DoH
  }

  // ── 回退：Cloudflare DoH ──
  try {
    const dohUrl = `https://cloudflare-dns.com/dns-query?name=${domain}&type=A`;
    const dohRes = await fetch(dohUrl, {
      headers: { Accept: 'application/dns-json' },
      signal: AbortSignal.timeout(POOL_CHECK_TIMEOUT),
    });
    const dohJson = await dohRes.json();

    if (dohJson.Status === 3) {
      return { ok: false, reason: 'NXDOMAIN（域名不存在）' };
    }
    const hasAnswer = dohJson.Answer?.length > 0;
    if (!hasAnswer && dohJson.Status !== 0) {
      return { ok: false, reason: `DNS RCODE=${dohJson.Status}` };
    }
    return { ok: true };
  } catch {
    // DNS 和 DoH 都不确定，保守视为有效（避免误剔除）
    return { ok: true, reason: 'DNS 不确定，保守视为有效' };
  }
}

/** Promise 包装 dns.resolve4，带超时 */
function dnsResolve4(domain, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DNS timeout')), timeout);
    dns.resolve4(domain, (err, addrs) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(addrs);
    });
  });
}

/**
 * HTTPS 连通性检测
 */
async function checkHttps(domain) {
  try {
    await fetch(`https://${domain}/`, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(POOL_CHECK_TIMEOUT),
    });
    // 任何响应都算连通（403/503 也说明网络通了）
    return { ok: true };
  } catch (e) {
    const msg = e.cause?.code || e.message || '';
    // 证书错误：DNS 已通，CNAME 层面仍有效
    if (msg.includes('CERT') || msg.includes('certificate') || msg.includes('UNABLE_TO_VERIFY')) {
      return { ok: true, reason: 'HTTPS 证书不匹配（不影响 CNAME）' };
    }
    // 连接被拒/超时
    return { ok: false, reason: `HTTPS 连接失败: ${msg.slice(0, 60)}` };
  }
}

/**
 * 检测单个优选域名是否有效
 * 1. DNS 解析：能解析出 A 记录
 * 2. HTTPS 连通：能建立 TLS 连接（可选）
 */
async function checkPoolDomain(domain) {
  const dnsResult = await checkDns(domain);
  if (!dnsResult.ok) {
    return { ok: false, reason: dnsResult.reason };
  }

  // HTTPS 检测仅作参考，不决定有效性
  if (POOL_CHECK_HTTPS) {
    const httpsResult = await checkHttps(domain);
    if (!httpsResult.ok) {
      return { ok: true, reason: `DNS 正常，HTTPS 不可达（仅警告）: ${httpsResult.reason}` };
    }
    return { ok: true, reason: httpsResult.reason };
  }

  return { ok: true, reason: dnsResult.reason };
}

/**
 * 并发检测优选域名池，返回有效域名列表和检测报告
 */
async function validatePool(pool) {
  console.log('\n── 优选域名池有效性检测 ──');

  const results = await Promise.all(
    pool.map(async (domain) => {
      const result = await checkPoolDomain(domain);
      const status = result.ok ? '✓' : '✗';
      const reason = result.reason || '';
      console.log(`  ${status}  ${domain.padEnd(32)} ${reason ? '— ' + reason : ''}`);
      return { domain, ...result };
    })
  );

  const valid = results.filter(r => r.ok).map(r => r.domain);
  const invalid = results.filter(r => !r.ok);

  if (invalid.length > 0) {
    console.log(`\n  ⚠  ${invalid.length} 个优选域名无效，已从池中剔除:`);
    for (const r of invalid) {
      console.log(`     - ${r.domain}: ${r.reason}`);
    }
  }
  console.log(`  池大小: ${pool.length} → ${valid.length}（剔除 ${pool.length - valid.length}）`);

  return { valid, invalid };
}

// ── 分配计划生成 ─────────────────────────────────────────
// 每个 zone 从池中轮询分配一个优选域名，zone 内所有子域名指向同一目标
// 不同 zone 会分散到不同优选域名，实现容灾
async function buildAssignmentPlan() {
  // 第0步：自动从 wrangler.toml 提取 Zone 配置
  console.log('\n── 自动检测 Zone 配置 ──');
  const ZONE_MAP = autoDetectZoneMap();
  if (ZONE_MAP.length === 0) {
    throw new Error('未检测到任何 Zone 配置，请检查 workers/ 下的 wrangler.toml');
  }
  console.log(`  共 ${ZONE_MAP.length} 个 Zone 需同步\n`);

  // 第1步：检测优选域名池有效性
  const { valid: validPool } = await validatePool(CNAME_POOL);

  if (validPool.length === 0) {
    throw new Error('所有优选域名均无效，无法继续同步！');
  }

  // 第2步：每个 zone 分配一个优选域名，zone 内所有子域名指向同一目标
  const assignments = [];
  for (let z = 0; z < ZONE_MAP.length; z++) {
    const zone = ZONE_MAP[z];
    const target = validPool[z % validPool.length];
    for (const name of zone.names) {
      assignments.push({
        fqdn: `${name}.${zone.zoneName}`,
        zoneName: zone.zoneName,
        name,
        tokenKey: zone.tokenKey,
        target,
        poolIndex: z % validPool.length,
      });
    }
  }

  return assignments;
}

// ── 工具函数 ──────────────────────────────────────────

function getToken(tokenKey) {
  // 支持 'default' 和 'account2' 等自定义 key
  const TOKEN_MAP = {
    default: process.env.CLOUDFLARE_API_TOKEN,
    account2: process.env.CLOUDFLARE_API_TOKEN_2,
  };
  const token = TOKEN_MAP[tokenKey || 'default'];
  if (!token) throw new Error(`API Token 未设置 (key: ${tokenKey || 'default'})`);
  return token;
}

async function cfFetch(path, options = {}) {
  const tokenKey = options.tokenKey || 'default';
  const token = getToken(tokenKey);
  if (!token) throw new Error(`API Token 未设置 (key: ${tokenKey})`);

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
    throw new Error(`Cloudflare API 错误: ${err}`);
  }
  return json;
}

async function getZoneId(zoneName, tokenKey) {
  const json = await cfFetch(`/zones?name=${zoneName}`, { tokenKey });
  if (!json.result?.length) {
    throw new Error(`Zone "${zoneName}" 未找到，请检查 zone 名称和 API Token 权限`);
  }
  return json.result[0].id;
}

async function getDnsRecords(zoneId, recordName, tokenKey) {
  const json = await cfFetch(`/zones/${zoneId}/dns_records?name=${recordName}`, { tokenKey });
  return json.result || [];
}

async function deleteDnsRecord(zoneId, recordId, tokenKey) {
  await cfFetch(`/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE', tokenKey });
}

async function createCnameRecord(zoneId, name, target, tokenKey, proxied = false) {
  const body = { type: 'CNAME', name, content: target, proxied, ttl: 1 };
  await cfFetch(`/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify(body),
    tokenKey,
  });
}

// ── 打印分配计划 ─────────────────────────────────────────

function printAssignmentPlan(assignments) {
  console.log('\n┌──────────────────────────────────────────────────────────────┐');
  console.log('│  CNAME 分配计划（轮询分配）                                    │');
  console.log('├──────────────────────────────────────────────────────────────┤');
  console.log('│  FQDN                              →  优选域名              │');
  console.log('├──────────────────────────────────────────────────────────────┤');
  for (const a of assignments) {
    console.log(`│  ${a.fqdn.padEnd(34)} →  ${a.target.padEnd(24)} │`);
  }
  console.log('└──────────────────────────────────────────────────────────────┘');

  // 按优选域名分组统计
  const byTarget = {};
  for (const a of assignments) {
    byTarget[a.target] = (byTarget[a.target] || 0) + 1;
  }
  console.log('\n  优选域名分配统计:');
  for (const [target, count] of Object.entries(byTarget).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${target.padEnd(30)} × ${count}`);
  }
}

// ── 主逻辑 ──────────────────────────────────────────

async function processAssignment(assignments) {
  const dryRun = process.env.DRY_RUN === '1';

  // 按 zone 分组处理
  const zoneGroups = {};
  for (const a of assignments) {
    if (!zoneGroups[a.zoneName]) {
      zoneGroups[a.zoneName] = { tokenKey: a.tokenKey, items: [] };
    }
    zoneGroups[a.zoneName].items.push(a);
  }

  let totalStats = { errors: 0, created: 0, deleted: 0, skipped: 0 };

  for (const [zoneName, group] of Object.entries(zoneGroups)) {
    const tokenKey = group.tokenKey;
    console.log(`\n━━━ Zone: ${zoneName}${tokenKey ? ` (账户: ${tokenKey})` : ''} ━━━`);

    let zoneId;
    try {
      zoneId = await getZoneId(zoneName, tokenKey);
    } catch (e) {
      console.error(`  ✗ 获取 Zone ID 失败: ${e.message}`);
      totalStats.errors += group.items.length;
      continue;
    }

    for (const a of group.items) {
      const { fqdn, target } = a;
      console.log(`\n  ▸ ${fqdn} → ${target}`);

      try {
        const records = await getDnsRecords(zoneId, fqdn, tokenKey);
        const cnameRecords = records.filter(r => r.type === 'CNAME');

        if (cnameRecords.length === 0) {
          console.log(`    无 CNAME 记录 → 创建 CNAME → ${target}`);
          if (!dryRun) {
            await createCnameRecord(zoneId, fqdn, target, tokenKey);
          }
          totalStats.created++;
        } else {
          const matchTarget = cnameRecords.filter(r => r.content === target);
          const mismatchTarget = cnameRecords.filter(r => r.content !== target);

          if (matchTarget.length > 0 && mismatchTarget.length === 0) {
            console.log(`    CNAME 已指向 ${target} → 跳过`);
            totalStats.skipped++;
          } else {
            for (const rec of mismatchTarget) {
              console.log(`    删除旧 CNAME → ${rec.content} (id: ${rec.id})`);
              if (!dryRun) {
                await deleteDnsRecord(zoneId, rec.id, tokenKey);
              }
              totalStats.deleted++;
            }

            if (matchTarget.length === 0) {
              console.log(`    创建 CNAME → ${target}`);
              if (!dryRun) {
                await createCnameRecord(zoneId, fqdn, target, tokenKey);
              }
              totalStats.created++;
            } else {
              console.log(`    CNAME 已指向 ${target} → 跳过`);
              totalStats.skipped++;
            }
          }
        }
      } catch (e) {
        console.error(`    ✗ 处理失败: ${e.message}`);
        totalStats.errors++;
      }
    }
  }

  return totalStats;
}

async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  Cloudflare DNS CNAME 同步脚本（优选域名池版）    ║');
  console.log('╚════════════════════════════════════════════════╝');

  if (process.env.DRY_RUN === '1') {
    console.log('\n⚠  DRY_RUN 模式 — 仅预览，不执行任何修改\n');
  }

  // 生成并展示分配计划
  const assignments = await buildAssignmentPlan();
  printAssignmentPlan(assignments);

  // 执行同步
  const totalStats = await processAssignment(assignments);

  console.log('\n━━━ 汇总 ━━━');
  console.log(`  创建: ${totalStats.created}  删除: ${totalStats.deleted}  跳过: ${totalStats.skipped}  错误: ${totalStats.errors}`);

  if (totalStats.errors > 0) {
    process.exit(1);
  }
}

main();
