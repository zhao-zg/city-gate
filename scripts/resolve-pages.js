#!/usr/bin/env node
/**
 * resolve-pages.js
 * 在 CI 部署 Worker 之前，通过 Cloudflare API 查询每个 Pages 项目的
 * 真实 *.pages.dev 域名，自动注入到 wrangler.toml 的 DOMAIN_CONFIG_JSON 中。
 *
 * 为什么需要：
 *   Pages 项目名可能被其他用户占用，Cloudflare 会自动加后缀
 *   （如项目 "cx" → 实际域名 cx-1wd.pages.dev）。
 *   之前靠手动配置 pages_domain 覆盖，容易遗漏。
 *   现在由本脚本在部署前自动查询并注入，Worker 直接用真实域名。
 *
 * 做什么：
 *   1. 读取 wrangler.toml 中的 DOMAIN_CONFIG_JSON
 *   2. 对每个有 pages_project 的 group，通过 CF API 查询真实域名
 *   3. 将 pages_domain 写入 group（如果查询成功）
 *   4. 将更新后的 DOMAIN_CONFIG_JSON 写回 wrangler.toml
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN   — 账户1 Token
 *   CLOUDFLARE_API_TOKEN_2 — 账户2 Token（可选）
 *
 * 用法：
 *   node scripts/resolve-pages.js
 */

const fs = require('fs');
const path = require('path');
const sc = require('./sync-cname');

const CF_API = 'https://api.cloudflare.com/client/v4';

// ── 工具函数 ──────────────────────────────────────────

async function cfApi(pathSuffix, tokenKey) {
  const token = sc.getToken(tokenKey);
  const res = await fetch(`${CF_API}${pathSuffix}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  const json = await res.json();
  if (!json.success) {
    const err = json.errors?.map(e => e.message).join('; ') || '未知错误';
    throw new Error(`Cloudflare API 错误: ${err} (path: ${pathSuffix})`);
  }
  return json;
}

/**
 * 获取账户下的所有 Pages 项目
 * 返回 Map<pages_project_name, subdomain.pages.dev>
 */
async function fetchPagesDomains(tokenKey) {
  const accountId = await getAccountId(tokenKey);
  const json = await cfApi(`/accounts/${accountId}/pages/projects?per_page=100`, tokenKey);
  const map = new Map();
  for (const project of json.result || []) {
    if (project.name && project.subdomain) {
      map.set(project.name, `${project.subdomain}.pages.dev`);
    }
  }
  return map;
}

async function getAccountId(tokenKey) {
  const json = await cfApi('/accounts', tokenKey);
  if (!json.result || json.result.length === 0) {
    throw new Error(`未找到 Cloudflare 账户 (tokenKey: ${tokenKey})`);
  }
  return json.result[0].id;
}

// ── 解析 & 写回 wrangler.toml ────────────────────────

function parseDomainConfig(tomlText) {
  const m = tomlText.match(/DOMAIN_CONFIG_JSON\s*=\s*"""([\s\S]*?)"""/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    console.error('  DOMAIN_CONFIG_JSON 解析失败:', e.message);
    return null;
  }
}

function parseWorkerName(tomlText) {
  const m = tomlText.match(/^name\s*=\s*"([^"]+)"/m);
  return m ? m[1] : null;
}

function writeBackDomainConfig(tomlPath, tomlText, config) {
  const newJson = JSON.stringify(config, null, 2);
  const newToml = tomlText.replace(
    /DOMAIN_CONFIG_JSON\s*=\s*"""[\s\S]*?"""/,
    `DOMAIN_CONFIG_JSON = """\n${newJson}\n"""`
  );
  if (newToml === tomlText) {
    console.log('  无变化，跳过写回');
    return false;
  }
  fs.writeFileSync(tomlPath, newToml, 'utf8');
  console.log('  ✓ 已写回 wrangler.toml');
  return true;
}

// ── 主逻辑 ──────────────────────────────────────────

async function processWorkerDir(dir) {
  const tomlPath = path.join(dir, 'wrangler.toml');
  if (!fs.existsSync(tomlPath)) {
    console.log(`跳过 ${dir}: wrangler.toml 不存在`);
    return;
  }

  console.log(`\n处理 ${dir} ...`);
  const tomlText = fs.readFileSync(tomlPath, 'utf8');
  const config = parseDomainConfig(tomlText);
  if (!config) {
    console.log('  无 DOMAIN_CONFIG_JSON，跳过');
    return;
  }

  const workerName = parseWorkerName(tomlText) || dir;
  const tokenKey = sc.WORKER_TOKEN_KEYS[workerName] || 'default';
  console.log(`  Worker: ${workerName}, tokenKey: ${tokenKey}`);

  // 查询 Pages 项目域名
  console.log('  查询 Pages 项目域名...');
  let pagesMap;
  try {
    pagesMap = await fetchPagesDomains(tokenKey);
    console.log(`  查询到 ${pagesMap.size} 个 Pages 项目`);
  } catch (e) {
    console.error(`  ✗ 查询 Pages 项目失败: ${e.message}`);
    console.error('  将使用配置中的 pages_domain 或 pages_project 拼接');
    return;
  }

  // 更新每个 group 的 pages_domain
  const groups = config.groups || [];
  let changed = 0;
  for (const group of groups) {
    if (!group.pages_project) continue;

    const realDomain = pagesMap.get(group.pages_project);
    if (!realDomain) {
      console.log(`  ⚠ Pages 项目 "${group.pages_project}" 未找到，保留现有配置`);
      continue;
    }

    // 如果已有 pages_domain 且与查询结果一致，跳过
    if (group.pages_domain === realDomain) {
      console.log(`  ✓ ${group.prefix}: pages_domain 已正确 (${realDomain})`);
      continue;
    }

    // 注入真实域名
    const oldDomain = group.pages_domain || `${group.pages_project}.pages.dev`;
    group.pages_domain = realDomain;
    console.log(`  → ${group.prefix}: ${oldDomain} → ${realDomain}`);
    changed++;
  }

  if (changed > 0) {
    writeBackDomainConfig(tomlPath, tomlText, config);
  } else {
    console.log('  所有 pages_domain 已正确，无需更新');
  }
}

async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  Pages 域名解析 — 自动查询真实 *.pages.dev     ║');
  console.log('╚════════════════════════════════════════════════╝');

  const workersDir = path.join(__dirname, '..', 'workers');
  const dirs = fs.readdirSync(workersDir)
    .filter(name => fs.existsSync(path.join(workersDir, name, 'wrangler.toml')))
    .map(name => path.join('workers', name));

  for (const dir of dirs) {
    await processWorkerDir(dir);
  }

  console.log('\n━━━ 完成 ━━━');
}

main().catch(e => {
  console.error('致命错误:', e.message);
  process.exit(1);
});
