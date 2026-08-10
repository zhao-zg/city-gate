/**
 * 混淆 cxapk Pages 下载页 JS
 * 用法：node scripts/obfuscate-cxapk.js
 *
 * 源文件：pages/cxapk/_src.html（未混淆源稿）
 * 输出：pages/cxapk/index.html（混淆后部署版）
 *
 * 域名变更时：修改 _src.html 中的 CFG，重新运行本脚本
 */
const Obfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

const srcFile = path.join(__dirname, '..', 'pages', 'cxapk', '_src.html');
const dstFile = path.join(__dirname, '..', 'pages', 'cxapk', 'index.html');

if (!fs.existsSync(srcFile)) {
  console.error('源文件不存在:', srcFile);
  console.error('请先创建 pages/cxapk/_src.html（含明文 JS 的源稿）');
  process.exit(1);
}

const html = fs.readFileSync(srcFile, 'utf8');
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
fs.writeFileSync(dstFile, newHtml, 'utf8');

// 验证：检查输出文件中是否还有明文域名
const domains = ['1189.dpdns.org','zhaozg.dpdns.org','1189.de5.net','zzg.cc.cd','1189.kdns.fr'];
const leaked = domains.filter(d => newHtml.includes(d));
if (leaked.length > 0) {
  console.error('泄露域名:', leaked);
  process.exit(1);
}
console.log('混淆完成 →', dstFile, '(' + newHtml.length + ' bytes)');
console.log('域名验证通过，源码中无明文域名');
