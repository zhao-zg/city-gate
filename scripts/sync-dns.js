#!/usr/bin/env node
/**
 * Cloudflare DNS 同步 + 检验 + 测速脚本
 *
 * 当前架构：
 *   {prefix}.{zone} → A 记录 → 优选 IP（CF Anycast IP，proxied=false）
 *   noPreferred zone: CNAME → 源站
 *   Worker Route 匹配域名 → 透明转发到 *.pages.dev
 *
 * 三大功能：
 *   1. 同步 DNS — 从优选域名池解析 IP，验证 1034 + 挑战页，按 IP_DEDUP_PREFIX 去重，
 *                 延迟排序，分配 A 记录，写入 Cloudflare DNS
 *   2. 检验 DNS — 对各 FQDN 做 HTTPS 连通性检测（1014/522/挑战页识别）
 *   3. 测速     — 对每个 zone 的 A 记录 IP 做下载测速（CF 官方 __down 端点），
 *                 最低 500 KB/s 达标即停，不达标自动替换下一个候选 IP
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN   — 默认 CF API Token
 *   CLOUDFLARE_API_TOKEN_2 — 账户2 Token（可选）
 *   DRY_RUN（可选）        — 设为 1 则只预览不执行修改
 *   IP_PER_ZONE（可选）    — 每 zone 分配几个 IP（默认 2）
 *   IP_DEDUP_PREFIX（可选）— IP 去重前缀长度（默认 32 = 仅去重完全相同的 IP）
 *   MIN_SPEED_KBPS（可选） — 最低速度 KB/s（默认 500）
 *   SPEED_TEST_SEC（可选） — 测速时长秒数（默认 2）
 *   MAX_LATENCY_MS（可选） — 延迟上限 ms，超过不测速（默认 300，0=不限制）
 *   SPEED_TEST_MODE（可选）— fast=达标即停 / best=全部测完选最优（默认 fast）
 *   MAX_SPEED_TEST_COUNT（可选）— best 模式下最大测速 IP 数（默认 20）
 *   SPEED_TEST_HOST（可选）  — 测速域名（默认自动检测，需为 Worker 路由域名）
 *   COLO_FILTER（可选）    — 数据中心过滤，逗号分隔（如 HKG,LAX），留空=不过滤
 *   LATENCY_SAMPLES（可选）— 延迟采样次数（默认 10，1=单次不取平均）
 *   MAX_PACKET_LOSS_RATE（可选）— 丢包率上限，超过则过滤（默认 0.1 = 10%）
 *   IP_SOURCE（可选）     — IP 来源：domain=域名解析(默认) / cidr=CF CIDR扫描 / both=两者合并 / isp=仅三网API / 自定义(CIDR,IP,域名混合)
 *   CIDR_SAMPLES（可选）  — 每个 CIDR 最多采样 IP 数（默认 100）
 *   TOKEN_KEY（可选）      — 只处理指定 tokenKey 的 zone
 *   ISP_IP_SOURCE（可选） — 三网优选 IP 源域名（默认 cf.090227.xyz，华为云分线路用）
 *   ISP_IP_PER_LINE（可选）— 每条线路取几个 IP（默认 2，华为云分线路 A 记录数）
 *   ISP_IP_POOL_COUNT（可选）— 三网优选 IP 注入测速候选池的数量（每运营商，默认 0=不注入）
 *
 * 用法：
 *   node scripts/sync-dns.js             # 执行同步+检验+测速
 *   DRY_RUN=1 node scripts/sync-dns.js   # 预览模式
 */

const https = require('https');
const http = require('http');
const net = require('net');
const sc = require('./sync-cname');
const { fetchIspIps, fetchIspIpsByDns, HW_LINES } = require('./fetch-isp-ips');

// ── 短命请求用 Agent：关闭 keep-alive，用完立即释放 TCP 连接 ──
// 避免 cron 空闲期间 conntrack/fd 被大量 keep-alive socket 占用
const _noKeepAliveAgent = new https.Agent({ keepAlive: false });

// ── 配置 ─────────────────────────────────────────────
const IP_PER_ZONE = parseInt(process.env.IP_PER_ZONE || '2', 10);
const IP_DEDUP_PREFIX = parseInt(process.env.IP_DEDUP_PREFIX || '32', 10);
const MIN_SPEED_KBPS = parseInt(process.env.MIN_SPEED_KBPS || '500', 10);
const SPEED_TEST_SEC = parseInt(process.env.SPEED_TEST_SEC || '2', 10);
// 延迟上限（ms），超过的 IP 不参与测速（0 = 不限制）
const MAX_LATENCY_MS = parseInt(process.env.MAX_LATENCY_MS || '300', 10);
// 测速模式：fast = 达标即停 / best = 全部测完选最优 / off = 跳过测速
const SPEED_TEST_MODE = process.env.SPEED_TEST_MODE || 'fast';
// best 模式下最大测速 IP 数（避免串行测速耗时过长）
const MAX_SPEED_TEST_COUNT = parseInt(process.env.MAX_SPEED_TEST_COUNT || '20', 10);
// 测速域名（需为已部署 Worker 的域名，默认自动检测）
const SPEED_TEST_HOST = process.env.SPEED_TEST_HOST || '';
// 数据中心过滤（逗号分隔，如 HKG,LAX），留空=不过滤
const COLO_FILTER = process.env.COLO_FILTER
  ? process.env.COLO_FILTER.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  : [];
// 延迟采样次数（默认 10，1=单次不取平均）
const LATENCY_SAMPLES = Math.min(Math.max(parseInt(process.env.LATENCY_SAMPLES || '10', 10), 1), 20);
// 丢包率上限，超过则过滤（默认 0.1 = 10%）
const MAX_PACKET_LOSS_RATE = parseFloat(process.env.MAX_PACKET_LOSS_RATE || '0.1');
// IP 来源模式：domain / cidr / both / isp(仅三网API) / 自定义字符串
const IP_SOURCE = process.env.IP_SOURCE || 'domain';
// 每个 CIDR 最多采样 IP 数
const CIDR_SAMPLES = parseInt(process.env.CIDR_SAMPLES || '100', 10);
// cfIpTop20 补充开关（默认关闭，设为 1 开启）
const ENABLE_CF_TOP20 = process.env.ENABLE_CF_TOP20 === '1';
// 三网优选 IP 注入测速候选池的数量（每运营商），0=不注入
// 与 ISP_IP_PER_LINE（华为云分线路记录数）独立，这里用于扩大测速候选面
const ISP_IP_POOL_COUNT = parseInt(process.env.ISP_IP_POOL_COUNT || '0', 10);
// 每条线路取几个 IP（华为云分线路 A 记录数，与 fetch-isp-ips.js 的 ISP_IP_PER_LINE 一致）
const ISP_IP_PER_LINE = parseInt(process.env.ISP_IP_PER_LINE || '2', 10);

// ── IP 质量检测 ──────────────────────────────────────

/**
 * 测量 TCP 握手延迟（ms）
 * 默认测 443 端口（与测速端口一致），确保延迟达标的 IP 也能正常测速
 * 返回 null 表示连接失败
 */
function measureLatency(ip, port = 443) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(3000);

    socket.on('connect', () => {
      const latency = Date.now() - start;
      socket.destroy();
      resolve(latency);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(null);
    });

    socket.on('error', () => {
      socket.destroy();
      resolve(null);
    });

    socket.connect(port, ip);
  });
}

/**
 * 多次采样测量延迟，取平均值
 * 参数 firstLatency：若传入非 null，作为第一次采样结果（复用 1034 检测的 TLS 握手延迟，省一次 TCP 连接）
 * 返回 { avgLatency, samples, successCount, totalCount }
 *   avgLatency  — 平均延迟（ms），null 表示全部失败
 *   samples    — 各次结果数组（null = 失败，数字 = 延迟ms）
 *   successCount — 成功次数
 *   totalCount   — 总采样次数
 */
async function measureLatencyMulti(ip, samples, port = 443, firstLatency = null) {
  const results = [];
  // 复用 1034 检测时的 TLS 握手延迟作为第一次采样
  if (firstLatency !== null && samples > 0) {
    results.push(firstLatency);
  }
  const remaining = samples - results.length;
  for (let i = 0; i < remaining; i++) {
    const latency = await measureLatency(ip, port);
    results.push(latency);
  }
  const successCount = results.filter(r => r !== null).length;
  const avgLatency = successCount > 0
    ? Math.round(results.reduce((sum, r) => sum + (r || 0), 0) / successCount)
    : null;
  return { avgLatency, samples: results, successCount, totalCount: samples };
}

/**
 * 提取 IP 的 /N 前缀（用于去重）
 * 如 172.64.152.241 + /24 → "172.64.152"
 */
function ipPrefix(ip, prefixLen) {
  const parts = ip.split('.');
  if (parts.length !== 4) return ip;
  const prefixParts = Math.floor(prefixLen / 8);
  return parts.slice(0, prefixParts).join('.');
}

/**
 * 同前缀去重（prefixLen=0 时不去重，直接按延迟排序）
 */
function dedupIps(ipLatencyList, prefixLen = IP_DEDUP_PREFIX) {
  if (prefixLen === 0) {
    return [...ipLatencyList].sort((a, b) => a.latency - b.latency);
  }
  const byPrefix = new Map();

  for (const item of ipLatencyList) {
    const { ip, latency } = item;
    // /32 时直接用完整 IP 做 key，跳过 ipPrefix 调用
    const prefix = prefixLen === 32 ? ip : ipPrefix(ip, prefixLen);
    const existing = byPrefix.get(prefix);

    if (!existing || latency < existing.latency) {
      byPrefix.set(prefix, item);
    }
  }

  return [...byPrefix.values()].sort((a, b) => a.latency - b.latency);
}

// ── 下载测速 ─────────────────────────────────────────

/**
 * 对指定 IP 做下载速度测试
 *
 * 使用自有 Worker 的 /__down 路由代理 speed.cloudflare.com 测速端点。
 * 通过 IP 直连 + Host 指定测速域名（已部署 Worker），HTTPS 443 端口访问。
 * Worker 内部 fetch 到 speed.cloudflare.com 不经过 WAF，443 可正常使用。
 *
 * 策略：
 *   - 使用 HTTPS 443 端口（通过 Worker 代理，不经过 CF WAF 拦截）
 *   - 单连接下载，每次请求 10MB，下载完结束
 *   - 连接超时 3s：TCP/TLS 握手未完成立即终止，不等满硬超时
 *   - keep-alive 复用 TCP 连接，避免反复握手开销
 *
 * 返回 { speed_kbps, downloaded, duration_ms } 或 null（失败）
 */
function testDownloadSpeed(ip, testSec, speedHost) {
  // 每次请求下载 10MB 随机数据
  const CHUNK_BYTES = 10 * 1024 * 1024;
  // 测速端口（443 = HTTPS，通过 Worker 代理不经过 WAF）
  const SPEED_PORT = 443;
  // 连接超时：TCP 连接 + TLS 握手超过 3s 未完成则立即终止
  const CONNECT_TIMEOUT_MS = 3000;

  return new Promise((resolve) => {
    let downloadStart = null;           // 收到响应头时记录，速度只算下载时段
    const timeoutMs = (testSec + 3) * 1000; // 硬超时 = 连接超时(3s) + 测速时长，纯保底
    const speedLimitMs = testSec * 1000;   // 测速时长到了就停，不等下完 10MB
    let settled = false;
    let totalDownloaded = 0;
    let speedTimer = null;
    const pendingTimers = new Set();

    // keep-alive agent 复用 TCP 连接
    const agent = new https.Agent({
      keepAlive: true,
      rejectUnauthorized: false,
    });

    const cleanup = () => {
      for (const t of pendingTimers) clearTimeout(t);
      pendingTimers.clear();
      agent.destroy();
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const elapsedSec = downloadStart
        ? Math.max((Date.now() - downloadStart) / 1000, 0.001)
        : 0.001;
      const speed_kbps = Math.round((totalDownloaded / 1024) / elapsedSec);
      resolve({ speed_kbps, downloaded: totalDownloaded, duration_ms: downloadStart ? Date.now() - downloadStart : 0 });
    };

    // 硬超时保底
    const hardTimer = setTimeout(finish, timeoutMs);
    pendingTimers.add(hardTimer);

    const req = https.request({
      host: ip,
      port: SPEED_PORT,
      headers: { Host: speedHost },
      path: `/__down?bytes=${CHUNK_BYTES}`,
      method: 'GET',
      timeout: timeoutMs,
      agent,
      rejectUnauthorized: false,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        finish();
        return;
      }
      // 从收到响应头开始计时，速度只算纯下载时段
      downloadStart = Date.now();
      speedTimer = setTimeout(finish, speedLimitMs);
      pendingTimers.add(speedTimer);
      res.on('data', (chunk) => {
        if (!settled) totalDownloaded += chunk.length;
      });
      res.on('end', () => { if (!settled) finish(); });
      res.on('error', () => { if (!settled) finish(); });
    });

    // 连接超时：TCP 连接或 TLS 握手超过 3s 未完成则立即终止
    // 避免 IP 不可达或证书缺失时等满整个硬超时（可能 10s+）
    req.on('socket', (socket) => {
      const connectTimer = setTimeout(() => {
        if (!settled) req.destroy(); // 触发 error → finish
      }, CONNECT_TIMEOUT_MS);
      pendingTimers.add(connectTimer);

      // TLS 握手成功，清除连接超时
      socket.on('secureConnect', () => {
        clearTimeout(connectTimer);
        pendingTimers.delete(connectTimer);
      });
    });

    req.on('timeout', () => { req.destroy(); });
    req.on('error', () => { if (!settled) finish(); });
    req.end();
  });
}

// ── SSL 证书保底 ─────────────────────────────────────

/**
 * 检测 FQDN 是否有有效的 SSL 证书
 * 通过 TLS 握手验证：能完成握手 → 有证书，RST/无证书 → 缺证书
 */
function checkSslCert(fqdn) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: fqdn,
      path: '/',
      method: 'HEAD',
      timeout: 5000,
      rejectUnauthorized: false,
      agent: _noKeepAliveAgent,
    }, () => {
      resolve(true); // 握手成功 = 有证书
    });
    req.on('error', () => { resolve(false); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// 保底记录名（下划线开头，不会被业务流量命中）
const SSL_KEEPALIVE_NAME = '_ssl';

/**
 * 为每个 Zone 确保 _ssl.{zone} A 记录（proxied=true）存在，
 * 使 CF 持续签发和续签 Universal SSL 通配符证书。
 *
 * 原理：proxied=false 的 A 记录不会触发 CF 签发 SSL 证书，
 * Zone 内至少需要一条 proxied=true 记录才能维持证书。
 * _ssl.{zone} 指向 192.0.2.1（文档保留 IP，CF 允许 proxied 记录指向它），
 * proxied=true 且不占业务流量。
 *
 * 注意：仅适用于 DNS 托管在 Cloudflare 的 Zone。
 * 华为云 DNS 的 Zone，SSL 证书由 CF for SaaS DCV 验证签发，
 * 不需要 _ssl 保底记录。
 *
 * @param {Array} fqdnList - FQDN 列表（含 dnsProvider 字段）
 * @returns {Array} 缺证书的 Zone 列表（空 = 全部正常）
 */
async function ensureSslCerts(fqdnList) {
  const dryRun = process.env.DRY_RUN === '1';

  // 按 zone 分组，去重
  const zoneMap = {};
  for (const f of fqdnList) {
    if (f.noPreferred && !f.origin) continue;
    if (!zoneMap[f.zoneName]) {
      zoneMap[f.zoneName] = { tokenKey: f.tokenKey, dnsProvider: f.dnsProvider || 'cloudflare', fqdns: [] };
    }
    zoneMap[f.zoneName].fqdns.push(f.fqdn);
  }

  // 检测哪些 Zone 缺证书
  console.log('\n── 检测 SSL 证书状态 ──');
  const missingZones = [];
  for (const [zoneName, group] of Object.entries(zoneMap)) {
    // 华为云 DNS 的 Zone 跳过 _ssl 保底（CF 专属机制）
    if (group.dnsProvider === 'huaweicloud') {
      console.log(`  ⊘ ${zoneName} — [华为云DNS] 跳过 _ssl 保底（非 CF 托管）`);
      continue;
    }
    const testFqdn = group.fqdns[0];
    const hasCert = await checkSslCert(testFqdn);
    if (hasCert) {
      console.log(`  ✓ ${zoneName} — SSL 证书正常`);
    } else {
      console.log(`  ✗ ${zoneName} — SSL 证书缺失（${testFqdn} TLS 握手失败）`);
      missingZones.push({ zoneName, tokenKey: group.tokenKey, testFqdn });
    }
  }

  if (missingZones.length === 0) {
    console.log('\n  所有 Zone 的 SSL 证书均正常');
    return [];
  }

  console.log(`\n  需激活证书的 Zone: ${missingZones.map(z => z.zoneName).join(', ')}`);
  console.log(`  方案: 为每个缺证书 Zone 创建 _ssl.{zone} A 记录（proxied=true）保底\n`);

  if (dryRun) {
    console.log('  ⚠  DRY_RUN 模式 — 跳过证书保底');
    return missingZones;
  }

  // 为每个缺证书的 Zone 创建保底记录
  for (const z of missingZones) {
    console.log(`  ▸ ${z.zoneName}:`);
    try {
      const zoneId = await sc.getZoneId(z.zoneName, z.tokenKey);
      const keepaliveFqdn = `${SSL_KEEPALIVE_NAME}.${z.zoneName}`;
      const records = await sc.getDnsRecords(zoneId, keepaliveFqdn, z.tokenKey);

      // 已有保底记录？
      const existing = records.find(r => r.type === 'A' && r.name === SSL_KEEPALIVE_NAME);
      if (existing) {
        if (existing.proxied) {
          console.log(`    ✓ ${keepaliveFqdn} 已存在且 proxied=true，CF 将续签证书`);
        } else {
          // 已有但不是 proxied，更新为 proxied=true
          await sc.cfFetch(`/zones/${zoneId}/dns_records/${existing.id}`, {
            method: 'PUT',
            body: JSON.stringify({ type: 'A', name: SSL_KEEPALIVE_NAME, content: existing.content, proxied: true, ttl: 1 }),
            tokenKey: z.tokenKey,
          });
          console.log(`    ✓ ${keepaliveFqdn} → proxied=true（已更新）`);
        }
        continue;
      }

      // 创建保底记录（192.0.2.1 是文档保留 IP，CF 允许 proxied 记录指向它）
      await sc.cfFetch(`/zones/${zoneId}/dns_records`, {
        method: 'POST',
        body: JSON.stringify({ type: 'A', name: SSL_KEEPALIVE_NAME, content: '192.0.2.1', proxied: true, ttl: 1 }),
        tokenKey: z.tokenKey,
      });
      console.log(`    ✓ ${keepaliveFqdn} → A 192.0.2.1 proxied=true（已创建）`);
    } catch (e) {
      console.log(`    ✗ 操作失败: ${e.message}`);
    }
  }

  console.log(`\n  保底记录已创建/确认，CF 将自动签发通配符证书（通常几分钟到数小时）`);
  console.log('  下次 cron 运行时将自动检测证书是否生效');

  return missingZones.map(z => z.zoneName);
}

// ── 连通性检测 ──────────────────────────────────────────

const CHECK_TIMEOUT = 8000;

/**
 * 检测 FQDN 连通性：HTTPS 请求到 FQDN，检查响应状态
 * 
 * 关键：必须通过 ip 参数直连已验证的 IP，而非让 Node.js 走系统 DNS 解析。
 * 原因：proxied=false 的 A 记录不触发 CF 签发 Universal SSL 证书，
 * 若 SNI=fqdn 但 CF 边缘没有该域证书，会直接 RST（ECONNRESET）；
 * 而 1034 检测用 testHost 做 SNI（已有证书），所以能通过。
 * 直连 IP + SNI=fqdn 可以准确检测"该 IP 在 CF 边缘是否为该 fqdn 正常服务"，
 * 同时避免系统 DNS 解析到不可控 IP 的问题。
 * 
 * @param {string} fqdn - 待检测的域名
 * @param {string|null} ip - 该 FQDN 的 A 记录 IP（直连，绕过系统 DNS）；null 则回退到系统 DNS
 */
function checkConnectivity(fqdn, ip) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };

    const options = {
      path: '/',
      method: 'GET',
      timeout: CHECK_TIMEOUT,
      rejectUnauthorized: false,
      agent: _noKeepAliveAgent,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' },
    };

    if (ip) {
      // 直连已验证的 IP，SNI=fqdn，Host=fqdn
      options.host = ip;
      options.servername = fqdn;
      options.headers.Host = fqdn;
    } else {
      // 无 IP 时回退到系统 DNS 解析（兼容旧调用方式）
      options.hostname = fqdn;
    }

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length >= 4096) {
          res.destroy();
          finish({ ok: true, status: res.statusCode, reason: `HTTP ${res.statusCode}` });
        }
      });
      res.on('end', () => {
        if (/error code:\s*1014|error 1014/i.test(body)) {
          finish({ ok: false, status: res.statusCode, reason: `HTTP ${res.statusCode} Error 1014` });
        } else if (/error code:\s*522|error 522/i.test(body)) {
          finish({ ok: false, status: res.statusCode, reason: `HTTP ${res.statusCode} Error 522` });
        } else if (sc.isChallengePage(res.statusCode, body)) {
          finish({ ok: false, status: res.statusCode, reason: `HTTP ${res.statusCode} 挑战页` });
        } else {
          finish({ ok: true, status: res.statusCode, reason: `HTTP ${res.statusCode}` });
        }
      });
    });

    req.on('timeout', () => { req.destroy(); finish({ ok: false, reason: '请求超时' }); });
    req.on('error', (e) => {
      // ECONNRESET 通常是 CF 边缘无该域名证书直接 RST，给出明确提示
      const msg = e.message || '';
      if (/ECONNRESET/i.test(msg)) {
        finish({ ok: false, reason: `ECONNRESET（CF 边缘无 ${fqdn} 证书，SNI 被 RST）` });
      } else {
        finish({ ok: false, reason: `连接失败: ${msg.slice(0, 60)}` });
      }
    });
    req.end();
  });
}

// ── IP 池构建 ────────────────────────────────────────

/**
 * 从优选域名池收集所有可用 IP，检测质量后排序
 * 池内 IP 经 1034 验证后按延迟排序（默认不去重），
 * 数量足够时跳过 cfIpTop20，不足时才拉取远程 Top20 补充候选。
 * 返回按延迟排序的可用 IP 列表 [{ ip, latency, source }]
 */
async function buildIpPool(testHost, needCount) {
  console.log('\n── IP 池构建 ──');
  console.log(`  测试 Host: ${testHost}`);
  const dedupDesc = IP_DEDUP_PREFIX > 0 ? `/${IP_DEDUP_PREFIX} 去重` : '不去重';
  const latencyDesc = MAX_LATENCY_MS > 0 ? `≤ ${MAX_LATENCY_MS}ms` : '不限制';
  console.log(`  去重: ${dedupDesc}`);
  console.log(`  延迟上限: ${latencyDesc}`);
  console.log(`  每 zone: ${IP_PER_ZONE} 个 IP，共需 ${needCount} 个\n`);

  // 第1步：收集候选 IP（根据 IP_SOURCE 模式）
  const rawIps = new Set();

  const useDomain = IP_SOURCE === 'domain' || IP_SOURCE === 'both';
  const useCidr = IP_SOURCE === 'cidr' || IP_SOURCE === 'both';
  const useIsp = IP_SOURCE === 'isp';
  const isCustom = !['domain', 'cidr', 'both', 'isp'].includes(IP_SOURCE);

  if (isCustom) {
    // 自定义模式：解析用户输入的 CIDR/IP/域名混合
    console.log('  [1] 从自定义来源收集 IP...');
    const { cidrs, singleIps, domains } = sc.parseCustomIpSource(IP_SOURCE);
    if (cidrs.length > 0) {
      const cidrIps = sc.sampleIpsFromCidrList(cidrs, CIDR_SAMPLES);
      for (const ip of cidrIps) rawIps.add(ip);
      console.log(`    CIDR ${cidrs.join(', ')} → ${cidrIps.length} 个 IP（每段最多 ${CIDR_SAMPLES}）`);
    }
    for (const ip of singleIps) {
      rawIps.add(ip);
      console.log(`    单 IP ${ip}`);
    }
    for (const domain of domains) {
      const ips = await sc.resolveIps(domain);
      for (const ip of ips) rawIps.add(ip);
      console.log(`    ${domain.padEnd(32)} → ${ips.length} 个 IP`);
    }
  } else {
    if (useDomain) {
      console.log('  [1] 从优选域名池解析 IP...');
      for (const domain of sc.CNAME_POOL) {
        const ips = await sc.resolveIps(domain);
        for (const ip of ips) {
          if (!sc.is1034Ip(ip)) {
            rawIps.add(ip);
          }
        }
        console.log(`    ${domain.padEnd(32)} → ${ips.length} 个 IP`);
      }
    }

    if (useCidr) {
      console.log(useDomain ? '\n  [1b] 从 CF CIDR 范围采样 IP...' : '  [1] 从 CF CIDR 范围采样 IP...');
      const cfRanges = await sc.fetchCfIpv4Ranges();
      console.log(`    CF IPv4 段: ${cfRanges.length} 个，每段采样 ${CIDR_SAMPLES} 个`);
      const cidrIps = sc.sampleIpsFromCidrList(cfRanges, CIDR_SAMPLES);
      const before = rawIps.size;
      for (const ip of cidrIps) {
        if (!sc.is1034Ip(ip)) {
          rawIps.add(ip);
        }
      }
      console.log(`    CIDR 采样: ${cidrIps.length} 个，新增 ${rawIps.size - before} 个（去重后）`);
    }
  }

  // ── 三网优选 IP 注入 ──
  // isp 模式：仅从三网 API 获取 IP（ISP_IP_POOL_COUNT 为 0 时用 ISP_IP_PER_LINE 兜底）
  // 其他模式：ISP_IP_POOL_COUNT > 0 时无条件注入三网 IP 到候选池一起测，仅去重
  const ispPoolCount = useIsp
    ? (ISP_IP_POOL_COUNT > 0 ? ISP_IP_POOL_COUNT : ISP_IP_PER_LINE)
    : ISP_IP_POOL_COUNT;
  if (ispPoolCount > 0) {
    console.log(`\n  [1c] 从三网 API 拉取优选 IP（每运营商 ${ispPoolCount} 个）...`);
    try {
      const ispIps = await fetchIspIps(ispPoolCount);
      const before = rawIps.size;
      const lines = [
        { key: 'telecom', label: '电信' },
        { key: 'unicom', label: '联通' },
        { key: 'mobile',  label: '移动' },
      ];
      for (const l of lines) {
        for (const ip of ispIps[l.key]) {
          if (!sc.is1034Ip(ip)) rawIps.add(ip);
        }
        console.log(`    ${l.label}: ${ispIps[l.key].length} 个 → 已加入候选池`);
      }
      console.log(`    三网注入后候选池: ${rawIps.size} 个（新增 ${rawIps.size - before}）`);
    } catch (e) {
      console.log(`    三网 IP 拉取失败: ${e.message}，继续用现有候选`);
    }
  }

  if (rawIps.size === 0) {
    throw new Error('未能收集到任何候选 IP！');
  }

  // 第2步：逐 IP 验证 1034 + 挑战页 + 延迟（固定并发池，谁完成谁输出，不互相等待）
  const coloDesc = COLO_FILTER.length > 0 ? `，colo 过滤: ${COLO_FILTER.join(',')}` : '';
  console.log(`\n  [2] 逐 IP 质量检测（${rawIps.size} 个，采样 ${LATENCY_SAMPLES} 次${coloDesc}）...`);

  async function checkIpBatch(ipSet) {
    const ipList = [...ipSet];
    const CONCURRENCY = 10;        // 固定并发数
    const total = ipList.length;
    const allResults = [];
    let done = 0;

    // 单个 IP 检测任务
    async function checkOneIp(ip) {
      const check = await sc.testIp1034(ip, testHost);
      const colo = check.colo || null;
      if (!check.ok) {
        return { ip, ok: false, reason: check.reason, latency: null, colo, samples: [], successCount: 0, totalCount: 0 };
      }
      // 复用 1034 检测的 TLS 握手延迟作为第一次采样，省一次 TCP 连接
      const firstLatency = check.connectLatency || null;
      const { avgLatency, samples, successCount, totalCount } = await measureLatencyMulti(ip, LATENCY_SAMPLES, 443, firstLatency);
      if (avgLatency === null) {
        return { ip, ok: false, reason: 'TCP 连接失败', latency: null, colo, samples, successCount, totalCount };
      }
      return { ip, ok: true, reason: check.reason, latency: avgLatency, colo, samples, successCount, totalCount };
    }

    // 并发池：维护固定并发数，谁完成谁打印谁腾位置
    let cursor = 0;
    async function worker() {
      while (cursor < ipList.length) {
        const ip = ipList[cursor++];
        const r = await checkOneIp(ip);
        allResults.push(r);
        done++;
        console.log(`  ── ${done}/${total} ──`);
        printIpResult(r);
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ipList.length) }, () => worker()));

    return allResults;
  }

  // 打印单个 IP 检测结果
  function printIpResult(r, extra) {
    const status = r.ok ? '✓' : '✗';
    const sampleStr = r.ok && r.samples.length > 1
      ? `${r.latency}ms (${r.samples.map(s => s === null ? '×' : s).join('/')})`
      : r.ok ? `${r.latency}ms` : '';
    const coloStr = r.colo ? r.colo : '';
    const lossStr = r.ok && r.totalCount > 1 && r.successCount < r.totalCount
      ? `${r.successCount}/${r.totalCount}` : '';
    const parts = [
      `  ${status}  ${r.ip.padEnd(18)}`,
      sampleStr.padEnd(r.samples.length > 1 ? 24 : 8),
    ];
    if (lossStr) parts.push(lossStr.padEnd(6));
    if (coloStr) parts.push(coloStr.padEnd(5));
    parts.push(extra || (r.ok ? '' : '— ' + r.reason));
    console.log(parts.join('  ').trimEnd());
  }

  let results = await checkIpBatch(rawIps);
  let good = results.filter(r => r.ok);
  let bad = results.filter(r => !r.ok);

  // colo 过滤
  let filteredByColo = 0;
  if (COLO_FILTER.length > 0) {
    const before = good.length;
    good = good.filter(r => r.colo && COLO_FILTER.includes(r.colo.toUpperCase()));
    filteredByColo = before - good.length;
  }

  // 丢包率过滤
  let filteredByLoss = 0;
  if (LATENCY_SAMPLES > 1) {
    const before = good.length;
    good = good.filter(r => {
      const lossRate = 1 - r.successCount / r.totalCount;
      return lossRate <= MAX_PACKET_LOSS_RATE;
    });
    filteredByLoss = before - good.length;
  }

  // 延迟上限过滤
  let filteredByLatency = 0;
  if (MAX_LATENCY_MS > 0) {
    const before = good.length;
    good = good.filter(r => r.latency <= MAX_LATENCY_MS);
    filteredByLatency = before - good.length;
  }

  for (const r of results) {
    let extra = '';
    if (r.ok && COLO_FILTER.length > 0 && r.colo && !COLO_FILTER.includes(r.colo.toUpperCase())) {
      extra = `[colo ${r.colo} 不匹配]`;
    } else if (r.ok && r.totalCount > 1 && r.successCount < r.totalCount) {
      const lossRate = 1 - r.successCount / r.totalCount;
      if (lossRate > MAX_PACKET_LOSS_RATE) {
        extra = `[丢包率 ${(lossRate * 100).toFixed(0)}% > ${(MAX_PACKET_LOSS_RATE * 100).toFixed(0)}%]`;
      }
    } else if (r.ok && MAX_LATENCY_MS > 0 && r.latency > MAX_LATENCY_MS) {
      extra = '[超延迟]';
    }
    if (extra) printIpResult(r, extra);
  }

  const filterParts = [`不可用 ${bad.length}`];
  if (filteredByColo > 0) filterParts.push(`colo 不匹配 ${filteredByColo}`);
  if (filteredByLoss > 0) filterParts.push(`丢包率过高 ${filteredByLoss}`);
  if (filteredByLatency > 0) filterParts.push(`超延迟 ${filteredByLatency}`);
  console.log(`\n  检测结果: 可用 ${good.length} / ${filterParts.join(' / ')}`);

  // 第3步：按延迟排序（prefixLen=0 时不去重，保留全部）
  console.log(`\n  [3] ${dedupDesc}...`);
  let deduped = dedupIps(good);
  console.log(`  去重后: ${deduped.length} 个 IP（按延迟排序）`);
  for (const item of deduped.slice(0, 20)) {
    const coloStr = item.colo ? ` ${item.colo}` : '';
    const sampleStr = item.samples && item.samples.length > 1
      ? ` (${item.samples.map(s => s === null ? '×' : s).join('/')})`
      : '';
    console.log(`    ${item.ip.padEnd(18)} ${item.latency}ms${sampleStr}${coloStr}`);
  }
  if (deduped.length > 20) {
    console.log(`    ... 共 ${deduped.length} 个`);
  }

  // 第4步：去重后数量不足且开启 cfIpTop20 补充时才拉取
  if (deduped.length < needCount && ENABLE_CF_TOP20) {
    console.log(`\n  [4] 池内仅 ${deduped.length} 个 IP，不足 ${needCount}，从 cfIpTop20 补充...`);
    try {
      const top20 = await sc.fetchCfTop20();
      // 收集新候选 IP（排除已检测过的）
      const existingIps = new Set(results.map(r => r.ip));
      const newIps = new Set();
      for (const domain of top20) {
        const ips = await sc.resolveIps(domain);
        for (const ip of ips) {
          if (!sc.is1034Ip(ip) && !existingIps.has(ip)) {
            newIps.add(ip);
          }
        }
      }
      console.log(`    cfIpTop20 新增候选: ${newIps.size} 个 IP`);

      if (newIps.size > 0) {
        const newResults = await checkIpBatch(newIps);
        // 补充批次只打印被过滤的 IP（正常 IP 已在 checkIpBatch 内打印）
        for (const r of newResults) {
          let extra = '';
          if (r.ok && COLO_FILTER.length > 0 && r.colo && !COLO_FILTER.includes(r.colo.toUpperCase())) {
            extra = `[colo ${r.colo} 不匹配]`;
          } else if (r.ok && r.totalCount > 1 && r.successCount < r.totalCount) {
            const lossRate = 1 - r.successCount / r.totalCount;
            if (lossRate > MAX_PACKET_LOSS_RATE) {
              extra = `[丢包率 ${(lossRate * 100).toFixed(0)}% > ${(MAX_PACKET_LOSS_RATE * 100).toFixed(0)}%]`;
            }
          } else if (r.ok && MAX_LATENCY_MS > 0 && r.latency > MAX_LATENCY_MS) {
            extra = '[超延迟]';
          }
          if (extra) printIpResult(r, extra);
        }
        let newGood = newResults.filter(r => r.ok);
        // colo 过滤
        if (COLO_FILTER.length > 0) {
          newGood = newGood.filter(r => r.colo && COLO_FILTER.includes(r.colo.toUpperCase()));
        }
        // 丢包率过滤
        if (LATENCY_SAMPLES > 1) {
          newGood = newGood.filter(r => {
            const lossRate = 1 - r.successCount / r.totalCount;
            return lossRate <= MAX_PACKET_LOSS_RATE;
          });
        }
        // 延迟过滤
        if (MAX_LATENCY_MS > 0) {
          newGood = newGood.filter(r => r.latency <= MAX_LATENCY_MS);
        }
        results = [...results, ...newResults];
        good = [...good, ...newGood];
        deduped = dedupIps(good);
        console.log(`    补充后去重: ${deduped.length} 个 IP`);
      }
    } catch (e) {
      console.log(`    cfIpTop20 拉取失败: ${e.message}，继续用现有 IP`);
    }
  } else if (deduped.length < needCount && !ENABLE_CF_TOP20) {
    console.log(`\n  [4] 池内仅 ${deduped.length} 个 IP，不足 ${needCount}（cfIpTop20 补充未开启）`);
  } else {
    console.log(`\n  [4] 池内 ${deduped.length} 个 IP >= 需求 ${needCount}，跳过 cfIpTop20`);
  }

  if (deduped.length === 0) {
    console.log('\n  ⚠ IP 池为空！CF zone 将跳过测速与 A 记录写入，保留现有 DNS 记录不变');
    console.log('  ⚠ 华为云三网分线路同步不受影响，继续执行');
  }

  // 收集所有已检测过的 IP（包括不可用的），供后续测速阶段去重
  const allSeenIps = new Set(results.map(r => r.ip));

  return { pool: deduped, seenIps: allSeenIps };
}

// ── Zone 分配 ───────────────────────────────────────

/**
 * 为每个 zone 分配 IP 组
 * 不同 zone 尽量分到不同 IP，实现容灾
 * IP 不够时允许跨 zone 复用（轮转分配）
 */
function assignIpsToZones(zoneMap, ipPool, ipPerZone) {
  // 华为云 zone 走三网分线路，不从 CF IP 池分 IP
  const poolZones = zoneMap.filter(z => !z.noPreferred && z.dnsProvider !== 'huaweicloud');
  const assignments = [];
  const poolLen = ipPool.length;

  for (let zi = 0; zi < poolZones.length; zi++) {
    const zone = poolZones[zi];
    const ips = [];

    if (poolLen === 0) {
      // IP 池为空：CF zone 不分配 IP，processARecords 会跳过
      for (const name of zone.names) {
        assignments.push({
          fqdn: `${name}.${zone.zoneName}`,
          zoneName: zone.zoneName,
          name,
          tokenKey: zone.tokenKey,
          dnsProvider: zone.dnsProvider || 'cloudflare',
          ips: [],
        });
      }
      continue;
    }

    // 使用偏移分配：每个 zone 从池中不同位置开始取 IP，最大化跨 zone 差异性
    // 当池够大时各 zone 完全不重叠；池不足时各 zone 至少不会完全相同
    const offset = Math.floor(zi * poolLen / poolZones.length);
    for (let j = 0; j < ipPerZone; j++) {
      const idx = (offset + j) % poolLen;
      ips.push(ipPool[idx].ip);
    }

    // 去重：池不足时可能产生重复 IP，CF 创建重复 A 记录会报错
    const uniqueIps = [...new Set(ips)];
    if (uniqueIps.length < ips.length) {
      // 保留去重后的列表（不补凑，避免创建重复记录）
      ips.length = 0;
      ips.push(...uniqueIps);
    }

    for (const name of zone.names) {
      assignments.push({
        fqdn: `${name}.${zone.zoneName}`,
        zoneName: zone.zoneName,
        name,
        tokenKey: zone.tokenKey,
        dnsProvider: zone.dnsProvider || 'cloudflare',
        ips,
      });
    }
  }

  // noPreferred zone 保持直连源站
  for (const zone of zoneMap) {
    if (!zone.noPreferred) continue;
    for (const name of zone.names) {
      const origin = (zone.origins && zone.origins[name]) || null;
      if (!origin) {
        console.log(`  ⚠ ${name}.${zone.zoneName} 无对应源站 origin，跳过`);
        continue;
      }
      assignments.push({
        fqdn: `${name}.${zone.zoneName}`,
        zoneName: zone.zoneName,
        name,
        tokenKey: zone.tokenKey,
        dnsProvider: zone.dnsProvider || 'cloudflare',
        direct: true,
        target: origin,
      });
    }
  }

  // 华为云 zone：加入 assignment 列表（不分配 CF IP，由 processHwIspRecords 单独处理）
  // 所有前缀（包括有 origin 的，如 answer）都走通配符 A → CF 边缘 IP → Worker 路由转发
  // 不再为有 origin 的前缀创建显式 CNAME 直连源站，统一由 Worker 路由处理
  // ispSources 传递：per-zone 三网分线路域名组（可选，未配则 processHwIspRecords 回退 HTTP API）
  for (const zone of zoneMap) {
    if (zone.dnsProvider !== 'huaweicloud' || zone.noPreferred) continue;
    for (const name of zone.names) {
      assignments.push({
        fqdn: `${name}.${zone.zoneName}`,
        zoneName: zone.zoneName,
        name,
        tokenKey: zone.tokenKey,
        dnsProvider: 'huaweicloud',
        // ips 为空，processHwIspRecords 会拉取三网 IP
        ips: [],
        ...(zone.ispSources ? { ispSources: zone.ispSources } : {}),
      });
    }
  }

  return assignments;
}

// ── DNS 记录操作（通过 sync-cname 的 provider 路由层）──

async function createARecord(zoneId, name, ip, tokenKey, dnsProvider) {
  return sc.createARecord(zoneId, name, ip, tokenKey, dnsProvider);
}

async function createCnameRecord(zoneId, name, target, tokenKey, dnsProvider) {
  return sc.createCnameRecord(zoneId, name, target, tokenKey, dnsProvider, false);
}

async function deleteDnsRecord(zoneId, recordId, tokenKey, dnsProvider) {
  return sc.deleteDnsRecord(zoneId, recordId, tokenKey, dnsProvider);
}

// ── 分配计划打印 ─────────────────────────────────────

function printAssignmentPlan(assignments) {
  console.log('\n┌──────────────────────────────────────────────────────────────────┐');
  console.log('│  A 记录分配计划                                                  │');
  console.log('├──────────────────────────────────────────────────────────────────┤');
  console.log('│  FQDN                              →  IP 记录                   │');
  console.log('├──────────────────────────────────────────────────────────────────┤');

  for (const a of assignments) {
    if (a.direct) {
      console.log(`│  ${a.fqdn.padEnd(34)} →  [源站] ${a.target.padEnd(24)} │`);
    } else {
      const ipsStr = a.ips.join(', ');
      console.log(`│  ${a.fqdn.padEnd(34)} →  [A] ${ipsStr.padEnd(26)} │`);
    }
  }
  console.log('└──────────────────────────────────────────────────────────────────┘');

  const byIp = {};
  for (const a of assignments) {
    if (a.direct) continue;
    for (const ip of a.ips) {
      byIp[ip] = (byIp[ip] || 0) + 1;
    }
  }
  console.log('\n  IP 分配统计:');
  for (const [ip, count] of Object.entries(byIp).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${ip.padEnd(18)} × ${count}`);
  }
}

// ── DNS 同步主逻辑 ──────────────────────────────────

/**
 * 华为云三网分线路同步
 *
 * 为华为云 DNS zone 创建通配符泛解析记录，按运营商线路分别指向对应优选 IP：
 *   *.zzgxxx.eu.org  A  Dianxin   → [电信IP1, 电信IP2]
 *   *.zzgxxx.eu.org  A  Liantong  → [联通IP1, 联通IP2]
 *   *.zzgxxx.eu.org  A  Yidong    → [移动IP1, 移动IP2]
 *   *.zzgxxx.eu.org  A  default   → [默认IP1, 默认IP2]
 *
 * 所有前缀（Pages + 非 Pages 如 answer）统一走通配符 A → CF 边缘 IP → Worker 路由转发
 * 清理已存在的显式 CNAME/A 记录，避免覆盖通配符
 *
 * @param {Array} hwAssignments — 华为云 zone 的 assignments（含 direct 和非 direct）
 * @param {string} testHost — 1034 真实请求验证用的测试 Host（如 sg.1189.dpdns.org）
 * @returns {Promise<{created, deleted, skipped, errors}>}
 */
async function processHwIspRecords(hwAssignments, testHost) {
  const dryRun = process.env.DRY_RUN === '1';

  // 按 zoneName 分组（ispSources 从同组任一 assignment 读取）
  const zoneGroups = {};
  for (const a of hwAssignments) {
    if (!zoneGroups[a.zoneName]) {
      zoneGroups[a.zoneName] = { tokenKey: a.tokenKey, items: [], ispSources: a.ispSources || null };
    }
    zoneGroups[a.zoneName].items.push(a);
  }

  let totalStats = { created: 0, deleted: 0, skipped: 0, errors: 0 };

  // 三网候选 IP 拉取数量：多拉候选做 1034 验证，最终只取 ISP_IP_PER_LINE 个写入 DNS
  const ISP_FETCH_COUNT = parseInt(process.env.ISP_FETCH_COUNT || '8', 10);

  // 三网线路定义（用于 1034 验证和截取）
  const ispLines = [
    { key: 'telecom', label: '电信' },
    { key: 'unicom', label: '联通' },
    { key: 'mobile',  label: '移动' },
  ];

  for (const [zoneName, group] of Object.entries(zoneGroups)) {
    const tokenKey = group.tokenKey;
    const ispSources = group.ispSources;
    console.log(`\n━━━ Zone: ${zoneName} (账户: ${tokenKey}) [华为云DNS 三网分线路] ━━━`);

    // ── per-zone 三网 IP 拉取 ──
    // 有 ispSources → DNS 解析域名获取三网 IP；无 → 回退 cf.090227.xyz HTTP API
    let ispIps;
    if (ispSources) {
      console.log(`  IP 来源: DNS 解析（ispSources 域名组）`);
      ispIps = await fetchIspIpsByDns(ispSources, ISP_FETCH_COUNT);
    } else {
      console.log(`  IP 来源: HTTP API（${process.env.ISP_IP_SOURCE || 'cf.090227.xyz'}）`);
      ispIps = await fetchIspIps(ISP_FETCH_COUNT);
    }

    const hasIspIps = ispIps.telecom.length > 0 || ispIps.unicom.length > 0 || ispIps.mobile.length > 0;
    if (!hasIspIps) {
      console.error(`  ✗ Zone ${zoneName}: 三网优选 IP 全部拉取失败，跳过该 Zone`);
      totalStats.errors += group.items.length;
      continue;
    }

    // ── 1034 验证：过滤已知保留 IP + 真实请求验证 ──
    // 与 CF IP 池（buildIpPool）保持一致：三网 IP 也需 1034 验证，
    // 避免 IP 混入 CF 保留 IP（如 1.1.1.1）直接写入 DNS
    for (const l of ispLines) {
      const raw = ispIps[l.key];
      // 第1步：快速短路，过滤已知 CF 保留 IP
      const afterQuick = raw.filter(ip => !sc.is1034Ip(ip));
      const removed = raw.length - afterQuick.length;
      if (removed > 0) {
        console.log(`  [1034 快速过滤] ${l.label}: 移除 ${removed} 个保留 IP → ${raw.filter(ip => sc.is1034Ip(ip)).join(', ')}`);
      }
      // 第2步：真实请求验证（testHost 做 SNI+Host），不可用的 IP 不写入 DNS
      if (testHost && afterQuick.length > 0) {
        console.log(`  [1034 真实验证] ${l.label}: 验证 ${afterQuick.length} 个 IP (testHost: ${testHost})`);
        const checks = await Promise.all(afterQuick.map(async (ip) => {
          const r = await sc.testIp1034(ip, testHost);
          return { ip, ...r };
        }));
        const good = checks.filter(r => r.ok);
        const bad = checks.filter(r => !r.ok);
        if (bad.length > 0) {
          console.log(`    ✗ ${l.label} 不可用 IP (${bad.length}/${checks.length}): ${bad.map(r => `${r.ip}(${r.reason})`).join(', ')}`);
        }
        ispIps[l.key] = good.map(r => r.ip);
      } else {
        // 无 testHost（不应发生，降级）：仅用快速过滤结果
        ispIps[l.key] = afterQuick;
      }
      if (ispIps[l.key].length === 0) {
        console.log(`  ⚠ ${l.label}: 1034 验证后无可用 IP，该线路将跳过`);
      }
    }

    // 验证后每条线路截取 ISP_IP_PER_LINE 个写入 DNS（拉取多但只取够用的）
    for (const l of ispLines) {
      if (ispIps[l.key].length > ISP_IP_PER_LINE) {
        console.log(`  [截取] ${l.label}: ${ispIps[l.key].length} → ${ISP_IP_PER_LINE} 个 → ${ispIps[l.key].slice(0, ISP_IP_PER_LINE).join(', ')}`);
        ispIps[l.key] = ispIps[l.key].slice(0, ISP_IP_PER_LINE);
      }
    }

    // default 线路：验证后重新合并三网可用 IP 去重
    // 如果 ispSources.default 域名单独拉取了 IP，也需要经过 1034 验证
    if (ispSources && ispSources.default && ispIps.default.length > 0) {
      // default 域名的 IP 也需要 1034 验证
      const rawDefault = ispIps.default;
      const afterQuickDefault = rawDefault.filter(ip => !sc.is1034Ip(ip));
      if (testHost && afterQuickDefault.length > 0) {
        console.log(`  [1034 真实验证] 默认: 验证 ${afterQuickDefault.length} 个 IP (testHost: ${testHost})`);
        const checks = await Promise.all(afterQuickDefault.map(async (ip) => {
          const r = await sc.testIp1034(ip, testHost);
          return { ip, ...r };
        }));
        const good = checks.filter(r => r.ok);
        const bad = checks.filter(r => !r.ok);
        if (bad.length > 0) {
          console.log(`    ✗ 默认 不可用 IP (${bad.length}/${checks.length}): ${bad.map(r => `${r.ip}(${r.reason})`).join(', ')}`);
        }
        ispIps.default = good.map(r => r.ip);
      } else {
        ispIps.default = afterQuickDefault;
      }
      // 截取
      if (ispIps.default.length > ISP_IP_PER_LINE) {
        console.log(`  [截取] 默认: ${ispIps.default.length} → ${ISP_IP_PER_LINE} 个 → ${ispIps.default.slice(0, ISP_IP_PER_LINE).join(', ')}`);
        ispIps.default = ispIps.default.slice(0, ISP_IP_PER_LINE);
      }
      // default 域名 IP 全部 1034 验证失败时，回退合并三网已验证 IP
      if (ispIps.default.length === 0) {
        console.log(`  ⚠ 默认域名 IP 经 1034 验证后全部不可用，回退合并三网 IP`);
        const defaultCandidates = [];
        for (const l of ispLines) {
          defaultCandidates.push(...ispIps[l.key]);
        }
        ispIps.default = [...new Set(defaultCandidates)];
      }
    } else {
      // 无 default 域名或留空：合并三网可用 IP 去重
      const defaultCandidates = [];
      for (const l of ispLines) {
        defaultCandidates.push(...ispIps[l.key]);
      }
      ispIps.default = [...new Set(defaultCandidates)];
    }
    console.log(`  [1034 验证完成] 默认线路: ${ispIps.default.length} 个 → ${ispIps.default.join(', ') || '(空)'}`);

    // 验证后再次检查是否有可用 IP
    const hasValidIps = ispIps.telecom.length > 0 || ispIps.unicom.length > 0 || ispIps.mobile.length > 0;
    if (!hasValidIps) {
      console.error(`  ✗ Zone ${zoneName}: 三网优选 IP 经 1034 验证后全部不可用，跳过该 Zone`);
      totalStats.errors += group.items.length;
      continue;
    }

    // 华为云分线路定义
    const lineConfig = [
      { line: HW_LINES.telecom, ips: ispIps.telecom, label: '电信' },
      { line: HW_LINES.unicom, ips: ispIps.unicom, label: '联通' },
      { line: HW_LINES.mobile, ips: ispIps.mobile, label: '移动' },
      { line: HW_LINES.default, ips: ispIps.default, label: '默认' },
    ].filter((l) => l.ips.length > 0);

    let zoneId;
    try {
      zoneId = await sc.getZoneId(zoneName, tokenKey, 'huaweicloud');
    } catch (e) {
      console.error(`  ✗ 获取 Zone ID 失败: ${e.message}`);
      totalStats.errors += group.items.length;
      continue;
    }

    // 所有前缀统一走通配符 A 记录（包括 answer 等非 Pages 前缀，由 Worker 路由转发）
    const poolItems = group.items;

    // ── 通配符 A 记录：一条 * 记录覆盖所有前缀 ──
    if (poolItems.length > 0) {
      const wildcardName = `*.${zoneName}`;
      console.log(`\n  ▸ ${wildcardName} → 三网分线路 A 记录`);

      try {
        // 查询现有记录
        const existingRecords = await sc.getDnsRecords(zoneId, wildcardName, tokenKey, 'huaweicloud');

        // 先删除同名 CNAME 记录（旧通配符 CNAME 会与 A 记录冲突）
        const conflictingCnames = existingRecords.filter((r) => r.type === 'CNAME');
        for (const rec of conflictingCnames) {
          console.log(`    [清理] 删除冲突 CNAME → ${rec.content} (id: ${rec.id})`);
          if (!dryRun) await sc.deleteDnsRecord(zoneId, rec.id, tokenKey, 'huaweicloud');
          totalStats.deleted++;
        }

        // 按线路分组现有 A 记录
        const existingByLine = {};
        for (const rec of existingRecords) {
          if (rec.type !== 'A') continue;
          const line = rec.line || 'default_view';
          if (!existingByLine[line]) existingByLine[line] = [];
          existingByLine[line].push(rec);
        }

        // 尝试分线路模式：逐线路创建 A 记录
        // 如果 NS 未切换到华为云，分线路会失败降级为 default_view
        // 此时改为合并所有 IP 创建一条 default_view 记录
        let ispLinesSupported = true;

        for (const lc of lineConfig) {
          const targetIps = lc.ips;
          const existing = existingByLine[lc.line] || [];

          // 对比 IP 是否一致
          const existingIps = existing.flatMap((r) => r.records || []);
          const targetSet = new Set(targetIps);
          const existingSet = new Set(existingIps);

          const ipsMatch =
            targetSet.size === existingSet.size &&
            [...targetSet].every((ip) => existingSet.has(ip));

          if (ipsMatch) {
            console.log(`    [${lc.label}] A ${targetIps.join(', ')} → 已匹配，跳过`);
            totalStats.skipped++;
          } else {
            // 删除旧记录
            for (const rec of existing) {
              console.log(`    [${lc.label}] 删除旧 A → ${(rec.records || []).join(', ')} (id: ${rec.id})`);
              if (!dryRun) await sc.deleteDnsRecord(zoneId, rec.id, tokenKey, 'huaweicloud');
              totalStats.deleted++;
            }
            // 创建新记录
            console.log(`    [${lc.label}] 创建 A → ${targetIps.join(', ')}`);
            if (!dryRun) {
              try {
                await sc.createARecord(zoneId, wildcardName, targetIps, tokenKey, 'huaweicloud', {
                  ips: targetIps,
                  line: lc.line,
                });
              } catch (createErr) {
                if (createErr.message && createErr.message.includes('already exists')) {
                  // 分线路降级为 default_view 后，多条线路重复创建 default_view 冲突
                  // 标记分线路不支持，后续改为合并模式
                  console.log(`    [${lc.label}] 分线路降级冲突，切换为合并模式`);
                  ispLinesSupported = false;
                  break;
                } else {
                  throw createErr;
                }
              }
            }
            totalStats.created++;
          }
        }

        // 如果分线路不支持（NS 未切换），合并所有 IP 创建/更新一条 default_view 记录
        if (!ispLinesSupported) {
          const allIps = [...new Set(lineConfig.flatMap((l) => l.ips))];

          // 重新查询当前记录（上一轮降级可能已创建了部分 default_view 记录）
          const currentRecords = await sc.getDnsRecords(zoneId, wildcardName, tokenKey, 'huaweicloud');
          const currentA = currentRecords.filter((r) => r.type === 'A');

          // 对比 IP 是否一致（合并所有 A 记录的 IP 与目标比较）
          const currentIps = currentA.flatMap((r) => r.records || []);
          const targetSet = new Set(allIps);
          const currentSet = new Set(currentIps);
          const ipsMatch =
            targetSet.size === currentSet.size &&
            [...targetSet].every((ip) => currentSet.has(ip)) &&
            currentA.length === 1; // 合并模式只有一条记录

          if (ipsMatch) {
            console.log(`    [默认] A ${allIps.join(', ')} → 已匹配，跳过`);
            totalStats.skipped++;
          } else {
            // 删除所有旧 A 记录（包括降级产生的部分 default_view 记录）
            for (const rec of currentA) {
              console.log(`    [默认] 删除旧 A → ${(rec.records || []).join(', ')} (line: ${rec.line || 'default_view'}, id: ${rec.id})`);
              if (!dryRun) await sc.deleteDnsRecord(zoneId, rec.id, tokenKey, 'huaweicloud');
              totalStats.deleted++;
            }
            // 创建合并的 default_view 记录
            console.log(`    [默认] 创建 A → ${allIps.join(', ')} (合并三网 IP)`);
            if (!dryRun) {
              await sc.createARecord(zoneId, wildcardName, allIps, tokenKey, 'huaweicloud', {
                ips: allIps,
                line: HW_LINES.default,
              });
            }
            totalStats.created++;
          }
        }

        // 清理非分线路的旧 A 记录（line=default_view 但不在 lineConfig 中的，或重复的）
        const validLines = new Set(lineConfig.map((l) => l.line));
        for (const rec of existingRecords) {
          if (rec.type !== 'A') continue;
          const line = rec.line || 'default_view';
          if (!validLines.has(line)) {
            console.log(`    [清理] 删除无效线路 A → ${(rec.records || []).join(', ')} (line: ${line}, id: ${rec.id})`);
            if (!dryRun) await sc.deleteDnsRecord(zoneId, rec.id, tokenKey, 'huaweicloud');
            totalStats.deleted++;
          }
        }
      } catch (e) {
        console.error(`    ✗ 通配符记录处理失败: ${e.message}`);
        totalStats.errors++;
      }
    }

    // 所有前缀统一走通配符 A → CF 边缘 IP → Worker 路由转发
    // 清理已存在的显式 CNAME/A 记录（如旧 answer CNAME），否则会覆盖通配符 A
    for (const a of group.items) {
      const { fqdn } = a;
      try {
        const records = await sc.getDnsRecords(zoneId, fqdn, tokenKey, 'huaweicloud');
        if (records.length > 0) {
          for (const rec of records) {
            console.log(`  [清理] 删除 ${fqdn} 的显式 ${rec.type} → ${rec.content} (id: ${rec.id})，改由通配符 A 覆盖`);
            if (!dryRun) await sc.deleteDnsRecord(zoneId, rec.id, tokenKey, 'huaweicloud');
            totalStats.deleted++;
          }
        }
      } catch (e) {
        // 查询失败不阻塞流程（记录可能不存在）
      }
    }
  }

  return totalStats;
}

async function processARecords(assignments) {
  const dryRun = process.env.DRY_RUN === '1';

  const zoneGroups = {};
  for (const a of assignments) {
    if (!zoneGroups[a.zoneName]) {
      zoneGroups[a.zoneName] = { tokenKey: a.tokenKey, dnsProvider: a.dnsProvider || 'cloudflare', items: [] };
    }
    zoneGroups[a.zoneName].items.push(a);
  }

  let totalStats = { errors: 0, created: 0, deleted: 0, skipped: 0 };

  for (const [zoneName, group] of Object.entries(zoneGroups)) {
    const tokenKey = group.tokenKey;
    const dnsProvider = group.dnsProvider;
    const provTag = dnsProvider === 'huaweicloud' ? ' [华为云DNS]' : '';
    console.log(`\n━━━ Zone: ${zoneName}${tokenKey ? ` (账户: ${tokenKey})` : ''}${provTag} ━━━`);

    let zoneId;
    try {
      zoneId = await sc.getZoneId(zoneName, tokenKey, dnsProvider);
    } catch (e) {
      console.error(`  ✗ 获取 Zone ID 失败: ${e.message}`);
      totalStats.errors += group.items.length;
      continue;
    }

    for (const a of group.items) {
      const { fqdn } = a;

      if (a.direct) {
        console.log(`\n  ▸ ${fqdn} → [源站] ${a.target}`);
        try {
          const records = await sc.getDnsRecords(zoneId, fqdn, tokenKey, dnsProvider);
          const cnameRecords = records.filter(r => r.type === 'CNAME');
          const matchTarget = cnameRecords.filter(r => r.content === a.target);

          if (matchTarget.length > 0) {
            console.log(`    CNAME 已指向 ${a.target} → 跳过`);
            totalStats.skipped++;
          } else {
            for (const rec of records) {
              console.log(`    删除旧记录 ${rec.type} → ${rec.content} (id: ${rec.id})`);
              if (!dryRun) await deleteDnsRecord(zoneId, rec.id, tokenKey, dnsProvider);
              totalStats.deleted++;
            }
            console.log(`    创建 CNAME → ${a.target}`);
            if (!dryRun) await createCnameRecord(zoneId, fqdn, a.target, tokenKey, dnsProvider);
            totalStats.created++;
          }
        } catch (e) {
          console.error(`    ✗ 处理失败: ${e.message}`);
          totalStats.errors++;
        }
        continue;
      }

      // A 记录模式
      const targetIps = a.ips;
      if (targetIps.length === 0) {
        console.log(`\n  ▸ ${fqdn} → [A] 无可用 IP，跳过（保留现有记录）`);
        totalStats.skipped++;
        continue;
      }
      console.log(`\n  ▸ ${fqdn} → [A] ${targetIps.join(', ')}`);

      try {
        const records = await sc.getDnsRecords(zoneId, fqdn, tokenKey, dnsProvider);
        const aRecords = records.filter(r => r.type === 'A');
        const cnameRecords = records.filter(r => r.type === 'CNAME');
        const otherRecords = records.filter(r => r.type !== 'A' && r.type !== 'CNAME');

        // 删除非 A 记录
        for (const rec of [...cnameRecords, ...otherRecords]) {
          console.log(`    删除 ${rec.type} 记录 → ${rec.content} (id: ${rec.id})`);
          if (!dryRun) await deleteDnsRecord(zoneId, rec.id, tokenKey, dnsProvider);
          totalStats.deleted++;
        }

        // 对比 A 记录
        const existingIps = aRecords.map(r => r.content);
        const targetSet = new Set(targetIps);
        const existingSet = new Set(existingIps);

        const toDelete = aRecords.filter(r => !targetSet.has(r.content));
        const toCreate = targetIps.filter(ip => !existingSet.has(ip));

        for (const rec of toDelete) {
          console.log(`    删除 A 记录 → ${rec.content} (id: ${rec.id})`);
          if (!dryRun) await deleteDnsRecord(zoneId, rec.id, tokenKey, dnsProvider);
          totalStats.deleted++;
        }

        for (const ip of toCreate) {
          console.log(`    创建 A 记录 → ${ip}`);
          if (!dryRun) await createARecord(zoneId, fqdn, ip, tokenKey, dnsProvider);
          totalStats.created++;
        }

        if (toDelete.length === 0 && toCreate.length === 0) {
          console.log(`    A 记录已匹配 → 跳过`);
          totalStats.skipped++;
        }
      } catch (e) {
        console.error(`    ✗ 处理失败: ${e.message}`);
        totalStats.errors++;
      }
    }
  }

  return totalStats;
}

// ── 主入口 ──────────────────────────────────────────

async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  Cloudflare DNS 同步 + 检验 + 测速              ║');
  console.log('╚════════════════════════════════════════════════╝');

  if (process.env.DRY_RUN === '1') {
    console.log('\n⚠  DRY_RUN 模式 — 仅预览，不执行任何修改\n');
  }

  // ── 第0步：自动检测 Zone 配置 ──
  console.log('\n── 自动检测 Zone 配置 ──');
  const ZONE_MAP = sc.autoDetectZoneMap();
  if (ZONE_MAP.length === 0) {
    throw new Error('未检测到任何 Zone 配置，请检查 workers/ 下的 wrangler.toml');
  }

  // 按 TOKEN_KEY 过滤
  const filterTokenKey = process.env.TOKEN_KEY;
  let filteredZones = ZONE_MAP;
  if (filterTokenKey) {
    const before = filteredZones.length;
    filteredZones = filteredZones.filter(z => z.tokenKey === filterTokenKey);
    console.log(`  TOKEN_KEY=${filterTokenKey} 过滤: ${before} → ${filteredZones.length} 个 Zone`);
  }

  // 华为云 zone 走三网分线路，不参与 CF IP 池测速
  const poolZones = filteredZones.filter(z => !z.noPreferred && z.dnsProvider !== 'huaweicloud');
  const noPrefZones = filteredZones.filter(z => z.noPreferred);
  const hwZones = filteredZones.filter(z => z.dnsProvider === 'huaweicloud');
  const cfZones = filteredZones.filter(z => z.dnsProvider !== 'huaweicloud');
  console.log(`  共 ${filteredZones.length} 个 Zone（CF A 记录: ${poolZones.length}，直连源站: ${noPrefZones.length}，华为云三网: ${hwZones.length}）`);
  if (hwZones.length > 0) {
    console.log(`  DNS Provider: Cloudflare ${cfZones.length} / 华为云 ${hwZones.length} (${hwZones.map(z => z.zoneName).join(', ')})`);
  }

  const testHost = sc.buildTestHost(filteredZones);
  if (!testHost) {
    throw new Error('无法构建测试 Host，请检查 Zone 配置');
  }

  // ═══════════════════════════════════════════════════
  // 第一步：构建 IP 池（1034 验证 + 延迟排序 + 去重）
  // ═══════════════════════════════════════════════════

  console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  第一步：构建 IP 池（1034 + 延迟 + /${IP_DEDUP_PREFIX} 去重）`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const needCount = poolZones.length * IP_PER_ZONE;

  let ipPool = [];
  let allSeenIps = new Set();
  if (needCount > 0) {
    const result = await buildIpPool(testHost, needCount);
    ipPool = result.pool;
    allSeenIps = result.seenIps;
  } else {
    console.log('\n  无 CF A 记录 zone，跳过 IP 池构建');
  }

  if (needCount > 0 && ipPool.length < needCount) {
    console.log(`\n  ⚠  IP 池 ${ipPool.length} 个，需求 ${needCount} 个（将跨 zone 复用）`);
  }

  // ═══════════════════════════════════════════════════
  // 第二步：测速筛选
  // fast = 从低延迟开始逐个测速，凑够 needCount 个达标即停
  // best = 全部测完后按速度排序，选最快的 needCount 个
  // off  = 跳过测速，直接用延迟+丢包率排序结果
  // ═══════════════════════════════════════════════════

  const isBestMode = SPEED_TEST_MODE === 'best';
  const isOffMode = SPEED_TEST_MODE === 'off';

  // 确定测速域名：优先使用环境变量，否则用 testHost（已部署 Worker 的域名）
  const speedHost = SPEED_TEST_HOST || testHost;

  console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  第二步：测速筛选');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let speedResults; // { ip, latency, speed_kbps }（达标）
  let subparResults = []; // { ip, latency, colo, speed_kbps }（测速成功但未达标，供降级补充）

  // ── off 模式：跳过测速，直接用 ipPool（已按延迟排序）构建 speedResults ──
  if (isOffMode) {
    console.log('  模式: off（跳过测速，仅按延迟+丢包率排序）');
    console.log(`  可用 IP: ${ipPool.length} 个（取前 ${needCount} 个）`);
    console.log('');

    if (ipPool.length === 0) {
      console.log('\n  ⚠ IP 池为空，跳过测速，CF zone 保留现有 DNS 记录不变');
      speedResults = [];
    } else {
      const offPool = ipPool.slice(0, needCount);
      console.log('  选中 IP（按延迟排序）:');
      for (const r of offPool) {
        const coloStr = r.colo ? `[${r.colo}] ` : '';
        const sampleStr = r.samples && r.samples.length > 1
          ? ` (${r.samples.map(s => s === null ? '×' : s).join('/')})`
          : '';
        console.log(`    ✓ ${r.ip.padEnd(18)} (${r.latency}ms)${sampleStr} ${coloStr}`);
      }
      if (offPool.length < needCount) {
        console.log(`\n  ⚠ 仅 ${offPool.length} 个 IP，不足 ${needCount}，将跨 zone 复用`);
      }

      // 直接用 offPool 作为 speedResults（无需 speed_kbps 字段，后续不再使用）
      speedResults = offPool.map(r => ({ ip: r.ip, latency: r.latency, colo: r.colo || null, speed_kbps: 0 }));
    }

  } else {

  console.log(`  模式: ${isBestMode ? 'best（全部测完选最优）' : 'fast（达标即停）'}`);
  console.log(`  测速域名: ${speedHost}（HTTPS 443，Worker 代理）`);
  console.log(`  最低速度: ${MIN_SPEED_KBPS} KB/s`);
  console.log(`  测速时长: ${SPEED_TEST_SEC}s`);
  console.log(`  需求数量: ${needCount} 个达标 IP`);
  if (isBestMode) {
    console.log(`  最大测速数: ${MAX_SPEED_TEST_COUNT} 个（避免耗时过长）`);
  }
  console.log('');

  speedResults = []; // { ip, latency, speed_kbps }（达标）
  subparResults = []; // { ip, latency, colo, speed_kbps }（测速成功但未达标，供降级补充）
  const testedIps = new Set();

  // best 模式限制最大测速 IP 数，避免串行测速耗时过长
  const maxTestCount = isBestMode ? Math.min(ipPool.length, MAX_SPEED_TEST_COUNT) : ipPool.length;

  // fast 模式达标即停，best 模式测完上限数
  for (let i = 0; i < maxTestCount; i++) {
    const { ip, latency, colo } = ipPool[i];
    if (!isBestMode && speedResults.length >= needCount) break;

    const coloStr = colo ? `[${colo}] ` : '';
    const sampleStr = ipPool[i].samples && ipPool[i].samples.length > 1
      ? ` (${ipPool[i].samples.map(s => s === null ? '×' : s).join('/')})`
      : '';
    console.log(`  ▸ ${ip}（延迟 ${latency}ms${sampleStr}）${coloStr}测速...`);
    const result = await testDownloadSpeed(ip, SPEED_TEST_SEC, speedHost);
    testedIps.add(ip);

    if (result) {
      const mark = result.speed_kbps >= MIN_SPEED_KBPS ? '✓' : '✗';
      console.log(`    ${mark} ${result.speed_kbps} KB/s（${(result.downloaded / 1024).toFixed(0)} KB / ${result.duration_ms}ms）`);
      if (result.speed_kbps >= MIN_SPEED_KBPS) {
        speedResults.push({ ip, latency, colo, speed_kbps: result.speed_kbps });
      } else {
        subparResults.push({ ip, latency, colo, speed_kbps: result.speed_kbps });
      }
    } else {
      console.log(`    ✗ 测速失败`);
    }
  }

  console.log(`\n  测速结果: ${speedResults.length}/${needCount} 达标`);
  if (subparResults.length > 0) {
    console.log(`  降级候选: ${subparResults.length} 个（测速成功但未达标）`);
  }

  // 池内 IP 测完仍不足且开启 cfIpTop20 补充时才拉取
  if (speedResults.length < needCount && ENABLE_CF_TOP20) {
    console.log(`\n  ⚠ 池内达标 IP 不足，从 cfIpTop20 补充候选...`);
    try {
      const top20 = await sc.fetchCfTop20();
      for (const domain of top20) {
        if (!isBestMode && speedResults.length >= needCount) break;
        const ips = await sc.resolveIps(domain);
        for (const ip of ips) {
          if (!isBestMode && speedResults.length >= needCount) break;
          // 用 allSeenIps 去重（包含 buildIpPool 阶段已检测的所有 IP）
          if (testedIps.has(ip) || allSeenIps.has(ip) || sc.is1034Ip(ip)) continue;

          // 先快速验证 1034
          const check = await sc.testIp1034(ip, testHost);
          if (!check.ok) { testedIps.add(ip); continue; }
          const colo = check.colo || null;
          // colo 过滤
          if (COLO_FILTER.length > 0 && (!colo || !COLO_FILTER.includes(colo.toUpperCase()))) {
            console.log(`  ⊘ ${ip}（colo ${colo || 'N/A'} 不匹配，跳过）`);
            testedIps.add(ip);
            continue;
          }

          const { avgLatency, samples, successCount, totalCount } = await measureLatencyMulti(ip, LATENCY_SAMPLES);
          if (avgLatency === null) { testedIps.add(ip); continue; }
          // 丢包率过滤
          if (LATENCY_SAMPLES > 1) {
            const lossRate = 1 - successCount / totalCount;
            if (lossRate > MAX_PACKET_LOSS_RATE) {
              console.log(`  ⊘ ${ip}（丢包率 ${(lossRate * 100).toFixed(0)}% > ${(MAX_PACKET_LOSS_RATE * 100).toFixed(0)}%，跳过）`);
              testedIps.add(ip);
              continue;
            }
          }
          // 延迟过滤
          if (MAX_LATENCY_MS > 0 && avgLatency > MAX_LATENCY_MS) {
            console.log(`  ⊘ ${ip}（延迟 ${avgLatency}ms > ${MAX_LATENCY_MS}ms，跳过）`);
            testedIps.add(ip);
            continue;
          }

          const coloStr = colo ? `[${colo}] ` : '';
          const sampleStr = samples.length > 1
            ? ` (${samples.map(s => s === null ? '×' : s).join('/')})`
            : '';
          console.log(`  ▸ ${ip}（候选，延迟 ${avgLatency}ms${sampleStr}）${coloStr}测速...`);
          const result = await testDownloadSpeed(ip, SPEED_TEST_SEC, speedHost);
          testedIps.add(ip);

          if (result) {
            const mark = result.speed_kbps >= MIN_SPEED_KBPS ? '✓' : '✗';
            console.log(`    ${mark} ${result.speed_kbps} KB/s（${(result.downloaded / 1024).toFixed(0)} KB / ${result.duration_ms}ms）`);
            if (result.speed_kbps >= MIN_SPEED_KBPS) {
              speedResults.push({ ip, latency: avgLatency, colo, speed_kbps: result.speed_kbps });
            } else {
              subparResults.push({ ip, latency: avgLatency, colo, speed_kbps: result.speed_kbps });
            }
          } else {
            console.log(`    ✗ 测速失败`);
          }
        }
      }
      console.log(`  补充后: ${speedResults.length}/${needCount} 达标`);
    } catch (e) {
      console.log(`  cfIpTop20 拉取失败: ${e.message}，用现有达标 IP 继续`);
    }
  } else if (speedResults.length < needCount && !ENABLE_CF_TOP20) {
    console.log(`\n  ⚠ 池内达标 IP 不足（${speedResults.length}/${needCount}），cfIpTop20 补充未开启`);
  }

  } // end else (非 off 模式的测速逻辑)

  if (speedResults.length === 0) {
    // 0 个达标：降级补充候选，全部没有则跳过 CF A 记录同步但继续华为云
    if (subparResults.length > 0) {
      console.log(`\n  ⚠ 没有达标 IP，降级使用 ${subparResults.length} 个测速成功但未达标的 IP`);
      // 按速度降序排列，优先用较快的
      subparResults.sort((a, b) => b.speed_kbps - a.speed_kbps);
      speedResults = subparResults.splice(0, needCount);
    } else {
      console.log('\n  ⚠ 没有达标 IP 也没有降级候选，CF zone 保留现有 DNS 记录不变');
      console.log('  ⚠ 华为云三网分线路同步不受影响，继续执行\n');
    }
  }

  // best 模式：全部测完后按速度排序，选最快的 needCount 个
  if (isBestMode && speedResults.length > needCount) {
    speedResults.sort((a, b) => b.speed_kbps - a.speed_kbps);
    console.log(`\n  best 模式: ${speedResults.length} 个达标，选最快的 ${needCount} 个`);
    speedResults.length = needCount;
    // 重新按延迟排序（分配时优先低延迟）
    speedResults.sort((a, b) => a.latency - b.latency);
  }

  if (speedResults.length < needCount) {
    // 用降级候选补充不足的部分，避免跨 zone 复用同一 IP
    const shortage = needCount - speedResults.length;
    const subsAvailable = subparResults
      .filter(r => !speedResults.some(s => s.ip === r.ip))
      .sort((a, b) => b.speed_kbps - a.speed_kbps);
    if (subsAvailable.length > 0) {
      const fill = subsAvailable.slice(0, shortage);
      speedResults.push(...fill);
      console.log(`\n  ⚠ 达标 IP 不足，降级补充 ${fill.length} 个未达标但可用的 IP（速度 ${fill.map(r => r.speed_kbps).join('/')} KB/s）`);
    } else if (speedResults.length > 0) {
      console.log(`\n  ⚠ 仅 ${speedResults.length} 个 IP（已无降级候选），将跨 zone 复用`);
    }
  }

  // 测速结果一览
  console.log('\n  选中 IP:');
  for (const r of speedResults) {
    const coloStr = r.colo ? `[${r.colo}] ` : '';
    const speedStr = r.speed_kbps > 0 ? `${r.speed_kbps} KB/s  ` : '';
    console.log(`    ✓ ${r.ip.padEnd(18)} ${speedStr}(${r.latency}ms) ${coloStr}`);
  }

  // ═══════════════════════════════════════════════════
  // 第三步：同步 DNS（分配 + 写入 A 记录）
  // ═══════════════════════════════════════════════════

  console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  第三步：同步 DNS（分配 + 写入 A 记录）');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const finalPool = speedResults.map(r => ({ ip: r.ip, latency: r.latency, colo: r.colo || null, samples: r.samples || null, successCount: r.successCount || 0, totalCount: r.totalCount || 0 }));
  console.log('\n── Zone IP 分配 ──');
  const assignments = assignIpsToZones(filteredZones, finalPool, IP_PER_ZONE);
  printAssignmentPlan(assignments);

  // 华为云 zone 走三网分线路逻辑，CF zone 走原有逻辑
  const hwAssignments = assignments.filter(a => a.dnsProvider === 'huaweicloud');
  const cfAssignments = assignments.filter(a => a.dnsProvider !== 'huaweicloud');

  let syncStats = { created: 0, deleted: 0, skipped: 0, errors: 0 };

  if (hwAssignments.length > 0) {
    console.log('\n── 华为云 DNS 三网分线路同步 ──');
    const hwStats = await processHwIspRecords(hwAssignments, testHost);
    syncStats.created += hwStats.created;
    syncStats.deleted += hwStats.deleted;
    syncStats.skipped += hwStats.skipped;
    syncStats.errors += hwStats.errors;
  }

  if (cfAssignments.length > 0) {
    const cfStats = await processARecords(cfAssignments);
    syncStats.created += cfStats.created;
    syncStats.deleted += cfStats.deleted;
    syncStats.skipped += cfStats.skipped;
    syncStats.errors += cfStats.errors;
  }

  console.log('\n━━━ 同步汇总 ━━━');
  console.log(`  创建: ${syncStats.created}  删除: ${syncStats.deleted}  跳过: ${syncStats.skipped}  错误: ${syncStats.errors}`);

  // ═══════════════════════════════════════════════════
  // 第三步半：SSL 证书保底
  // proxied=false 的 A 记录不会触发 CF 签发 Universal SSL 证书，
  // 导致 TLS 握手被 RST。为缺证书的 Zone 创建 _ssl.{zone} A 记录
  // （proxied=true, 1.1.1.1）保底，CF 会持续签发和续签通配符证书。
  // ═══════════════════════════════════════════════════

  // 构建 FQDN 列表（连通性检测也需要，提前构建）
  const fqdnList = [];
  for (const zone of filteredZones) {
    for (const prefix of zone.names) {
      fqdnList.push({
        fqdn: `${prefix}.${zone.zoneName}`,
        zoneName: zone.zoneName,
        tokenKey: zone.tokenKey,
        dnsProvider: zone.dnsProvider || 'cloudflare',
        noPreferred: zone.noPreferred || false,
        origin: (zone.origins && zone.origins[prefix]) || null,
      });
    }
  }

  console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  SSL 证书保底（检测 + 自动创建 _ssl 记录）');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const missingZones = await ensureSslCerts(fqdnList);

  // ═══════════════════════════════════════════════════
  // 第四步：检验 DNS（连通性检测）
  // ═══════════════════════════════════════════════════

  console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  第四步：检验 DNS（连通性检测）');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  console.log(`  共 ${fqdnList.length} 个 FQDN\n`);

  // DNS 记录现状 + 收集 A 记录 IP（供连通性检测直连用）
  console.log('── DNS 记录现状 ──');
  const zoneGroups = {};
  for (const f of fqdnList) {
    if (!zoneGroups[f.zoneName]) {
      zoneGroups[f.zoneName] = { tokenKey: f.tokenKey, dnsProvider: f.dnsProvider || 'cloudflare', items: [] };
    }
    zoneGroups[f.zoneName].items.push(f);
  }

  for (const [zoneName, group] of Object.entries(zoneGroups)) {
    const dnsProvider = group.dnsProvider || 'cloudflare';
    const provTag = dnsProvider === 'huaweicloud' ? ' [华为云DNS]' : '';
    console.log(`\n  Zone: ${zoneName}${provTag}`);
    let zoneId;
    try {
      zoneId = await sc.getZoneId(zoneName, group.tokenKey, dnsProvider);
    } catch (e) {
      console.error(`    ✗ 获取 Zone ID 失败: ${e.message}`);
      continue;
    }

    if (dnsProvider === 'huaweicloud') {
      // 华为云 zone：通配符记录无法按具体 FQDN 查到，统一查 *.zone
      const wildcardName = `*.${zoneName}`;
      try {
        const wRecords = await sc.getDnsRecords(zoneId, wildcardName, group.tokenKey, dnsProvider);
        if (wRecords.length === 0) {
          console.log(`    ⚠ ${wildcardName}: 无 DNS 记录`);
        } else {
          for (const rec of wRecords) {
            const lineTag = rec.line && rec.line !== 'default_view' ? ` [${rec.line}]` : '';
            console.log(`    ${wildcardName}: ${rec.type} → ${rec.content}${lineTag}`);
          }
        }
      } catch (e) {
        console.error(`    ✗ ${wildcardName} 查询失败: ${e.message}`);
      }
      // 再显示显式 CNAME（answer 等直连子域名，覆盖通配符）
      for (const f of group.items) {
        if (!f.origin) continue; // 跳过通配符覆盖的子域名（已在上面显示）
        try {
          const records = await sc.getDnsRecords(zoneId, f.fqdn, group.tokenKey, dnsProvider);
          if (records.length === 0) {
            console.log(`    ⚠ ${f.fqdn}: 无 DNS 记录`);
          } else {
            for (const rec of records) {
              console.log(`    ${f.fqdn}: ${rec.type} → ${rec.content}`);
            }
          }
        } catch (e) {
          console.error(`    ✗ ${f.fqdn} 查询失败: ${e.message}`);
        }
      }
      continue;
    }

    // 默认 Cloudflare zone：逐 FQDN 查询
    for (const f of group.items) {
      try {
        const records = await sc.getDnsRecords(zoneId, f.fqdn, group.tokenKey, dnsProvider);
        if (records.length === 0) {
          console.log(`    ⚠ ${f.fqdn}: 无 DNS 记录`);
        } else {
          for (const rec of records) {
            console.log(`    ${f.fqdn}: ${rec.type} → ${rec.content}${rec.proxied ? ' (proxied)' : ''}`);
          }
          // 收集 proxied=false 的 A 记录 IP，供连通性检测直连
          const aIps = records
            .filter(r => r.type === 'A' && !r.proxied)
            .map(r => r.content);
          if (aIps.length > 0) f.aRecordIps = aIps;
        }
      } catch (e) {
        console.error(`    ✗ ${f.fqdn} 查询失败: ${e.message}`);
      }
    }
  }

  // 连通性检测
  console.log('\n── 连通性检测 ──');
  const checkResults = [];
  for (const f of fqdnList) {
    if (f.noPreferred && !f.origin) {
      console.log(`  ⊘ ${f.fqdn} — noPreferred 无 origin，跳过`);
      checkResults.push({ fqdn: f.fqdn, ok: null, reason: 'noPreferred' });
      continue;
    }

    // 华为云 zone：通配符记录无法按具体 FQDN 收集 IP，回退到系统 DNS 检测
    // CF zone：优先直连 A 记录 IP，避免系统 DNS 解析到不可控 IP
    const isHwZone = f.dnsProvider === 'huaweicloud';
    let checkIp = null;
    if (!isHwZone) {
      checkIp = f.aRecordIps && f.aRecordIps[0] ? f.aRecordIps[0] : null;
    }
    if (checkIp) {
      console.log(`  ▸ 检测 ${f.fqdn} (→ ${checkIp})...`);
    } else if (isHwZone) {
      console.log(`  ▸ 检测 ${f.fqdn} (系统 DNS，华为云通配符)...`);
    } else {
      console.log(`  ▸ 检测 ${f.fqdn} (系统 DNS)...`);
    }
    const r = await checkConnectivity(f.fqdn, checkIp);
    checkResults.push({ fqdn: f.fqdn, ...r });
    const mark = r.ok ? '✓' : '✗';
    console.log(`    ${mark} ${r.reason}`);
  }

  const connOk = checkResults.filter(r => r.ok === true).length;
  const connBad = checkResults.filter(r => r.ok === false).length;
  const connSkip = checkResults.filter(r => r.ok === null).length;
  console.log(`\n  连通性汇总: 正常 ${connOk}  异常 ${connBad}  跳过 ${connSkip}`);

  // ═══════════════════════════════════════════════════
  // 最终汇总
  // ═══════════════════════════════════════════════════

  console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  最终汇总');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  IP 池:   选中 ${speedResults.length}/${needCount}（去重后 ${ipPool.length} 个候选${isOffMode ? '，未测速' : ''}）`);
  console.log(`  DNS 同步: 创建 ${syncStats.created}  删除 ${syncStats.deleted}  跳过 ${syncStats.skipped}  错误 ${syncStats.errors}`);
  console.log(`  连通性:   正常 ${connOk}  异常 ${connBad}  跳过 ${connSkip}`);

  const hasError = syncStats.errors > 0 || connBad > 0;
  if (hasError) {
    if (connBad > 0) {
      console.log('\n  异常 FQDN:');
      for (const r of checkResults.filter(r => r.ok === false)) {
        console.log(`    ✗ ${r.fqdn}: ${r.reason}`);
      }
    }
  }

  // 清理 keep-alive 连接：Node.js https.globalAgent 默认 keepAlive=true，
  // cron 模式下进程不退出，空闲 socket 会一直挂着占用 fd 和 conntrack；
  // fetch() 内部也复用 globalAgent，必须显式销毁
  https.globalAgent.destroy();
  http.globalAgent.destroy();
  return hasError ? 1 : 0;
}

if (require.main === module) {
  main().then(exitCode => {
    if (exitCode) process.exit(exitCode);
  }).catch(e => {
    console.error('致命错误:', e.message);
    process.exit(1);
  });
}

// ── 导出 ──
module.exports = {
  measureLatency,
  measureLatencyMulti,
  ipPrefix,
  dedupIps,
  checkConnectivity,
  testDownloadSpeed,
};
