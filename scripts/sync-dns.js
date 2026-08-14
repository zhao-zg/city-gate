#!/usr/bin/env node
/**
 * Cloudflare DNS 同步脚本（SaaS A 记录模式）
 *
 * 架构：
 *   Pages 源站 → A 记录 192.0.2.1 (proxied=true)
 *     CF Edge 收到请求后通过 SaaS Custom Hostname 路由到 origin CNAME → Pages 源站
 *     注意：不能用 CNAME 指向同 zone 内的 o-{prefix}.{zone}（都 proxied=true 会触发 1014）
 *     A 记录 192.0.2.1 (RFC 5737 保留 IP) 与 Fallback Origin 使用相同占位 IP
 *
 *   非 Pages 源站 → CNAME → 源站域名 (proxied=false)
 *     直连外部源站，不经过 CF 代理
 *
 * 与 setup-saas.js 的关系：
 *   setup-saas.js: SaaS 配置（Custom Hostnames + origin CNAME + Fallback Origin + Pages 自定义域名）
 *   sync-dns.js:   用户域名 DNS 记录同步（A 记录占位 或 CNAME 直连）
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN   — 默认 CF API Token（需 Zone:DNS:Edit 权限）
 *   CLOUDFLARE_API_TOKEN_2 — 账户2 Token（可选）
 *   DRY_RUN（可选）       — 设为 1 则只预览不执行
 *   TOKEN_KEY（可选）     — 只处理指定 tokenKey 的 zone（'default' 或 'account2'）
 *
 * 用法：
 *   node scripts/sync-dns.js             # 执行同步
 *   DRY_RUN=1 node scripts/sync-dns.js   # 预览模式
 */

const sc = require('./sync-cname');
const saas = require('./setup-saas');

const PLACEHOLDER_IP = '192.0.2.1'; // RFC 5737 保留 IP，与 Fallback Origin 一致

// ── 工具函数 ──────────────────────────────────────────

/**
 * 判断是否为 Pages 源站（origin 以 .pages.dev 结尾）
 */
function isPagesOrigin(origin) {
  return origin.endsWith('.pages.dev');
}

// ── 分配计划构建 ─────────────────────────────────────

/**
 * 从 FQDN 列表构建 DNS 分配计划
 *
 * Pages 源站 → A 记录 192.0.2.1 (proxied=true)
 *   CF Edge 通过 SaaS Custom Hostname 路由到 origin CNAME → Pages 源站
 *   不使用 CNAME → o-{prefix}.{zone}，避免同 zone proxied CNAME 链触发 1014
 *
 * 非 Pages  → CNAME → 源站域名 (proxied=false)
 *   直连外部源站，不经过 CF 代理
 *
 * @param {Array} fqdnList — buildFqdnOriginMap() 的返回值
 * @returns {Array} [{ fqdn, zoneName, tokenKey, recordType, target, proxied, origin, isPages }]
 */
function buildAssignmentList(fqdnList) {
  return fqdnList.map(f => {
    const pages = isPagesOrigin(f.origin);
    if (pages) {
      // Pages 源站: A 记录 → 192.0.2.1 (proxied=true)
      // CF Edge 通过 SaaS Custom Hostname 路由，DNS 只需让流量到达 CF Edge
      return {
        fqdn: f.fqdn,
        zoneName: f.zoneName,
        tokenKey: f.tokenKey,
        recordType: 'A',
        target: PLACEHOLDER_IP,
        proxied: true,
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
  console.log('│  DNS 分配计划                                                    │');
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
  console.log(`\n  Pages 源站: ${pages.length} 个 (A 记录 ${PLACEHOLDER_IP} proxied=true → SaaS 路由)`);
  if (nonPages.length > 0) {
    console.log(`  非 Pages:  ${nonPages.length} 个 (CNAME proxied=false → 直连源站)`);
    for (const a of nonPages) {
      console.log(`    ${a.fqdn} → ${a.target}`);
    }
  }
}

// ── DNS 同步主逻辑 ──────────────────────────────────

/**
 * 创建 A 记录
 */
async function createARecord(zoneId, name, content, tokenKey) {
  const body = { type: 'A', name, content, proxied: true, ttl: 1 };
  await sc.cfFetch(`/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify(body),
    tokenKey,
  });
}

/**
 * 同步 DNS 记录
 * - Pages 源站: 创建/更新 A 记录 → 192.0.2.1 (proxied=true)
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
        // Pages: A 记录，content=192.0.2.1，proxied=true
        // 非 Pages: CNAME 记录，content=源站域名，proxied=false
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
                await createARecord(zoneId, fqdn, desiredContent, tokenKey);
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
  console.log('║  Cloudflare DNS 同步（SaaS A 记录模式）         ║');
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

  // 按 TOKEN_KEY 过滤（CI 多账户 Job 隔离 / Docker 单账户运行）
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

  // 第2步：构建分配计划
  const assignments = buildAssignmentList(fqdnList);

  // 第3步：打印分配计划
  printAssignmentPlan(assignments);

  // 第4步：执行同步
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
  PLACEHOLDER_IP,
};
