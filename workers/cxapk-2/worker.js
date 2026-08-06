/**
 * Cloudflare Worker — CX APK 下载代理（账户2冗余容灾版）
 *
 * 与 cxapk Worker 逻辑完全相同，仅域名源站指向账户2的域名。
 * 环境变量同 cxapk，详见 ../cxapk/worker.js 注释。
 */

import { denyPage } from '../shared/deny-page.js';
import { initIpLookup, lookupIP } from '../shared/ip-lookup.js';

// 域名源站列表（账户2：走 zhaozg.de5.net 域名，由 city-gate-2 做地理限制）
const DOMAIN_ORIGINS = {
  sg:    'https://sg.zhaozg.de5.net/',
  cx:    'https://cx.zhaozg.de5.net/',
  bible: 'https://bible.zhaozg.de5.net/',
  books: 'https://books.zhaozg.de5.net/',
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
    const origin = DOMAIN_ORIGINS[seg] || DOMAIN_ORIGINS['cx'];

    // 构建转发头：传递客户端真实 IP + 密钥，让 city-gate-2 用客户端 IP 做地理判断
    const clientIP = request.headers.get('CF-Connecting-IP') || '';
    const gateKey = env.GATE_KEY || '';
    const fwdHeaders = { 'X-Original-IP': clientIP };
    if (gateKey) fwdHeaders['X-Gate-Key'] = gateKey;

    try {
      const res = await fetch(origin + 'version.json', {
        headers: fwdHeaders,
        cf: { cacheEverything: false },
      });
      if (!res.ok) return new Response('APK 暂时无法获取，请稍后重试', { status: 502 });
      const { apk_file } = await res.json();
      if (!apk_file) return new Response('APK 信息缺失', { status: 502 });

      const apkRes = await fetch(origin + apk_file, { headers: fwdHeaders });
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
