/**
 * Cloudflare Worker — CX APK 下载代理（带地理检查）
 *
 * 根据 URL 路径段动态替换源站前缀，获取 version.json 并代理 APK 文件。
 * 走域名源站，通过 X-Original-IP + X-Gate-Key 传递客户端真实 IP，
 * 让 city-gate Worker 正确做地理判断，避免 Worker 自抓被 403。
 *
 * 环境变量:
 *   GATE_KEY         — 与 city-gate 共享的密钥，防止 X-Original-IP 伪造
 *   ALLOWED_CITIES   — 允许的城市，逗号分隔（如 "杭州,Hangzhou"）
 *   ALLOWED_PROVINCES— 允许的省份，逗号分隔（如 "浙江,Zhejiang"）
 */

import { initIpLookup, lookupIP } from '../shared/ip-lookup.js';

// 域名源站列表（走域名，由 city-gate 做地理限制）
// key: 路径段前缀, value: 域名源站 URL
const DOMAIN_ORIGINS = {
  sg:    'https://sg.zhaozg.dpdns.org/',
  cx:    'https://cx.zhaozg.dpdns.org/',
  bible: 'https://bible.zhaozg.dpdns.org/',
  books: 'https://books.zhaozg.dpdns.org/',
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
        return new Response('Forbidden', { status: 403 });
      }
    }

    // ── APK 代理逻辑 ──
    const url = new URL(request.url);
    const seg = url.pathname.split('/').filter(Boolean)[0] || '';
    const origin = DOMAIN_ORIGINS[seg] || DOMAIN_ORIGINS['cx'];

    // 构建转发头：传递客户端真实 IP + 密钥，让 city-gate 用客户端 IP 做地理判断
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
