/**
 * Cloudflare Worker — 城市IP访问限制网关（多城市版）
 *
 * 一个 Worker 即可服务多个域名，每个域名独立配置允许的城市和源站。
 * 新增城市只需在 DOMAIN_CONFIG 中加一条，再在 wrangler.toml 加一条路由。
 *
 * 域名配置格式：
 *   "域名": { cities: ["城市1", "城市2"], origin: "https://源站" }
 */

// ── 域名配置 ──────────────────────────────────────────
// 每个域名的允许城市列表 + 代理源站
// 环境变量 DOMAIN_CONFIG_JSON 可覆盖此配置（JSON 字符串）
const DOMAIN_CONFIG = {
  'sg.1189.dpdns.org': {
    cities: ['Hangzhou'],
    origin: 'https://sg-7gj.pages.dev',
  },
  'sg.07170501.xyz': {
    cities: ['Hangzhou'],
    origin: 'https://sg-7gj.pages.dev',
  },
  'sg.bxg.dpdns.org': {
    cities: ['Hangzhou'],
    origin: 'https://sg-7gj.pages.dev',
  },
  'sg.zhaozg.dpdns.org': {
    cities: ['Hangzhou'],
    origin: 'https://sg-7gj.pages.dev',
  },
  'sg.zhaozg.cloudns.org': {
    cities: ['Hangzhou'],
    origin: 'https://sg-7gj.pages.dev',
  },
};

// 兜底默认值（域名未匹配时使用）
const DEFAULT_ORIGIN = 'https://sg.pages.dev';
const DEFAULT_CITIES = ['Hangzhou'];

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
    const origin = domainCfg.origin || env.PAGES_ORIGIN || DEFAULT_ORIGIN;

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

// ── 403 页面 ─────────────────────────────────────────

function denyPage(city, region, country) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>访问受限</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      color: #fff;
    }
    .card {
      background: rgba(255,255,255,0.12);
      backdrop-filter: blur(20px);
      border-radius: 20px;
      padding: 48px 40px;
      max-width: 420px;
      text-align: center;
      border: 1px solid rgba(255,255,255,0.2);
    }
    .icon { font-size: 64px; margin-bottom: 24px; }
    h1 { font-size: 24px; margin-bottom: 12px; }
    p { font-size: 14px; line-height: 1.8; opacity: 0.9; }
    .info {
      margin-top: 20px;
      padding: 12px 20px;
      background: rgba(255,255,255,0.1);
      border-radius: 12px;
      font-size: 13px;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">&#128274;</div>
    <h1>访问受限</h1>
    <p>您所在的地区暂不支持访问<br>如有需要请联系管理员</p>
    <div class="info">
      您的 IP 归属地：${city || '未知'}${region ? '，' + region : ''}${country ? '，' + country : ''}
    </div>
  </div>
</body>
</html>`;
}
