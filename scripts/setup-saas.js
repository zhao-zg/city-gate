#!/usr/bin/env node
/**
 * Pages 自定义域名直绑配置脚本（多账户版）
 *
 * 替代原 CF for SaaS 方案，改为 Pages 直接绑定自定义域名：
 *   1. 为每个 FQDN 添加为对应 Pages 项目的自定义域名
 *   2. 为验证需要，临时创建 CNAME FQDN → pages.dev (proxied=true)
 *   3. 等待域名状态 Active
 *   4. 清理旧的 SaaS 配置（Custom Hostnames、Fallback Origins、origin CNAME）
 *
 * DNS A 记录（优选 IP）由 sync-dns.js 管理，本脚本不涉及。
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN   — 账户1 Token（需 Zone:Edit + DNS:Edit + Pages:Edit 权限）
 *   CLOUDFLARE_API_TOKEN_2 — 账户2 Token
 *   TOKEN_KEY（可选）       — 只处理指定 tokenKey 的 zone（'default' 或 'account2'），不设则全部处理
 *   DRY_RUN（可选）        — 设为 1 则只预览不执行
 *   SKIP_CLEANUP（可选）   — 设为 1 则跳过 SaaS 配置清理
 *   ZONE_CONFIG_JSON（可选）— 覆盖 wrangler.toml 配置
 *
 * 用法：
 *   node scripts/setup-saas.js             # 执行配置
 *   DRY_RUN=1 node scripts/setup-saas.js   # 预览模式
 */

const sc = require('./sync-cname');

const CF_API = 'https://api.cloudflare.com/client/v4';
const ORIGIN_PREFIX = 'o-';              // origin CNAME 前缀（清理用）
const FALLBACK_PREFIX = 'proxy-fallback'; // Fallback Origin DNS 记录前缀（清理用）
const FALLBACK_IP = '192.0.2.1';        // RFC 5737 文档保留 IP（清理用）
const DOMAIN_POLL_TIMEOUT_MS = 120000;    // Pages 域名激活轮询超时
const DOMAIN_POLL_INTERVAL_MS = 5000;     // Pages 域名轮询间隔
const CH_POLL_TIMEOUT_MS = 60000;         // Custom Hostname 轮询超时（清理用）
const CH_POLL_INTERVAL_MS = 3000;         // Custom Hostname 轮询间隔

const dryRun = process.env.DRY_RUN === '1';
const skipCleanup = process.env.SKIP_CLEANUP === '1';

// ── 工具函数 ──────────────────────────────────────────

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

// ── DNS 记录操作 ─────────────────────────────────────

async function getDnsRecord(zoneId, name, type, tokenKey) {
  const json = await cfApi(`/zones/${zoneId}/dns_records?name=${name}&type=${type}`, { tokenKey });
  return json.result || [];
}

async function createDnsRecord(zoneId, body, tokenKey) {
  const json = await cfApi(`/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify(body),
    tokenKey,
  });
  return json.result;
}

async function deleteDnsRecord(zoneId, recordId, tokenKey) {
  await cfApi(`/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE', tokenKey });
}

// ── Fallback Origin（仅清理用）──────────────────────

async function getFallbackOrigin(zoneId, tokenKey) {
  const json = await cfApi(`/zones/${zoneId}/custom_hostnames/fallback_origin`, { tokenKey });
  return json.result;
}

async function setFallbackOrigin(zoneId, origin, tokenKey) {
  const json = await cfApi(`/zones/${zoneId}/custom_hostnames/fallback_origin`, {
    method: 'PUT',
    body: JSON.stringify({ origin }),
    tokenKey,
  });
  return json.result;
}

// ── Custom Hostnames（仅清理用）─────────────────────

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

// ── Pages 自定义域名 ─────────────────────────────────

/**
 * 从 origin（如 https://sg-f3b.pages.dev）提取 *.pages.dev 域名（sg-f3b.pages.dev）
 * 非 Pages 源站返回 null
 */
function extractPagesDomain(origin) {
  const host = sc.stripProtocol(origin);
  if (host.endsWith('.pages.dev')) {
    return host;
  }
  return null;
}

// 缓存：tokenKey → accountId
const accountIdCache = {};

/**
 * 获取账户 ID（带缓存）
 */
async function getAccountId(tokenKey) {
  if (accountIdCache[tokenKey]) return accountIdCache[tokenKey];
  const json = await cfApi(`/accounts`, { tokenKey });
  if (json.result && json.result.length > 0) {
    accountIdCache[tokenKey] = json.result[0].id;
    return accountIdCache[tokenKey];
  }
  return null;
}

// 缓存：tokenKey → { accountId, projects: Map<pagesDevDomain, projectName> }
const pagesProjectCache = {};

/**
 * 列出账户下所有 Pages 项目，构建 { pagesDevDomain → projectName } 映射
 */
async function loadPagesProjects(tokenKey) {
  if (pagesProjectCache[tokenKey]) return pagesProjectCache[tokenKey];

  let token;
  try {
    token = sc.getToken(tokenKey);
  } catch {
    return null;
  }
  if (!token) return null;

  // 获取 account ID
  const accountId = await getAccountId(tokenKey);
  if (!accountId) return null;

  // 列出所有 Pages 项目
  const projectMap = new Map(); // pagesDevDomain → projectName
  try {
    const json = await cfApi(`/accounts/${accountId}/pages/projects`, { tokenKey });
    for (const proj of (json.result || [])) {
      for (const domain of (proj.domains || [])) {
        if (domain.endsWith('.pages.dev')) {
          projectMap.set(domain, proj.name);
        }
      }
    }
  } catch {
    return null;
  }

  const result = { accountId, projectMap };
  pagesProjectCache[tokenKey] = result;
  return result;
}

/**
 * 查找 Pages 项目信息（优先使用显式 pages_project 配置）
 * 返回 { accountId, tokenKey, projectName } 或 null
 */
async function findPagesProject(origin, tokenKey, pagesProject) {
  // 优先路径：显式 pages_project
  if (pagesProject) {
    try {
      const accountId = await getAccountId(tokenKey);
      if (accountId) {
        return { accountId, tokenKey, projectName: pagesProject };
      }
    } catch (e) {
      console.log(`    ⚠ 显式 pages_project="${pagesProject}" 获取账户 ID 失败 (tokenKey=${tokenKey}): ${e.message}`);
    }
  }

  // 回退路径：通过 origin 全量反查
  return findPagesProjectByOrigin(origin);
}

/**
 * 通过 origin 的 *.pages.dev 域名查找 Pages 项目所在账户
 * 返回 { accountId, tokenKey, projectName } 或 null
 */
async function findPagesProjectByOrigin(origin) {
  const pagesDomain = extractPagesDomain(origin);
  if (!pagesDomain) return null;

  const tokenKeys = ['default', 'account2'];
  for (const tk of tokenKeys) {
    const loaded = await loadPagesProjects(tk);
    if (!loaded) continue;

    const projectName = loaded.projectMap.get(pagesDomain);
    if (projectName) {
      return { accountId: loaded.accountId, tokenKey: tk, projectName };
    }
  }
  return null;
}

async function listPagesDomains(accountId, projectName, tokenKey) {
  const json = await cfApi(`/accounts/${accountId}/pages/projects/${projectName}/domains`, { tokenKey });
  return json.result || [];
}

async function addPagesDomain(accountId, projectName, domain, tokenKey) {
  const json = await cfApi(`/accounts/${accountId}/pages/projects/${projectName}/domains`, {
    method: 'POST',
    body: JSON.stringify({ name: domain }),
    tokenKey,
  });
  return json.result;
}

async function deletePagesDomain(accountId, projectName, domainId, tokenKey) {
  await cfApi(`/accounts/${accountId}/pages/projects/${projectName}/domains/${domainId}`, { method: 'DELETE', tokenKey });
}

/**
 * 等待 Pages 自定义域名状态变为 Active
 * 返回 true/false
 */
async function waitForPagesDomainActive(accountId, projectName, domainName, tokenKey) {
  const deadline = Date.now() + DOMAIN_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const domains = await listPagesDomains(accountId, projectName, tokenKey);
      const matched = domains.find(d => d.name === domainName);
      if (matched) {
        if (matched.status === 'active') return true;
        // status 可能是 'pending' 或 'initializing'
        console.log(`      域名状态: ${matched.status}, 等待中...`);
      } else {
        console.log(`      域名未找到，等待中...`);
      }
    } catch (e) {
      console.log(`      查询域名状态失败: ${e.message}`);
    }
    await sleep(DOMAIN_POLL_INTERVAL_MS);
  }
  return false;
}

// ── 配置解析 ─────────────────────────────────────────

/**
 * 从 ZONE_MAP 和 wrangler.toml 提取每条 FQDN → origin 映射
 * 返回 [{ fqdn, zoneName, tokenKey, origin, prefix, pagesProject }]
 */
function buildFqdnOriginMap() {
  const zoneMap = sc.autoDetectZoneMap();

  const fs = require('fs');
  const path = require('path');

  let allConfigs = [];
  if (process.env.ZONE_CONFIG_JSON) {
    const parsed = JSON.parse(process.env.ZONE_CONFIG_JSON);
    allConfigs = Array.isArray(parsed) ? parsed : [parsed];
  } else {
    const workersDir = path.join(__dirname, '..', 'workers');
    const dirs = fs.readdirSync(workersDir)
      .filter(name => fs.existsSync(path.join(workersDir, name, 'wrangler.toml')));
    for (const dir of dirs) {
      const tomlText = fs.readFileSync(path.join(workersDir, dir, 'wrangler.toml'), 'utf8');
      const config = sc.parseDomainConfig(tomlText);
      if (config) {
        const workerName = sc.parseWorkerName(tomlText) || dir;
        const tokenKey = sc.WORKER_TOKEN_KEYS[workerName] || 'default';
        allConfigs.push({ config, tokenKey, workerName });
      }
    }
  }

  const prefixInfoByTokenKey = {};

  for (const entry of allConfigs) {
    const config = entry.config || entry;
    let tokenKey = entry.tokenKey || 'default';

    if (!entry.tokenKey && config.zones) {
      for (const zone of config.zones) {
        if (typeof zone === 'object' && zone.tokenKey) {
          tokenKey = zone.tokenKey;
          break;
        }
      }
    }

    if (!prefixInfoByTokenKey[tokenKey]) {
      prefixInfoByTokenKey[tokenKey] = {};
    }
    if (config.groups) {
      for (const group of config.groups) {
        prefixInfoByTokenKey[tokenKey][group.prefix] = {
          origin: sc.stripProtocol(group.origin || ''),
          pagesProject: group.pages_project || null,
        };
      }
    }
  }

  const fqdnList = [];
  for (const zone of zoneMap) {
    const tokenKey = zone.tokenKey || 'default';
    const prefixInfo = prefixInfoByTokenKey[tokenKey] || {};
    for (const prefix of zone.names) {
      const info = prefixInfo[prefix];
      if (!info || !info.origin) {
        console.log(`  ⚠ ${prefix}.${zone.zoneName} 无对应 origin，跳过`);
        continue;
      }
      fqdnList.push({
        fqdn: `${prefix}.${zone.zoneName}`,
        zoneName: zone.zoneName,
        tokenKey,
        origin: info.origin,
        prefix,
        pagesProject: info.pagesProject,
      });
    }
  }

  return fqdnList;
}

// ── 主逻辑：Pages 直绑 ──────────────────────────────

/**
 * 为 Pages 项目添加用户域名为自定义域名
 * 流程：
 *   1. 检查 Pages 项目是否已绑定该域名
 *   2. 若未绑定，需要先创建验证 CNAME（FQDN → pages.dev, proxied=true）
 *   3. 添加域名到 Pages 项目
 *   4. 等待域名状态变为 Active
 *   5. 删除验证 CNAME（A 记录由 sync-dns.js 管理）
 *   6. 若已绑定且 Active，跳过
 */
async function bindPagesDomain(fqdn, origin, pagesProject, zoneName, tokenKey) {
  const pagesDomain = extractPagesDomain(origin);
  if (!pagesDomain) {
    console.log(`    ${fqdn} → ${origin} 非 Pages 源站 → 跳过`);
    return { result: 'skipped', error: false };
  }

  // 查找 Pages 项目
  let pagesInfo;
  try {
    pagesInfo = await findPagesProject(origin, tokenKey, pagesProject);
  } catch (e) {
    console.error(`    ✗ 查找 Pages 项目失败: ${e.message}`);
    return { result: 'error', error: true };
  }

  if (!pagesInfo) {
    console.error(`    ✗ 未找到包含 ${pagesDomain} 的 Pages 项目`);
    return { result: 'error', error: true };
  }

  console.log(`    → 项目: ${pagesInfo.projectName} (account: ${pagesInfo.tokenKey})`);

  // 检查域名是否已绑定
  let domains;
  try {
    domains = await listPagesDomains(pagesInfo.accountId, pagesInfo.projectName, pagesInfo.tokenKey);
  } catch (e) {
    console.error(`    ✗ 获取 Pages 域名列表失败: ${e.message}`);
    return { result: 'error', error: true };
  }

  const matched = domains.find(d => d.name === fqdn);
  if (matched && matched.status === 'active') {
    console.log(`    域名已绑定且 Active → 跳过`);
    return { result: 'skipped', error: false };
  }

  if (matched && matched.status !== 'active') {
    console.log(`    域名已绑定但状态: ${matched.status}，等待激活...`);
    if (!dryRun) {
      const ok = await waitForPagesDomainActive(pagesInfo.accountId, pagesInfo.projectName, fqdn, pagesInfo.tokenKey);
      if (ok) {
        console.log(`    ✓ 域名已 Active`);
        return { result: 'activated', error: false };
      } else {
        console.log(`    ⚠ 域名未在 ${DOMAIN_POLL_TIMEOUT_MS / 1000}s 内变为 Active`);
        return { result: 'timeout', error: true };
      }
    }
    return { result: 'skipped_dry', error: false };
  }

  // 域名未绑定 → 需要添加
  // 步骤1：获取 zone ID
  let zoneId;
  try {
    zoneId = await sc.getZoneId(zoneName, tokenKey);
  } catch (e) {
    console.error(`    ✗ 获取 Zone ID 失败: ${e.message}`);
    return { result: 'error', error: true };
  }

  // 步骤2：创建验证 CNAME（FQDN → pages.dev, proxied=true）
  console.log(`    创建验证 CNAME: ${fqdn} → ${pagesDomain} (proxied=true)`);
  let cnameCreated = false;
  if (!dryRun) {
    try {
      // 先检查是否已有记录
      const existingCname = await getDnsRecord(zoneId, fqdn, 'CNAME', tokenKey);
      const existingA = await getDnsRecord(zoneId, fqdn, 'A', tokenKey);

      // 如果已有 A 记录（优选 IP），临时删除
      if (existingA.length > 0) {
        for (const rec of existingA) {
          console.log(`    临时删除 A 记录 → ${rec.content} (proxied=${rec.proxied})`);
          if (!dryRun) await deleteDnsRecord(zoneId, rec.id, tokenKey);
        }
      }

      // 检查是否已有匹配的 CNAME
      const matchedCname = existingCname.find(r => r.content === pagesDomain && r.proxied === true);
      if (!matchedCname) {
        // 删除不匹配的 CNAME
        for (const rec of existingCname) {
          console.log(`    删除旧 CNAME → ${rec.content} (proxied=${rec.proxied})`);
          await deleteDnsRecord(zoneId, rec.id, tokenKey);
        }

        await createDnsRecord(zoneId, {
          type: 'CNAME',
          name: fqdn,
          content: pagesDomain,
          proxied: true,
          ttl: 1,
        }, tokenKey);
        cnameCreated = true;
        console.log(`    ✓ 验证 CNAME 已创建`);
      } else {
        console.log(`    验证 CNAME 已存在 → 跳过创建`);
        cnameCreated = true;
      }
    } catch (e) {
      console.error(`    ✗ 验证 CNAME 创建失败: ${e.message}`);
      return { result: 'error', error: true };
    }
  }

  // 步骤3：添加域名到 Pages 项目
  console.log(`    添加自定义域名 ${fqdn} 到 Pages 项目 ${pagesInfo.projectName}...`);
  if (!dryRun) {
    try {
      await addPagesDomain(pagesInfo.accountId, pagesInfo.projectName, fqdn, pagesInfo.tokenKey);
      console.log(`    ✓ 已添加`);
    } catch (e) {
      if (e.message.includes('already') || e.message.includes('duplicate')) {
        console.log(`    域名已存在于 Pages 项目 → 继续等待激活`);
      } else {
        console.error(`    ✗ 添加失败: ${e.message}`);
        // 清理 CNAME
        if (cnameCreated) {
          console.log(`    清理验证 CNAME...`);
          try {
            const recs = await getDnsRecord(zoneId, fqdn, 'CNAME', tokenKey);
            for (const rec of recs) {
              await deleteDnsRecord(zoneId, rec.id, tokenKey);
            }
          } catch {}
        }
        return { result: 'error', error: true };
      }
    }
  }

  // 步骤4：等待域名状态变为 Active
  console.log(`    等待域名激活...`);
  if (!dryRun) {
    const ok = await waitForPagesDomainActive(pagesInfo.accountId, pagesInfo.projectName, fqdn, pagesInfo.tokenKey);
    if (ok) {
      console.log(`    ✓ 域名已 Active`);
    } else {
      console.log(`    ⚠ 域名未在 ${DOMAIN_POLL_TIMEOUT_MS / 1000}s 内变为 Active`);
      // 不算错误，可能证书签发中
    }
  }

  // 步骤5：删除验证 CNAME（A 记录由 sync-dns.js 管理）
  if (cnameCreated && !dryRun) {
    console.log(`    清理验证 CNAME...`);
    try {
      const recs = await getDnsRecord(zoneId, fqdn, 'CNAME', tokenKey);
      for (const rec of recs) {
        console.log(`    删除 CNAME → ${rec.content}`);
        await deleteDnsRecord(zoneId, rec.id, tokenKey);
      }
      console.log(`    ✓ 验证 CNAME 已删除（A 记录由 sync-dns.js 管理）`);
    } catch (e) {
      console.error(`    ✗ 清理验证 CNAME 失败: ${e.message}`);
    }
  }

  return { result: 'created', error: false };
}

// ── 清理旧的 SaaS 配置 ──────────────────────────────

async function cleanupSaaSConfig(zoneName, tokenKey, fqdns) {
  console.log(`\n  ── 清理旧 SaaS 配置 ──`);

  let zoneId;
  try {
    zoneId = await sc.getZoneId(zoneName, tokenKey);
  } catch (e) {
    console.error(`    ✗ 获取 Zone ID 失败: ${e.message}`);
    return { errors: 0 };
  }

  let errors = 0;

  // 1. 删除 Custom Hostnames
  console.log(`\n  [清理] Custom Hostnames`);
  try {
    const hostnames = await listCustomHostnames(zoneId, tokenKey);
    for (const ch of hostnames) {
      console.log(`    删除 Custom Hostname: ${ch.hostname}`);
      if (!dryRun) {
        try {
          await deleteCustomHostname(zoneId, ch.id, tokenKey);
          console.log(`    ✓ 已删除`);
        } catch (e) {
          console.error(`    ✗ 删除失败: ${e.message}`);
          errors++;
        }
      }
    }
    if (hostnames.length === 0) {
      console.log(`    无 Custom Hostnames 需清理`);
    }
  } catch (e) {
    console.error(`    ✗ 获取 Custom Hostnames 失败: ${e.message}`);
    errors++;
  }

  // 2. 清除 Fallback Origin
  console.log(`\n  [清理] Fallback Origin`);
  try {
    const fallback = await getFallbackOrigin(zoneId, tokenKey);
    if (fallback && fallback.origin) {
      console.log(`    清除 Fallback Origin: ${fallback.origin}`);
      if (!dryRun) {
        // CF API 不支持直接删除 Fallback Origin，设为空字符串来清除
        try {
          await setFallbackOrigin(zoneId, '', tokenKey);
          console.log(`    ✓ 已清除`);
        } catch (e) {
          // 有些 zone 可能无法清除，忽略
          console.log(`    ⚠ 无法清除: ${e.message}`);
        }
      }
    } else {
      console.log(`    无 Fallback Origin 需清理`);
    }
  } catch (e) {
    console.log(`    无 Fallback Origin 需清理`);
  }

  // 3. 删除 origin CNAME 记录（o-{prefix}.{zone}）
  console.log(`\n  [清理] Origin CNAME 记录`);
  const prefixes = [...new Set(fqdns.map(f => f.prefix))];
  let cleanedCnames = 0;
  for (const prefix of prefixes) {
    const originCname = `${ORIGIN_PREFIX}${prefix}.${zoneName}`;
    try {
      const recs = await getDnsRecord(zoneId, originCname, 'CNAME', tokenKey);
      for (const rec of recs) {
        console.log(`    删除 CNAME: ${originCname} → ${rec.content}`);
        if (!dryRun) {
          await deleteDnsRecord(zoneId, rec.id, tokenKey);
          console.log(`    ✓ 已删除`);
          cleanedCnames++;
        }
      }
    } catch (e) {
      console.error(`    ✗ 删除 ${originCname} 失败: ${e.message}`);
      errors++;
    }
  }
  if (cleanedCnames === 0 && prefixes.length === 0) {
    console.log(`    无 Origin CNAME 需清理`);
  }

  // 4. 删除 Fallback Origin DNS 记录（proxy-fallback.{zone}）
  console.log(`\n  [清理] Fallback DNS 记录`);
  const fallbackFqdn = `${FALLBACK_PREFIX}.${zoneName}`;
  try {
    const aRecs = await getDnsRecord(zoneId, fallbackFqdn, 'A', tokenKey);
    for (const rec of aRecs) {
      console.log(`    删除 A 记录: ${fallbackFqdn} → ${rec.content}`);
      if (!dryRun) {
        await deleteDnsRecord(zoneId, rec.id, tokenKey);
        console.log(`    ✓ 已删除`);
      }
    }
    const cRecs = await getDnsRecord(zoneId, fallbackFqdn, 'CNAME', tokenKey);
    for (const rec of cRecs) {
      console.log(`    删除 CNAME: ${fallbackFqdn} → ${rec.content}`);
      if (!dryRun) {
        await deleteDnsRecord(zoneId, rec.id, tokenKey);
        console.log(`    ✓ 已删除`);
      }
    }
    if (aRecs.length === 0 && cRecs.length === 0) {
      console.log(`    无 Fallback DNS 记录需清理`);
    }
  } catch (e) {
    console.error(`    ✗ 清理 Fallback DNS 失败: ${e.message}`);
    errors++;
  }

  return { errors };
}

// ── 主入口 ──────────────────────────────────────────

async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  Pages 自定义域名直绑配置脚本                    ║');
  console.log('║  替代 CF for SaaS 方案                           ║');
  console.log('╚════════════════════════════════════════════════╝');

  if (dryRun) {
    console.log('\n⚠  DRY_RUN 模式 — 仅预览，不执行任何修改\n');
  }
  if (skipCleanup) {
    console.log('\n⚠  SKIP_CLEANUP 模式 — 跳过旧 SaaS 配置清理\n');
  }

  // Step 1: 解析配置
  console.log('\n── 解析域名配置 ──');
  let fqdnList = buildFqdnOriginMap();
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
  console.log(`  共 ${fqdnList.length} 个 FQDN 需配置\n`);

  // 打印配置概览
  console.log('┌──────────────────────────────────────────────────────────────────┐');
  console.log('│  Pages 直绑配置计划                                              │');
  console.log('├──────────────────────────────────────────────────────────────────┤');
  console.log('│  FQDN                              →  Pages 源站                  │');
  console.log('├──────────────────────────────────────────────────────────────────┤');
  for (const f of fqdnList) {
    console.log(`│  ${f.fqdn.padEnd(34)} →  ${f.origin.padEnd(30)} │`);
  }
  console.log('└──────────────────────────────────────────────────────────────────┘');

  // Step 2: Pages 直绑 — 按 (origin, pagesProject) 去重，同一 Pages 项目只需绑定一次
  console.log('\n── Pages 自定义域名直绑 ──');
  const seenOriginProject = new Set(); // "origin:pagesProject" 去重
  let bindStats = { created: 0, skipped: 0, errors: 0 };

  for (const f of fqdnList) {
    const pagesDomain = extractPagesDomain(f.origin);
    if (!pagesDomain) {
      console.log(`\n  [Pages 直绑] ${f.fqdn} → 非 Pages 源站，跳过`);
      bindStats.skipped++;
      continue;
    }

    // 同一 Pages 项目的每个 FQDN 都需要独立绑定
    console.log(`\n  [Pages 直绑] ${f.fqdn} → ${pagesDomain}`);

    if (dryRun) {
      console.log(`    [DRY_RUN] 跳过实际绑定`);
      bindStats.created++;
      continue;
    }

    const result = await bindPagesDomain(f.fqdn, f.origin, f.pagesProject, f.zoneName, f.tokenKey);
    if (result.error) {
      bindStats.errors++;
    } else if (result.result === 'skipped') {
      bindStats.skipped++;
    } else {
      bindStats.created++;
    }
  }

  // Step 3: 清理旧 SaaS 配置
  if (!skipCleanup) {
    console.log('\n── 清理旧 SaaS 配置 ──');
    const zoneGroups = {};
    for (const f of fqdnList) {
      if (!zoneGroups[f.zoneName]) {
        zoneGroups[f.zoneName] = { tokenKey: f.tokenKey, items: [] };
      }
      zoneGroups[f.zoneName].items.push(f);
    }

    let cleanupErrors = 0;
    for (const [zoneName, group] of Object.entries(zoneGroups)) {
      console.log(`\n━━━ Zone: ${zoneName}${group.tokenKey ? ` (账户: ${group.tokenKey})` : ''} ━━━`);
      const result = await cleanupSaaSConfig(zoneName, group.tokenKey, group.items);
      cleanupErrors += result.errors;
    }

    if (cleanupErrors > 0) {
      console.log(`\n⚠ 清理过程中有 ${cleanupErrors} 个错误`);
    }
  }

  // 汇总
  console.log('\n━━━ 汇总 ━━━');
  console.log(`  Pages 直绑: ${bindStats.created} 新增 / ${bindStats.skipped} 跳过 / ${bindStats.errors} 错误`);

  if (bindStats.errors > 0) {
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
  buildFqdnOriginMap,
  bindPagesDomain,
  cleanupSaaSConfig,
  extractPagesDomain,
  findPagesProject,
  findPagesProjectByOrigin,
  listPagesDomains,
  addPagesDomain,
  deletePagesDomain,
  listCustomHostnames,
  deleteCustomHostname,
  getFallbackOrigin,
  setFallbackOrigin,
};
