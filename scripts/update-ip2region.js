#!/usr/bin/env node
/**
 * ⚠ DEPRECATED — 本脚本已废弃（2026-08-15）
 * 原因：Worker 重构为透明传输模式，不再使用 KV / ip2region / 城市限制。
 * 保留仅供历史参考，如需恢复请先恢复 wrangler.toml 中的 KV 绑定和 cities 配置。
 *
 * ip2region xdb 更新脚本
 *
 * 从 ip2region GitHub Release 下载最新 v4 和 v6 xdb 文件，上传到 Cloudflare KV。
 * v4 xdb 整体上传；v6 xdb 因 36MB 超 KV 27MiB 限制，自动分片上传。
 *
 * 分片策略：将 v6 xdb 拆成 2 个 ~18MB 的 KV key：
 *   - ip2region_v6_part1
 *   - ip2region_v6_part2
 *
 * 自动 KV namespace 管理：
 *   - 如果未指定 KV_NAMESPACE_ID，脚本会通过 Cloudflare API 查找或创建
 *     名为 "city-gate-IP2REGION" 的 KV namespace
 *   - 创建后自动将 namespace id 写回 wrangler.toml
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN  - Cloudflare API Token（需 Account:Edit + KV:Edit 权限）
 *   CLOUDFLARE_ACCOUNT_ID - Cloudflare 账户 ID
 *   KV_NAMESPACE_ID       - (可选) KV namespace ID，不提供则自动查找/创建
 *   IP2REGION_VERSION     - (可选) 指定版本号，默认取最新 release
 *   WRANGLER_TOML_PATH    - (可选) wrangler.toml 路径，默认 workers/city-gate/wrangler.toml
 *   SKIP_V6              - (可选) 设为 1 跳过 v6 xdb 下载和上传
 *
 * 用法：
 *   node scripts/update-ip2region.js
 *   KV_NAMESPACE_ID=xxx node scripts/update-ip2region.js
 *   IP2REGION_VERSION=3.5.1 node scripts/update-ip2region.js
 */

const path = require('path');
const fs = require('fs');

const V4_KEY = 'ip2region_v4.xdb';
const V6_KEYS = ['ip2region_v6_part1', 'ip2region_v6_part2'];
const VERSION_KEY = 'ip2region_version';
const GITHUB_OWNER = 'lionsoul2014';
const GITHUB_REPO = 'ip2region';
const KV_NAMESPACE_TITLE = process.env.KV_NAMESPACE_TITLE || 'city-gate-IP2REGION';
const KV_PLACEHOLDER = 'PLACEHOLDER_KV_IP2REGION_NAMESPACE_ID';

// KV 单 value 最大 25MiB（留 2MiB 余量，官方限制 27MiB）
const KV_MAX_PART_SIZE = 25 * 1024 * 1024;

// ── 工具函数 ──────────────────────────────────────────

function cfApi(pathSuffix, options = {}) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  return fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${pathSuffix}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
}

async function jsonFetch(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json();
}

// ── KV namespace 管理 ──────────────────────────────────

/**
 * 查找已存在的 KV namespace（按 title 匹配）
 */
async function findKvNamespace() {
  const res = await cfApi('/storage/kv/namespaces');
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`列出 KV namespace 失败: HTTP ${res.status} ${err}`);
  }
  const data = await res.json();
  if (!data.success) {
    throw new Error(`列出 KV namespace 失败: ${JSON.stringify(data.errors)}`);
  }
  const found = data.result.find(ns => ns.title === KV_NAMESPACE_TITLE);
  return found ? found.id : null;
}

/**
 * 创建新的 KV namespace
 */
async function createKvNamespace() {
  console.log(`创建 KV namespace "${KV_NAMESPACE_TITLE}"...`);
  const res = await cfApi('/storage/kv/namespaces', {
    method: 'POST',
    body: JSON.stringify({ title: KV_NAMESPACE_TITLE }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`创建 KV namespace 失败: HTTP ${res.status} ${err}`);
  }
  const data = await res.json();
  if (!data.success) {
    throw new Error(`创建 KV namespace 失败: ${JSON.stringify(data.errors)}`);
  }
  console.log(`创建成功: id=${data.result.id}`);
  return data.result.id;
}

/**
 * 确保 KV namespace 存在，返回 namespace id
 * 优先使用环境变量指定的 id，否则查找/创建
 */
async function ensureKvNamespace() {
  // 1. 环境变量直接指定
  if (process.env.KV_NAMESPACE_ID) {
    console.log(`使用环境变量指定的 KV namespace: ${process.env.KV_NAMESPACE_ID}`);
    return process.env.KV_NAMESPACE_ID;
  }

  // 2. 查找已存在的
  console.log(`查找 KV namespace "${KV_NAMESPACE_TITLE}"...`);
  const existingId = await findKvNamespace();
  if (existingId) {
    console.log(`找到已存在的 KV namespace: id=${existingId}`);
    return existingId;
  }

  // 3. 创建新的
  return await createKvNamespace();
}

/**
 * 将 KV namespace id 写入 wrangler.toml
 * 替换占位符或已有的 id
 */
function writeKvIdToWranglerToml(namespaceId) {
  const tomlPath = process.env.WRANGLER_TOML_PATH
    || path.resolve(__dirname, '..', 'workers', 'city-gate', 'wrangler.toml');

  if (!fs.existsSync(tomlPath)) {
    console.warn(`wrangler.toml 不存在: ${tomlPath}，跳过写入`);
    return false;
  }

  const content = fs.readFileSync(tomlPath, 'utf-8');

  // 替换占位符或已存在的 id（id 行在 binding = "IP2REGION" 下方）
  const newContent = content.replace(
    /(binding\s*=\s*"IP2REGION"\s*\n\s*id\s*=\s*)"[^"]*"/,
    `$1"${namespaceId}"`
  );

  if (newContent === content) {
    console.warn('wrangler.toml 中未找到 IP2REGION 绑定行，跳过写入');
    return false;
  }

  fs.writeFileSync(tomlPath, newContent, 'utf-8');
  console.log(`已将 KV namespace id 写入 wrangler.toml: ${namespaceId}`);
  return true;
}

// ── GitHub Release ──────────────────────────────────

async function getLatestRelease() {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
  const data = await jsonFetch(url, {
    'User-Agent': 'city-gate-update-script',
    'Accept': 'application/vnd.github+json',
  });
  return {
    tag: data.tag_name,
    assets: data.assets || [],
  };
}

function findXdbAsset(assets, pattern) {
  for (const p of pattern) {
    const found = assets.find(a => p.test(a.name) && a.name.endsWith('.xdb'));
    if (found) return found;
  }
  return null;
}

async function downloadXdb(downloadUrl, label) {
  console.log(`  下载 ${label}: ${downloadUrl}`);
  const res = await fetch(downloadUrl, {
    headers: { 'User-Agent': 'city-gate-update-script' },
  });
  if (!res.ok) throw new Error(`下载 ${label} 失败: HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();
  console.log(`  ${label} 大小: ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB`);
  return buffer;
}

// ── KV 读写 ──────────────────────────────────────────

async function getKvValue(namespaceId, key) {
  const res = await cfApi(`/storage/kv/namespaces/${namespaceId}/values/${key}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KV 读取失败: HTTP ${res.status}`);
  return res.text();
}

/**
 * 检查 KV key 是否存在（只检查 status code，不读取完整内容）
 * Cloudflare KV 不支持 HEAD，用 GET + Range 头限制只读 1 字节
 */
async function kvKeyExists(namespaceId, key) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${key}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Range': 'bytes=0-0', // 只读 1 字节
    },
  });
  if (res.status === 404) return false;
  if (res.ok || res.status === 206) return true;
  // Range 不支持时完整返回也算存在
  if (res.status === 200) return true;
  throw new Error(`KV 存在性检查失败: HTTP ${res.status} key=${key}`);
}

async function putKvValue(namespaceId, key, value, metadata = {}) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${key}`;

  // 对于二进制大文件（如 xdb），直接用 PUT body 传输，避免 FormData base64 膨胀
  if (value instanceof Uint8Array) {
    const metaParam = Object.keys(metadata).length > 0
      ? `&metadata=${encodeURIComponent(JSON.stringify(metadata))}`
      : '';
    const res = await fetch(`${baseUrl}?${metaParam}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: value,
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`KV 写入 ${key} 失败: HTTP ${res.status} ${err}`);
    }
    console.log(`  KV 写入成功: ${key} (${(value.byteLength / 1024 / 1024).toFixed(1)} MB)`);
    return;
  }

  // 小文本值用 FormData
  const formData = new FormData();
  formData.append('value', value);
  formData.append('metadata', JSON.stringify(metadata));

  const res = await fetch(baseUrl, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}` },
    body: formData,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`KV 写入 ${key} 失败: HTTP ${res.status} ${err}`);
  }
}

/**
 * 将大 ArrayBuffer 分片上传到 KV
 * @param {string} namespaceId
 * @param {string[]} keys - 分片 KV key 列表
 * @param {ArrayBuffer} buffer - 完整 xdb 数据
 */
async function putShardedXdb(namespaceId, keys, buffer) {
  const totalSize = buffer.byteLength;
  const partSize = Math.ceil(totalSize / keys.length);

  // 确保每个分片不超过 KV 限制
  if (partSize > KV_MAX_PART_SIZE) {
    // 需要更多分片
    const neededParts = Math.ceil(totalSize / KV_MAX_PART_SIZE);
    throw new Error(
      `v6 xdb (${(totalSize / 1024 / 1024).toFixed(1)} MB) 需要至少 ${neededParts} 个分片，` +
      `但只提供了 ${keys.length} 个 key。请增加 V6_KEYS 数量。`
    );
  }

  const data = new Uint8Array(buffer);
  for (let i = 0; i < keys.length; i++) {
    const start = i * partSize;
    const end = Math.min(start + partSize, totalSize);
    const chunk = data.slice(start, end);
    console.log(`  分片 ${i + 1}/${keys.length}: ${keys[i]} (${(chunk.byteLength / 1024 / 1024).toFixed(1)} MB)`);
    await putKvValue(namespaceId, keys[i], chunk, {
      part: i + 1,
      total_parts: keys.length,
      total_size: totalSize,
    });
  }
}

// ── 主流程 ────────────────────────────────────────────

async function main() {
  // 必需环境变量
  const requiredEnvs = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'];
  for (const env of requiredEnvs) {
    if (!process.env[env]) {
      console.error(`缺少环境变量: ${env}`);
      process.exit(1);
    }
  }

  const skipV6 = process.env.SKIP_V6 === '1';

  // 1. 确保 KV namespace 存在
  const namespaceId = await ensureKvNamespace();

  // 2. 如果是通过环境变量指定的 id，检查 wrangler.toml 是否需要更新
  const tomlPath = process.env.WRANGLER_TOML_PATH
    || path.resolve(__dirname, '..', 'workers', 'city-gate', 'wrangler.toml');
  if (fs.existsSync(tomlPath)) {
    const tomlContent = fs.readFileSync(tomlPath, 'utf-8');
    const idMatch = tomlContent.match(/binding\s*=\s*"IP2REGION"\s*\n\s*id\s*=\s*"([^"]*)"/);
    const currentTomlId = idMatch ? idMatch[1] : null;

    if (currentTomlId !== namespaceId) {
      writeKvIdToWranglerToml(namespaceId);
    } else {
      console.log('wrangler.toml 中 KV namespace id 已是最新，无需更新');
    }
  }

  const specifiedVersion = process.env.IP2REGION_VERSION;

  // 3. 获取最新版本
  let releaseTag, v4Url, v6Url;

  if (specifiedVersion) {
    releaseTag = specifiedVersion.startsWith('v') ? specifiedVersion : `v${specifiedVersion}`;
    v4Url = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/raw/${releaseTag}/data/ip2region_v4.xdb`;
    v6Url = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/raw/${releaseTag}/data/ip2region_v6.xdb`;
    console.log(`指定版本: ${releaseTag}`);
  } else {
    console.log('检查 ip2region 最新版本...');
    const release = await getLatestRelease();
    releaseTag = release.tag;

    // v4 xdb
    const v4Asset = findXdbAsset(release.assets, [/ip2region\.xdb/, /ip2region_v4\.xdb/, /ipv4.*\.xdb/]);
    v4Url = v4Asset
      ? v4Asset.browser_download_url
      : `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/raw/${releaseTag}/data/ip2region_v4.xdb`;

    // v6 xdb
    const v6Asset = findXdbAsset(release.assets, [/ip2region_v6\.xdb/, /ipv6.*\.xdb/]);
    v6Url = v6Asset
      ? v6Asset.browser_download_url
      : `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/raw/${releaseTag}/data/ip2region_v6.xdb`;

    console.log(`最新版本: ${releaseTag}`);
  }

  // 4. 检查 KV 中各 xdb 是否已上传（版本号一致不代表分片存在，需分别检查）
  const currentVersion = await getKvValue(namespaceId, VERSION_KEY);
  const needV4 = !(await kvKeyExists(namespaceId, V4_KEY));
  let needV6 = false;
  if (!skipV6) {
    // 任一 v6 分片缺失就需要重新上传
    for (const key of V6_KEYS) {
      if (!(await kvKeyExists(namespaceId, key))) {
        needV6 = true;
        break;
      }
    }
  }

  if (!needV4 && !needV6 && currentVersion === releaseTag) {
    console.log(`KV 中已是最新版本 ${releaseTag}，v4/v6 均已存在，跳过更新`);
    return;
  }
  console.log(`KV 当前版本: ${currentVersion || '无'}，目标: ${releaseTag}`);
  console.log(`  v4: ${needV4 ? '需要上传' : '已存在（跳过）'}`);
  console.log(`  v6: ${skipV6 ? '跳过（SKIP_V6=1）' : needV6 ? '需要上传' : '已存在（跳过）'}`);

  // 5. 下载并上传 v4 xdb
  if (needV4) {
    console.log('\n── IPv4 xdb ──');
    const v4Buffer = await downloadXdb(v4Url, 'v4');
    console.log('上传 v4 xdb 到 KV...');
    await putKvValue(namespaceId, V4_KEY, new Uint8Array(v4Buffer), {
      version: releaseTag,
      updated_at: new Date().toISOString(),
    });
  } else {
    console.log('\n── IPv4 xdb: 已存在，跳过 ──');
  }

  // 6. 下载并分片上传 v6 xdb
  if (skipV6) {
    console.log('\n── IPv6 xdb: 跳过（SKIP_V6=1）──');
  } else if (needV6) {
    console.log('\n── IPv6 xdb ──');
    try {
      const v6Buffer = await downloadXdb(v6Url, 'v6');
      console.log('分片上传 v6 xdb 到 KV...');
      await putShardedXdb(namespaceId, V6_KEYS, v6Buffer);
    } catch (e) {
      // v6 下载失败不应阻塞 v4 部署
      console.warn(`v6 xdb 处理失败（不影响 v4）: ${e.message}`);
    }
  } else {
    console.log('\n── IPv6 xdb: 已存在，跳过 ──');
  }

  // 7. 更新版本号
  await putKvValue(namespaceId, VERSION_KEY, releaseTag, {
    updated_at: new Date().toISOString(),
  });

  console.log(`\n更新完成: ${currentVersion || '(无)'} → ${releaseTag}`);
  console.log(`  v4: KV key "${V4_KEY}" — ${needV4 ? '已上传' : '已存在'}`);
  if (!skipV6) {
    console.log(`  v6: KV keys ${V6_KEYS.join(', ')} — ${needV6 ? '已上传' : '已存在'}`);
  }
}

main().catch(err => {
  console.error('更新失败:', err.message);
  process.exit(1);
});
