#!/usr/bin/env node
/**
 * setup-pages-domains.js
 *
 * 为华为云 DNS 托管的 zone 的子域名配置 Pages 自定义域名。
 *
 * 正确流程（三步顺序）：
 *   1. 本脚本：在 CF DNS 创建 CNAME(proxied=true) → pages.dev + 添加 Pages 自定义域名
 *   2. 等待 Pages 自定义域名状态变 active（SSL 证书签发完成）
 *   3. setup-ns-delegation.js：创建 NS 委托记录指向华为云 NS（不删除 CNAME）
 *
 * 为什么先创建 CNAME：
 *   Pages 自定义域名需要 CF DNS 上有对应的 CNAME(proxied=true) 记录才能验证通过并签发 SSL。
 *   如果直接设置 NS 委托，CF DNS 不再管理该子域名，Pages 自定义域名无法验证。
 *   所以必须先创建 CNAME → 等 Pages 验证通过 → 再设置 NS 委托。
 *
 * 做什么：
 *   1. 查询每个 Pages 项目的真实 *.pages.dev 域名（通过 CF API）
 *   2. 在 CF DNS 上为每个子域名创建 CNAME(proxied=true) → pages.dev
 *      - 如果已有 A 记录则删除（CF 不允许同一名称同时有 CNAME 和 A）
 *      - 如果已有 CNAME 但目标不对则更新
 *      - 如果已有正确的 CNAME 则跳过（幂等）
 *   3. 在 Pages 项目上添加自定义域名
 *   4. 跳过有 origin 的子域名（走 Worker Route 路由）
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN — CF API Token（需 Account > Cloudflare Pages > Edit + Zone > DNS > Edit 权限）
 *   DRY_RUN（可选）      — 设为 1 则只预览不执行
 *
 * 用法：
 *   node scripts/setup-pages-domains.js
 *   DRY_RUN=1 node scripts/setup-pages-domains.js
 */

const sc = require('./sync-cname');

const CF_API = 'https://api.cloudflare.com/client/v4';
const dryRun = process.env.DRY_RUN === '1';

// ── CF API 封装 ──────────────────────────────────────

async function cfApi(path, options = {}) {
  const token = sc.getToken('default');
  const res = await fetch(`${CF_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Connection: 'close',
      ...options.headers,
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
  // 先从 zone 信息提取 account ID
  const zoneMap = sc.autoDetectZoneMap();
  for (const zone of zoneMap) {
    if (sc.zoneDnsProvider(zone) !== sc.DNS_PROVIDER_CF) continue;
    try {
      const json = await cfApi(`/zones?name=${zone.zoneName}`);
      if (json.result?.[0]?.account?.id) {
        _accountId = json.result[0].account.id;
        console.log(`  Account ID: ${_accountId} (from zone ${zone.zoneName})`);
        return _accountId;
      }
    } catch (_) { /* 忽略，尝试下一个 zone */ }
  }
  // 回退：直接查 /accounts
  const json = await cfApi('/accounts');
  if (json.result?.[0]?.id) {
    _accountId = json.result[0].id;
    return _accountId;
  }
  throw new Error('无法获取 Account ID，请检查 Token 权限');
}

// ── Pages 项目域名查询 ──────────────────────────────────

/**
 * 查询账户下所有 Pages 项目的真实 *.pages.dev 域名
 * 返回 Map<pages_project_name, pages.dev域名>
 */
async function fetchPagesDomains(accountId) {
  const json = await cfApi(`/accounts/${accountId}/pages/projects`);
  const map = new Map();
  for (const project of json.result || []) {
    if (project.name && project.subdomain) {
      const domain = project.subdomain.includes('.pages.dev')
        ? project.subdomain
        : `${project.subdomain}.pages.dev`;
      map.set(project.name, domain);
    }
  }
  return map;
}

// ── Pages 自定义域名操作 ──────────────────────────────

async function listPagesDomains(accountId, projectName) {
  const json = await cfApi(`/accounts/${accountId}/pages/projects/${projectName}/domains`);
  return json.result || [];
}

async function addPagesDomain(accountId, projectName, domainName) {
  await cfApi(`/accounts/${accountId}/pages/projects/${projectName}/domains`, {
    method: 'POST',
    body: JSON.stringify({ name: domainName }),
  });
}

// ── CF DNS 记录操作（仅操作 CF zone）──────────────────

async function getCfZoneId(zoneName) {
  const json = await cfApi(`/zones?name=${zoneName}`);
  if (!json.result?.length) {
    throw new Error(`CF Zone "${zoneName}" 未找到`);
  }
  return json.result[0].id;
}

async function getCfDnsRecords(zoneId, recordName) {
  const json = await cfApi(`/zones/${zoneId}/dns_records?name=${recordName}`);
  return json.result || [];
}

async function deleteCfDnsRecord(zoneId, recordId) {
  await cfApi(`/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' });
}

async function createCfCnameRecord(zoneId, name, target) {
  await cfApi(`/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'CNAME',
      name,
      content: target,
      proxied: true,  // 必须 proxied=true 才能触发 Pages 自定义域名验证和 SSL 签发
      ttl: 1,         // Auto TTL
    }),
  });
}

// ── 主逻辑 ──────────────────────────────────────────

async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  Pages 自定义域名 + CNAME 配置（华为云 DNS zone）║');
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

  // 只处理华为云 DNS 的 zone
  const hwZones = zoneMap.filter(z => sc.zoneDnsProvider(z) === sc.DNS_PROVIDER_HW);
  if (hwZones.length === 0) {
    console.log('  无华为云 DNS zone，跳过');
    return;
  }
  console.log(`  华为云 DNS zone: ${hwZones.map(z => z.zoneName).join(', ')}`);

  // 获取 Account ID
  console.log('\n── 获取 Account ID ──');
  const accountId = await getAccountId();

  // Step 2: 查询 Pages 项目真实域名
  console.log('\n── 查询 Pages 项目域名 ──');
  const pagesMap = await fetchPagesDomains(accountId);
  console.log(`  查询到 ${pagesMap.size} 个 Pages 项目`);

  // Step 3: 从 wrangler.toml 提取 prefix → pages_project 映射
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

  console.log(`\n  Pages 子域名: ${prefixToPages.size} 个`);
  console.log(`  外部源站子域名: ${prefixToOrigin.size} 个（跳过，走 Worker Route）`);

  // Step 4: 为每个 Pages 子域名创建 CNAME + 添加 Pages 自定义域名
  console.log('\n── CNAME + Pages 自定义域名配置 ──');
  let totalCnameCreated = 0;
  let totalCnameUpdated = 0;
  let totalCnameSkipped = 0;
  let totalADeleted = 0;
  let totalNsDeleted = 0;
  let totalPagesAdded = 0;
  let totalPagesSkipped = 0;
  let totalErrors = 0;

  // 按 zone 分组，每个 zone 只获取一次 zoneId
  const zoneGroups = new Map();
  for (const [prefix, info] of prefixToPages) {
    if (!zoneGroups.has(info.zone_name)) {
      zoneGroups.set(info.zone_name, []);
    }
    zoneGroups.get(info.zone_name).push({ prefix, ...info });
  }

  for (const [zoneName, items] of zoneGroups) {
    console.log(`\n━━━ Zone: ${zoneName} ━━━`);

    // 获取 CF Zone ID（华为云 zone 的 NS 委托在 CF Zone 上操作）
    let zoneId;
    try {
      zoneId = await getCfZoneId(zoneName);
    } catch (e) {
      console.error(`  ✗ 获取 CF Zone ID 失败: ${e.message}`);
      totalErrors += items.length;
      continue;
    }
    console.log(`  CF Zone ID: ${zoneId}`);

    for (const item of items) {
      const fqdn = `${item.prefix}.${item.zone_name}`;
      const projectName = item.pages_project;
      const pagesDomain = pagesMap.get(projectName);

      if (!pagesDomain) {
        console.error(`\n  ▸ ${fqdn}: Pages 项目 "${projectName}" 未找到，跳过`);
        totalErrors++;
        continue;
      }

      console.log(`\n  ▸ ${fqdn} → CNAME ${pagesDomain} (Pages: ${projectName})`);

      try {
        // ── 4a: 处理 CF DNS 记录 ──
        const records = await getCfDnsRecords(zoneId, fqdn);
        const cnameRecords = records.filter(r => r.type === 'CNAME');
        const aRecords = records.filter(r => r.type === 'A');
        const nsRecords = records.filter(r => r.type === 'NS');
        const otherRecords = records.filter(r => r.type !== 'CNAME' && r.type !== 'A' && r.type !== 'NS');

        // 检查是否已有正确的 CNAME
        const existingCname = cnameRecords.find(r => r.content === pagesDomain && r.proxied === true);

        // 删除 A 记录（CF 不允许同一名称同时有 CNAME 和 A）
        if (aRecords.length > 0) {
          console.log(`    删除 ${aRecords.length} 条旧 A 记录:`);
          for (const rec of aRecords) {
            console.log(`      A ${fqdn} → ${rec.content} (id: ${rec.id})`);
            if (!dryRun) {
              await deleteCfDnsRecord(zoneId, rec.id);
            }
            totalADeleted++;
          }
        }

        // 删除其他非 CNAME/NS 记录（如 TXT 等，避免冲突）
        if (otherRecords.length > 0) {
          console.log(`    删除 ${otherRecords.length} 条其他记录:`);
          for (const rec of otherRecords) {
            console.log(`      ${rec.type} ${fqdn} → ${rec.content} (id: ${rec.id})`);
            if (!dryRun) {
              await deleteCfDnsRecord(zoneId, rec.id);
            }
          }
        }

        // 如果没有正确的 CNAME，需要创建 CNAME
        // 此时如果已有 NS 记录（上次错误先创建的），需要先删除 NS
        // DNS 标准不允许 CNAME 和 NS 共存于同一名称
        if (!existingCname && nsRecords.length > 0) {
          console.log(`    删除 ${nsRecords.length} 条旧 NS 记录（为创建 CNAME 让路，NS 将在后续步骤重建）:`);
          for (const rec of nsRecords) {
            console.log(`      NS ${fqdn} → ${rec.content} (id: ${rec.id})`);
            if (!dryRun) {
              await deleteCfDnsRecord(zoneId, rec.id);
            }
            totalNsDeleted++;
          }
        }

        // 检查/创建 CNAME
        if (existingCname) {
          console.log(`    ✓ CNAME 已存在且正确 (proxied=true) → 跳过`);
          totalCnameSkipped++;
        } else {
          // 删除目标不对的旧 CNAME
          for (const rec of cnameRecords) {
            console.log(`    删除旧 CNAME → ${rec.content} (proxied=${rec.proxied}, id: ${rec.id})`);
            if (!dryRun) {
              await deleteCfDnsRecord(zoneId, rec.id);
            }
          }
          // 创建新 CNAME
          console.log(`    创建 CNAME: ${fqdn} → ${pagesDomain} (proxied=true)`);
          if (!dryRun) {
            await createCfCnameRecord(zoneId, fqdn, pagesDomain);
          }
          totalCnameCreated++;
        }

        // ── 4b: 添加 Pages 自定义域名 ──
        const pagesDomains = await listPagesDomains(accountId, projectName);
        const existingPagesDomain = pagesDomains.find(d => d.name === fqdn);

        if (existingPagesDomain) {
          console.log(`    ✓ Pages 自定义域名已存在 (status: ${existingPagesDomain.status || 'active'}) → 跳过`);
          totalPagesSkipped++;
        } else {
          console.log(`    添加 Pages 自定义域名: ${fqdn}`);
          if (!dryRun) {
            await addPagesDomain(accountId, projectName, fqdn);
          }
          console.log(`    ✓ 已添加（SSL 证书将自动签发）`);
          totalPagesAdded++;
        }

      } catch (e) {
        console.error(`    ✗ 失败: ${e.message}`);
        totalErrors++;
      }
    }
  }

  // 对外部源站子域名打印提示
  for (const [prefix, info] of prefixToOrigin) {
    const fqdn = `${prefix}.${info.zone_name}`;
    console.log(`\n  ⊘ ${fqdn} → 外部源站 ${info.origin}（走 Worker Route，跳过 Pages 自定义域名）`);
  }

  // 汇总
  console.log('\n━━━ 汇总 ━━━');
  console.log(`  CNAME: 创建 ${totalCnameCreated}  更新 ${totalCnameUpdated}  跳过 ${totalCnameSkipped}`);
  console.log(`  A 记录删除: ${totalADeleted}`);
  console.log(`  NS 记录删除: ${totalNsDeleted}（为创建 CNAME 让路，后续步骤重建）`);
  console.log(`  Pages 自定义域名: 添加 ${totalPagesAdded}  跳过 ${totalPagesSkipped}`);
  console.log(`  错误: ${totalErrors}`);

  if (totalErrors > 0) {
    process.exit(1);
  }

  console.log('\n  CNAME + Pages 自定义域名配置完成。');
  console.log('  下一步：等待 Pages 自定义域名状态变 active 后，运行 setup-ns-delegation.js');
}

if (require.main === module) {
  main().catch(e => {
    console.error('致命错误:', e.message);
    process.exit(1);
  });
}
