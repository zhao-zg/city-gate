#!/usr/bin/env node
/**
 * Cloudflare DNS A 记录同步脚本（直连 CF 边缘 IP，不再依赖优选域名）
 *
 * 核心思路：
 *   从优选域名池解析出 CF 边缘 IP，验证 1034 + 挑战页 + 延迟后，
 *   直接写入 A 记录，消除 CNAME 链不确定性。
 *
 * 与 sync-cname.js 的关系：
 *   - 复用 sync-cname.js 的 IP 收集/检测函数（require 导入）
 *   - 新增延迟测量、IP 去重、A 记录同步逻辑
 *   - sync-cname.js 保留作为 CNAME 模式 fallback
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN   — 默认 Cloudflare API Token（需 Zone:DNS:Edit 权限）
 *   CLOUDFLARE_API_TOKEN_2 — 账户2的 API Token（可选）
 *   DRY_RUN（可选）        — 设为 1 则只预览不执行
 *   IP_PER_ZONE（可选）     — 每 zone 分配几个 IP（默认 2）
 *   IP_DEDUP_PREFIX（可选）— IP 去重的前缀长度（默认 24，即 /24）
 *
 * 用法：
 *   node scripts/sync-dns.js             # 执行同步
 *   DRY_RUN=1 node scripts/sync-dns.js   # 预览模式
 */

const https = require('https');
const net = require('net');
const sc = require('./sync-cname');

// ── 配置 ─────────────────────────────────────────────
const IP_PER_ZONE = parseInt(process.env.IP_PER_ZONE || '2', 10);
const IP_DEDUP_PREFIX = parseInt(process.env.IP_DEDUP_PREFIX || '24', 10);
const POOL_MIN_IPS = 12; // IP 池最小可用数量（6 zone × 2，留余量）

// ── IP 质量检测 ──────────────────────────────────────

/**
 * 测量 TCP 握手延迟（ms）
 * 只测 TCP 连接速度，不发送 HTTP 请求，快速且不影响 CF 计数
 */
function measureLatency(ip, port = 443) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(4000);

    socket.on('connect', () => {
      const latency = Date.now() - start;
      socket.destroy();
      resolve(latency);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(null); // 超时 = 不可用
    });

    socket.on('error', () => {
      socket.destroy();
      resolve(null); // 连接失败 = 不可用
    });

    socket.connect(port, ip);
  });
}

/**
 * 提取 IP 的 /N 前缀（用于去重）
 * 如 172.64.152.241 + /24 → "172.64.152"
 */
function ipPrefix(ip, prefixLen) {
  const parts = ip.split('.');
  if (parts.length !== 4) return ip;
  const prefixParts = Math.floor(prefixLen / 8);
  return parts.slice(0, prefixParts).join('.');
}

/**
 * 同前缀去重：同 /24 段只保留延迟最低的 IP
 * 避免 CF 边缘 IP 集中在同一段，提高容灾
 */
function dedupIps(ipLatencyList, prefixLen = IP_DEDUP_PREFIX) {
  const byPrefix = new Map(); // prefix → { ip, latency }

  for (const { ip, latency } of ipLatencyList) {
    const prefix = ipPrefix(ip, prefixLen);
    const existing = byPrefix.get(prefix);

    if (!existing || latency < existing.latency) {
      byPrefix.set(prefix, { ip, latency });
    }
  }

  return [...byPrefix.values()].sort((a, b) => a.latency - b.latency);
}

// ── IP 池构建 ────────────────────────────────────────

/**
 * 从优选域名池收集所有可用 IP，检测质量后排序
 * 返回按延迟排序的可用 IP 列表 [{ ip, latency, source }]
 */
async function buildIpPool(testHost, poolZonesCount = 1) {
  console.log('\n── IP 池构建 ──');
  console.log(`  测试 Host: ${testHost}`);
  console.log(`  去重前缀: /${IP_DEDUP_PREFIX}`);
  console.log(`  每 zone: ${IP_PER_ZONE} 个 IP`);
  console.log(`  最少需要: ${poolZonesCount * IP_PER_ZONE} 个 IP\n`);

  // 第1步：从 CNAME_POOL 收集 IP（复用 resolveIps）
  console.log('  [1] 从优选域名池解析 IP...');
  const rawIps = new Set();

  for (const domain of sc.CNAME_POOL) {
    const ips = await sc.resolveIps(domain);
    for (const ip of ips) {
      if (!sc.is1034Ip(ip)) { // 排除已知保留 IP
        rawIps.add(ip);
      }
    }
    console.log(`    ${domain.padEnd(32)} → ${ips.length} 个 IP`);
  }

  // 第2步：从 cfIpTop20 补充 IP
  console.log(`\n  [2] 从 cfIpTop20 补充 IP...`);
  try {
    const top20 = await sc.fetchCfTop20();
    for (const domain of top20) {
      const ips = await sc.resolveIps(domain);
      for (const ip of ips) {
        if (!sc.is1034Ip(ip)) {
          rawIps.add(ip);
        }
      }
    }
    console.log(`    cfIpTop20 补充后总计: ${rawIps.size} 个唯一 IP`);
  } catch (e) {
    console.log(`    cfIpTop20 拉取失败: ${e.message}，继续用池内 IP`);
  }

  if (rawIps.size === 0) {
    throw new Error('未能收集到任何 IP！');
  }

  // 第3步：逐 IP 验证 1034 + 挑战页 + 延迟
  console.log(`\n  [3] 逐 IP 质量检测（${rawIps.size} 个）...`);
  const ipList = [...rawIps];

  const results = await Promise.all(
    ipList.map(async (ip) => {
      // 验证 1034 + 挑战页（复用 testIp1034）
      const check = await sc.testIp1034(ip, testHost);
      if (!check.ok) {
        return { ip, ok: false, reason: check.reason, latency: null };
      }

      // 测量延迟
      const latency = await measureLatency(ip);
      if (latency === null) {
        return { ip, ok: false, reason: 'TCP 连接失败', latency: null };
      }

      return { ip, ok: true, reason: check.reason, latency };
    })
  );

  // 打印检测结果
  const good = results.filter(r => r.ok);
  const bad = results.filter(r => !r.ok);

  for (const r of results) {
    const status = r.ok ? '✓' : '✗';
    const latencyStr = r.ok ? `${r.latency}ms` : '';
    console.log(`  ${status}  ${r.ip.padEnd(18)} ${latencyStr.padEnd(8)} ${r.ok ? '' : '— ' + r.reason}`);
  }

  console.log(`\n  检测结果: 可用 ${good.length} / 不可用 ${bad.length}`);

  if (good.length === 0) {
    throw new Error('没有可用的 IP！');
  }

  // 第4步：自适应去重，按延迟排序
  // 如果 /N 去重后数量不够（少于 zone 数 × IP_PER_ZONE），自动放宽前缀长度
  const minNeeded = poolZonesCount * IP_PER_ZONE;
  let deduped = [];
  let curPrefix = IP_DEDUP_PREFIX;
  const validPrefixes = [32, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16];

  // 从用户配置的前缀开始，逐步放宽直到数量够或到 /16
  const startIdx = validPrefixes.indexOf(IP_DEDUP_PREFIX);
  for (let i = (startIdx >= 0 ? startIdx : 0); i < validPrefixes.length; i++) {
    const p = validPrefixes[i];
    deduped = dedupIps(good, p);
    console.log(`  [4] /${p} 去重 → ${deduped.length} 个 IP${deduped.length >= minNeeded ? ' ✓' : ' (不够，继续放宽)'}`);
    if (deduped.length >= minNeeded) break;
  }

  // 放宽到极限还是不够，用全部可用 IP（不去重）
  if (deduped.length < minNeeded) {
    console.log(`  ⚠  去重后仅 ${deduped.length} 个，少于需求 ${minNeeded} 个，保留全部可用 IP`);
    deduped = good.slice().sort((a, b) => a.latency - b.latency);
  }

  console.log(`  最终: ${deduped.length} 个 IP（按延迟排序）`);
  for (const { ip, latency } of deduped.slice(0, 20)) {
    console.log(`    ${ip.padEnd(18)} ${latency}ms`);
  }
  if (deduped.length > 20) {
    console.log(`    ... 共 ${deduped.length} 个`);
  }

  return deduped;
}

// ── Zone 分配 ───────────────────────────────────────

/**
 * 为每个 zone 分配 IP 组
 * 不同 zone 尽量分到不同 IP，实现容灾
 * IP 不够时允许跨 zone 复用（轮转分配）
 */
function assignIpsToZones(zoneMap, ipPool, ipPerZone) {
  const poolZones = zoneMap.filter(z => !z.noPreferred);
  const assignments = [];

  for (let zi = 0; zi < poolZones.length; zi++) {
    const zone = poolZones[zi];
    const ips = [];

    for (let j = 0; j < ipPerZone; j++) {
      const idx = (zi * ipPerZone + j) % ipPool.length;
      ips.push(ipPool[idx].ip);
    }

    for (const name of zone.names) {
      assignments.push({
        fqdn: `${name}.${zone.zoneName}`,
        zoneName: zone.zoneName,
        name,
        tokenKey: zone.tokenKey,
        ips, // 该 FQDN 的 A 记录目标 IP 列表
      });
    }
  }

  // noPreferred zone 保持直连源站（CNAME 模式不变）
  for (const zone of zoneMap) {
    if (!zone.noPreferred) continue;
    for (const name of zone.names) {
      const origin = (zone.origins && zone.origins[name]) || null;
      if (!origin) {
        console.log(`  ⚠ ${name}.${zone.zoneName} 无对应源站 origin，跳过`);
        continue;
      }
      assignments.push({
        fqdn: `${name}.${zone.zoneName}`,
        zoneName: zone.zoneName,
        name,
        tokenKey: zone.tokenKey,
        direct: true,
        target: origin, // 直连源站 CNAME
      });
    }
  }

  return assignments;
}

// ── DNS 记录操作 ─────────────────────────────────────

const CF_API = 'https://api.cloudflare.com/client/v4';

function getToken(tokenKey) {
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

async function createARecord(zoneId, name, ip, tokenKey) {
  const body = { type: 'A', name, content: ip, proxied: false, ttl: 1 };
  await cfFetch(`/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify(body),
    tokenKey,
  });
}

async function createCnameRecord(zoneId, name, target, tokenKey) {
  const body = { type: 'CNAME', name, content: target, proxied: false, ttl: 1 };
  await cfFetch(`/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify(body),
    tokenKey,
  });
}

async function deleteDnsRecord(zoneId, recordId, tokenKey) {
  await cfFetch(`/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE', tokenKey });
}

// ── 分配计划打印 ─────────────────────────────────────

function printAssignmentPlan(assignments) {
  console.log('\n┌──────────────────────────────────────────────────────────────────┐');
  console.log('│  A 记录分配计划                                                  │');
  console.log('├──────────────────────────────────────────────────────────────────┤');
  console.log('│  FQDN                              →  IP 记录                   │');
  console.log('├──────────────────────────────────────────────────────────────────┤');

  for (const a of assignments) {
    if (a.direct) {
      console.log(`│  ${a.fqdn.padEnd(34)} →  [源站] ${a.target.padEnd(24)} │`);
    } else {
      const ipsStr = a.ips.join(', ');
      console.log(`│  ${a.fqdn.padEnd(34)} →  [A] ${ipsStr.padEnd(26)} │`);
    }
  }
  console.log('└──────────────────────────────────────────────────────────────────┘');

  // 按 IP 分组统计
  const byIp = {};
  for (const a of assignments) {
    if (a.direct) continue;
    for (const ip of a.ips) {
      byIp[ip] = (byIp[ip] || 0) + 1;
    }
  }
  console.log('\n  IP 分配统计:');
  for (const [ip, count] of Object.entries(byIp).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${ip.padEnd(18)} × ${count}`);
  }
}

// ── DNS 同步主逻辑 ──────────────────────────────────

async function processARecords(assignments) {
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
    console.log(`\n━━━ Zone: ${zoneName}${tokenKey ? ` (账户: ${tokenKey})` : ''} ━━━`);

    let zoneId;
    try {
      zoneId = await sc.getZoneId(zoneName, tokenKey);
    } catch (e) {
      console.error(`  ✗ 获取 Zone ID 失败: ${e.message}`);
      totalStats.errors += group.items.length;
      continue;
    }

    for (const a of group.items) {
      const { fqdn } = a;

      if (a.direct) {
        // noPreferred zone: CNAME 直连源站（保持原逻辑）
        console.log(`\n  ▸ ${fqdn} → [源站] ${a.target}`);
        try {
          const records = await sc.getDnsRecords(zoneId, fqdn, tokenKey);
          const cnameRecords = records.filter(r => r.type === 'CNAME');
          const matchTarget = cnameRecords.filter(r => r.content === a.target);

          if (matchTarget.length > 0) {
            console.log(`    CNAME 已指向 ${a.target} → 跳过`);
            totalStats.skipped++;
          } else {
            // 删除旧记录（CNAME 或其他）
            for (const rec of records) {
              console.log(`    删除旧记录 ${rec.type} → ${rec.content} (id: ${rec.id})`);
              if (!dryRun) await deleteDnsRecord(zoneId, rec.id, tokenKey);
              totalStats.deleted++;
            }
            console.log(`    创建 CNAME → ${a.target}`);
            if (!dryRun) await createCnameRecord(zoneId, fqdn, a.target, tokenKey);
            totalStats.created++;
          }
        } catch (e) {
          console.error(`    ✗ 处理失败: ${e.message}`);
          totalStats.errors++;
        }
        continue;
      }

      // A 记录模式
      const targetIps = a.ips;
      console.log(`\n  ▸ ${fqdn} → [A] ${targetIps.join(', ')}`);

      try {
        const records = await sc.getDnsRecords(zoneId, fqdn, tokenKey);
        const aRecords = records.filter(r => r.type === 'A');
        const cnameRecords = records.filter(r => r.type === 'CNAME');
        const otherRecords = records.filter(r => r.type !== 'A' && r.type !== 'CNAME');

        // 删除非 A 记录（CNAME 迁移 + 其他类型清理）
        // 注意：DNS 规范不允许 CNAME 和 A 共存，必须先删 CNAME
        for (const rec of [...cnameRecords, ...otherRecords]) {
          console.log(`    删除 ${rec.type} 记录 → ${rec.content} (id: ${rec.id})`);
          if (!dryRun) await deleteDnsRecord(zoneId, rec.id, tokenKey);
          totalStats.deleted++;
        }

        // 对比 A 记录
        const existingIps = aRecords.map(r => r.content);
        const targetSet = new Set(targetIps);
        const existingSet = new Set(existingIps);

        const toDelete = aRecords.filter(r => !targetSet.has(r.content));
        const toCreate = targetIps.filter(ip => !existingSet.has(ip));
        const matched = aRecords.filter(r => targetSet.has(r.content));

        // 删除不匹配的 A 记录
        for (const rec of toDelete) {
          console.log(`    删除 A 记录 → ${rec.content} (id: ${rec.id})`);
          if (!dryRun) await deleteDnsRecord(zoneId, rec.id, tokenKey);
          totalStats.deleted++;
        }

        // 创建缺少的 A 记录
        for (const ip of toCreate) {
          console.log(`    创建 A 记录 → ${ip}`);
          if (!dryRun) await createARecord(zoneId, fqdn, ip, tokenKey);
          totalStats.created++;
        }

        // 全部匹配
        if (toDelete.length === 0 && toCreate.length === 0) {
          console.log(`    A 记录已匹配 → 跳过`);
          totalStats.skipped++;
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
  console.log('║  Cloudflare DNS A 记录同步脚本（直连 IP 版）     ║');
  console.log('╚════════════════════════════════════════════════╝');

  if (process.env.DRY_RUN === '1') {
    console.log('\n⚠  DRY_RUN 模式 — 仅预览，不执行任何修改\n');
  }

  // 第0步：自动检测 Zone 配置
  console.log('\n── 自动检测 Zone 配置 ──');
  const ZONE_MAP = sc.autoDetectZoneMap();
  if (ZONE_MAP.length === 0) {
    throw new Error('未检测到任何 Zone 配置，请检查 workers/ 下的 wrangler.toml');
  }
  console.log(`  共 ${ZONE_MAP.length} 个 Zone`);

  const poolZones = ZONE_MAP.filter(z => !z.noPreferred);
  const noPrefZones = ZONE_MAP.filter(z => z.noPreferred);
  console.log(`  使用 A 记录: ${poolZones.length} 个 Zone`);
  if (noPrefZones.length > 0) {
    console.log(`  直连源站: ${noPrefZones.length} 个 Zone (noPreferred)`);
  }

  // 构建测试 Host（用于 1034/挑战页验证）
  const testHost = sc.buildTestHost(ZONE_MAP);
  if (!testHost) {
    throw new Error('无法构建测试 Host，请检查 Zone 配置');
  }

  // 第1步：构建 IP 池
  const ipPool = await buildIpPool(testHost, poolZones.length);

  if (ipPool.length < poolZones.length) {
    console.log(`\n  ⚠  IP 池仅 ${ipPool.length} 个，少于 zone 数 ${poolZones.length}，将跨 zone 复用`);
  }

  // 第2步：分配 IP
  console.log('\n── Zone IP 分配 ──');
  const assignments = assignIpsToZones(ZONE_MAP, ipPool, IP_PER_ZONE);

  // 第3步：打印分配计划
  printAssignmentPlan(assignments);

  // 第4步：执行同步
  const totalStats = await processARecords(assignments);

  console.log('\n━━━ 汇总 ━━━');
  console.log(`  创建: ${totalStats.created}  删除: ${totalStats.deleted}  跳过: ${totalStats.skipped}  错误: ${totalStats.errors}`);

  if (totalStats.errors > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

// ── 导出 ──
module.exports = {
  measureLatency,
  ipPrefix,
  dedupIps,
  buildIpPool,
  assignIpsToZones,
  processARecords,
};
