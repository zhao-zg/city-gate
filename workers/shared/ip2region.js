/**
 * ⚠ DEPRECATED — 本文件已废弃（2026-08-15）
 * 原因：Worker 重构为透明传输模式，不再使用 ip2region 查询。
 * 保留仅供历史参考。
 *
 * ip2region xdb 查询器 — Cloudflare Worker 适配版
 *
 * 从官方 ip2region JavaScript 绑定移植，移除所有 fs 依赖，
 * 只保留 newWithBuffer（纯内存查询）路径。
 *
 * xdb 数据从 KV 加载后存入全局变量，冷启动后首次读取约 10ms，
 * 后续所有查询均为纯内存操作，延迟 < 0.1ms。
 *
 * 格式（v3 xdb）：国家|省份/州|城市|运营商|国家代码
 * 例：  中国|浙江省|杭州市|电信|CN
 *
 * @see https://github.com/lionsoul2014/ip2region
 */

// ── 常量 ──────────────────────────────────────────────
const HeaderInfoLength = 256;
const VectorIndexRows  = 256;
const VectorIndexCols  = 256;
const VectorIndexSize  = 8;

// ── IP 解析 ──────────────────────────────────────────
function parseIPv4(ip) {
  const ps = ip.split('.', 4);
  if (ps.length !== 4) throw new Error(`invalid ipv4: ${ip}`);
  const buf = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const v = parseInt(ps[i], 10);
    if (isNaN(v) || v < 0 || v > 255) throw new Error(`invalid ipv4 part: ${ps[i]}`);
    buf[i] = v & 0xFF;
  }
  return buf;
}

function parseIPv6(ip) {
  const ps = ip.split(':', 8);
  if (ps.length < 3) throw new Error(`invalid ipv6: ${ip}`);
  const buf = new Uint8Array(16);
  let dc = 0, offset = 0;
  for (let i = 0; i < ps.length; i++) {
    let s = ps[i].trim();
    if (s.length === 0) {
      if (dc > 0) throw new Error('invalid ipv6: multiple double colon');
      dc = 1;
      let start = i, mi = ps.length - 1;
      for (i++;;) {
        s = ps[i]?.trim() || '';
        if (s.length > 0) { i--; break; }
        if (i >= mi) break;
        i++;
      }
      let padding = 8 - start - (mi - i);
      offset += 2 * padding;
      continue;
    }
    const v = parseInt(s, 16);
    if (isNaN(v) || v < 0 || v > 0xFFFF) throw new Error(`invalid ipv6 part: ${s}`);
    buf[offset++] = (v >> 8) & 0xFF;
    buf[offset++] = v & 0xFF;
  }
  return buf;
}

function parseIP(ip) {
  if (ip.includes('.')) return { bytes: parseIPv4(ip), version: 4 };
  if (ip.includes(':')) return { bytes: parseIPv6(ip), version: 6 };
  throw new Error(`invalid ip: ${ip}`);
}

// ── 查询器 ────────────────────────────────────────────
class Searcher {
  /**
   * @param {ArrayBuffer} xdbBuffer - 整个 xdb 文件的 ArrayBuffer
   */
  constructor(xdbBuffer) {
    this.buf = new Uint8Array(xdbBuffer);
    // 读取 header 判断 IP 版本
    const headerVer = this._readU16(0);
    const ipVersion = this._readU16(16);
    if (headerVer === 2) {
      this.version = 4;
      this.indexSize = 14; // 4+4+2+4
    } else if (headerVer === 3 && ipVersion === 4) {
      this.version = 4;
      this.indexSize = 14;
    } else if (headerVer === 3 && ipVersion === 6) {
      this.version = 6;
      this.indexSize = 38; // 16+16+2+4
    } else {
      throw new Error(`unsupported xdb structure: ${headerVer}, ipVersion: ${ipVersion}`);
    }
  }

  _readU32(offset) {
    return this.buf[offset]
      | (this.buf[offset + 1] << 8)
      | (this.buf[offset + 2] << 16)
      | (this.buf[offset + 3] << 24);
  }

  _readU16(offset) {
    return this.buf[offset] | (this.buf[offset + 1] << 8);
  }

  /**
   * 查询 IP 归属地
   * @param {string} ip - IPv4 或 IPv6 地址
   * @returns {string} - 格式（v3）：国家|省份|城市|运营商|国家代码
   */
  search(ip) {
    const { bytes, version } = parseIP(ip);
    if (version !== this.version) {
      throw new Error(`IP version mismatch: got v${version}, xdb is v${this.version}`);
    }

    // 通过 vector index 定位 segment index 区间
    const il0 = bytes[0], il1 = bytes[1];
    const idx = il0 * VectorIndexCols * VectorIndexSize + il1 * VectorIndexSize;
    let sPtr = this._readU32(HeaderInfoLength + idx);
    let ePtr = this._readU32(HeaderInfoLength + idx + 4);

    if (sPtr === 0 || ePtr === 0) return '';

    // 二分查找
    // index entry 结构: [start_ip][end_ip][data_len:2B][data_ptr:4B]
    const indexSize = this.indexSize;
    const bLen = bytes.length;
    const dOff = bLen * 2; // data 区域在 index entry 中的偏移
    let l = 0, h = Math.floor((ePtr - sPtr) / indexSize);
    let dLen = 0, dPtr = 0;

    while (l <= h) {
      const m = (l + h) >> 1;
      const p = sPtr + m * indexSize;

      const startCmp = this._compareIP(bytes, p, 0);
      if (startCmp < 0) {
        // input < start_ip → 往左
        h = m - 1;
      } else if (startCmp > 0) {
        // input > start_ip，还需检查 input <= end_ip
        const endCmp = this._compareIP(bytes, p, bLen);
        if (endCmp > 0) {
          // input > end_ip → 往右
          l = m + 1;
        } else {
          // start_ip <= input <= end_ip → 匹配成功
          dLen = this._readU16(p + dOff);
          dPtr = this._readU32(p + dOff + 2);
          break;
        }
      } else {
        // input == start_ip → 匹配成功
        dLen = this._readU16(p + dOff);
        dPtr = this._readU32(p + dOff + 2);
        break;
      }
    }

    if (dLen === 0) return '';

    // 读取 region 字符串（UTF-8 编码）
    const regionBuf = this.buf.slice(dPtr, dPtr + dLen);
    return new TextDecoder().decode(regionBuf);
  }

  /**
   * 比较 IP 与 xdb index entry 中的 IP
   * IPv4: index 中是 little-endian，需要反序比较
   * IPv6: 直接 big-endian 比较
   *
   * @param {Uint8Array} ipBytes - 输入 IP 的字节数组（big-endian）
   * @param {number} entryOffset - index entry 在 xdb 中的偏移
   * @param {number} ipOffset - IP 字段在 entry 中的偏移（0=start_ip, bytes=end_ip）
   * @returns {number} -1/0/1
   */
  _compareIP(ipBytes, entryOffset, ipOffset) {
    if (this.version === 4) {
      // IPv4 index entry: [start_ip LE 4B] [end_ip LE 4B] [data_len 2B] [data_ptr 4B]
      // 比较 IP 字段（little-endian 存储），反向读取
      for (let i = 0, j = ipOffset + 3; i < 4; i++, j--) {
        const a = ipBytes[i] & 0xFF;
        const b = this.buf[entryOffset + j] & 0xFF;
        if (a < b) return -1;
        if (a > b) return 1;
      }
      return 0;
    } else {
      // IPv6: big-endian 直接比较
      for (let i = 0; i < 16; i++) {
        const a = ipBytes[i] & 0xFF;
        const b = this.buf[entryOffset + ipOffset + i] & 0xFF;
        if (a < b) return -1;
        if (a > b) return 1;
      }
      return 0;
    }
  }
}

// ── 全局单例管理 ──────────────────────────────────────

let _searcherV4 = null;
let _searcherV6 = null;
let _loadingV4 = null;
let _loadingV6 = null;

/**
 * 初始化 ip2region 查询器（从 KV 加载 xdb 到内存）
 * 支持 v4 和 v6 双 xdb：v4 整体存储，v6 分片存储（因 36MB 超 KV 27MiB 限制）
 *
 * @param {KVNamespace} kv - Cloudflare KV 绑定
 * @param {Object} [opts]
 * @param {string} [opts.v4Key='ip2region_v4.xdb'] - v4 xdb 在 KV 中的 key
 * @param {string[]} [opts.v6Keys] - v6 xdb 分片 key 列表，如 ['ip2region_v6_part1', 'ip2region_v6_part2']
 * @param {boolean} [opts.loadV6=true] - 是否加载 v6 xdb（v6 不存在时静默跳过）
 */
export async function initIp2Region(kv, opts = {}) {
  const v4Key = opts.v4Key || 'ip2region_v4.xdb';
  const v6Keys = opts.v6Keys || ['ip2region_v6_part1', 'ip2region_v6_part2'];
  const loadV6 = opts.loadV6 !== false;

  // 加载 v4（必须）
  if (!_searcherV4 && !_loadingV4) {
    _loadingV4 = (async () => {
      const value = await kv.get(v4Key, 'arrayBuffer');
      if (!value) throw new Error(`ip2region v4 xdb not found in KV: ${v4Key}`);
      _searcherV4 = new Searcher(value);
      _loadingV4 = null;
      return _searcherV4;
    })();
  }

  // 加载 v6（可选，分片拼接）
  if (loadV6 && !_searcherV6 && !_loadingV6) {
    _loadingV6 = (async () => {
      try {
        const parts = await Promise.all(
          v6Keys.map(key => kv.get(key, 'arrayBuffer'))
        );
        // 任一分片缺失则跳过 v6
        if (parts.some(p => !p)) {
          console.warn('ip2region v6 xdb 分片不完整，跳过 v6 查询');
          _loadingV6 = null;
          return null;
        }
        // 拼接分片
        const totalLen = parts.reduce((sum, p) => sum + p.byteLength, 0);
        const combined = new Uint8Array(totalLen);
        let offset = 0;
        for (const part of parts) {
          combined.set(new Uint8Array(part), offset);
          offset += part.byteLength;
        }
        _searcherV6 = new Searcher(combined.buffer);
        _loadingV6 = null;
        console.log(`ip2region v6 xdb 加载成功 (${(totalLen / 1024 / 1024).toFixed(1)} MB)`);
        return _searcherV6;
      } catch (e) {
        console.warn(`ip2region v6 xdb 加载失败: ${e.message}`);
        _loadingV6 = null;
        return null;
      }
    })();
  }

  await _loadingV4;
  if (_loadingV6) await _loadingV6;
}

/**
 * 查询 IP 归属地（自动选择 v4/v6 Searcher）
 * @param {string} ip - IP 地址
 * @returns {string|null} - 格式（v3）：国家|省份|城市|运营商|国家代码，未初始化返回 null
 */
export function searchIp2Region(ip) {
  const isV6 = ip.includes(':');
  const searcher = isV6 ? _searcherV6 : _searcherV4;
  if (!searcher) return null;
  try {
    return searcher.search(ip);
  } catch {
    return null;
  }
}

/**
 * 解析 ip2region 返回的 region 字符串
 *
 * v2 格式：国家|区域|省份|城市|ISP
 * v3 格式：国家|省份/州|城市|运营商|国家代码
 *
 * @param {string} region - 如 "中国|浙江省|杭州市|电信|CN" 或 "Australia|Queensland|Brisbane|0|AU"
 * @returns {{country, province, city, isp}}
 */
export function parseRegionString(region) {
  if (!region) return { country: '', province: '', city: '', isp: '' };
  const parts = region.split('|');
  // v3 格式：国家|省份|城市|运营商|国家代码
  // v2 格式：国家|区域|省份|城市|ISP（5段时第4段是ISP）
  // 区分方法：v3 第5段是2字符国家代码；v2 第2段是"0"或区域名
  if (parts.length >= 5 && parts[4].length === 2) {
    // v3 格式
    return {
      country: parts[0] || '',
      province: parts[1] || '',
      city: parts[2] || '',
      isp: parts[3] || '',
    };
  }
  // v2 格式（兼容旧版）
  return {
    country: parts[0] || '',
    province: parts[2] || '',
    city: parts[3] || '',
    isp: parts[4] || '',
  };
}
