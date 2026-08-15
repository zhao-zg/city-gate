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
# Zone 配置覆盖（留空=使用镜像内 wrangler.toml，设为 JSON 字符串=环境变量覆盖）
ENV ZONE_CONFIG_JSON=""

ENTRYPOINT ["/entrypoint.sh"]
