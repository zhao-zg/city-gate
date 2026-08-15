#!/usr/bin/env node
/**
 * Cloudflare DNS 现状检查脚本（A 记录 + 1034 实测）
 *
 * 功能：
 *   1. 自动扫描 workers/ 下所有 wrangler.toml，提取 zones + prefixes
 *   2. 查询每个 FQDN 当前实际 DNS 记录（A 记录优先，兼容 CNAME）
 *   3. 对 A 记录 IP 做 1034/挑战页实测
 *   4. 输出报告：哪些 FQDN 正常、哪些触发 1034/挑战页、哪些缺记录
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN  — 默认账户 Token（可选；设置后走 API 精确查询）
 *   CLOUDFLARE_API_TOKEN_2 — 账户2 Token（可选）
 *
 * 用法：
 *   node scripts/check-dns.js
 */

const sc = require('./sync-cname');
const dns = require('dns');

// ── 当前 DNS 记录查询（API 优先，DNS 回退） ─────────────────

function hasToken() {
  return !!(process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN_2);
}

function dnsResolve(domain, type) {
  return new Promise((resolve) => {
    dns.resolve(domain, type, (err, addrs) => {
      if (err || !addrs || addrs.length === 0) return resolve([]);
      resolve(addrs);
    });
  });
}

/**
 * 查询 FQDN 的当前 DNS 记录（A + CNAME）
 * 返回 { aRecords: string[], cnameRecords: string[] }
 */
async function getCurrentDns(fqdn, zoneId, tokenKey) {
  const result = { aRecords: [], cnameRecords: [] };

  // API 模式：精确查询
  if (zoneId) {
    try {
      const records = await sc.getDnsRecords(zoneId, fqdn, tokenKey);
      for (const r of records) {
        if (r.type === 'A') result.aRecords.push(r.content);
        else if (r.type === 'CNAME') result.cnameRecords.push(r.content);
      }
      return result;
    } catch (e) {
      console.error(`  ⚠ API 查询失败 (${fqdn}): ${e.message}，回退 DNS`);
    }
  }

  // DNS 回退
  result.aRecords = await dnsResolve(fqdn, 'A');
  result.cnameRecords = await dnsResolve(fqdn, 'CNAME');
  return result;
}

// ── 1034 实测（复用 sync-cname.js 逻辑） ──────────────────

async function checkARecord(ip, testHost) {
  // 先检查是否是 CF 保留 IP
  if (sc.is1034Ip(ip)) {
    return { ok: false, reason: 'CF 保留 IP（必 1034）' };
  }
  // 实测
  const r = await sc.testIp1034(ip, testHost);
  return r;
}

async function checkCnameTarget(domain, testHost) {
  const ips = await sc.resolveIps(domain);
  if (ips.length === 0) {
    return { ok: false, ips: [], detail: 'NXDOMAIN（无法解析）' };
  }
  const reserved = ips.filter(ip => sc.is1034Ip(ip));
  if (reserved.length > 0) {
    return { ok: false, ips, detail: `解析到 CF 保留 IP ${reserved.join(', ')}（必 1034）` };
  }
  const checks = await Promise.all(ips.map(async (ip) => {
    const r = await sc.testIp1034(ip, testHost);
    return { ip, ...r };
  }));
  const good = checks.filter(r => r.ok);
  const bad = checks.filter(r => !r.ok);
  if (bad.length === 0) {
    return { ok: true, ips, detail: 'OK' };
  }
  if (good.length === 0) {
    return { ok: false, ips, detail: `全部 ${checks.length} 个 IP 不可用: ${bad.map(r => r.ip + ' ' + r.reason).join('; ')}` };
  }
  return { ok: false, ips, detail: `⚠ 混合池 ${bad.length}/${checks.length} IP 不可用: ${bad.map(r => r.ip + ' ' + r.reason).join('; ')}` };
}

// ── 主流程 ─────────────────────────────────────────────

async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  DNS 现状检查 + 1034/挑战页实测                ║');
  console.log('╚════════════════════════════════════════════════╝');

  const useApi = hasToken();
  console.log(useApi
    ? '\n  模式: Cloudflare API（精确查询）'
    : '\n  模式: 权威 DNS（未检测到 API Token，走 DNS 查询）\n  提示: 设置 CLOUDFLARE_API_TOKEN 后重跑可走 API');

  // 1. 扫描 zone map
  console.log('\n── 自动检测 Zone 配置 ──');
  const zoneMap = sc.autoDetectZoneMap();
  console.log(`  共 ${zoneMap.length} 个 Zone\n`);

  // 2. 预取 zoneId（API 模式）
  const zoneIds = {};
  if (useApi) {
    for (const z of zoneMap) {
      try {
        zoneIds[z.zoneName] = await sc.getZoneId(z.zoneName, z.tokenKey);
      } catch (e) {
        console.error(`  ✗ 获取 Zone ID 失败 (${z.zoneName}): ${e.message}`);
      }
    }
  }

  // 3. 展平 FQDN 并查询当前 DNS 记录
  const rows = [];
  for (const z of zoneMap) {
    for (const name of z.names) {
      const fqdn = `${name}.${z.zoneName}`;
      const dnsResult = await getCurrentDns(fqdn, zoneIds[z.zoneName], z.tokenKey);
      rows.push({ fqdn, zoneName: z.zoneName, ...dnsResult });
    }
  }

  // 4. 对 A 记录 IP 做 1034 实测
  const aIpReport = {};
  for (const row of rows) {
    for (const ip of row.aRecords) {
      if (!aIpReport[ip]) {
        const r = await checkARecord(ip, row.fqdn);
        aIpReport[ip] = r;
      }
    }
  }

  // 5. 对 CNAME 目标做 1034 实测
  const cnameTargetReport = {};
  for (const row of rows) {
    for (const target of row.cnameRecords) {
      if (!cnameTargetReport[target]) {
        cnameTargetReport[target] = await checkCnameTarget(target, row.fqdn);
      }
    }
  }

  // 6. 打印报告
  console.log('\n── DNS 现状 + 1034/挑战页实测 ──\n');
  const line = '─'.repeat(120);
  console.log(`┌${line}┐`);
  console.log(`│ ${'FQDN'.padEnd(26)} │ ${'类型'.padEnd(4)} │ ${'记录值'.padEnd(28)} │ ${'状态'.padEnd(8)} │ 详情${' '.repeat(34)}│`);
  console.log(`├${line}┤`);

  let bad = 0, missing = 0;
  for (const r of rows) {
    if (r.aRecords.length === 0 && r.cnameRecords.length === 0) {
      missing++;
      console.log(`│ ${r.fqdn.padEnd(26)} │ ${'—'.padEnd(4)} │ ${'(无记录)'.padEnd(28)} │ ${'缺记录'.padEnd(8)} │ ${'FQDN 无 A/CNAME 记录'.padEnd(36)}│`);
    }
    for (const ip of r.aRecords) {
      const rep = aIpReport[ip];
      if (!rep) continue;
      const ok = rep.ok;
      if (!ok) bad++;
      const status = ok ? '✓ 正常' : '✗ 风险';
      const detail = ok ? ip : `${ip} ${rep.reason || ''}`;
      console.log(`│ ${r.fqdn.padEnd(26)} │ ${'A'.padEnd(4)} │ ${ip.padEnd(28)} │ ${status.padEnd(8)} │ ${String(detail).padEnd(36)}│`);
    }
    for (const target of r.cnameRecords) {
      const rep = cnameTargetReport[target];
      if (!rep) continue;
      if (!rep.ok) bad++;
      const status = rep.ok ? '✓ 正常' : '✗ 风险';
      const detail = rep.detail === 'OK' ? (rep.ips || []).join(',') : (rep.ips || []).join(',') + ' ' + rep.detail;
      console.log(`│ ${r.fqdn.padEnd(26)} │ ${'CNA'.padEnd(4)} │ ${target.padEnd(28)} │ ${status.padEnd(8)} │ ${String(detail).slice(0, 36).padEnd(36)}│`);
    }
  }
  console.log(`└${line}┘`);

  const total = rows.length;
  console.log(`\n  汇总: 共 ${total} 条 FQDN，缺记录 ${missing}，1034/挑战页风险 ${bad}，正常 ${total - bad - missing}`);

  if (bad > 0) process.exit(2);
}

main();
