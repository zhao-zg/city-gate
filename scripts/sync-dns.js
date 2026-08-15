#!/usr/bin/env node
/**
 * Cloudflare DNS 同步 + 检验 + 测速脚本
 *
 * 当前架构：
 *   {prefix}.{zone} → A 记录 → 优选 IP（CF Anycast IP，proxied=false）
 *   noPreferred zone: CNAME → 源站
 *   Worker Route 匹配域名 → 透明转发到 *.pages.dev
 *
 * 三大功能：
 *   1. 同步 DNS — 从优选域名池解析 IP，验证 1034 + 挑战页，/24 去重，
 *                 延迟排序，分配 A 记录，写入 Cloudflare DNS
 *   2. 检验 DNS — 对各 FQDN 做 HTTPS 连通性检测（1014/522/挑战页识别）
 *   3. 测速     — 对每个 zone 的 A 记录 IP 做下载测速，
 *                 最低 500 KB/s 达标即停，不达标自动替换下一个候选 IP
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN   — 默认 CF API Token
 *   CLOUDFLARE_API_TOKEN_2 — 账户2 Token（可选）
 *   DRY_RUN（可选）        — 设为 1 则只预览不执行修改
 *   IP_PER_ZONE（可选）    — 每 zone 分配几个 IP（默认 2）
 *   IP_DEDUP_PREFIX（可选）— IP 去重前缀长度（默认 24，即 /24）
 *   MIN_SPEED_KBPS（可选） — 最低速度 KB/s（默认 500）
 *   SPEED_TEST_SEC（可选） — 测速时长秒数（默认 2）
 *   TOKEN_KEY（可选）      — 只处理指定 tokenKey 的 zone
 *
 * 用法：
 *   node scripts/sync-dns.js             # 执行同步+检验+测速
 *   DRY_RUN=1 node scripts/sync-dns.js   # 预览模式
 */

const https = require('https');
const net = require('net');
const sc = require('./sync-cname');

// ── 配置 ─────────────────────────────────────────────
const IP_PER_ZONE = parseInt(process.env.IP_PER_ZONE || '2', 10);
const IP_DEDUP_PREFIX = parseInt(process.env.IP_DEDUP_PREFIX || '24', 10);
const MIN_SPEED_KBPS = parseInt(process.env.MIN_SPEED_KBPS || '500', 10);
const SPEED_TEST_SEC = parseInt(process.env.SPEED_TEST_SEC || '2', 10);

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
      resolve(null);
    });

    socket.on('error', () => {
      socket.destroy();
      resolve(null);
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
  const byPrefix = new Map();

  for (const { ip, latency } of ipLatencyList) {
    const prefix = ipPrefix(ip, prefixLen);
    const existing = byPrefix.get(prefix);

    if (!existing || latency < existing.latency) {
      byPrefix.set(prefix, { ip, latency });
    }
  }

  return [...byPrefix.values()].sort((a, b) => a.latency - b.latency);
}

// ── 下载测速 ─────────────────────────────────────────

/**
 * 对指定 IP 做下载速度测试
 * 通过 IP 直连 + SNI/Host 指定域名，下载一段时间后计算速度
 * 返回 { speed_kbps, downloaded, duration_ms } 或 null（失败）
 */
function testDownloadSpeed(ip, testHost, testSec) {
  return new Promise((resolve) => {
    const start = Date.now();
    const timeout = (testSec + 3) * 1000; // 额外 3s 余量
    let settled = false;
    let downloaded = 0;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = https.request({
      host: ip,
      servername: testHost,
      headers: { Host: testHost },
      path: '/',
      method: 'GET',
      timeout,
      rejectUnauthorized: false,
    }, (res) => {
      // 收集数据，按时间截断
      const timer = setTimeout(() => {
        res.destroy();
        const duration = (Date.now() - start) / 1000;
        const speed_kbps = duration > 0 ? Math.round((downloaded / 1024) / duration) : 0;
        finish({ speed_kbps, downloaded, duration_ms: Date.now() - start });
      }, testSec * 1000);

      res.on('data', (chunk) => {
        downloaded += chunk.length;
      });

      res.on('end', () => {
        clearTimeout(timer);
        const duration = (Date.now() - start) / 1000;
        const speed_kbps = duration > 0 ? Math.round((downloaded / 1024) / duration) : 0;
        finish({ speed_kbps, downloaded, duration_ms: Date.now() - start });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      finish(null);
    });

    req.on('error', () => {
      finish(null);
    });

    req.end();
  });
}

// ── 连通性检测 ──────────────────────────────────────────

const CHECK_TIMEOUT = 8000;

/**
 * 检测 FQDN 连通性：HTTPS 请求到 FQDN，检查响应状态
 */
function checkConnectivity(fqdn) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };

    const req = https.request({
      hostname: fqdn,
      path: '/',
      method: 'GET',
      timeout: CHECK_TIMEOUT,
      rejectUnauthorized: false,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length >= 4096) {
          res.destroy();
          finish({ ok: true, status: res.statusCode, reason: `HTTP ${res.statusCode}` });
        }
      });
      res.on('end', () => {
        if (/error code:\s*1014|error 1014/i.test(body)) {
          finish({ ok: false, status: res.statusCode, reason: `HTTP ${res.statusCode} Error 1014` });
        } else if (/error code:\s*522|error 522/i.test(body)) {
          finish({ ok: false, status: res.statusCode, reason: `HTTP ${res.statusCode} Error 522` });
        } else if (sc.isChallengePage(res.statusCode, body)) {
          finish({ ok: false, status: res.statusCode, reason: `HTTP ${res.statusCode} 挑战页` });
        } else {
          finish({ ok: true, status: res.statusCode, reason: `HTTP ${res.statusCode}` });
        }
      });
    });

    req.on('timeout', () => { req.destroy(); finish({ ok: false, reason: '请求超时' }); });
    req.on('error', (e) => { finish({ ok: false, reason: `连接失败: ${e.message.slice(0, 60)}` }); });
    req.end();
  });
}

// ── IP 池构建 ────────────────────────────────────────

/**
 * 从优选域名池收集所有可用 IP，检测质量后排序
 * 返回按延迟排序的可用 IP 列表 [{ ip, latency, source }]
 */
async function buildIpPool(testHost) {
  console.log('\n── IP 池构建 ──');
  console.log(`  测试 Host: ${testHost}`);
  console.log(`  去重前缀: /${IP_DEDUP_PREFIX}`);
  console.log(`  每 zone: ${IP_PER_ZONE} 个 IP\n`);

  // 第1步：从 CNAME_POOL 收集 IP
  console.log('  [1] 从优选域名池解析 IP...');
  const rawIps = new Set();

  for (const domain of sc.CNAME_POOL) {
    const ips = await sc.resolveIps(domain);
    for (const ip of ips) {
      if (!sc.is1034Ip(ip)) {
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
      const check = await sc.testIp1034(ip, testHost);
      if (!check.ok) {
        return { ip, ok: false, reason: check.reason, latency: null };
      }

      const latency = await measureLatency(ip);
      if (latency === null) {
        return { ip, ok: false, reason: 'TCP 连接失败', latency: null };
      }

      return { ip, ok: true, reason: check.reason, latency };
    })
  );

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

  // 第4步：同 /24 去重，按延迟排序
  console.log(`\n  [4] 同 /${IP_DEDUP_PREFIX} 去重...`);
  const deduped = dedupIps(good);
  console.log(`  去重后: ${deduped.length} 个 IP（按延迟排序）`);
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
        ips,
      });
    }
  }

  // noPreferred zone 保持直连源站
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
        target: origin,
      });
    }
  }

  return assignments;
}

// ── DNS 记录操作 ─────────────────────────────────────

async function createARecord(zoneId, name, ip, tokenKey) {
  const body = { type: 'A', name, content: ip, proxied: false, ttl: 1 };
  await sc.cfFetch(`/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify(body),
    tokenKey,
  });
}

async function createCnameRecord(zoneId, name, target, tokenKey) {
  const body = { type: 'CNAME', name, content: target, proxied: false, ttl: 1 };
  await sc.cfFetch(`/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify(body),
    tokenKey,
  });
}

async function deleteDnsRecord(zoneId, recordId, tokenKey) {
  await sc.cfFetch(`/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE', tokenKey });
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
        console.log(`\n  ▸ ${fqdn} → [源站] ${a.target}`);
        try {
          const records = await sc.getDnsRecords(zoneId, fqdn, tokenKey);
          const cnameRecords = records.filter(r => r.type === 'CNAME');
          const matchTarget = cnameRecords.filter(r => r.content === a.target);

          if (matchTarget.length > 0) {
            console.log(`    CNAME 已指向 ${a.target} → 跳过`);
            totalStats.skipped++;
          } else {
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

        // 删除非 A 记录
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

        for (const rec of toDelete) {
          console.log(`    删除 A 记录 → ${rec.content} (id: ${rec.id})`);
          if (!dryRun) await deleteDnsRecord(zoneId, rec.id, tokenKey);
          totalStats.deleted++;
        }

        for (const ip of toCreate) {
          console.log(`    创建 A 记录 → ${ip}`);
          if (!dryRun) await createARecord(zoneId, fqdn, ip, tokenKey);
          totalStats.created++;
        }

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
  console.log('║  Cloudflare DNS 同步 + 检验 + 测速              ║');
  console.log('╚════════════════════════════════════════════════╝');

  if (process.env.DRY_RUN === '1') {
    console.log('\n⚠  DRY_RUN 模式 — 仅预览，不执行任何修改\n');
  }

  // ── 第0步：自动检测 Zone 配置 ──
  console.log('\n── 自动检测 Zone 配置 ──');
  const ZONE_MAP = sc.autoDetectZoneMap();
  if (ZONE_MAP.length === 0) {
    throw new Error('未检测到任何 Zone 配置，请检查 workers/ 下的 wrangler.toml');
  }

  // 按 TOKEN_KEY 过滤
  const filterTokenKey = process.env.TOKEN_KEY;
  let filteredZones = ZONE_MAP;
  if (filterTokenKey) {
    const before = filteredZones.length;
    filteredZones = filteredZones.filter(z => z.tokenKey === filterTokenKey);
    console.log(`  TOKEN_KEY=${filterTokenKey} 过滤: ${before} → ${filteredZones.length} 个 Zone`);
  }

  const poolZones = filteredZones.filter(z => !z.noPreferred);
  const noPrefZones = filteredZones.filter(z => z.noPreferred);
  console.log(`  共 ${filteredZones.length} 个 Zone（使用 A 记录: ${poolZones.length}，直连源站: ${noPrefZones.length}）`);

  const testHost = sc.buildTestHost(filteredZones);
  if (!testHost) {
    throw new Error('无法构建测试 Host，请检查 Zone 配置');
  }

  // ═══════════════════════════════════════════════════
  // 第一步：同步 DNS（A 记录）
  // ═══════════════════════════════════════════════════

  console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  第一步：同步 DNS（A 记录）');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const ipPool = await buildIpPool(testHost);

  if (ipPool.length < poolZones.length) {
    console.log(`\n  ⚠  IP 池仅 ${ipPool.length} 个，少于 zone 数 ${poolZones.length}，将跨 zone 复用`);
  }

  console.log('\n── Zone IP 分配 ──');
  const assignments = assignIpsToZones(filteredZones, ipPool, IP_PER_ZONE);
  printAssignmentPlan(assignments);

  const syncStats = await processARecords(assignments);

  console.log('\n━━━ 同步汇总 ━━━');
  console.log(`  创建: ${syncStats.created}  删除: ${syncStats.deleted}  跳过: ${syncStats.skipped}  错误: ${syncStats.errors}`);

  // ═══════════════════════════════════════════════════
  // 第二步：检验 DNS（连通性检测）
  // ═══════════════════════════════════════════════════

  console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  第二步：检验 DNS（连通性检测）');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 构建 FQDN 列表
  const fqdnList = [];
  for (const zone of filteredZones) {
    for (const prefix of zone.names) {
      fqdnList.push({
        fqdn: `${prefix}.${zone.zoneName}`,
        zoneName: zone.zoneName,
        tokenKey: zone.tokenKey,
        noPreferred: zone.noPreferred || false,
        origin: (zone.origins && zone.origins[prefix]) || null,
      });
    }
  }
  console.log(`  共 ${fqdnList.length} 个 FQDN\n`);

  // DNS 记录现状
  console.log('── DNS 记录现状 ──');
  const zoneGroups = {};
  for (const f of fqdnList) {
    if (!zoneGroups[f.zoneName]) {
      zoneGroups[f.zoneName] = { tokenKey: f.tokenKey, items: [] };
    }
    zoneGroups[f.zoneName].items.push(f);
  }

  for (const [zoneName, group] of Object.entries(zoneGroups)) {
    console.log(`\n  Zone: ${zoneName}`);
    let zoneId;
    try {
      zoneId = await sc.getZoneId(zoneName, group.tokenKey);
    } catch (e) {
      console.error(`    ✗ 获取 Zone ID 失败: ${e.message}`);
      continue;
    }

    for (const f of group.items) {
      try {
        const records = await sc.getDnsRecords(zoneId, f.fqdn, group.tokenKey);
        if (records.length === 0) {
          console.log(`    ⚠ ${f.fqdn}: 无 DNS 记录`);
        } else {
          for (const rec of records) {
            console.log(`    ${f.fqdn}: ${rec.type} → ${rec.content} (proxied=${rec.proxied})`);
          }
        }
      } catch (e) {
        console.error(`    ✗ ${f.fqdn} 查询失败: ${e.message}`);
      }
    }
  }

  // 连通性检测
  console.log('\n── 连通性检测 ──');
  const checkResults = [];
  for (const f of fqdnList) {
    if (f.noPreferred && !f.origin) {
      console.log(`  ⊘ ${f.fqdn} — noPreferred 无 origin，跳过`);
      checkResults.push({ fqdn: f.fqdn, ok: null, reason: 'noPreferred' });
      continue;
    }

    console.log(`  ▸ 检测 ${f.fqdn}...`);
    const r = await checkConnectivity(f.fqdn);
    checkResults.push({ fqdn: f.fqdn, ...r });
    const mark = r.ok ? '✓' : '✗';
    console.log(`    ${mark} ${r.reason}`);
  }

  const connOk = checkResults.filter(r => r.ok === true).length;
  const connBad = checkResults.filter(r => r.ok === false).length;
  const connSkip = checkResults.filter(r => r.ok === null).length;
  console.log(`\n  连通性汇总: 正常 ${connOk}  异常 ${connBad}  跳过 ${connSkip}`);

  // ═══════════════════════════════════════════════════
  // 第三步：测速（下载速度测试）
  // ═══════════════════════════════════════════════════

  console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  第三步：测速（下载速度测试）');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  最低速度: ${MIN_SPEED_KBPS} KB/s`);
  console.log(`  测速时长: ${SPEED_TEST_SEC}s`);

  // 收集所有 zone 的 A 记录 IP（去重）
  const ipSpeedMap = new Map(); // ip → speed result
  const speedReplacements = []; // 需要替换的 { fqdn, oldIp, newIp }

  for (const zone of poolZones) {
    const zoneFqdns = [];
    for (const prefix of zone.names) {
      zoneFqdns.push(`${prefix}.${zone.zoneName}`);
    }

    // 查询该 zone 当前 A 记录
    let zoneId;
    try {
      zoneId = await sc.getZoneId(zone.zoneName, zone.tokenKey);
    } catch (e) {
      console.error(`\n  ✗ Zone ${zone.zoneName} 获取 ID 失败: ${e.message}`);
      continue;
    }

    for (const fqdn of zoneFqdns) {
      let records;
      try {
        records = await sc.getDnsRecords(zoneId, fqdn, zone.tokenKey);
      } catch (e) {
        console.error(`  ✗ ${fqdn} 查询失败: ${e.message}`);
        continue;
      }

      const aRecords = records.filter(r => r.type === 'A');
      if (aRecords.length === 0) continue;

      console.log(`\n  ▸ ${fqdn}（A 记录: ${aRecords.map(r => r.content).join(', ')}）`);

      for (const rec of aRecords) {
        const ip = rec.content;

        // 缓存测速结果
        if (!ipSpeedMap.has(ip)) {
          console.log(`    测速 ${ip}...`);
          const result = await testDownloadSpeed(ip, fqdn, SPEED_TEST_SEC);
          if (result) {
            ipSpeedMap.set(ip, result);
            const mark = result.speed_kbps >= MIN_SPEED_KBPS ? '✓' : '✗';
            console.log(`    ${mark} ${ip}: ${result.speed_kbps} KB/s（${(result.downloaded / 1024).toFixed(0)} KB / ${result.duration_ms}ms）`);
          } else {
            ipSpeedMap.set(ip, null);
            console.log(`    ✗ ${ip}: 测速失败`);
          }
        }

        // 不达标 → 从候选池中找替换
        const speedResult = ipSpeedMap.get(ip);
        if (speedResult && speedResult.speed_kbps < MIN_SPEED_KBPS) {
          console.log(`    ⚠ ${ip} 不达标（${speedResult.speed_kbps} < ${MIN_SPEED_KBPS} KB/s），查找替换...`);

          // 从 ipPool 中按延迟排序找候选（排除已分配给该 zone 的 IP）
          const assignedIps = new Set(aRecords.map(r => r.content));
          const candidate = ipPool.find(c => !assignedIps.has(c.ip) && c.ip !== ip);

          if (candidate) {
            // 先测候选的速度
            if (!ipSpeedMap.has(candidate.ip)) {
              console.log(`    候选 ${candidate.ip} 测速...`);
              const candResult = await testDownloadSpeed(candidate.ip, fqdn, SPEED_TEST_SEC);
              ipSpeedMap.set(candidate.ip, candResult);
              if (candResult) {
                console.log(`    候选 ${candidate.ip}: ${candResult.speed_kbps} KB/s`);
              } else {
                console.log(`    候选 ${candidate.ip}: 测速失败`);
              }
            }

            const candSpeed = ipSpeedMap.get(candidate.ip);
            if (candSpeed && candSpeed.speed_kbps >= MIN_SPEED_KBPS) {
              console.log(`    ✓ 替换: ${ip} → ${candidate.ip}（${candSpeed.speed_kbps} KB/s）`);
              speedReplacements.push({ fqdn, zoneId, tokenKey: zone.tokenKey, oldIp: ip, newIp: candidate.ip, recordId: rec.id });
            } else {
              console.log(`    ✗ 候选 ${candidate.ip} 也不达标，保留原 IP`);
            }
          } else {
            console.log(`    ✗ 无更多候选 IP 可替换`);
          }
        }
      }
    }
  }

  // 执行替换
  if (speedReplacements.length > 0) {
    console.log('\n── 执行测速不达标 IP 替换 ──');
    const dryRun = process.env.DRY_RUN === '1';

    for (const rep of speedReplacements) {
      console.log(`  ${rep.fqdn}: ${rep.oldIp} → ${rep.newIp}`);
      if (!dryRun) {
        try {
          await deleteDnsRecord(rep.zoneId, rep.recordId, rep.tokenKey);
          await createARecord(rep.zoneId, rep.fqdn, rep.newIp, rep.tokenKey);
          console.log(`    ✓ 替换完成`);
        } catch (e) {
          console.error(`    ✗ 替换失败: ${e.message}`);
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════
  // 最终汇总
  // ═══════════════════════════════════════════════════

  console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  最终汇总');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  DNS 同步: 创建 ${syncStats.created}  删除 ${syncStats.deleted}  跳过 ${syncStats.skipped}  错误 ${syncStats.errors}`);
  console.log(`  连通性:   正常 ${connOk}  异常 ${connBad}  跳过 ${connSkip}`);
  console.log(`  测速替换: ${speedReplacements.length} 个 IP`);

  // 测速结果一览
  if (ipSpeedMap.size > 0) {
    console.log('\n  测速结果:');
    for (const [ip, result] of ipSpeedMap) {
      if (result) {
        const mark = result.speed_kbps >= MIN_SPEED_KBPS ? '✓' : '✗';
        console.log(`    ${mark} ${ip.padEnd(18)} ${result.speed_kbps} KB/s`);
      } else {
        console.log(`    ✗ ${ip.padEnd(18)} 测速失败`);
      }
    }
  }

  const hasError = syncStats.errors > 0 || connBad > 0;
  if (hasError) {
    if (connBad > 0) {
      console.log('\n  异常 FQDN:');
      for (const r of checkResults.filter(r => r.ok === false)) {
        console.log(`    ✗ ${r.fqdn}: ${r.reason}`);
      }
    }
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
  measureLatency,
  ipPrefix,
  dedupIps,
  checkConnectivity,
  testDownloadSpeed,
};
