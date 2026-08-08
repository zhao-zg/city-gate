/**
 * Cloudflare Worker — IP访问限制网关（多域名版）
 *
 * 一个 Worker 即可服务多个域名，每个域名独立配置允许的地区和源站。
 * 域名配置全部来自环境变量 DOMAIN_CONFIG_JSON（见 wrangler.toml [vars]），
 * 新增域名只需在 JSON 的 zones 或 groups 中添加，路由由 CI 自动生成。
 *
 * 地理匹配策略（IPv4/IPv6 均支持）：
 * - ip2region 可用时：城市级精确匹配（如 杭州）
 * - ip2region 不可用时：降级到 CF 省级代码匹配（如 浙江）
 */

import { denyPage, denySchedulePage } from '../shared/deny-page.js';
import { initIpLookup, lookupIP } from '../shared/ip-lookup.js';
import { isInOpenSchedule } from '../shared/schedule.js';

// ── Worker 入口 ───────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const hostname = url.hostname;

    // 0. 初始化 ip2region（从 KV 加载 xdb，冷启动仅一次）
    if (env.IP2REGION) {
      await initIpLookup(env.IP2REGION);
    }

    // 1. 加载配置：全部来自环境变量 DOMAIN_CONFIG_JSON
    //    支持三种结构：
    //    - zones + prefixes：{ zones: [...], groups: [{ prefix, origin, cities, provinces }, ...] }
    //      运行时自动展开 prefix.zone 为完整域名（推荐，简洁免重复）
    //    - 域名组数组：[{ origin, cities, provinces, domains: [...] }, ...]（旧格式，仍兼容）
    //    - 域名映射：{ "域名": { origin, cities, provinces }, ... }（旧格式，仍兼容）
    //    缺失或解析失败时返回 500，避免网关静默失效放行所有请求
    let config;
    try {
      config = JSON.parse(env.DOMAIN_CONFIG_JSON);
    } catch {
      return new Response('网关配置错误：环境变量 DOMAIN_CONFIG_JSON 缺失或不是合法 JSON', {
        status: 500,
      });
    }

    // zones + prefixes 结构 → 展开成 域名 → 配置 映射
    if (config.zones && Array.isArray(config.groups)) {
      const domainMap = {};
      for (const group of config.groups) {
        const cities = group.cities || [];
        const provinces = group.provinces || [];
        const zones = group.zones || config.zones; // 组级可覆盖 zone 列表
        for (const zone of zones) {
          const domain = `${group.prefix}.${zone}`;
          domainMap[domain] = { cities, provinces, origin: group.origin, schedule: group.schedule || null };
        }
      }
      config = domainMap;
    }
    // 域名组数组结构 → 展开成 域名 → 配置 映射（旧格式兼容）
    else if (Array.isArray(config)) {
      const domainMap = {};
      for (const group of config) {
        const cities = group.cities || [];
        const provinces = group.provinces || [];
        for (const domain of group.domains || []) {
          domainMap[domain] = { cities, provinces, origin: group.origin, schedule: group.schedule || null };
        }
      }
      config = domainMap;
    }

    // 2. 查找当前域名的地理配置和源站
    const domainCfg = config[hostname] || {};
    const allowedCities = domainCfg.cities || [];
    const allowedProvinces = domainCfg.provinces || [];
    const origin = domainCfg.origin || env.PAGES_ORIGIN;

    // 2.5 schedule 时间判断（优先于地理围栏）
    if (domainCfg.schedule) {
      if (!isInOpenSchedule(domainCfg.schedule)) {
        return new Response(denySchedulePage(), {
          status: 403,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
    }

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
