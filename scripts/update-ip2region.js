#!/usr/bin/env node
/**
 * ip2region xdb 更新脚本
 *
 * 从 ip2region GitHub Release 下载最新 xdb 文件，上传到 Cloudflare KV。
 * 支持版本检测：如果 KV 中已有最新版本则跳过。
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
 *
 * 用法：
 *   node scripts/update-ip2region.js
 *   KV_NAMESPACE_ID=xxx node scripts/update-ip2region.js
 *   IP2REGION_VERSION=3.5.1 node scripts/update-ip2region.js
 */

const path = require('path');
const fs = require('fs');

const XDB_KEY = 'ip2region_v4.xdb';
const VERSION_KEY = 'ip2region_version';
const GITHUB_OWNER = 'lionsoul2014';
const GITHUB_REPO = 'ip2region';
const KV_NAMESPACE_TITLE = 'city-gate-IP2REGION';
const KV_PLACEHOLDER = 'PLACEHOLDER_KV_IP2REGION_NAMESPACE_ID';

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

function findXdbAsset(assets) {
  for (const pattern of [/ip2region\.xdb/, /ip2region_v4\.xdb/, /ipv4.*\.xdb/]) {
    const found = assets.find(a => pattern.test(a.name) && a.name.endsWith('.xdb'));
    if (found) return found;
  }
  return null;
}

async function downloadXdb(downloadUrl) {
  console.log(`  下载: ${downloadUrl}`);
  const res = await fetch(downloadUrl, {
    headers: { 'User-Agent': 'city-gate-update-script' },
  });
  if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();
  console.log(`  大小: ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB`);
  return buffer;
}

// ── KV 读写 ──────────────────────────────────────────

async function getKvValue(namespaceId, key) {
  const res = await cfApi(`/storage/kv/namespaces/${namespaceId}/values/${key}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KV 读取失败: HTTP ${res.status}`);
  return res.text();
}

async function putKvValue(namespaceId, key, value, metadata = {}) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${key}`;

  const formData = new FormData();
  formData.append('value', value);
  formData.append('metadata', JSON.stringify(metadata));

  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}` },
    body: formData,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`KV 写入失败: HTTP ${res.status} ${err}`);
  }
}

// ── 主流程 ────────────────────────────────────────────

async function main() {
  // 必需环境变量（不再要求 KV_NAMESPACE_ID）
  const requiredEnvs = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'];
  for (const env of requiredEnvs) {
    if (!process.env[env]) {
      console.error(`缺少环境变量: ${env}`);
      process.exit(1);
    }
  }

  // 1. 确保 KV namespace 存在
  const namespaceId = await ensureKvNamespace();

  // 2. 如果是通过环境变量指定的 id，检查 wrangler.toml 是否需要更新
  //    如果是自动查找/创建的，始终尝试写回 wrangler.toml
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
  let releaseTag, xdbUrl;

  if (specifiedVersion) {
    releaseTag = specifiedVersion.startsWith('v') ? specifiedVersion : `v${specifiedVersion}`;
    xdbUrl = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/raw/${releaseTag}/data/ip2region_v4.xdb`;
    console.log(`指定版本: ${releaseTag}`);
  } else {
    console.log('检查 ip2region 最新版本...');
    const release = await getLatestRelease();
    releaseTag = release.tag;

    const asset = findXdbAsset(release.assets);
    if (asset) {
      xdbUrl = asset.browser_download_url;
    } else {
      xdbUrl = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/raw/${releaseTag}/data/ip2region_v4.xdb`;
    }
    console.log(`最新版本: ${releaseTag}`);
  }

  // 4. 检查 KV 中是否已是最新版本
  const currentVersion = await getKvValue(namespaceId, VERSION_KEY);
  if (currentVersion === releaseTag) {
    console.log(`KV 中已是最新版本 ${releaseTag}，跳过更新`);
    return;
  }
  console.log(`KV 当前版本: ${currentVersion || '无'}，需要更新到 ${releaseTag}`);

  // 5. 下载 xdb
  const xdbBuffer = await downloadXdb(xdbUrl);

  // 6. 上传到 KV
  console.log('上传 xdb 到 KV...');
  await putKvValue(namespaceId, XDB_KEY, new Uint8Array(xdbBuffer), {
    version: releaseTag,
    updated_at: new Date().toISOString(),
  });

  // 7. 写入版本号
  await putKvValue(namespaceId, VERSION_KEY, releaseTag, {
    updated_at: new Date().toISOString(),
  });

  console.log(`更新完成: ${currentVersion || '(无)'} → ${releaseTag}`);
}

main().catch(err => {
  console.error('更新失败:', err.message);
  process.exit(1);
});
