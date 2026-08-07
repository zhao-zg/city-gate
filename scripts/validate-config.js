const fs = require('fs');
const path = require('path');

for (const dir of ['workers/city-gate', 'workers/city-gate-2', 'workers/cxapk', 'workers/cxapk-2']) {
  const file = path.join(dir, 'wrangler.toml');
  if (!fs.existsSync(file)) { console.log(file, '-> 不存在'); continue; }
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/DOMAIN_CONFIG_JSON\s*=\s*"""([\s\S]*?)"""/);
  if (!m) { console.log(file, '-> 未找到 DOMAIN_CONFIG_JSON'); continue; }
  try {
    const config = JSON.parse(m[1]);
    if (config.zones && Array.isArray(config.groups)) {
      const domains = [];
      for (const g of config.groups) {
        const zones = g.zones || config.zones;
        for (const z of zones) domains.push(g.prefix + '.' + z);
      }
      console.log(file, '-> zones+prefixes 格式, 分组数:', config.groups.length, '域名数:', domains.length);
    } else if (Array.isArray(config)) {
      console.log(file, '-> 域名组数组格式, 分组数:', config.length);
    } else {
      console.log(file, '-> 未知格式');
    }
  } catch (e) {
    console.log(file, '-> JSON 非法:', e.message);
  }
}
