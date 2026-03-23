# OpenClaw 深度指南：部署、自动化与安全架构

## 一、OpenClaw 概述

OpenClaw（前身为 Clawdbot → Moltbot）是一个开源的、自托管的 24/7 AI 助手框架。它运行在用户自己的硬件上，通过 Gateway 守护进程连接到 Telegram、WhatsApp、Feishu、Discord 等消息平台，能够执行代码、浏览网页、管理文件，并在用户不在线时通过 heartbeat 和 cron 机制自主工作。
其核心架构为单进程 Node.js Gateway，内部集成了 Channel Adapter（20+ 消息平台）、Agent 执行引擎（agentic loop + tools）、Memory 系统（文件 + 向量搜索）、Cron 调度器、Docker 沙箱、浏览器自动化和 Sub-agent 系统[[Inside OpenClaw: How This AI Agent Actually Works Under the Hood](https://www.linkedin.com/pulse/inside-openclaw-how-ai-agent-actually-works-under-hood-ajith-raghavan-eqahc)]。
---

## 二、部署实践
### 2.1 核心依赖
部署 OpenClaw 需要以下基础依赖：
- **Node.js 22+**：OpenClaw 的运行时基础
- **操作系统**：macOS、Linux（推荐 Ubuntu 22.04+）或 Windows WSL2
- **API 密钥**：至少一个 LLM 提供商（Anthropic / OpenAI / Google 等）
- **消息平台凭证**：Telegram Bot Token、WhatsApp Business API、Feishu App 等
- **Docker**（推荐）：用于沙箱隔离执行
- **硬件**：最低 1 vCPU / 1GB RAM，推荐 2 vCPU / 4GB RAM
### 2.2 主流部署目标
#### 英文社区推荐

| 部署目标 | 推荐程度 | 适用场景 | 代表方案 |
| --- | --- | --- | --- |
| **Cloud VPS** | 最广泛推荐 | 入门、长期运行 | Hetzner CAX11（€3.79/月）、DigitalOcean（$6/月）、AWS Lightsail |
| **Mac Mini** | 社区"信仰级"硬件 | 性能敏感、本地 AI 模型 | Mac Mini M4（$499 起），社区称之为"lobster's home" |
| **混合架构** | 进阶方案 | VPS 保活 + Mac 算力 | VPS 运行 Gateway + Cloudflare Tunnel 回连家中 Mac Mini |
| **托管平台** | 最省心 | 不想运维 | Railway、Render、Fly.io |
| **Raspberry Pi** | 实验性 | 极致低成本 | Pi 5 8GB，需要 swap + 外接 SSD |

**社区共识的渐进路径**：VPS 入门 → Mac Mini 升级 → 混合架构终极形态。
Hetzner CAX11（ARM64 VPS）被 Reddit 社区反复推荐为最佳性价比起点，月费不到 $4 即可获得 2 vCPU / 4GB RAM[[Patterns I've learned running OpenClaw 24/7 for 2 weeks - Reddit](https://www.reddit.com/r/openclaw/comments/1r1zk45/patterns_ive_learned_running_openclaw_247_for_2/)]。
#### 中文社区差异
中文社区在部署目标选择上与英文社区有显著差异：

| 维度 | 英文社区 | 中文社区 |
| --- | --- | --- |
| **首选 VPS** | Hetzner、DigitalOcean | 阿里云、腾讯云、UCloud、火山引擎 |
| **Mac Mini 态度** | "信仰级"，热情推荐 | 认可但更务实，考虑性价比 |
| **企业方案** | AWS / GCP 标准实例 | AWS Mac 云实例（按需弹性） |
| **Serverless** | 少见讨论 | Cloudflare Workers（边缘部署） |
| **消息平台** | Telegram / WhatsApp / Discord | 飞书 / 钉钉 |
| **模型偏好** | Claude / GPT 为主 | DeepSeek / Qwen / Kimi 作为低成本替代 |

中文社区更关注国内网络环境下的可达性和延迟，倾向于选择有国内节点的云服务商。
### 2.3 部署步骤概览
1. **选择部署环境**（VPS / Mac Mini / 混合）
2. **安装基础依赖**（Node.js 22+、Docker、Git）
3. **安装 OpenClaw**（npm 全局安装或 Git clone）
4. **运行 **`**openclaw onboard**`（交互式初始化，生成 `openclaw.json`）
5. **配置消息 Channel**（Telegram Bot Token / WhatsApp 等）
6. **配置安全策略**（沙箱、工具策略、DM 配对）
7. **启动 Gateway**（`openclaw gateway start`，建议配合 systemd 或 PM2 守护）
### 2.4 安全最佳实践
- **始终启用 Docker 沙箱**（`sandbox.mode: "all"`）
- **使用 Cloudflare Tunnel 反向代理**，避免直接暴露端口
- **非 root 用户运行**，限制文件权限
- **DM 配对策略**（`dmPolicy: "pairing"`），陌生人需要配对码
- **永远不要在主力工作机器上运行 OpenClaw**
---

## 三、自动化机制
OpenClaw 提供了三套互补的自动化机制：Heartbeat（心跳）、Cron（定时任务）和 System Event（系统事件）。
### 3.1 Heartbeat（心跳）
Heartbeat 是 OpenClaw 的**周期性自检机制**。Gateway 按配置的间隔（默认 30 分钟）在主 session 中触发一次 agent turn，agent 读取 `HEARTBEAT.md` 中定义的检查项，判断是否有需要关注的事项[[The 3 Superpowers of OpenClaw for a Truly Autonomous Agent](https://blog.kryll.io/openclaw-hooks-cron-heartbeat-ai-agent-automation/)]：
- 如果一切正常 → agent 回复 `HEARTBEAT_OK`（静默，不投递到 channel）
- 如果有异常 → agent 回复告警文本（投递到配置的 target）
**关键配置**：
```plaintext
{
 agents: {
 defaults: {
 heartbeat: {
 every: "30m", // 心跳间隔
 target: "last", // 回复投递目标（默认 "none"！）
 },
 },
 },
}
```

**重要注意**：`target` 的默认值是 `"none"`，即 heartbeat 的回复**不会投递到任何外部 channel**，只留在内部 session 中。如果希望回复发送到用户最后交互的 channel，必须显式设为 `"last"`[[Heartbeat - OpenClaw](https://docs.openclaw.ai/gateway/heartbeat)]。
### 3.2 Cron（定时任务）
Cron 用于设定精确时间触发的定时任务，支持标准 cron 表达式。与 heartbeat 的区别是[[The 3 Superpowers of OpenClaw for a Truly Autonomous Agent](https://blog.kryll.io/openclaw-hooks-cron-heartbeat-ai-agent-automation/)]：

| 维度 | Heartbeat | Cron |
| --- | --- | --- |
| 触发方式 | 固定间隔 | cron 表达式 / 一次性 |
| 执行上下文 | 主 session（有完整对话历史） | 可选主 session 或隔离 session |
| 适用场景 | 状态巡检、被动监控 | 精确定时任务（日报、周报、提醒） |
| 持久性 | 随 Gateway 启停 | 持久化到配置文件 |

Cron 的两种模式：
- **主 session cron**：通过 `payload.kind = "systemEvent"` 注入事件到主 session，走 heartbeat 流程处理
- **隔离 session cron**（`kind: "agentTurn"`）：创建独立 session 执行，投递路径更直接
### 3.3 System Event（系统事件）
`openclaw system event` 是一个 CLI 命令，用于向主 session 的事件队列注入**一次性的临时事件**[[System - OpenClaw](https://docs.openclaw.ai/cli/system)]。
**基本语法**：
```bash
openclaw system event --text "<内容>" --mode <now|next-heartbeat>
```

**参数说明**：

| 参数 | 说明 |
| --- | --- |
| `--text` | 事件内容文本 |
| `--mode now` | 立即触发一次 heartbeat 来处理该事件 |
| `--mode next-heartbeat` | 等待下一次定时 heartbeat 时处理（默认） |

**与 Cron 的区别**：System Event 是临时的一次性事件，不持久化（重启后丢失）；Cron 是持久化的定时任务。System Event 适合需要立即或尽快让 agent 处理某件事的场景，比如从外部脚本触发 agent 执行某个操作。
**重要限制**：System Event 通过 heartbeat 处理和投递，因此受 heartbeat 的 `target` 配置约束。如果 `target` 为默认的 `"none"`，agent 处理了事件并生成了回复，但回复**不会被投递到任何外部 channel**——这是一个常见的困惑点，在网页后台能看到 agent 确实回复了，但 Telegram / 飞书等 channel 上收不到。解决方法就是将 heartbeat 的 `target` 设为 `"last"`。
社区已知的其他投递相关问题包括：heartbeat 投递目标混淆（可能发到错误的对话）、webchat channel 间歇性丢弃 heartbeat 事件、`--mode now` 可能因 heartbeat 合并机制产生最多 30 秒延迟。
---

### 3.4 外部→Agent 通信方式对比
System Event 并非从外部触达 Agent 的唯一途径。OpenClaw 提供了四种不同的外部→Agent 通信方式，各自在执行路径、是否触发 agent turn、channel 投递行为上有显著差异。
#### 四种通信方式概览

| 方式 | 类型 | 是否触发 Agent Turn | Channel 投递 | 是否持久化 |
| --- | --- | --- | --- | --- |
| `openclaw system event` | CLI 命令 | 间接（通过 heartbeat） | 受 heartbeat target 约束 | 否（重启丢失） |
| `openclaw agent --message` | CLI 命令 | 是（直接） | `--deliver` 显式控制 | 否 |
| `sessions_send` | Agent 工具 | 否（纯消息注入） | 不涉及（session 间通信） | 否 |
| `openclaw message send` | CLI 命令 | 否 | 是（纯投递） | 否 |

#### 方式一：`openclaw system event`
前文 3.3 节已详细介绍。事件注入到主 session 的事件队列，必须等待 heartbeat 处理。`--mode now` 可以立即触发一次 heartbeat，但仍走 heartbeat 投递路径，受 `target` 配置约束。
**优势**：事件在主 session 上下文中处理，agent 可访问完整对话历史。
**劣势**：投递受 heartbeat target 约束；`--mode next-heartbeat` 有延迟；heartbeat 合并机制可能导致事件被批量处理。
#### 方式二：`openclaw agent --message`（推荐替代方案）
直接在指定 agent 上触发一次完整的 agent turn，不经过 heartbeat 路径。这是 System Event 最直接的替代方案。
```bash
# 触发 agent turn 并将回复投递到最后交互的 channel
openclaw agent --message "请检查服务器状态" --deliver last

# 触发 agent turn 但不投递（仅留在 session 内）
openclaw agent --message "更新内部状态记录"

# 指定投递到特定 channel
openclaw agent --message "日报生成完毕" --deliver <channel-id>

```

**关键特性**：
- **直接触发 agent turn**：不需要等待或依赖 heartbeat，消息立即被 agent 处理
- **--deliver 参数独立控制投递**：可以设为 `last`（最后交互的 channel）、具体 channel ID 或不设（不投递），完全不受 heartbeat target 影响
- **在主 session 中执行**：agent 拥有完整的对话历史上下文
**与 System Event 的关键区别**：System Event 是"把事件放入队列等 heartbeat 来处理"，而 `openclaw agent --message` 是"立刻让 agent 处理这条消息并按我指定的方式投递"。后者的投递路径更直接、更可控。
#### 方式三：`sessions_send`
这是一个 **agent 工具**（不是 CLI 命令），用于 agent-to-agent 的 session 间通信。只能在 agent turn 执行过程中由 agent 自己调用，不能从外部 CLI 直接触发。
**适用场景**：主 agent 需要向 sub-agent 发送消息，或 sub-agent 向主 session 回报结果。
**不适合替代 System Event**：因为 `sessions_send` 只能从 agent 内部调用，无法从外部脚本或 CLI 发起。
#### 方式四：`openclaw message send`
纯粹的消息投递工具，将文本发送到指定的 channel，**不触发任何 agent turn**。
```bash
openclaw message send --channel <channel-id> --text "纯通知消息"

```

**适用场景**：外部系统需要通过 OpenClaw 的 channel 基础设施发送通知（如 CI/CD 通知、监控告警），但不需要 agent 参与处理。
**不适合替代 System Event**：因为它完全跳过了 agent，只是消息管道。
#### 场景选择指南

| 场景 | 推荐方式 | 原因 |
| --- | --- | --- |
| 外部脚本触发 agent 执行任务并回复到 channel | `openclaw agent --message --deliver last` | 直接触发 + 可控投递 |
| 定期巡检，仅异常时通知 | Heartbeat + `target: "last"` | 原生支持 OK/告警二态 |
| 精确定时任务（日报等） | Cron（`kind: agentTurn`） | 持久化 + 精确调度 |
| Agent 间协作通信 | `sessions_send` | 专为 session 间设计 |
| 纯通知（不需 agent 处理） | `openclaw message send` | 最轻量 |
| 临时注入上下文到主 session | `openclaw system event` | 不需要立即处理时仍有价值 |

#### 结论
如果目标是"从外部让 agent 处理某件事并把结果发到 channel"，**openclaw agent --message --deliver 是 System Event 的最佳替代方案**。它解决了 System Event 的两个核心痛点：不需要依赖 heartbeat 处理（无延迟）、投递路径独立可控（不受 heartbeat target 约束）。System Event 在"临时注入上下文、不需要立即处理"的场景下仍然有其价值，但对于需要即时响应和可靠投递的场景，`openclaw agent --message` 是更优选择。
---

## 四、Agent 的自我认知机制
### 4.1 系统提示词的组装
OpenClaw 为每次 agent 运行构建一个**定制的系统提示词**，不使用底层 LLM 的默认 prompt。这个 prompt 由 `buildAgentSystemPrompt()` 函数组装，源码位于 [`src/agents/system-prompt.ts`](https://github.com/openclaw/openclaw/blob/main/src/agents/system-prompt.ts)[[System Prompt - OpenClaw](https://docs.openclaw.ai/concepts/system-prompt)]。
系统提示词按固定顺序包含以下分区：

| 分区 | 作用 | promptMode=minimal 时是否保留 |
| --- | --- | --- |
| Identity | 基础身份声明 | 是 |
| Tooling | 完整工具列表 + 摘要 | 是 |
| Tool Call Style | 工具调用风格指引 | 是 |
| Safety | 安全护栏指令 | 是 |
| CLI Quick Reference | OpenClaw CLI 命令参考 | 是 |
| Skills | 可用 Skill 列表 | 否 |
| Memory Recall | 记忆检索指引 | 否 |
| Self-Update | 自更新指令 | 否 |
| Model Aliases | 模型别名 | 否 |
| Workspace | 工作目录 | 是 |
| Documentation | 文档路径 | 否 |
| Sandbox | 沙箱信息 | 是（启用时） |
| Authorized Senders | 授权发送者 | 否 |
| Current Date & Time | 时区信息 | 否 |
| Workspace Files | 引导文件列表声明 | 是 |
| Reply Tags | 回复标签语法 | 否 |
| Messaging | 消息路由指引 | 否 |
| Project Context | bootstrap 文件内容注入 | 部分（仅 AGENTS.md + TOOLS.md） |
| Silent Replies | 静默回复规则 | 否 |
| Heartbeats | 心跳行为说明 | 否 |
| Runtime | 运行时环境信息 | 是 |

### 4.2 Agent 知道什么，不知道什么
Agent 的"自我认知"不是天生的，而是通过**系统提示词注入 + workspace bootstrap 文件注入**两层机制实现的。
**Agent 确实知道的**（自动注入）：

| 能力 | 注入机制 |
| --- | --- |
| 可用工具列表（read、exec、cron、sessions_spawn 等） | system prompt 的 Tooling 分区 |
| Heartbeat 机制 | system prompt 的 Heartbeats 分区 + `HEARTBEAT.md` 注入 |
| Sub-agent / sessions_spawn | 工具列表 + Tooling 分区说明 |
| sessions_send 跨会话消息 | 工具列表 + Messaging 分区说明 |
| Cron 定时任务 | 工具列表 + 工具摘要 |
| Memory 工具 | 工具列表 + Memory Recall 分区 |
| 本地文档位置 | Documentation 分区 |

**Agent 不直接知道的**（需要额外引导）：

| 内容 | 原因 |
| --- | --- |
| `openclaw system event` CLI 命令 | Gateway 层面的 CLI，不是 agent 工具 |
| Heartbeat target 配置细节 | Gateway 投递层面的行为，agent 不可见 |
| Channel 路由和投递机制 | Gateway 层面行为 |
| 自身 token 消耗和上下文限制 | 需要调用 `session_status` 查询 |
| 其他 agent 的存在 | 需通过 `agents_list` 工具或 AGENTS.md 声明 |

**Sub-agent 的认知更受限**：Sub-agent 使用 `minimal` prompt mode，只注入 `AGENTS.md` + `TOOLS.md`，不注入 SOUL.md、HEARTBEAT.md、USER.md 等[[Sub-Agents - OpenClaw Docs](https://docs.openclaw.ai/tools/subagents)]。
### 4.3 Workspace Bootstrap 文件
以下文件在**每一轮对话**中自动注入到 system prompt 的 `# Project Context` 区域[[System Prompt - OpenClaw](https://docs.openclaw.ai/concepts/system-prompt)]：

| 文件 | 作用 |
| --- | --- |
| `SOUL.md` | Agent 的人格、语调、行为边界 |
| `AGENTS.md` | 操作规则、习得的教训、工作流策略 |
| `TOOLS.md` | 外部工具使用指南 |
| `IDENTITY.md` | 身份信息 |
| `USER.md` | 用户上下文、目标、偏好 |
| `HEARTBEAT.md` | heartbeat 时要检查的内容 |
| `MEMORY.md` | 长期记忆（精选） |

这些文件**消耗 token**，需保持精简。单个文件上限 `bootstrapMaxChars`（默认 20000），所有文件总量上限 `bootstrapTotalMaxChars`（默认 150000）。
### 4.4 扩展 Agent 认知的最佳实践
如果希望 agent 更合理地使用各种能力，最佳做法是在 `AGENTS.md` 中**显式写出决策规则**[[Patterns I've learned running OpenClaw 24/7 for 2 weeks - Reddit](https://www.reddit.com/r/openclaw/comments/1r1zk45/patterns_ive_learned_running_openclaw_247_for_2/)]：
```markdown
## 工作策略
- 需要定时执行的任务 → 使用 cron 工具
- 长时间运行或可并行的任务 → spawn sub-agent
- 需要向用户主动推送消息 → 使用 sessions_send
- routine 状态检查 → 通过 HEARTBEAT.md 在 heartbeat 周期中完成
```

Agent 看到工具列表后**知道能用什么工具**，但**不一定知道什么时候该用哪个**——这个决策智慧需要通过 workspace 文件"教"给它。
---

## 五、安全架构
### 5.1 Safety 提示词
在 system prompt 的 Safety 分区中，有三条硬编码的安全指令（源码位于 `src/agents/system-prompt.ts` 的 `safetySection` 变量）：

| 规则 | 内容 |
| --- | --- |
| 无独立目标 | 不追求自我保存、自我复制、资源获取或权力扩张；不进行超出用户请求的长期规划 |
| 优先安全和人类监督 | 安全和人类监督优先于任务完成；指令冲突时暂停并询问；服从停止/暂停/审计请求，绝不绕过安全机制。灵感来自 Anthropic 宪法 |
| 不操纵、不扩权 | 不操纵或说服任何人扩大访问权限或关闭安全机制；不复制自身或修改系统提示词、安全规则、工具策略（除非明确要求） |

**关键特征**：
- Safety 是**硬编码**的，没有配置项可以修改（`agents.defaults.safetyPrompt` 不存在）
- 在 `promptMode=minimal`（sub-agent）和 `promptMode=full`（主 agent）下**都会注入**
- 官方明确声明：Safety 提示词是 **advisory（建议性的）**，不是强制执行的[[System Prompt - OpenClaw](https://docs.openclaw.ai/concepts/system-prompt)]
### 5.2 多层安全架构
Safety 提示词中提到的"安全机制"和"安全规则"，实际指向 OpenClaw 完整的 **6 层安全架构**：
#### 第 1 层：Tool Policy（工具策略）— 硬执行
决定 agent **能用哪些工具**。配置在 `openclaw.json` 中的 `tools.allow` / `tools.deny`。`deny` 总是优先级最高，被 deny 的工具无论如何不可调用[[Sandbox vs Tool Policy vs Elevated - OpenClaw Docs](https://docs.openclaw.ai/gateway/sandbox-vs-tool-policy-vs-elevated)]。
```plaintext
{
 tools: {
 deny: ["gateway", "cron"], // 完全禁止这些工具
 allow: ["read", "write", "exec", "web_search"], // 白名单模式
 }
}
```

支持工具分组简写：`group:runtime`（exec, bash, process）、`group:fs`（read, write, edit, apply_patch）、`group:sessions`、`group:automation` 等。
#### 第 2 层：Sandbox（沙箱）— 隔离执行
决定工具**在哪里执行**。通过 `agents.defaults.sandbox.mode` 控制[[Sandboxing - OpenClaw Docs](https://docs.openclaw.ai/gateway/sandboxing)]：

| 模式 | 行为 |
| --- | --- |
| `"off"` | 所有工具在宿主机执行 |
| `"non-main"` | 只有非主 session 在 Docker 中执行 |
| `"all"` | 所有 session 都在 Docker 中执行 |

沙箱的文件系统隔离、网络隔离和进程隔离确保即使 agent 被 prompt injection 攻击，破坏范围也被限制在容器内。
#### 第 3 层：Exec Approvals（执行审批）— 人类在环
即使工具可用、脱离沙箱，exec 命令仍需人类审批。支持 allowlist 模式（只允许预批准的命令模式）和 always-ask 模式。
#### 第 4 层：Elevated Mode（提权）— Exec 的受控逃逸
沙箱内的 agent 需要在宿主机执行命令时的受控机制。默认关闭，需显式启用并配置发送者白名单。Elevated 只影响 exec，不授予额外工具[[Sandbox vs Tool Policy vs Elevated - OpenClaw Docs](https://docs.openclaw.ai/gateway/sandbox-vs-tool-policy-vs-elevated)]。
#### 第 5 层：Channel Access Control（频道访问控制）
从入口处控制谁能和 agent 说话。包括 DM 配对策略（`dmPolicy: "pairing"`）、DM 白名单（`allowFrom`）、群组策略（`groupPolicy`）和群组白名单[[Security - OpenClaw](https://docs.openclaw.ai/gateway/security)]。
#### 第 6 层：System Prompt Safety（提示词安全）
就是上述三条硬编码的安全指令。这是**最软的一层**，纯建议性质。
### 5.3 安全执行的优先级
```plaintext
消息进入 → [第 5 层] Channel 访问控制 → [第 6 层] 提示词安全（建议性）
 → [第 1 层] Tool Policy（硬拒绝） → [第 2 层] Sandbox（隔离执行）
 → [第 4 层] Elevated（宿主机逃逸） → [第 3 层] Exec Approvals（人类审批）
 → 命令执行
```

### 5.4 Control Plane 风险
`gateway` 和 `cron` 这两个工具可以做**持久化的控制面变更**。一个被 prompt injection 攻击的 agent 如果拥有 `gateway` 工具，理论上可以通过 `config.apply` 修改安全配置（关闭沙箱、放开工具限制）。这正是 Safety 提示词中"不要修改 tool policies"存在的原因——但提示词防御是软性的。对于不受信任的场景，应在 Tool Policy 层面直接 deny 掉 `gateway` 和 `cron`[[Security - OpenClaw](https://docs.openclaw.ai/gateway/security)]：
```plaintext
{
 tools: {
 deny: ["gateway", "cron", "sessions_spawn", "sessions_send"],
 }
}
```

### 5.5 安全配置的核心原则
OpenClaw 官方安全文档的核心理念是：**"Identity first, scope next, model last"**——先控制谁能说话（Channel Access），再控制能做什么（Tool Policy + Sandbox），最后才考虑模型层面的防护（Safety prompt）。仅依赖提示词层面的 Safety 而不配置前几层硬执行机制，安全防线实际上是不存在的[[Security - OpenClaw](https://docs.openclaw.ai/gateway/security)]。
---

## 六、Memory 系统
OpenClaw 的记忆系统遵循 **"file-first" 哲学**——Markdown 文件是唯一的持久化真实来源。框架本身不会自动创建或写入记忆文件，所有写入动作必须由 agent（LLM）通过文件写入工具执行[[Memory - OpenClaw Docs]](https://docs.openclaw.ai/concepts/memory)。
### 6.1 记忆架构的四个层次
OpenClaw 的"记忆"并非单一系统，而是由四个独立层次组成，各自有不同的持久性和失效模式[[OpenClaw Memory Masterclass]](https://velvetshark.com/openclaw-memory-masterclass)：

| 层次 | 内容 | 持久性 | 失效方式 |
| --- | --- | --- | --- |
| Bootstrap 文件（SOUL.md、AGENTS.md、MEMORY.md 等） | 每次 session 启动从磁盘加载 | 永久——经受一切 | 仅磁盘文件被删除时 |
| Session 转录（磁盘上的 JSONL） | 对话历史，每轮重建到上下文 | 半永久 | Compaction 时被压缩摘要替代 |
| LLM 上下文窗口（内存中） | 模型当前"看到"的全部内容 | 临时——固定大小 | 溢出时触发 compaction |
| 检索索引（memory_search / QMD） | 对 memory 文件的可搜索索引 | 永久——从文件重建 | 仅文件被删除时 |

**核心原则**：如果信息没有被写入文件，它就只存在于 LLM 上下文窗口中——一旦 compaction 或 session 重置，就会永久丢失。
### 6.2 Compaction 与 Pruning
Compaction 和 Pruning 是两个完全不同的系统，但经常被混淆：

| 维度 | Compaction（压缩） | Pruning（修剪） |
| --- | --- | --- |
| 作用 | 将整个对话历史压缩为摘要 | 裁剪旧的工具返回结果 |
| 触发条件 | 上下文窗口接近溢出 | 按 cache TTL 配置 |
| 影响范围 | 所有消息类型（用户、助手、工具调用） | 仅 toolResult 消息 |
| 是否改变磁盘记录 | 否（磁盘转录不变，但模型看到的变了） | 否（仅影响当次请求） |
| 可逆性 | 不可逆——模型此后只能看到摘要 | 可逆——下次请求可重新加载 |
| 危害程度 | 高——丢失指令、偏好、上下文细节 | 低——只是暂时看不到旧工具输出 |

**Compaction 会摧毁的内容**：
- 对话中给出的指令（最大杀手）
- 偏好、修正、决策等中途给出的信息
- compaction 之前分享的所有图片
- 工具返回结果及其上下文
**经受 Compaction 的内容**：
- 所有 workspace 文件（SOUL.md、AGENTS.md、MEMORY.md 等——从磁盘重新加载）
- 每日记忆日志（通过 memory_search 按需检索）
- agent 在 compaction 之前写入磁盘的一切
### 6.3 `memory/YYYY-MM-DD.md` 的创建机制
这是一个常见困惑点：**OpenClaw 不会自动创建每日记忆文件**。`memory/YYYY-MM-DD.md` 的创建完全依赖 agent 调用文件写入工具（write/edit），而 agent 是否会主动写入，取决于以下条件：
#### 写入路径一：Pre-compaction Memory Flush（自动触发）
当 session 上下文接近 compaction 阈值时，Gateway 注入一个**静默的 agentic turn**，提示 agent 把重要内容保存到 `memory/YYYY-MM-DD.md`[[Memory - OpenClaw Docs]](https://docs.openclaw.ai/concepts/memory)。
```plaintext
{
 agents: {
 defaults: {
 compaction: {
 reserveTokensFloor: 40000, // 默认 20000，建议提高
 memoryFlush: {
 enabled: true,
 softThresholdTokens: 4000,
 systemPrompt: "Session nearing compaction. Store durable memories now.",
 prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
 },
 },
 },
 },
}

```

**触发公式**：`contextWindow - reserveTokensFloor - softThresholdTokens`。以 200K 上下文窗口、推荐配置为例：`200000 - 40000 - 4000 = 156000` tokens 时触发。
**关键问题**：如果对话比较短，上下文使用量从未接近阈值，这条路径**永远不会被触发**——这是大多数用户的记忆文件从不被创建的首要原因。
#### 写入路径二：AGENTS.md 中的 Memory Protocol 驱动
在 `AGENTS.md` 中定义记忆规则，让 agent 在特定场景下主动写入：
```markdown
## Memory Protocol
- Before answering questions about past work: search memory first
- Before starting any new task: check memory/today's date for active context
- When you learn something important: write it to the appropriate file immediately
- When corrected on a mistake: add the correction as a rule to MEMORY.md
- When a session is ending or context is large: summarize to memory/YYYY-MM-DD.md

```

没有这个规则 → agent 不知道什么时候该写 → 文件永远不会被创建[[OpenClaw Memory Masterclass]](https://velvetshark.com/openclaw-memory-masterclass)。
#### 写入路径三：用户明确要求
直接告诉 agent "保存到今天的记忆文件"或"记住这个"，agent 才会执行写入。这也是为什么"除非要求，否则从不记录"——因为另外两条路径都没有被正确配置。
#### 为什么你的 agent 从不创建记忆文件

| 原因 | 概率 | 说明 |
| --- | --- | --- |
| 对话从未达到 compaction 阈值 | 最高 | 短对话中 pre-compaction flush 永远不会触发 |
| AGENTS.md 缺少 Memory Protocol | 高 | agent 没有被"教会"主动记忆 |
| memoryFlush.enabled 可能为 false | 中 | 需要检查 openclaw.json 配置 |
| reserveTokensFloor 太小 | 中 | 默认 20000，容易被大的 tool output 跳过 |
| Agent 自主判断不写入 | 低 | LLM 认为没有值得记录的内容 |

### 6.4 Memory 文件体系
OpenClaw 的文件体系分为两类：
**Bootstrap 文件**（每轮注入上下文，消耗 token）：

| 文件 | 存放内容 | 注意事项 |
| --- | --- | --- |
| `MEMORY.md` | 跨 session 的持久记忆速查表 | 保持精简，低于 100 行 |
| `SOUL.md` | 人格、语调、行为边界 | 是身份定义，不是安全机制 |
| `AGENTS.md` | 操作规则、决策框架、Memory Protocol | 最适合写入行为规则 |
| `USER.md` | 用户上下文、偏好、项目信息 | 帮助 agent 理解你是谁 |

**Memory 目录文件**（不注入上下文，按需检索）：

| 文件 | 存放内容 | 检索方式 |
| --- | --- | --- |
| `memory/YYYY-MM-DD.md` | 每日工作记录、决策、活跃任务状态 | `memory_search` / `memory_get` |
| `memory/*.md`（自定义） | 项目笔记、会议记录等 | `memory_search` |

Memory 目录下的文件通常只自动读取**今天和昨天的**，历史文件通过 `memory_search` 按需检索。
### 6.5 检索系统
OpenClaw 提供两个 memory 工具：
- **memory_search**：跨所有 memory 文件的混合搜索（BM25 关键词 + 向量语义），能匹配含义相近但用词不同的内容
- **memory_get**：按文件路径和行范围精确读取
检索系统支持两种后端：

| 后端 | 适用场景 | 特点 |
| --- | --- | --- |
| Built-in（默认） | 个人使用，memory 文件不多 | 本地 embedding 模型，免费，无需额外安装 |
| QMD（实验性） | 需要搜索大量外部文档（Obsidian 库等） | 支持 session 索引，可搜索过往对话 |

Built-in 后端的推荐配置：
```plaintext
{
 agents: {
 defaults: {
 memorySearch: {
 enabled: true,
 provider: "local",
 local: {
 modelPath: "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf",
 },
 query: {
 hybrid: {
 enabled: true,
 vectorWeight: 0.7,
 textWeight: 0.3,
 },
 },
 cache: { enabled: true },
 },
 },
 },
}

```

### 6.6 三层防御策略
单一机制无法保证记忆可靠性，需要三层协同工作[[OpenClaw Memory Masterclass]](https://velvetshark.com/openclaw-memory-masterclass)：
**第 1 层：Pre-compaction Memory Flush（自动安全网）**
上下文接近 compaction 阈值时自动触发。需要正确配置 `reserveTokensFloor`（建议 40000）和确认 `memoryFlush.enabled: true`。这是被动防御——只在快溢出时触发。
**第 2 层：手动记忆保存（主动保存）**
在重要决策后、切换任务前、给出复杂指令时，主动告诉 agent "保存到记忆文件"。还可以使用 `/compact` 命令主动触发 compaction：先让 agent 保存上下文 → 执行 `/compact` → 然后给新指令（新指令落在 compaction 后的新鲜上下文中，生命周期最长）。
**第 3 层：AGENTS.md 中的 Memory Protocol（行为规则）**
通过 AGENTS.md 写入明确的记忆规则，让 agent 在适当时机自动检索和写入记忆。没有这层规则，agent 只会从当前上下文中"猜"，而不是去查找已记录的信息。
### 6.7 常见故障诊断

| 症状 | 原因 | 修复方式 |
| --- | --- | --- |
| Agent 不记住偏好 | 偏好只存在于对话中，未写入 MEMORY.md | 检查 `/context list`；手动要求写入 MEMORY.md |
| `memory_search` 无结果 | memory 文件不存在或 embedding 模型未下载 | 确认文件存在；检查本地模型是否正常加载 |
| Agent 忘记工具返回的内容 | Session pruning 裁剪了旧的 tool result | 重新执行工具；或将重要结果手动保存到 memory 文件 |
| 一夜之间忘记所有内容 | 每日 session 重置（默认凌晨 4:00） | 这是正常行为——只有文件和可搜索记忆跨 session 存活 |
| `memory/YYYY-MM-DD.md` 从不被创建 | compaction flush 未触发 + 无 Memory Protocol | 配置 memoryFlush + 在 AGENTS.md 添加 Memory Protocol |
| Compaction 来不及保存就溢出 | `reserveTokensFloor` 太小 | 从默认 20000 提高到 40000 |

**诊断起点**：始终从 `/context list` 命令开始。它会显示哪些 workspace 文件被加载、是否被截断、注入的字符数是否等于原始字符数。如果文件不在上下文中，它对 agent 没有任何影响。
### 6.8 推荐完整配置
```plaintext
{
 agents: {
 defaults: {
 compaction: {
 reserveTokensFloor: 40000,
 memoryFlush: {
 enabled: true,
 softThresholdTokens: 4000,
 systemPrompt: "Session nearing compaction. Store durable memories now.",
 prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
 },
 },
 memorySearch: {
 enabled: true,
 provider: "local",
 local: {
 modelPath: "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf",
 },
 query: {
 hybrid: {
 enabled: true,
 vectorWeight: 0.7,
 textWeight: 0.3,
 },
 },
 cache: { enabled: true },
 },
 contextPruning: {
 mode: "cache-ttl",
 ttl: "5m",
 },
 },
 },
}

```

配合 `AGENTS.md` 中的 Memory Protocol 和 Retrieval Protocol，即可构建完整的记忆可靠性保障体系。
---

# 七、脚本与定时任务中调用 Agent AI 能力

当 OpenClaw 帮你编写脚本或定时任务代码时，一个关键问题是：这些脚本在运行时能否**回调 Agent 自身的 AI 能力**（自然语言搜索、分析、总结等）？答案是肯定的。OpenClaw 提供了多种架构模式来实现「代码 × 智能」的融合。

## 7.1 核心思路转变

传统思维是「Agent 写一段脚本，脚本自己做数据处理」。但 OpenClaw 架构下，正确的思路应该是：

> **Agent 本身就是脚本的执行引擎** —— 让 Agent 在定时触发时以自然语言理解任务，直接调用内置工具（web_search、web_fetch、browser、memory_search 等）完成搜索、分析、总结。

基于此，有**四种架构模式**可选，从简到繁。

---

## 7.2 模式一：Agent 即脚本（Cron agentTurn）⭐ 推荐

**核心理念**：不写代码，直接用自然语言描述任务，让 Agent 在定时触发时以完整 Agent Turn 执行。

**机制**：Cron 的 `isolated` 模式会创建独立的 `cron:<jobId>` 会话，运行一个完整的 Agent Turn。Agent 拥有全部工具能力（web_search、web_fetch、browser、exec、memory_search 等），可以像正常对话一样完成复杂任务。

**CLI 示例**：

```bash
# 每天早 7 点，让 Agent 自动搜索并总结 AI 领域前沿动态
openclaw cron add \
 --name "AI 前沿日报" \
 --cron "0 7 * * *" \
 --session isolated \
 --message "搜索过去 24 小时内 AI 领域的重大进展、论文发布和产品更新，整理成结构化日报，包含标题、摘要、链接和影响评估。" \
 --announce \
 --channel slack \
 --to "channel:C1234567890"
```

**通过 `cron.yaml` 配置的 payload 结构**：

```yaml
jobs:
 ai-daily-brief:
 cron: "0 7 * * *"
 session: isolated
 payload:
 kind: agentTurn
 message: |
 搜索过去 24 小时内 AI 领域的重大进展，包括：
 1. 重要论文（arXiv、顶会）
 2. 产品发布和更新
 3. 行业动态和融资新闻
 整理成结构化日报。
 lightContext: true # 不需要工作区引导文件，轻量启动
 thinkingBudget: high # 给足推理预算
 delivery:
 mode: announce
 channel: slack
 to: "channel:C1234567890"
```

**关键配置项**：

| 配置 | 说明 |
|------|------|
| `session: isolated` | 每次运行创建独立会话，互不干扰 |
| `lightContext: true` | 跳过 workspace 引导文件注入，加快启动 |
| `thinkingBudget` | 控制推理深度：`low` / `medium` / `high` |
| `delivery.mode: announce` | 将结果发送到指定频道 |
| `delivery.mode: webhook` | 将结果 POST 到 HTTP endpoint |

**适用场景**：日报生成、舆情监控、竞品追踪、定期文档总结 —— 任何可以用自然语言描述的周期性 AI 任务。

---

## 7.3 模式二：脚本调用 Agent（`openclaw agent --message --json`）

**核心理念**：当你确实需要脚本做一些 Agent 不擅长的事（如精确数据变换、API 调用、文件处理），但中间环节需要 AI 能力时，脚本可以通过 CLI 回调 Agent。

**机制**：`openclaw agent` 命令执行一个单独的 Agent Turn，`--json` 标志返回结构化 JSON，脚本可以解析并使用。

**基本用法**：

```bash
# 单次调用 Agent 进行自然语言分析
openclaw agent --message "分析这段日志，识别错误模式和根因" --json

# 指定特定 Agent 配置
openclaw agent --agent ops --message "总结以下内容" --json

# 启用深度推理
openclaw agent --message "..." --thinking --json
```

**在脚本中集成的完整示例**：

```bash
#!/bin/bash
# hybrid_monitor.sh — 系统监控 + AI 分析

# 第 1 步：脚本收集原始数据（Agent 不擅长的精确数据采集）
LOGS=$(journalctl --since "1 hour ago" --priority=err --no-pager)
METRICS=$(curl -s http://prometheus:9090/api/v1/query?query=up)
DISK_USAGE=$(df -h | grep '/dev/sd')

# 第 2 步：将原始数据交给 Agent 做 AI 分析
ANALYSIS=$(openclaw agent --message "
你是一个 SRE 专家。分析以下系统数据，给出：
1. 关键问题识别
2. 根因分析
3. 建议操作

## 错误日志
${LOGS}

## 服务状态
${METRICS}

## 磁盘使用
${DISK_USAGE}
" --json)

# 第 3 步：脚本解析 AI 输出并自动化后续操作
SEVERITY=$(echo "$ANALYSIS" | jq -r '.output' | grep -c '严重\|critical')
if [ "$SEVERITY" -gt 0 ]; then
 curl -X POST "$WEBHOOK_URL" \
 -d "{\"text\": $(echo "$ANALYSIS" | jq '.output')}"
fi
```

**`--json` 返回结构**：

```json
{
 "output": "Agent 的文本回复内容...",
 "toolCalls": [...],
 "tokenUsage": { "prompt": 1200, "completion": 800 },
 "duration": 4500
}
```

**关键标志**：

| 标志 | 说明 |
|------|------|
| `--message "..."` | 发送给 Agent 的自然语言指令 |
| `--json` | 返回结构化 JSON（脚本必备） |
| `--agent <name>` | 指定 Agent 配置 |
| `--deliver` | 同时将结果投递到频道 |
| `--thinking` | 启用深度推理 |
| `--local` | 强制本地运行（跳过 Gateway） |
| `--timeout <ms>` | 超时设置 |

**适用场景**：需要精确数据采集 + AI 分析的混合场景，如日志分析、监控告警、数据 ETL + 摘要生成。

---

## 7.4 模式三：Agent 派生子 Agent（sessions_spawn）

**核心理念**：对于复杂的多维度研究任务，主 Agent（或 cron agentTurn）可以派生多个子 Agent 并行工作，各自搜索不同方向，最后汇总。

**机制**：`sessions_spawn` 工具在独立会话中创建子 Agent，子 Agent 拥有全部工具（除 session 类工具外），通过 `announce` 链将结果返回给父 Agent。

**在 Cron agentTurn 中的 prompt 示例**：

```
你需要生成一份全面的竞品分析报告。按以下步骤执行：

1. 使用 sessions_spawn 并行派生 3 个子 Agent：
 - 子 Agent A：搜索并分析 Competitor X 的最新产品更新、定价变化、用户评价
 - 子 Agent B：搜索并分析 Competitor Y 的相同维度
 - 子 Agent C：搜索行业整体趋势和市场份额变化

2. 收集所有子 Agent 的 announce 结果

3. 综合所有信息，生成结构化竞品分析报告，包含：
 - 功能对比矩阵
 - 定价对比
 - 市场定位分析
 - 建议的差异化策略
```

**编排者模式（Orchestrator Pattern）**：

如果需要更深层级的并行化，可以启用 `maxSpawnDepth: 2`：

```
主 Agent（cron 触发）
 └── 编排者子 Agent（深度 1，拥有 sessions_spawn 权限）
 ├── 工作者子 Agent A（深度 2，执行具体搜索）
 ├── 工作者子 Agent B（深度 2，执行具体搜索）
 └── 工作者子 Agent C（深度 2，执行具体搜索）
```

**子 Agent 工具权限规则**：

| 层级 | 角色 | 可用工具 |
|------|------|----------|
| 深度 1（叶子节点） | 独立工作者 | 所有工具，**除** session 类工具 |
| 深度 1（编排者） | maxSpawnDepth≥2 时 | 所有工具 + `sessions_spawn`、`subagents`、`sessions_list`、`sessions_history` |
| 深度 2 | 终端工作者 | 所有工具，**除** session 类工具（永不再派生） |

**适用场景**：多维度竞品分析、多源信息汇总、需要并行搜索的大型研究任务。

---

## 7.5 模式四：混合管道（Hybrid Pipeline）

**核心理念**：将上述模式组合，形成「Cron 触发 → 脚本数据采集 → Agent AI 分析 → 子 Agent 深度研究 → 结构化输出」的完整管道。

**示例：自动化周报生成管道**：

```yaml
# cron.yaml
jobs:
 weekly-report:
 cron: "0 9 * * MON" # 每周一早 9 点
 session: isolated
 payload:
 kind: agentTurn
 message: |
 执行以下周报生成流程：

 1. 使用 exec 工具运行数据采集脚本：
 bash /workspace/scripts/collect_weekly_data.sh
 该脚本会将数据保存到 /workspace/data/weekly_raw.json

 2. 读取采集到的原始数据

 3. 使用 sessions_spawn 派生子 Agent 分别分析：
 - 子 Agent A：分析本周代码提交和 PR 合并情况
 - 子 Agent B：搜索本周行业动态和相关技术博客

 4. 综合所有数据和子 Agent 结果，生成周报

 5. 周报格式要求：
 ## 本周摘要
 ## 关键成果
 ## 数据指标变化
 ## 行业动态
 ## 下周计划建议
 thinkingBudget: high
 delivery:
 mode: announce
 channel: slack
 to: "channel:C1234567890"
```

---

## 7.6 选型指南

| 场景 | 推荐模式 | 理由 |
|------|----------|------|
| 纯 AI 任务（搜索、总结、分析） | **模式一：agentTurn** | 零代码，自然语言驱动，Agent 拥有全部工具 |
| 数据采集 + AI 分析 | **模式二：脚本调 Agent** | 脚本负责精确操作，Agent 负责智能分析 |
| 多维度并行研究 | **模式三：子 Agent** | 并行执行，各自独立搜索，汇总结果 |
| 复杂端到端自动化 | **模式四：混合管道** | 组合所有能力，覆盖全链路 |
| 快速原型 / 一次性任务 | **模式二（单次调用）** | `openclaw agent --message "..." --json` 即可 |

## 7.7 实践建议

1. **优先考虑模式一**：绝大多数「想让 AI 帮忙搜索分析」的需求，直接用 cron agentTurn + 自然语言 prompt 就够了，不需要写代码
2. **Prompt 即程序**：在 agentTurn 的 message 中写清楚步骤、格式要求、输出结构，Agent 会按步骤执行并使用适当的工具
3. **用 `lightContext: true`** 加速定时任务启动，除非你需要 workspace 中的引导文件
4. **用 `--json` 做管道胶水**：当确实需要脚本和 Agent 协作时，`openclaw agent --message --json` 是最佳的集成点
5. **子 Agent 用于扩展并行度**：当单个 Agent Turn 的搜索范围不够时，在 prompt 中指示 Agent 使用 `sessions_spawn` 分发任务

# 八、DM 策略、会话作用域与心跳投递机制

本章深入讲解 OpenClaw 中三个紧密关联的配置维度：`session.dmPolicy`（DM 入站策略）、`session.dmScope`（DM 会话作用域）和 `heartbeat` 的投递机制，以及它们之间的交叉影响。理解这三者的关系，是正确配置心跳投递的关键。

## 8.1 DM 基本概念

DM 即 **Direct Message（私聊/私信）**，指用户与 Bot 之间一对一的会话，区别于群组/频道中的公开对话。在 OpenClaw 的语境中：

- **DM 消息**：用户在 Telegram、飞书、Discord 等平台上直接私信 Bot 的消息
- **DM 会话**：Bot 与某个用户之间建立的私聊 session
- **DM 投递**：Bot（通过 heartbeat 等机制）主动向某个用户发送私信

DM 在 OpenClaw 中涉及**两个方向**的控制：

| 方向 | 控制配置 | 作用 |
|---|---|---|
| **入站**（谁能私信 Bot） | `dmPolicy` + `allowFrom` | 控制哪些用户可以给 Bot 发 DM |
| **出站**（Bot 能否主动私信用户） | `heartbeat.directPolicy` | 控制 heartbeat 能否投递到 DM 目标 |

## 8.2 `session.dmPolicy`：DM 入站策略

`dmPolicy` 控制**谁可以给 Bot 发私信**，有四种模式：

| 模式 | 行为 | 适用场景 |
|---|---|---|
| `pairing`（默认） | 用户必须先发送配对码，被批准后才能 DM | 个人部署，安全优先 |
| `allowlist` | 只有 `allowFrom` 列表中的用户 ID 可以 DM | 已知固定用户群 |
| `open` | 任何人都可以 DM | 公开服务型 Bot |
| `disabled` | 完全禁止所有 DM | 仅群组使用 |

**配置示例**：

```yaml
session:
 dmPolicy: "pairing" # 默认值
 # 或
 dmPolicy: "allowlist"
 allowFrom:
 - "ou_abc123" # 飞书 open_id
 - "123456789" # Telegram 数字 ID
```

## 8.3 `heartbeat.directPolicy`：DM 出站策略

`directPolicy` 是 heartbeat 配置中**专门控制出站 DM 投递**的字段：

| 值 | 行为 |
|---|---|
| `block`（默认） | 心跳不会投递到任何 DM 目标——即使 `target: "last"` 解析到的最后交互是一个 DM 对话 |
| `allow` | 允许心跳投递到 DM 目标 |

**为什么默认是 `block`？**

这是 PR #25916 引入的 `dm-blocked` 安全护栏。设计目的是防止心跳意外发送到**陌生人的 DM**——例如，如果 `dmPolicy: "open"` 且某个陌生人刚给 Bot 发了一条消息，`target: "last"` 可能解析到这个陌生人的 DM，导致心跳内容泄露给非预期的人。

**Bug #26338**：早期实现中，`dm-blocked` 检查是**无差别应用**的，即使你在 `heartbeat.to` 中显式指定了 DM 目标也会被拦截。PR #26366 修复了这个问题——现在 `dm-blocked` 只对**隐式解析**的 DM 目标生效，显式指定的 `to` 不受影响。

## 8.4 `dmPolicy` 对 `heartbeat.target: "last"` 的影响

`dmPolicy` 与 heartbeat 的交互是**间接的**——`dmPolicy` 控制入站，`directPolicy` 控制出站，它们通过 DM session 的存在与否产生关联。

### 各模式下的影响分析

| dmPolicy 模式 | 对 `target: "last"` 的影响 |
|---|---|
| `pairing` | 只有通过配对的用户才能创建 DM session → `lastRoute` 只可能指向已配对用户的 DM 或群组 → 相对安全，但仍受 `directPolicy` 约束 |
| `allowlist` | 只有白名单用户能创建 DM session → 与 `pairing` 类似，`lastRoute` 范围受限 |
| `open` | 任何人的 DM 都会创建 session → `lastRoute` 可能指向陌生人 → **这正是 `directPolicy: "block"` 默认值存在的原因** |
| `disabled` | 不存在 DM session → `lastRoute` 只可能指向群组 → DM 投递问题不存在 |

### 实践配置建议

**单用户场景**（个人助手）：

```yaml
session:
 dmPolicy: "pairing" # 只有你自己配对过
agents:
 defaults:
 heartbeat:
 target: "last"
 directPolicy: "allow" # 安全——只有你能创建 DM session
```

**多用户场景**（团队 Bot）：

```yaml
session:
 dmPolicy: "open" # 允许所有人 DM
agents:
 defaults:
 heartbeat:
 target: "last"
 directPolicy: "block" # 保持默认——防止心跳发到陌生人 DM
```

**安全法则**：`dmPolicy` 越开放 → `directPolicy` 越应该保持 `block`。只有当你能确保所有 DM session 都是可信的（`pairing` 或严格的 `allowlist`），才应该将 `directPolicy` 设为 `allow`。

## 8.5 `session.dmScope` 对 `heartbeat.target: "last"` 的影响

`dmScope` 控制 DM 消息如何映射到 session key，这直接决定了 DM 交互是否会影响 main session 的 `lastRoute`，进而影响 `target: "last"` 的解析结果。

### 四种模式的行为差异

| dmScope 模式 | Session Key 格式 | DM 是否影响 main session 的 lastRoute | 对 `target: "last"` 的影响 |
|---|---|---|---|
| `main`（默认） | `agent:<agentId>:main` | **是** — 所有 DM 共享 main session | DM 交互会改变 `lastRoute`，心跳可能发到 DM |
| `per-peer` | `agent:<agentId>:direct:<peerId>` | **否** — DM 进入独立 session | 不影响，`lastRoute` 只受群组交互影响 |
| `per-channel-peer` | `agent:<agentId>:<channel>:direct:<peerId>` | **否** — DM 按渠道 + 用户隔离 | 不影响，同上 |
| `per-account-channel-peer` | `agent:<agentId>:<channel>:<accountId>:direct:<peerId>` | **否** — DM 按账户 + 渠道 + 用户隔离 | 不影响，同上 |

### 核心机制解析

Heartbeat 默认运行在 **main session** 中。当 `target: "last"` 时，它从 main session 的上一次外部交互记录中解析投递目标。

- **`dmScope: "main"`**：所有 DM 消息都流入 main session → 每次 DM 交互都会更新 main session 的 `lastRoute` → 心跳的 `target: "last"` 可能解析到最近的 DM 对象
- **其他模式**：DM 消息进入独立的 session → main session 的 `lastRoute` 不受影响 → `target: "last"` 只能解析到最近的**群组交互**

### 设计意义

如果你希望 **DM 和群组交互互不干扰**，尤其是不希望用户的 DM 交互「抢走」心跳的投递目标，应该将 `dmScope` 设为 `per-peer` 或更细粒度的模式。

```yaml
session:
 dmScope: "per-peer" # DM 不影响 main session
agents:
 defaults:
 heartbeat:
 target: "last" # 只解析到群组交互
 directPolicy: "block"
```

这样配置后，无论用户如何与 Bot DM 交互，心跳始终只会发到最后交互的群组中。

## 8.6 显式渠道投递：`heartbeat.target` + `heartbeat.to`

当你不想依赖 `"last"` 的自动解析逻辑，可以将 `target` 设为具体渠道名（如 `"telegram"`、`"feishu"`），并通过 `to` 字段指定接收者。这种方式绕过了 `lastRoute` 解析，因此**不受 `dmScope` 影响**。

### `to` 字段格式

`to` 的值是**渠道特定的接收者标识**：

| 渠道 | `to` 格式 | 示例 |
|---|---|---|
| Telegram | 纯数字用户/群组 ID | `"123456789"` |
| Feishu（飞书） | open_id（`ou_` 开头）或 chat_id（`oc_` 开头） | `"ou_abc123def456..."` |
| WhatsApp | E.164 电话号码格式 | `"+8613800138000"` |
| Discord | 用户 ID 或频道 ID | `"123456789012345678"` |

### 配置示例

```yaml
# Telegram 心跳发给自己
agents:
 defaults:
 heartbeat:
 intervalMinutes: 120
 target: "telegram"
 to: "123456789"
 directPolicy: "allow" # 必须允许 DM 投递

# 飞书心跳发给自己
agents:
 defaults:
 heartbeat:
 intervalMinutes: 120
 target: "feishu"
 to: "ou_abc123def456ghi789"
 directPolicy: "allow" # 必须允许 DM 投递
```

> **重要**：即使显式指定了 `to`，也必须设置 `directPolicy: "allow"`，否则投递到个人私聊的消息仍会被拦截。

## 8.7 如何找到自己的用户 ID

配置 `heartbeat.to` 时需要知道自己在各平台上的 ID。以下是各渠道的获取方法：

### Telegram

Telegram 用户 ID 是纯数字（如 `123456789`）。

**方法一：通过 OpenClaw 日志（最可靠）**

1. 确保 Telegram 渠道的 Gateway 已启动
2. 用你自己的 Telegram 账号给 Bot 发一条私信
3. 实时查看日志：`openclaw logs --follow`
4. 在日志中找到 `from.id` 字段，该数字即为你的用户 ID

**方法二：通过 Telegram Bot API**

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates"
```

返回的 JSON 中，找到 `message.from.id` 字段。

**方法三：通过第三方 Bot**

在 Telegram 中私信 `@userinfobot` 或 `@getidsbot`，它会直接回复你的数字 ID。

### Feishu（飞书）

飞书用户 ID 使用 open_id 格式，形如 `ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`。

**方法一：通过 OpenClaw 日志（最可靠）**

1. 确保飞书渠道的 Gateway 已启动
2. 用你的飞书账号给 Bot 发一条私信
3. 实时查看日志：`openclaw logs --follow`
4. 在日志中找到 `open_id` 字段（`ou_xxx` 格式）

**方法二：通过 OpenClaw 配对列表**

如果飞书渠道使用了 `dmPolicy: "pairing"`：

```bash
openclaw pairing list feishu
```

输出中会显示发起配对请求的用户 Open ID。

**方法三：通过飞书开放平台 API**

调用「通过手机号或邮箱获取用户 ID」接口：

```
POST https://open.feishu.cn/open-apis/contact/v3/users/batch_get_id
```

传入你的邮箱或手机号，返回对应的 `open_id`。

### 通用法则

无论哪个渠道，最通用的方法是：**给 Bot 发一条消息 → 看日志 → 拿到 ID**。这适用于所有平台。

## 8.8 `heartbeat.session`：心跳的会话隔离

`heartbeat.session`（或 `isolatedSession: true`）控制心跳的 Agent Turn 运行在哪个会话中。

| 配置 | 行为 |
|---|---|
| 不设置（默认） | 心跳运行在 main session，与用户正常对话共享上下文 |
| `isolatedSession: true` | 心跳运行在独立的专用会话中，与正常对话互不干扰 |

### 为什么需要隔离会话

**共享 main session 的问题：**

1. **上下文污染**：心跳每次触发都会往 main session 的对话历史中写入内容（心跳 prompt + Agent 回复）。高频心跳会导致对话历史被心跳记录填满
2. **状态干扰**：心跳的 Agent Turn 可能调用工具、修改状态，影响正常对话
3. **lastRoute 副作用**：心跳的投递行为本身可能更新 `lastRoute`，影响后续路由

**隔离会话的优势：**

| 方面 | 共享 main session | 隔离会话 |
|---|---|---|
| 对话历史 | 心跳记录混入正常对话 | 心跳有独立的对话历史 |
| Memory | 共享 Agent 的 memory 文件 | 共享（memory 是 Agent 级别的） |
| lastRoute | 心跳投递会更新 main session 的 lastRoute | 不影响 main session |
| 工具调用 | 影响 main session 状态 | 不影响 main session |
| 心跳自我追踪 | 上下文被正常对话冲淡 | 可以看到之前的心跳历史，回复更连贯 |

### 与 `lightContext` 的配合

`lightContext: true` 减少心跳 Agent Turn 加载的上下文量（更少的历史消息、跳过部分文件加载），让心跳执行更快、token 消耗更低：

```yaml
agents:
 defaults:
 heartbeat:
 isolatedSession: true
 lightContext: true # 轻量上下文，加快心跳执行
```

### 场景选择

| 场景 | 推荐配置 |
|---|---|
| 心跳仅做简单提醒/问候 | `isolatedSession: true` + `lightContext: true` |
| 心跳需要感知用户最近对话 | 不设置（共享 main session） |
| 心跳执行复杂任务（如定时数据分析） | `isolatedSession: true` |
| 高频心跳（< 30 分钟一次） | **强烈建议** `isolatedSession: true` + `lightContext: true` |

> **经验法则**：除非心跳明确需要「接上」用户的正常对话，否则建议始终开启 `isolatedSession: true`。

## 8.9 配置全景图

以下是本章涉及的所有配置项的完整关系图：

```
用户发 DM 给 Bot
 │
 ▼
┌───────────────────────────────────────────┐
│ [dmPolicy] 入站检查：这个用户能否私信 Bot？ │
│ pairing → 需配对码 │
│ allowlist → 需在白名单 │
│ open → 允许 │
│ disabled → 拒绝 │
└───────────────────────────────────────────┘
 │ 通过
 ▼
┌───────────────────────────────────────────┐
│ [dmScope] DM 消息进入哪个 session？ │
│ main → 进入 main session（影响 lastRoute） │
│ per-peer → 进入独立 session（不影响） │
└───────────────────────────────────────────┘
 │
 ▼
┌───────────────────────────────────────────┐
│ Heartbeat 触发（在 main session 或隔离 session）│
│ │
│ [isolatedSession] 决定心跳运行在哪个 session │
└───────────────────────────────────────────┘
 │ Agent 回复非 HEARTBEAT_OK
 ▼
┌───────────────────────────────────────────┐
│ [target] 投递目标解析 │
│ "none" → 不投递 │
│ "last" → 解析 main session 的 lastRoute │
│ "telegram"/"feishu" → 显式指定渠道 + to │
└───────────────────────────────────────────┘
 │ 目标是 DM
 ▼
┌───────────────────────────────────────────┐
│ [directPolicy] 出站检查：心跳能否发到 DM？ │
│ "block" → 拦截（默认） │
│ "allow" → 放行 │
└───────────────────────────────────────────┘
 │ 放行
 ▼
 ✅ 心跳消息投递到目标渠道
```

### 推荐配置组合

**个人助手（单用户，心跳发到自己的 DM）：**

```yaml
session:
 dmPolicy: "pairing"
 dmScope: "main" # 单用户无所谓
agents:
 defaults:
 heartbeat:
 intervalMinutes: 60
 target: "last" # 或显式指定渠道
 directPolicy: "allow"
 isolatedSession: true
 lightContext: true
```

**团队 Bot（多用户，心跳发到固定群组）：**

```yaml
session:
 dmPolicy: "open"
 dmScope: "per-peer" # DM 不干扰 main session
agents:
 defaults:
 heartbeat:
 intervalMinutes: 120
 target: "telegram" # 显式指定渠道
 to: "group:-1001234567890" # 固定群组
 directPolicy: "block" # 保持默认
 isolatedSession: true
```

**显式指定发给自己（最确定性配置）：**

```yaml
session:
 dmPolicy: "pairing"
agents:
 defaults:
 heartbeat:
 intervalMinutes: 120
 target: "feishu" # 或 "telegram"
 to: "ou_abc123def456..." # 自己的 ID
 directPolicy: "allow"
 isolatedSession: true
 lightContext: true
```

## 8.10 常见问题排查

| 症状 | 可能原因 | 解决方案 |
|---|---|---|
| 心跳有回复但收不到 | `target` 为默认的 `"none"` | 设为 `"last"` 或显式指定渠道 |
| 心跳发到了陌生人的 DM | `dmPolicy: "open"` + `target: "last"` + `directPolicy: "allow"` | 收紧 `dmPolicy` 或设 `directPolicy: "block"` |
| 心跳发到了错误的群组 | DM 交互改变了 `lastRoute`（`dmScope: "main"` 导致） | 设 `dmScope: "per-peer"` 隔离 DM |
| 显式指定 `to` 但仍收不到 | `directPolicy` 为默认的 `"block"` | 设 `directPolicy: "allow"` |
| 心跳记录填满正常对话历史 | 心跳运行在 main session 中 | 设 `isolatedSession: true` |
| 心跳内容重复/不连贯 | 心跳每次都在新的上下文中运行 | 开启 `isolatedSession: true`，心跳可追踪自己的历史 |
| 心跳执行慢/token 消耗高 | 加载了完整上下文 | 配合 `lightContext: true` |
