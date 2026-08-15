#!/usr/bin/env node
// 列出所有 Worker routes 和 SaaS Custom Hostnames，帮助判断是否冲突
const fs = require('fs');
const path = require('path');

function parseConfig(workerDir) {
  const tomlPath = path.join(workerDir, 'wrangler.toml');
  if (!fs.existsSync(tomlPath)) return null;
  const toml = fs.readFileSync(tomlPath, 'utf8');
  const m = toml.match(/DOMAIN_CONFIG_JSON\s*=\s*"""([\s\S]*?)"""/);
  if (!m) return null;
  return JSON.parse(m[1]);
}

function expandDomains(config) {
  const domains = [];
  if (config.zones && Array.isArray(config.groups)) {
    for (const group of config.groups) {
      const zones = group.zones || config.zones;
      for (const zone of zones) {
        const zoneName = typeof zone === 'string' ? zone : (zone && zone.name);
        if (zoneName) domains.push(`${group.prefix}.${zoneName}`);
      }
    }
  }
  return [...new Set(domains)].sort();
}

for (const dir of ['workers/city-gate', 'workers/city-gate-2']) {
  const config = parseConfig(dir);
  if (!config) { console.log(`\n${dir}: 无配置`); continue; }
  const domains = expandDomains(config);
  console.log(`\n${dir} — Worker routes (${domains.length} 个):`);
  domains.forEach(d => console.log(`  ${d}/*`));
}
