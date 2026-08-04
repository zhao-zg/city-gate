#!/usr/bin/env node
/**
 * Cloudflare DNS CNAME 同步脚本
 *
 * 根据 CNAME_MAP 配置，自动为指定 zone 下的域名设置 CNAME 记录：
 *   - 如果已存在 CNAME 且目标不是优选域名 → 删除旧记录，新建
 *   - 如果已存在 CNAME 且目标已是优选域名 → 跳过
 *   - 如果不存在 CNAME → 新建记录
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN  — Cloudflare API Token（需 Zone:DNS:Edit 权限）
 *   DRY_RUN（可选）       — 设为 1 则只预览不执行
 *
 * 用法：
 *   node scripts/sync-cname.js             # 执行同步
 *   DRY_RUN=1 node scripts/sync-cname.js   # 预览模式
 */

const CF_API = 'https://api.cloudflare.com/client/v4';

// ── CNAME 映射配置 ─────────────────────────────────────
// 每个 zone 下的子域名前缀列表 → 指向的优选域名（CNAME 目标）
// 后续新增优选域名只需在此数组中添加一条即可
const CNAME_MAP = [
  {
    zoneName: 'zhaozg.dpdns.org',
    target: 'saas.sin.fan',
    names: ['sg', 'books', 'bible', 'cx'],
    // names 会拼接为 sg.zhaozg.dpdns.org, books.zhaozg.dpdns.org 等
  },
  // 示例：后续扩展更多优选域名
  // {
  //   zoneName: '1189.dpdns.org',
  //   target: 'preferred2.example.com',
  //   names: ['sg', 'books', 'bible'],
  // },
];

// ── 工具函数 ──────────────────────────────────────────

async function cfFetch(path, options = {}) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN 未设置');

  const res = await fetch(`${CF_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const json = await res.json();
  if (!json.success) {
    const err = json.errors?.map(e => e.message).join('; ') || '未知错误';
    throw new Error(`Cloudflare API 错误: ${err}`);
  }
  return json;
}

async function getZoneId(zoneName) {
  const json = await cfFetch(`/zones?name=${zoneName}`);
  if (!json.result?.length) {
    throw new Error(`Zone "${zoneName}" 未找到，请检查 zone 名称和 API Token 权限`);
  }
  return json.result[0].id;
}

async function getDnsRecords(zoneId, recordName) {
  const json = await cfFetch(`/zones/${zoneId}/dns_records?name=${recordName}`);
  return json.result || [];
}

async function deleteDnsRecord(zoneId, recordId) {
  await cfFetch(`/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' });
}

async function createCnameRecord(zoneId, name, target, proxied = false) {
  const body = { type: 'CNAME', name, content: target, proxied, ttl: 1 };
  await cfFetch(`/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ── 主逻辑 ──────────────────────────────────────────

async function processZone(cfg) {
  const { zoneName, target, names } = cfg;
  const dryRun = process.env.DRY_RUN === '1';

  console.log(`\n━━━ Zone: ${zoneName} → ${target} ━━━`);

  let zoneId;
  try {
    zoneId = await getZoneId(zoneName);
  } catch (e) {
    console.error(`  ✗ 获取 Zone ID 失败: ${e.message}`);
    return { errors: 1, created: 0, deleted: 0, skipped: 0 };
  }

  const stats = { errors: 0, created: 0, deleted: 0, skipped: 0 };

  for (const name of names) {
    const fqdn = `${name}.${zoneName}`;
    console.log(`\n  ▸ ${fqdn}`);

    try {
      const records = await getDnsRecords(zoneId, fqdn);
      const cnameRecords = records.filter(r => r.type === 'CNAME');

      if (cnameRecords.length === 0) {
        // 无 CNAME 记录，直接创建
        console.log(`    无 CNAME 记录 → 创建 CNAME → ${target}`);
        if (!dryRun) {
          await createCnameRecord(zoneId, fqdn, target);
        }
        stats.created++;
      } else {
        // 已有 CNAME 记录
        const matchTarget = cnameRecords.filter(r => r.content === target);
        const mismatchTarget = cnameRecords.filter(r => r.content !== target);

        if (matchTarget.length > 0 && mismatchTarget.length === 0) {
          // 已存在正确的 CNAME，跳过
          console.log(`    CNAME 已指向 ${target} → 跳过`);
          stats.skipped++;
        } else {
          // 存在不指向优选域名的 CNAME，删除后重建
          for (const rec of mismatchTarget) {
            console.log(`    删除旧 CNAME → ${rec.content} (id: ${rec.id})`);
            if (!dryRun) {
              await deleteDnsRecord(zoneId, rec.id);
            }
            stats.deleted++;
          }

          if (matchTarget.length === 0) {
            console.log(`    创建 CNAME → ${target}`);
            if (!dryRun) {
              await createCnameRecord(zoneId, fqdn, target);
            }
            stats.created++;
          } else {
            console.log(`    CNAME 已指向 ${target} → 跳过`);
            stats.skipped++;
          }
        }
      }
    } catch (e) {
      console.error(`    ✗ 处理失败: ${e.message}`);
      stats.errors++;
    }
  }

  return stats;
}

async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║  Cloudflare DNS CNAME 同步脚本        ║');
  console.log('╚══════════════════════════════════════╝');

  if (process.env.DRY_RUN === '1') {
    console.log('\n⚠  DRY_RUN 模式 — 仅预览，不执行任何修改\n');
  }

  let totalStats = { errors: 0, created: 0, deleted: 0, skipped: 0 };

  for (const cfg of CNAME_MAP) {
    const stats = await processZone(cfg);
    totalStats.created += stats.created;
    totalStats.deleted += stats.deleted;
    totalStats.errors += stats.errors;
    totalStats.skipped += stats.skipped;
  }

  console.log('\n━━━ 汇总 ━━━');
  console.log(`  创建: ${totalStats.created}  删除: ${totalStats.deleted}  跳过: ${totalStats.skipped}  错误: ${totalStats.errors}`);

  if (totalStats.errors > 0) {
    process.exit(1);
  }
}

main();
