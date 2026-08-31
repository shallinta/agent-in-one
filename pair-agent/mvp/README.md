# Pair Agent Phase 0 MVP

这是一个基于固定 DeepSeek Harness（DSH）源码快照的本地探索原型。它验证一条 Pair Session 映射为两个独立 DSH Agent Session，并由 Pair Web Shell 同时展示 Navigator 与 Pilot 的原生 DSH Web 会话。

它不是生产部署方案，也不声称实现完整权限系统、可靠消息投递或完整的 Sub-agent / workflow 语义。

## 1. 运行边界

`pnpm dev` 启动一个受监督的本地进程组：

```text
Pair Web (3070) ──/api proxy──> Pair Host (3090)
      │
      ├── Navigator iframe ─┐
      └── Pilot iframe ─────┴──> DSH Host/API/Web (3080)
                                      │
                                      └── one live DSH Context
                                          ├── Navigator Agent/Session
                                          └── Pilot Agent/Session
```

DSH Host/API 与两个 Agent 使用同一个 live `Context`、`AgentRegistry` 和 `SessionPersistence`。Pair Web 是独立 origin；两个 iframe 通过 addressed-session 启动参数固定到各自 Session。这里没有另启一套只共享 JSONL 的 DSH Runtime。

## 2. 前置条件

- Node.js `>=22.19.0`；仓库固定 pnpm `11.7.0`。
- 已准备 `pair-agent/mvp/.runtime/deepseek-harness`，其 Git HEAD、补丁和官方构建产物与 `dsh.lock.json` 完全一致。
- DSH Web 前端必须已经完成 official build；浏览器 E2E 使用该 checkout 已安装的 Playwright/Chromium，不下载新浏览器。

首次准备或主动升级 DSH 基线是维护者操作，不属于普通 `verify`：

```bash
cd pair-agent/mvp
corepack pnpm@11.7.0 run prepare:source

# 在 prepared checkout 中安装依赖时应显式禁止 install/postinstall hooks，
# 再按团队审计过的依赖构建策略补齐所需二进制。
corepack pnpm@11.7.0 --dir .runtime/deepseek-harness install --frozen-lockfile --ignore-scripts
corepack pnpm@11.7.0 --dir .runtime/deepseek-harness run build:official

# 只有确认源码与 official build 都是新的受信基线后才更新 artifact lock。
corepack pnpm@11.7.0 run refresh:runtime-artifacts
```

普通开发者运行 `verify` 时不会安装依赖、访问模型 API、重建 DSH 或自动修改 lock。

## 3. 启动

默认使用无需 API Key 的确定性 capture Provider：

```bash
cd pair-agent/mvp
corepack pnpm@11.7.0 dev
```

首次启动会创建 `pair-demo`，运行一次 Navigator → Pilot harmless echo 演示，并打印实际 URL：

- Pair Web：`http://127.0.0.1:3070/pair.html?pairId=pair-demo`
- DSH Web/API：`http://127.0.0.1:3080`
- Pair Host：`http://127.0.0.1:3090`

再次使用同一 data root 启动时会恢复 Pair 与两条 DSH Session，不重复创建初始 Task。按 `Ctrl-C` 停止；Supervisor 严格按 Pair Web → Pair Host/Registry → hosted DSH Runtime 的顺序逐项等待关闭。Hosted Runtime 内部再依次关闭两个 Agent 与 DSH Context，避免两个所有者并发 dispose 同一个 Agent handle。

可配置项：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PAIR_DATA_ROOT` | `~/.pair-agent/phase0` | 必须是绝对路径，不会默认写入仓库 |
| `PAIR_ID` | `pair-demo` | 当前要创建或恢复的 Pair |
| `PAIR_WEB_PORT` | `3070` | Pair Shell；必须为 `1024..65535` |
| `DSH_WEB_PORT` | `3080` | 原生 DSH Host/API/Web |
| `PAIR_HOST_PORT` | `3090` | Pair API；三个端口必须互不相同 |

端口和 data root 在启动前严格校验；端口占用、部分服务启动失败或 readiness probe 失败都会触发上述逆序、顺序等待的清理。某一项失败不会跳过后续项，全部尝试结束后才汇总报告错误。

### 使用 OpenAI-compatible Chat Completions

以下三个变量必须一起提供：

```bash
export OPENAI_API_KEY='...'
export PAIR_OPENAI_BASE_URL='https://api.openai.com/v1'
export PAIR_OPENAI_MODEL='gpt-5'
export PAIR_OPENAI_API_KEY_ENV='OPENAI_API_KEY'
corepack pnpm@11.7.0 dev
```

可选 `PAIR_OPENAI_CONTEXT_WINDOW`（默认 `128000`）和 `PAIR_OPENAI_MAX_TOKENS`（默认 `4096`）。MVP 始终使用本地 Session 重建 continuation，不发送 Provider stateful continuation ID。

## 4. 界面中能看到什么

- Pair Header：共同 Pair ID、Goal/Task/Execution Plan projection、attention/pause 与连接状态。
- Navigator/Pilot：两个独立的原生 DSH transcript 与 composer；iframe URL 同时携带 `session` 和 `expectedSession`，刷新后仍固定在原 Session。
- Tool：capture 演示的 `phase0_echo` 会出现在 Pilot Chat 和 `Trajectory` 页签中。
- Sub-agent：Phase 0 的 `pair-safe` preset 未安装 delegation plugin。验收以 Provider request 的精确 tool allowlist 与原生 DSH UI/API 中不存在 child Session/入口为准；Pair Shell 不自行宣称运行时能力。P2 才考虑真实 Sub-agent/workflow 能力。
- Reasoning：只展示 Provider 明确返回并进入标准 Session Event 的 reasoning block。Provider 隐藏的 chain-of-thought 不存在可读取或展示的接口；capture demo 不伪造 reasoning。

用户可在各原生 Pane 查看该 Agent 的执行轨迹。涉及 Pair 共同事实或任务分派的输入应通过 Pair Host API 进入 Pair Ledger；直接在 iframe composer 中输入属于该 Agent 的本地会话输入，Phase 0 尚未把它提升为共同 Goal/Task 变更。

## 5. 持久化与恢复

默认 `PAIR_DATA_ROOT=~/.pair-agent/phase0`。以 `PAIR_ID=pair-demo` 为例，三类关键产物是：

1. Pair Ledger：`~/.pair-agent/phase0/pairs/pair-obqws4rnmrsw23y/pair.jsonl`。`pair.request_built` infrastructure event 内含不可变 Request Snapshot 与 digest。
2. Navigator Session：`~/.pair-agent/phase0/dsh-sessions/_no-cwd/pair~003Apair-demo~003Anavigator/session.jsonl`。
3. Pilot Session：`~/.pair-agent/phase0/dsh-sessions/_no-cwd/pair~003Apair-demo~003Apilot/session.jsonl`。

`dsh-storage/` 保存 Web projection/workspace 辅助状态，`dsh-home/` 保存该运行实例的隔离设置，`agent-presets/pair-safe/` 是运行时生成的安全 preset。它们都位于显式 data root 内。

恢复只依赖 Pair Ledger、两条本地 DSH Session Log 和固定版本材料；同一 data root 重启后，Pair Header 与历史 Request digest 必须保持一致。不要手工编辑 JSONL。

## 6. 验证

```bash
cd pair-agent/mvp
corepack pnpm@11.7.0 verify
```

该命令顺序执行：

1. prepared DSH Git/patch/runtime-artifact lock 校验；
2. Pair 全量测试（包含从 clean temp data root 启动的 Phase 0 capture/browser E2E）；
3. Pair typecheck 与 build；
4. DSH `agent/request-layout`、addressed-session、fixed-root Workspace guard 与 Composer unit regressions；
5. DSH 原生 addressed embedded Chromium regression。

Phase 0 E2E 真实创建 Pair，运行 Navigator，显式调用 Coordinator 分派 Task，让 Pilot 进入受门控的 harmless tool；在 Pilot 尚未结束时证明 Navigator 第二条消息已被接收并完成。随后它打开 Pair Web，核对两个 iframe 的 Session ID、Pilot tool/Trajectory 与 Sub-agent empty 状态，再停止、使用同一 data root 恢复并比对 Header、历史 digest、Pair JSONL 和两条 DSH JSONL。

`verify` 不调用 `install`/`postinstall`，不使用网络模型，也不读取真实 API Key。

## 7. 排错

- `EADDRINUSE`：修改三个端口之一，确保三者不同且目标端口未被占用。
- `runtime artifact integrity mismatch`：prepared checkout 或 official build 已漂移。不要直接改 lock；重新核对固定 commit、两份 patch 和 official build，再由维护者执行 artifact refresh。
- `frontend dist not built`：在固定 DSH checkout 完成 `build:official`，再刷新 runtime artifact lock。
- Pane 显示 addressed-session missing/mismatch：先确认 Pair Header 中的 Session ID 与 iframe URL 的 `session`、`expectedSession` 一致，并确认 Pair 已恢复。
- OpenAI 模式启动失败：检查 base URL、model、API-key 环境变量名三元组；Key 的值由 `PAIR_OPENAI_API_KEY_ENV` 指向的环境变量提供。
- 强制退出后恢复异常：保留 data root 进行检查。不要删除用户产物；复制 Pair Ledger、Navigator/Pilot JSONL 和错误日志后再做隔离复现。

## 8. 已知限制

- P1 Goal/Task 权限矩阵尚未实现；Phase 0 只保留后续能力所需的边界。
- durable append 与 delivery acknowledgement 之间的 crash window 尚未完成 P2 reconciliation。
- runtime artifact 校验会在 import 前后复查，但不能抵御同机恶意进程在 TOCTOU 窗口持续篡改文件。
- Provider 隐藏 chain-of-thought 不可见；界面只显示显式 reasoning block。
- OpenAI-compatible 路径已做本地装配和无网络 prepare-call 验证，本阶段没有把真实网络调用作为自动验收项。
- safe preset 只提供 Pair 注册的 harmless tool；启动时会校验全局及 Pair Agent scope 的 model-facing tool catalog 与配置 allowlist 完整 schema 精确一致，否则 fail closed。Sub-agent、workflow、shell、文件写入和网络搜索均不属于 Phase 0 dev 默认能力。即使这些工具未挂载，host 侧 sandbox-policy 与 fs-sandbox 的 fallback root 仍固定在 data root，默认策略为 read-only。
