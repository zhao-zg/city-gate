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
    console.log(file, '-> JSON 合法, 分组数:', Array.isArray(config) ? config.length : '对象');
  } catch (e) {
    console.log(file, '-> JSON 非法:', e.message);
  }
}
