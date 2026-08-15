#!/usr/bin/env node
/**
 * Cloudflare DNS 检测脚本（Worker 透明传输模式）
 *
 * 当前架构：
 *   {prefix}.{zone} → A 记录 → 优选 IP（CF Anycast IP，proxied=false）
 *   noPreferred zone: CNAME → 源站
 *   Worker Route 匹配域名 → 透明转发到 *.pages.dev
 *
 * 本脚本做连通性检测，不修改 DNS 记录。
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN   — 默认 CF API Token
 *   CLOUDFLARE_API_TOKEN_2 — 账户2 Token（可选）
 *   TOKEN_KEY（可选）     — 只检测指定 tokenKey 的 zone
 *
 * 用法：
 *   node scripts/sync-dns.js
 */

const sc = require('./sync-cname');
const https = require('https');

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
        // 检测 CF 错误页
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

// ── 主入口 ──────────────────────────────────────────

async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  Cloudflare DNS 检测（Worker 透明传输模式）      ║');
  console.log('╚════════════════════════════════════════════════╝');

  // 解析配置
  console.log('\n── 解析域名配置 ──');
  const zoneMap = sc.autoDetectZoneMap();
  if (zoneMap.length === 0) {
    throw new Error('未检测到任何 Zone 配置，请检查 workers/ 下的 wrangler.toml');
  }

  // 按 TOKEN_KEY 过滤
  const filterTokenKey = process.env.TOKEN_KEY;
  let filteredZones = zoneMap;
  if (filterTokenKey) {
    const before = filteredZones.length;
    filteredZones = filteredZones.filter(z => z.tokenKey === filterTokenKey);
    console.log(`  TOKEN_KEY=${filterTokenKey} 过滤: ${before} → ${filteredZones.length} 个 Zone`);
  }

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

  if (fqdnList.length === 0) {
    console.log('  无 FQDN 需检测');
    return;
  }
  console.log(`  共 ${fqdnList.length} 个 FQDN\n`);

  // DNS 记录查询
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
            const type = rec.type === 'A' ? 'A' : rec.type;
            console.log(`    ${f.fqdn}: ${type} → ${rec.content} (proxied=${rec.proxied})`);
          }
        }
      } catch (e) {
        console.error(`    ✗ ${f.fqdn} 查询失败: ${e.message}`);
      }
    }
  }

  // 连通性检测
  console.log('\n── 连通性检测 ──');
  const results = [];
  for (const f of fqdnList) {
    if (f.noPreferred && !f.origin) {
      console.log(`  ⊘ ${f.fqdn} — noPreferred 无 origin，跳过`);
      results.push({ fqdn: f.fqdn, ok: null, reason: 'noPreferred' });
      continue;
    }

    console.log(`  ▸ 检测 ${f.fqdn}...`);
    const r = await checkConnectivity(f.fqdn);
    results.push({ fqdn: f.fqdn, ...r });
    const mark = r.ok ? '✓' : '✗';
    console.log(`    ${mark} ${r.reason}`);
  }

  // 汇总
  console.log('\n━━━ 汇总 ━━━');
  const ok = results.filter(r => r.ok === true).length;
  const bad = results.filter(r => r.ok === false).length;
  const skipped = results.filter(r => r.ok === null).length;
  console.log(`  正常: ${ok}  异常: ${bad}  跳过: ${skipped}`);

  if (bad > 0) {
    console.log('\n  异常 FQDN:');
    for (const r of results.filter(r => r.ok === false)) {
      console.log(`    ✗ ${r.fqdn}: ${r.reason}`);
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
  checkConnectivity,
};
