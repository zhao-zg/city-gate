---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'a13b9025-200e-4315-ab40-0df8a9368f0c'
  PropagateID: 'a13b9025-200e-4315-ab40-0df8a9368f0c'
  ReservedCode1: '743ae05f-4e3f-464d-8370-2055ee72a98e'
  ReservedCode2: '743ae05f-4e3f-464d-8370-2055ee72a98e'
---

# 设计文档：colo 数据中心过滤 + 多次采样评分

> 日期：2026-08-16
> 参考项目：[GuangYu-yu/CFnat](https://github.com/GuangYu-yu/CFnat)

## 背景

当前 city-gate 的 IP 优选流程：从优选域名池解析 IP → 验证 1034 → 测延迟 → 去重 → 测速。
每个 IP 只做 1 次延迟测量 + 1 次测速，单次结果决定一切。且不关心 IP 属于哪个 CF 数据中心。

从 CFnat 项目学习到两个可改进点：
1. **colo 数据中心过滤** — 从 `cf-ray` 响应头提取数据中心代码，可按区域筛选
2. **多次采样取平均** — 消除偶发网络抖动导致的误判

## 功能 1：colo 数据中心过滤

### 原理

CF 边缘 IP 的 HTTP 响应头 `cf-ray` 格式为 `{hex}-{COLO}`，如 `8a1b2c3d-HKG`。
在 `testIp1034Once` 中已经发了一个 HTTPS GET 请求到 CF 边缘 IP，响应头包含 `cf-ray`，无需额外请求。

### 设计

- 新增环境变量 `COLO_FILTER`（逗号分隔，如 `HKG,LAX,SJC`），留空=不过滤
- 在 `testIp1034Once` 返回结果中附带 `colo` 信息（从 `cf-ray` 提取）
- `buildIpPool` 中 IP 质量检测结果增加 colo 列
- 设了 `COLO_FILTER` 时，colo 不匹配的 IP 直接过滤（在延迟过滤之后）
- 测速结果一览中显示每个 IP 的 colo

### 改动范围

| 文件 | 改动 |
|---|---|
| `scripts/sync-cname.js` | `testIp1034Once` 提取 `cf-ray` → 返回 `colo` 字段 |
| `scripts/sync-dns.js` | 读取 `COLO_FILTER`，`buildIpPool` 增加 colo 过滤，日志展示 colo |
| `docker/Dockerfile` | 新增 `ENV COLO_FILTER=""` |
| `docker/docker-compose.yml` | 新增 `COLO_FILTER` 环境变量传递 |
| `docker/.env.example` | 新增 `COLO_FILTER` 配置说明 |

### 日志格式

```
✓  172.64.152.241   45ms    HKG
✓  104.16.123.45    78ms    LAX
✗  162.159.9.193    — 连接失败
```

## 功能 2：延迟多次采样 + 丢包率过滤

### 原理

单次 TCP 握手延迟可能因网络抖动偏高/偏低。对每个 IP 测多次延迟取平均，可消除偶发干扰。
同时，N 次采样中的失败比例即丢包率，过高说明 IP 不稳定，应直接过滤。

### 设计

- 新增环境变量 `LATENCY_SAMPLES`（延迟采样次数，默认 3，范围 1-10）
- 新增环境变量 `MAX_PACKET_LOSS_RATE`（丢包率上限，默认 0.3 = 允许 30% 失败，如 3 次中最多 1 次失败）
- `measureLatency` 改为 `measureLatencyMulti(ip, samples)`，测 N 次取平均值，同时返回成功次数/总次数
- 丢包率 = 失败次数 / 总采样次数，超过 `MAX_PACKET_LOSS_RATE` 的 IP 直接过滤
- 测速保持单次 10MB 下载，不改
- 日志展示采样明细

### 改动范围

| 文件 | 改动 |
|---|---|
| `scripts/sync-dns.js` | `measureLatency` → `measureLatencyMulti`，丢包率过滤，日志展示采样明细 |
| `docker/Dockerfile` | 新增 `ENV LATENCY_SAMPLES="3"` 和 `ENV MAX_PACKET_LOSS_RATE="0.3"` |
| `docker/docker-compose.yml` | 新增 `LATENCY_SAMPLES` 和 `MAX_PACKET_LOSS_RATE` 环境变量传递 |
| `docker/.env.example` | 新增 `LATENCY_SAMPLES` 和 `MAX_PACKET_LOSS_RATE` 配置说明 |

### 日志格式

```
  ✓  172.64.152.241   45ms (42/48/45)  3/3  HKG
  ✗  104.16.123.45    78ms (76/82/76)  2/3  丢包率 33% > 30%，过滤
  ✗  162.159.9.193    — 0/3  连接失败
```

## 不做的事

- **不引入文件持久化** — cron 模式跨运行历史参考价值有限
- **不引入 EMA 加权** — 多次采样取平均已足够消除抖动
- **不改测速** — 单次 10MB 下载测速已确定
- **不改主备池机制** — 那是常驻转发场景的设计，cron 不需要