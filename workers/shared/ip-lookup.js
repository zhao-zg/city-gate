/**
 * IP 归属地查询 — 统一封装层
 *
 * 优先级：ip2region(KV+内存) > Cloudflare request.cf
 *
 * 使用方式：
 *   1. 请求入口调用 initIpLookup(kv) 初始化（冷启动从 KV 加载 xdb）
 *   2. 调用 lookupIP(ip, cf) 获取归属地信息
 */

import { initIp2Region, searchIp2Region, parseRegionString } from './ip2region.js';

// ── 初始化 ──────────────────────────────────────────
let _initialized = false;

/**
 * 初始化 IP 查询（从 KV 加载 ip2region xdb 到内存）
 * Worker 入口调用一次即可
 *
 * @param {KVNamespace} kv - Cloudflare KV 绑定
 * @param {string} [key='ip2region_v4.xdb'] - xdb 在 KV 中的 key
 */
export async function initIpLookup(kv, key = 'ip2region_v4.xdb') {
  if (_initialized) return;
  try {
    await initIp2Region(kv, key);
    _initialized = true;
  } catch (e) {
    // xdb 加载失败不影响服务，降级到 cf 自带数据
    console.error(`ip2region init failed: ${e.message}`);
  }
}

// ── 归属地结果 ──────────────────────────────────────

/**
 * @typedef {Object} IPLookupResult
 * @property {string} country   - 国家
 * @property {string} province  - 省份（ip2region 更准）
 * @property {string} city     - 城市（ip2region 更准）
 * @property {string} region   - Cloudflare 省级代码
 * @property {string} isp      - 运营商
 * @property {string} source    - 数据来源：'ip2region' | 'cf'
 * @property {string} [lat]    - Cloudflare 经度
 * @property {string} [lon]    - Cloudflare 纬度
 */

/**
 * 查询 IP 归属地
 *
 * @param {string} ip - 客户端 IP
 * @param {Object} cf - request.cf 对象
 * @returns {IPLookupResult}
 */
export function lookupIP(ip, cf = {}) {
  const cfCity = cf.city || '';
  const cfRegion = cf.region || '';
  const cfCountry = cf.country || '';

  // 尝试 ip2region
  const region = searchIp2Region(ip);
  if (region) {
    const p = parseRegionString(region);
    return {
      country: p.country || cfCountry,
      province: p.province || cfRegion,
      city: p.city || cfCity,
      region: cfRegion,
      isp: p.isp,
      source: 'ip2region',
      lat: cf.latitude || '',
      lon: cf.longitude || '',
    };
  }

  // 降级到 Cloudflare
  return {
    country: cfCountry,
    province: cfRegion,
    city: cfCity,
    region: cfRegion,
    isp: '',
    source: 'cf',
    lat: cf.latitude || '',
    lon: cf.longitude || '',
  };
}
