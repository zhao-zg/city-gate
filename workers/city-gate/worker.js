/**
 * Cloudflare Worker — 城市IP访问限制网关（多城市版）
 *
 * 一个 Worker 即可服务多个域名，每个域名独立配置允许的城市和源站。
 * 新增域名只需在 DOMAIN_GROUPS 中加一条，再在 wrangler.toml 加一条路由。
 *
 * 配置方式 — 域名组：
 *   按源站分组，同组的域名共享 geo / origin，不用重复写。
 *   个别域名有差异时，在 overrides 中覆盖。
 *
 * 地理匹配策略：
 *   geo: { lat, lon, radiusKm } — 经纬度 + 半径(km)，精度远高于城市名匹配
 *   cities: ['Hangzhou']      — 旧方式，城市名精确匹配（向下兼容）
 *   两者同时配置时 geo 优先
 */

import { denyPage } from '../shared/deny-page.js';

// ── 默认值 ───────────────────────────────────────────
const DEFAULT_CITIES = ['ALL'];

// ── 域名组配置 ────────────────────────────────────────
// 按源站分组，同组域名共享 geo / cities / origin
// 环境变量 DOMAIN_CONFIG_JSON 可覆盖此配置（JSON 字符串）
const DOMAIN_GROUPS = [
  {
    origin: 'https://sg-7gj.pages.dev',
    geo: { lat: 30.2741, lon: 120.1551, radiusKm: 70 }, // 杭州 70km
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
    geo: { lat: 30.2741, lon: 120.1551, radiusKm: 70 }, // 杭州 70km
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
// 将分组配置展开为 { hostname → { geo, cities, origin } } 的扁平字典
const DOMAIN_CONFIG = {};
for (const group of DOMAIN_GROUPS) {
  const geo = group.geo || null;
  const cities = group.cities || DEFAULT_CITIES;
  for (const domain of group.domains) {
    DOMAIN_CONFIG[domain] = { geo, cities, origin: group.origin };
  }
}

// ── Worker 入口 ───────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const hostname = url.hostname;

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
    const geo = domainCfg.geo || null;
    const allowedCities = domainCfg.cities || DEFAULT_CITIES;
    const origin = domainCfg.origin || env.PAGES_ORIGIN;

    // 3. 城市为 ALL 时全部放行
    if (allowedCities.length === 1 && allowedCities[0].toUpperCase() === 'ALL' && !geo) {
      return proxyRequest(request, url, origin);
    }

    // 4. IP 地理判断
    const cf = request.cf || {};
    const city = cf.city || '';
    const region = cf.region || '';
    const country = cf.country || '';

    let isAllowed = false;
    let denyReason = '';

    // 优先：经纬度距离匹配
    if (geo) {
      const reqLat = parseFloat(cf.latitude);
      const reqLon = parseFloat(cf.longitude);
      if (!isNaN(reqLat) && !isNaN(reqLon)) {
        const dist = haversineKm(geo.lat, geo.lon, reqLat, reqLon);
        isAllowed = dist <= geo.radiusKm;
        if (!isAllowed) {
          denyReason = `距允许区域中心 ${dist.toFixed(0)}km，超出 ${geo.radiusKm}km 限制`;
        }
      } else {
        // 经纬度缺失时回退到城市名匹配
        isAllowed = allowedCities.some(c => city.toLowerCase() === c.toLowerCase());
        if (!isAllowed) denyReason = '经纬度缺失且城市名不匹配';
      }
    } else {
      // 旧方式：城市名精确匹配
      isAllowed = allowedCities.some(
        c => city.toLowerCase() === c.toLowerCase()
      );
      if (!isAllowed) denyReason = '城市不在允许列表中';
    }

    // 5. 非允许地区返回 403
    if (!isAllowed) {
      const cfLat = cf.latitude || '';
      const cfLon = cf.longitude || '';
      return new Response(denyPage(city, region, country, denyReason, cfLat, cfLon), {
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


