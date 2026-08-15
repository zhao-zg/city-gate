#!/usr/bin/env node
// 验证 setup-saas.js buildFqdnOriginMap 是否正确提取 pagesProject
const saas = require('../scripts/setup-saas');

const fqdnList = saas.buildFqdnOriginMap();
console.log(`\n共 ${fqdnList.length} 个 FQDN\n`);

let withProject = 0;
let withoutProject = 0;
for (const f of fqdnList) {
  if (f.pagesProject) {
    withProject++;
    console.log(`  ✓ ${f.fqdn} → pagesProject=${f.pagesProject}, tokenKey=${f.tokenKey}`);
  } else {
    withoutProject++;
    console.log(`  - ${f.fqdn} → no pagesProject, tokenKey=${f.tokenKey}, origin=${f.origin}`);
  }
}

console.log(`\n有 pages_project: ${withProject}, 无 pages_project: ${withoutProject}`);
