#!/usr/bin/env node
const sc = require('../scripts/sync-cname');
const fs = require('fs');
const path = require('path');

const workersDir = path.join(__dirname, '..', 'workers');
const dirs = fs.readdirSync(workersDir)
  .filter(n => fs.existsSync(path.join(workersDir, n, 'wrangler.toml')));

for (const dir of dirs) {
  const t = fs.readFileSync(path.join(workersDir, dir, 'wrangler.toml'), 'utf8');
  const c = sc.parseDomainConfig(t);
  if (!c) continue;
  const wn = sc.parseWorkerName(t) || dir;
  const tk = sc.WORKER_TOKEN_KEYS[wn] || 'default';
  console.log(`\n=== ${dir} (tokenKey=${tk}) ===`);
  for (const g of c.groups) {
    console.log(`  prefix=${g.prefix}, origin=${g.origin}, pages_project=${g.pages_project || '(none)'}`);
  }
}
