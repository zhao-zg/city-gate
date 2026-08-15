#!/usr/bin/env node
/**
 * CF for SaaS 资源清理脚本
 *
 * 清理所有由 setup-saas.js 创建的资源：
 *   1. Pages 自定义域名（从 Pages 项目中移除）
 *   2. Custom Hostnames
 *   3. Fallback Origin
 *   4. Fallback Origin DNS 记录
 *   5. FQDN 的 DNS 记录（A 记录、CNAME 记录）
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN   — 账户1 Token
 *   CLOUDFLARE_API_TOKEN_2 — 账户2 Token
 *   TOKEN_KEY（可选）       — 只清理指定 tokenKey 的 zone
 *   DRY_RUN（可选）        — 设为 1 则只预览不执行
 */

const sc = require('./sync-cname');
const saas = require('./setup-saas');

const CF_API = 'https://api.cloudflare.com/client/v4';
const FALLBACK_PREFIX = 'proxy-fallback';
const dryRun = process.env.DRY_RUN === '1';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function cfApi(path, options = {}) {
  const tokenKey = options.tokenKey || 'default';
  const token = sc.getToken(tokenKey);

  const { tokenKey: _, ...fetchOptions } = options;
  const res = await fetch(`${CF_API}${path}`, {
    ...fetchOptions,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...fetchOptions.headers,
    },
  });

  const json = await res.json();
  if (!json.success) {
    const err = json.errors?.map(e => e.message).join('; ') || '未知错误';
    throw new Error(`Cloudflare API 错误: ${err} (path: ${path})`);
  }
  return json;
}

// ── DNS 操作 ─────────────────────────────────────

async function getDnsRecord(zoneId, name, type, tokenKey) {
  const json = await cfApi(`/zones/${zoneId}/dns_records?name=${name}&type=${type}`, { tokenKey });
  return json.result || [];
}

async function deleteDnsRecord(zoneId, recordId, tokenKey) {
  await cfApi(`/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE', tokenKey });
}

// ── Fallback Origin ────────────────────────────

async function getFallbackOrigin(zoneId, tokenKey) {
  const json = await cfApi(`/zones/${zoneId}/custom_hostnames/fallback_origin`, { tokenKey });
  return json.result;
}

async function deleteFallbackOrigin(zoneId, tokenKey) {
  await cfApi(`/zones/${zoneId}/custom_hostnames/fallback_origin`, { method: 'DELETE', tokenKey });
}

// ── Custom Hostnames ──────────────────────────

async function listCustomHostnames(zoneId, tokenKey) {
  const all = [];
  let page = 1;
  while (true) {
    const json = await cfApi(`/zones/${zoneId}/custom_hostnames?per_page=50&page=${page}`, { tokenKey });
    all.push(...json.result);
    if (json.result_info && json.result_info.total_pages > page) {
      page++;
    } else {
      break;
    }
  }
  return all;
}

async function deleteCustomHostname(zoneId, chId, tokenKey) {
  await cfApi(`/zones/${zoneId}/custom_hostnames/${chId}`, { method: 'DELETE', tokenKey });
}

// ── Pages 域名 ────────────────────────────────

async function listPagesDomains(accountId, projectName, tokenKey) {
  const json = await cfApi(`/accounts/${accountId}/pages/projects/${projectName}/domains`, { tokenKey });
  return json.result || [];
}

async function deletePagesDomain(accountId, projectName, domainId, tokenKey) {
  await cfApi(`/accounts/${accountId}/pages/projects/${projectName}/domains/${domainId}`, { method: 'DELETE', tokenKey });
}

// ── 账户信息 ──────────────────────────────────

const accountIdCache = {};

async function getAccountId(tokenKey) {
  if (accountIdCache[tokenKey]) return accountIdCache[tokenKey];
  const json = await cfApi(`/accounts`, { tokenKey });
  if (json.result && json.result.length > 0) {
    accountIdCache[tokenKey] = json.result[0].id;
    return accountIdCache[tokenKey];
  }
  return null;
}

// ── 主逻辑 ───────────────────────────────────

async function cleanZone(zoneName, tokenKey, fqdns) {
  console.log(`\n━━━ Zone: ${zoneName} (账户: ${tokenKey}) ━━━`);

  let zoneId;
  try {
    zoneId = await sc.getZoneId(zoneName, tokenKey);
  } catch (e) {
    console.error(`  ✗ 获取 Zone ID 失败: ${e.message}`);
    return { errors: 1 };
  }

  let errors = 0;

  // ── Step 1: 清理 Pages 自定义域名 ──
  console.log(`\n  ── Pages 自定义域名 ──`);
  const pagesFqdnList = fqdns.filter(f => saas.extractPagesDomain(f.origin));

  // 收集需要清理的 (accountId, projectName, tokenKey) 对
  const pagesProjectSet = new Set();
  for (const f of pagesFqdnList) {
    try {
      const pagesInfo = await saas.findPagesProject(f.origin, f.tokenKey, f.pagesProject);
      if (pagesInfo) {
        const key = `${pagesInfo.accountId}|${pagesInfo.projectName}|${pagesInfo.tokenKey}`;
        pagesProjectSet.add(key);
      }
    } catch {
      // 忽略
    }
  }

  for (const key of pagesProjectSet) {
    const [accountId, projectName, pagesTokenKey] = key.split('|');
    try {
      const domains = await listPagesDomains(accountId, projectName, pagesTokenKey);
      for (const d of domains) {
        // 只删除属于当前 zone 的 FQDN 的自定义域名
        const isOurs = pagesFqdnList.some(f => f.fqdn === d.name);
        if (isOurs || d.name.includes(zoneName.replace('.', '-'))) {
          console.log(`    删除 Pages 域名: ${d.name} (project: ${projectName})`);
          if (!dryRun) {
            await deletePagesDomain(accountId, projectName, d.id, pagesTokenKey);
          }
        }
      }
    } catch (e) {
      console.error(`    ✗ 清理 Pages 域名失败: ${e.message}`);
      errors++;
    }
  }

  // ── Step 2: 清理 Custom Hostnames ──
  console.log(`\n  ── Custom Hostnames ──`);
  try {
    const chs = await listCustomHostnames(zoneId, tokenKey);
    if (chs.length === 0) {
      console.log(`    无 Custom Hostnames`);
    } else {
      for (const ch of chs) {
        console.log(`    删除 Custom Hostname: ${ch.hostname} (id: ${ch.id}, status: ${ch.status})`);
        if (!dryRun) {
          await deleteCustomHostname(zoneId, ch.id, tokenKey);
        }
      }
    }
  } catch (e) {
    console.error(`    ✗ 清理 Custom Hostnames 失败: ${e.message}`);
    errors++;
  }

  // ── Step 3: 清理 Fallback Origin ──
  console.log(`\n  ── Fallback Origin ──`);
  try {
    const fallback = await getFallbackOrigin(zoneId, tokenKey);
    if (fallback && fallback.origin) {
      console.log(`    删除 Fallback Origin: ${fallback.origin}`);
      if (!dryRun) {
        await deleteFallbackOrigin(zoneId, tokenKey);
      }
    } else {
      console.log(`    无 Fallback Origin`);
    }
  } catch (e) {
    console.error(`    ✗ 清理 Fallback Origin 失败: ${e.message}`);
    errors++;
  }

  // ── Step 4: 清理 Fallback DNS 记录 ──
  console.log(`\n  ── Fallback DNS 记录 ──`);
  const fallbackFqdn = `${FALLBACK_PREFIX}.${zoneName}`;
  try {
    for (const type of ['A', 'CNAME']) {
      const records = await getDnsRecord(zoneId, fallbackFqdn, type, tokenKey);
      for (const rec of records) {
        console.log(`    删除 ${rec.type} 记录: ${fallbackFqdn} → ${rec.content} (proxied=${rec.proxied})`);
        if (!dryRun) {
          await deleteDnsRecord(zoneId, rec.id, tokenKey);
        }
      }
    }
    if (await getDnsRecord(zoneId, fallbackFqdn, 'A', tokenKey).then(r => r.length === 0).catch(() => true) &&
        await getDnsRecord(zoneId, fallbackFqdn, 'CNAME', tokenKey).then(r => r.length === 0).catch(() => true)) {
      console.log(`    无 Fallback DNS 记录`);
    }
  } catch (e) {
    console.error(`    ✗ 清理 Fallback DNS 失败: ${e.message}`);
    errors++;
  }

  // ── Step 5: 清理 FQDN 的 DNS 记录 ──
  console.log(`\n  ── FQDN DNS 记录 ──`);
  for (const f of fqdns) {
    try {
      const allRecords = await sc.getDnsRecords(zoneId, f.fqdn, tokenKey);
      if (allRecords.length === 0) {
        console.log(`    ${f.fqdn}: 无 DNS 记录`);
      } else {
        for (const rec of allRecords) {
          console.log(`    删除 ${rec.type}: ${f.fqdn} → ${rec.content} (proxied=${rec.proxied})`);
          if (!dryRun) {
            await deleteDnsRecord(zoneId, rec.id, tokenKey);
          }
        }
      }
    } catch (e) {
      console.error(`    ✗ ${f.fqdn} 清理失败: ${e.message}`);
      errors++;
    }
  }

  return { errors };
}

async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  CF for SaaS 资源清理脚本                       ║');
  console.log('╚════════════════════════════════════════════════╝');

  if (dryRun) {
    console.log('\n⚠  DRY_RUN 模式 — 仅预览，不执行任何修改\n');
  }

  // 解析配置
  console.log('\n── 解析域名配置 ──');
  let fqdnList = saas.buildFqdnOriginMap();
  if (fqdnList.length === 0) {
    throw new Error('未检测到任何 FQDN 配置，请检查 workers/ 下的 wrangler.toml');
  }

  // 按 TOKEN_KEY 过滤
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
  console.log(`  共 ${fqdnList.length} 个 FQDN 需清理\n`);

  // 按 zone 分组
  const zoneGroups = {};
  for (const f of fqdnList) {
    if (!zoneGroups[f.zoneName]) {
      zoneGroups[f.zoneName] = { tokenKey: f.tokenKey, items: [] };
    }
    zoneGroups[f.zoneName].items.push(f);
  }

  let totalErrors = 0;
  for (const [zoneName, group] of Object.entries(zoneGroups)) {
    const result = await cleanZone(zoneName, group.tokenKey, group.items);
    totalErrors += result.errors;
  }

  // 汇总
  console.log('\n━━━ 汇总 ━━━');
  console.log(`  清理${totalErrors > 0 ? ` ⚠ ${totalErrors} 个错误` : ' ✓ 完成'}`);

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
