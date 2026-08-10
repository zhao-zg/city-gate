const Obfuscator = require('../.temp/obf/node_modules/javascript-obfuscator');

const code = `var suffixes = ['zhaozg.dpdns.org', '1189.dpdns.org'];`;

// Test 1: base64 encoding (current config)
const result1 = Obfuscator.obfuscate(code, {
  compact: true,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 1,
  rotateStringArray: true,
});
const obf1 = result1.getObfuscatedCode();

// Test 2: rc4 encoding
const result2 = Obfuscator.obfuscate(code, {
  compact: true,
  stringArray: true,
  stringArrayEncoding: ['rc4'],
  stringArrayThreshold: 1,
  rotateStringArray: true,
});
const obf2 = result2.getObfuscatedCode();

const domains = ['1189.dpdns.org','zhaozg.dpdns.org','1189.de5.net','zhaozg.de5.net','zzg.cc.cd','1189.kdns.fr'];

console.log('=== base64 泄露检测 ===');
console.log('泄露域名:', domains.filter(d => obf1.includes(d)));
console.log('代码片段:', obf1.substring(0, 500));

console.log('\n=== rc4 泄露检测 ===');
console.log('泄露域名:', domains.filter(d => obf2.includes(d)));
console.log('代码片段:', obf2.substring(0, 500));
