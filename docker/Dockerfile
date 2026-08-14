FROM node:22-alpine

# ── 安装 cron + tzdata + ca-certificates ──
RUN apk add --no-cache dcron tzdata ca-certificates && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone && \
    echo "Asia/Shanghai" > /etc/TZ

WORKDIR /app

# ── 仅拷贝脚本所需文件 ──
# workers/ 不再需要（去 Worker 化重构，容器仅用于 DNS A 记录同步）
# wrangler.toml 仍需保留以供 sync-dns.js 读取配置
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
# 默认执行 A 记录同步（可选: check = 仅检测不同步）
ENV RUN_MODE="sync"
# 默认不 dry-run
ENV DRY_RUN="0"
# 每个 zone 分配的 A 记录 IP 数量
ENV IP_PER_ZONE="2"
# IP 去重前缀长度（/24 = 同段只保留延迟最低的）
ENV IP_DEDUP_PREFIX="24"
# Zone 配置覆盖（留空=使用镜像内 wrangler.toml，设为 JSON 字符串=环境变量覆盖）
ENV ZONE_CONFIG_JSON=""

ENTRYPOINT ["/entrypoint.sh"]
