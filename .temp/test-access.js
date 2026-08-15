#!/usr/bin/env node
/**
 * 优选域名访问测试脚本
 *
 * 三层检测：
 *   1. DNS 查询：每个 FQDN 的 A 记录（去 Worker 化后用 A 记录直连优选 IP）
 *   2. HTTP 可达性：直连 IP + Host header 请求，检查 HTTP 状态
 *   3. 优选域名池检测：CNAME_POOL 中每个优选域名是否仍可用
 */

const dns = require('dns');
const https = require('https');
const http = require('http');
const sc = require('../scripts/sync-cname');

const TIMEOUT = 8000;

function dnsResolve4(domain) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve([]), TIMEOUT);
    dns.resolve4(domain, (err, addrs) => {
      clearTimeout(timer);
      resolve(err ? [] : (addrs || []));
    });
  });
}

function httpCheck(fqdn) {
  return new Promise((resolve) => {
    const url = `https://${fqdn}/`;
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };

    const req = https.request(url, {
      method: 'GET',
      timeout: TIMEOUT,
      rejectUnauthorized: false,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length >= 4096) {
          res.destroy();
          finish({ status: res.statusCode, ok: res.statusCode < 500, redirect: res.headers.location || '', snippet: body.slice(0, 200) });
        }
      });
      res.on('end', () => {
        finish({ status: res.statusCode, ok: res.statusCode < 500, redirect: res.headers.location || '', snippet: body.slice(0, 200) });
      });
    });

    req.on('timeout', () => { req.destroy(); finish({ status: 0, ok: false, error: 'timeout' }); });
    req.on('error', (e) => {
      const msg = String(e.code || e.message || '');
      if (/CERT|TLS|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(msg)) {
        finish({ status: 0, ok: true, note: 'TLS cert mismatch (network OK)' });
      } else {
        finish({ status: 0, ok: false, error: msg.slice(0, 60) });
      }
    });
    req.end();
  });
}

async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  优选域名访问测试                               ║');
  console.log('╚════════════════════════════════════════════════╝\n');

  // ── Part 1: FQDN DNS + HTTP 可达性 ──
  console.log('── Part 1: FQDN DNS + HTTP 可达性 ──\n');
  const zoneMap = sc.autoDetectZoneMap();
  const allFqdns = [];
  for (const z of zoneMap) {
    for (const name of z.names) {
      allFqdns.push({ fqdn: `${name}.${z.zoneName}`, zoneName: z.zoneName, tokenKey: z.tokenKey });
    }
  }

  const line = '─'.repeat(100);
  console.log(`┌${line}┐`);
  console.log(`│ ${'FQDN'.padEnd(30)} │ ${'A 记录'.padEnd(20)} │ ${'HTTP'.padEnd(6)} │ ${'详情'.padEnd(38)} │`);
  console.log(`├${line}┤`);

  let okCount = 0, failCount = 0, noDns = 0;

  for (const { fqdn } of allFqdns) {
    const ips = await dnsResolve4(fqdn);
    if (ips.length === 0) {
      noDns++;
      console.log(`│ ${fqdn.padEnd(30)} │ ${'(无 A 记录)'.padEnd(20)} │ ${'—'.padEnd(6)} │ ${'DNS 无法解析'.padEnd(38)} │`);
      continue;
    }

    const httpResult = await httpCheck(fqdn);
    const ipStr = ips.join(', ').slice(0, 20);
    let detail = '';
    let statusStr = '';

    if (httpResult.ok) {
      okCount++;
      statusStr = '✓';
      if (httpResult.status > 0) {
        detail = `HTTP ${httpResult.status}` + (httpResult.redirect ? ` → ${httpResult.redirect.slice(0, 20)}` : '');
      } else {
        detail = httpResult.note || httpResult.error || '';
      }
    } else {
      failCount++;
      statusStr = '✗';
      detail = httpResult.error || `HTTP ${httpResult.status}`;
    }

    console.log(`│ ${fqdn.padEnd(30)} │ ${ipStr.padEnd(20)} │ ${statusStr.padEnd(6)} │ ${detail.padEnd(38)} │`);
  }

  console.log(`└${line}┘`);
  console.log(`\n  汇总: 共 ${allFqdns.length} 个 FQDN，正常 ${okCount}，失败 ${failCount}，无 DNS ${noDns}`);

  // ── Part 2: 优选域名池检测 ──
  console.log('\n── Part 2: 优选域名池（CNAME_POOL）1034/挑战页检测 ──\n');
  const testHost = sc.buildTestHost(zoneMap);
  console.log(`  测试 Host: ${testHost}\n`);

  const poolResults = await Promise.all(
    sc.CNAME_POOL.map(async (domain) => {
      const result = await sc.checkPoolDomain(domain, testHost);
      const mark = result.ok ? '✓' : '✗';
      console.log(`  ${mark}  ${domain.padEnd(30)} ${result.reason || ''}`);
      return { domain, ...result };
    })
  );

  const validPool = poolResults.filter(r => r.ok);
  const invalidPool = poolResults.filter(r => !r.ok);
  console.log(`\n  优选域名池: ${sc.CNAME_POOL.length} 个，可用 ${validPool.length}，不可用 ${invalidPool.length}`);

  if (invalidPool.length > 0) {
    console.log('\n  不可用域名:');
    for (const r of invalidPool) {
      console.log(`    ✗ ${r.domain}: ${r.reason}`);
    }
  }

  // ── Part 3: 抽样 FQDN 实际访问测试 ──
  console.log('\n── Part 3: 抽样 FQDN 实际 HTTPS 访问 ──\n');

  // 每个 zone 取第一个 FQDN 做详细测试
  const samples = [];
  const seenZones = new Set();
  for (const { fqdn, zoneName } of allFqdns) {
    if (!seenZones.has(zoneName)) {
      seenZones.add(zoneName);
      samples.push(fqdn);
    }
  }

  for (const fqdn of samples) {
    const ips = await dnsResolve4(fqdn);
    const result = await httpCheck(fqdn);
    let line = `  ${fqdn.padEnd(30)} `;
    if (ips.length > 0) line += `IP: ${ips.join(', ').slice(0, 20).padEnd(20)} `;
    else line += `IP: (none)`.padEnd(26);

    if (result.ok) {
      line += `✓ `;
      if (result.status > 0) line += `HTTP ${result.status}`;
      else line += result.note || '';
    } else {
      line += `✗ ${result.error || 'HTTP ' + result.status}`;
    }
    console.log(line);
  }

  console.log('\n━━━ 测试完成 ━━━');
  if (failCount > 0) process.exit(1);
}

main().catch(e => {
  console.error('致命错误:', e.message);
  process.exit(1);
});
