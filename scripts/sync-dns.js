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
 *   1. 同步 DNS — 从优选域名池解析 IP，验证 1034 + 挑战页，按 IP_DEDUP_PREFIX 去重，
 *                 延迟排序，分配 A 记录，写入 Cloudflare DNS
 *   2. 检验 DNS — 对各 FQDN 做 HTTPS 连通性检测（1014/522/挑战页识别）
 *   3. 测速     — 对每个 zone 的 A 记录 IP 做下载测速（CF 官方 __down 端点），
 *                 最低 500 KB/s 达标即停，不达标自动替换下一个候选 IP
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN   — 默认 CF API Token
 *   CLOUDFLARE_API_TOKEN_2 — 账户2 Token（可选）
 *   DRY_RUN（可选）        — 设为 1 则只预览不执行修改
 *   IP_PER_ZONE（可选）    — 每 zone 分配几个 IP（默认 2）
 *   IP_DEDUP_PREFIX（可选）— IP 去重前缀长度（默认 32 = 仅去重完全相同的 IP）
 *   MIN_SPEED_KBPS（可选） — 最低速度 KB/s（默认 500）
 *   SPEED_TEST_SEC（可选） — 测速时长秒数（默认 2）
 *   MAX_LATENCY_MS（可选） — 延迟上限 ms，超过不测速（默认 300，0=不限制）
 *   SPEED_TEST_MODE（可选）— fast=达标即停 / best=全部测完选最优（默认 fast）
 *   TOKEN_KEY（可选）      — 只处理指定 tokenKey 的 zone
 *
 * 用法：
 *   node scripts/sync-dns.js             # 执行同步+检验+测速
 *   DRY_RUN=1 node scripts/sync-dns.js   # 预览模式
 */

const https = require('https');
const http = require('http');
const net = require('net');
const sc = require('./sync-cname');

// ── 配置 ─────────────────────────────────────────────
const IP_PER_ZONE = parseInt(process.env.IP_PER_ZONE || '2', 10);
const IP_DEDUP_PREFIX = parseInt(process.env.IP_DEDUP_PREFIX || '32', 10);
const MIN_SPEED_KBPS = parseInt(process.env.MIN_SPEED_KBPS || '500', 10);
const SPEED_TEST_SEC = parseInt(process.env.SPEED_TEST_SEC || '2', 10);
// 延迟上限（ms），超过的 IP 不参与测速（0 = 不限制）
const MAX_LATENCY_MS = parseInt(process.env.MAX_LATENCY_MS || '300', 10);
// 测速模式：fast = 达标即停 / best = 全部测完选最优
const SPEED_TEST_MODE = process.env.SPEED_TEST_MODE || 'fast';

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
 * 同前缀去重（prefixLen=0 时不去重，直接按延迟排序）
 */
function dedupIps(ipLatencyList, prefixLen = IP_DEDUP_PREFIX) {
  if (prefixLen === 0) {
    return [...ipLatencyList].sort((a, b) => a.latency - b.latency);
  }
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
 *
 * 使用 Cloudflare 官方测速端点 speed.cloudflare.com/__down?bytes=N
 * 通过 IP 直连 + Host 指定 speed.cloudflare.com，下载指定大小的随机数据。
 *
 * 策略：
 *   - 使用 HTTP 80 端口（speed.cloudflare.com 的 __down 端点在 443 上可能被 CF WAF 拦截，
 *     XIU2/CloudflareSpeedTest 也建议用 80 端口测速）
 *   - 每次请求 10MB，下载完自动续传，持续满测速时长
 *   - 2 个并发请求提高吞吐量测量准确性
 *   - keep-alive 复用 TCP 连接，避免反复握手开销
 *
 * 返回 { speed_kbps, downloaded, duration_ms, requests } 或 null（失败）
 */
function testDownloadSpeed(ip, testSec) {
  const SPEED_HOST = 'speed.cloudflare.com';
  // 每次请求下载 10MB 随机数据
  const CHUNK_BYTES = 10 * 1024 * 1024;
  // 测速并发数
  const CONCURRENCY = 2;
  // 测速端口（80 = HTTP，避免 443 被 CF WAF 拦截）
  const SPEED_PORT = 80;

  return new Promise((resolve) => {
    const start = Date.now();
    const durationMs = testSec * 1000;
    const timeoutMs = (testSec + 5) * 1000; // 硬超时 = 测速时长 + 5s 余量
    let settled = false;
    let totalDownloaded = 0;
    let requestCount = 0;
    let activeRequests = 0;

    // keep-alive agent 复用 TCP 连接
    const agent = new http.Agent({
      keepAlive: true,
      maxSockets: CONCURRENCY,
    });

    const cleanup = () => {
      clearTimeout(testTimer);
      clearTimeout(hardTimer);
      agent.destroy();
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const elapsedSec = Math.max((Date.now() - start) / 1000, 0.001);
      const speed_kbps = Math.round((totalDownloaded / 1024) / elapsedSec);
      resolve({ speed_kbps, downloaded: totalDownloaded, duration_ms: Date.now() - start, requests: requestCount });
    };

    // 测速时长到点后延迟一点等待在途数据统计
    const testTimer = setTimeout(() => {
      // 给在途请求 500ms 缓冲收尾
      setTimeout(finish, 500);
    }, durationMs);
    const hardTimer = setTimeout(finish, timeoutMs);

    function makeRequest() {
      if (settled) return;
      if (Date.now() - start >= durationMs) {
        if (activeRequests === 0) finish();
        return;
      }

      activeRequests++;
      requestCount++;

      const req = http.request({
        host: ip,
        port: SPEED_PORT,
        headers: { Host: SPEED_HOST },
        path: `/__down?bytes=${CHUNK_BYTES}`,
        method: 'GET',
        timeout: timeoutMs,
        agent,
      }, (res) => {
        // 非 200 响应不算有效下载
        if (res.statusCode !== 200) {
          activeRequests--;
          if (!settled) setTimeout(makeRequest, 100);
          res.resume();
          return;
        }

        res.on('data', (chunk) => {
          if (!settled) totalDownloaded += chunk.length;
        });
        res.on('end', () => {
          activeRequests--;
          if (!settled) makeRequest(); // 10MB 下载完，继续发新请求
        });
        res.on('error', () => {
          activeRequests--;
          if (!settled) makeRequest();
        });
      });

      req.on('timeout', () => { req.destroy(); });
      req.on('error', () => {
        activeRequests--;
        if (!settled) setTimeout(makeRequest, 100);
      });
      req.end();
    }

    // 并发请求
    for (let i = 0; i < CONCURRENCY; i++) {
      makeRequest();
    }
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
 * 池内 IP 经 1034 验证后按延迟排序（默认不去重），
 * 数量足够时跳过 cfIpTop20，不足时才拉取远程 Top20 补充候选。
 * 返回按延迟排序的可用 IP 列表 [{ ip, latency, source }]
 */
async function buildIpPool(testHost, needCount) {
  console.log('\n── IP 池构建 ──');
  console.log(`  测试 Host: ${testHost}`);
  const dedupDesc = IP_DEDUP_PREFIX > 0 ? `/${IP_DEDUP_PREFIX} 去重` : '不去重';
  const latencyDesc = MAX_LATENCY_MS > 0 ? `≤ ${MAX_LATENCY_MS}ms` : '不限制';
  console.log(`  去重: ${dedupDesc}`);
  console.log(`  延迟上限: ${latencyDesc}`);
  console.log(`  每 zone: ${IP_PER_ZONE} 个 IP，共需 ${needCount} 个\n`);

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

  if (rawIps.size === 0) {
    throw new Error('未能从优选域名池收集到任何 IP！');
  }

  // 第2步：逐 IP 验证 1034 + 挑战页 + 延迟
  console.log(`\n  [2] 逐 IP 质量检测（${rawIps.size} 个）...`);

  async function checkIpBatch(ipSet) {
    const ipList = [...ipSet];
    return await Promise.all(
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
  }

  let results = await checkIpBatch(rawIps);
  let good = results.filter(r => r.ok);
  let bad = results.filter(r => !r.ok);
  // 延迟上限过滤
  let filteredByLatency = 0;
  if (MAX_LATENCY_MS > 0) {
    const before = good.length;
    good = good.filter(r => r.latency <= MAX_LATENCY_MS);
    filteredByLatency = before - good.length;
  }

  for (const r of results) {
    const status = r.ok ? '✓' : '✗';
    const latencyStr = r.ok ? `${r.latency}ms` : '';
    const filtered = r.ok && MAX_LATENCY_MS > 0 && r.latency > MAX_LATENCY_MS ? ' [超延迟] ' : '';
    console.log(`  ${status}  ${r.ip.padEnd(18)} ${latencyStr.padEnd(8)} ${r.ok ? filtered : '— ' + r.reason}`);
  }

  console.log(`\n  检测结果: 可用 ${good.length} / 不可用 ${bad.length}${filteredByLatency > 0 ? ` / 超延迟 ${filteredByLatency}` : ''}`);

  // 第3步：按延迟排序（prefixLen=0 时不去重，保留全部）
  console.log(`\n  [3] ${dedupDesc}...`);
  let deduped = dedupIps(good);
  console.log(`  去重后: ${deduped.length} 个 IP（按延迟排序）`);
  for (const { ip, latency } of deduped.slice(0, 20)) {
    console.log(`    ${ip.padEnd(18)} ${latency}ms`);
  }
  if (deduped.length > 20) {
    console.log(`    ... 共 ${deduped.length} 个`);
  }

  // 第4步：去重后数量不足时才从 cfIpTop20 补充
  if (deduped.length < needCount) {
    console.log(`\n  [4] 池内仅 ${deduped.length} 个 IP，不足 ${needCount}，从 cfIpTop20 补充...`);
    try {
      const top20 = await sc.fetchCfTop20();
      // 收集新候选 IP（排除已检测过的）
      const existingIps = new Set(results.map(r => r.ip));
      const newIps = new Set();
      for (const domain of top20) {
        const ips = await sc.resolveIps(domain);
        for (const ip of ips) {
          if (!sc.is1034Ip(ip) && !existingIps.has(ip)) {
            newIps.add(ip);
          }
        }
      }
      console.log(`    cfIpTop20 新增候选: ${newIps.size} 个 IP`);

      if (newIps.size > 0) {
        const newResults = await checkIpBatch(newIps);
        for (const r of newResults) {
          const status = r.ok ? '✓' : '✗';
          const latencyStr = r.ok ? `${r.latency}ms` : '';
          const filtered = r.ok && MAX_LATENCY_MS > 0 && r.latency > MAX_LATENCY_MS ? ' [超延迟] ' : '';
          console.log(`  ${status}  ${r.ip.padEnd(18)} ${latencyStr.padEnd(8)} ${r.ok ? filtered : '— ' + r.reason}`);
        }
        let newGood = newResults.filter(r => r.ok);
        // 补充 IP 也过滤延迟
        if (MAX_LATENCY_MS > 0) {
          newGood = newGood.filter(r => r.latency <= MAX_LATENCY_MS);
        }
        results = [...results, ...newResults];
        good = [...good, ...newGood];
        deduped = dedupIps(good);
        console.log(`    补充后去重: ${deduped.length} 个 IP`);
      }
    } catch (e) {
      console.log(`    cfIpTop20 拉取失败: ${e.message}，继续用现有 IP`);
    }
  } else {
    console.log(`\n  [4] 池内 ${deduped.length} 个 IP >= 需求 ${needCount}，跳过 cfIpTop20`);
  }

  if (deduped.length === 0) {
    throw new Error('没有可用的 IP！');
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
  // 第一步：构建 IP 池（1034 验证 + 延迟排序 + 去重）
  // ═══════════════════════════════════════════════════

  console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  第一步：构建 IP 池（1034 + 延迟 + /${IP_DEDUP_PREFIX} 去重）`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const needCount = poolZones.length * IP_PER_ZONE;
  const ipPool = await buildIpPool(testHost, needCount);

  if (ipPool.length < needCount) {
    console.log(`\n  ⚠  IP 池 ${ipPool.length} 个，需求 ${needCount} 个（将跨 zone 复用）`);
  }

  // ═══════════════════════════════════════════════════
  // 第二步：测速筛选
  // fast = 从低延迟开始逐个测速，凑够 needCount 个达标即停
  // best = 全部测完后按速度排序，选最快的 needCount 个
  // ═══════════════════════════════════════════════════

  const isBestMode = SPEED_TEST_MODE === 'best';

  console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  第二步：测速筛选');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  模式: ${isBestMode ? 'best（全部测完选最优）' : 'fast（达标即停）'}`);
  console.log(`  最低速度: ${MIN_SPEED_KBPS} KB/s`);
  console.log(`  测速时长: ${SPEED_TEST_SEC}s`);
  console.log(`  需求数量: ${needCount} 个达标 IP\n`);

  const speedResults = []; // { ip, latency, speed_kbps }
  const testedIps = new Set();

  // fast 模式达标即停，best 模式测完全部
  for (const { ip, latency } of ipPool) {
    if (!isBestMode && speedResults.length >= needCount) break;

    console.log(`  ▸ ${ip}（延迟 ${latency}ms）测速...`);
    const result = await testDownloadSpeed(ip, SPEED_TEST_SEC);
    testedIps.add(ip);

    if (result) {
      const mark = result.speed_kbps >= MIN_SPEED_KBPS ? '✓' : '✗';
      console.log(`    ${mark} ${result.speed_kbps} KB/s（${(result.downloaded / 1024).toFixed(0)} KB / ${result.duration_ms}ms / ${result.requests} 请求）`);
      if (result.speed_kbps >= MIN_SPEED_KBPS) {
        speedResults.push({ ip, latency, speed_kbps: result.speed_kbps });
      }
    } else {
      console.log(`    ✗ 测速失败`);
    }
  }

  console.log(`\n  测速结果: ${speedResults.length}/${needCount} 达标`);

  // 池内 IP 测完仍不足，从 cfIpTop20 补充候选再测速
  if (speedResults.length < needCount) {
    console.log(`\n  ⚠ 池内达标 IP 不足，从 cfIpTop20 补充候选...`);
    try {
      const top20 = await sc.fetchCfTop20();
      for (const domain of top20) {
        if (!isBestMode && speedResults.length >= needCount) break;
        const ips = await sc.resolveIps(domain);
        for (const ip of ips) {
          if (!isBestMode && speedResults.length >= needCount) break;
          if (testedIps.has(ip) || sc.is1034Ip(ip)) continue;

          // 先快速验证 1034
          const check = await sc.testIp1034(ip, testHost);
          if (!check.ok) { testedIps.add(ip); continue; }

          const latency = await measureLatency(ip);
          if (latency === null) { testedIps.add(ip); continue; }
          // 延迟过滤
          if (MAX_LATENCY_MS > 0 && latency > MAX_LATENCY_MS) {
            console.log(`  ⊘ ${ip}（延迟 ${latency}ms > ${MAX_LATENCY_MS}ms，跳过）`);
            testedIps.add(ip);
            continue;
          }

          console.log(`  ▸ ${ip}（候选，延迟 ${latency}ms）测速...`);
          const result = await testDownloadSpeed(ip, SPEED_TEST_SEC);
          testedIps.add(ip);

          if (result) {
            const mark = result.speed_kbps >= MIN_SPEED_KBPS ? '✓' : '✗';
            console.log(`    ${mark} ${result.speed_kbps} KB/s（${(result.downloaded / 1024).toFixed(0)} KB / ${result.requests} 请求）`);
            if (result.speed_kbps >= MIN_SPEED_KBPS) {
              speedResults.push({ ip, latency, speed_kbps: result.speed_kbps });
            }
          } else {
            console.log(`    ✗ 测速失败`);
          }
        }
      }
      console.log(`  补充后: ${speedResults.length}/${needCount} 达标`);
    } catch (e) {
      console.log(`  cfIpTop20 拉取失败: ${e.message}，用现有达标 IP 继续`);
    }
  }

  if (speedResults.length === 0) {
    throw new Error('没有测速达标的 IP！');
  }

  // best 模式：全部测完后按速度排序，选最快的 needCount 个
  if (isBestMode && speedResults.length > needCount) {
    speedResults.sort((a, b) => b.speed_kbps - a.speed_kbps);
    console.log(`\n  best 模式: ${speedResults.length} 个达标，选最快的 ${needCount} 个`);
    speedResults.length = needCount;
    // 重新按延迟排序（分配时优先低延迟）
    speedResults.sort((a, b) => a.latency - b.latency);
  }

  if (speedResults.length < needCount) {
    console.log(`\n  ⚠ 仅 ${speedResults.length} 个达标 IP，不足 ${needCount}，将跨 zone 复用`);
  }

  // 测速结果一览
  console.log('\n  测速达标 IP:');
  for (const r of speedResults) {
    console.log(`    ✓ ${r.ip.padEnd(18)} ${r.speed_kbps} KB/s  (${r.latency}ms)`);
  }

  // ═══════════════════════════════════════════════════
  // 第三步：同步 DNS（分配 + 写入 A 记录）
  // ═══════════════════════════════════════════════════

  console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  第三步：同步 DNS（分配 + 写入 A 记录）');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const finalPool = speedResults.map(r => ({ ip: r.ip, latency: r.latency }));
  console.log('\n── Zone IP 分配 ──');
  const assignments = assignIpsToZones(filteredZones, finalPool, IP_PER_ZONE);
  printAssignmentPlan(assignments);

  const syncStats = await processARecords(assignments);

  console.log('\n━━━ 同步汇总 ━━━');
  console.log(`  创建: ${syncStats.created}  删除: ${syncStats.deleted}  跳过: ${syncStats.skipped}  错误: ${syncStats.errors}`);

  // ═══════════════════════════════════════════════════
  // 第四步：检验 DNS（连通性检测）
  // ═══════════════════════════════════════════════════

  console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  第四步：检验 DNS（连通性检测）');
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
  // 最终汇总
  // ═══════════════════════════════════════════════════

  console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  最终汇总');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  IP 池:   达标 ${speedResults.length}/${needCount}（去重后 ${ipPool.length} 个候选）`);
  console.log(`  DNS 同步: 创建 ${syncStats.created}  删除 ${syncStats.deleted}  跳过 ${syncStats.skipped}  错误 ${syncStats.errors}`);
  console.log(`  连通性:   正常 ${connOk}  异常 ${connBad}  跳过 ${connSkip}`);

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
