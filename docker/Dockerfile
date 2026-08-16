FROM node:22-alpine

# ── 安装 cron + tzdata + ca-certificates ──
RUN apk add --no-cache dcron tzdata ca-certificates && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone && \
    echo "Asia/Shanghai" > /etc/TZ

WORKDIR /app

# ── 仅拷贝脚本所需文件 ──
# workers/ 不再需要 Worker 代码（去 Worker 化重构）
# wrangler.toml 仍需保留以供 sync-dns.js 读取域名配置
COPY scripts/   ./scripts/
COPY workers/city-gate/wrangler.toml     ./workers/city-gate/wrangler.toml
COPY workers/city-gate-2/wrangler.toml  ./workers/city-gate-2/wrangler.toml
COPY package.json ./

# ── entrypoint ──
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# ── 日志目录 ──
RUN mkdir -p /var/log/city-gate

# 默认每 6 小时执行一次
ENV CRON_SCHEDULE="0 */6 * * *"
# 默认执行 CNAME 同步（可选: check = 仅检测不同步）
ENV RUN_MODE="sync"
# 默认不 dry-run
ENV DRY_RUN="0"
# A 记录配置
ENV IP_PER_ZONE="2"
ENV IP_DEDUP_PREFIX="32"
# 测速配置
ENV MIN_SPEED_KBPS="500"
ENV SPEED_TEST_SEC="2"
ENV MAX_LATENCY_MS="300"
# 测速模式：fast=达标即停 / best=全部测完选最优 / off=跳过测速
ENV SPEED_TEST_MODE="fast"
ENV MAX_SPEED_TEST_COUNT="20"
# 测速域名（留空=自动检测，需为已部署 Worker 的域名，Worker 需有 /__down 路由）
ENV SPEED_TEST_HOST=""
# 数据中心过滤（逗号分隔，如 HKG,LAX；留空=不过滤，仅展示）
ENV COLO_FILTER=""
# 延迟采样次数（默认 10，1=单次不取平均）
ENV LATENCY_SAMPLES="10"
# 丢包率上限，超过则过滤（默认 0.1 = 10%）
ENV MAX_PACKET_LOSS_RATE="0.1"
# IP 来源：domain=域名解析 / cidr=CF CIDR扫描 / both=两者合并 / 自定义(CIDR,IP,域名混合)
ENV IP_SOURCE="domain"
# 每个 CIDR 最多采样 IP 数（默认 100）
ENV CIDR_SAMPLES="100"
# Zone 配置覆盖（留空=使用镜像内 wrangler.toml，设为 JSON 字符串=环境变量覆盖）
ENV ZONE_CONFIG_JSON=""

ENTRYPOINT ["/entrypoint.sh"]
