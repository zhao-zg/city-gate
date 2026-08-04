/**
 * Cloudflare Worker — CX APK 下载代理（带地理检查）
 *
 * 根据 URL 路径段动态替换源站前缀，逐个尝试获取 version.json 并代理 APK 文件。
 * 地理匹配策略（IPv4/IPv6 均支持）：
 * - ip2region 可用时：城市级精确匹配
 * - ip2region 不可用时：降级到 CF 省级代码匹配
 *
 * 环境变量:
 *   ALLOWED_CITIES — 允许的城市，逗号分隔（如 "杭州,Hangzhou"）
 *   ALLOWED_PROVINCES — 允许的省份，逗号分隔（如 "浙江,Zhejiang"）
 */

import { denyPage } from '../shared/deny-page.js';
import { initIpLookup, lookupIP } from '../shared/ip-lookup.js';

// 源站列表（直连 Pages 源站，绕过 city-gate 地理限制，避免 Worker 自抓被 403）
// key: 路径段前缀, value: Pages 源站 URL
const PAGES_ORIGINS = {
  sg:   'https://sg-7gj.pages.dev/',
  cx:   'https://cx-1wd.pages.dev/',
  bible: 'https://bible-2o8.pages.dev/',
  books: 'https://books-89r.pages.dev/',
};

export default {
  async fetch(request, env) {
    // 0. 初始化 ip2region（从 KV 加载 xdb，冷启动仅一次）
    if (env.IP2REGION) {
      await initIpLookup(env.IP2REGION);
    }

    // ── 地理检查 ──
    const allowedCities = (env.ALLOWED_CITIES || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const allowedProvinces = (env.ALLOWED_PROVINCES || '')
      .split(',').map(s => s.trim()).filter(Boolean);

    // 包含 ALL 或未配置时跳过检查
    if (allowedCities.length > 0 && !allowedCities.some(c => c.toUpperCase() === 'ALL')) {
      const cf = request.cf || {};
      const clientIP = request.headers.get('CF-Connecting-IP') || '';
      const loc = lookupIP(clientIP, cf);

      let isAllowed = false;
      let matchLevel = '';

      // 城市级精确匹配（IPv4/IPv6 均走 ip2region）
      if (loc.source === 'ip2region' && loc.city) {
        isAllowed = allowedCities.some(
          c => loc.city.toLowerCase() === c.toLowerCase()
        );
        if (isAllowed) matchLevel = 'city';
      }

      // 省级匹配（ip2region 不可用时降级）
      if (!isAllowed && loc.province) {
        isAllowed = allowedProvinces.some(
          p => loc.province.toLowerCase() === p.toLowerCase()
        );
        if (isAllowed) matchLevel = 'province';
      }

      if (!isAllowed) {
        const reason = `${matchLevel ? '省级' : '城市'}匹配失败：${loc.city || '未知城市'}/${loc.province || '未知省份'}不在允许地区`;
        const debugInfo = `IP: ${clientIP} | ip2region: ${loc.city}/${loc.province} | CF: ${cf.city || '?'}/${cf.region || '?'} | 匹配级别: ${matchLevel || 'none'}`;
        return new Response(denyPage(loc.city, loc.province, loc.country, reason, loc.source, loc.isp, debugInfo), {
          status: 403,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
    }

    // ── APK 代理逻辑 ──
    const url = new URL(request.url);
    const seg = url.pathname.split('/').filter(Boolean)[0] || '';
    const origin = PAGES_ORIGINS[seg] || PAGES_ORIGINS['cx'];
    const basePath = url.pathname.replace(/^\/[^/]+/, '') || '/';

    // version.json 在源站根目录
    const baseUrl = seg ? origin : PAGES_ORIGINS['cx'];
    try {
      const res = await fetch(baseUrl + 'version.json', { cf: { cacheEverything: false } });
      if (!res.ok) return new Response('APK 暂时无法获取，请稍后重试', { status: 502 });
      const { apk_file } = await res.json();
      if (!apk_file) return new Response('APK 信息缺失', { status: 502 });
      const apkRes = await fetch(baseUrl + apk_file);
      if (!apkRes.ok) return new Response('APK 下载失败', { status: 502 });
      return new Response(apkRes.body, {
        status: 200,
        headers: {
          'Content-Type': apkRes.headers.get('Content-Type') || 'application/vnd.android.package-archive',
          'Content-Length': apkRes.headers.get('Content-Length') || '',
          'Content-Disposition': 'attachment; filename="' + apk_file.split('/').pop() + '"',
        },
      });
    } catch (_) {
      return new Response('APK 暂时无法获取，请稍后重试', { status: 502 });
    }
  },
};
