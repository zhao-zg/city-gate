#!/usr/bin/env node
/**
 * 三网优选 IP 拉取工具
 *
 * 从 cf.090227.xyz 的三个端点分别拉取联通/电信/移动优选 IP：
 *   /cu   → 联通（Unicom）
 *   /ct   → 电信（Telecom）
 *   /cmcc → 移动（Mobile）
 *
 * 支持在端点后追加 ?ips=N 指定返回数量，如 /ct?ips=100 获取 100 个电信优选 IP。
 * fetchIspIps(perLine) 会把 perLine 作为 ?ips=N 传给 API；若 API 不支持该参数，
 * 则返回全量，本地再 slice(0, perLine) 保底截断。
 *
 * 返回格式：
 *   {
 *     unicom:  [ip1, ip2, ...],
 *     telecom: [ip1, ip2, ...],
 *     mobile:  [ip1, ip2, ...]
 *   }
 *
 * 环境变量：
 *   ISP_IP_SOURCE — 三网优选 IP 源域名（默认 cf.090227.xyz）
 *   ISP_IP_PER_LINE — 每条线路取几个 IP（默认 2）
 *
 * 用法：
 *   const { fetchIspIps } = require('./fetch-isp-ips');
 *   const ispIps = await fetchIspIps();
 */

const http = require('http');
const https = require('https');

const ISP_IP_SOURCE = process.env.ISP_IP_SOURCE || 'cf.090227.xyz';
const ISP_IP_PER_LINE = parseInt(process.env.ISP_IP_PER_LINE || '2', 10);

// Cloudflare 边缘 IP 回退列表
// 当 ISP_IP_SOURCE 域名 DNS 解析到源站（非 CF 边缘）导致端点 404 时，
// 使用这些 CF Anycast IP + SNI + Host header 直连 CF 边缘访问 Worker。
const CF_EDGE_IPS = [
  '104.18.33.45', '172.64.154.211', '104.18.42.98', '172.64.145.158',
  '104.16.159.115', '104.17.51.91', '104.17.112.66',
];

// 华为云 DNS 线路 ID（与 dns-huaweicloud.js 对应）
const HW_LINES = {
  telecom: 'Dianxin',
  unicom: 'Liantong',
  mobile: 'Yidong',
  default: 'default_view',
};

/**
 * 从指定端点拉取 IP 列表
 * 返回格式：每行 "IP#注释"，取 # 前面的 IP
 *
 * 访问策略（按顺序尝试）：
 * 1. HTTPS 域名直连 — 正常情况下域名解析到 CF 边缘，Worker 直接可用
 * 2. HTTP 域名直连 — HTTPS 证书/连接失败时的降级
 * 3. HTTPS + CF 边缘 IP + SNI — DNS 被分线路解析到源站导致 404 时的回退
 *
 * @param {string} path  - 端点路径（如 ct/cu/cmcc）
 * @param {number} [count] - 请求的 IP 数量，追加 ?ips=N；不传则拉全量
 */
async function fetchIpsFromEndpoint(path, count) {
  const query = count && count > 0 ? `?ips=${count}` : '';
  const urlPath = `/${path}${query}`;

  // 策略 1: HTTPS 域名直连
  try {
    return await fetchWith(`https://${ISP_IP_SOURCE}${urlPath}`, https);
  } catch (httpsErr) {
    // 策略 2: HTTP 域名直连
    try {
      return await fetchWith(`http://${ISP_IP_SOURCE}${urlPath}`, http);
    } catch (httpErr) {
      // 策略 3: HTTPS + CF 边缘 IP + SNI 回退
      // 某些网络环境下 ISP_IP_SOURCE 域名 DNS 被分线路解析到源站，
      // 源站上没有 Worker 端点返回 404，需要直连 CF 边缘 IP 访问。
      for (const cfIp of CF_EDGE_IPS) {
        try {
          return await fetchWithCfEdge(cfIp, urlPath);
        } catch (cfErr) {
          // 继续尝试下一个 CF 边缘 IP
        }
      }
      // 所有策略都失败，抛出第一个 HTTPS 错误（最有参考价值）
      throw httpsErr;
    }
  }
}

function fetchWith(url, mod) {
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${url}`));
          return;
        }
        const ips = data
          .split('\n')
          .map((line) => line.split('#')[0].trim())
          .filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
        resolve(ips);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`请求超时: ${url}`));
    });
  });
}

/**
 * 通过 Cloudflare 边缘 IP + SNI + Host header 访问 Worker
 * 用于域名 DNS 被分线路解析到源站的回退场景
 */
function fetchWithCfEdge(cfIp, urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: cfIp,
      port: 443,
      path: urlPath,
      headers: { Host: ISP_IP_SOURCE },
      servername: ISP_IP_SOURCE, // SNI
      rejectUnauthorized: true,
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`CF边缘 ${cfIp} HTTP ${res.statusCode}`));
          return;
        }
        const ips = data
          .split('\n')
          .map((line) => line.split('#')[0].trim())
          .filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
        resolve(ips);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`CF边缘 ${cfIp} 请求超时`));
    });
  });
}

/**
 * 拉取三网优选 IP
 *
 * @param {number} perLine - 每条线路取几个 IP（默认 ISP_IP_PER_LINE）
 * @returns {Promise<{telecom: string[], unicom: string[], mobile: string[], default: string[]}>}
 */
async function fetchIspIps(perLine = ISP_IP_PER_LINE) {
  console.log(`\n── 三网优选 IP 拉取 ──`);
  console.log(`  源: ${ISP_IP_SOURCE}`);
  console.log(`  每线路: ${perLine} 个 IP`);

  const endpoints = [
    { key: 'telecom', path: 'ct', label: '电信' },
    { key: 'unicom', path: 'cu', label: '联通' },
    { key: 'mobile', path: 'cmcc', label: '移动' },
  ];

  const result = { telecom: [], unicom: [], mobile: [], default: [] };

  for (const ep of endpoints) {
    try {
      // 向 API 请求 perLine 个 IP；若 API 不支持 ?ips=N 则返回全量，本地再 slice 保底
      const allIps = await fetchIpsFromEndpoint(ep.path, perLine);
      const ips = allIps.slice(0, perLine);
      result[ep.key] = ips;
      console.log(`  ${ep.label} (${ep.path}): ${ips.length} 个 → ${ips.join(', ')}`);
    } catch (e) {
      console.error(`  ${ep.label} (${ep.path}): 拉取失败 — ${e.message}`);
    }
  }

  // default 线路：合并三网所有 IP 去重，作为保底解析
  const defaultCandidates = [];
  for (const ep of endpoints) {
    defaultCandidates.push(...result[ep.key]);
  }
  result.default = [...new Set(defaultCandidates)];
  console.log(`  默认 (default): ${result.default.length} 个 → ${result.default.join(', ')}`);

  return result;
}

module.exports = {
  fetchIspIps,
  HW_LINES,
  ISP_IP_SOURCE,
};
