# Pair Agent P0.5 MVP

这是一个基于固定 DeepSeek Harness（DSH）源码快照的本地探索原型。它验证一条 Pair Session 映射为两个独立 DSH Agent Session，由 Pair Web Shell 同时展示 Navigator 与 Pilot 的原生 DSH Web 会话，并把两条本地 Session 中可共享的用户输入与最终回答投影到同一 Pair Ledger。

它不是生产部署方案，也不声称实现 P1 的 Goal-impact/权限语义，或 P2 的 delivery crash-window exactly-once reconciliation、Sub-agent/workflow 等能力。

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

每条 DSH Session 的 durable event 由 Session-to-Pair Bridge 增量观察。Bridge 先写 canonical Pair Event，再写 `session_event.linked`；普通共享输出只更新 Pair projection/SSE，不会启动另一方 Turn。只有模型显式调用 `pair_message_peer` 才会在 Peer Event durable 后定向唤醒对方。

### 1.1 Prompt 与角色选择

- Navigator 与 Pilot 使用字节完全一致的 Common System；其中完整定义 Pair Contract、两个角色、共享事件解释、响应责任和 P0.5 能力边界。
- Host 在 Shared Context 和 Agent Local History 之后插入保留的 user-role `<system-reminder>`，选择本轮 Active Role：有严格结构化 Current Trigger 时紧邻其前，无 Trigger 的工具续接轮则作为最后一条消息。Reminder 只选择角色，不授予工具、不改变 Goal，也不创建权威 Pair 状态；用户输入或共享数据中的相似标签无效，合法用户 XML 不做转义或改写。
- Prompt material identity 对 Common System、Navigator guidance 和 Pilot guidance 三段实际 UTF-8 文本整体计算内容摘要。Runtime 会在 Provider 请求前重新校验实际材料，缺失或不匹配时 fail closed。
- P0.5 仍未提供结构化 Goal/Task/Execution Plan 控制、Goal-impact 分类、Revision fencing 或 Pause/Resume/Cancel 语义；Prompt 不得宣称这些 P1/P2 能力已经实现。

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

首次启动会在独立的 P0.5 data root 创建 `pair-demo`，运行一次 Navigator → Pilot harmless echo 演示，并打印实际 URL：

- Pair Web：`http://127.0.0.1:3070/pair.html?pairId=pair-demo`
- DSH Web/API：`http://127.0.0.1:3080`
- Pair Host：`http://127.0.0.1:3090`

再次使用同一 data root 启动时会恢复 Pair 与两条 DSH Session，不重复创建初始 Task。按 `Ctrl-C` 停止；Supervisor 严格按 Pair Web → Pair Host/Registry → hosted DSH Runtime 的顺序逐项等待关闭。Hosted Runtime 内部再依次关闭两个 Agent 与 DSH Context，避免两个所有者并发 dispose 同一个 Agent handle。

P0.5 的 immutable request materials 增加了 `pair_message_peer`，Pair protocol marker 也固定为 `pair-agent/p0.5`。因此默认 root 已从旧 `~/.pair-agent/phase0` 切到 `~/.pair-agent/p0.5`。当前是尚未发布的探索 MVP，不承诺本地运行数据向前兼容或提供生产迁移；Prompt/Tool 等不可变材料发生不兼容变化时，应停止服务并清理明确确认过的测试 data root，再重新创建 Pair。需要保留审计样本时必须在清理前另行复制，但这不是 runtime 自动迁移能力。

可配置项：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PAIR_DATA_ROOT` | `~/.pair-agent/p0.5` | 必须是绝对路径，不会默认写入仓库；不兼容变更后的本地测试数据可在明确确认范围后重置 |
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

可选 `PAIR_OPENAI_CONTEXT_WINDOW`（默认 `128000`）、`PAIR_OPENAI_MAX_TOKENS`（默认 `4096`）和 `PAIR_OPENAI_COMPATIBILITY`（`openai` 或 `deepseek`）。兼容模式默认根据 model ID 选择：`deepseek-*` 使用 `deepseek`，其他 model 使用 `openai`；私有网关的模型命名与其 wire protocol 不一致时应显式设置。DeepSeek 模式会按 thinking + tool continuation 规则回传 `reasoning_content`。MVP 始终使用本地 Session 重建 continuation，不发送 Provider stateful continuation ID。

## 4. 界面中能看到什么

- Pair Header：共同 Pair ID、Goal/Task/Execution Plan projection、attention/pause 与连接状态。
- Navigator/Pilot：两个独立的原生 DSH transcript 与 composer；iframe URL 同时携带 `session` 和 `expectedSession`，刷新后仍固定在原 Session。
- Pair-level input：每个 Pane 上方的 Pair form 先以 CAS 写 Pair Ledger，再定向投递到对应 Session。发生 `409` 时草稿保留，等待 projection 追上后必须显式复核并重试；结果未知时也保留草稿并提示先查 Session Events。
- Native DSH composer：iframe 内输入仍由 DSH 原生 `source.kind=user` 接收；其 durable `user/message` 会被 Bridge 投影为 shared `user.message`。这不会自动改写 Goal/Task，也不会唤醒另一方。
- Session Events：`Semantic` 隐藏 infrastructure records，适合阅读共同对话；`All / Audit` 使用 physical Pair sequence 展示 `session_event.linked`、`pair.request_built` 等完整审计记录。
- Tool：capture 演示的 `phase0_echo` 会出现在 Pilot Chat 和 `Trajectory` 页签中。
- Peer Message：两个角色的精确 tool allowlist 都包含 `pair_message_peer({ text })`。它每个 sender Turn 最多成功一次，Peer Event 必须先 durable 才会唤醒对方；双向回复保持同一 `causalRootId`，hop 逐次增加，最多四跳，第五跳 fail closed 且不 append、不 wake。模型参数不能指定 authority、目标 Session、wake、causal root 或 hop。
- Sub-agent：P0.5 的 `pair-safe` preset 未安装 delegation plugin。验收以 Provider request 的精确 tool allowlist 与原生 DSH UI/API 中不存在 child Session/入口为准；Pair Shell 不自行宣称运行时能力。P2 才考虑真实 Sub-agent/workflow 能力。
- Reasoning：只展示 Provider 明确返回并进入标准 Session Event 的 reasoning block。Provider 隐藏的 chain-of-thought 不存在可读取或展示的接口；capture demo 不伪造 reasoning。

用户可在各原生 Pane 查看该 Agent 的执行轨迹。无论输入来自 Pair form 还是 native composer，共享 conversation 都只从 durable Session/Pair facts 派生；普通 Agent 最终回答必须等对应 durable `turn/end` 后才发布为 complete shared `agent.message`。普通对话共享是 passive 的，只有 Pair 命令或 `pair_message_peer` 才会启动目标 Turn。

## 5. 持久化与恢复

默认 `PAIR_DATA_ROOT=~/.pair-agent/p0.5`。以 `PAIR_ID=pair-demo` 为例，三类关键产物是：

1. Pair Ledger：`~/.pair-agent/p0.5/pairs/pair-obqws4rnmrsw23y/pair.jsonl`。`pair.request_built` infrastructure event 内含不可变 Request Snapshot 与 digest。
2. Navigator Session：`~/.pair-agent/p0.5/dsh-sessions/_no-cwd/pair~003Apair-demo~003Anavigator/session.jsonl`。
3. Pilot Session：`~/.pair-agent/p0.5/dsh-sessions/_no-cwd/pair~003Apair-demo~003Apilot/session.jsonl`。

`dsh-storage/` 保存 Web projection/workspace 辅助状态，`dsh-home/` 保存该运行实例的隔离设置，`agent-presets/pair-safe/` 是运行时生成的安全 preset。它们都位于显式 data root 内。

恢复只依赖 Pair Ledger、两条本地 DSH Session Log 和固定版本材料；同一 data root 重启后，Pair Header 与历史 Request digest 必须保持一致。P0.5 为短日志原型，恢复会 full-scan 两条 durable Session logs，并只补缺失的 canonical Pair Event/link；重复重启必须幂等。不要手工编辑 JSONL。

Pair vocabulary 只写 Pair Ledger，DSH JSONL 只保留 DSH Session Event vocabulary；Bridge 不向 DSH fork 回写 Pair custom event。

## 6. 验证

```bash
cd pair-agent/mvp
corepack pnpm@11.7.0 verify
```

该命令顺序执行：

1. prepared DSH Git/patch/runtime-artifact lock 校验；
2. Pair 全量测试（包含 legacy Phase 0 browser regression，以及从 clean temp root 启动的 P0.5 passive sharing、native composer、Peer round-trip 和 crash/restart capture E2E）；
3. Pair typecheck 与 build；
4. DSH `agent/request-layout`、addressed-session、fixed-root Workspace guard 与 Composer unit regressions；
5. DSH 原生 addressed embedded Chromium regression。

P0.5 E2E 使用 clean temp root 与 capture Provider：验证 ordinary conversation passive sharing、later peer request 的 Shared Events 恰好一次、native composer 的 durable ordering、双向 Peer Message 与四跳上限，以及在 DSH message durable、Pair link 尚未写入时崩溃后的两次幂等恢复。测试直接读取临时 Pair/DSH artifacts 并在结束时自行清理，不依赖人工保留目录。

`verify` 不调用 `install`/`postinstall`，不使用网络模型，也不读取真实 API Key。

## 7. 排错

- `EADDRINUSE`：修改三个端口之一，确保三者不同且目标端口未被占用。
- `runtime artifact integrity mismatch`：prepared checkout 或 official build 已漂移。不要直接改 lock；重新核对固定 commit、两份 patch 和 official build，再由维护者执行 artifact refresh。
- `frontend dist not built`：在固定 DSH checkout 完成 `build:official`，再刷新 runtime artifact lock。
- Pane 显示 addressed-session missing/mismatch：先确认 Pair Header 中的 Session ID 与 iframe URL 的 `session`、`expectedSession` 一致，并确认 Pair 已恢复。
- OpenAI 模式启动失败：检查 base URL、model、API-key 环境变量名三元组；Key 的值由 `PAIR_OPENAI_API_KEY_ENV` 指向的环境变量提供。
- 强制退出后恢复异常：保留 data root 进行检查。不要删除用户产物；复制 Pair Ledger、Navigator/Pilot JSONL 和错误日志后再做隔离复现。

## 8. 已知限制

- P1 Goal-impact 判断、Goal/Task 权限矩阵、Revision fencing 与 Pause/Resume/Cancel 语义尚未实现；P0.5 只保留后续能力所需的边界。
- P0.5 的正常运行使用内存 Session cursor，恢复时 full-scan 短日志。持久化 per-Agent unread cursor、Shared Checkpoint 与长日志增量恢复属于 P2。
- durable Peer/Pair append 与 delivery acknowledgement 之间的 crash window 尚未完成 P2 exactly-once reconciliation；P0.5 不声称已经解决。
- runtime artifact 校验会在 import 前后复查，但不能抵御同机恶意进程在 TOCTOU 窗口持续篡改文件。
- Provider 隐藏 chain-of-thought 不可见；界面只显示显式 reasoning block。
- OpenAI-compatible 路径已做本地装配和无网络 prepare-call 验证，本阶段没有把真实网络调用作为自动验收项。
- safe preset 只提供 Pair 注册的 `pair_message_peer` 与演示用 harmless tool；启动时会校验全局、assembled Provider boundary 及 Pair Agent scope 的 model-facing tool catalog 与配置 allowlist 完整 schema 精确一致，否则 fail closed。Sub-agent、workflow、shell、文件写入和网络搜索均不属于 P0.5 dev 默认能力。即使这些工具未挂载，host 侧 sandbox-policy 与 fs-sandbox 的 fallback root 仍固定在 data root，默认策略为 read-only。
