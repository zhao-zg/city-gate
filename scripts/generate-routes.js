#!/usr/bin/env node
/**
 * generate-routes.js
 * 从 wrangler.toml 的 DOMAIN_CONFIG_JSON 提取域名，生成 wrangler.generated.toml
 *
 * 原文件 wrangler.toml 完全不动，生成文件追加 [[routes]] 段
 * CI 部署时使用: wrangler deploy -c wrangler.generated.toml
 *
 * 用法:
 *   node scripts/generate-routes.js [worker-dir ...]
 *   # 默认处理 workers/ 下所有含 wrangler.toml 的目录
 *
 * 支持两种 DOMAIN_CONFIG_JSON 格式：
 *   1. zones + prefixes（推荐）：{ zones: [...], groups: [{ prefix, origin, ... }] }
 *   2. 旧格式 domains 数组：[{ domains: [...], ... }]
 */

const fs = require('fs');
const path = require('path');

const GENERATED_SUFFIX = '.generated.toml';

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
    const zone = domain.split('.').slice(1).join('.');
    lines.push(`[[routes]]`);
    lines.push(`pattern = "${domain}/*"`);
    lines.push(`zone_name = "${zone}"`);
    if (domain !== domains[domains.length - 1]) lines.push('');
  }
  return lines.join('\n') + '\n';
}

// ── 注入 routes 到 toml 文本（在 [vars] 之前插入）─────────
function injectRoutes(tomlText, routesTOML) {
  const insertPoint = '\n[vars]';
  const idx = tomlText.indexOf(insertPoint);
  if (idx === -1) {
    // 没有 [vars]，追加到末尾
    return tomlText + '\n' + routesTOML;
  }
  return tomlText.slice(0, idx) + '\n' + routesTOML + tomlText.slice(idx);
}

// ── 处理单个 worker 目录 ─────────────────────────────────
function processWorkerDir(dir) {
  const srcPath = path.join(dir, 'wrangler.toml');
  const dstPath = path.join(dir, `wrangler${GENERATED_SUFFIX}`);

  if (!fs.existsSync(srcPath)) {
    console.log(`跳过 ${dir}: wrangler.toml 不存在`);
    return;
  }

  console.log(`处理 ${dir} ...`);
  const tomlText = fs.readFileSync(srcPath, 'utf8');
  const config = parseDomainConfig(tomlText);

  if (!config) {
    // 无 DOMAIN_CONFIG_JSON，直接复制原文件（cxapk 等需要保留手写 routes）
    fs.writeFileSync(dstPath, tomlText, 'utf8');
    console.log(`  无 DOMAIN_CONFIG_JSON，直接复制`);
    return;
  }

  const domains = expandDomains(config);

  if (domains.length === 0) {
    fs.writeFileSync(dstPath, tomlText, 'utf8');
    console.log(`  DOMAIN_CONFIG_JSON 中无域名，直接复制`);
    return;
  }

  // 生成 routes 并注入到 [vars] 之前
  const routesTOML = generateRoutesTOML(domains);
  const generated = injectRoutes(tomlText, routesTOML);

  fs.writeFileSync(dstPath, generated, 'utf8');
  console.log(`  已生成 ${domains.length} 条 routes → ${path.basename(dstPath)}`);
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
