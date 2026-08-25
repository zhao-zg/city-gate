#!/usr/bin/env node
/**
 * DNS 初始化脚本（Worker 透明传输模式）
 *
 * 新架构：
 *   用户访问 sg.1189.dpdns.org
 *     → DNS A 记录 → 优选 IP（CF Anycast IP，proxied=false）
 *     → 请求到达 CF 边缘（因为 IP 是 CF 的）
 *     → CF 匹配 Zone → 匹配 Worker Route → Worker 透明转发到 *.pages.dev
 *
 * 本脚本职责：
 *   1. 优选域名池验证（1034 检测）
 *   2. 为每个 zone 分配一个优选 IP（从池中域名解析 A 记录）
 *   3. 创建/更新 DNS A 记录（proxied=false）
 *   4. 清理旧 CNAME 记录（SaaS 模式遗留）
 *   5. noPreferred zone: CNAME 直连源站
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN   — 账户1 Token
 *   CLOUDFLARE_API_TOKEN_2 — 账户2 Token
 *   TOKEN_KEY（可选）       — 只处理指定 tokenKey 的 zone
 *   DRY_RUN（可选）        — 设为 1 则只预览不执行
 *
 * 用法：
 *   node scripts/setup-saas.js             # 执行配置
 *   DRY_RUN=1 node scripts/setup-saas.js   # 预览模式
 */

const sc = require('./sync-cname');

const dryRun = process.env.DRY_RUN === '1';

// ── DNS 记录操作（通过 sync-cname 的 provider 路由层）──
// setup-saas.js 不再直接调用 CF API，统一走 sc.* 函数，
// 由 zone 配置的 dnsProvider 决定走 CF 还是华为云

async function deleteDnsRecord(zoneId, recordId, tokenKey, dnsProvider) {
  return sc.deleteDnsRecord(zoneId, recordId, tokenKey, dnsProvider);
}

async function createARecord(zoneId, name, ip, tokenKey, dnsProvider) {
  return sc.createARecord(zoneId, name, ip, tokenKey, dnsProvider);
}

async function createCnameRecord(zoneId, name, target, tokenKey, dnsProvider) {
  return sc.createCnameRecord(zoneId, name, target, tokenKey, dnsProvider, false);
}

// ── 主逻辑 ──────────────────────────────────────────

async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  DNS 初始化脚本（Worker 透明传输模式）           ║');
  console.log('╚════════════════════════════════════════════════╝');

  if (dryRun) {
    console.log('\n⚠  DRY_RUN 模式 — 仅预览，不执行任何修改\n');
  }

  // Step 1: 自动检测 Zone 配置
  console.log('\n── 自动检测 Zone 配置 ──');
  const zoneMap = sc.autoDetectZoneMap();
  if (zoneMap.length === 0) {
    throw new Error('未检测到任何 Zone 配置，请检查 workers/ 下的 wrangler.toml');
  }
    const hwZones = zoneMap.filter(z => sc.zoneDnsProvider(z) === sc.DNS_PROVIDER_HW);
    const cfZones = zoneMap.filter(z => sc.zoneDnsProvider(z) === sc.DNS_PROVIDER_CF);
    console.log(`  共 ${zoneMap.length} 个 Zone（Cloudflare ${cfZones.length} / 华为云 ${hwZones.length}${hwZones.length > 0 ? ': ' + hwZones.map(z => z.zoneName).join(', ') : ''}）\n`);

  // Step 2: 优选域名池验证
  console.log('\n── 优选域名池验证 ──');
  const testHost = await sc.resolveTestHost(zoneMap);
  const { valid: validPool } = await sc.validatePool(sc.CNAME_POOL, testHost);

  if (validPool.length === 0) {
    throw new Error('所有优选域名均无效，无法继续！');
  }

  // 自动补充
  const poolZones = zoneMap.filter(z => !z.noPreferred);
  const finalPool = await sc.autoRefillPool(validPool, testHost, poolZones.length);

  // Step 3: 解析优选域名 → IP
  console.log('\n── 解析优选域名 IP ──');
  const preferredIps = [];
  for (const domain of finalPool) {
    const ips = await sc.resolveIps(domain);
    const safeIps = ips.filter(ip => !sc.is1034Ip(ip));
    if (safeIps.length > 0) {
      preferredIps.push(safeIps[0]);
      console.log(`  ✓ ${domain} → ${safeIps[0]}（共 ${safeIps.length} 个安全 IP）`);
    } else {
      console.log(`  ⚠ ${domain} 无安全 IP，跳过`);
    }
  }

  if (preferredIps.length === 0) {
    throw new Error('无法获取任何可用优选 IP！');
  }
  console.log(`  可用优选 IP: ${preferredIps.length} 个`);

  // Step 4: 为每个 zone 分配优选 IP 并配置 DNS
  console.log('\n── DNS 配置 ──');
  let totalErrors = 0;
  let ipIdx = 0;

  // 按 TOKEN_KEY 过滤
  const filterTokenKey = process.env.TOKEN_KEY;

  for (const zone of zoneMap) {
    if (filterTokenKey && zone.tokenKey !== filterTokenKey) continue;

    const zoneName = zone.zoneName;
    const tokenKey = zone.tokenKey || 'default';
    const dnsProvider = sc.zoneDnsProvider(zone);
    const provTag = dnsProvider === sc.DNS_PROVIDER_HW ? ' [华为云DNS]' : '';

    // 华为云 zone 在无 AK/SK 时跳过（CI 环境不配置华为云密钥，由 Docker cron 负责同步）
    if (dnsProvider === sc.DNS_PROVIDER_HW && (!process.env.HUAWEICLOUD_DNS_AK || !process.env.HUAWEICLOUD_DNS_SK)) {
      console.log(`\n━━━ Zone: ${zoneName}${provTag} ━━━`);
      console.log(`  ⊘ 跳过 — 华为云 DNS 环境变量未配置（CI 由 Docker cron 同步）`);
      continue;
    }

    console.log(`\n━━━ Zone: ${zoneName} (账户: ${tokenKey})${provTag} ━━━`);

    let zoneId;
    try {
      zoneId = await sc.getZoneId(zoneName, tokenKey, dnsProvider);
    } catch (e) {
      console.error(`  ✗ 获取 Zone ID 失败: ${e.message}`);
      totalErrors++;
      continue;
    }

    // 为该 zone 选一个优选 IP
    const preferredIp = preferredIps[ipIdx % preferredIps.length];
    ipIdx++;

    for (const prefix of zone.names) {
      const fqdn = `${prefix}.${zoneName}`;

      // 自引用 FQDN（FQDN = origin 主机名，如 answer.07170501.xyz）跳过，
      // 保留现有 DNS 记录直连源站，避免 Worker 回源死循环
      const origin = (zone.origins && zone.origins[prefix]) || null;
      if (origin && fqdn === origin) {
        console.log(`\n  ▸ ${fqdn} → [自引用 origin] 跳过，保留现有记录`);
        continue;
      }

      // noPreferred zone: CNAME → 源站
      if (zone.noPreferred) {
        if (!origin) {
          console.log(`  ⚠ ${fqdn}: noPreferred 但无 origin，跳过`);
          continue;
        }
        console.log(`\n  ▸ ${fqdn} → CNAME ${origin} (proxied=false)`);
        try {
          const records = await sc.getDnsRecords(zoneId, fqdn, tokenKey, dnsProvider);
          // 清理旧 A 记录
          for (const rec of records.filter(r => r.type === 'A')) {
            console.log(`    删除旧 A → ${rec.content}`);
            if (!dryRun) await deleteDnsRecord(zoneId, rec.id, tokenKey, dnsProvider);
          }
          // 检查 CNAME
          const matched = records.filter(r => r.type === 'CNAME' && r.content === origin && !r.proxied);
          if (matched.length > 0) {
            console.log(`    CNAME 已匹配 → 跳过`);
          } else {
            for (const rec of records.filter(r => r.type === 'CNAME')) {
              console.log(`    删除旧 CNAME → ${rec.content}`);
              if (!dryRun) await deleteDnsRecord(zoneId, rec.id, tokenKey, dnsProvider);
            }
            console.log(`    创建 CNAME → ${origin}`);
            if (!dryRun) await createCnameRecord(zoneId, fqdn, origin, tokenKey, dnsProvider);
          }
        } catch (e) {
          console.error(`    ✗ 失败: ${e.message}`);
          totalErrors++;
        }
        continue;
      }

      // 正常 zone: A 记录 → 优选 IP (proxied=false)
      console.log(`\n  ▸ ${fqdn} → A ${preferredIp} (proxied=false)`);
      try {
        const records = await sc.getDnsRecords(zoneId, fqdn, tokenKey, dnsProvider);
        // 清理旧 CNAME（SaaS 遗留）
        for (const rec of records.filter(r => r.type === 'CNAME')) {
          console.log(`    删除旧 CNAME → ${rec.content}`);
          if (!dryRun) await deleteDnsRecord(zoneId, rec.id, tokenKey, dnsProvider);
        }
        // 检查 A 记录
        const matched = records.filter(r => r.type === 'A' && r.content === preferredIp && !r.proxied);
        if (matched.length > 0) {
          console.log(`    A 记录已匹配 → 跳过`);
        } else {
          for (const rec of records.filter(r => r.type === 'A')) {
            console.log(`    删除旧 A → ${rec.content}`);
            if (!dryRun) await deleteDnsRecord(zoneId, rec.id, tokenKey, dnsProvider);
          }
          console.log(`    创建 A 记录 → ${preferredIp}`);
          if (!dryRun) await createARecord(zoneId, fqdn, preferredIp, tokenKey, dnsProvider);
        }
      } catch (e) {
        console.error(`    ✗ 失败: ${e.message}`);
        totalErrors++;
      }
    }
  }

  // 汇总
  console.log('\n━━━ 汇总 ━━━');
  console.log(`  DNS 配置${totalErrors > 0 ? ` ⚠ ${totalErrors} 个错误` : ' ✓ 完成'}`);

  if (totalErrors > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error('致命错误:', e.message);
    process.exit(1);
  });
}
