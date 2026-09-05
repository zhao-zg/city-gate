---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '12d346da-bc9e-495c-a491-2e5f99f88b07'
  PropagateID: '12d346da-bc9e-495c-a491-2e5f99f88b07'
  ReservedCode1: '82f1f993-e231-4769-9bb0-2f7311400bda'
  ReservedCode2: '82f1f993-e231-4769-9bb0-2f7311400bda'
---

# Docker 相关代码审查报告

> 审查日期: 2026-08-16  
> 审查范围: `docker/` 目录全部文件 + `.github/workflows/docker-build.yml`  
> 审查方法: superpowers 技能（系统性代码审查）  
> 项目: city-gate — Cloudflare 优选 IP 定时同步服务

---

## 审查文件清单

| 文件 | 行数 | 用途 |
|------|------|------|
| `docker/Dockerfile` | 57 | 容器镜像构建 |
| `docker/docker-compose.yml` | 50 | 服务编排 |
| `docker/entrypoint.sh` | 116 | 容器入口脚本 |
| `docker/.env.example` | 131 | 环境变量模板 |
| `docker/.gitattributes` | 1 | Git 换行符控制 |
| `.github/workflows/docker-build.yml` | 60 | CI 构建工作流 |

---

## 一、发现的问题

### 严重程度说明

- **P0 — 会导致功能故障或安全风险**，必须修复
- **P1 — 存在隐患或不一致**，建议修复
- **P2 — 优化建议**，可选择性处理

---

### P0-1: CI 工作流引用了不存在的文件 `scripts/check-cname.js`

**文件**: `.github/workflows/docker-build.yml` 第 11 行

```yaml
paths:
  - 'scripts/check-cname.js'   # ← 此文件不存在
```

**验证**: `scripts/` 目录下实际文件为 `check-dns.js`，没有 `check-cname.js`。

**影响**: 当仅 `check-cname.js` 发生变更时不会触发 CI 构建（但因为文件不存在，这个 path 永远不会匹配，属于死配置）。不影响实际构建，但会导致 `sync-cname.js`（被 sync-dns.js require 的核心模块）变更时不在 CI 监听路径中。

**修复建议**: 将 `scripts/check-cname.js` 改为 `scripts/sync-cname.js`（这是实际被 sync-dns.js 依赖的模块），同时补充 `scripts/check-dns.js`：

```yaml
paths:
  - 'docker/**'
  - 'scripts/sync-dns.js'
  - 'scripts/sync-cname.js'    # ← sync-dns.js 的核心依赖
  - 'scripts/check-dns.js'     # ← check 模式入口
  - 'workers/**/wrangler.toml'
  - 'package.json'
```

---

### P0-2: Dockerfile 注释中的 `_ssl` 保底 IP 与代码不一致

**文件**: `docker/Dockerfile` 无直接问题，但代码注释存在不一致

**文件**: `scripts/sync-dns.js` 第 292 行（注释）vs 第 366 行（实际代码）

```javascript
// 注释（第 292 行）:
// _ssl.{zone} 指向 1.1.1.1（CF 不访问源站，仅作证书保底），

// 实际代码（第 366 行）:
content: '192.0.2.1'   // ← 实际使用 192.0.2.1
```

**背景**: 根据记忆日志，最初用 `1.1.1.1` 但 CF 不允许 proxied 记录指向 `1.1.1.1`，已改为 `192.0.2.1`，但注释未同步更新。

**影响**: 误导维护者，可能在排查 SSL 问题时走弯路。

**修复建议**: 将第 292 行注释改为：

```javascript
// _ssl.{zone} 指向 192.0.2.1（文档保留 IP，CF 允许 proxied 记录指向它），
```

---

### P1-1: 缺少 `.dockerignore` 文件

**文件**: 项目根目录缺少 `.dockerignore`

**影响**: `docker-build.yml` 的 `context: .` 会将整个项目根目录发送到 Docker 构建守护进程。当前 `node_modules/`、`.temp/`、`docs/`、`pages/` 等目录都会被发送，增加构建上下文体积和构建时间。虽然 Dockerfile 只 COPY 了 `scripts/` 和 `wrangler.toml`，但构建上下文传输仍浪费带宽和时间。

**修复建议**: 在项目根目录创建 `.dockerignore`：

```
node_modules/
.temp/
docs/
pages/
README.md
.git/
.gitignore
*.xdb
wrangler.generated.toml
.env
.env.local
```

---

### P1-2: `entrypoint.sh` 中 `tee` 管道导致 exit_code 捕获失效

**文件**: `docker/entrypoint.sh` 第 50 行

```bash
node "$script" 2>&1 | tee -a "$LOG_FILE" || exit_code=$?
```

**问题**: 在 shell 管道 `cmd1 | cmd2` 中，`$?` 默认取的是**最后一个命令**（即 `tee`）的退出码，而不是 `node` 的退出码。如果 `node` 脚本失败但 `tee` 成功，`exit_code` 仍为 0，通知不会触发。

**影响**: 脚本执行失败时可能无法正确推送通知告警。

**修复建议**: 使用 `PIPESTATUS` 或 `set -o pipefail`：

```bash
# 方案 A: pipefail（推荐，Alpine sh 支持）
set -o pipefail
node "$script" 2>&1 | tee -a "$LOG_FILE" || exit_code=$?

# 方案 B: 显式取 PIPESTATUS（bash 才支持，Alpine 默认 sh 不支持）
# node "$script" 2>&1 | tee -a "$LOG_FILE"; exit_code=${PIPESTATUS[0]}
```

注意: Alpine 的 `/bin/sh`（busybox ash）支持 `set -o pipefail`，但需验证 dcron 环境下行为。

---

### P1-3: docker-compose.yml 注释中 `LATENCY_SAMPLES` 默认值描述不一致

**文件**: `docker/docker-compose.yml` 第 38 行

```yaml
# ── 延迟采样次数（默认 3，1=单次采样） ──
- LATENCY_SAMPLES=${LATENCY_SAMPLES:-10}
```

**问题**: 注释写"默认 3"，实际默认值为 `10`（与 Dockerfile ENV 和 .env.example 一致）。

**修复建议**: 将注释改为 `默认 10`：

```yaml
# ── 延迟采样次数（默认 10，1=单次采样） ──
```

---

### P1-4: Dockerfile 时区设置冗余且不完整

**文件**: `docker/Dockerfile` 第 5-7 行

```dockerfile
cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
echo "Asia/Shanghai" > /etc/timezone && \
echo "Asia/Shanghai" > /etc/TZ
```

**问题**:
1. 硬编码 `Asia/Shanghai`，但 docker-compose.yml 支持通过 `TZ` 环境变量自定义时区
2. `/etc/localtime` 设置后，Alpine 的 `date` 命令会读取它，但 Node.js 的 `Date` 默认使用 `/etc/localtime` 或 `TZ` 环境变量
3. `entrypoint.sh` 在 cron 模式下已通过 `export TZ=${TZ:-Asia/Shanghai}` 处理时区，Dockerfile 中的硬编码可被保留作为默认值，但应添加注释说明

**影响**: 功能正常（entrypoint.sh 已兜底），但不够 DRY。

**修复建议**: 保留 Dockerfile 中的默认设置作为 fallback，添加注释说明可被 `TZ` 环境变量覆盖：

```dockerfile
# 默认时区设为 Asia/Shanghai，可通过 TZ 环境变量覆盖
RUN apk add --no-cache dcron tzdata ca-certificates && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone
```

---

### P1-5: entrypoint.sh `notify` 函数使用 `local` 关键字在 `/bin/sh` 中不保证兼容

**文件**: `docker/entrypoint.sh` 第 11-12 行

```bash
#!/bin/sh
...
local title="$1"
```

**问题**: `local` 关键字是 bash 扩展，POSIX sh 不保证支持。Alpine 的 `/bin/sh`（busybox ash）**确实支持** `local`，所以当前不会报错，但这是非可移植写法。

**影响**: 当前环境正常运行。如果未来更换基础镜像（如 `node:22-slim` 使用 Debian，`/bin/sh` 指向 dash），`local` 可能行为不同。

**修复建议**: 维持现状可接受。如需严格 POSIX 兼容，可去掉 `local` 或将 shebang 改为 `#!/bin/bash`（但需在 Dockerfile 中安装 bash）。

---

### P2-1: GitHub Actions 缺少路径触发器 `scripts/sync-cname.js`

**文件**: `.github/workflows/docker-build.yml` 第 7-12 行

`sync-cname.js` 是 `sync-dns.js` 的核心依赖（`require('./sync-cname')`），但其变更不在 CI 监听路径中。

**影响**: 修改 `sync-cname.js` 后不会自动触发镜像构建，可能导致运行旧代码。

**修复建议**: 已在 P0-1 修复建议中包含。

---

### P2-2: Dockerfile 未固定 node:22-alpine 版本标签

**文件**: `docker/Dockerfile` 第 1 行

```dockerfile
FROM node:22-alpine
```

**问题**: `22-alpine` 是浮动标签，会跟随上游更新。虽然能获得安全补丁，但也可能引入破坏性变更（如 Alpine 版本升级导致包名变化）。

**影响**: 可重现性降低，但安全性受益。

**修复建议**: 可根据偏好选择：
- 维持现状（安全性优先）
- 或固定到小版本如 `node:22.16-alpine`（可重现性优先）

---

### P2-3: docker-compose.yml 缺少健康检查

**文件**: `docker/docker-compose.yml`

**问题**: 容器内运行 dcron 守护进程，但未配置 `healthcheck`。如果 crond 进程异常退出，docker 不会感知。

**修复建议**: 可添加健康检查（可选）：

```yaml
healthcheck:
  test: ["CMD", "pgrep", "crond"]
  interval: 5m
  timeout: 10s
  retries: 3
```

注意: dcron 的进程名可能是 `crond` 或 `dcron`，需在容器内验证。

---

### P2-4: Dockerfile 中 `package.json` 被拷贝但未执行 `npm install`

**文件**: `docker/Dockerfile` 第 17 行

```dockerfile
COPY package.json ./
```

**问题**: `package.json` 仅声明了 `javascript-obfuscator` 作为 devDependencies，sync-dns.js 使用的是 Node.js 内置模块（https/http/net/dns），不需要任何 npm 包。拷贝 `package.json` 但不安装依赖是合理的（脚本不需要），但拷贝行为本身可能是历史遗留。

**影响**: 无功能影响，仅增加镜像中一个 8 行文件。

**修复建议**: 确认 `package.json` 在运行时是否被 sync-dns.js 读取。如果不需要，可移除该 COPY 行。如果需要（如读取 version 字段），则保留。

---

## 二、架构与安全审查

### 安全审查

| 检查项 | 状态 | 说明 |
|--------|------|------|
| API Token 传递 | ✅ 安全 | 通过环境变量传递，不写入镜像 |
| 构建上下文 | ⚠️ 需关注 | 缺少 `.dockerignore`，但不含敏感文件（.env 已在 .gitignore） |
| 容器用户 | ℹ️ 注意 | 容器以 root 运行（未设置 USER 指令），Alpine 小镜像常见但非最佳实践 |
| 网络暴露 | ✅ 安全 | 无端口映射，仅出站请求 CF API |
| 日志持久化 | ✅ 正常 | 挂载 `./logs` 目录，不写入容器层 |

### 架构一致性

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 环境变量链路 | ✅ 一致 | Dockerfile ENV → docker-compose.yml → .env.example 三处默认值对齐（除 P1-3 注释） |
| CI 触发路径 | ❌ 有缺陷 | 见 P0-1，缺少 sync-cname.js，引用不存在的 check-cname.js |
| 代码注释与实现 | ❌ 不一致 | 见 P0-2，SSL 保底 IP 注释过时 |
| 多架构支持 | ✅ 正常 | linux/amd64 + linux/arm64，QEMU + Buildx |
| 镜像缓存 | ✅ 正常 | GHA 缓存 `type=gha,mode=max` |

---

## 三、修复优先级汇总

| 优先级 | 编号 | 问题 | 文件 | 修复难度 |
|--------|------|------|------|----------|
| **P0** | P0-1 | CI 引用不存在的文件，缺少核心依赖路径 | docker-build.yml | 低 |
| **P0** | P0-2 | SSL 保底 IP 注释与代码不一致 | sync-dns.js:292 | 低 |
| **P1** | P1-1 | 缺少 .dockerignore | 项目根目录 | 低 |
| **P1** | P1-2 | tee 管道导致 exit_code 捕获失效 | entrypoint.sh:50 | 中 |
| **P1** | P1-3 | LATENCY_SAMPLES 注释默认值不一致 | docker-compose.yml:38 | 低 |
| **P1** | P1-4 | 时区硬编码冗余 | Dockerfile:5-7 | 低 |
| **P1** | P1-5 | local 关键字在 sh 中非严格兼容 | entrypoint.sh:11 | 低 |
| **P2** | P2-1 | CI 缺少 sync-cname.js 路径 | docker-build.yml | 低 |
| **P2** | P2-2 | node:22-alpine 浮动标签 | Dockerfile:1 | 低 |
| **P2** | P2-3 | 缺少健康检查 | docker-compose.yml | 中 |
| **P2** | P2-4 | package.json 拷贝可能多余 | Dockerfile:17 | 低 |

---

## 四、建议修复计划

### 第一批（P0 + 简单 P1，建议立即修复）

1. **P0-1**: 修正 `docker-build.yml` 路径触发器
2. **P0-2**: 更新 `sync-dns.js` 第 292 行注释
3. **P1-1**: 创建 `.dockerignore`
4. **P1-3**: 修正 `docker-compose.yml` 注释

### 第二批（需测试验证，建议后续修复）

5. **P1-2**: 修复 `entrypoint.sh` 管道退出码捕获，添加 `set -o pipefail`，需在 NAS 容器内验证
6. **P1-4**: 优化 Dockerfile 时区设置注释
7. **P2-3**: 添加健康检查，需先在容器内确认 dcron 进程名

### 不修复项（维持现状合理）

8. **P1-5**: `local` 关键字 — Alpine ash 支持，不引入风险
9. **P2-2**: node:22-alpine 浮动标签 — 安全性优先策略
10. **P2-4**: package.json — 需确认是否有运行时读取需求

---

## 五、总结

整体 Docker 化方案设计合理，多架构构建、GHA 缓存、环境变量透传、通知告警等机制完善。主要问题集中在：

1. **CI 工作流路径配置错误**（P0-1）— 会导致核心依赖变更不触发重建
2. **代码注释过时**（P0-2）— 误导维护者
3. **管道退出码捕获**（P1-2）— 可能导致告警失效

建议优先修复 P0 问题，P1 中的 `.dockerignore` 和管道修复也建议尽快处理。