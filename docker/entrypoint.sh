#!/bin/sh
set -e

LOG_DIR="/var/log/city-gate"
LOG_FILE="${LOG_DIR}/sync-$(date +%Y%m%d).log"
# 确保日志目录存在
mkdir -p "$LOG_DIR"

LOCK_FILE="/tmp/city-gate.lock"

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

# ── 执行脚本（带互斥锁） ──
run_script() {
  # 尝试获取锁：非阻塞，锁文件存在且持有进程存活则跳过
  if [ -f "$LOCK_FILE" ]; then
    local old_pid
    old_pid=$(cat "$LOCK_FILE" 2>/dev/null)
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] [SKIP] 上一次执行仍在运行 (PID $old_pid)，跳过本次"
      return 0
    fi
    # 锁文件残留但进程已死，清理
    rm -f "$LOCK_FILE"
  fi

  # 写入当前 PID
  echo $$ > "$LOCK_FILE"
  trap 'rm -f "$LOCK_FILE"' EXIT

  local mode="${RUN_MODE:-sync}"
  local script=""

  case "$mode" in
    sync)
      script="scripts/sync-dns.js"
      ;;
    check)
      script="scripts/check-dns.js"
      ;;
    *)
      echo "[ERROR] 未知 RUN_MODE: $mode（支持: sync / check）"
      rm -f "$LOCK_FILE"
      exit 1
      ;;
  esac

  local start_ts end_ts elapsed elapsed_h elapsed_m elapsed_s
  start_ts=$(date +%s)

  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "  city-gate-cron 开始: $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "  模式: $mode (同步 DNS + 检验 + 测速)  |  DRY_RUN: ${DRY_RUN:-0}"
  echo "════════════════════════════════════════════════════════════"
  echo ""

  local exit_code=0
  node "$script" 2>&1 | tee -a "$LOG_FILE" || exit_code=$?

  rm -f "$LOCK_FILE"
  trap - EXIT

  end_ts=$(date +%s)
  elapsed=$((end_ts - start_ts))
  elapsed_h=$((elapsed / 3600))
  elapsed_m=$(( (elapsed % 3600) / 60 ))
  elapsed_s=$((elapsed % 60))

  if [ "$exit_code" -ne 0 ]; then
    echo "[ERROR] 脚本执行失败 (exit: $exit_code)"
    notify "city-gate 执行失败" "模式: $mode, 退出码: $exit_code, 时间: $(date '+%Y-%m-%d %H:%M:%S')"
  else
    echo "[OK] 脚本执行完成"
  fi

  echo "──────────────────────────────────────────────────────────────"
  echo "  city-gate-cron 结束: $(date '+%Y-%m-%d %H:%M:%S %Z')"
  printf "  耗时: %02d:%02d:%02d (%ds)\n" "$elapsed_h" "$elapsed_m" "$elapsed_s" "$elapsed"
  echo "──────────────────────────────────────────────────────────────"
  echo ""

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

    # 写入 crontab（crond 子进程不继承环境变量，需在命令前显式 export TZ）
    echo "$CRON_EXPR export TZ=${TZ:-Asia/Shanghai}; cd /app && /entrypoint.sh run >> ${LOG_DIR}/cron.log 2>&1" \
      | crontab -

    echo "[INFO] 已注册 crontab: $CRON_EXPR"
    echo "[INFO] 启动后先执行一次..."
    /entrypoint.sh run || true

    echo "[INFO] cron 守护启动"
    export TZ="${TZ:-Asia/Shanghai}"
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
