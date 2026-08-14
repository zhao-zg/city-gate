#!/usr/bin/env node
/**
 * cleanup-worker-routes.js
 *
 * 删除 Cloudflare 上旧 Worker 的 routes 绑定。
 * 使用 wrangler OAuth token 或 CF API Token 进行操作。
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN   — 账户1 Token（需 Workers Routes:Edit 权限）
 *   CLOUDFLARE_API_TOKEN_2 — 账户2 Token
 *   TOKEN_KEY（可选）       — 只处理指定 tokenKey 的 zone（'default' 或 'account2'），不设则全部处理
 *   DRY_RUN（可选）        — 设为 1 则只预览不执行
 *
 * 用法：
 *   node scripts/cleanup-worker-routes.js
 *   DRY_RUN=1 node scripts/cleanup-worker-routes.js
 *   TOKEN_KEY=account2 node scripts/cleanup-worker-routes.js
 */

const sc = require('./sync-cname');

const CF_API = 'https://api.cloudflare.com/client/v4';
const dryRun = process.env.DRY_RUN === '1';

// Token 映射：支持 WRANGLER_OAUTH_TOKEN 优先，兼容 CI 的 TOKEN_KEY 过滤
const TOKEN_MAP = {
  default: process.env.WRANGLER_OAUTH_TOKEN || process.env.CLOUDFLARE_API_TOKEN,
  account2: process.env.CLOUDFLARE_API_TOKEN_2,
};

const tokenKeyFilter = process.env.TOKEN_KEY || null;

function getToken(tokenKey) {
  const token = TOKEN_MAP[tokenKey || 'default'];
  if (!token) throw new Error(`API Token 未设置 (key: ${tokenKey || 'default'})`);
  return token;
}

async function cfApi(path, options = {}) {
  const tokenKey = options.tokenKey || 'default';
  const token = getToken(tokenKey);

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
  const json = await cfApi(`/zones?name=${zoneName}`, { tokenKey });
  if (!json.result?.length) {
    throw new Error(`Zone "${zoneName}" 未找到`);
  }
  return json.result[0].id;
}

async function getWorkerRoutes(zoneId, tokenKey) {
  const json = await cfApi(`/zones/${zoneId}/workers/routes`, { tokenKey });
  return json.result || [];
}

async function deleteWorkerRoute(zoneId, routeId, tokenKey) {
  await cfApi(`/zones/${zoneId}/workers/routes/${routeId}`, { method: 'DELETE', tokenKey });
}

async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  Worker Routes 清理脚本                          ║');
  console.log('╚════════════════════════════════════════════════╝');

  if (dryRun) {
    console.log('\n⚠  DRY_RUN 模式 — 仅预览，不执行任何修改\n');
  }

  // 获取所有 zone 配置
  let zones = sc.autoDetectZoneMap();
  
  // TOKEN_KEY 过滤
  if (tokenKeyFilter) {
    const before = zones.length;
    zones = zones.filter(z => z.tokenKey === tokenKeyFilter);
    console.log(`  TOKEN_KEY=${tokenKeyFilter} 过滤: ${before} → ${zones.length} 个 Zone`);
  }
  
  console.log(`\n检测到 ${zones.length} 个 zone\n`);

  let totalDeleted = 0;
  let totalErrors = 0;
  let totalSkipped = 0;

  for (const zone of zones) {
    const { zoneName, tokenKey } = zone;
    console.log(`━━━ Zone: ${zoneName} (账户: ${tokenKey}) ━━━`);

    let zoneId;
    try {
      zoneId = await getZoneId(zoneName, tokenKey);
    } catch (e) {
      console.error(`  ✗ 获取 Zone ID 失败: ${e.message}`);
      totalErrors++;
      continue;
    }

    let routes;
    try {
      routes = await getWorkerRoutes(zoneId, tokenKey);
    } catch (e) {
      console.error(`  ✗ 获取 Worker routes 失败: ${e.message}`);
      totalErrors++;
      continue;
    }

    if (routes.length === 0) {
      console.log(`  无 Worker routes → 跳过`);
      totalSkipped++;
      continue;
    }

    console.log(`  发现 ${routes.length} 条 Worker routes:`);
    for (const route of routes) {
      console.log(`    ${route.pattern} (id: ${route.id})`);
    }

    for (const route of routes) {
      console.log(`  删除: ${route.pattern}`);
      if (!dryRun) {
        try {
          await deleteWorkerRoute(zoneId, route.id, tokenKey);
          console.log(`    ✓ 已删除`);
          totalDeleted++;
        } catch (e) {
          console.error(`    ✗ 删除失败: ${e.message}`);
          totalErrors++;
        }
      } else {
        totalDeleted++;
      }
    }
  }

  console.log('\n━━━ 汇总 ━━━');
  console.log(`  删除: ${totalDeleted}  跳过(无routes): ${totalSkipped}  错误: ${totalErrors}`);

  if (totalErrors > 0) {
    process.exit(1);
  }
}

main().catch(e => {
  console.error('致命错误:', e.message);
  process.exit(1);
});
