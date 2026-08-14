FROM node:20-alpine

# ── 安装 cron + tzdata + ca-certificates ──
RUN apk add --no-cache dcron tzdata ca-certificates && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone && \
    apk del tzdata

WORKDIR /app

# ── 仅拷贝脚本所需文件 ──
COPY scripts/   ./scripts/
COPY workers/   ./workers/
COPY package.json ./

# ── entrypoint ──
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# ── 日志目录 ──
RUN mkdir -p /var/log/city-gate

# 默认每 6 小时执行一次（与 GitHub Actions 对齐）
ENV CRON_SCHEDULE="0 */6 * * *"
# 默认执行同步（可选: check = 仅检测不同步）
ENV RUN_MODE="sync"
# 默认不 dry-run
ENV DRY_RUN="0"

ENTRYPOINT ["/entrypoint.sh"]
