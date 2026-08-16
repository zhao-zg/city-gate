#!/usr/bin/env node
/**
 * Cloudflare DNS CNAME 同步脚本（多账户版 + 优选域名池轮询分配）
 *
 * 核心改进：同一服务的不同域名指向不同的优选域名，实现容灾分散。
 *   - 定义优选域名池（多个优选域名）
 *   - 将所有 FQDN 展平后按顺序轮流分配池中的优选域名
 *   - 同一服务的不同域名自然分配到不同优选域名
 *
 * Zone & Prefix 自动检测：
 *   自动扫描 workers/ 下所有 wrangler.toml，从 DOMAIN_CONFIG_JSON
 *   提取 zones + groups prefixes，无需手动维护两份配置。
 *   与 generate-routes.js 共用同一解析逻辑，增减前缀只需改 wrangler.toml。
 *
 * 同步策略（三路判断）：
 *   - 已存在 CNAME 且目标已是分配的优选域名 → 跳过
 *   - 已存在 CNAME 但目标不是分配的优选域名 → 删除旧记录，新建
 *   - 不存在 CNAME → 新建
 *
 * 支持多账户：每个 zone 配置可指定不同的 API Token（用于跨账户 DNS 操作）
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN  — 默认 Cloudflare API Token（需 Zone:DNS:Edit 权限）
 *   CLOUDFLARE_API_TOKEN_2 — 账户2的 API Token（可选）
 *   DRY_RUN（可选）       — 设为 1 则只预览不执行
 *
 * 用法：
 *   node scripts/sync-cname.js             # 执行同步
 *   DRY_RUN=1 node scripts/sync-cname.js   # 预览模式
 */

const CF_API = 'https://api.cloudflare.com/client/v4';
const fs = require('fs');
const https = require('https');
const path = require('path');

// ── Worker → 账户 Token 映射 ──────────────────────────────
// key = wrangler.toml 中的 name（即 Worker 名），value = 环境变量 Token key
const WORKER_TOKEN_KEYS = {
  'city-gate': 'default',
  'city-gate-2': 'account2',
};

// ── 优选域名池 ─────────────────────────────────────────
// 每个 zone 分配池中一个域名，zone 内所有子域名指向同一优选域名
// 注意：1034（Edge IP Restricted）按"受限 IP 空间 × 未授权 Host"触发，
//       无法用 IP 段猜测。validatePool 会用自家域名做真实请求验证，
//       响应含 "error code: 1034" 的域名自动跳过，只使用安全域名。
//
// 已移除（多解析器全 IP 检测确认混合池，部分 IP 触发 1034）：
//   - cf.cloudflare.182682.xyz  5/10 IP 触发 1034（162.159.9.193 等）
//   - 1.cf.3666888.xyz          2/5 IP 触发 1034（172.64.52.173、108.162.198.88）
// 混合池域名用户随机命中受限 IP 即 1034，即使"还有 N 个可用"也禁用。
//
// 补充来源：vps789.com/openApi/cfIpTop20（实时优选域名 Top20），
//   取其中通过全 IP 1034 检测的域名（2026-08-11 检测，测试 Host: sg.zzg.cc.cd）。
// 去重原则：**同二级域名（注册域）只保留一个**，多个子域名指向同一注册域
//   无容灾意义（挂都挂），反而稀释池子。validatePool 也会自动去重兜底。
const CNAME_POOL = [
  // ── 原池保留（历史实测干净）──
  'saas.sin.fan',
  'cf.090227.xyz',
  'cf.877774.xyz',
  'cf.yfjc.sbs',
  'cf-cname.xingpingcn.top',
  'zzg.cf.959923.xyz',
  'ips.993888.xyz',
  'bestcf.030101.xyz',
  'www.shopify.com',
  'icook.hk',
  // ── cfIpTop20 补充（2026-08-11 全 IP 检测通过，同二级域名去重）──
  //'g.lma.de5.net',
  //'cdn.2x.nz',
  //'blog.646474.xyz',
  //'yg8.ygkkk.dpdns.org',
  //'cdn.091224.xyz',
  //'b3.cfyx.20237737.xyz'
];

// ── 从 wrangler.toml 自动提取 Zone 配置 ──────────────────
// 与 generate-routes.js 共用同一解析逻辑，增减前缀只需改 wrangler.toml
const dns = require('dns');

/**
 * 解析 wrangler.toml 中的 DOMAIN_CONFIG_JSON
 */
function parseDomainConfig(tomlText) {
  const m = tomlText.match(/DOMAIN_CONFIG_JSON\s*=\s*"""([\s\S]*?)"""/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    console.error('  DOMAIN_CONFIG_JSON 解析失败:', e.message);
    return null;
  }
}

/**
 * 解析 wrangler.toml 中的 Worker name
 */
function parseWorkerName(tomlText) {
  const m = tomlText.match(/^name\s*=\s*"([^"]+)"/m);
  return m ? m[1] : null;
}

/**
 * 从 zones 元素提取 zone 名称
 * 兼容两种写法：字符串 "zzg.cc.cd" 或对象 { name, noPreferred }
 */
function zoneNameOf(zone) {
  return typeof zone === 'string' ? zone : (zone && typeof zone.name === 'string' ? zone.name : null);
}

/**
 * 判断 zone 是否标记为"不使用优选域名"
 * 标记方式：{ "name": "zzg.cc.cd", "noPreferred": true }
 * noPreferred zone 不分配优选域名池，子域名直接 CNAME 到各前缀对应源站
 */
function isNoPreferredZone(zone) {
  return typeof zone === 'object' && zone !== null && zone.noPreferred === true;
}

/**
 * 剥离协议前缀，得到裸域名（CNAME content 使用）
 * https://sg-f3b.pages.dev → sg-f3b.pages.dev
 */
function stripProtocol(url) {
  return String(url || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

/**
 * 从 DOMAIN_CONFIG_JSON 展开为 { zoneName, names, tokenKey, noPreferred?, origins? } 列表
 * @param {object} config - 解析后的 DOMAIN_CONFIG_JSON
 * @param {string} workerNameOrTokenKey - Worker 名称（如 "city-gate"）或直接传 tokenKey（如 "default"）
 *   传入 Worker 名时查 WORKER_TOKEN_KEYS 映射；传入的值不在映射表中时直接作为 tokenKey 使用
 */
function buildZoneMapFromConfig(config, workerNameOrTokenKey) {
  const tokenKey = WORKER_TOKEN_KEYS[workerNameOrTokenKey] || workerNameOrTokenKey || 'default';
  const zones = [];

  // zones + prefixes 格式
  if (config.zones && Array.isArray(config.groups)) {
    // 按前缀去重收集
    const prefixSet = new Set();
    // zone 级信息：noPreferred 标记 + 各前缀对应的源站 origin
    // （noPreferred zone 不分配优选域名，直接 CNAME 到源站，需要 prefix → origin 映射）
    const zoneInfo = new Map();

    for (const group of config.groups) {
      prefixSet.add(group.prefix);

      const groupZones = group.zones || config.zones;
      for (const zone of groupZones) {
        const zoneName = zoneNameOf(zone);
        if (!zoneName) continue;
        const noPreferred = isNoPreferredZone(zone);
        // zone 级 tokenKey 覆盖（可选，优先于 config 级 tokenKey）
        const zoneTokenKey = (typeof zone === 'object' && zone.tokenKey) || null;

        let info = zoneInfo.get(zoneName);
        if (!info) {
          info = { noPreferred: false, origins: {}, tokenKey: zoneTokenKey };
          zoneInfo.set(zoneName, info);
        }
        if (noPreferred) info.noPreferred = true;
        if (zoneTokenKey) info.tokenKey = zoneTokenKey;

        // noPreferred zone 需要记录每个前缀对应的源站（CNAME 直连目标）
        if (info.noPreferred && group.origin) {
          info.origins[group.prefix] = stripProtocol(group.origin);
        }
      }
    }

    const names = [...prefixSet];
    for (const [zoneName, info] of zoneInfo) {
      zones.push({
        zoneName,
        names,
        tokenKey: info.tokenKey || tokenKey,
        ...(info.noPreferred ? { noPreferred: true, origins: info.origins } : {}),
      });
    }
    return zones;
  }

  // 旧格式：域名组数组 → 从 domains 反推 zone + prefix
  if (Array.isArray(config)) {
    const zoneMap = {};
    for (const group of config) {
      for (const domain of group.domains || []) {
        const prefix = domain.split('.')[0];
        const zoneName = domain.split('.').slice(1).join('.');
        if (!zoneMap[zoneName]) zoneMap[zoneName] = { zoneName, names: new Set(), tokenKey };
        zoneMap[zoneName].names.add(prefix);
      }
    }
    return Object.values(zoneMap).map(z => ({ ...z, names: [...z.names] }));
  }

  return zones;
}

/**
 * 扫描所有 Worker 目录，自动生成 ZONE_MAP
 *
 * 支持环境变量覆盖：
 *   ZONE_CONFIG_JSON — 设置后直接解析为 Zone 配置，跳过 wrangler.toml 扫描
 *   格式与 wrangler.toml 中的 DOMAIN_CONFIG_JSON 完全一致（zones + groups），
 *   但支持额外的可选字段实现多账户/自定义 tokenKey：
 *
 *   方式1: 单账户（默认 tokenKey=default）
 *     { "zones": ["a.com"], "groups": [{ "prefix": "sg", "origin": "https://sg.pages.dev" }] }
 *
 *   方式2: 多账户（按 zone 指定 tokenKey）
 *     {
 *       "zones": [
 *         { "name": "a.com", "tokenKey": "default" },
 *         { "name": "b.com", "tokenKey": "account2" }
 *       ],
 *       "groups": [{ "prefix": "sg", "origin": "https://sg.pages.dev" }]
 *     }
 *
 *   方式3: 多账户（zones 数组，每个元素可指定 tokenKey）
 *     {
 *       "zones": [
 *         { "name": "a.com" },
 *         { "name": "b.com", "tokenKey": "account2" }
 *       ],
 *       "groups": [...]
 *     }
 *
 *   noPreferred zone 也通过环境变量支持：
 *     { "name": "c.com", "noPreferred": true }
 *
 *   也可传入数组（多 Worker 配置合并），每个元素含 zones + groups + tokenKey:
 *     [
 *       { "tokenKey": "default",  "zones": [...], "groups": [...] },
 *       { "tokenKey": "account2", "zones": [...], "groups": [...] }
 *     ]
 */
function autoDetectZoneMap() {
  // ── 环境变量覆盖 ──
  if (process.env.ZONE_CONFIG_JSON) {
    console.log('  [ZONE_CONFIG_JSON] 使用环境变量覆盖 Zone 配置');
    let configs;
    try {
      configs = JSON.parse(process.env.ZONE_CONFIG_JSON);
    } catch (e) {
      throw new Error(`ZONE_CONFIG_JSON 解析失败: ${e.message}`);
    }

    // 统一为数组处理
    const configList = Array.isArray(configs) ? configs : [configs];
    const allZones = [];

    for (const entry of configList) {
      // 数组元素可含 tokenKey 字段指定该组 Zone 的 tokenKey
      const tokenKey = entry.tokenKey || 'default';
      // 复用 buildZoneMapFromConfig，但传入自定义 tokenKey
      const zones = buildZoneMapFromConfig(entry, tokenKey);
      allZones.push(...zones);
      console.log(`  [env] (${tokenKey}): ${zones.length} zones, prefixes: ${zones.map(z => z.names.join(',')).join('; ') || '(无)'}`);
    }

    return allZones;
  }

  // ── 默认：扫描 wrangler.toml ──
  const workersDir = path.join(__dirname, '..', 'workers');
  const allZones = [];

  const dirs = fs.readdirSync(workersDir)
    .filter(name => fs.existsSync(path.join(workersDir, name, 'wrangler.toml')));

  for (const dir of dirs) {
    const tomlPath = path.join(workersDir, dir, 'wrangler.toml');
    const tomlText = fs.readFileSync(tomlPath, 'utf8');
    const config = parseDomainConfig(tomlText);
    if (!config) {
      console.log(`跳过 ${dir}: 无 DOMAIN_CONFIG_JSON`);
      continue;
    }
    const workerName = parseWorkerName(tomlText) || dir;
    const zones = buildZoneMapFromConfig(config, workerName);
    allZones.push(...zones);
    console.log(`  ${dir} (${workerName}): ${zones.length} zones, prefixes: ${zones.map(z => z.names.join(',')).join('; ') || '(无)'}`);
  }

  return allZones;
}

// ── Cloudflare 公共保留 IP（解析到这些 IP 必触发 1034，快速短路）──────────
// 1034 由 Edge IP Validation (EIV) 触发，保护"特定账户专用"的受限 IP 空间
// （BYOIP 前缀、专用/静态 IP、CF for SaaS 客户关联 IP 段）。
// 注意：**不能**用 IP 段（如 172.64.0.0/13）一刀切——实测同一段内
//       172.64.52.173 触发 1034、172.64.153.208 正常。
//       真正的判定靠真实请求验证（见 checkPoolDomain）。
// 以下仅作快速短路；resolveIps 只查 A 记录，故不含 IPv6 条目。
const CF_PUBLIC_RESERVED_IPS = [
  '1.1.1.1', '1.0.0.1',           // Cloudflare Public DNS（官方确认 1034）
  '198.51.100.1', '100::1',        // Cloudflare 官方推荐占位 IP
];

// ── 优选域名有效性检测 ─────────────────────────────────────
const POOL_CHECK_TIMEOUT = 3000;   // 单次请求超时（ms）
const POOL_RESOLVE_ROUNDS = 3;     // 每个域名 DNS 解析轮数（收集轮询 IP）
const POOL_IP_RETRIES = 2;         // 软错误（超时/连接失败）重试次数，消除抖动

/**
 * 快速短路：是否为已知 CF 公共保留 IP（1.1.1.1 等，官方确认必触发 1034）
 * 其余 IP 是否触发 1034 无法按 IP/段判断，交给真实请求验证 testIp1034
 */
function is1034Ip(ip) {
  return CF_PUBLIC_RESERVED_IPS.includes(ip);
}

/** Promise 包装 dns.resolve4，带超时 */
function dnsResolve4(domain, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DNS timeout')), timeout);
    dns.resolve4(domain, (err, addrs) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(addrs);
    });
  });
}

/**
 * 从指定 DNS 服务器解析 A 记录（独立 c-ares 解析器，Windows 亦可用）
 */
function dnsResolve4FromServer(domain, server, timeout) {
  return new Promise((resolve) => {
    const resolver = new dns.Resolver({ timeout, tries: 1 });
    try {
      resolver.setServers([server]);
    } catch (_) {
      return resolve([]);
    }
    resolver.resolve4(domain, (err, addrs) => {
      try { resolver.cancel(); } catch (_) { /* 忽略 */ }
      resolve(err ? [] : (addrs || []));
    });
  });
}

// 交叉收集用的公共 DNS 服务器（不同递归解析器会返回不同的轮询 IP）
// 以国内 DNS 为主，收集 Cloudflare CDN 节点 IP；海外 DNS 延迟高且可能被污染
const POOL_DNS_SERVERS = ['223.5.5.5', '114.114.114.114', '117.50.11.11', '8.8.8.8'];

/**
 * 解析域名并返回所有 A 记录 IP（多解析器 × 多轮收集去重）
 * 轮询域名在不同解析器/不同时刻会返回**不同**的 IP 子集：
 *   实测 1.cf.3666888.xyz 本机只看到 104.17.188.61，
 *   而 8.8.8.8 还返回 172.64.52.173、108.162.198.88（均触发 1034）。
 * 单个解析器收集必然漏检，必须跨解析器全量收集才能测全 1034 风险面。
 */
async function resolveIps(domain) {
  const ips = new Set();
  // ── 主路径：多个公共 DNS 服务器 × 多轮解析收集 ──
  const servers = POOL_DNS_SERVERS;
  for (const server of servers) {
    for (let round = 0; round < POOL_RESOLVE_ROUNDS; round++) {
      try {
        const addrs = await dnsResolve4FromServer(domain, server, POOL_CHECK_TIMEOUT);
        for (const a of addrs) ips.add(a);
      } catch (_) {
        // 该轮失败，继续下一轮
      }
    }
  }
  if (ips.size > 0) return [...ips];
  // ── 回退：Cloudflare DoH ──
  try {
    const dohUrl = `https://cloudflare-dns.com/dns-query?name=${domain}&type=A`;
    const dohRes = await fetch(dohUrl, {
      headers: { Accept: 'application/dns-json' },
      signal: AbortSignal.timeout(POOL_CHECK_TIMEOUT),
    });
    const dohJson = await dohRes.json();
    if (dohJson.Answer) {
      for (const a of dohJson.Answer) {
        if (a.type === 1 && a.data && /^\d+\.\d+\.\d+\.\d+$/.test(a.data)) {
          ips.add(a.data);
        }
      }
    }
  } catch (_) {
    // 忽略
  }
  return [...ips];
}

/**
 * 判断是否为 Cloudflare 挑战页（验证码/JS Challenge/WAF 拦截）
 * 挑战页特征：
 *   - HTTP 403（也有 503 用于 Under Attack 模式）
 *   - 响应体含 cf-browser-verify、challenge-platform、Just a moment、Checking if 等关键词
 *   - 用户访问时看到"请验证您是真人"或 Turnstile 验证码
 *   - 与 Worker 正常 403（城市限制拒绝）的区别：Worker 返回的是自定义响应，不含 CF 挑战页特征
 * 任一 IP 出现挑战页即禁用该优选域名，与 1034 同等处理：
 *   用户可能随机命中该 IP，遭遇验证码即服务不可用
 */
function isChallengePage(statusCode, body) {
  // 只在 403/503 范围内检测（挑战页的典型状态码）
  if (statusCode !== 403 && statusCode !== 503) return false;
  // Cloudflare 挑战页特征关键词（覆盖 JS Challenge / Managed Challenge / Under Attack / Turnstile）
  return /cf-browser-verify|challenge-platform|Just a moment|Checking if the site|Enable JavaScript|cf_chl_opt|Challenge running|Attention Required/i.test(body);
}

/**
 * 真实请求验证（单次）：用自家域名（testHost）做 Host + SNI 直连指定 IP
 * 响应含 "error code: 1034" → 该 IP 处于受限空间且 Host 未授权 → 不可用
 * 响应含 Cloudflare 挑战页（验证码） → 用户遭遇验证码 → 不可用
 * 其他任何 HTTP 响应（200/403/530 等）都说明网络通路正常 → 可用
 * 注意：testHost 必须是**真实存在 CNAME 记录**的自家子域名，
 *       不存在的子域名只会得到 1016（Origin DNS error），无法触发 1034 判定
 */
function testIp1034Once(ip, testHost) {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    let connectLatency = null;  // TLS 握手延迟（ms），供延迟采样复用
    let activeRes = null;        // 当前响应对象，finish 时销毁
    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (activeRes) { try { activeRes.destroy(); } catch (_) {} }
      req.destroy();
      resolve(r);
    };
    let body = '';
    let colo = null;

    // 从 cf-ray 响应头提取数据中心代码（格式: {hex}-{COLO}）
    function extractColo(res) {
      if (colo) return;
      const cfRay = res.headers['cf-ray'];
      if (cfRay) {
        const parts = String(cfRay).split('-');
        if (parts.length >= 2) colo = parts[parts.length - 1];
      }
    }

    const req = https.request({
      host: ip,
      servername: testHost,       // SNI
      headers: { Host: testHost },
      path: '/',
      method: 'GET',
      timeout: POOL_CHECK_TIMEOUT,
      rejectUnauthorized: false,  // 忽略证书不匹配（不影响可用性判定）
    }, (res) => {
      activeRes = res;
      extractColo(res);
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length >= 8192) {
          // 1034 错误页和挑战页远小于 8KB，到这里还没出现说明正常
          finish({ ok: true, reason: `HTTP ${res.statusCode}`, colo, connectLatency });
        } else if (/error code:\s*1034|error 1034/i.test(body)) {
          finish({ ok: false, reason: `HTTP ${res.statusCode} 1034`, colo, connectLatency });
        } else if (isChallengePage(res.statusCode, body)) {
          finish({ ok: false, reason: `HTTP ${res.statusCode} 挑战页（验证码）`, colo, connectLatency });
        }
      });
      res.on('end', () => {
        if (/error code:\s*1034|error 1034/i.test(body)) {
          finish({ ok: false, reason: `HTTP ${res.statusCode} 1034`, colo, connectLatency });
        } else if (isChallengePage(res.statusCode, body)) {
          finish({ ok: false, reason: `HTTP ${res.statusCode} 挑战页（验证码）`, colo, connectLatency });
        } else {
          finish({ ok: true, reason: `HTTP ${res.statusCode}`, colo, connectLatency });
        }
      });
    });

    // 记录 TLS 握手延迟，供调用方复用为第一次延迟采样
    req.on('socket', (socket) => {
      socket.on('secureConnect', () => {
        connectLatency = Date.now() - start;
      });
    });

    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, reason: '连接超时', colo: null, connectLatency: null });
    });
    req.on('error', (e) => {
      const msg = e.code || e.message || '';
      // 证书类错误说明 TLS 已通到 CF 边缘，CNAME 层面仍有效
      if (/CERT|TLS|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(String(msg))) {
        finish({ ok: true, reason: 'TLS 证书不匹配（网络已通）', colo, connectLatency });
      } else {
        finish({ ok: false, reason: `连接失败: ${String(msg).slice(0, 40)}`, colo: null, connectLatency: null });
      }
    });

    req.end();
  });
}

/**
 * 真实请求验证（带重试）：
 * - 成功（ok）→ 直接返回
 * - 1034/挑战页（硬判定，IP 受限或被 WAF 拦截是稳定特性）→ 直接接受，重试不会改变结果
 * - 软错误（超时/连接失败/ECONNRESET 等）→ 重试 POOL_IP_RETRIES 次
 *   实测部分 IP 偶发连接失败（如 2/3 能连上），多重试可避免误判
 */
async function testIp1034(ip, testHost) {
  let last;
  for (let attempt = 0; attempt < POOL_IP_RETRIES; attempt++) {
    last = await testIp1034Once(ip, testHost);
    if (last.ok) return last;                                  // 可用
    if (/1034/i.test(last.reason)) return last;                // 硬判定
    if (/挑战页|验证码/i.test(last.reason)) return last;       // 硬判定（WAF 拦截）
    // 软错误 → 继续重试
  }
  return last;
}

/**
 * 生成 1034 真实请求验证用的测试 Host
 * 取第一个 zone 的第一个前缀（如 sg.1189.dpdns.org）
 * 必须是自家真实 zone 且该 FQDN 会配置 CNAME，才能正确触发 EIV 判定；
 * 首次运行（记录尚未创建）可能显示 1016 而误判可用，第二次运行自动纠正
 */
function buildTestHost(zoneMap) {
  if (zoneMap.length === 0) return null;
  // 优先选使用优选域名的 zone（其 CNAME 指向池内域名，最贴近实际场景）；
  // noPreferred zone 直连源站，不作为 1034 测试 Host
  const first = zoneMap.find(z => !z.noPreferred) || zoneMap[0];
  const prefix = first.names[0] || 'www';
  return `${prefix}.${first.zoneName}`;
}

/**
 * 检测单个优选域名是否可用（严格模式）:
 * 1. DNS 解析（无 A 记录 → 不可用）
 * 2. 快速短路：解析到 CF 公共保留 IP（1.1.1.1 等）→ 必 1034，不可用
 * 3. 真实请求验证：对**收集到的全部 IP** 用自家域名做 Host 逐一访问
 *    判定规则：**任一 IP 触发 1034 或挑战页（验证码）即判不可用**——
 *    轮询域名每个 IP 都可能被用户命中，混合池（部分 IP 1034/挑战页）依然危险，
 *    绝不能因"还有 N 个可用"而分配出去。
 */
async function checkPoolDomain(domain, testHost) {
  const ips = await resolveIps(domain);

  if (ips.length === 0) {
    return { ok: false, reason: 'NXDOMAIN（域名无法解析）' };
  }

  // 快速短路：解析到已知保留 IP 必触发 1034
  const reservedIps = ips.filter(ip => is1034Ip(ip));
  if (reservedIps.length > 0) {
    return { ok: false, reason: `解析到 CF 保留 IP: ${reservedIps.join(', ')}（必 1034）` };
  }

  // 真实请求验证：对每个 IP 用自家域名做 Host 访问
  const checks = await Promise.all(ips.map(async (ip) => {
    const r = await testIp1034(ip, testHost);
    return { ip, ...r };
  }));
  const good = checks.filter(r => r.ok);
  const bad = checks.filter(r => !r.ok);

  if (bad.length === 0) {
    return { ok: true, reason: `IP 可用: ${ips.join(', ')}` };
  }
  if (good.length === 0) {
    const badIps = bad.map(r => `${r.ip}(${r.reason})`).join('; ');
    return { ok: false, reason: `全部 ${checks.length} 个 IP 不可用: ${badIps}` };
  }
  // 混合池：部分 IP 触发 1034/挑战页 → 用户可能随机命中受限 IP，视为不可用
  const badIps = bad.map(r => `${r.ip}(${r.reason})`).join('; ');
  return { ok: false, reason: `⚠ 混合池 ${bad.length}/${checks.length} IP 不可用（${badIps}），用户可能命中受限 IP/挑战页，禁用` };
}

/**
 * 提取注册域（二级域名）：取域名最后两段
 * 如 yg8.ygkkk.dpdns.org → ygkkk.dpdns.org；cf-cname.xingpingcn.top → xingpingcn.top
 */
function registrableDomain(domain) {
  const parts = domain.split('.');
  return parts.slice(-2).join('.');
}

/**
 * 并发检测优选域名池，返回安全域名列表和检测报告
 * 用自家域名做真实请求验证，有 1034 风险的域名自动跳过，只使用安全域名
 * 去重：同二级域名（注册域）只保留池中第一个，避免重复检测与无意义冗余
 */
async function validatePool(pool, testHost) {
  console.log('\n── 优选域名池有效性检测 ──');
  console.log(`  测试 Host: ${testHost}（真实请求验证 1034）\n`);

  // 按注册域去重：同二级域名的子域名视为同一个，只保留第一个
  const seen = new Set();
  const deduped = [];
  for (const d of pool) {
    const reg = registrableDomain(d);
    if (seen.has(reg)) {
      console.log(`  ↦ 跳过 ${d}（与 ${reg} 同二级域名，视为重复）`);
      continue;
    }
    seen.add(reg);
    deduped.push(d);
  }

  const results = await Promise.all(
    deduped.map(async (domain) => {
      const result = await checkPoolDomain(domain, testHost);
      const status = result.ok ? '✓' : '✗';
      const reason = result.reason || '';
      console.log(`  ${status}  ${domain.padEnd(32)} ${reason ? '— ' + reason : ''}`);
      return { domain, ...result };
    })
  );

  const valid = results.filter(r => r.ok).map(r => r.domain);
  const invalid = results.filter(r => !r.ok);

  if (invalid.length > 0) {
    console.log(`\n  ⚠  ${invalid.length} 个域名有 1034/挑战页风险，已跳过:`);
    for (const r of invalid) {
      console.log(`     - ${r.domain}: ${r.reason}`);
    }
  }
  console.log(`  池大小: ${pool.length}（去重后 ${deduped.length}），安全可用: ${valid.length}`);

  return { valid, invalid };
}

// ── 池自动补充（vps789.com cfIpTop20） ────────────────────
// 用途：GitHub Actions 定时同步时，若池内有效域名不足（部分域名 1034 被跳过、
//       新增 zone 等场景），自动从 vps789 实时优选 Top20 拉取候选并检测补充，
//       保证同步永远有足量安全域名可用，无需手动维护池。
const POOL_API = 'https://vps789.com/openApi/cfIpTop20';
const POOL_MIN_VALID = 8;   // 有效域名低于此数量时触发补充（当前 6 zone，留余量）

/**
 * 拉取 vps789 实时优选域名 Top20
 * 返回域名数组（失败时返回空数组，不抛异常）
 */
async function fetchCfIpTop20() {
  try {
    const res = await fetch(POOL_API, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json();
    const list = (json?.data?.good || []).map(g => g.ip).filter(d => typeof d === 'string' && d.includes('.'));
    return [...new Set(list)];
  } catch (e) {
    console.error(`  ✗ 拉取 cfIpTop20 失败: ${e.message}`);
    return [];
  }
}

/**
 * 池自动补充：当有效域名不足时，从 cfIpTop20 拉取候选检测补充
 * 规则：
 *   - 候选与池内有效域名同二级域名 → 跳过（防伪容灾）
 *   - 候选之间同二级域名 → 只取第一个
 *   - 逐个用真实请求检测 1034，通过才入池
 * 补充不足或拉取失败时静默返回原池（不阻塞同步）
 */
async function autoRefillPool(validPool, testHost, zoneCount) {
  const need = Math.max(POOL_MIN_VALID, zoneCount + 1);
  if (validPool.length >= need) return validPool;

  console.log(`\n── 池自动补充（有效 ${validPool.length}/${need}，从 cfIpTop20 拉取候选）──`);
  const candidates = await fetchCfIpTop20();
  if (candidates.length === 0) {
    console.log('  候选拉取失败/为空，跳过补充（使用现有池继续）');
    return validPool;
  }
  console.log(`  候选 ${candidates.length} 个: ${candidates.join(', ')}`);

  const usedRegs = new Set(validPool.map(d => registrableDomain(d)));
  let added = 0;

  for (const domain of candidates) {
    if (validPool.length >= need) break;
    const reg = registrableDomain(domain);
    if (usedRegs.has(reg)) continue;

    const result = await checkPoolDomain(domain, testHost);
    if (result.ok) {
      // 只有检测通过才占用注册域名额（失败的候选不占位，
      // 否则 auto.dolby.dpdns.org 失败会把 yg8.ygkkk.dpdns.org 等优质候选挤掉）
      usedRegs.add(reg);
      validPool.push(domain);
      added++;
      console.log(`  ✓ 补充 ${domain.padEnd(30)} ${result.reason.slice(0, 60)}`);
    } else {
      console.log(`  ✗ 候选 ${domain.padEnd(30)} 未通过: ${result.reason.slice(0, 70)}`);
    }
  }

  console.log(`  补充完成: +${added}，有效池 ${validPool.length}`);
  return validPool;
}

// ── 分配计划生成 ─────────────────────────────────────────
// 每个 zone 从池中轮询分配一个优选域名，zone 内所有子域名指向同一目标
// 不同 zone 会分散到不同优选域名，实现容灾
async function buildAssignmentPlan() {
  // 第0步：自动从 wrangler.toml 提取 Zone 配置
  console.log('\n── 自动检测 Zone 配置 ──');
  const ZONE_MAP = autoDetectZoneMap();
  if (ZONE_MAP.length === 0) {
    throw new Error('未检测到任何 Zone 配置，请检查 workers/ 下的 wrangler.toml');
  }
  console.log(`  共 ${ZONE_MAP.length} 个 Zone 需同步\n`);

  // 第1步：检测优选域名池有效性（真实请求验证 1034，自动跳过风险域名）
  const testHost = buildTestHost(ZONE_MAP);
  const { valid: validPool } = await validatePool(CNAME_POOL, testHost);

  if (validPool.length === 0) {
    throw new Error('所有优选域名均无效，无法继续同步！');
  }

  // 第1.5步：池自动补充（有效域名不足时从 cfIpTop20 拉取候选检测补充）
  // GitHub Actions 定时运行时，若池内域名因 1034 被大量跳过或 zone 增多导致不足，
  // 自动拉取实时优选 Top20 检测后补足，保证每个 zone 都有独立优选域名。
  // noPreferred（不使用优选域名）的 zone 不占用池，直连源站
  const poolZones = ZONE_MAP.filter(z => !z.noPreferred);
  const finalPool = await autoRefillPool(validPool, testHost, poolZones.length);

  // 第2步：每个 zone 分配一个优选域名，zone 内所有子域名指向同一目标
  // noPreferred zone 跳过优选域名池，各前缀直接 CNAME 到对应源站 origin
  const assignments = [];
  let poolIdx = 0;
  for (const zone of ZONE_MAP) {
    if (zone.noPreferred) {
      for (const name of zone.names) {
        const origin = (zone.origins && zone.origins[name]) || null;
        if (!origin) {
          console.log(`  ⚠ ${name}.${zone.zoneName} 无对应源站 origin，跳过（请检查 DOMAIN_CONFIG_JSON）`);
          continue;
        }
        assignments.push({
          fqdn: `${name}.${zone.zoneName}`,
          zoneName: zone.zoneName,
          name,
          tokenKey: zone.tokenKey,
          target: origin,
          direct: true, // 直连源站，非优选域名
        });
      }
      continue;
    }

    const target = finalPool[poolIdx % finalPool.length];
    const poolIndex = poolIdx % validPool.length;
    poolIdx++;
    for (const name of zone.names) {
      assignments.push({
        fqdn: `${name}.${zone.zoneName}`,
        zoneName: zone.zoneName,
        name,
        tokenKey: zone.tokenKey,
        target,
        poolIndex,
      });
    }
  }

  return assignments;
}

// ── 工具函数 ──────────────────────────────────────────

function getToken(tokenKey) {
  // 支持 'default' 和 'account2' 等自定义 key
  const TOKEN_MAP = {
    default: process.env.CLOUDFLARE_API_TOKEN,
    account2: process.env.CLOUDFLARE_API_TOKEN_2,
  };
  const token = TOKEN_MAP[tokenKey || 'default'];
  if (!token) throw new Error(`API Token 未设置 (key: ${tokenKey || 'default'})`);
  return token;
}

async function cfFetch(path, options = {}) {
  const tokenKey = options.tokenKey || 'default';
  const token = getToken(tokenKey);
  if (!token) throw new Error(`API Token 未设置 (key: ${tokenKey})`);

  const { tokenKey: _, ...fetchOptions } = options;
  const res = await fetch(`${CF_API}${path}`, {
    ...fetchOptions,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...fetchOptions.headers,
    },
  });

  const json = await res.json();
  if (!json.success) {
    const err = json.errors?.map(e => e.message).join('; ') || '未知错误';
    throw new Error(`Cloudflare API 错误: ${err}`);
  }
  return json;
}

async function getZoneId(zoneName, tokenKey) {
  const json = await cfFetch(`/zones?name=${zoneName}`, { tokenKey });
  if (!json.result?.length) {
    throw new Error(`Zone "${zoneName}" 未找到，请检查 zone 名称和 API Token 权限`);
  }
  return json.result[0].id;
}

async function getDnsRecords(zoneId, recordName, tokenKey) {
  const json = await cfFetch(`/zones/${zoneId}/dns_records?name=${recordName}`, { tokenKey });
  return json.result || [];
}

async function deleteDnsRecord(zoneId, recordId, tokenKey) {
  await cfFetch(`/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE', tokenKey });
}

async function createCnameRecord(zoneId, name, target, tokenKey, proxied = false) {
  const body = { type: 'CNAME', name, content: target, proxied, ttl: 1 };
  await cfFetch(`/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify(body),
    tokenKey,
  });
}

// ── 打印分配计划 ─────────────────────────────────────────

function printAssignmentPlan(assignments) {
  console.log('\n┌──────────────────────────────────────────────────────────────┐');
  console.log('│  CNAME 分配计划（轮询分配）                                    │');
  console.log('├──────────────────────────────────────────────────────────────┤');
  console.log('│  FQDN                              →  目标                  │');
  console.log('├──────────────────────────────────────────────────────────────┤');
  for (const a of assignments) {
    const kind = a.direct ? '源站' : '优选';
    console.log(`│  ${a.fqdn.padEnd(34)} →  [${kind}] ${a.target.padEnd(20)} │`);
  }
  console.log('└──────────────────────────────────────────────────────────────┘');

  // 按目标分组统计（优选域名 / 源站直连分开）
  const byTarget = {};
  for (const a of assignments) {
    byTarget[a.target] = (byTarget[a.target] || 0) + 1;
  }
  console.log('\n  目标分配统计:');
  for (const [target, count] of Object.entries(byTarget).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${target.padEnd(30)} × ${count}`);
  }
}

// ── 主逻辑 ──────────────────────────────────────────

async function processAssignment(assignments) {
  const dryRun = process.env.DRY_RUN === '1';

  // 按 zone 分组处理
  const zoneGroups = {};
  for (const a of assignments) {
    if (!zoneGroups[a.zoneName]) {
      zoneGroups[a.zoneName] = { tokenKey: a.tokenKey, items: [] };
    }
    zoneGroups[a.zoneName].items.push(a);
  }

  let totalStats = { errors: 0, created: 0, deleted: 0, skipped: 0 };

  for (const [zoneName, group] of Object.entries(zoneGroups)) {
    const tokenKey = group.tokenKey;
    console.log(`\n━━━ Zone: ${zoneName}${tokenKey ? ` (账户: ${tokenKey})` : ''} ━━━`);

    let zoneId;
    try {
      zoneId = await getZoneId(zoneName, tokenKey);
    } catch (e) {
      console.error(`  ✗ 获取 Zone ID 失败: ${e.message}`);
      totalStats.errors += group.items.length;
      continue;
    }

    for (const a of group.items) {
      const { fqdn, target } = a;
      console.log(`\n  ▸ ${fqdn} → ${target}`);

      try {
        const records = await getDnsRecords(zoneId, fqdn, tokenKey);
        const cnameRecords = records.filter(r => r.type === 'CNAME');

        if (cnameRecords.length === 0) {
          console.log(`    无 CNAME 记录 → 创建 CNAME → ${target}`);
          if (!dryRun) {
            await createCnameRecord(zoneId, fqdn, target, tokenKey);
          }
          totalStats.created++;
        } else {
          const matchTarget = cnameRecords.filter(r => r.content === target);
          const mismatchTarget = cnameRecords.filter(r => r.content !== target);

          if (matchTarget.length > 0 && mismatchTarget.length === 0) {
            console.log(`    CNAME 已指向 ${target} → 跳过`);
            totalStats.skipped++;
          } else {
            for (const rec of mismatchTarget) {
              console.log(`    删除旧 CNAME → ${rec.content} (id: ${rec.id})`);
              if (!dryRun) {
                await deleteDnsRecord(zoneId, rec.id, tokenKey);
              }
              totalStats.deleted++;
            }

            if (matchTarget.length === 0) {
              console.log(`    创建 CNAME → ${target}`);
              if (!dryRun) {
                await createCnameRecord(zoneId, fqdn, target, tokenKey);
              }
              totalStats.created++;
            } else {
              console.log(`    CNAME 已指向 ${target} → 跳过`);
              totalStats.skipped++;
            }
          }
        }
      } catch (e) {
        console.error(`    ✗ 处理失败: ${e.message}`);
        totalStats.errors++;
      }
    }
  }

  return totalStats;
}

async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  Cloudflare DNS CNAME 同步脚本（优选域名池版）    ║');
  console.log('╚════════════════════════════════════════════════╝');

  if (process.env.DRY_RUN === '1') {
    console.log('\n⚠  DRY_RUN 模式 — 仅预览，不执行任何修改\n');
  }

  // 生成并展示分配计划
  const assignments = await buildAssignmentPlan();
  printAssignmentPlan(assignments);

  // 执行同步
  const totalStats = await processAssignment(assignments);

  console.log('\n━━━ 汇总 ━━━');
  console.log(`  创建: ${totalStats.created}  删除: ${totalStats.deleted}  跳过: ${totalStats.skipped}  错误: ${totalStats.errors}`);

  if (totalStats.errors > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

// ── Cloudflare CIDR IP 扫描 ──────────────────────────

/**
 * Cloudflare 官方 IPv4 段（硬编码兜底）
 * 来源: https://www.cloudflare.com/ips-v4
 * 当自动拉取失败时使用此列表
 */
const CF_IPV4_FALLBACK = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
];

/**
 * 从 Cloudflare 官方 API 拉取 IPv4 段
 * 失败时回退到硬编码列表
 */
async function fetchCfIpv4Ranges() {
  try {
    const resp = await fetch('https://www.cloudflare.com/ips-v4', {
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    const ranges = text.trim().split('\n').map(s => s.trim()).filter(Boolean);
    if (ranges.length === 0) throw new Error('空列表');
    console.log(`    CF 官方 IPv4 段: ${ranges.length} 个（在线获取）`);
    return ranges;
  } catch (e) {
    console.log(`    CF 官方 IPv4 段拉取失败 (${e.message})，使用硬编码兜底 (${CF_IPV4_FALLBACK.length} 个)`);
    return CF_IPV4_FALLBACK;
  }
}

/**
 * 将 CIDR 转换为整数范围
 * 返回 { start, end }（无符号 32 位整数）
 */
function cidrToRange(cidr) {
  const [ipStr, prefixLenStr] = cidr.split('/');
  const prefixLen = parseInt(prefixLenStr, 10);
  const parts = ipStr.split('.').map(p => parseInt(p, 10));
  const ipInt = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
  // 确保无符号
  const ipUInt = ipInt >>> 0;
  const hostBits = 32 - prefixLen;
  const mask = hostBits === 32 ? 0 : (0xFFFFFFFF << hostBits) >>> 0;
  const start = (ipUInt & mask) >>> 0;
  const end = (start | ((~mask) >>> 0)) >>> 0;
  return { start, end, prefixLen };
}

/**
 * 将无符号 32 位整数转为 IP 字符串
 */
function intToIp(int) {
  return [
    (int >>> 24) & 0xFF,
    (int >>> 16) & 0xFF,
    (int >>> 8) & 0xFF,
    int & 0xFF,
  ].join('.');
}

/**
 * 从 CIDR 网段中随机采样 IP
 * 策略（参考 CFnat）：
 *   - 按 /24 分段，每个 /24 段内随机取 1 个 IP
 *   - /24 及更小网段直接取 1 个
 *   - 大网段（如 /13）会产生大量采样，需配合 samplesPerSubnet 限制
 *
 * 参数：
 *   cidr       — CIDR 字符串，如 "104.16.0.0/13"
 *   maxSamples — 该 CIDR 最多采样多少个 IP（默认 100）
 * 返回 IP 字符串数组
 */
function sampleIpsFromCidr(cidr, maxSamples = 100) {
  const { start, end, prefixLen } = cidrToRange(cidr);
  const rangeSize = (end - start + 1) >>> 0;

  if (rangeSize === 1) return [intToIp(start)];

  // 计算采样步长：均匀分布
  const actualSamples = Math.min(maxSamples, rangeSize);
  const step = Math.max(1, Math.floor(rangeSize / actualSamples));
  const result = [];

  for (let i = 0; i < actualSamples; i++) {
    // 在每个步长区间内随机取一个 IP
    const segStart = (start + i * step) >>> 0;
    const segEnd = Math.min((segStart + step - 1) >>> 0, end);
    const randomOffset = segEnd === segStart ? 0 : Math.floor(Math.random() * (segEnd - segStart + 1));
    result.push(intToIp((segStart + randomOffset) >>> 0));
  }

  return result;
}

/**
 * 从 CIDR 列表批量采样 IP
 * 返回去重后的 IP 数组
 */
function sampleIpsFromCidrList(cidrList, maxPerCidr = 100) {
  const ips = new Set();
  for (const cidr of cidrList) {
    const sampled = sampleIpsFromCidr(cidr, maxPerCidr);
    for (const ip of sampled) {
      ips.add(ip);
    }
  }
  return [...ips];
}

/**
 * 解析自定义 IP 来源字符串
 * 支持格式：
 *   - CIDR:  104.16.0.0/13,172.64.0.0/13
 *   - 单 IP: 1.2.3.4,5.6.7.8
 *   - 域名:  example.com,cdn.example.com（会做 DNS 解析）
 *   - 混合:  104.16.0.0/13,1.2.3.4,example.com
 */
function parseCustomIpSource(sourceStr) {
  const items = sourceStr.split(',').map(s => s.trim()).filter(Boolean);
  const cidrs = [];
  const singleIps = [];
  const domains = [];

  for (const item of items) {
    if (item.includes('/')) {
      cidrs.push(item);
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(item)) {
      singleIps.push(item);
    } else {
      domains.push(item);
    }
  }

  return { cidrs, singleIps, domains };
}

// ── 导出（供其他脚本复用，如 setup-saas.js、check-dns.js） ──
module.exports = {
  autoDetectZoneMap,
  buildZoneMapFromConfig,
  parseDomainConfig,
  parseWorkerName,
  stripProtocol,
  zoneNameOf,
  isNoPreferredZone,
  WORKER_TOKEN_KEYS,
  resolveIps,
  is1034Ip,
  isChallengePage,
  testIp1034,
  testIp1034Once,
  checkPoolDomain,
  validatePool,
  registrableDomain,
  fetchCfTop20: fetchCfIpTop20,
  autoRefillPool,
  buildTestHost,
  buildAssignmentPlan,
  getZoneId,
  getDnsRecords,
  deleteDnsRecord,
  createCnameRecord,
  getToken,
  cfFetch,
  CNAME_POOL,
  CF_IPV4_FALLBACK,
  fetchCfIpv4Ranges,
  cidrToRange,
  intToIp,
  sampleIpsFromCidr,
  sampleIpsFromCidrList,
  parseCustomIpSource,
};
