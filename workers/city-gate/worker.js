/**
 * Cloudflare Worker — IP访问限制网关（多域名版）
 *
 * 一个 Worker 即可服务多个域名，每个域名独立配置允许的地区和源站。
 * 新增域名只需在 DOMAIN_GROUPS 中加一条，再在 wrangler.toml 加一条路由。
 *
 * 地理匹配策略（三级，满足任一即放行）：
 *   1. region 省级匹配  — 精度最高，省级由运营商IP段决定，几乎不会错
 *   2. geo 经纬度距离   — 精度中等，容错范围比城市名大
 *   3. city 城市名匹配  — 精度最低，向下兼容旧配置
 *
 * 配置方式 — 域名组：
 *   按源站分组，同组的域名共享 regions / geo / origin
 */

import { denyPage } from '../shared/deny-page.js';
import { initIpLookup, lookupIP } from '../shared/ip-lookup.js';

// ── 默认值 ───────────────────────────────────────────
const DEFAULT_CITIES = ['ALL'];

// ── 域名组配置 ────────────────────────────────────────
// regions: 省份中文名（如 浙江、上海），同时兼容 Cloudflare 英文名（Zhejiang）
// geo:     { lat, lon, radiusKm } 经纬度 + 半径，作为 region 的补充
// cities:  旧方式，城市名精确匹配（向下兼容）
// 环境变量 DOMAIN_CONFIG_JSON 可覆盖此配置（JSON 字符串）
const DOMAIN_GROUPS = [
  {
    origin: 'https://sg-7gj.pages.dev',
    regions: ['浙江', '上海', 'Zhejiang', 'Shanghai'],
    geo: { lat: 30.2741, lon: 120.1551, radiusKm: 150 }, // 杭州 150km 兜底
    domains: [
      'sg.1189.dpdns.org',
      'sg.07170501.xyz',
      'sg.bxg.dpdns.org',
      'sg.zhaozg.dpdns.org',
      'sg.zhaozg.cloudns.org',
    ],
  },
  {
    origin: 'https://books-89r.pages.dev',
    regions: ['浙江', '上海', 'Zhejiang', 'Shanghai'],
    geo: { lat: 30.2741, lon: 120.1551, radiusKm: 150 },
    domains: [
      'books.07170501.xyz',
      'books.1189.dpdns.org',
      'books.zhaozg.dpdns.org'
    ],
  },
  {
    origin: 'https://bible-2o8.pages.dev',
    cities: ['ALL'],
    domains: [
      'bible.zhaozg.dpdns.org',
      'bible.07170501.xyz',
      'bible.1189.dpdns.org'
    ],
  },
  {
    origin: 'https://cx-1wd.pages.dev',
    cities: ['ALL'],
    domains: [
      'cx.zhaozg.dpdns.org'
    ],
  },
  {
    origin: 'https://sg-resource.pages.dev',
    cities: ['ALL'],
    domains: [
      'sg-resource.zhaozg.dpdns.org'
    ],
  }
];

// ── Haversine 距离计算（km）──────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── 构建域名查找表 ────────────────────────────────────
// 将分组配置展开为 { hostname → { regions, geo, cities, origin } } 的扁平字典
const DOMAIN_CONFIG = {};
for (const group of DOMAIN_GROUPS) {
  const regions = group.regions || [];
  const geo = group.geo || null;
  const cities = group.cities || DEFAULT_CITIES;
  for (const domain of group.domains) {
    DOMAIN_CONFIG[domain] = { regions, geo, cities, origin: group.origin };
  }
}

// ── Worker 入口 ───────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const hostname = url.hostname;

    // 0. 初始化 ip2region（从 KV 加载 xdb，冷启动仅一次）
    if (env.IP2REGION) {
      await initIpLookup(env.IP2REGION);
    }

    // 1. 加载配置：环境变量优先，否则用代码内配置
    let config;
    try {
      config = env.DOMAIN_CONFIG_JSON
        ? JSON.parse(env.DOMAIN_CONFIG_JSON)
        : DOMAIN_CONFIG;
    } catch {
      config = DOMAIN_CONFIG;
    }

    // 2. 查找当前域名的地理配置和源站
    const domainCfg = config[hostname] || {};
    const allowedRegions = domainCfg.regions || [];
    const geo = domainCfg.geo || null;
    const allowedCities = domainCfg.cities || DEFAULT_CITIES;
    const origin = domainCfg.origin || env.PAGES_ORIGIN;

    // 3. 城市为 ALL 且无省级/经纬度限制时全部放行
    if (allowedRegions.length === 0 && !geo &&
        allowedCities.length === 1 && allowedCities[0].toUpperCase() === 'ALL') {
      return proxyRequest(request, url, origin);
    }

    // 4. IP 地理判断
    const cf = request.cf || {};
    const clientIP = request.headers.get('CF-Connecting-IP') || '';
    const loc = lookupIP(clientIP, cf);

    // 用 ip2region 的省份/城市（更准），cf 的做兜底
    const province = loc.province || loc.region;
    const city = loc.city;
    const country = loc.country;

    let isAllowed = false;
    const denyReasons = [];

    // 4a. 省级匹配（ip2region 返回中文省名，同时兼容 CF 英文名）
    if (allowedRegions.length > 0) {
      isAllowed = allowedRegions.some(
        r => province.toLowerCase() === r.toLowerCase() || loc.region.toLowerCase() === r.toLowerCase()
      );
      if (!isAllowed) denyReasons.push(`省份 ${province || '未知'} 不在允许列表 [${allowedRegions.join(', ')}]`);
    }

    // 4b. 经纬度距离匹配
    if (!isAllowed && geo) {
      const reqLat = parseFloat(loc.lat);
      const reqLon = parseFloat(loc.lon);
      if (!isNaN(reqLat) && !isNaN(reqLon)) {
        const dist = haversineKm(geo.lat, geo.lon, reqLat, reqLon);
        isAllowed = dist <= geo.radiusKm;
        if (!isAllowed) denyReasons.push(`距允许区域中心 ${dist.toFixed(0)}km，超出 ${geo.radiusKm}km`);
      }
    }

    // 4c. 城市名匹配（ip2region 的城市更准）
    if (!isAllowed && allowedCities.length > 0 &&
        !(allowedCities.length === 1 && allowedCities[0].toUpperCase() === 'ALL')) {
      isAllowed = allowedCities.some(c => city.toLowerCase() === c.toLowerCase());
      if (!isAllowed) denyReasons.push(`城市 ${city || '未知'} 不在允许列表 [${allowedCities.join(', ')}]`);
    }

    // 5. 非允许地区返回 403
    if (!isAllowed) {
      const reason = denyReasons.length > 0 ? denyReasons.join('；') : '不在允许区域';
      return new Response(denyPage(city, province, country, reason, loc.lat, loc.lon, loc.source, loc.isp), {
        status: 403,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // 6. 允许城市：反向代理到源站
    return proxyRequest(request, url, origin);
  },
};

// ── 反向代理 ──────────────────────────────────────────

async function proxyRequest(request, url, origin) {
  const targetUrl = origin + url.pathname + url.search;

  const headers = new Headers(request.headers);
  headers.set('Host', new URL(origin).host);
  headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') || '');
  headers.delete('CF-Connecting-IP');
  headers.delete('CF-IPCountry');
  headers.delete('CF-Ray');
  headers.delete('CF-Visitor');

  const response = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
    redirect: 'manual',
  });

  const respHeaders = new Headers(response.headers);
  respHeaders.delete('x-robots-tag');
  respHeaders.set('Access-Control-Allow-Origin', '*');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: respHeaders,
  });
}


