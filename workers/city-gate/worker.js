/**
 * Cloudflare Worker — 城市IP访问限制网关（多城市版）
 *
 * 一个 Worker 即可服务多个域名，每个域名独立配置允许的城市和源站。
 * 新增域名只需在 DOMAIN_GROUPS 中加一条，再在 wrangler.toml 加一条路由。
 *
 * 配置方式 — 域名组：
 *   按源站分组，同组的域名共享 cities 和 origin，不用重复写。
 *   个别域名有差异时，在 overrides 中覆盖。
 */

import { denyPage } from '../shared/deny-page.js';

// ── 默认值 ───────────────────────────────────────────
const DEFAULT_CITIES = ['Hangzhou'];

// ── 域名组配置 ────────────────────────────────────────
// 按源站分组，同组域名共享 cities / origin
// 环境变量 DOMAIN_CONFIG_JSON 可覆盖此配置（JSON 字符串）
const DOMAIN_GROUPS = [
  {
    origin: 'https://sg-7gj.pages.dev',
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
    cities: ['Hangzhou'],
    domains: [
      'books.07170501.xyz',
      'books.1189.dpdns.org',
      'books.zhaozg.dpdns.org'
    ],
  },
];

// ── 构建域名查找表 ────────────────────────────────────
// 将分组配置展开为 { hostname → { cities, origin } } 的扁平字典
const DOMAIN_CONFIG = {};
for (const group of DOMAIN_GROUPS) {
  const cities = group.cities || DEFAULT_CITIES;
  for (const domain of group.domains) {
    DOMAIN_CONFIG[domain] = { cities, origin: group.origin };
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

    // 2. 查找当前域名的城市列表和源站
    const domainCfg = config[hostname] || {};
    const allowedCities = domainCfg.cities || DEFAULT_CITIES;
    const origin = domainCfg.origin || env.PAGES_ORIGIN;

    // 3. IP 地理判断
    const cf = request.cf || {};
    const city = cf.city || '';
    const region = cf.region || '';
    const country = cf.country || '';

    const isAllowed = allowedCities.some(
      c => city.toLowerCase() === c.toLowerCase()
    );

    // 4. 非允许城市返回 403
    if (!isAllowed) {
      return new Response(denyPage(city, region, country), {
        status: 403,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // 5. 允许城市：反向代理到源站
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


