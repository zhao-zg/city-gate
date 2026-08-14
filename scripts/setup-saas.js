#!/usr/bin/env node
/**
 * Cloudflare for SaaS 配置脚本（多账户版）
 *
 * 自动化配置 CF for SaaS：
 *   1. 为每个 zone 创建 Fallback Origin DNS 记录（proxy-fallback.{zone} → A 192.0.2.1, proxied=true）
 *   2. 设置 Fallback Origin
 *   3. 为每个 FQDN 创建 Custom Hostname（指定 custom_origin 指向 *.pages.dev 源站）
 *   4. 等待 Custom Hostname 状态 Active
 *
 * 配置来源：workers/ 下的 wrangler.toml 中的 DOMAIN_CONFIG_JSON
 *   与 sync-cname.js / sync-dns.js 共用同一解析逻辑
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN   — 账户1 Token（需 Zone:Edit + DNS:Edit + SSL and Certificates:Edit 权限）
 *   CLOUDFLARE_API_TOKEN_2 — 账户2 Token
 *   DRY_RUN（可选）        — 设为 1 则只预览不执行
 *   ZONE_CONFIG_JSON（可选）— 覆盖 wrangler.toml 配置
 *
 * 用法：
 *   node scripts/setup-saas.js             # 执行配置
 *   DRY_RUN=1 node scripts/setup-saas.js   # 预览模式
 */

const sc = require('./sync-cname');

const CF_API = 'https://api.cloudflare.com/client/v4';
const FALLBACK_IP = '192.0.2.1';        // RFC 5737 文档保留 IP，CF SaaS 占位用
const FALLBACK_PREFIX = 'proxy-fallback'; // Fallback Origin DNS 记录前缀
const POLL_TIMEOUT_MS = 30000;           // Fallback Origin 状态轮询超时
const POLL_INTERVAL_MS = 2000;           // 轮询间隔
const CH_POLL_TIMEOUT_MS = 60000;        // Custom Hostname 状态轮询超时
const CH_POLL_INTERVAL_MS = 3000;        // Custom Hostname 轮询间隔

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

// ── Fallback Origin ──────────────────────────────────

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

async function waitForFallbackOriginActive(zoneId, tokenKey) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await getFallbackOrigin(zoneId, tokenKey);
    if (result && result.status === 'active') {
      return true;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

// ── Custom Hostnames ─────────────────────────────────

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

async function getCustomHostname(zoneId, hostname, tokenKey) {
  const json = await cfApi(`/zones/${zoneId}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`, { tokenKey });
  return json.result && json.result[0] || null;
}

async function createCustomHostname(zoneId, hostname, customOrigin, tokenKey) {
  const body = {
    hostname,
    ssl: { method: 'http', wildcard: false },
  };
  if (customOrigin) {
    body.custom_origin = customOrigin;
  }
  const json = await cfApi(`/zones/${zoneId}/custom_hostnames`, {
    method: 'POST',
    body: JSON.stringify(body),
    tokenKey,
  });
  return json.result;
}

async function deleteCustomHostname(zoneId, chId, tokenKey) {
  await cfApi(`/zones/${zoneId}/custom_hostnames/${chId}`, { method: 'DELETE', tokenKey });
}

async function waitForCustomHostnameActive(zoneId, hostname, tokenKey) {
  const deadline = Date.now() + CH_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ch = await getCustomHostname(zoneId, hostname, tokenKey);
    if (ch && ch.status === 'active') {
      return ch;
    }
    await sleep(CH_POLL_INTERVAL_MS);
  }
  return null;
}

// ── 配置解析 ─────────────────────────────────────────

/**
 * 从 ZONE_MAP 和 wrangler.toml 提取每条 FQDN → origin 映射
 * 返回 [{ fqdn, zoneName, tokenKey, origin, prefix }]
 */
function buildFqdnOriginMap() {
  // 复用 autoDetectZoneMap 获取 zone + prefix 列表
  const zoneMap = sc.autoDetectZoneMap();

  // 同时读取 wrangler.toml 的完整 DOMAIN_CONFIG_JSON 以获取 origin
  const fs = require('fs');
  const path = require('path');

  // 从环境变量或 wrangler.toml 获取完整配置
  // 需要保留 Worker 名（目录名）以正确映射 tokenKey
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
        // 用 Worker 名映射 tokenKey（与 autoDetectZoneMap 逻辑一致）
        const workerName = sc.parseWorkerName(tomlText) || dir;
        const tokenKey = sc.WORKER_TOKEN_KEYS[workerName] || 'default';
        allConfigs.push({ config, tokenKey, workerName });
      }
    }
  }

  // 构建 prefix → origin 映射（按 tokenKey 分组，因为账户2有不同的 origin）
  const prefixOriginByTokenKey = {}; // { default: { sg: 'https://...', ... }, account2: { ... } }

  for (const entry of allConfigs) {
    // 环境变量方式：entry 直接是 config 对象，需要从 zones 找 tokenKey
    // wrangler.toml 方式：entry = { config, tokenKey, workerName }
    const config = entry.config || entry;
    let tokenKey = entry.tokenKey || 'default';

    // 环境变量方式 fallback：检查 zones 中是否有 tokenKey 指定的
    if (!entry.tokenKey && config.zones) {
      for (const zone of config.zones) {
        if (typeof zone === 'object' && zone.tokenKey) {
          tokenKey = zone.tokenKey;
          break;
        }
      }
    }

    if (!prefixOriginByTokenKey[tokenKey]) {
      prefixOriginByTokenKey[tokenKey] = {};
    }
    if (config.groups) {
      for (const group of config.groups) {
        prefixOriginByTokenKey[tokenKey][group.prefix] = sc.stripProtocol(group.origin || '');
      }
    }
  }

  // 展开所有 FQDN
  const fqdnList = [];
  for (const zone of zoneMap) {
    const tokenKey = zone.tokenKey || 'default';
    const origins = prefixOriginByTokenKey[tokenKey] || {};
    for (const prefix of zone.names) {
      const origin = origins[prefix];
      if (!origin) {
        console.log(`  ⚠ ${prefix}.${zone.zoneName} 无对应 origin，跳过`);
        continue;
      }
      fqdnList.push({
        fqdn: `${prefix}.${zone.zoneName}`,
        zoneName: zone.zoneName,
        tokenKey,
        origin,
        prefix,
      });
    }
  }

  return fqdnList;
}

// ── 主逻辑 ──────────────────────────────────────────

async function processZone(zoneName, tokenKey, fqdns) {
  console.log(`\n━━━ Zone: ${zoneName}${tokenKey ? ` (账户: ${tokenKey})` : ''} ━━━`);

  let zoneId;
  try {
    zoneId = await sc.getZoneId(zoneName, tokenKey);
  } catch (e) {
    console.error(`  ✗ 获取 Zone ID 失败: ${e.message}`);
    return { errors: fqdns.length, fallback: false, hostnames: 0 };
  }

  // ── Step 1: Fallback Origin DNS 记录 ──
  const fallbackFqdn = `${FALLBACK_PREFIX}.${zoneName}`;
  console.log(`\n  [Fallback Origin] ${fallbackFqdn} → A ${FALLBACK_IP} (proxied=true)`);

  let fallbackReady = false;
  try {
    const existing = await getDnsRecord(zoneId, fallbackFqdn, 'A', tokenKey);
    const matched = existing.filter(r => r.content === FALLBACK_IP && r.proxied === true);

    if (matched.length > 0) {
      console.log(`    A 记录已存在且匹配 → 跳过`);
    } else {
      // 删除旧记录
      for (const rec of existing) {
        console.log(`    删除旧 A 记录 → ${rec.content} (proxied=${rec.proxied})`);
        if (!dryRun) await deleteDnsRecord(zoneId, rec.id, tokenKey);
      }
      // 也检查是否有其他类型记录（如 CNAME）
      const otherRecords = await getDnsRecord(zoneId, fallbackFqdn, 'CNAME', tokenKey);
      for (const rec of otherRecords) {
        console.log(`    删除旧 CNAME 记录 → ${rec.content}`);
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
    console.error(`    ✗ Fallback DNS 记录操作失败: ${e.message}`);
    return { errors: fqdns.length, fallback: false, hostnames: 0 };
  }

  // ── Step 2: 设置 Fallback Origin ──
  console.log(`\n  [Fallback Origin] 设置 fallback origin = ${fallbackFqdn}`);
  try {
    const current = await getFallbackOrigin(zoneId, tokenKey);
    if (current && current.origin === fallbackFqdn && current.status === 'active') {
      console.log(`    Fallback Origin 已设置为 ${fallbackFqdn} (active) → 跳过`);
      fallbackReady = true;
    } else {
      console.log(`    当前: origin=${current?.origin || '(无)'}, status=${current?.status || '(无)'}`);
      if (!dryRun) {
        await setFallbackOrigin(zoneId, fallbackFqdn, tokenKey);
        console.log(`    等待 Fallback Origin 状态 Active...`);
        fallbackReady = await waitForFallbackOriginActive(zoneId, tokenKey);
        if (fallbackReady) {
          console.log(`    ✓ Fallback Origin 已 Active`);
        } else {
          console.log(`    ⚠ Fallback Origin 未在 ${POLL_TIMEOUT_MS / 1000}s 内变为 Active`);
        }
      } else {
        console.log(`    [DRY_RUN] 跳过实际设置`);
        fallbackReady = true; // 预览模式假设成功
      }
    }
  } catch (e) {
    console.error(`    ✗ 设置 Fallback Origin 失败: ${e.message}`);
    // 继续尝试创建 Custom Hostnames
  }

  // ── Step 3: Custom Hostnames ──
  let hostnameStats = { created: 0, skipped: 0, updated: 0, errors: 0 };

  // 获取现有 Custom Hostnames
  let existingHostnames = [];
  try {
    if (!dryRun) {
      existingHostnames = await listCustomHostnames(zoneId, tokenKey);
    }
  } catch (e) {
    console.error(`    ✗ 获取现有 Custom Hostnames 失败: ${e.message}`);
  }

  const existingMap = new Map();
  for (const ch of existingHostnames) {
    existingMap.set(ch.hostname, ch);
  }

  // 收集需要保留的 hostname 集合
  const desiredHostnames = new Set(fqdns.map(f => f.fqdn));

  // 删除不再需要的 Custom Hostnames
  for (const [hostname, ch] of existingMap) {
    if (!desiredHostnames.has(hostname)) {
      console.log(`\n  [Custom Hostname] ${hostname} — 不在配置中，删除`);
      if (!dryRun) {
        try {
          await deleteCustomHostname(zoneId, ch.id, tokenKey);
          console.log(`    ✓ 已删除`);
        } catch (e) {
          console.error(`    ✗ 删除失败: ${e.message}`);
        }
      }
    }
  }

  for (const f of fqdns) {
    const { fqdn, origin } = f;
    console.log(`\n  [Custom Hostname] ${fqdn} → custom_origin: ${origin}`);

    const existing = existingMap.get(fqdn);

    if (existing) {
      // 检查 custom_origin 是否匹配
      if (existing.custom_origin === origin && existing.status === 'active') {
        console.log(`    Custom Hostname 已存在且 origin 匹配 (active) → 跳过`);
        hostnameStats.skipped++;
        continue;
      }

      // origin 不匹配或状态不 active，需要更新
      // CF API 不支持直接更新 Custom Hostname 的 custom_origin，需要删除重建
      if (existing.custom_origin !== origin) {
        console.log(`    Custom Hostname origin 不匹配 (当前: ${existing.custom_origin || '(无)'}) → 重建`);
        if (!dryRun) {
          try {
            await deleteCustomHostname(zoneId, existing.id, tokenKey);
            console.log(`    ✓ 旧 Custom Hostname 已删除`);
          } catch (e) {
            console.error(`    ✗ 删除旧 Custom Hostname 失败: ${e.message}`);
            hostnameStats.errors++;
            continue;
          }
        } else {
          hostnameStats.updated++;
          continue;
        }
      } else if (existing.status !== 'active') {
        console.log(`    Custom Hostname 状态: ${existing.status} → 等待 Active...`);
        if (!dryRun) {
          const ch = await waitForCustomHostnameActive(zoneId, fqdn, tokenKey);
          if (ch) {
            console.log(`    ✓ Custom Hostname 已 Active`);
            hostnameStats.skipped++;
          } else {
            console.log(`    ⚠ 未在 ${CH_POLL_TIMEOUT_MS / 1000}s 内变为 Active`);
            hostnameStats.errors++;
          }
          continue;
        }
      }
    }

    // 创建新的 Custom Hostname
    console.log(`    创建 Custom Hostname (custom_origin: ${origin}, ssl: http)`);
    if (!dryRun) {
      try {
        const ch = await createCustomHostname(zoneId, fqdn, origin, tokenKey);
        console.log(`    ✓ 已创建 (id: ${ch.id}, status: ${ch.status})`);

        if (ch.status !== 'active') {
          console.log(`    等待 Custom Hostname 状态 Active...`);
          const activeCh = await waitForCustomHostnameActive(zoneId, fqdn, tokenKey);
          if (activeCh) {
            console.log(`    ✓ Custom Hostname 已 Active`);
          } else {
            console.log(`    ⚠ 未在 ${CH_POLL_TIMEOUT_MS / 1000}s 内变为 Active（证书签发中？）`);
          }
        }
        hostnameStats.created++;
      } catch (e) {
        console.error(`    ✗ 创建失败: ${e.message}`);
        hostnameStats.errors++;
      }
    } else {
      hostnameStats.created++;
    }
  }

  return {
    errors: hostnameStats.errors,
    fallback: fallbackReady,
    hostnames: hostnameStats.created + hostnameStats.skipped + hostnameStats.updated,
    hostnameStats,
  };
}

// ── 主入口 ──────────────────────────────────────────

async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  Cloudflare for SaaS 配置脚本                    ║');
  console.log('║  Fallback Origin + Custom Hostnames              ║');
  console.log('╚════════════════════════════════════════════════╝');

  if (dryRun) {
    console.log('\n⚠  DRY_RUN 模式 — 仅预览，不执行任何修改\n');
  }

  // Step 1: 解析配置
  console.log('\n── 解析域名配置 ──');
  const fqdnList = buildFqdnOriginMap();
  if (fqdnList.length === 0) {
    throw new Error('未检测到任何 FQDN 配置，请检查 workers/ 下的 wrangler.toml');
  }
  console.log(`  共 ${fqdnList.length} 个 FQDN 需配置\n`);

  // 打印配置概览
  console.log('┌──────────────────────────────────────────────────────────────────┐');
  console.log('│  Custom Hostname 配置计划                                        │');
  console.log('├──────────────────────────────────────────────────────────────────┤');
  console.log('│  FQDN                              →  custom_origin              │');
  console.log('├──────────────────────────────────────────────────────────────────┤');
  for (const f of fqdnList) {
    console.log(`│  ${f.fqdn.padEnd(34)} →  ${f.origin.padEnd(28)} │`);
  }
  console.log('└──────────────────────────────────────────────────────────────────┘');

  // Step 2: 按 zone 分组
  const zoneGroups = {};
  for (const f of fqdnList) {
    if (!zoneGroups[f.zoneName]) {
      zoneGroups[f.zoneName] = { tokenKey: f.tokenKey, items: [] };
    }
    zoneGroups[f.zoneName].items.push(f);
  }

  // Step 3: 逐 zone 处理
  let totalErrors = 0;
  let totalHostnames = 0;
  let totalFallbacks = 0;

  for (const [zoneName, group] of Object.entries(zoneGroups)) {
    const result = await processZone(zoneName, group.tokenKey, group.items);
    totalErrors += result.errors;
    totalHostnames += result.hostnames;
    if (result.fallback) totalFallbacks++;
  }

  // 汇总
  console.log('\n━━━ 汇总 ━━━');
  console.log(`  Zones: ${Object.keys(zoneGroups).length}  Fallback Origins: ${totalFallbacks}  Custom Hostnames: ${totalHostnames}  错误: ${totalErrors}`);

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
  processZone,
  createCustomHostname,
  deleteCustomHostname,
  listCustomHostnames,
  getFallbackOrigin,
  setFallbackOrigin,
  waitForFallbackOriginActive,
  waitForCustomHostnameActive,
};
