#!/usr/bin/env node
/**
 * CF for SaaS 配置脚本（多账户版）
 *
 * 架构：
 *   1. Fallback Origin：proxy-fallback.{zone} → A 192.0.2.1 (proxied=true)
 *   2. Custom Hostnames：为每个 FQDN 添加 Custom Hostname，回源到 Fallback Origin
 *   3. Origin Rules：为每个 Pages FQDN 创建规则，将 Host header 从用户域名改写为 pages.dev
 *   4. 用户域名 DNS：A 记录指向优选 CF 边缘 IP (proxied=false, DNS only)，由 sync-dns.js 管理
 *
 * 流程：
 *   用户访问 sg.1189.dpdns.org
 *     → DNS: A 记录 → 优选 CF 边缘 IP (proxied=false, DNS only)
 *     → CF Edge 收到请求，匹配 Custom Hostname (sg.1189.dpdns.org)
 *     → 回源到 Fallback Origin (proxy-fallback.1189.dpdns.org → 192.0.2.1, proxied=true)
 *     → Origin Rule 触发：Host header 从 sg.1189.dpdns.org 改写为 sg-f3b.pages.dev
 *     → Pages 服务器收到 Host: sg-f3b.pages.dev → 200 OK
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN   — 账户1 Token（需 Zone:Edit + DNS:Edit + SaaS 权限）
 *   CLOUDFLARE_API_TOKEN_2 — 账户2 Token
 *   TOKEN_KEY（可选）       — 只处理指定 tokenKey 的 zone（'default' 或 'account2'），不设则全部处理
 *   DRY_RUN（可选）        — 设为 1 则只预览不执行
 *   ZONE_CONFIG_JSON（可选）— 覆盖 wrangler.toml 配置
 *   SKIP_ORIGIN_RULES（可选）— 设为 1 则跳过 Origin Rule 配置
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
const skipOriginRules = process.env.SKIP_ORIGIN_RULES === '1';

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

// ── Origin Rules ──────────────────────────────────────

/**
 * 列出 zone 下所有 Origin Rules
 */
async function listOriginRules(zoneId, tokenKey) {
  const json = await cfApi(`/zones/${zoneId}/rulesets/phases/http_request_origin/entrypoint`, { tokenKey });
  return json.result;
}

/**
 * 创建或更新 Origin Rules（phase: http_request_origin）
 * 为每个 Pages FQDN 创建规则：匹配 hostname → 重写 Host header 为对应 pages.dev
 *
 * 免费版限制：10 条 Origin Rule
 * 按 (origin pages.dev) 去重：同一 Pages 项目的多个域名共用一条规则
 */
async function ensureOriginRules(zoneId, zoneName, pagesFqdnMap, tokenKey) {
  // pagesFqdnMap: Map<pagesDevDomain, Array<{fqdn, origin}>>
  // 按 pagesDevDomain 去重，同一 origin 只创建一条规则（多 hostname 用 or 匹配）

  if (pagesFqdnMap.size === 0) {
    console.log(`    无 Pages FQDN，跳过 Origin Rule`);
    return { created: 0, errors: 0 };
  }

  // 构建 rules
  const rules = [];
  for (const [pagesDevDomain, entries] of pagesFqdnMap) {
    // 多个 FQDN 指向同一 pages.dev 时，用 or 表达式匹配
    const hostnames = entries.map(e => e.fqdn);
    let expression;
    if (hostnames.length === 1) {
      expression = `(http.host eq "${hostnames[0]}")`;
    } else {
      const conditions = hostnames.map(h => `http.host eq "${h}"`).join(' or ');
      expression = `(${conditions})`;
    }

    rules.push({
      expression,
      description: `Origin Rule: ${hostnames.join(', ')} → ${pagesDevDomain}`,
      action: 'rewrite',
      action_parameters: {
        headers: {
          'Host': {
            operation: 'set',
            value: pagesDevDomain,
          },
        },
      },
    });
  }

  console.log(`    将创建 ${rules.length} 条 Origin Rule（${pagesFqdnMap.size} 个不同 Pages 源站）`);

  // 检查免费版额度（最多 10 条）
  if (rules.length > 10) {
    console.error(`    ✗ Origin Rule 数量 ${rules.length} 超过免费版额度 10 条`);
    return { created: 0, errors: 1 };
  }

  // 打印规则详情
  for (const rule of rules) {
    console.log(`      ${rule.description}`);
  }

  if (dryRun) {
    console.log(`    [DRY_RUN] 跳过 Origin Rule 创建`);
    return { created: rules.length, errors: 0 };
  }

  // 获取现有 Origin Rules
  let existingRuleset;
  try {
    existingRuleset = await listOriginRules(zoneId, tokenKey);
  } catch (e) {
    // "could not find entrypoint ruleset" = zone 下还没有 Origin Rule，视为空
    if (e.message.includes('could not find entrypoint') || e.message.includes('not found')) {
      console.log(`    无现有 Origin Rules（首次创建）`);
      existingRuleset = null;
    } else if (e.message.includes('not authorized') || e.message.includes('403')) {
      console.error(`    ✗ Origin Rules API 权限不足: ${e.message}`);
      console.error(`    ℹ 请在 Cloudflare Dashboard 更新 API Token 权限，添加 "Zone Rulesets: Edit"`);
      return { created: 0, errors: 1, authError: true };
    } else {
      console.error(`    ✗ 获取现有 Origin Rules 失败: ${e.message}`);
      return { created: 0, errors: 1 };
    }
  }

  // 合并：保留非本项目创建的规则，替换本项目规则
  const ourDescriptionPrefix = 'Origin Rule:';
  let existingOtherRules = [];
  if (existingRuleset && existingRuleset.rules) {
    existingOtherRules = existingRuleset.rules.filter(r => !r.description?.startsWith(ourDescriptionPrefix));
  }

  const allRules = [...existingOtherRules, ...rules];

  try {
    await cfApi(`/zones/${zoneId}/rulesets/phases/http_request_origin/entrypoint`, {
      method: 'PUT',
      body: JSON.stringify({
        rules: allRules,
      }),
      tokenKey,
    });
    console.log(`    ✓ Origin Rules 已创建/更新（${rules.length} 条本项目 + ${existingOtherRules.length} 条其他）`);
    return { created: rules.length, errors: 0 };
  } catch (e) {
    console.error(`    ✗ 创建 Origin Rules 失败: ${e.message}`);
    return { created: 0, errors: 1 };
  }
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
 * 为 zone 配置 SaaS：Fallback Origin + Custom Hostnames + Origin Rules
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
  const pagesFqdns = []; // Pages 源站的 FQDN 列表（用于 Origin Rule）

  // ── Step 1: 配置 Fallback Origin ──
  console.log(`\n  ── Fallback Origin ──`);
  const fallbackFqdn = `${FALLBACK_PREFIX}.${zoneName}`;

  // 检查/创建 Fallback Origin DNS 记录（A 记录 192.0.2.1, proxied=true）
  console.log(`    检查 DNS 记录: ${fallbackFqdn} → A ${FALLBACK_IP} (proxied=true)`);
  try {
    const existingA = await getDnsRecord(zoneId, fallbackFqdn, 'A', tokenKey);
    const matchedA = existingA.filter(r => r.content === FALLBACK_IP && r.proxied === true);

    if (matchedA.length > 0) {
      console.log(`    A 记录已匹配 → 跳过`);
    } else {
      // 删除不匹配的记录
      for (const rec of existingA) {
        console.log(`    删除旧 A 记录 → ${rec.content} (proxied=${rec.proxied})`);
        if (!dryRun) await deleteDnsRecord(zoneId, rec.id, tokenKey);
      }
      // 也删除可能存在的 CNAME
      const existingCname = await getDnsRecord(zoneId, fallbackFqdn, 'CNAME', tokenKey);
      for (const rec of existingCname) {
        console.log(`    删除旧 CNAME → ${rec.content}`);
        if (!dryRun) await deleteDnsRecord(zoneId, rec.id, tokenKey);
      }
      // 创建 A 记录
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

  // 设置 Fallback Origin
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
    console.error(`    ✗ 设置 Fallback Origin 失败: ${e.message}`);
    errors++;
  }

  // ── Step 2: 配置 Custom Hostnames ──
  console.log(`\n  ── Custom Hostnames ──`);

  // 获取现有 Custom Hostnames
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

  // 筛选需要添加的 FQDN（仅 Pages 源站）
  const pagesFqdnList = fqdns.filter(f => extractPagesDomain(f.origin));

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
          // 等待激活
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

    // 所有 Pages FQDN 都需要 Origin Rule（无论 CH 是新建还是已存在）
    pagesFqdns.push({ fqdn: f.fqdn, origin: f.origin });
  }

  // ── Step 3: 配置 Origin Rules ──
  if (!skipOriginRules) {
    console.log(`\n  ── Origin Rules ──`);

    // 按 pagesDevDomain 去重分组
    const pagesFqdnMap = new Map(); // pagesDevDomain → [{fqdn, origin}]
    for (const f of pagesFqdns) {
      const pagesDomain = extractPagesDomain(f.origin);
      if (!pagesDomain) continue;
      if (!pagesFqdnMap.has(pagesDomain)) {
        pagesFqdnMap.set(pagesDomain, []);
      }
      pagesFqdnMap.get(pagesDomain).push({ fqdn: f.fqdn, origin: f.origin });
    }

    const ruleResult = await ensureOriginRules(zoneId, zoneName, pagesFqdnMap, tokenKey);
    errors += ruleResult.errors;
  } else {
    console.log(`\n  ── Origin Rules ──`);
    console.log(`    SKIP_ORIGIN_RULES=1，跳过`);
  }

  return { errors };
}

// ── 清理旧的 Pages 直绑配置 ──────────────────────────

async function cleanupPagesDirectBind(zoneName, tokenKey, fqdns) {
  console.log(`\n  ── 清理旧 Pages 直绑 ──`);

  let zoneId;
  try {
    zoneId = await sc.getZoneId(zoneName, tokenKey);
  } catch (e) {
    console.error(`    ✗ 获取 Zone ID 失败: ${e.message}`);
    return { errors: 1 };
  }

  let errors = 0;

  // 获取账户 ID（用于 Pages API）
  const pagesFqdnList = fqdns.filter(f => extractPagesDomain(f.origin));

  if (pagesFqdnList.length === 0) {
    console.log(`    无 Pages FQDN，跳过清理`);
    return { errors: 0 };
  }

    // 遍历 FQDN，尝试从 Pages 项目中移除自定义域名
  // 需要找到 Pages 项目信息
  for (const f of pagesFqdnList) {
    const pagesDomain = extractPagesDomain(f.origin);
    if (!pagesDomain) continue;

    // 查找 Pages 项目
    let pagesInfo;
    try {
      pagesInfo = await findPagesProject(f.origin, f.tokenKey, f.pagesProject);
    } catch {
      continue;
    }
    if (!pagesInfo) continue;

    try {
      const accountId = pagesInfo.accountId;
      const projectName = pagesInfo.projectName;

      // 列出 Pages 项目的自定义域名
      const domains = await listPagesDomains(accountId, projectName, pagesInfo.tokenKey);
      const matched = domains.find(d => d.name === f.fqdn);
      if (matched) {
        console.log(`    删除 Pages 自定义域名: ${f.fqdn} (project: ${projectName})`);
        if (!dryRun) {
          await deletePagesDomain(accountId, projectName, matched.id, pagesInfo.tokenKey);
          console.log(`    ✓ 已删除`);
        }
      }
    } catch (e) {
      // 域名不存在是正常的（之前可能已被删除），静默忽略
      if (e.message.includes('does not exist') || e.message.includes('not found')) {
        // 静默忽略
      } else {
        console.error(`    ✗ 清理 ${f.fqdn} 失败: ${e.message}`);
        errors++;
      }
    }
  }

  return { errors };
}

// ── Pages 项目查找（清理用）──────────────────────────

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
  console.log('║  CF for SaaS 配置脚本（优选 IP + Origin Rule）  ║');
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
    // 清理旧 Pages 直绑
    const cleanupResult = await cleanupPagesDirectBind(zoneName, group.tokenKey, group.items);
    totalErrors += cleanupResult.errors;

    // 配置 SaaS
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
