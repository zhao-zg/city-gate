#!/bin/sh
set -e

LOG_DIR="/var/log/city-gate"
LOG_FILE="${LOG_DIR}/sync-$(date +%Y%m%d).log"
# 确保日志目录存在
mkdir -p "$LOG_DIR"

# ── 通知函数（可选） ──
notify() {
  local title="$1"
  local body="$2"
  if [ -n "$NOTIFY_URL" ]; then
    local token_part=""
    [ -n "$NOTIFY_TOKEN" ] && token_part="\"token\":\"${NOTIFY_TOKEN}\","
    # 兼容 Bark / PushPlus / Server酱等常见通知 API
    curl -sf -X POST "$NOTIFY_URL" \
      -H "Content-Type: application/json" \
      -d "{${token_part}\"title\":\"${title}\",\"body\":\"$(echo "$body" | head -c 2000)\"}" \
      > /dev/null 2>&1 || true
  fi
}

# ── 执行脚本 ──
run_script() {
  local mode="${RUN_MODE:-sync}"
  local script=""

  case "$mode" in
    sync)
      script="scripts/sync-dns.js"
      ;;
    check)
      script="scripts/check-cname.js"
      ;;
    *)
      echo "[ERROR] 未知 RUN_MODE: $mode（支持: sync / check）"
      exit 1
      ;;
  esac

  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "  city-gate-cron  $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "  模式: $mode  |  DRY_RUN: ${DRY_RUN:-0}"
  echo "════════════════════════════════════════════════════════════"
  echo ""

  local exit_code=0
  node "$script" 2>&1 | tee -a "$LOG_FILE" || exit_code=$?

  if [ "$exit_code" -ne 0 ]; then
    echo "[ERROR] 脚本执行失败 (exit: $exit_code)"
    notify "city-gate 执行失败" "模式: $mode, 退出码: $exit_code, 时间: $(date '+%Y-%m-%d %H:%M:%S')"
  else
    echo "[OK] 脚本执行完成"
  fi

  return $exit_code
}

# ── 入口 ──
case "${1:-cron}" in
  # 手动执行一次
  run)
    run_script
    ;;

  # 仅检测
  check)
    RUN_MODE=check run_script
    ;;

  # 预览模式（不修改 DNS）
  dry-run)
    DRY_RUN=1 RUN_MODE=sync run_script
    ;;

  # 定时 cron 模式（默认）
  cron)
    CRON_EXPR="${CRON_SCHEDULE:-0 */6 * * *}"
    echo ""
    echo "╔════════════════════════════════════════════════╗"
    echo "║  city-gate-cron  定时模式启动                    ║"
    echo "╠════════════════════════════════════════════════╣"
    echo "║  定时计划:  ${CRON_EXPR}"
    echo "║  运行模式:  ${RUN_MODE:-sync}"
    echo "║  DRY_RUN:   ${DRY_RUN:-0}"
    echo "║  时区:      ${TZ:-Asia/Shanghai}"
    echo "║  日志目录:  ${LOG_DIR}"
    echo "╚════════════════════════════════════════════════╝"
    echo ""

    # 写入 crontab
    echo "$CRON_EXPR cd /app && /entrypoint.sh run >> ${LOG_DIR}/cron.log 2>&1" \
      | crontab -

    echo "[INFO] 已注册 crontab: $CRON_EXPR"
    echo "[INFO] 启动后先执行一次..."
    /entrypoint.sh run || true

    echo "[INFO] cron 守护启动"
    crond -f -l 2 -L "${LOG_DIR}/cron.log"
    ;;

  *)
    echo "用法: $0 {run|check|dry-run|cron}"
    echo ""
    echo "  run      — 手动执行一次同步"
    echo "  check    — 仅检测（不同步 DNS）"
    echo "  dry-run  — 预览模式（不修改 DNS）"
    echo "  cron     — 定时模式（默认，按 CRON_SCHEDULE 周期执行）"
    exit 1
    ;;
esac
