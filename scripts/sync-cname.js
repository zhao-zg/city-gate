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
const https = require('https');
const path = require('path');

// ── Worker → 账户 Token 映射 ──────────────────────────────
// key = wrangler.toml 中的 name（即 Worker 名），value = 环境变量 Token key
const WORKER_TOKEN_KEYS = {
  'city-gate': 'default',
  'city-gate-2': 'account2',
};

// ── 优选域名池 ─────────────────────────────────────────
// 每个 zone 分配池中一个域名，zone 内所有子域名指向同一优选域名
// 注意：1034（Edge IP Restricted）按"受限 IP 空间 × 未授权 Host"触发，
//       无法用 IP 段猜测。validatePool 会用自家域名做真实请求验证，
//       响应含 "error code: 1034" 的域名自动跳过，只使用安全域名。
const CNAME_POOL = [
  'cf.090227.xyz',
  'cf.877774.xyz',
  'cf.cloudflare.182682.xyz',
  '1.cf.3666888.xyz',
  'www.shopify.com',
  'cf.yfjc.sbs',
  'icook.hk',
  'cf-cname.xingpingcn.top',
  'zzg.cf.959923.xyz',
  'ips.993888.xyz',
  'bestcf.030101.xyz'
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

// ── Cloudflare 公共保留 IP（解析到这些 IP 必触发 1034，快速短路）──────────
// 1034 由 Edge IP Validation (EIV) 触发，保护"特定账户专用"的受限 IP 空间
// （BYOIP 前缀、专用/静态 IP、CF for SaaS 客户关联 IP 段）。
// 注意：**不能**用 IP 段（如 172.64.0.0/13）一刀切——实测同一段内
//       172.64.52.173 触发 1034、172.64.153.208 正常。
//       真正的判定靠真实请求验证（见 checkPoolDomain）。
// 以下仅作快速短路；resolveIps 只查 A 记录，故不含 IPv6 条目。
const CF_PUBLIC_RESERVED_IPS = [
  '1.1.1.1', '1.0.0.1',           // Cloudflare Public DNS（官方确认 1034）
  '198.51.100.1', '100::1',        // Cloudflare 官方推荐占位 IP
];

// ── 优选域名有效性检测 ─────────────────────────────────────
const POOL_CHECK_TIMEOUT = 4000;   // 单次请求超时（ms）
const POOL_RESOLVE_ROUNDS = 3;     // 每个域名 DNS 解析轮数（收集轮询 IP）
const POOL_IP_RETRIES = 3;         // 软错误（超时/连接失败）重试次数，消除抖动

/**
 * 快速短路：是否为已知 CF 公共保留 IP（1.1.1.1 等，官方确认必触发 1034）
 * 其余 IP 是否触发 1034 无法按 IP/段判断，交给真实请求验证 testIp1034
 */
function is1034Ip(ip) {
  return CF_PUBLIC_RESERVED_IPS.includes(ip);
}

/**
 * 解析域名并返回所有 A 记录 IP（多次解析收集去重）
 * 轮询域名（同一域名不同时刻解析到不同 IP）多次查询能覆盖更多 IP，
 * 尽可能测全域名暴露的所有 A 记录
 */
async function resolveIps(domain) {
  const ips = new Set();
  // ── 主路径：Node.js dns.resolve4 多次解析收集 ──
  for (let round = 0; round < POOL_RESOLVE_ROUNDS; round++) {
    try {
      const addrs = await dnsResolve4(domain, POOL_CHECK_TIMEOUT);
      for (const a of addrs) ips.add(a);
    } catch (_) {
      // 该轮失败，继续下一轮
    }
  }
  if (ips.size > 0) return [...ips];
  // ── 回退：Cloudflare DoH ──
  try {
    const dohUrl = `https://cloudflare-dns.com/dns-query?name=${domain}&type=A`;
    const dohRes = await fetch(dohUrl, {
      headers: { Accept: 'application/dns-json' },
      signal: AbortSignal.timeout(POOL_CHECK_TIMEOUT),
    });
    const dohJson = await dohRes.json();
    if (dohJson.Answer) {
      for (const a of dohJson.Answer) {
        if (a.type === 1 && a.data && /^\d+\.\d+\.\d+\.\d+$/.test(a.data)) {
          ips.add(a.data);
        }
      }
    }
  } catch (_) {
    // 忽略
  }
  return [...ips];
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
 * 真实请求验证（单次）：用自家域名（testHost）做 Host + SNI 直连指定 IP
 * 响应含 "error code: 1034" → 该 IP 处于受限空间且 Host 未授权 → 不可用
 * 其他任何 HTTP 响应（200/403/530 等）都说明网络通路正常 → 可用
 * 注意：testHost 必须是**真实存在 CNAME 记录**的自家子域名，
 *       不存在的子域名只会得到 1016（Origin DNS error），无法触发 1034 判定
 */
function testIp1034Once(ip, testHost) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    let body = '';

    const req = https.request({
      host: ip,
      servername: testHost,       // SNI
      headers: { Host: testHost },
      path: '/',
      method: 'GET',
      timeout: POOL_CHECK_TIMEOUT,
      rejectUnauthorized: false,  // 忽略证书不匹配（不影响可用性判定）
    }, (res) => {
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length >= 8192) {
          // 1034 错误页远小于 8KB，到这里还没出现说明不是 1034
          res.destroy();
          finish({ ok: true, reason: `HTTP ${res.statusCode}` });
        } else if (/error code:\s*1034|error 1034/i.test(body)) {
          res.destroy();
          finish({ ok: false, reason: `HTTP ${res.statusCode} 1034` });
        }
      });
      res.on('end', () => {
        finish(/error code:\s*1034|error 1034/i.test(body)
          ? { ok: false, reason: `HTTP ${res.statusCode} 1034` }
          : { ok: true, reason: `HTTP ${res.statusCode}` });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, reason: '连接超时' });
    });
    req.on('error', (e) => {
      const msg = e.code || e.message || '';
      // 证书类错误说明 TLS 已通到 CF 边缘，CNAME 层面仍有效
      if (/CERT|TLS|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(String(msg))) {
        finish({ ok: true, reason: 'TLS 证书不匹配（网络已通）' });
      } else {
        finish({ ok: false, reason: `连接失败: ${String(msg).slice(0, 40)}` });
      }
    });

    req.end();
  });
}

/**
 * 真实请求验证（带重试）：
 * - 成功（ok）→ 直接返回
 * - 1034（硬判定，IP 受限是稳定特性）→ 直接接受，重试不会改变结果
 * - 软错误（超时/连接失败/ECONNRESET 等）→ 重试 POOL_IP_RETRIES 次
 *   实测部分 IP 偶发连接失败（如 2/3 能连上），多重试可避免误判
 */
async function testIp1034(ip, testHost) {
  let last;
  for (let attempt = 0; attempt < POOL_IP_RETRIES; attempt++) {
    last = await testIp1034Once(ip, testHost);
    if (last.ok) return last;                                  // 可用
    if (/1034/i.test(last.reason)) return last;                // 硬判定
    // 软错误 → 继续重试
  }
  return last;
}

/**
 * 生成 1034 真实请求验证用的测试 Host
 * 取第一个 zone 的第一个前缀（如 sg.1189.dpdns.org）
 * 必须是自家真实 zone 且该 FQDN 会配置 CNAME，才能正确触发 EIV 判定；
 * 首次运行（记录尚未创建）可能显示 1016 而误判可用，第二次运行自动纠正
 */
function buildTestHost(zoneMap) {
  if (zoneMap.length === 0) return null;
  const first = zoneMap[0];
  const prefix = first.names[0] || 'www';
  return `${prefix}.${first.zoneName}`;
}

/**
 * 检测单个优选域名是否可用：
 * 1. DNS 解析（无 A 记录 → 不可用）
 * 2. 快速短路：解析到 CF 公共保留 IP（1.1.1.1 等）→ 必 1034，不可用
 * 3. 真实请求验证：用自家域名做 Host 逐 IP 访问
 *    多个 IP 时只要有一个可用即视为可用（用户可能随机命中任一 IP）
 */
async function checkPoolDomain(domain, testHost) {
  const ips = await resolveIps(domain);

  if (ips.length === 0) {
    return { ok: false, reason: 'NXDOMAIN（域名无法解析）' };
  }

  // 快速短路：解析到已知保留 IP 必触发 1034
  const reservedIps = ips.filter(ip => is1034Ip(ip));
  if (reservedIps.length > 0) {
    return { ok: false, reason: `解析到 CF 保留 IP: ${reservedIps.join(', ')}（必 1034）` };
  }

  // 真实请求验证：对每个 IP 用自家域名做 Host 访问
  const checks = await Promise.all(ips.map(ip => testIp1034(ip, testHost)));
  const good = checks.filter(r => r.ok);

  if (good.length === 0) {
    const reasons = [...new Set(checks.map(r => r.reason))];
    return { ok: false, reason: reasons.join('; ') };
  }
  if (good.length < checks.length) {
    return { ok: true, reason: `⚠ ${checks.length - good.length}/${checks.length} IP 触发 1034，仍有 ${good.length} 个可用` };
  }
  return { ok: true, reason: `IP 可用: ${ips.join(', ')}` };
}

/**
 * 并发检测优选域名池，返回安全域名列表和检测报告
 * 用自家域名做真实请求验证，有 1034 风险的域名自动跳过，只使用安全域名
 */
async function validatePool(pool, testHost) {
  console.log('\n── 优选域名池有效性检测 ──');
  console.log(`  测试 Host: ${testHost}（真实请求验证 1034）\n`);

  const results = await Promise.all(
    pool.map(async (domain) => {
      const result = await checkPoolDomain(domain, testHost);
      const status = result.ok ? '✓' : '✗';
      const reason = result.reason || '';
      console.log(`  ${status}  ${domain.padEnd(32)} ${reason ? '— ' + reason : ''}`);
      return { domain, ...result };
    })
  );

  const valid = results.filter(r => r.ok).map(r => r.domain);
  const invalid = results.filter(r => !r.ok);

  if (invalid.length > 0) {
    console.log(`\n  ⚠  ${invalid.length} 个域名有 1034 风险，已跳过:`);
    for (const r of invalid) {
      console.log(`     - ${r.domain}: ${r.reason}`);
    }
  }
  console.log(`  池大小: ${pool.length}，安全可用: ${valid.length}`);

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

  // 第1步：检测优选域名池有效性（真实请求验证 1034，自动跳过风险域名）
  const testHost = buildTestHost(ZONE_MAP);
  const { valid: validPool } = await validatePool(CNAME_POOL, testHost);

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
