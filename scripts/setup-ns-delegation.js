#!/usr/bin/env node
/**
 * setup-ns-delegation.js
 *
 * 在 Cloudflare 上为华为云 DNS 托管的 zone 的子域名创建 NS 委托记录。
 *
 * 前置条件：
 *   setup-pages-domains.js 必须先运行完成，且 Pages 自定义域名状态已变 active。
 *   即 CF DNS 上已有 CNAME(proxied=true) → pages.dev，Pages 自定义域名 SSL 证书已签发。
 *
 * 做什么：
 *   1. 验证所有 Pages 子域名的自定义域名状态为 active（SSL 证书已签发）
 *   2. 在 CF 上为每个子域名创建 4 条 NS 记录指向华为云 NS 服务器
 *   3. 不删除 CNAME 记录（CNAME 保留在 CF DNS 中，NS 委托后华为云 DNS 接管解析）
 *   4. 已存在且完整的 NS 记录跳过（幂等）
 *
 * 为什么不删除 CNAME：
 *   NS 委托后，该子域名的 DNS 解析由华为云负责（华为云 A 记录指向 CF Anycast IP）。
 *   CF 上保留的 CNAME 不影响解析——递归解析器看到 NS 记录后会向华为云查询，
 *   不会查询 CF 上的 CNAME。保留 CNAME 是为了：
 *     - 如果将来需要回退（删除 NS 委托），CF 上的 CNAME 仍在，可立即恢复 Pages 路由
 *     - Pages 自定义域名需要 CNAME 存在才能保持验证状态
 *
 * 注意事项：
 *   - NS 委托是 Zone 级操作，在 CF Zone 的 DNS 记录中添加 NS 类型记录
 *   - NS 记录的 name 是子域名（如 sg.zzgxxx.eu.org），content 是 NS 服务器
 *   - NS 委托后 DNS 传播需要时间（TTL 依赖 CF Zone 的 NS 记录 TTL）
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN — CF API Token（需 Zone > DNS > Edit + Account > Cloudflare Pages > Read 权限）
 *   DRY_RUN（可选）      — 设为 1 则只预览不执行
 *   SKIP_VERIFY（可选）  — 设为 1 则跳过 Pages 自定义域名状态验证（调试用）
 *
 * 用法：
 *   node scripts/setup-ns-delegation.js
 *   DRY_RUN=1 node scripts/setup-ns-delegation.js
 *   SKIP_VERIFY=1 node scripts/setup-ns-delegation.js
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
const skipVerify = process.env.SKIP_VERIFY === '1';

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

// ── Account ID 获取 ──────────────────────────────────

let _accountId = null;

async function getAccountId() {
  if (_accountId) return _accountId;
  const zoneMap = sc.autoDetectZoneMap();
  for (const zone of zoneMap) {
    if (sc.zoneDnsProvider(zone) !== sc.DNS_PROVIDER_CF) continue;
    try {
      const json = await cfFetch(`/zones?name=${zone.zoneName}`);
      if (json.result?.[0]?.account?.id) {
        _accountId = json.result[0].account.id;
        console.log(`  Account ID: ${_accountId} (from zone ${zone.zoneName})`);
        return _accountId;
      }
    } catch (_) { /* 忽略 */ }
  }
  const json = await cfFetch('/accounts');
  if (json.result?.[0]?.id) {
    _accountId = json.result[0].id;
    return _accountId;
  }
  throw new Error('无法获取 Account ID，请检查 Token 权限');
}

// ── Pages 自定义域名状态查询 ──────────────────────────

async function listPagesDomains(accountId, projectName) {
  const json = await cfFetch(`/accounts/${accountId}/pages/projects/${projectName}/domains`);
  return json.result || [];
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

  // Step 2: 提取 prefix → pages_project 映射（用于验证 Pages 自定义域名状态）
  const fs = require('fs');
  const path = require('path');
  const workersDir = path.join(__dirname, '..', 'workers');
  const prefixToPages = new Map();
  const prefixToOrigin = new Map();

  const dirs = fs.readdirSync(workersDir)
    .filter(name => fs.existsSync(path.join(workersDir, name, 'wrangler.toml')));

  for (const dir of dirs) {
    const tomlText = fs.readFileSync(path.join(workersDir, dir, 'wrangler.toml'), 'utf8');
    const config = sc.parseDomainConfig(tomlText);
    if (!config || !config.groups) continue;

    for (const group of config.groups) {
      const zones = group.zones || config.zones;
      for (const zone of zones) {
        const zoneName = sc.zoneNameOf(zone);
        if (!zoneName) continue;
        if (sc.zoneDnsProvider(zone) !== sc.DNS_PROVIDER_HW) continue;
        if (group.pages_project) {
          prefixToPages.set(group.prefix, { pages_project: group.pages_project, zone_name: zoneName });
        } else if (group.origin) {
          prefixToOrigin.set(group.prefix, { origin: group.origin, zone_name: zoneName });
        }
      }
    }
  }

  // Step 3: 验证 Pages 自定义域名状态（除非 SKIP_VERIFY）
  if (!skipVerify && prefixToPages.size > 0) {
    console.log('\n── 验证 Pages 自定义域名状态 ──');
    const accountId = await getAccountId();

    let allActive = true;
    let pendingList = [];

    for (const [prefix, info] of prefixToPages) {
      const fqdn = `${prefix}.${info.zone_name}`;
      try {
        const domains = await listPagesDomains(accountId, info.pages_project);
        const domain = domains.find(d => d.name === fqdn);
        if (!domain) {
          console.log(`  ✗ ${fqdn}: Pages 自定义域名不存在（请先运行 setup-pages-domains.js）`);
          allActive = false;
          pendingList.push(fqdn);
        } else if (domain.status === 'active') {
          console.log(`  ✓ ${fqdn}: active`);
        } else {
          console.log(`  ⏳ ${fqdn}: ${domain.status || 'pending'}（SSL 证书签发中）`);
          allActive = false;
          pendingList.push(fqdn);
        }
      } catch (e) {
        console.log(`  ⚠ ${fqdn}: 查询失败 (${e.message})，继续处理`);
      }
    }

    if (!allActive) {
      console.log(`\n  ⚠ 有 ${pendingList.length} 个子域名的 Pages 自定义域名尚未 active:`);
      console.log(`    ${pendingList.join(', ')}`);
      console.log('  SSL 证书签发通常需要几分钟到几小时。');
      console.log('  请等待状态变 active 后重新运行本脚本。');
      console.log('  或设置 SKIP_VERIFY=1 跳过验证（不推荐）。');
      process.exit(1);
    }
    console.log('  全部 Pages 自定义域名状态为 active');
  } else if (skipVerify) {
    console.log('\n  ⚠ SKIP_VERIFY=1，跳过 Pages 自定义域名状态验证');
  }

  // Step 4: 创建 NS 委托记录
  console.log('\n── NS 委托配置 ──');
  let totalNsCreated = 0;
  let totalNsSkipped = 0;
  let totalErrors = 0;

  for (const zone of hwZones) {
    const zoneName = zone.zoneName;
    console.log(`\n━━━ Zone: ${zoneName} ━━━`);

    // 获取 CF Zone ID
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

        // 分类：现有 NS 记录、CNAME 记录、其他
        const nsRecords = records.filter(r => r.type === 'NS');
        const cnameRecords = records.filter(r => r.type === 'CNAME');

        // 报告 CNAME 状态（不删除，只提示）
        if (cnameRecords.length > 0) {
          for (const rec of cnameRecords) {
            console.log(`    ℹ 保留 CNAME → ${rec.content} (proxied=${rec.proxied})`);
          }
        }

        // 创建/检查 NS 记录
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
            console.log(`    NS 记录已存在但数量不一致，补充中`);
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
  console.log(`  CNAME 记录: 全部保留（未删除）`);
  console.log(`  错误: ${totalErrors}`);

  if (totalErrors > 0) {
    process.exit(1);
  }

  console.log('\n  NS 委托配置完成。DNS 传播需要几分钟到数小时。');
  console.log('  可用以下命令验证子域名是否走华为云解析:');
  console.log('    dig sg.zzgxxx.eu.org NS');
  console.log('    nslookup sg.zzgxxx.eu.org 8.8.8.8');
}

if (require.main === module) {
  main().catch(e => {
    console.error('致命错误:', e.message);
    process.exit(1);
  });
}
