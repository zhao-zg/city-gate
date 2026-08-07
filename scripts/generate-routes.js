#!/usr/bin/env node
/**
 * generate-routes.js
 * 从 wrangler.toml 的 DOMAIN_CONFIG_JSON 提取域名，自动生成 [[routes]] 段
 *
 * 用法:
 *   node scripts/generate-routes.js [worker-dir ...]
 *   # 默认处理 workers/ 下所有含 wrangler.toml 的目录
 *
 * 支持两种 DOMAIN_CONFIG_JSON 格式：
 *   1. zones + prefixes（推荐）：{ zones: [...], groups: [{ prefix, origin, ... }] }
 *      自动展开 prefix.zone 为完整域名
 *   2. 旧格式 domains 数组：[{ domains: [...], ... }]
 */

const fs = require('fs');
const path = require('path');

// ── 从 DOMAIN_CONFIG_JSON 展开完整域名列表 ───────────────
function expandDomains(config) {
  // 新格式：zones + prefixes
  if (config.zones && Array.isArray(config.groups)) {
    const domains = [];
    for (const group of config.groups) {
      const zones = group.zones || config.zones;
      for (const zone of zones) {
        domains.push(`${group.prefix}.${zone}`);
      }
    }
    return [...new Set(domains)].sort();
  }

  // 旧格式：domains 数组
  if (Array.isArray(config)) {
    return [...new Set(config.flatMap(g => g.domains || []))].sort();
  }

  return [];
}

// ── 解析 wrangler.toml 中的 DOMAIN_CONFIG_JSON ──────────
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

// ── 生成 [[routes]] TOML 段 ─────────────────────────────
function generateRoutesTOML(domains) {
  const lines = [];
  for (const domain of domains) {
    // zone = 去掉第一个子域后的部分
    const zone = domain.split('.').slice(1).join('.');
    lines.push(`[[routes]]`);
    lines.push(`pattern = "${domain}/*"`);
    lines.push(`zone_name = "${zone}"`);
    if (domain !== domains[domains.length - 1]) lines.push('');
  }
  return lines.join('\n') + '\n';
}

// ── 从 wrangler.toml 中提取已有的 routes 区域并替换 ─────
function replaceRoutesInToml(tomlText, newRoutes) {
  const newBlock = `# 路由配置 — 由 scripts/generate-routes.js 从 DOMAIN_CONFIG_JSON 自动生成，勿手动编辑\n${newRoutes}`;

  // 匹配已有 routes 区域：注释行 + 连续的 [[routes]] 块
  const routeBlockRegex = /(# 路由配置[^\n]*\n(?:\[\[routes\]\][^\n]*\n[^\n]*\n[^\n]*\n*)+)/;
  const match = tomlText.match(routeBlockRegex);

  if (match) {
    return tomlText.replace(routeBlockRegex, newBlock);
  }

  // 匹配路由配置占位注释行（含"动态生成"或"自动生成"）
  const commentOnlyRegex = /# 路由配置[^\n]*generate-routes[^\n]*\n/;
  if (tomlText.match(commentOnlyRegex)) {
    return tomlText.replace(commentOnlyRegex, newBlock);
  }

  // 没有找到已有的 routes 区域，在 [vars] 之前插入
  const varsMatch = tomlText.match(/\n(\[vars\])/);
  if (varsMatch) {
    return tomlText.replace(/\n(\[vars\])/, '\n' + newBlock + '\n$1');
  }

  // 都没找到，追加到末尾
  return tomlText + '\n' + newBlock;
}

// ── 处理单个 worker 目录 ─────────────────────────────────
function processWorkerDir(dir) {
  const tomlPath = path.join(dir, 'wrangler.toml');
  if (!fs.existsSync(tomlPath)) {
    console.log(`跳过 ${dir}: wrangler.toml 不存在`);
    return;
  }

  console.log(`处理 ${dir} ...`);
  const tomlText = fs.readFileSync(tomlPath, 'utf8');
  const config = parseDomainConfig(tomlText);

  if (!config) {
    console.log(`  无 DOMAIN_CONFIG_JSON，跳过`);
    return;
  }

  const domains = expandDomains(config);

  if (domains.length === 0) {
    console.log(`  DOMAIN_CONFIG_JSON 中无域名，跳过`);
    return;
  }

  const routesTOML = generateRoutesTOML(domains);
  const newToml = replaceRoutesInToml(tomlText, routesTOML);

  if (newToml !== tomlText) {
    fs.writeFileSync(tomlPath, newToml, 'utf8');
    console.log(`  已更新 ${domains.length} 条 routes`);
  } else {
    console.log(`  routes 已是最新，无需更新`);
  }
}

// ── 主逻辑 ───────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);

  let dirs;
  if (args.length > 0) {
    dirs = args;
  } else {
    const workersDir = path.join(__dirname, '..', 'workers');
    dirs = fs.readdirSync(workersDir)
      .filter(name => fs.existsSync(path.join(workersDir, name, 'wrangler.toml')))
      .map(name => path.join('workers', name));
  }

  for (const dir of dirs) {
    processWorkerDir(dir);
  }
}

main();
