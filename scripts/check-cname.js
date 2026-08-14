#!/usr/bin/env node
/**
 * Cloudflare DNS CNAME 现状检查 + 1034 实测脚本
 *
 * 功能：
 *   1. 自动扫描 workers/ 下所有 wrangler.toml，提取 zones + prefixes
 *   2. 查询每个 FQDN 当前实际 CNAME 目标（优先 Cloudflare API，无 Token 时回退权威 DNS）
 *   3. 对每个 CNAME 目标做真实请求验证（1034/挑战页检测，用对应 FQDN 做 Host + SNI）
 *   4. 输出报告：哪些 FQDN 正常、哪些触发 1034/挑战页、哪些缺记录
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN  — 默认账户 Token（可选；设置后走 API 精确查询）
 *   CLOUDFLARE_API_TOKEN_2 — 账户2 Token（可选）
 *
 * 用法：
 *   node scripts/check-cname.js
 */

const sc = require('./sync-cname');
const dns = require('dns');

// ── 当前 CNAME 查询（API 优先，DNS 回退） ─────────────────

function hasToken() {
  return !!(process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN_2);
}

function dnsCname(domain) {
  return new Promise((resolve) => {
    dns.resolve(domain, 'CNAME', (err, addrs) => {
      if (err || !addrs || addrs.length === 0) return resolve([]);
      resolve(addrs.map(a => a.replace(/\.$/, '')));
    });
  });
}

async function getCurrentCname(fqdn, zoneId, tokenKey) {
  if (zoneId) {
    try {
      const records = await sc.getDnsRecords(zoneId, fqdn, tokenKey);
      const cnames = records.filter(r => r.type === 'CNAME');
      if (cnames.length > 0) return cnames.map(r => r.content);
    } catch (e) {
      console.error(`  ⚠ API 查询失败 (${fqdn}): ${e.message}，回退 DNS`);
    }
  }
  return dnsCname(fqdn);
}

// ── 1034 实测（复用 sync-cname.js 逻辑） ──────────────────

async function checkTarget(domain, testHost) {
  const ips = await sc.resolveIps(domain);
  if (ips.length === 0) {
    return { ok: false, ips: [], detail: 'NXDOMAIN（无法解析）' };
  }
  const reserved = ips.filter(ip => sc.is1034Ip(ip));
  if (reserved.length > 0) {
    return { ok: false, ips, detail: `解析到 CF 保留 IP ${reserved.join(', ')}（必 1034）` };
  }
  // 严格判定：对收集到的全部 IP 逐一实测，任一 IP 触发 1034/挑战页即标记风险
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
  console.log('║  CNAME 现状检查 + 1034/挑战页实测             ║');
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

  // 3. 展平 FQDN 并查询当前 CNAME
  const rows = [];
  for (const z of zoneMap) {
    for (const name of z.names) {
      const fqdn = `${name}.${z.zoneName}`;
      const targets = await getCurrentCname(fqdn, zoneIds[z.zoneName], z.tokenKey);
      for (const t of targets.length ? targets : [null]) {
        rows.push({ fqdn, zoneName: z.zoneName, target: t });
      }
    }
  }

  // 4. 对每个唯一目标域名做 1034 实测（用指向它的 FQDN 做测试 Host）
  const targetSet = new Set(rows.filter(r => r.target).map(r => r.target));
  const targetReport = {};
  for (const t of targetSet) {
    const testHost = rows.find(r => r.target === t).fqdn;
    targetReport[t] = await checkTarget(t, testHost);
  }

  // 5. 打印报告
  console.log('\n── 当前 CNAME 现状 + 1034/挑战页实测 ──\n');
  const line = '─'.repeat(112);
  console.log(`┌${line}┐`);
  console.log(`│ ${'FQDN'.padEnd(26)} │ ${'CNAME 目标'.padEnd(24)} │ ${'状态'.padEnd(12)} │ 详情${' '.repeat(38)}│`);
  console.log(`├${line}┤`);

  let bad = 0, missing = 0;
  for (const r of rows) {
    const rep = r.target ? targetReport[r.target] : null;
    if (!r.target) {
      missing++;
      console.log(`│ ${r.fqdn.padEnd(26)} │ ${'(无 CNAME)'.padEnd(24)} │ ${'— 缺记录'.padEnd(12)} │ ${'FQDN 无 CNAME 记录'.padEnd(40)}│`);
    } else if (!rep.ok) {
      bad++;
      console.log(`│ ${r.fqdn.padEnd(26)} │ ${r.target.padEnd(24)} │ ${'✗ 风险'.padEnd(12)} │ ${String(rep.ips.join(',') + ' ' + rep.detail).padEnd(40)}│`);
    } else {
      const detail = rep.detail === 'OK' ? rep.ips.join(',') : rep.ips.join(',') + ' ' + rep.detail;
      console.log(`│ ${r.fqdn.padEnd(26)} │ ${r.target.padEnd(24)} │ ${'✓ 正常'.padEnd(12)} │ ${String(detail).padEnd(40)}│`);
    }
  }
  console.log(`└${line}┘`);

  console.log(`\n  汇总: 共 ${rows.length} 条记录，正常 ${rows.length - bad - missing}，1034/挑战页风险 ${bad}，缺记录 ${missing}`);

  // 6. 目标域名去重统计
  console.log('\n  目标域名状态:');
  for (const [t, rep] of Object.entries(targetReport)) {
    const mark = rep.ok ? '✓' : '✗';
    const extra = rep.detail === 'OK' ? '' : `  (${rep.detail})`;
    console.log(`    ${mark}  ${t.padEnd(28)} ${rep.ips.join(', ')}${extra}`);
  }

  if (bad > 0) process.exit(2);
}

main();
