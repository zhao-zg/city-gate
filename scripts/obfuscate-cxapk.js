/**
 * 混淆 cxapk Pages 下载页 JS
 * 用法：node scripts/obfuscate-cxapk.js
 *
 * 读取 pages/cxapk/index.html，混淆 <script> 内的 JS，写回同一文件。
 * 本地开发保持明文，CI 部署前调用此脚本混淆。
 *
 * 安全保护：如果检测到已经是混淆版（无明文域名），跳过避免双重混淆。
 */
const Obfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'pages', 'cxapk', 'index.html');
const html = fs.readFileSync(filePath, 'utf8');

// 检测是否已经是混淆版：如果源码中没有任何明文域名，说明已混淆，跳过
const PLAINTEXT_MARKER = '1189.dpdns.org';
if (!html.includes(PLAINTEXT_MARKER)) {
  console.log('已是混淆版，跳过');
  process.exit(0);
}

const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) {
  console.error('未找到 <script> 标签');
  process.exit(1);
}

const result = Obfuscator.obfuscate(match[1], {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  rotateStringArray: true,
  selfDefending: true,
});

const newHtml = html.replace(/<script>[\s\S]*?<\/script>/, '<script>\n' + result.getObfuscatedCode() + '\n</script>');
fs.writeFileSync(filePath, newHtml, 'utf8');

// 验证：检查输出文件中是否还有明文标记或域名
const domains = ['1189.dpdns.org','zhaozg.dpdns.org','1189.de5.net','zhaozg.de5.net','zzg.cc.cd','1189.kdns.fr'];
const leakedAfter = domains.filter(d => newHtml.includes(d));
if (leakedAfter.length > 0) {
  console.error('泄露域名:', leakedAfter);
  process.exit(1);
}
console.log('混淆完成 →', filePath, '(' + newHtml.length + ' bytes)');
console.log('域名验证通过，源码中无明文域名');
