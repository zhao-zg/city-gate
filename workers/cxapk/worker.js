/**
 * Cloudflare Worker — CX APK 下载代理（带地理检查）
 *
 * 根据 URL 路径段动态替换源站前缀，逐个尝试获取 version.json 并代理 APK 文件。
 * 支持经纬度距离匹配（精度高）和城市名匹配（兼容旧配置）。
 *
 * 环境变量:
 *   ALLOWED_CITIES — 允许的城市，逗号分隔（不配置则全部允许）
 *   GEO_CENTER     — 允许区域中心，格式 "lat,lon"（如 "30.2741,120.1551"）
 *   GEO_RADIUS_KM  — 允许半径(km)，默认 150
 */

import { denyPage } from '../shared/deny-page.js';

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

// 源站列表，cx 会被 URL 路径段替换（如 /sg → sg.1189.dpdns.org）
const FALLBACK_BASES = [
  'https://cx.1189.dpdns.org/',
  'https://cx.zhaozg.dpdns.org/',
  'https://cx.07170501.xyz/',
  'https://cx.11891189.xyz/'
];

export default {
  async fetch(request, env) {
    // ── 地理检查 ──
    const allowedCities = (env.ALLOWED_CITIES || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    const geoCenter = (env.GEO_CENTER || '').split(',').map(Number);
    const geoRadius = parseFloat(env.GEO_RADIUS_KM) || 150;
    const hasGeo = geoCenter.length === 2 && !isNaN(geoCenter[0]) && !isNaN(geoCenter[1]);

    if (allowedCities.length > 0 || hasGeo) {
      const cf = request.cf || {};
      const city = cf.city || '';
      let isAllowed = false;
      let denyReason = '';

      // 优先：经纬度距离匹配
      if (hasGeo) {
        const reqLat = parseFloat(cf.latitude);
        const reqLon = parseFloat(cf.longitude);
        if (!isNaN(reqLat) && !isNaN(reqLon)) {
          const dist = haversineKm(geoCenter[0], geoCenter[1], reqLat, reqLon);
          isAllowed = dist <= geoRadius;
          if (!isAllowed) denyReason = `距允许区域中心 ${dist.toFixed(0)}km，超出 ${geoRadius}km 限制`;
        } else if (allowedCities.length > 0) {
          // 经纬度缺失时回退到城市名匹配
          isAllowed = allowedCities.some(c => city.toLowerCase() === c.toLowerCase());
          if (!isAllowed) denyReason = '经纬度缺失且城市名不匹配';
        }
      } else if (allowedCities.length > 0) {
        isAllowed = allowedCities.some(c => city.toLowerCase() === c.toLowerCase());
        if (!isAllowed) denyReason = '城市不在允许列表中';
      }

      if (!isAllowed) {
        return new Response(denyPage(city, cf.region, cf.country, denyReason, cf.latitude || '', cf.longitude || ''), {
          status: 403,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
    }

    // ── APK 代理逻辑 ──
    const url = new URL(request.url);
    const seg = url.pathname.split('/').filter(Boolean)[0] || '';
    const allBases = seg
      ? FALLBACK_BASES.map(b => b.replace('cx', seg))
      : FALLBACK_BASES;

    for (const base of allBases) {
      try {
        const res = await fetch(base + 'version.json', { cf: { cacheEverything: false } });
        if (!res.ok) continue;
        const { apk_file } = await res.json();
        if (!apk_file) continue;
        const apkRes = await fetch(base + apk_file);
        if (!apkRes.ok) continue;
        return new Response(apkRes.body, {
          status: 200,
          headers: {
            'Content-Type': apkRes.headers.get('Content-Type') || 'application/vnd.android.package-archive',
            'Content-Length': apkRes.headers.get('Content-Length') || '',
            'Content-Disposition': 'attachment; filename="' + apk_file.split('/').pop() + '"',
          },
        });
      } catch (_) {
        continue;
      }
    }
    return new Response('APK 暂时无法获取，请稍后重试', { status: 502 });
  },
};


