#!/usr/bin/env node
/**
 * 华为云 DNS API 客户端
 *
 * 用于替代 Cloudflare DNS 管理域名解析记录。
 * 架构不变：A 记录仍指向 CF Anycast 优选 IP，只是 DNS 记录托管在华为云。
 *
 * 认证方式：AK/SK 签名（SDK-HMAC-SHA256 算法）
 *   每次请求实时计算签名，无需缓存/刷新 Token，签名有效期约 15 分钟
 *
 * 华为云 DNS API 规范：
 *   Endpoint: https://dns.myhuaweicloud.com （公网 Zone 为全局资源）
 *   公网 Zone: GET /v2/zones?zone_type=public&name={zoneName}
 *   记录集(查询): GET /v2.1/zones/{zone_id}/recordsets?name={fqdn}  ← v2.1 返回 line 字段
 *   记录集(创建): POST /v2.1/zones/{zone_id}/recordsets              ← v2.1 支持 line 参数
 *   记录集(删除): DELETE /v2.1/zones/{zone_id}/recordsets/{recordset_id}  ← v2.1 可删除分线路记录
 *
 * v2 vs v2.1：
 *   v2  API 静默忽略 line 参数，所有记录都创建为 default_view
 *   v2.1 API 支持 line 字段，可创建分线路记录（Dianxin/Liantong/Yidong）
 *   查询也需用 v2.1 才能获取 line 信息（v2 查询不返回 line 字段）
 *   删除记录用 v2.1：v2.1 创建的分线路记录只能通过 v2.1 删除，
 *   v2 DELETE 会返回 "This record set does not exist"
 *
 * 华为云 DNS 记录集与 CF DNS 记录的差异：
 *   - CF: 一条 A 记录对应一个 IP（多 IP = 多条 A 记录）
 *   - 华为云: 一条 recordset 的 records 字段是数组，可包含多个 IP
 *   - 华为云 recordset name 使用完整 FQDN（如 sg.example.com.）
 *   - 华为云 TTL 默认 300s，最短 1s（需开通 premium 才支持低 TTL）
 *
 * 环境变量：
 *   HUAWEICLOUD_DNS_AK       — Access Key Id
 *   HUAWEICLOUD_DNS_SK       — Secret Access Key
 *   HUAWEICLOUD_DNS_ENDPOINT — DNS Endpoint（可选，默认 https://dns.myhuaweicloud.com）
 */

const crypto = require('crypto');

// ── 配置 ─────────────────────────────────────────────

// AK/SK 在签名时实时从 process.env 读取（模块加载和调用可能跨进程环境）
const HW_DNS_ENDPOINT = process.env.HUAWEICLOUD_DNS_ENDPOINT || 'https://dns.myhuaweicloud.com';

// 从 endpoint 提取 host
const HW_DNS_HOST = (() => {
  try {
    return new URL(HW_DNS_ENDPOINT).host;
  } catch {
    return 'dns.myhuaweicloud.com';
  }
})();

// ── 签名工具函数 ─────────────────────────────────────

/**
 * SHA-256 哈希，返回小写十六进制字符串
 */
function sha256Hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * HMAC-SHA256，返回小写十六进制字符串
 */
function hmacSha256Hex(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest('hex');
}

/**
 * RFC 3986 安全的 URI 编码
 */
function uriEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

/**
 * 规范化 API 路径
 *
 * 华为云服务端会对 collection 端点自动添加尾部斜杠（如 /v2/zones → /v2/zones/、
 * /v2.1/zones/{id}/recordsets → /v2.1/zones/{id}/recordsets/），
 * 签名时必须使用与服务端一致的路径，否则签名验证失败。
 *
 * 判断规则：末尾段为 UUID（resource ID）时不加斜杠，其余 collection 端点加斜杠。
 */
function normalizePath(path) {
  const uri = path.split('?')[0];
  const segments = uri.split('/').filter(Boolean);
  const lastSegment = segments[segments.length - 1] || '';
  // 华为云服务端会对 collection 端点自动添加尾部斜杠做签名规范化。
  // 末尾段为 resource ID（标准 UUID）时不加斜杠，其余 collection 端点加斜杠。
  // 注意：华为云 recordset/zone ID 虽为 32 位无连字符 hex，但服务端仍会对其加斜杠，
  // 所以这里只检查标准 UUID 格式，不做 32 位 hex 判断。
  const isResourceId =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lastSegment);
  if (!isResourceId && !uri.endsWith('/')) {
    return uri + '/';
  }
  return uri;
}

/**
 * 构造规范查询字符串（CanonicalQueryString）
 * 按参数名字典序排序，key=value 格式，用 & 连接
 */
function buildCanonicalQueryString(queryParams) {
  if (!queryParams || Object.keys(queryParams).length === 0) {
    return '';
  }

  const sorted = Object.keys(queryParams).sort();
  const parts = sorted.map((key) => {
    const value = queryParams[key];
    const encodedKey = uriEncode(key);
    // 有值 → key=value，无值 → key
    return value !== undefined && value !== null
      ? `${encodedKey}=${uriEncode(String(value))}`
      : encodedKey;
  });

  return parts.join('&');
}

/**
 * 构造规范请求头（CanonicalHeaders）和签名头列表（SignedHeaders）
 * CanonicalHeaders 格式: "key:value\n" 每行一个，按 key 字典序
 * SignedHeaders 格式: "key1;key2;key3" 按字典序
 */
function buildCanonicalHeaders(headers) {
  // 所有 key 转小写，去除值首尾空白
  const normalized = Object.entries(headers).map(([k, v]) => [
    k.toLowerCase().trim(),
    String(v).trim(),
  ]);

  // 按 key 字典序排序
  normalized.sort((a, b) => a[0].localeCompare(b[0]));

  const canonicalHeaders = normalized
    .map(([k, v]) => `${k}:${v}\n`)
    .join('');

  const signedHeaders = normalized.map(([k]) => k).join(';');

  return { canonicalHeaders, signedHeaders };
}

/**
 * 构造 Authorization 头并返回所有需要发送的请求头
 *
 * 签名步骤:
 *   1. 构造 CanonicalRequest
 *   2. 构造 StringToSign
 *   3. 计算 Signature = HexEncode(HMAC-SHA256(SK, StringToSign))
 *   4. 组装 Authorization 头
 */
function signRequest(method, path, queryParams, body, extraHeaders) {
  const hwAk = process.env.HUAWEICLOUD_DNS_AK || '';
  const hwSk = process.env.HUAWEICLOUD_DNS_SK || '';
  if (!hwAk || !hwSk) {
    throw new Error(
      '华为云 DNS 环境变量未设置: 需要 HUAWEICLOUD_DNS_AK 和 HUAWEICLOUD_DNS_SK'
    );
  }

  // X-Sdk-Date 格式: yyyyMMddTHHmmssZ (UTC)
  const now = new Date();
  const timestamp = formatSdkDate(now);

  // 构造需要签名的请求头
  const signHeaders = {
    host: HW_DNS_HOST,
    'x-sdk-date': timestamp,
    ...extraHeaders,
  };

  // 构造规范请求头和签名头列表
  const { canonicalHeaders, signedHeaders } = buildCanonicalHeaders(signHeaders);

  // 构造规范查询字符串
  const canonicalQueryString = buildCanonicalQueryString(queryParams);

  // 构造规范 URI（路径部分，以 / 开头）
  // 华为云服务端会对 collection 端点自动添加尾部斜杠，签名必须使用规范化后的路径
  const canonicalUri = normalizePath(path);

  // 请求体哈希（GET/DELETE 无 body，body 为空字符串）
  const payload = body || '';
  const payloadHash = sha256Hex(payload);

  // 步骤 1: 构造 CanonicalRequest
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  // 步骤 2: 构造 StringToSign
  const hashedCanonicalRequest = sha256Hex(canonicalRequest);
  const stringToSign = [
    'SDK-HMAC-SHA256',
    timestamp,
    hashedCanonicalRequest,
  ].join('\n');

  // 步骤 3: 计算签名
  const signature = hmacSha256Hex(hwSk, stringToSign);

  // 步骤 4: 组装 Authorization 头
  const authorization = `SDK-HMAC-SHA256 Access=${hwAk}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  // 返回所有需要发送的请求头（签名用的 + Authorization）
  return {
    ...signHeaders,
    authorization,
  };
}

/**
 * 格式化 X-Sdk-Date: yyyyMMddTHHmmssZ (UTC)
 */
function formatSdkDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = date.getUTCFullYear();
  const MM = pad(date.getUTCMonth() + 1);
  const dd = pad(date.getUTCDate());
  const HH = pad(date.getUTCHours());
  const mm = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  return `${yyyy}${MM}${dd}T${HH}${mm}${ss}Z`;
}

// ── HTTP 请求封装 ─────────────────────────────────────

/**
 * 华为云 DNS API 请求封装
 *
 * @param {string} method - HTTP 方法 (GET/POST/DELETE)
 * @param {string} path - API 路径 (如 /v2/zones, /v2.1/zones/{id}/recordsets)
 * @param {object} queryParams - 查询参数 {key: value}
 * @param {string|null} body - 请求体 (POST 时使用)
 * @returns {Promise<object|null>} - 响应 JSON 或 null (204)
 */
async function hwDnsRequest(method, path, queryParams = {}, body = null) {
  // 构造完整 URL（用于 fetch），使用原始路径
  // 注意：签名时使用 normalizePath 规范化后的路径（华为云签名验证期望带尾部斜杠），
  // 但实际 API 路由期望原始路径（不带尾部斜杠），两者必须区分
  const queryString = buildCanonicalQueryString(queryParams);
  const fullPath = queryString ? `${path}?${queryString}` : path;
  const url = `${HW_DNS_ENDPOINT}${fullPath}`;

  // 签名需要额外的请求头
  const extraHeaders = {};
  if (body) {
    extraHeaders['content-type'] = 'application/json';
  }

  // 构造签名头（签名内部也会使用 normalizePath 规范化路径）
  const signedHeaders = signRequest(method, path, queryParams, body, extraHeaders);

  // 构造 fetch 请求头（签名头 + body 相关头）
  const fetchHeaders = {
    host: HW_DNS_HOST,
    'x-sdk-date': signedHeaders['x-sdk-date'],
    authorization: signedHeaders.authorization,
  };
  if (body) {
    fetchHeaders['content-type'] = 'application/json';
  }

  const res = await fetchWithRetry(url, {
    method: method.toUpperCase(),
    headers: fetchHeaders,
    body: body || undefined,
  });

  return handleResponse(res, path);
}

/**
 * 带重试的 fetch 封装
 *
 * NAS 环境下本地 DNS (OpenClash/dnsmasq) 偶尔返回 EAI_AGAIN，
 * 导致 fetch 的 DNS 解析间歇性失败。增加自动重试机制。
 */
async function fetchWithRetry(url, options, maxRetries = 3) {
  let lastErr;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      lastErr = err;
      // DNS 解析失败（EAI_AGAIN）或网络瞬时错误，等待后重试
      if (err.cause && (err.cause.code === 'EAI_AGAIN' || err.cause.code === 'ENOTFOUND')) {
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        continue;
      }
      // 其他错误也重试一次（fetch failed 可能是网络瞬时问题）
      if (i < maxRetries - 1 && err.message && err.message.includes('fetch failed')) {
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function handleResponse(res, path) {
  if (res.status === 204) {
    return null; // DELETE 成功无响应体
  }

  const text = await res.text();
  if (!text) return null;

  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error(`华为云 DNS API 解析失败: HTTP ${res.status} — ${text.slice(0, 500)}`);
  }

  if (res.status >= 400) {
    const err =
      json.error_msg ||
      json.message ||
      json.error?.message ||
      `HTTP ${res.status}`;
    throw new Error(`华为云 DNS API 错误 (${path}): ${err}`);
  }

  return json;
}

// ── Zone 操作 ────────────────────────────────────────

/**
 * 查询公网 Zone ID
 * GET /v2/zones?zone_type=public&name={zoneName}
 */
async function getZoneId(zoneName) {
  const zone = await getZoneInfo(zoneName);
  return zone.id;
}

/**
 * 查询公网 Zone 完整信息（含 NS 列表）
 * GET /v2/zones?zone_type=public&name={zoneName}
 *
 * 返回: { id, name, zone_type, status, ns: [...], pool_id, record_num, ... }
 */
async function getZoneInfo(zoneName) {
  const queryParams = {
    zone_type: 'public',
    name: zoneName + '.',
  };
  const json = await hwDnsRequest('GET', '/v2/zones', queryParams);
  const zones = json.zones || [];
  if (zones.length === 0) {
    throw new Error(`华为云公网 Zone "${zoneName}" 未找到，请在华为云控制台创建公网域名`);
  }
  return zones[0];
}

// ── 记录集操作 ───────────────────────────────────────

/**
 * 查询指定 FQDN 的记录集
 * GET /v2.1/zones/{zone_id}/recordsets?name={fqdn}
 *
 * 使用 v2.1 端点以获取 line 字段（分线路信息）。
 * v2 端点不返回 line 字段，导致分线路记录被误判为 default_view。
 * v2.1 查询失败时自动降级到 v2（全部视为 default_view）。
 *
 * 返回统一格式，与 CF getDnsRecords 兼容：
 *   [{ id, type, name, content, records, ttl, proxied: false, line }]
 * 华为云 records 是数组（多值），content 用逗号连接以兼容 CF 的"一条一 IP"模型
 * line 字段标明线路（default_view / Dianxin / Liantong / Yidong），无分线路时为 'default_view'
 */
async function getDnsRecords(zoneId, fqdn) {
  const queryParams = {
    name: fqdn + '.',
  };
  let json;
  try {
    json = await hwDnsRequest('GET', `/v2.1/zones/${zoneId}/recordsets`, queryParams);
  } catch (e) {
    // v2.1 查询失败 → 回退到 v2（无 line 信息，全部视为 default_view）
    json = await hwDnsRequest('GET', `/v2/zones/${zoneId}/recordsets`, queryParams);
  }
  const recordsets = json.recordsets || [];

  // 转换为 CF 兼容格式
  return recordsets.map((rs) => ({
    id: rs.id,
    type: rs.type,
    name: rs.name.replace(/\.$$/, ''), // 去掉尾部点号
    // 华为云 records 是数组，A 记录可能含多个 IP
    // 转为 CF 格式：一条记录一个 content（多 IP 时用逗号连接）
    content: rs.records.join(','),
    records: rs.records,
    ttl: rs.ttl,
    proxied: false, // 华为云无 proxied 概念
    line: rs.line || 'default_view',
  }));
}

/**
 * 创建 A 记录（支持分线路 + 多 IP）
 *
 * 有分线路时：POST /v2.1/zones/{zone_id}/recordsets（支持 line 字段）
 * 无分线路时：POST /v2/zones/{zone_id}/recordsets（默认线路）
 *
 * v2 API 静默忽略 line 参数，所有记录都创建为 default_view。
 * v2.1 API 支持 line 字段，可创建分线路记录。
 * 分线路创建失败时（如 NS 未切换到华为云），自动降级为 v2 默认线路重试。
 *
 * 参数：
 *   zoneId — Zone ID
 *   name   — 记录名（如 '*.zzgxxx.eu.org' 或 'sg.zzgxxx.eu.org'）
 *   ips    — IP 数组（一条 recordset 可含多个 IP）
 *   line   — 线路（可选）：'default_view' / 'Dianxin' / 'Liantong' / 'Yidong'
 *            不传或 'default_view' = 默认线路
 *   ttl    — TTL 秒数（可选，默认 300）
 *
 * 华为云 API 文档：CreateRecordSetWithLine
 *   请求体中 line 字段指定线路，records 是数组可含多个 IP
 *   通配符泛解析：name 使用 '*' 即可（如 '*.example.com.'）
 */
async function createARecord(zoneId, name, ips, options = {}) {
  const { line, ttl = 300 } = options;
  const ipArray = Array.isArray(ips) ? ips : [ips];
  const bodyObj = {
    name: name + '.', // 华为云要求完整 FQDN 带尾部点号
    type: 'A',
    ttl,
    records: ipArray,
  };
  // 仅当指定了非默认线路时才传 line 字段
  const hasLine = line && line !== 'default_view';
  if (hasLine) {
    bodyObj.line = line;
  }
  const body = JSON.stringify(bodyObj);

  // 有分线路时用 v2.1（支持 line），否则用 v2
  const apiPath = hasLine
    ? `/v2.1/zones/${zoneId}/recordsets`
    : `/v2/zones/${zoneId}/recordsets`;

  try {
    await hwDnsRequest('POST', apiPath, {}, body);
  } catch (err) {
    // 分线路创建失败（如 NS 未切换到华为云、Zone 不支持该线路），
    // 自动降级为 v2 默认线路重试
    // "already exists" 不降级（由 sync-dns.js 处理合并模式）
    if (hasLine && !(err.message && err.message.includes('already exists'))) {
      const fallbackBody = JSON.stringify({
        name: name + '.',
        type: 'A',
        ttl,
        records: ipArray,
        // 不传 line 字段 = 默认线路
      });
      await hwDnsRequest('POST', `/v2/zones/${zoneId}/recordsets`, {}, fallbackBody);
    } else {
      throw err;
    }
  }
}

/**
 * 创建 CNAME 记录（支持分线路）
 * 有分线路时用 v2.1 端点，否则用 v2
 * 参数 options.line 可选，指定线路
 */
async function createCnameRecord(zoneId, name, target, options = {}) {
  const { line } = options;
  const bodyObj = {
    name: name + '.',
    type: 'CNAME',
    ttl: 300,
    records: [target.endsWith('.') ? target : target + '.'],
  };
  const hasLine = line && line !== 'default_view';
  if (hasLine) {
    bodyObj.line = line;
  }
  const body = JSON.stringify(bodyObj);
  const apiPath = hasLine
    ? `/v2.1/zones/${zoneId}/recordsets`
    : `/v2/zones/${zoneId}/recordsets`;
  await hwDnsRequest('POST', apiPath, {}, body);
}

/**
 * 删除记录集
 * DELETE /v2.1/zones/{zone_id}/recordsets/{recordset_id}
 *
 * 使用 v2.1 端点：v2.1 创建的分线路记录（带 line 参数）只能通过 v2.1 删除，
 * v2 DELETE 会返回 "This record set does not exist"。
 */
async function deleteDnsRecord(zoneId, recordId) {
  await hwDnsRequest('DELETE', `/v2.1/zones/${zoneId}/recordsets/${recordId}`);
}

// ── 导出 ─────────────────────────────────────────────

module.exports = {
  getZoneId,
  getZoneInfo,
  getDnsRecords,
  createARecord,
  createCnameRecord,
  deleteDnsRecord,
};
