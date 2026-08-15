/**
 * Cloudflare Worker — 透明传输网关（多域名版）
 *
 * 将自定义域名请求透明转发到对应的 Pages 项目（*.pages.dev）或外部源站。
 * 不做任何业务逻辑（无城市限制、无 IP 判断、无时间调度）。
 *
 * 域名配置来自环境变量 DOMAIN_CONFIG_JSON（见 wrangler.toml [vars]），
 * 格式：
 *   { "groups": [{ "prefix", "pages_project", "pages_domain?", "origin?" }, ...], "zones": [...] }
 *
 * - pages_domain: Pages 项目的实际 *.pages.dev 域名（由 resolve-pages.js 在 CI 时
 *                  通过 API 自动查询注入，如 "sg-f3b.pages.dev"、"cx-1wd.pages.dev"）
 * - origin:       非 Pages 源站 URL（如 "https://answer.07170501.xyz"），与 pages_domain 互斥
 *
 * 注意：pages_project 仅作标识符（不用于拼接域名），实际转发目标由 pages_domain 决定。
 *       如果 pages_domain 缺失，该 group 将无法转发（返回 502）。
 *
 * 运行时自动展开 prefix.zone 为完整域名，匹配后透明转发。
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const hostname = url.hostname;
    const pathname = url.pathname;

    // 0a. 测速代理路由 — 代理 speed.cloudflare.com/__down
    // 通过 Worker 内部 fetch 访问，不经过 WAF，443 端口可用
    if (pathname === '/__down' || pathname.startsWith('/__down?')) {
      const bytes = url.searchParams.get('bytes') || '104857600'; // 默认 100MB
      const targetUrl = `https://speed.cloudflare.com/__down?bytes=${bytes}`;
      const headers = new Headers();
      headers.set('referer', 'https://speed.cloudflare.com/');
      const resp = await fetch(targetUrl, { headers });
      const respHeaders = new Headers(resp.headers);
      respHeaders.set('Access-Control-Allow-Origin', '*');
      respHeaders.set('Cache-Control', 'no-store');
      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: respHeaders,
      });
    }

    // 0b. CORS 预检（OPTIONS）
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
          'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || '*',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // 1. 加载配置
    let config;
    try {
      config = JSON.parse(env.DOMAIN_CONFIG_JSON);
    } catch {
      return new Response('网关配置错误：DOMAIN_CONFIG_JSON 缺失或非法', { status: 500 });
    }

    // 2. 展开 zones + groups → hostname → target 映射
    const domainMap = {};
    const groups = config.groups || [];
    const zones = config.zones || [];

    for (const group of groups) {
      const groupZones = group.zones || zones;
      for (const zone of groupZones) {
        const zoneName = typeof zone === 'string' ? zone : (zone && zone.name);
        if (!zoneName) continue;
        const domain = `${group.prefix}.${zoneName}`;

        // 确定转发目标：
        //   pages_domain（CI 自动注入的真实域名）> origin（外部源站）
        let target;
        let isPages = false;

        if (group.pages_domain) {
          // CI 通过 API 查询的真实 *.pages.dev 域名
          target = group.pages_domain;
          isPages = true;
        } else if (group.origin) {
          // 非 Pages 源站
          target = group.origin;
          isPages = false;
        } else if (group.pages_project) {
          // pages_project 仅作标识，不用于拼接域名
          // 到达这里说明 resolve-pages.js 未成功运行或该 Pages 项目不存在
          console.error(`group "${group.prefix}" 有 pages_project 但无 pages_domain，跳过`);
          continue;
        }

        if (target) {
          domainMap[domain] = { target, isPages };
        }
      }
    }

    // 3. 查找当前域名的转发目标
    const route = domainMap[hostname];
    if (!route) {
      return new Response('Not Found', { status: 404 });
    }

    // 4. 透明转发
    const originPrefix = route.isPages ? 'https://' : '';
    const target = `${originPrefix}${route.target}${url.pathname}${url.search}`;

    const headers = new Headers(request.headers);
    headers.set('Host', new URL(target).host);
    headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') || '');
    headers.delete('CF-Connecting-IP');
    headers.delete('CF-IPCountry');
    headers.delete('CF-Ray');
    headers.delete('CF-Visitor');

    const response = await fetch(target, {
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
  },
};
