#!/usr/bin/env node
/**
 * 三网优选 IP 拉取工具
 *
 * 从 cf.090227.xyz 的三个端点分别拉取联通/电信/移动优选 IP：
 *   /cu   → 联通（Unicom）
 *   /ct   → 电信（Telecom）
 *   /cmcc → 移动（Mobile）
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
 * 优先使用 HTTPS，若 HTTPS 失败（证书错误/连接重置等）则自动降级到 HTTP。
 * 某些 CF 优选 IP 源的 443 端口可能被重置，但 80 端口正常。
 */
async function fetchIpsFromEndpoint(path) {
  const httpsUrl = `https://${ISP_IP_SOURCE}/${path}`;
  const httpUrl = `http://${ISP_IP_SOURCE}/${path}`;

  // 先尝试 HTTPS
  try {
    return await fetchWith(httpsUrl, https);
  } catch (httpsErr) {
    // HTTPS 失败，降级到 HTTP
    try {
      return await fetchWith(httpUrl, http);
    } catch (httpErr) {
      // 两个都失败，抛出 HTTPS 的错误（更有参考价值）
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
      const allIps = await fetchIpsFromEndpoint(ep.path);
      const ips = allIps.slice(0, perLine);
      result[ep.key] = ips;
      console.log(`  ${ep.label} (${ep.path}): ${ips.length} 个 → ${ips.join(', ')}`);
    } catch (e) {
      console.error(`  ${ep.label} (${ep.path}): 拉取失败 — ${e.message}`);
    }
  }

  // default 线路：从三网各取第一个 IP 拼成去重列表（最多 perLine 个）
  const defaultCandidates = [];
  for (const ep of endpoints) {
    if (result[ep.key].length > 0) {
      defaultCandidates.push(result[ep.key][0]);
    }
  }
  // 去重
  result.default = [...new Set(defaultCandidates)].slice(0, perLine);
  console.log(`  默认 (default): ${result.default.length} 个 → ${result.default.join(', ')}`);

  return result;
}

module.exports = {
  fetchIspIps,
  HW_LINES,
  ISP_IP_SOURCE,
};
