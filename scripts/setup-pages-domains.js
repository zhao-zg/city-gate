#!/usr/bin/env node
/**
 * setup-pages-domains.js
 *
 * 为华为云 DNS 托管的 zone 的子域名在 Cloudflare Pages 项目上
 * 添加自定义域名（Custom Domain）。
 *
 * 为什么需要：
 *   zzgxxx.eu.org 的 DNS 从 CF 切到华为云后，DNS 记录在华为云管理。
 *   A 记录仍指向 CF Anycast IP，请求仍到达 CF 边缘。
 *   但到达后需要路由到 Pages 源站——通过 Pages Custom Domain 实现。
 *   Pages Custom Domain 会自动通过 CF for SaaS 签发 SSL 证书。
 *
 * 做什么：
 *   1. 从 wrangler.toml 提取 dnsProvider=huaweicloud 的 zone 及其子域名
 *   2. 对每个有 pages_project 的子域名，在对应 Pages 项目上添加自定义域名
 *   3. 已存在的自定义域名跳过（幂等）
 *   4. 对有 origin 的子域名（非 Pages），跳过（走 Worker Route 路由）
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN — CF API Token（需 Account > Cloudflare Pages > Edit 权限）
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
  // （Token 可能没有 /accounts 权限，但 zone 信息中包含 account ID）
  const zoneMap = sc.autoDetectZoneMap();
  // 找一个 CF zone 来获取 account ID
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

// ── Pages 自定义域名操作 ──────────────────────────────

/**
 * 列出 Pages 项目的自定义域名
 * GET /accounts/{account_id}/pages/projects/{project_name}/domains
 */
async function listPagesDomains(accountId, projectName) {
  const json = await cfApi(`/accounts/${accountId}/pages/projects/${projectName}/domains`);
  return json.result || [];
}

/**
 * 添加 Pages 自定义域名
 * POST /accounts/{account_id}/pages/projects/{project_name}/domains
 * body: { "name": "sg.zzgxxx.eu.org" }
 */
async function addPagesDomain(accountId, projectName, domainName) {
  await cfApi(`/accounts/${accountId}/pages/projects/${projectName}/domains`, {
    method: 'POST',
    body: JSON.stringify({ name: domainName }),
  });
}

// ── 主逻辑 ──────────────────────────────────────────

async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  Pages 自定义域名配置（华为云 DNS zone）         ║');
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

  // Step 2: 从 wrangler.toml 提取 prefix → pages_project 映射
  // 需要重新解析原始配置，因为 zoneMap 只保留了 zone 级信息
  const fs = require('fs');
  const path = require('path');
  const workersDir = path.join(__dirname, '..', 'workers');
  const prefixToPages = new Map(); // prefix → { pages_project, zone_name }
  const prefixToOrigin = new Map(); // prefix → origin (非 Pages)

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
        // 只关注华为云 zone
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

  // Step 3: 为每个 Pages 子域名添加自定义域名
  console.log('\n── Pages 自定义域名配置 ──');
  let totalAdded = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const [prefix, info] of prefixToPages) {
    const fqdn = `${prefix}.${info.zone_name}`;
    const projectName = info.pages_project;

    console.log(`\n  ▸ ${fqdn} → Pages 项目: ${projectName}`);

    try {
      // 查询已有域名
      const domains = await listPagesDomains(accountId, projectName);
      const existing = domains.find(d => d.name === fqdn);

      if (existing) {
        console.log(`    ✓ 已存在 (status: ${existing.status || 'active'}) → 跳过`);
        totalSkipped++;
        continue;
      }

      // 添加自定义域名
      console.log(`    添加自定义域名: ${fqdn}`);
      if (!dryRun) {
        await addPagesDomain(accountId, projectName, fqdn);
      }
      console.log(`    ✓ 已添加（SSL 证书将自动签发）`);
      totalAdded++;
    } catch (e) {
      console.error(`    ✗ 失败: ${e.message}`);
      totalErrors++;
    }
  }

  // 对外部源站子域名打印提示
  for (const [prefix, info] of prefixToOrigin) {
    const fqdn = `${prefix}.${info.zone_name}`;
    console.log(`\n  ⊘ ${fqdn} → 外部源站 ${info.origin}（走 Worker Route，跳过 Pages 自定义域名）`);
  }

  // 汇总
  console.log('\n━━━ 汇总 ━━━');
  console.log(`  添加: ${totalAdded}  跳过: ${totalSkipped}  错误: ${totalErrors}`);

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
