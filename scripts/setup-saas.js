#!/usr/bin/env node
/**
 * CF for SaaS 配置脚本（o-{prefix} 回源模式）
 *
 * 架构：
 *   1. o-{prefix}.{zone} → CNAME → {prefix}.pages.dev (proxied=true)
 *      Pages 项目绑定 o-{prefix} 为自定义域名，Pages 认识 Host header → 200
 *
 *   2. Fallback Origin：o-fallback.{zone} → A 192.0.2.1 (proxied=true)
 *
 *   3. Custom Hostnames：{prefix}.{zone} 回源到 Fallback Origin
 *      CF Edge 匹配 Custom Hostname → 回源到 Fallback Origin (o-fallback)
 *      Fallback Origin 是 proxied 记录，CF 内部路由到 o-{prefix}
 *      Pages 项目已绑定 o-{prefix}，认识 Host: {prefix}.{zone} → 200
 *
 *   4. {prefix}.{zone} → CNAME → o-{prefix}.{zone} (proxied=false, DNS only)
 *      用户直连 o-{prefix} 的 CF Anycast IP，SaaS 路由到 Pages
 *
 * 流程：
 *   用户访问 sg.1189.dpdns.org
 *     → DNS: CNAME → o-sg.1189.dpdns.org (proxied=false, DNS only)
 *     → 解析到 CF Anycast IP（o-sg 的 proxied CNAME 链解析结果）
 *     → CF Edge 收到请求，匹配 Custom Hostname (sg.1189.dpdns.org)
 *     → 回源到 Fallback Origin (o-fallback.1189.dpdns.org)
 *     → Pages 源站已绑定 o-sg，认识 Host → 200 OK
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN   — 账户1 Token（需 Zone:Edit + DNS:Edit + SaaS 权限）
 *   CLOUDFLARE_API_TOKEN_2 — 账户2 Token
 *   TOKEN_KEY（可选）       — 只处理指定 tokenKey 的 zone（'default' 或 'account2'），不设则全部处理
 *   DRY_RUN（可选）        — 设为 1 则只预览不执行
 *   ZONE_CONFIG_JSON（可选）— 覆盖 wrangler.toml 配置
 *
 * 用法：
 *   node scripts/setup-saas.js             # 执行配置
 *   DRY_RUN=1 node scripts/setup-saas.js   # 预览模式
 */

const sc = require('./sync-cname');

const CF_API = 'https://api.cloudflare.com/client/v4';
const FALLBACK_PREFIX = 'o-fallback';   // Fallback Origin DNS 记录前缀
const ORIGIN_PREFIX = 'o-';            // 回源域名前缀
const FALLBACK_IP = '192.0.2.1';       // RFC 5737 文档保留 IP
const CH_POLL_TIMEOUT_MS = 120000;      // Custom Hostname 激活轮询超时
const CH_POLL_INTERVAL_MS = 5000;       // Custom Hostname 轮询间隔

const dryRun = process.env.DRY_RUN === '1';

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

// ── Fallback Origin ────────────────────────────────────

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

// ── Custom Hostnames ──────────────────────────────────

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

async function addCustomHostname(zoneId, hostname, tokenKey) {
  const json = await cfApi(`/zones/${zoneId}/custom_hostnames`, {
    method: 'POST',
    body: JSON.stringify({
      hostname,
      ssl: { method: 'http', type: 'dv', wildcard: false },
    }),
    tokenKey,
  });
  return json.result;
}

async function deleteCustomHostname(zoneId, chId, tokenKey) {
  await cfApi(`/zones/${zoneId}/custom_hostnames/${chId}`, { method: 'DELETE', tokenKey });
}

/**
 * 等待 Custom Hostname 状态变为 Active
 */
async function waitForCustomHostnameActive(zoneId, chId, hostname, tokenKey) {
  const deadline = Date.now() + CH_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const json = await cfApi(`/zones/${zoneId}/custom_hostnames/${chId}`, { tokenKey });
      const ch = json.result;
      if (ch.status === 'active') return true;
      console.log(`      状态: ${ch.status}${ch.ssl?.status ? `, SSL: ${ch.ssl.status}` : ''}, 等待中...`);
    } catch (e) {
      console.log(`      查询状态失败: ${e.message}`);
    }
    await sleep(CH_POLL_INTERVAL_MS);
  }
  return false;
}

// ── Pages 自定义域名 ─────────────────────────────────

async function addPagesDomain(accountId, projectName, domain, tokenKey) {
  const json = await cfApi(`/accounts/${accountId}/pages/projects/${projectName}/domains`, {
    method: 'POST',
    body: JSON.stringify({ name: domain }),
    tokenKey,
  });
  return json.result;
}

async function waitForPagesDomainActive(accountId, projectName, domain, tokenKey) {
  const deadline = Date.now() + CH_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const domains = await listPagesDomains(accountId, projectName, tokenKey);
      const d = domains.find(x => x.name === domain);
      if (d) {
        if (d.status === 'active') return true;
        console.log(`      Pages 域名状态: ${d.status}, 等待中...`);
      }
    } catch (e) {
      console.log(`      查询状态失败: ${e.message}`);
    }
    await sleep(CH_POLL_INTERVAL_MS);
  }
  return false;
}

async function listPagesDomains(accountId, projectName, tokenKey) {
  const json = await cfApi(`/accounts/${accountId}/pages/projects/${projectName}/domains`, { tokenKey });
  return json.result || [];
}

async function deletePagesDomain(accountId, projectName, domainId, tokenKey) {
  await cfApi(`/accounts/${accountId}/pages/projects/${projectName}/domains/${domainId}`, { method: 'DELETE', tokenKey });
}

// ── 配置解析 ─────────────────────────────────────────

/**
 * 从 ZONE_MAP 和 wrangler.toml 提取每条 FQDN → origin 映射
 * 返回 [{ fqdn, zoneName, tokenKey, origin, prefix, pagesProject, originFqdn }]
 *   originFqdn = o-{prefix}.{zone} — 回源域名
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
      const originFqdn = `${ORIGIN_PREFIX}${prefix}.${zone.zoneName}`;
      fqdnList.push({
        fqdn: `${prefix}.${zone.zoneName}`,
        zoneName: zone.zoneName,
        tokenKey,
        origin: info.origin,
        prefix,
        pagesProject: info.pagesProject,
        originFqdn,    // o-{prefix}.{zone}
      });
    }
  }

  return fqdnList;
}

/**
 * 从 origin 提取 *.pages.dev 域名
 */
function extractPagesDomain(origin) {
  const host = sc.stripProtocol(origin);
  if (host.endsWith('.pages.dev')) {
    return host;
  }
  return null;
}

// ── Pages 项目查找 ──────────────────────────────────

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

const pagesProjectCache = {};

async function loadPagesProjects(tokenKey) {
  if (pagesProjectCache[tokenKey]) return pagesProjectCache[tokenKey];

  let token;
  try {
    token = sc.getToken(tokenKey);
  } catch {
    return null;
  }
  if (!token) return null;

  const accountId = await getAccountId(tokenKey);
  if (!accountId) return null;

  const projectMap = new Map();
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

async function findPagesProject(origin, tokenKey, pagesProject) {
  if (pagesProject) {
    try {
      const accountId = await getAccountId(tokenKey);
      if (accountId) {
        return { accountId, tokenKey, projectName: pagesProject };
      }
    } catch (e) {
      console.log(`    ⚠ 显式 pages_project="${pagesProject}" 获取账户 ID 失败: ${e.message}`);
    }
  }
  return findPagesProjectByOrigin(origin);
}

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

// ── 主逻辑：SaaS 配置 ──────────────────────────────

/**
 * 为 zone 配置 SaaS（5 步）
 */
async function configureSaaS(zoneName, tokenKey, fqdns) {
  console.log(`\n━━━ Zone: ${zoneName} (账户: ${tokenKey}) ━━━`);

  let zoneId;
  try {
    zoneId = await sc.getZoneId(zoneName, tokenKey);
  } catch (e) {
    console.error(`  ✗ 获取 Zone ID 失败: ${e.message}`);
    return { errors: 1 };
  }

  let errors = 0;
  const pagesFqdnList = fqdns.filter(f => extractPagesDomain(f.origin));

  // ── Step 1: o-{prefix} DNS 记录（CNAME → pages.dev, proxied=true） ──
  // 这些是回源域名，Pages 项目会绑定它们
  console.log(`\n  ── Step 1: 回源域名 DNS（o-{prefix} CNAME → pages.dev, proxied=true） ──`);
  for (const f of pagesFqdnList) {
    const pagesDomain = extractPagesDomain(f.origin);
    const originFqdn = f.originFqdn;
    console.log(`    检查 DNS: ${originFqdn} → CNAME ${pagesDomain} (proxied=true)`);
    try {
      // 清理旧 A 记录
      const existingA = await getDnsRecord(zoneId, originFqdn, 'A', tokenKey);
      for (const rec of existingA) {
        console.log(`    删除旧 A 记录 → ${rec.content} (proxied=${rec.proxied})`);
        if (!dryRun) await deleteDnsRecord(zoneId, rec.id, tokenKey);
      }
      // 检查 CNAME
      const existingCname = await getDnsRecord(zoneId, originFqdn, 'CNAME', tokenKey);
      const matchedCname = existingCname.filter(r => r.content === pagesDomain && r.proxied === true);
      if (matchedCname.length > 0) {
        console.log(`    CNAME 记录已匹配 → 跳过`);
      } else {
        for (const rec of existingCname) {
          console.log(`    删除旧 CNAME → ${rec.content} (proxied=${rec.proxied})`);
          if (!dryRun) await deleteDnsRecord(zoneId, rec.id, tokenKey);
        }
        console.log(`    创建 CNAME → ${pagesDomain} (proxied=true)`);
        if (!dryRun) {
          await createDnsRecord(zoneId, { type: 'CNAME', name: originFqdn, content: pagesDomain, proxied: true, ttl: 1 }, tokenKey);
        }
      }
    } catch (e) {
      console.error(`    ✗ DNS 配置失败: ${e.message}`);
      errors++;
    }
  }

  // ── Step 2: Fallback Origin DNS 记录 ──
  console.log(`\n  ── Step 2: Fallback Origin DNS ──`);
  const fallbackFqdn = `${FALLBACK_PREFIX}.${zoneName}`;

  console.log(`    检查 DNS: ${fallbackFqdn} → A ${FALLBACK_IP} (proxied=true)`);
  try {
    const existingA = await getDnsRecord(zoneId, fallbackFqdn, 'A', tokenKey);
    const matchedA = existingA.filter(r => r.content === FALLBACK_IP && r.proxied === true);

    if (matchedA.length > 0) {
      console.log(`    A 记录已匹配 → 跳过`);
    } else {
      for (const rec of existingA) {
        console.log(`    删除旧 A 记录 → ${rec.content} (proxied=${rec.proxied})`);
        if (!dryRun) await deleteDnsRecord(zoneId, rec.id, tokenKey);
      }
      const existingCname = await getDnsRecord(zoneId, fallbackFqdn, 'CNAME', tokenKey);
      for (const rec of existingCname) {
        console.log(`    删除旧 CNAME → ${rec.content}`);
        if (!dryRun) await deleteDnsRecord(zoneId, rec.id, tokenKey);
      }
      console.log(`    创建 A 记录 → ${FALLBACK_IP} (proxied=true)`);
      if (!dryRun) {
        await createDnsRecord(zoneId, {
          type: 'A',
          name: fallbackFqdn,
          content: FALLBACK_IP,
          proxied: true,
          ttl: 1,
        }, tokenKey);
      }
    }
  } catch (e) {
    console.error(`    ✗ Fallback DNS 配置失败: ${e.message}`);
    errors++;
  }

  // ── Step 3: Pages 自定义域名（绑定 o-{prefix} 到 Pages 项目） ──
  // 必须在 DNS CNAME 创建之后，Pages 域名验证才能通过
  // 必须在 Custom Hostnames 之前，否则 Custom Hostname 拦截 Pages 验证请求
  console.log(`\n  ── Step 3: Pages 自定义域名（绑定 o-{prefix}） ──`);
  for (const f of pagesFqdnList) {
    const pagesDomain = extractPagesDomain(f.origin);
    if (!pagesDomain) continue;

    let pagesInfo;
    try {
      pagesInfo = await findPagesProject(f.origin, f.tokenKey, f.pagesProject);
    } catch {
      console.error(`    ✗ 找不到 Pages 项目: ${pagesDomain}`);
      errors++;
      continue;
    }
    if (!pagesInfo) {
      console.error(`    ✗ 找不到 Pages 项目: ${pagesDomain}`);
      errors++;
      continue;
    }

    const { accountId, projectName, tokenKey: pagesTokenKey } = pagesInfo;
    const originFqdn = f.originFqdn;

    let domains = [];
    try {
      domains = await listPagesDomains(accountId, projectName, pagesTokenKey);
    } catch (e) {
      console.error(`    ✗ 获取 Pages 域名列表失败: ${e.message}`);
      errors++;
      continue;
    }

    const existing = domains.find(d => d.name === originFqdn);
    if (existing) {
      if (existing.status === 'active') {
        console.log(`    ✓ ${originFqdn} Pages 域名已 Active → 跳过`);
      } else {
        console.log(`    ${originFqdn} Pages 域名状态: ${existing.status}, 等待激活...`);
        if (!dryRun) {
          const ok = await waitForPagesDomainActive(accountId, projectName, originFqdn, pagesTokenKey);
          if (ok) {
            console.log(`    ✓ ${originFqdn} Pages 域名已 Active`);
          } else {
            console.log(`    ⚠ ${originFqdn} 未在 ${CH_POLL_TIMEOUT_MS / 1000}s 内变为 Active`);
          }
        }
      }
    } else {
      console.log(`    添加 Pages 自定义域名: ${originFqdn} (project: ${projectName})`);
      if (!dryRun) {
        try {
          await addPagesDomain(accountId, projectName, originFqdn, pagesTokenKey);
          console.log(`    ✓ 已添加，等待激活...`);
          const ok = await waitForPagesDomainActive(accountId, projectName, originFqdn, pagesTokenKey);
          if (ok) {
            console.log(`    ✓ ${originFqdn} Pages 域名已 Active`);
          } else {
            console.log(`    ⚠ ${originFqdn} 未在 ${CH_POLL_TIMEOUT_MS / 1000}s 内变为 Active`);
          }
        } catch (e) {
          if (e.message.includes('already exists') || e.message.includes('duplicate')) {
            console.log(`    Pages 域名已存在 → 继续`);
          } else {
            console.error(`    ✗ 添加 Pages 域名失败: ${e.message}`);
            errors++;
          }
        }
      } else {
        console.log(`    [DRY_RUN] 添加 Pages 自定义域名: ${originFqdn}`);
      }
    }
  }

  // ── Step 4: Fallback Origin + Custom Hostnames ──
  // 先设置 Fallback Origin，再添加 Custom Hostnames
  console.log(`\n  ── Step 4: Fallback Origin ──`);
  console.log(`    设置 Fallback Origin: ${fallbackFqdn}`);
  try {
    const currentFallback = await getFallbackOrigin(zoneId, tokenKey);
    if (currentFallback?.origin === fallbackFqdn) {
      console.log(`    Fallback Origin 已设置 → 跳过`);
    } else {
      if (!dryRun) {
        await setFallbackOrigin(zoneId, fallbackFqdn, tokenKey);
        console.log(`    ✓ Fallback Origin 已设置`);
      } else {
        console.log(`    [DRY_RUN] 设置 Fallback Origin: ${fallbackFqdn}`);
      }
    }
  } catch (e) {
    if (e.message.includes('not found')) {
      console.log(`    Fallback Origin 不存在，尝试创建...`);
      if (!dryRun) {
        try {
          await setFallbackOrigin(zoneId, fallbackFqdn, tokenKey);
          console.log(`    ✓ Fallback Origin 已设置`);
        } catch (e2) {
          console.error(`    ✗ 设置 Fallback Origin 失败: ${e2.message}`);
          errors++;
        }
      }
    } else {
      console.error(`    ✗ 设置 Fallback Origin 失败: ${e.message}`);
      errors++;
    }
  }

  console.log(`\n  ── Step 5: Custom Hostnames ──`);

  let existingCHs = [];
  try {
    existingCHs = await listCustomHostnames(zoneId, tokenKey);
    console.log(`    现有 ${existingCHs.length} 个 Custom Hostnames`);
  } catch (e) {
    console.error(`    ✗ 获取 Custom Hostnames 失败: ${e.message}`);
    errors++;
  }

  const existingCHMap = new Map();
  for (const ch of existingCHs) {
    existingCHMap.set(ch.hostname, ch);
  }

  for (const f of pagesFqdnList) {
    const existing = existingCHMap.get(f.fqdn);
    if (existing) {
      if (existing.status === 'active') {
        console.log(`    ✓ ${f.fqdn} Custom Hostname 已 Active → 跳过`);
      } else {
        console.log(`    ${f.fqdn} Custom Hostname 状态: ${existing.status}, 等待激活...`);
        if (!dryRun) {
          const ok = await waitForCustomHostnameActive(zoneId, existing.id, f.fqdn, tokenKey);
          if (ok) {
            console.log(`    ✓ ${f.fqdn} Custom Hostname 已 Active`);
          } else {
            console.log(`    ⚠ ${f.fqdn} 未在 ${CH_POLL_TIMEOUT_MS / 1000}s 内变为 Active`);
          }
        }
      }
    } else {
      console.log(`    添加 Custom Hostname: ${f.fqdn}`);
      if (!dryRun) {
        try {
          const ch = await addCustomHostname(zoneId, f.fqdn, tokenKey);
          console.log(`    ✓ 已添加 (id: ${ch.id})`);
          const ok = await waitForCustomHostnameActive(zoneId, ch.id, f.fqdn, tokenKey);
          if (ok) {
            console.log(`    ✓ ${f.fqdn} Custom Hostname 已 Active`);
          } else {
            console.log(`    ⚠ ${f.fqdn} 未在 ${CH_POLL_TIMEOUT_MS / 1000}s 内变为 Active（可能证书签发中）`);
          }
        } catch (e) {
          if (e.message.includes('already exists') || e.message.includes('duplicate')) {
            console.log(`    Custom Hostname 已存在 → 继续等待激活`);
          } else {
            console.error(`    ✗ 添加 Custom Hostname 失败: ${e.message}`);
            errors++;
          }
        }
      } else {
        console.log(`    [DRY_RUN] 添加 Custom Hostname: ${f.fqdn}`);
      }
    }
  }

  // ── Step 6: 用户域名 DNS（CNAME → o-{prefix}, proxied=false） ──
  console.log(`\n  ── Step 6: 用户域名 DNS（CNAME → o-{prefix}, proxied=false） ──`);
  for (const f of pagesFqdnList) {
    const originFqdn = f.originFqdn;
    console.log(`    检查 DNS: ${f.fqdn} → CNAME ${originFqdn} (proxied=false)`);
    try {
      // 清理旧 A 记录
      const existingA = await getDnsRecord(zoneId, f.fqdn, 'A', tokenKey);
      for (const rec of existingA) {
        console.log(`    删除旧 A 记录 → ${rec.content} (proxied=${rec.proxied})`);
        if (!dryRun) await deleteDnsRecord(zoneId, rec.id, tokenKey);
      }
      // 检查 CNAME
      const existingCname = await getDnsRecord(zoneId, f.fqdn, 'CNAME', tokenKey);
      const matchedCname = existingCname.filter(r => r.content === originFqdn && r.proxied === false);
      if (matchedCname.length > 0) {
        console.log(`    CNAME 记录已匹配 → 跳过`);
      } else {
        for (const rec of existingCname) {
          console.log(`    删除旧 CNAME → ${rec.content} (proxied=${rec.proxied})`);
          if (!dryRun) await deleteDnsRecord(zoneId, rec.id, tokenKey);
        }
        console.log(`    创建 CNAME → ${originFqdn} (proxied=false)`);
        if (!dryRun) {
          await createDnsRecord(zoneId, { type: 'CNAME', name: f.fqdn, content: originFqdn, proxied: false, ttl: 1 }, tokenKey);
        }
      }
    } catch (e) {
      console.error(`    ✗ DNS 配置失败: ${e.message}`);
      errors++;
    }
  }

  // ── 非 Pages 源站：CNAME → 源站域名 (proxied=false) ──
  const nonPagesFqdnList = fqdns.filter(f => !extractPagesDomain(f.origin));
  if (nonPagesFqdnList.length > 0) {
    console.log(`\n  ── 非 Pages 源站 DNS ──`);
    for (const f of nonPagesFqdnList) {
      console.log(`    检查 DNS: ${f.fqdn} → CNAME ${f.origin} (proxied=false)`);
      try {
        const existingA = await getDnsRecord(zoneId, f.fqdn, 'A', tokenKey);
        for (const rec of existingA) {
          console.log(`    删除旧 A 记录 → ${rec.content} (proxied=${rec.proxied})`);
          if (!dryRun) await deleteDnsRecord(zoneId, rec.id, tokenKey);
        }
        const existingCname = await getDnsRecord(zoneId, f.fqdn, 'CNAME', tokenKey);
        const matchedCname = existingCname.filter(r => r.content === f.origin && r.proxied === false);
        if (matchedCname.length > 0) {
          console.log(`    CNAME 记录已匹配 → 跳过`);
        } else {
          for (const rec of existingCname) {
            console.log(`    删除旧 CNAME → ${rec.content} (proxied=${rec.proxied})`);
            if (!dryRun) await deleteDnsRecord(zoneId, rec.id, tokenKey);
          }
          console.log(`    创建 CNAME → ${f.origin} (proxied=false)`);
          if (!dryRun) {
            await createDnsRecord(zoneId, { type: 'CNAME', name: f.fqdn, content: f.origin, proxied: false, ttl: 1 }, tokenKey);
          }
        }
      } catch (e) {
        console.error(`    ✗ DNS 配置失败: ${e.message}`);
        errors++;
      }
    }
  }

  return { errors };
}

// ── 主入口 ──────────────────────────────────────────

async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  CF for SaaS 配置脚本（o-{prefix} 回源模式）     ║');
  console.log('╚════════════════════════════════════════════════╝');

  if (dryRun) {
    console.log('\n⚠  DRY_RUN 模式 — 仅预览，不执行任何修改\n');
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
  console.log('│  SaaS 配置计划                                                   │');
  console.log('├──────────────────────────────────────────────────────────────────┤');
  console.log('│  FQDN                              →  回源域名    源站           │');
  console.log('├──────────────────────────────────────────────────────────────────┤');
  for (const f of fqdnList) {
    const originTag = extractPagesDomain(f.origin) ? 'Pages' : '外部';
    console.log(`│  ${f.fqdn.padEnd(34)} →  ${f.originFqdn.padEnd(22)} ${f.origin.padEnd(16)} (${originTag}) │`);
  }
  console.log('└──────────────────────────────────────────────────────────────────┘');

  // Step 2: 按 zone 分组执行 SaaS 配置
  console.log('\n── SaaS 配置 ──');
  const zoneGroups = {};
  for (const f of fqdnList) {
    if (!zoneGroups[f.zoneName]) {
      zoneGroups[f.zoneName] = { tokenKey: f.tokenKey, items: [] };
    }
    zoneGroups[f.zoneName].items.push(f);
  }

  let totalErrors = 0;
  for (const [zoneName, group] of Object.entries(zoneGroups)) {
    const result = await configureSaaS(zoneName, group.tokenKey, group.items);
    totalErrors += result.errors;
  }

  // 汇总
  console.log('\n━━━ 汇总 ━━━');
  console.log(`  SaaS 配置${totalErrors > 0 ? ` ⚠ ${totalErrors} 个错误` : ' ✓ 完成'}`);

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

// ── 导出 ──
module.exports = {
  buildFqdnOriginMap,
  configureSaaS,
  extractPagesDomain,
  findPagesProject,
  findPagesProjectByOrigin,
  listCustomHostnames,
  deleteCustomHostname,
  getFallbackOrigin,
  setFallbackOrigin,
  ORIGIN_PREFIX,
};
