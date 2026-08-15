#!/usr/bin/env node
/**
 * CF for SaaS 配置脚本（多账户版）
 *
 * 架构：
 *   1. Fallback Origin：proxy-fallback.{zone} → A 192.0.2.1 (proxied=true)
 *   2. Custom Hostnames：为每个 FQDN 添加 Custom Hostname，回源到 Fallback Origin
 *   3. DNS 记录（激活用）：FQDN → CNAME → xxx.pages.dev (proxied=true)
 *      Pages 自定义域名通过 CNAME 验证激活，识别 Host header
 *   4. 运行时由 sync-dns.js 改为 A 优选 IP (proxied=false, DNS only)
 *
 * 流程：
 *   用户访问 sg.1189.dpdns.org
 *     → DNS: A 记录 → 优选 CF 边缘 IP (proxied=false, DNS only)
 *     → CF Edge 收到请求，匹配 Custom Hostname (sg.1189.dpdns.org)
 *     → 回源到 Fallback Origin (proxy-fallback.1189.dpdns.org → 192.0.2.1, proxied=true)
 *     → Pages 源站已绑定该自定义域名，认识 Host: sg.1189.dpdns.org → 200 OK
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
const FALLBACK_PREFIX = 'proxy-fallback'; // Fallback Origin DNS 记录前缀
const FALLBACK_IP = '192.0.2.1';          // RFC 5737 文档保留 IP
const CH_POLL_TIMEOUT_MS = 120000;         // Custom Hostname 激活轮询超时
const CH_POLL_INTERVAL_MS = 5000;          // Custom Hostname 轮询间隔

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
 * 返回 true/false
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

/**
 * 为 Pages 项目添加自定义域名
 */
async function addPagesDomain(accountId, projectName, domain, tokenKey) {
  const json = await cfApi(`/accounts/${accountId}/pages/projects/${projectName}/domains`, {
    method: 'POST',
    body: JSON.stringify({ name: domain }),
    tokenKey,
  });
  return json.result;
}

/**
 * 等待 Pages 自定义域名激活
 */
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

/**
 * 为 zone 下的所有 Pages FQDN 添加自定义域名到 Pages 项目
 */
async function ensurePagesDomains(zoneName, tokenKey, fqdns) {
  console.log(`\n  ── Pages 自定义域名 ──`);

  let zoneId;
  try {
    zoneId = await sc.getZoneId(zoneName, tokenKey);
  } catch (e) {
    console.error(`    ✗ 获取 Zone ID 失败: ${e.message}`);
    return { errors: 1 };
  }

  let errors = 0;
  const pagesFqdnList = fqdns.filter(f => extractPagesDomain(f.origin));

  if (pagesFqdnList.length === 0) {
    console.log(`    无 Pages FQDN，跳过`);
    return { errors: 0 };
  }

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

    // 检查是否已添加
    let domains = [];
    try {
      domains = await listPagesDomains(accountId, projectName, pagesTokenKey);
    } catch (e) {
      console.error(`    ✗ 获取 Pages 域名列表失败: ${e.message}`);
      errors++;
      continue;
    }

    const existing = domains.find(d => d.name === f.fqdn);
    if (existing) {
      if (existing.status === 'active') {
        console.log(`    ✓ ${f.fqdn} Pages 域名已 Active → 跳过`);
      } else {
        console.log(`    ${f.fqdn} Pages 域名状态: ${existing.status}, 等待激活...`);
        if (!dryRun) {
          const ok = await waitForPagesDomainActive(accountId, projectName, f.fqdn, pagesTokenKey);
          if (ok) {
            console.log(`    ✓ ${f.fqdn} Pages 域名已 Active`);
          } else {
            console.log(`    ⚠ ${f.fqdn} 未在 ${CH_POLL_TIMEOUT_MS / 1000}s 内变为 Active`);
          }
        }
      }
    } else {
      console.log(`    添加 Pages 自定义域名: ${f.fqdn} (project: ${projectName})`);
      if (!dryRun) {
        try {
          await addPagesDomain(accountId, projectName, f.fqdn, pagesTokenKey);
          console.log(`    ✓ 已添加，等待激活...`);
          const ok = await waitForPagesDomainActive(accountId, projectName, f.fqdn, pagesTokenKey);
          if (ok) {
            console.log(`    ✓ ${f.fqdn} Pages 域名已 Active`);
          } else {
            console.log(`    ⚠ ${f.fqdn} 未在 ${CH_POLL_TIMEOUT_MS / 1000}s 内变为 Active（可能需要手动验证 DNS）`);
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
        console.log(`    [DRY_RUN] 添加 Pages 自定义域名: ${f.fqdn}`);
      }
    }
  }

  return { errors };
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

/**
 * 从 origin（如 https://sg-f3b.pages.dev）提取 *.pages.dev 域名
 */
function extractPagesDomain(origin) {
  const host = sc.stripProtocol(origin);
  if (host.endsWith('.pages.dev')) {
    return host;
  }
  return null;
}

// ── 主逻辑：SaaS 配置 ──────────────────────────────

/**
 * 为 zone 配置 SaaS：Fallback Origin + Custom Hostnames + DNS 记录
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

  // ── Step 1: 配置 Fallback Origin DNS 记录 ──
  console.log(`\n  ── Step 1: Fallback Origin DNS ──`);
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

  // ── Step 2: FQDN DNS 记录（CNAME → pages.dev, proxied=true） ──
  // 必须先设置 DNS，Pages 域名验证才能通过
  console.log(`\n  ── Step 2: FQDN DNS（CNAME → pages.dev, proxied=true） ──`);
  for (const f of pagesFqdnList) {
    const pagesDomain = extractPagesDomain(f.origin);
    console.log(`    检查 DNS: ${f.fqdn} → CNAME ${pagesDomain} (proxied=true)`);
    try {
      // 删除所有旧 A 记录
      const existingA = await getDnsRecord(zoneId, f.fqdn, 'A', tokenKey);
      for (const rec of existingA) {
        console.log(`    删除旧 A 记录 → ${rec.content} (proxied=${rec.proxied})`);
        if (!dryRun) await deleteDnsRecord(zoneId, rec.id, tokenKey);
      }
      // 检查现有 CNAME 记录
      const existingCname = await getDnsRecord(zoneId, f.fqdn, 'CNAME', tokenKey);
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
          await createDnsRecord(zoneId, { type: 'CNAME', name: f.fqdn, content: pagesDomain, proxied: true, ttl: 1 }, tokenKey);
        }
      }
    } catch (e) {
      console.error(`    ✗ DNS 配置失败: ${e.message}`);
      errors++;
    }
  }

  // ── Step 3: Pages 自定义域名（DNS 已配好 CNAME，验证可通过） ──
  // 必须在添加 Custom Hostnames 之前，否则 Custom Hostname 拦截请求导致 Pages 验证失败
  console.log(`\n  ── Step 3: Pages 自定义域名 ──`);
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

    let domains = [];
    try {
      domains = await listPagesDomains(accountId, projectName, pagesTokenKey);
    } catch (e) {
      console.error(`    ✗ 获取 Pages 域名列表失败: ${e.message}`);
      errors++;
      continue;
    }

    const existing = domains.find(d => d.name === f.fqdn);
    if (existing) {
      if (existing.status === 'active') {
        console.log(`    ✓ ${f.fqdn} Pages 域名已 Active → 跳过`);
      } else {
        console.log(`    ${f.fqdn} Pages 域名状态: ${existing.status}, 等待激活...`);
        if (!dryRun) {
          const ok = await waitForPagesDomainActive(accountId, projectName, f.fqdn, pagesTokenKey);
          if (ok) {
            console.log(`    ✓ ${f.fqdn} Pages 域名已 Active`);
          } else {
            console.log(`    ⚠ ${f.fqdn} 未在 ${CH_POLL_TIMEOUT_MS / 1000}s 内变为 Active`);
          }
        }
      }
    } else {
      console.log(`    添加 Pages 自定义域名: ${f.fqdn} (project: ${projectName})`);
      if (!dryRun) {
        try {
          await addPagesDomain(accountId, projectName, f.fqdn, pagesTokenKey);
          console.log(`    ✓ 已添加，等待激活...`);
          const ok = await waitForPagesDomainActive(accountId, projectName, f.fqdn, pagesTokenKey);
          if (ok) {
            console.log(`    ✓ ${f.fqdn} Pages 域名已 Active`);
          } else {
            console.log(`    ⚠ ${f.fqdn} 未在 ${CH_POLL_TIMEOUT_MS / 1000}s 内变为 Active（可能需要手动验证 DNS）`);
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
        console.log(`    [DRY_RUN] 添加 Pages 自定义域名: ${f.fqdn}`);
      }
    }
  }

  // ── Step 4: 设置 Fallback Origin ──
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
    // Resource not found 可能是因为 Fallback Origin 不存在（首次设置），尝试直接设置
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

  // ── Step 5: 添加 Custom Hostnames ──
  // 必须在 Pages 域名激活之后，否则 Custom Hostname 拦截 Pages 验证请求
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

  return { errors };
}

// ── Pages 项目查找 ──────────────────────────────────

// 缓存：tokenKey → accountId
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

async function listPagesDomains(accountId, projectName, tokenKey) {
  const json = await cfApi(`/accounts/${accountId}/pages/projects/${projectName}/domains`, { tokenKey });
  return json.result || [];
}

async function deletePagesDomain(accountId, projectName, domainId, tokenKey) {
  await cfApi(`/accounts/${accountId}/pages/projects/${projectName}/domains/${domainId}`, { method: 'DELETE', tokenKey });
}

// ── 主入口 ──────────────────────────────────────────

async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  CF for SaaS 配置脚本（Pages 直绑 + 优选 IP）   ║');
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
  console.log('│  FQDN                              →  源站                       │');
  console.log('├──────────────────────────────────────────────────────────────────┤');
  for (const f of fqdnList) {
    console.log(`│  ${f.fqdn.padEnd(34)} →  ${f.origin.padEnd(30)} │`);
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
    // 配置 SaaS（Fallback Origin + Custom Hostnames + DNS CNAME + Pages 自定义域名）
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
};
