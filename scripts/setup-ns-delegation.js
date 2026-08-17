#!/usr/bin/env node
/**
 * setup-ns-delegation.js
 *
 * 在 Cloudflare 上为华为云 DNS 托管的 zone 的子域名创建 NS 委托记录。
 *
 * 为什么需要：
 *   zzgxxx.eu.org 整体 NS 托管在 Cloudflare。
 *   要将子域名 DNS 解析切到华为云，需要在 CF 的 Zone 下为每个子域名
 *   创建 NS 记录指向华为云 NS 服务器（子域名 NS 委托 / Subdomain Delegation）。
 *   NS 委托后，该子域名的 DNS 解析由华为云负责，A 记录在华为云管理。
 *
 * 做什么：
 *   1. 从 wrangler.toml 提取 dnsProvider=huaweicloud 的 zone 及其子域名
 *   2. 在 CF 上为每个子域名创建 4 条 NS 记录指向华为云 NS 服务器
 *   3. 删除 CF 上这些子域名的旧 A 记录（避免解析冲突：CF A 记录 vs 华为云 A 记录）
 *   4. 已存在且正确的 NS 记录跳过（幂等）
 *
 * 注意事项：
 *   - NS 委托是 Zone 级操作，在 CF Zone 的 DNS 记录中添加 NS 类型记录
 *   - NS 记录的 name 是子域名（如 sg.zzgxxx.eu.org），content 是 NS 服务器
 *   - 删除旧 A 记录必须同批完成，否则 CF 会优先返回 A 记录（不委托）
 *   - NS 委托后 DNS 传播需要时间（TTL 依赖 CF Zone 的 NS 记录 TTL）
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN — CF API Token（需 Zone > DNS > Edit 权限）
 *   DRY_RUN（可选）      — 设为 1 则只预览不执行
 *
 * 用法：
 *   node scripts/setup-ns-delegation.js
 *   DRY_RUN=1 node scripts/setup-ns-delegation.js
 */

const sc = require('./sync-cname');

const CF_API = 'https://api.cloudflare.com/client/v4';

// 华为云 DNS 公网 Zone 的 NS 服务器（固定 4 个）
const HW_NS_SERVERS = [
  'ns1.huaweicloud-dns.com',
  'ns1.huaweicloud-dns.cn',
  'ns1.huaweicloud-dns.net',
  'ns1.huaweicloud-dns.org',
];

const dryRun = process.env.DRY_RUN === '1';

// ── CF API 封装 ──────────────────────────────────────

async function cfFetch(path, options = {}) {
  const tokenKey = options.tokenKey || 'default';
  const token = sc.getToken(tokenKey);
  if (!token) throw new Error(`API Token 未设置 (key: ${tokenKey})`);

  const { tokenKey: _, ...fetchOptions } = options;
  const res = await fetch(`${CF_API}${path}`, {
    ...fetchOptions,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Connection: 'close',
      ...fetchOptions.headers,
    },
  });

  const json = await res.json();
  if (!json.success) {
    const err = json.errors?.map(e => `${e.code}:${e.message}`).join('; ') || '未知错误';
    throw new Error(`Cloudflare API 错误: ${err} (path: ${path})`);
  }
  return json;
}

// ── 主逻辑 ──────────────────────────────────────────

async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  NS 委托配置（CF → 华为云 DNS 子域名委托）       ║');
  console.log('╚════════════════════════════════════════════════╝');

  if (dryRun) {
    console.log('\n⚠  DRY_RUN 模式 — 仅预览，不执行任何修改\n');
  }

  console.log(`\n  华为云 NS 服务器: ${HW_NS_SERVERS.join(', ')}`);

  // Step 1: 自动检测 Zone 配置
  console.log('\n── 自动检测 Zone 配置 ──');
  const zoneMap = sc.autoDetectZoneMap();
  if (zoneMap.length === 0) {
    throw new Error('未检测到任何 Zone 配置，请检查 workers/ 下的 wrangler.toml');
  }

  // 只处理华为云 DNS 的 zone
  const hwZones = zoneMap.filter(z => sc.zoneDnsProvider(z) === sc.DNS_PROVIDER_HW);
  if (hwZones.length === 0) {
    console.log('  无华为云 DNS zone，跳过');
    return;
  }
  console.log(`  华为云 DNS zone: ${hwZones.map(z => z.zoneName).join(', ')}`);

  let totalNsCreated = 0;
  let totalNsSkipped = 0;
  let totalADeleted = 0;
  let totalErrors = 0;

  for (const zone of hwZones) {
    const zoneName = zone.zoneName;
    console.log(`\n━━━ Zone: ${zoneName} ━━━`);

    // 获取 CF Zone ID（华为云 zone 的 NS 委托在 CF Zone 上操作，需要 CF Zone ID）
    let zoneId;
    try {
      zoneId = await sc.getZoneId(zoneName, zone.tokenKey || 'default', sc.DNS_PROVIDER_CF);
    } catch (e) {
      console.error(`  ✗ 获取 CF Zone ID 失败: ${e.message}`);
      totalErrors += zone.names.length;
      continue;
    }
    console.log(`  CF Zone ID: ${zoneId}`);

    for (const prefix of zone.names) {
      const fqdn = `${prefix}.${zoneName}`;
      console.log(`\n  ▸ ${fqdn}`);

      try {
        // 查询该 FQDN 的所有 DNS 记录
        const records = await sc.getDnsRecords(zoneId, fqdn, zone.tokenKey || 'default', sc.DNS_PROVIDER_CF);

        // 分类：现有 NS 记录、A 记录、其他
        const nsRecords = records.filter(r => r.type === 'NS');
        const aRecords = records.filter(r => r.type === 'A');
        const otherRecords = records.filter(r => r.type !== 'NS' && r.type !== 'A');

        // Step A: 删除旧 A 记录（避免与华为云 A 记录冲突）
        // NS 委托后，该子域名的解析应由华为云负责。
        // 如果 CF 上还保留 A 记录，CF 会直接返回 A 记录（不委托到华为云），
        // 导致解析仍在 CF。必须删除 A 记录，只保留 NS 记录。
        if (aRecords.length > 0) {
          console.log(`    删除 ${aRecords.length} 条旧 A 记录:`);
          for (const rec of aRecords) {
            console.log(`      A ${fqdn} → ${rec.content} (id: ${rec.id})`);
            if (!dryRun) {
              await sc.deleteDnsRecord(zoneId, rec.id, zone.tokenKey || 'default', sc.DNS_PROVIDER_CF);
            }
            totalADeleted++;
          }
        }

        // 删除其他非 NS 记录（如 CNAME）
        if (otherRecords.length > 0) {
          console.log(`    删除 ${otherRecords.length} 条其他记录:`);
          for (const rec of otherRecords) {
            console.log(`      ${rec.type} ${fqdn} → ${rec.content} (id: ${rec.id})`);
            if (!dryRun) {
              await sc.deleteDnsRecord(zoneId, rec.id, zone.tokenKey || 'default', sc.DNS_PROVIDER_CF);
            }
          }
        }

        // Step B: 创建/检查 NS 记录
        const existingNs = new Set(nsRecords.map(r => r.content.toLowerCase().replace(/\.$/, '')));
        const neededNs = HW_NS_SERVERS.filter(ns => !existingNs.has(ns.toLowerCase()));

        if (neededNs.length === 0 && nsRecords.length >= HW_NS_SERVERS.length) {
          console.log(`    ✓ NS 记录已完整（${nsRecords.length} 条）→ 跳过`);
          totalNsSkipped++;
        } else {
          // 有缺失的 NS 记录，需要创建
          if (nsRecords.length > 0 && neededNs.length > 0) {
            console.log(`    补充 ${neededNs.length} 条缺失的 NS 记录（已有 ${nsRecords.length} 条）`);
          } else if (nsRecords.length > 0) {
            console.log(`    NS 记录已完整但数量不一致，补充中`);
          }

          for (const ns of neededNs) {
            console.log(`    创建 NS 记录: ${fqdn} → ${ns}`);
            if (!dryRun) {
              await cfFetch(`/zones/${zoneId}/dns_records`, {
                method: 'POST',
                body: JSON.stringify({
                  type: 'NS',
                  name: fqdn,
                  content: ns,
                  ttl: 1, // Auto TTL
                }),
                tokenKey: zone.tokenKey || 'default',
              });
            }
            totalNsCreated++;
          }

          // 如果所有 NS 记录都是新创建的（原来没有任何 NS 记录）
          if (nsRecords.length === 0) {
            console.log(`    ✓ 已创建 ${HW_NS_SERVERS.length} 条 NS 记录`);
          }
        }

      } catch (e) {
        console.error(`    ✗ 失败: ${e.message}`);
        totalErrors++;
      }
    }
  }

  // 汇总
  console.log('\n━━━ 汇总 ━━━');
  console.log(`  NS 记录: 创建 ${totalNsCreated}  跳过 ${totalNsSkipped}`);
  console.log(`  A 记录删除: ${totalADeleted}`);
  console.log(`  错误: ${totalErrors}`);

  if (totalErrors > 0) {
    process.exit(1);
  }

  console.log('\n  NS 委托配置完成。DNS 传播需要几分钟到数小时。');
  console.log('  可用以下命令验证子域名是否走华为云解析:');
  console.log('    dig sg.zzgxxx.eu.org NS');
}

if (require.main === module) {
  main().catch(e => {
    console.error('致命错误:', e.message);
    process.exit(1);
  });
}
