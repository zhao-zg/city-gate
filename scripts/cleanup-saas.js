#!/usr/bin/env node
/**
 * SaaS 旧资源清理脚本
 *
 * 清理所有旧 SaaS 架构（o-{prefix} 回源模式）创建的资源：
 *   1. Custom Hostnames
 *   2. Fallback Origin
 *   3. Fallback Origin DNS 记录（o-fallback A 192.0.2.1）
 *   4. o-{prefix} DNS 记录（CNAME → pages.dev）
 *   5. o-{prefix} Pages 自定义域名
 *   6. {prefix} 旧 CNAME 记录（CNAME → o-{prefix}）
 *
 * 清理后这些 FQDN 的 DNS 记录将被 setup-saas.js 重新创建为
 * A 记录指向优选 IP（Worker 透明传输模式）。
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN   — 账户1 Token
 *   CLOUDFLARE_API_TOKEN_2 — 账户2 Token
 *   TOKEN_KEY（可选）       — 只清理指定 tokenKey 的 zone
 *   DRY_RUN（可选）        — 设为 1 则只预览不执行
 */

const sc = require('./sync-cname');

const CF_API = 'https://api.cloudflare.com/client/v4';
const FALLBACK_PREFIX = 'o-fallback';
const ORIGIN_PREFIX = 'o-';
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

async function getDnsRecords(zoneId, name, tokenKey) {
  const json = await cfApi(`/zones/${zoneId}/dns_records?name=${name}`, { tokenKey });
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

async function listPagesDomains(accountId, projectName, tokenKey) {
  const json = await cfApi(`/accounts/${accountId}/pages/projects/${projectName}/domains`, { tokenKey });
  return json.result || [];
}

async function deletePagesDomain(accountId, projectName, domainId, tokenKey) {
  await cfApi(`/accounts/${accountId}/pages/projects/${projectName}/domains/${domainId}`, { method: 'DELETE', tokenKey });
}

// ── 从 wrangler.toml 提取 pages_project 列表 ──

function getPagesProjects() {
  const fs = require('fs');
  const path = require('path');
  const workersDir = path.join(__dirname, '..', 'workers');
  const projects = new Map(); // projectName → tokenKey

  const dirs = fs.readdirSync(workersDir)
    .filter(name => fs.existsSync(path.join(workersDir, name, 'wrangler.toml')));

  for (const dir of dirs) {
    const tomlText = fs.readFileSync(path.join(workersDir, dir, 'wrangler.toml'), 'utf8');
    const config = sc.parseDomainConfig(tomlText);
    if (!config || !config.groups) continue;
    const workerName = sc.parseWorkerName(tomlText) || dir;
    const tokenKey = sc.WORKER_TOKEN_KEYS[workerName] || 'default';
    for (const group of config.groups) {
      if (group.pages_project) {
        projects.set(group.pages_project, tokenKey);
      }
    }
  }

  return projects;
}

// ── 主逻辑 ───────────────────────────────────

async function cleanZone(zoneName, tokenKey) {
  console.log(`\n━━━ Zone: ${zoneName} (账户: ${tokenKey}) ━━━`);

  let zoneId;
  try {
    zoneId = await sc.getZoneId(zoneName, tokenKey);
  } catch (e) {
    console.error(`  ✗ 获取 Zone ID 失败: ${e.message}`);
    return { errors: 1 };
  }

  let errors = 0;

  // Step 1: Custom Hostnames
  console.log(`\n  ── Step 1: Custom Hostnames ──`);
  try {
    const chs = await listCustomHostnames(zoneId, tokenKey);
    if (chs.length === 0) {
      console.log(`    无 Custom Hostnames`);
    } else {
      for (const ch of chs) {
        console.log(`    删除: ${ch.hostname} (id: ${ch.id}, status: ${ch.status})`);
        if (!dryRun) await deleteCustomHostname(zoneId, ch.id, tokenKey);
      }
    }
  } catch (e) {
    console.error(`    ✗ 清理 Custom Hostnames 失败: ${e.message}`);
    errors++;
  }

  // Step 2: Fallback Origin
  console.log(`\n  ── Step 2: Fallback Origin ──`);
  try {
    const fallback = await getFallbackOrigin(zoneId, tokenKey);
    if (fallback && fallback.origin) {
      console.log(`    删除: ${fallback.origin}`);
      if (!dryRun) await deleteFallbackOrigin(zoneId, tokenKey);
    } else {
      console.log(`    无 Fallback Origin`);
    }
  } catch (e) {
    if (e.message.includes('not found') || e.message.includes('Resource not found')) {
      console.log(`    Fallback Origin 已不存在 → 忽略`);
    } else {
      console.error(`    ✗ 清理 Fallback Origin 失败: ${e.message}`);
      errors++;
    }
  }

  // Step 3: Fallback Origin DNS 记录
  console.log(`\n  ── Step 3: Fallback Origin DNS 记录 ──`);
  const fallbackFqdn = `${FALLBACK_PREFIX}.${zoneName}`;
  try {
    for (const type of ['A', 'CNAME']) {
      const records = await getDnsRecords(zoneId, fallbackFqdn, tokenKey);
      for (const rec of records) {
        console.log(`    删除 ${rec.type}: ${fallbackFqdn} → ${rec.content}`);
        if (!dryRun) {
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              await deleteDnsRecord(zoneId, rec.id, tokenKey);
              break;
            } catch (e2) {
              if (attempt < 3 && (e2.message.includes('not allowed') || e2.message.includes('fallback origin'))) {
                console.log(`    ⚠ 第 ${attempt} 次删除失败，5s 后重试...`);
                await sleep(5000);
              } else {
                throw e2;
              }
            }
          }
        }
      }
    }
  } catch (e) {
    console.error(`    ✗ 清理 Fallback DNS 失败: ${e.message}`);
    errors++;
  }

  // Step 4: o-{prefix} DNS 记录
  console.log(`\n  ── Step 4: o-{prefix} DNS 记录 ──`);
  const zoneMap = sc.autoDetectZoneMap();
  const zoneInfo = zoneMap.find(z => z.zoneName === zoneName);
  if (zoneInfo) {
    for (const prefix of zoneInfo.names) {
      const originFqdn = `${ORIGIN_PREFIX}${prefix}.${zoneName}`;
      try {
        const records = await getDnsRecords(zoneId, originFqdn, tokenKey);
        if (records.length === 0) {
          console.log(`    ${originFqdn}: 无 DNS 记录`);
        } else {
          for (const rec of records) {
            console.log(`    删除 ${rec.type}: ${originFqdn} → ${rec.content}`);
            if (!dryRun) await deleteDnsRecord(zoneId, rec.id, tokenKey);
          }
        }
      } catch (e) {
        console.error(`    ✗ ${originFqdn} 清理失败: ${e.message}`);
        errors++;
      }
    }
  }

  // Step 5: {prefix} 旧 CNAME 记录（指向 o-{prefix} 的）
  console.log(`\n  ── Step 5: {prefix} 旧 CNAME 记录 ──`);
  if (zoneInfo) {
    for (const prefix of zoneInfo.names) {
      const fqdn = `${prefix}.${zoneName}`;
      try {
        const records = await getDnsRecords(zoneId, fqdn, tokenKey);
        // 只删除指向 o-{prefix} 的旧 CNAME，保留新的 A 记录
        for (const rec of records.filter(r => r.type === 'CNAME')) {
          if (rec.content.startsWith(ORIGIN_PREFIX) || rec.content.includes('.pages.dev')) {
            console.log(`    删除旧 CNAME: ${fqdn} → ${rec.content}`);
            if (!dryRun) await deleteDnsRecord(zoneId, rec.id, tokenKey);
          }
        }
      } catch (e) {
        console.error(`    ✗ ${fqdn} 清理失败: ${e.message}`);
        errors++;
      }
    }
  }

  return { errors };
}

async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  SaaS 旧资源清理脚本                              ║');
  console.log('╚════════════════════════════════════════════════╝');

  if (dryRun) {
    console.log('\n⚠  DRY_RUN 模式 — 仅预览，不执行任何修改\n');
  }

  // Step 6: o-{prefix} Pages 自定义域名
  console.log('\n── Step 6: o-{prefix} Pages 自定义域名 ──');
  const pagesProjects = getPagesProjects();
  for (const [projectName, pagesTokenKey] of pagesProjects) {
    const accountId = await getAccountId(pagesTokenKey);
    if (!accountId) continue;

    try {
      const domains = await listPagesDomains(accountId, projectName, pagesTokenKey);
      for (const d of domains) {
        if (d.name.startsWith(ORIGIN_PREFIX)) {
          console.log(`  删除 Pages 域名: ${d.name} (project: ${projectName})`);
          if (!dryRun) {
            try {
              await deletePagesDomain(accountId, projectName, d.id, pagesTokenKey);
            } catch (e) {
              if (e.message.includes('not found') || e.message.includes('not exist')) {
                console.log(`    Pages 域名已不存在 → 忽略`);
              } else {
                throw e;
              }
            }
          }
        }
      }
    } catch (e) {
      console.error(`  ✗ 清理 Pages 域名失败 (${projectName}): ${e.message}`);
    }
  }

  // 清理各 zone 的 SaaS 资源
  const zoneMap = sc.autoDetectZoneMap();
  const filterTokenKey = process.env.TOKEN_KEY;

  let totalErrors = 0;
  for (const zone of zoneMap) {
    if (filterTokenKey && zone.tokenKey !== filterTokenKey) continue;
    const result = await cleanZone(zone.zoneName, zone.tokenKey || 'default');
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
