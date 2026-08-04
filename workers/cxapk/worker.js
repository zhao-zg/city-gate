/**
 * Cloudflare Worker — CX APK 下载代理（带城市检查）
 *
 * 根据 URL 路径段动态替换源站前缀，逐个尝试获取 version.json 并代理 APK 文件。
 * 可通过环境变量 ALLOWED_CITIES 配置允许的城市，不配置则全部允许。
 *
 * 环境变量:
 *   ALLOWED_CITIES — 允许的城市，逗号分隔（不配置则全部允许）
 */

import { denyPage } from '../shared/deny-page.js';

// 源站列表，cx 会被 URL 路径段替换（如 /sg → sg.1189.dpdns.org）
const FALLBACK_BASES = [
  'https://cx.1189.dpdns.org/',
  'https://cx.zhaozg.dpdns.org/',
  'https://cx.07170501.xyz/',
  'https://cx.11891189.xyz/'
];

export default {
  async fetch(request, env) {
    // ── 城市检查（不配置 ALLOWED_CITIES 则全部允许）──
    const allowedCities = (env.ALLOWED_CITIES || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    if (allowedCities.length > 0) {
      const cf = request.cf || {};
      const city = cf.city || '';
      const isAllowed = allowedCities.some(
        c => city.toLowerCase() === c.toLowerCase()
      );
      if (!isAllowed) {
        return new Response(denyPage(city, cf.region, cf.country), {
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


