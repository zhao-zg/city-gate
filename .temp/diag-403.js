#!/usr/bin/env node
/**
 * 诊断 403 问题：测试不同 Host header 直连 CF Edge 的响应
 *
 * 测试矩阵：
 *   1. 直接访问 Pages 源站（https://sg-f3b.pages.dev/）
 *   2. Host: sg.1189.dpdns.org  （用户实际访问的域名）
 *   3. Host: o-sg.1189.dpdns.org （SaaS 回源的 origin CNAME）
 *   4. Host: sg-f3b.pages.dev    （Pages 源站域名）
 *
 * 每种 Host 用同一批优选 IP 直连测试，对比响应。
 */

const https = require('https');
const dns = require('dns');

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

function requestWithHost(ip, host, path = '/') {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    let body = '';

    const req = https.request({
      host: ip,
      servername: host,
      headers: { Host: host, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' },
      path,
      method: 'GET',
      timeout: TIMEOUT,
      rejectUnauthorized: false,
    }, (res) => {
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length >= 8192) {
          res.destroy();
          finish({ status: res.statusCode, headers: res.headers, body: body.slice(0, 500) });
        }
      });
      res.on('end', () => {
        finish({ status: res.statusCode, headers: res.headers, body: body.slice(0, 500) });
      });
    });

    req.on('timeout', () => { req.destroy(); finish({ status: 0, error: 'timeout' }); });
    req.on('error', (e) => {
      const msg = String(e.code || e.message || '');
      if (/CERT|TLS|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(msg)) {
        finish({ status: 0, error: 'TLS cert mismatch (network may be OK)' });
      } else {
        finish({ status: 0, error: msg.slice(0, 80) });
      }
    });
    req.end();
  });
}

async function main() {
  // 取一个 FQDN 的优选 IP 做测试
  const testFqdn = 'sg.1189.dpdns.org';
  const originCname = 'o-sg.1189.dpdns.org';
  const pagesDomain = 'sg-f3b.pages.dev';

  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  403 诊断：Host header 对比测试                  ║');
  console.log('╚════════════════════════════════════════════════╝\n');

  // 获取 IP
  const fqdnIps = await dnsResolve4(testFqdn);
  const originIps = await dnsResolve4(originCname);
  const pagesIps = await dnsResolve4(pagesDomain);

  console.log(`FQDN A 记录:      ${testFqdn} → ${fqdnIps.join(', ')}`);
  console.log(`Origin CNAME A:  ${originCname} → ${originIps.join(', ')}`);
  console.log(`Pages 源站 A:     ${pagesDomain} → ${pagesIps.join(', ')}\n`);

  const testIp = fqdnIps[0] || originIps[0] || pagesIps[0];
  console.log(`使用测试 IP: ${testIp}\n`);

  // 测试矩阵
  const hosts = [
    { name: 'Pages 源站域名', host: pagesDomain, ip: pagesIps[0] || testIp },
    { name: '用户 FQDN', host: testFqdn, ip: fqdnIps[0] || testIp },
    { name: 'Origin CNAME', host: originCname, ip: originIps[0] || testIp },
    { name: 'FQDN via FQDN IP', host: testFqdn, ip: fqdnIps[0] || testIp },
    { name: 'Origin CNAME via FQDN IP', host: originCname, ip: fqdnIps[0] || testIp },
    { name: 'Pages via FQDN IP', host: pagesDomain, ip: fqdnIps[0] || testIp },
  ];

  console.log('── 直连测试（IP + Host header）──\n');
  const line = '─'.repeat(90);
  console.log(`┌${line}┐`);
  console.log(`│ ${'测试场景'.padEnd(28)} │ ${'IP'.padEnd(18)} │ ${'Host'.padEnd(24)} │ ${'HTTP'.padEnd(5)} │ ${'Server / 详情'.padEnd(20)} │`);
  console.log(`├${line}┤`);

  for (const t of hosts) {
    const r = await requestWithHost(t.ip, t.host);
    const status = r.status > 0 ? String(r.status) : (r.error || 'ERR');
    const server = r.headers?.server || r.headers?.['cf-ray'] || '';
    let detail = '';
    if (r.status === 403) {
      // 检查是否是 CF 挑战页或普通 403
      if (/cf-browser|challenge|Just a moment/i.test(r.body || '')) {
        detail = 'CF 挑战页';
      } else if (/error code:\s*\d+/i.test(r.body || '')) {
        const m = (r.body || '').match(/error code:\s*(\d+)/i);
        detail = m ? `CF Error ${m[1]}` : 'CF 403';
      } else {
        detail = (r.body || '').slice(0, 80).replace(/\n/g, ' ');
      }
    } else if (r.status === 200) {
      detail = 'OK (200)';
    } else if (r.status > 0) {
      detail = (r.body || '').slice(0, 60).replace(/\n/g, ' ');
    } else {
      detail = r.error || '';
    }

    console.log(`│ ${t.name.padEnd(28)} │ ${t.ip.padEnd(18)} │ ${t.host.padEnd(24)} │ ${status.padEnd(5)} │ ${detail.padEnd(20)} │`);
  }
  console.log(`└${line}┘`);

  // 直接用 Node fetch 访问 Pages 源站
  console.log('\n── 直接 HTTPS 访问（无自定义 Host）──\n');

  for (const url of [`https://${pagesDomain}/`, `https://${originCname}/`, `https://${testFqdn}/`]) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT),
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      const text = await res.text().catch(() => '');
      const server = res.headers.get('server') || '';
      const cfRay = res.headers.get('cf-ray') || '';
      let bodySnippet = text.slice(0, 150).replace(/\n/g, ' ');
      console.log(`  ${url}`);
      console.log(`    → HTTP ${res.status} (server: ${server}, cf-ray: ${cfRay})`);
      console.log(`    → body: ${bodySnippet}\n`);
    } catch (e) {
      console.log(`  ${url}`);
      console.log(`    → ERROR: ${e.message}\n`);
    }
  }

  // 测试更多 zone 的 FQDN
  console.log('\n── 多 zone 抽样对比（FQDN vs Origin CNAME vs Pages）──\n');

  const samples = [
    { zone: '1189.dpdns.org', prefix: 'sg', pages: 'sg-f3b.pages.dev' },
    { zone: 'zzg.cc.cd', prefix: 'sg', pages: 'sg-f3b.pages.dev' },
    { zone: 'zhaozg.de5.net', prefix: 'sg', pages: 'sg-7gj.pages.dev' },
    { zone: '1189.kdns.fr', prefix: 'books', pages: 'books-em3.pages.dev' },
  ];

  for (const s of samples) {
    const fqdn = `${s.prefix}.${s.zone}`;
    const ocname = `o-${s.prefix}.${s.zone}`;
    const ips = await dnsResolve4(fqdn);

    const r1 = await requestWithHost(ips[0] || testIp, fqdn);
    const r2 = await requestWithHost(ips[0] || testIp, ocname);
    const r3 = await requestWithHost(ips[0] || testIp, s.pages);

    const s1 = r1.status > 0 ? String(r1.status) : 'ERR';
    const s2 = r2.status > 0 ? String(r2.status) : 'ERR';
    const s3 = r3.status > 0 ? String(r3.status) : 'ERR';

    console.log(`  ${fqdn}`);
    console.log(`    IP: ${ips.join(', ')}`);
    console.log(`    Host=${fqdn.padEnd(24)} → HTTP ${s1}`);
    console.log(`    Host=${ocname.padEnd(24)} → HTTP ${s2}`);
    console.log(`    Host=${s.pages.padEnd(24)} → HTTP ${s3}`);
    console.log();
  }

  console.log('━━━ 诊断完成 ━━━');
}

main().catch(e => { console.error('致命错误:', e); process.exit(1); });
