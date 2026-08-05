/**
 * Cloudflare Worker — IP访问限制网关（多域名版）
 *
 * 一个 Worker 即可服务多个域名，每个域名独立配置允许的地区和源站。
 * 新增域名只需在 DOMAIN_GROUPS 中加一条，再在 wrangler.toml 加一条路由。
 *
 * 地理匹配策略（IPv4/IPv6 均支持）：
 * - ip2region 可用时：城市级精确匹配（如 杭州）
 * - ip2region 不可用时：降级到 CF 省级代码匹配（如 浙江）
 */

import { denyPage } from '../shared/deny-page.js';
import { initIpLookup, lookupIP } from '../shared/ip-lookup.js';

// ── 域名组配置 ────────────────────────────────────────
// cities: 城市名（支持中文如 杭州、上海，和英文如 Hangzhou、Shanghai）
// provinces: 省份名（ip2region 不可用时降级使用省级匹配）
// 环境变量 DOMAIN_CONFIG_JSON 可覆盖此配置（JSON 字符串）
const DOMAIN_GROUPS = [
  {
    origin: 'https://sg-7gj.pages.dev',
    cities: ['杭州', 'Hangzhou'],
    provinces: ['浙江', 'Zhejiang'],
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
    cities: ['杭州', 'Hangzhou'],
    provinces: ['浙江', 'Zhejiang'],
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

// ── 构建域名查找表 ────────────────────────────────────
const DOMAIN_CONFIG = {};
for (const group of DOMAIN_GROUPS) {
  const cities = group.cities || [];
  const provinces = group.provinces || [];
  for (const domain of group.domains) {
    DOMAIN_CONFIG[domain] = { cities, provinces, origin: group.origin };
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
    const allowedCities = domainCfg.cities || [];
    const allowedProvinces = domainCfg.provinces || [];
    const origin = domainCfg.origin || env.PAGES_ORIGIN;

    // 3. cities 包含 ALL 时全部放行
    if (allowedCities.some(c => c.toUpperCase() === 'ALL')) {
      return proxyRequest(request, url, origin);
    }

    // 4. 无地区限制时也放行
    if (allowedCities.length === 0) {
      return proxyRequest(request, url, origin);
    }

    // 5. IP 地理判断
    // 优先使用可信 Worker 传递的原始客户端 IP（X-Original-IP + X-Gate-Key 校验）
    const cf = request.cf || {};
    const gateKey = request.headers.get('X-Gate-Key') || '';
    const originalIP = request.headers.get('X-Original-IP') || '';
    const trustedKey = env.GATE_KEY || '';

    // 只有密钥匹配时才信任 X-Original-IP（防伪造）
    const clientIP = (gateKey && trustedKey && gateKey === trustedKey && originalIP)
      ? originalIP
      : (request.headers.get('CF-Connecting-IP') || '');

    const loc = lookupIP(clientIP, cf);

    let isAllowed = false;
    let matchLevel = '';

    if (loc.source === 'ip2region' && loc.city) {
      // ip2region 城市级精确匹配（IPv4/IPv6 均支持）
      isAllowed = allowedCities.some(
        c => loc.city.toLowerCase() === c.toLowerCase()
      );
      if (isAllowed) matchLevel = 'city';
    }

    if (!isAllowed && loc.province) {
      // ip2region 不可用时降级到省级匹配（CF 的 region 省级代码可靠）
      isAllowed = allowedProvinces.some(
        p => loc.province.toLowerCase() === p.toLowerCase()
      );
      if (isAllowed) matchLevel = 'province';
    }

    // 6. 非允许地区返回 403
    if (!isAllowed) {
      const reason = `${matchLevel ? '省级' : '城市'}匹配失败：${loc.city || '未知城市'}/${loc.province || '未知省份'}不在允许地区`;
      const debugInfo = `IP: ${clientIP} | ip2region: ${loc.city}/${loc.province} | CF: ${cf.city || '?'}/${cf.region || '?'} | 匹配级别: ${matchLevel || 'none'}`;
      return new Response(denyPage(loc.city, loc.province, loc.country, reason, loc.source, loc.isp, debugInfo), {
        status: 403,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // 7. 允许地区：反向代理到源站
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
