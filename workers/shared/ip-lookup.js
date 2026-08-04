/**
 * IP 归属地查询 — 统一封装层
 *
 * 使用 ip2region（KV+内存缓存）查询 IP 省份信息。
 * 支持 IPv4 和 IPv6 双 xdb：
 *   - v4 xdb 整体存储在 KV（~10.6MB）
 *   - v6 xdb 分片存储在 KV（~36MB，拆成 2 个 ~18MB 分片，避免超 KV 27MiB 限制）
 *
 * 如果 ip2region 不可用（xdb 未加载），降级使用 Cloudflare request.cf 的省级代码。
 *
 * 使用方式：
 *   1. 请求入口调用 initIpLookup(kv) 初始化（冷启动从 KV 加载 xdb）
 *   2. 调用 lookupIP(ip, cf) 获取归属地信息
 */

import { initIp2Region, searchIp2Region, parseRegionString } from './ip2region.js';

// ── 初始化 ──────────────────────────────────────────
let _initialized = false;

/**
 * 初始化 IP 查询（从 KV 加载 ip2region v4/v6 xdb 到内存）
 * Worker 入口调用一次即可
 *
 * @param {KVNamespace} kv - Cloudflare KV 绑定
 * @param {Object} [opts]
 * @param {string} [opts.v4Key] - v4 xdb 在 KV 中的 key
 * @param {string[]} [opts.v6Keys] - v6 xdb 分片 key 列表
 * @param {boolean} [opts.loadV6=true] - 是否加载 v6 xdb
 */
export async function initIpLookup(kv, opts = {}) {
  if (_initialized) return;
  try {
    await initIp2Region(kv, {
      v4Key: opts.v4Key || 'ip2region_v4.xdb',
      v6Keys: opts.v6Keys || ['ip2region_v6_part1', 'ip2region_v6_part2'],
      loadV6: opts.loadV6 !== false,
    });
    _initialized = true;
  } catch (e) {
    console.error(`ip2region init failed: ${e.message}`);
  }
}

// ── 省份/城市名规范化 ──────────────────────────────────

// ip2region 返回 "浙江省"、"上海市"、"内蒙古自治区"、"香港特别行政区"
// 配置中写的是 "浙江"、"上海"、"内蒙古"、"香港"
// 统一剥离后缀，让匹配更宽松

const PROVINCE_SUFFIXES = ['特别行政区', '自治区', '省', '市'];
const CITY_SUFFIXES = ['特别行政区', '自治州', '地区', '盟', '市'];

/**
 * 剥离省份后缀：浙江省 → 浙江，上海市 → 上海，内蒙古自治区 → 内蒙古
 */
function normalizeProvince(name) {
  if (!name) return '';
  for (const s of PROVINCE_SUFFIXES) {
    if (name.endsWith(s)) return name.slice(0, -s.length);
  }
  return name;
}

/**
 * 剥离城市后缀：杭州市 → 杭州，上海市 → 上海
 */
function normalizeCity(name) {
  if (!name) return '';
  for (const s of CITY_SUFFIXES) {
    if (name.endsWith(s)) return name.slice(0, -s.length);
  }
  return name;
}

// ── 归属地结果 ──────────────────────────────────────

/**
 * @typedef {Object} IPLookupResult
 * @property {string} country   - 国家
 * @property {string} province  - 省份（已去后缀：浙江 / CF 英文省级代码）
 * @property {string} city     - 城市（已去后缀：杭州）
 * @property {string} isp      - 运营商
 * @property {string} source    - 数据来源：'ip2region' | 'cf'
 */

/**
 * 查询 IP 归属地
 *
 * IPv4/IPv6 均优先走 ip2region（城市级精确匹配）；
 * ip2region 不可用时降级到 Cloudflare CF 省级代码。
 *
 * @param {string} ip - 客户端 IP
 * @param {Object} cf - request.cf 对象（降级时使用）
 * @returns {IPLookupResult}
 */
export function lookupIP(ip, cf = {}) {
  // 尝试 ip2region（自动路由到 v4/v6 Searcher）
  const region = searchIp2Region(ip);
  if (region) {
    const p = parseRegionString(region);
    return {
      country: p.country || cf.country || '',
      province: normalizeProvince(p.province) || cf.region || '',
      city: normalizeCity(p.city) || cf.city || '',
      isp: p.isp || '',
      source: 'ip2region',
    };
  }

  // 降级到 Cloudflare（省级代码 region 精度可靠）
  return {
    country: cf.country || '',
    province: cf.region || '',
    city: cf.city || '',
    isp: '',
    source: 'cf',
  };
}
