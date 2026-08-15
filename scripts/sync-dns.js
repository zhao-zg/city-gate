#!/usr/bin/env node
/**
 * Cloudflare DNS 同步脚本（优选 IP + SaaS 模式）
 *
 * 架构：
 *   Pages 源站 → A 记录指向优选 CF 边缘 IP (proxied=false, DNS only)
 *     用户直连优选 IP，CF Edge 通过 SaaS Custom Hostname 路由
 *     Pages 自定义域名已激活，源站认识 Host header → 200 OK
 *
 *   非 Pages 源站 → CNAME → 源站域名 (proxied=false)
 *     直连外部源站，不经过 CF 代理
 *
 * 与 setup-saas.js 的关系：
 *   setup-saas.js: SaaS 配置（Fallback Origin + Custom Hostnames + Pages 自定义域名 + DNS proxied=true）
 *   sync-dns.js:   将 DNS 从 proxied=true 改为 A 记录优选 IP (proxied=false)
 *
 * 优选 IP 来源：
 *   从 sync-cname.js 的 CNAME_POOL 优选域名池解析得到，
 *   每个 zone 分配 2 个 IP（IP_PER_ZONE=2），/24 去重
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN   — 默认 CF API Token（需 Zone:DNS:Edit 权限）
 *   CLOUDFLARE_API_TOKEN_2 — 账户2 Token（可选）
 *   DRY_RUN（可选）       — 设为 1 则只预览不执行
 *   TOKEN_KEY（可选）     — 只处理指定 tokenKey 的 zone（'default' 或 'account2'）
 *   IP_PER_ZONE（可选）   — 每个 zone 分配的优选 IP 数量，默认 2
 *
 * 下载测速相关：
 *   SPEED_TEST_ENABLED（可选）  — 设为 1 启用下载测速，默认不启用
 *   MIN_DOWNLOAD_SPEED（可选）  — 最低下载速度 KB/s，低于此的 IP 淘汰，默认 500
 *   SPEED_TEST_DURATION（可选） — 测速持续时间秒数，默认 5
 *   SPEED_TEST_TIMEOUT（可选）  — 单次测速超时毫秒，默认 8000
 *   SPEED_TEST_CONCURRENCY（可选）— 并发测速数，默认 10
 *   SPEED_TEST_DOWNLOAD_BYTES（可选）— 手动指定下载字节数（覆盖自动计算）
 *
 * 用法：
 *   node scripts/sync-dns.js             # 执行同步
 *   DRY_RUN=1 node scripts/sync-dns.js   # 预览模式
 */

const sc = require('./sync-cname');
const saas = require('./setup-saas');
const https = require('https');

// ── 优选 IP 配置 ─────────────────────────────────────
const IP_PER_ZONE = parseInt(process.env.IP_PER_ZONE || '2', 10);
const SPEED_TEST_ENABLED = process.env.SPEED_TEST_ENABLED === '1';
const MIN_DOWNLOAD_SPEED = parseInt(process.env.MIN_DOWNLOAD_SPEED || '500', 10);
const SPEED_TEST_DURATION = parseInt(process.env.SPEED_TEST_DURATION || '5', 10);
const SPEED_TEST_TIMEOUT = parseInt(process.env.SPEED_TEST_TIMEOUT || '8000', 10);
const SPEED_TEST_CONCURRENCY = parseInt(process.env.SPEED_TEST_CONCURRENCY || '10', 10);
const SPEED_TEST_DOWNLOAD_BYTES = process.env.SPEED_TEST_DOWNLOAD_BYTES
  ? parseInt(process.env.SPEED_TEST_DOWNLOAD_BYTES, 10)
  : null;

// ── 工具函数 ──────────────────────────────────────────

/**
 * 判断是否为 Pages 源站（origin 以 .pages.dev 结尾）
 */
function isPagesOrigin(origin) {
  return origin.endsWith('.pages.dev');
}

// ── 优选 IP 解析与测速 ──────────────────────────────────

/**
 * 从优选域名池解析所有可用 IP，/24 去重
 * 返回 [{ ip, /24_prefix }]
 */
async function resolvePreferredIps() {
  console.log('\n── 解析优选域名池 ──');
  const pool = sc.CNAME_POOL;
  if (pool.length === 0) {
    throw new Error('CNAME_POOL 为空，无法解析优选 IP');
  }

  const allIps = new Map(); // ip → /24 prefix
  for (const domain of pool) {
    try {
      const ips = await sc.resolveIps(domain);
      for (const ip of ips) {
        if (!allIps.has(ip)) {
          const prefix24 = ip.split('.').slice(0, 3).join('.');
          allIps.set(ip, prefix24);
        }
      }
      console.log(`  ${domain}: ${ips.length} 个 IP`);
    } catch (e) {
      console.log(`  ${domain}: 解析失败 (${e.message})`);
    }
  }

  // /24 去重：同一 /24 段只保留第一个 IP
  const seen24 = new Set();
  const uniqueIps = [];
  for (const [ip, prefix24] of allIps) {
    if (!seen24.has(prefix24)) {
      seen24.add(prefix24);
      uniqueIps.push(ip);
    }
  }

  console.log(`  共 ${allIps.size} 个 IP，/24 去重后 ${uniqueIps.length} 个`);
  return uniqueIps;
}

/**
 * 下载测速：直连 CF 边缘 IP，SNI 设 speed.cloudflare.com
 * 下载 speed.cloudflare.com/__down?bytes=N 的数据测速
 */
async function measureDownloadSpeed(ip, downloadBytes, timeout) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let resolved = false;
    const finish = (result) => {
      if (!resolved) { resolved = true; resolve(result); }
    };

    const req = https.request({
      host: ip,
      servername: 'speed.cloudflare.com',
      headers: { Host: 'speed.cloudflare.com' },
      path: `/__down?bytes=${downloadBytes}`,
      method: 'GET',
      timeout,
      rejectUnauthorized: false,
    }, (res) => {
      let downloaded = 0;
      res.on('data', (chunk) => { downloaded += chunk.length; });
      res.on('end', () => {
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = elapsed > 0 ? (downloaded / elapsed / 1024) : 0; // KB/s
        finish({ ip, speed, downloaded, elapsed, ok: true });
      });
    });

    req.on('timeout', () => { req.destroy(); finish({ ip, speed: 0, ok: false, reason: '超时' }); });
    req.on('error', (e) => { finish({ ip, speed: 0, ok: false, reason: e.message }); });
    req.end();
  });
}

/**
 * 批量下载测速（并发控制）
 */
async function batchMeasureDownloadSpeed(ips, downloadBytes) {
  const results = [];
  for (let i = 0; i < ips.length; i += SPEED_TEST_CONCURRENCY) {
    const batch = ips.slice(i, i + SPEED_TEST_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(ip => measureDownloadSpeed(ip, downloadBytes, SPEED_TEST_TIMEOUT))
    );
    results.push(...batchResults);
  }
  return results;
}

/**
 * 优选 IP 筛选：解析 → 1034 过滤 → 可选下载测速 → 分配
 * 返回按 zone 分配的 IP 列表
 */
async function selectPreferredIps(zoneCount) {
  const allIps = await resolvePreferredIps();

  // 1034 过滤
  console.log('\n── 1034 过滤 ──');
  const testHost = sc.buildTestHost(sc.autoDetectZoneMap());
  if (!testHost) {
    throw new Error('无法构建 1034 测试 Host');
  }
  console.log(`  测试 Host: ${testHost}`);

  const checkedIps = [];
  for (const ip of allIps) {
    const r = await sc.testIp1034(ip, testHost);
    if (r.ok) {
      checkedIps.push(ip);
      console.log(`  ✓ ${ip} — ${r.reason}`);
    } else {
      console.log(`  ✗ ${ip} — ${r.reason}`);
    }
  }
  console.log(`  ${allIps.length} 个 IP 中 ${checkedIps.length} 个可用`);

  if (checkedIps.length === 0) {
    throw new Error('所有 IP 均不可用（1034 或连接失败）');
  }

  // 可选下载测速
  if (SPEED_TEST_ENABLED && checkedIps.length > 0) {
    // 计算下载字节数：MIN_DOWNLOAD_SPEED * SPEED_TEST_DURATION * 10
    // 如 500 KB/s × 5s = 2500 KB × 10 = 25000 KB ≈ 25MB
    const autoBytes = MIN_DOWNLOAD_SPEED * 1024 * SPEED_TEST_DURATION * 10;
    const downloadBytes = SPEED_TEST_DOWNLOAD_BYTES || Math.max(autoBytes, 2 * 1024 * 1024);
    const downloadMB = (downloadBytes / 1024 / 1024).toFixed(1);

    console.log(`\n── 下载测速 ──`);
    console.log(`  下载量: ${downloadMB} MB，最低速度: ${MIN_DOWNLOAD_SPEED} KB/s，超时: ${SPEED_TEST_TIMEOUT} ms`);

    const results = await batchMeasureDownloadSpeed(checkedIps, downloadBytes);

    const goodResults = [];
    const badResults = [];
    for (const r of results) {
      if (r.ok && r.speed >= MIN_DOWNLOAD_SPEED) {
        goodResults.push(r);
      } else if (r.ok) {
        badResults.push(r);
      }
      const label = r.ok ? `${r.speed.toFixed(0)} KB/s` : r.reason;
      console.log(`  ${r.ok && r.speed >= MIN_DOWNLOAD_SPEED ? '✓' : '✗'} ${r.ip} — ${label}`);
    }

    if (goodResults.length > 0) {
      // 按下载速度降序排列
      goodResults.sort((a, b) => b.speed - a.speed);
      checkedIps.length = 0;
      checkedIps.push(...goodResults.map(r => r.ip));
      console.log(`  ${goodResults.length} 个 IP 达到 ${MIN_DOWNLOAD_SPEED} KB/s 阈值（最高 ${goodResults[0].speed.toFixed(0)} KB/s）`);
    } else {
      console.log(`  ⚠ 全部 IP 低于 ${MIN_DOWNLOAD_SPEED} KB/s，降级保留全部可用 IP`);
    }
  }

  // 按 zone 分配 IP
  const neededIps = zoneCount * IP_PER_ZONE;
  const selectedIps = checkedIps.slice(0, neededIps);

  if (selectedIps.length < neededIps) {
    console.log(`\n  ⚠ 可用 IP 不足（需要 ${neededIps}，有 ${selectedIps.length}），循环复用`);
    while (selectedIps.length < neededIps) {
      selectedIps.push(checkedIps[selectedIps.length % checkedIps.length]);
    }
  }

  return selectedIps;
}

// ── 分配计划构建 ─────────────────────────────────────

/**
 * 从 FQDN 列表构建 DNS 分配计划
 *
 * Pages 源站 → A 记录指向优选 IP (proxied=false, DNS only)
 *   CF Edge 通过 SaaS Custom Hostname + Origin Rule 路由到 Pages 源站
 *
 * 非 Pages  → CNAME → 源站域名 (proxied=false)
 *   直连外部源站，不经过 CF 代理
 *
 * @param {Array} fqdnList — buildFqdnOriginMap() 的返回值
 * @param {Array} preferredIps — 优选 IP 列表
 * @returns {Array} [{ fqdn, zoneName, tokenKey, recordType, target, proxied, origin, isPages }]
 */
function buildAssignmentList(fqdnList, preferredIps) {
  // 按 zone 分组，分配 IP
  const zoneIpMap = {};
  let ipIdx = 0;

  // 先收集所有 zone
  const zones = [...new Set(fqdnList.map(f => f.zoneName))];
  for (const zone of zones) {
    const ips = preferredIps.slice(ipIdx, ipIdx + IP_PER_ZONE);
    zoneIpMap[zone] = ips;
    ipIdx += IP_PER_ZONE;
  }

  return fqdnList.map(f => {
    const pages = isPagesOrigin(f.origin);
    if (pages) {
      // Pages 源站: A 记录 → 优选 IP (proxied=false, DNS only)
      const zoneIps = zoneIpMap[f.zoneName] || [];
      // 同一 zone 内不同 prefix 使用同一组 IP，取第一个
      const targetIp = zoneIps[0] || '192.0.2.1';
      return {
        fqdn: f.fqdn,
        zoneName: f.zoneName,
        tokenKey: f.tokenKey,
        recordType: 'A',
        target: targetIp,
        proxied: false, // DNS only，用户直连优选 IP
        origin: f.origin,
        prefix: f.prefix,
        isPages: true,
      };
    } else {
      // 非 Pages 源站: CNAME → 源站域名 (proxied=false)
      return {
        fqdn: f.fqdn,
        zoneName: f.zoneName,
        tokenKey: f.tokenKey,
        recordType: 'CNAME',
        target: f.origin,
        proxied: false,
        origin: f.origin,
        prefix: f.prefix,
        isPages: false,
      };
    }
  });
}

// ── 分配计划打印 ─────────────────────────────────────

function printAssignmentPlan(assignments) {
  console.log('\n┌──────────────────────────────────────────────────────────────────┐');
  console.log('│  DNS 分配计划（优选 IP + SaaS）                                    │');
  console.log('├──────────────────────────────────────────────────────────────────┤');
  console.log('│  FQDN                              →  记录类型  目标           │');
  console.log('├──────────────────────────────────────────────────────────────────┤');

  for (const a of assignments) {
    const tag = a.proxied ? 'proxied' : 'direct';
    console.log(`│  ${a.fqdn.padEnd(34)} →  ${a.recordType} [${tag}] ${a.target.padEnd(18)} │`);
  }
  console.log('└──────────────────────────────────────────────────────────────────┘');

  const pages = assignments.filter(a => a.isPages);
  const nonPages = assignments.filter(a => !a.isPages);
  console.log(`\n  Pages 源站: ${pages.length} 个 (A 记录优选 IP, proxied=false → SaaS 路由)`);
  if (nonPages.length > 0) {
    console.log(`  非 Pages:  ${nonPages.length} 个 (CNAME proxied=false → 直连源站)`);
    for (const a of nonPages) {
      console.log(`    ${a.fqdn} → ${a.target}`);
    }
  }

  // 打印 IP 分配详情
  const zoneIpSummary = {};
  for (const a of pages) {
    if (!zoneIpSummary[a.zoneName]) zoneIpSummary[a.zoneName] = new Set();
    zoneIpSummary[a.zoneName].add(a.target);
  }
  console.log('\n  IP 分配:');
  for (const [zone, ips] of Object.entries(zoneIpSummary)) {
    console.log(`    ${zone}: ${[...ips].join(', ')}`);
  }
}

// ── DNS 同步主逻辑 ──────────────────────────────────

/**
 * 创建 A 记录
 */
async function createARecord(zoneId, name, content, tokenKey, proxied) {
  const body = { type: 'A', name, content, proxied: proxied !== undefined ? proxied : false, ttl: 1 };
  await sc.cfFetch(`/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify(body),
    tokenKey,
  });
}

/**
 * 同步 DNS 记录
 * - Pages 源站: 创建/更新 A 记录 → 优选 IP (proxied=false, DNS only)
 * - 非 Pages:   创建/更新 CNAME → 源站域名 (proxied=false)
 * - 删除所有不匹配的旧记录（A、AAAA、CNAME 等）
 */
async function syncDnsRecords(assignments) {
  const dryRun = process.env.DRY_RUN === '1';

  // 按 zone 分组
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
    console.log(`\n━━━ Zone: ${zoneName} (账户: ${tokenKey}) ━━━`);

    let zoneId;
    try {
      zoneId = await sc.getZoneId(zoneName, tokenKey);
    } catch (e) {
      console.error(`  ✗ 获取 Zone ID 失败: ${e.message}`);
      totalStats.errors += group.items.length;
      continue;
    }

    for (const a of group.items) {
      const { fqdn, target, proxied, recordType } = a;
      console.log(`\n  ▸ ${fqdn} → ${recordType} ${target} (proxied=${proxied})`);

      try {
        const records = await sc.getDnsRecords(zoneId, fqdn, tokenKey);

        // 期望的记录类型和内容
        const desiredType = recordType; // 'A' 或 'CNAME'
        const desiredContent = target;
        const desiredProxied = proxied;

        // 匹配的记录（类型 + content + proxied 都匹配）
        const matched = records.filter(r => r.type === desiredType && r.content === desiredContent && r.proxied === desiredProxied);
        // 不匹配的记录（需要删除）
        const mismatched = records.filter(r => !(r.type === desiredType && r.content === desiredContent && r.proxied === desiredProxied));

        if (matched.length > 0 && mismatched.length === 0) {
          console.log(`    ${desiredType} 记录已匹配 → 跳过`);
          totalStats.skipped++;
        } else {
          // 删除不匹配的记录
          for (const rec of mismatched) {
            console.log(`    删除 ${rec.type} 记录 → ${rec.content} (proxied=${rec.proxied}) (id: ${rec.id})`);
            if (!dryRun) await sc.deleteDnsRecord(zoneId, rec.id, tokenKey);
            totalStats.deleted++;
          }

          // 创建期望的记录（如果没有匹配的）
          if (matched.length === 0) {
            console.log(`    创建 ${desiredType} 记录 → ${desiredContent} (proxied=${desiredProxied})`);
            if (!dryRun) {
              if (desiredType === 'A') {
                await createARecord(zoneId, fqdn, desiredContent, tokenKey, desiredProxied);
              } else {
                await sc.createCnameRecord(zoneId, fqdn, desiredContent, tokenKey, desiredProxied);
              }
            }
            totalStats.created++;
          } else {
            console.log(`    ${desiredType} 记录已匹配 → 跳过`);
            totalStats.skipped++;
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

// ── 主入口 ──────────────────────────────────────────

async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  Cloudflare DNS 同步（优选 IP + SaaS 模式）    ║');
  console.log('╚════════════════════════════════════════════════╝');

  if (process.env.DRY_RUN === '1') {
    console.log('\n⚠  DRY_RUN 模式 — 仅预览，不执行任何修改\n');
  }

  // 第1步：解析配置（复用 setup-saas.js 的 buildFqdnOriginMap）
  console.log('\n── 解析域名配置 ──');
  let fqdnList = saas.buildFqdnOriginMap();
  if (fqdnList.length === 0) {
    throw new Error('未检测到任何 FQDN 配置，请检查 workers/ 下的 wrangler.toml');
  }

  // 按 TOKEN_KEY 过滤
  const filterTokenKey = process.env.TOKEN_KEY;
  if (filterTokenKey) {
    const before = fqdnList.length;
    fqdnList = fqdnList.filter(f => f.tokenKey === filterTokenKey);
    console.log(`  TOKEN_KEY=${filterTokenKey} 过滤: ${before} → ${fqdnList.length} 个 FQDN`);
  }

  if (fqdnList.length === 0) {
    console.log('  过滤后无需处理任何 FQDN');
    return;
  }
  console.log(`  共 ${fqdnList.length} 个 FQDN\n`);

  // 第2步：优选 IP 选择
  const zoneCount = [...new Set(fqdnList.filter(f => isPagesOrigin(f.origin)).map(f => f.zoneName))].length;
  let preferredIps;
  if (zoneCount > 0) {
    preferredIps = await selectPreferredIps(zoneCount);
    console.log(`\n  优选 IP: ${preferredIps.join(', ')}`);
  } else {
    preferredIps = [];
  }

  // 第3步：构建分配计划
  const assignments = buildAssignmentList(fqdnList, preferredIps);

  // 第4步：打印分配计划
  printAssignmentPlan(assignments);

  // 第5步：执行同步
  const totalStats = await syncDnsRecords(assignments);

  console.log('\n━━━ 汇总 ━━━');
  console.log(`  创建: ${totalStats.created}  删除: ${totalStats.deleted}  跳过: ${totalStats.skipped}  错误: ${totalStats.errors}`);

  if (totalStats.errors > 0) {
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
  isPagesOrigin,
  buildAssignmentList,
  syncDnsRecords,
};
