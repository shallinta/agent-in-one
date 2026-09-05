# Pair Agent MVP 实现与效果报告

> **性质：**持续更新的探索报告，用于记录 Pair Agent MVP 的实际实现状态、真实模型测试数据、效果判断和后续验证方向，不是生产可用性声明。
>
> **当前实测快照：**2026-09-05，Pair `pair-real-model-mvp`，Ledger head 131 / Shared head 130。
>
> **数据口径：**本文只使用上述 Pair 的当前会话数据。此前其他 Pair、旧 Prompt、旧工具集合及旧缓存统计已经从报告中移除，不再作为正文基线。
>
> **相关文档：**[Pair Agent 模型](pair-agent.md)、[通用技术设计参考](pair-agent-spec.md)、[基于 DeepSeek Harness 的 MVP 技术方案](pair-agent-dsh-mvp.md)、[MVP 运行说明](mvp/README.md)、[Completion-specific Turn-end Handoff 设计](mvp/completion-specific-turn-end-handoff-design.md)。

## 1. 报告目标

本文回答四个问题：

1. 当前 Pair Agent MVP 实际实现了什么，没有实现什么；
2. Navigator 与 Pilot 在真实模型会话中的协作效果是否符合设计；
3. Shared Context、请求投影、缓存和上下文增长是否达到预期；
4. 当前实现距离 [`pair-agent-dsh-mvp.md`](pair-agent-dsh-mvp.md) 规划的 MVP 语义闭环还缺少什么。

本报告不把不同 Pair、不同 Prompt 或不同工具配置的数据拼接为趋势。后续出现新的权威验收会话时，应整体替换本次数据，或明确建立条件一致的 A/B 实验，不继续累积不可比的历史数字。

## 2. 当前实现范围

当前原型由 P0 与 P0.5 阶段构成，运行在固定 DeepSeek Harness（DSH）源码快照之上：

- 一条 Pair Session 对应 Navigator、Pilot 两条独立的 DSH Agent Session；
- Pair Ledger 保存两个 Agent 共同消费的 canonical session events；
- Session-to-Pair Bridge 把双方可共享的用户输入和最终回答写入 Pair Ledger；
- Pair Request Builder 在每次模型请求前组合 Common System、完整 Shared Events、Shared Projection、去重后的 Agent-local History、Active Role Reminder、Current Trigger 与稳定工具 schema；
- Navigator 与 Pilot 可使用 `pair_message_peer` 定向通信并唤醒对方；
- 普通对话只被动进入共享上下文，不会自动唤醒另一个 Agent；
- Pilot 可以登记 `pair_report_completion`，由 Bridge 在最终回答和 `turn/end` 均 durable 后发布 completion handoff，再以事件引用唤醒 Navigator；
- Pilot 可以调用 DSH 原生 search-only `web_search`；Navigator 看到相同 schema，但由 Agent-scope guard 拒绝执行并应委派给 Pilot；
- 每个 Provider 请求都记录八个固定请求段的字节数、估算 token、摘要和条目数，并可与 Provider usage 对齐分析；
- continuation 完全从本地 Pair Ledger 与 DSH Session 重建，不依赖模型供应商的 stateful continuation；
- 当前 Shared Event 模型投影格式为 `pair-event-context/text-dedup-v1`。

当前明确未实现 P1/P2 的结构化 Goal/Task/Execution Plan、Goal-impact 权限判断、Revision fencing、完整 Pause/Resume/Cancel、持久 unread cursor、Shared Checkpoint、生产级压缩、Sub-agent/workflow、ArtifactRef，以及 Harness 执行权限绑定。`web_fetch`、文件写入与通用代码执行也未挂载。`web_search` 对用户提供精确 URL 的处理能力不在本次评估范围。

## 3. 本次真实模型验收数据

### 3.1 环境

| 项目 | 值 |
| --- | --- |
| 测试日期 | 2026-09-05 |
| Pair ID | `pair-real-model-mvp` |
| 模型 | `deepseek-v4-flash` |
| 主会话接口 | OpenAI Chat Completions 兼容接口 |
| Web Search 接口 | DSH DeepSeek Anthropic-compatible Messages + server-side `web_search` |
| Pair protocol | `pair-agent/p0.5` |
| Shared Event 投影 | `pair-event-context/text-dedup-v1` |
| Prompt material | `pair-prompt/sha256:1f3c67360188f6173a1473926bec7a54fd5581822ce66bbca541dc5b89679a0e` |
| Tool material | `pair-tools/v1:sha256:b15a0a4be485384d67008a6ce2917cb89179f1c308d36844db78333d4d829032` |
| Request config | `pair-config/v1:sha256:a502aacc64956e2200d377c27792145cf17438fb81422c2476f0e70e1d1801bb` |
| Ledger / Shared head | 131 / 130 |

### 3.2 记录完整性

Pair Ledger 共 131 条物理事件：

| 事件类型 | 数量 |
| --- | ---: |
| `pair.created` | 1 |
| `pair.agent_ready` | 1 |
| `user.message` | 15 |
| `agent.message` | 30 |
| `session_event.linked` | 46 |
| `pair.request_built` | 38 |

Navigator Session 有 15 个完成 Turn，Pilot Session 有 8 个完成 Turn。38 个主模型请求全部存在请求分段测量和 Provider usage；当前 Pair 没有 `agent.turn_failed`，本次最新交互窗口也没有 Turn 或工具错误。

### 3.3 代表性协作链路

本次会话覆盖了三类交互。

第一类是持续委派与正式完成回报：

```text
Navigator 委派 CrewAI/CAMEL 调研
  → Pilot 多轮 web_search
  → Pilot 调用 pair_report_completion
  → Bridge 发布 Event 83（completion-handoff，完整交付）
  → Navigator 从 Shared Events 读取 Event 83
  → Navigator 生成 Event 88，向用户综合结论
```

第二类是有限即时问答：

```text
Navigator Event 99 → pair_message_peer(expectsReply=true)
  → Pilot 使用 web_search 补充信息
  → Pilot Event 108 → pair_message_peer(replyTo=Event 99)
  → Navigator 请求以 sharedHead=108 构造
  → Navigator Event 114 向用户整合回答
```

第三类是用户分别与两个 Agent 对话：

```text
用户在 Navigator Pane 提问 → Event 117 → Navigator Event 122
用户在 Pilot Pane 提问     → Event 120 → Pilot Event 125
用户再询问 Navigator 两份评价是否一致
  → Navigator 请求以 sharedHead=125 构造
  → Navigator Event 130 准确引用并比较 Event 122 与 Event 125
```

这些链路证明两个长期独立 Agent Session 可以通过 Pair Ledger 获得双方上下文，普通共享、定向唤醒和完成交付三种语义也可以共存。

## 4. Shared Context 与协作效果

| 能力目标 | 当前判断 | 本次证据 |
| --- | --- | --- |
| 双方理解共享上下文 | 达成 | Navigator Event 130 准确引用并比较双方 Event 122/125；Pilot 能读取 Navigator 的委派和既有调研上下文 |
| 普通共享不自动唤醒 | 达成 | 用户与一方的普通对话进入 Shared Events，另一方到下一次自然 Turn 才消费 |
| 有限问题定向回复 | 达成 | Event 99 的 `expectsReply` 与 Event 108 的 `replyTo` 正确闭合 |
| 持续委派完成回报 | 达成 P0.5 口径 | Event 83 在 Pilot 最终回答和 completed `turn/end` durable 后发布 |
| Completion delivery 不复制正文 | 达成 | Navigator 的唤醒消息只携带 Event 引用，完整报告只存在于 handoff Shared Event |
| 原生 Web Search | 达成当前范围 | Pilot 实际调用 `web_search`；Navigator 保持相同 schema 和执行 guard |
| 请求与缓存可观测 | 达成基础口径 | 38/38 请求有固定八段测量并成功关联 usage |
| 运行稳定性 | 达成当前样本 | 当前 Pair 没有 Turn failure，服务恢复后继续使用同一 Pair |

共享上下文会影响两个 Agent 的判断独立性。本次 Pilot Turn 8 Step 2 的请求使用 `sharedHead=122`，因此 Pilot 在输出 Event 125 前已经能看到 Navigator 的 Event 122。两份评价高度一致可以证明共享上下文促进了协作收敛，但不能作为两个隔离 Agent 独立得出相同结论的证据。若未来需要独立交叉验证，Harness 必须显式冻结可见 Shared Head 或提供隔离评审模式，不能只靠 Prompt 要求“独立思考”。

## 5. Session link 与 Local History 去重

### 5.1 去重证明

当前 Pair 有 23 个 `representation=summary` link：

- 23/23 都携带合法 `representedContentDigest`；
- 23/23 都只关联一个明确 message ID；
- 没有 message ID 被两个 link 重复认领；
- link 的 durable range 可以延伸到对应 `step/end`、`turn/end`，但范围内不能包含额外消息边界；
- Local History 只有在 Session/message identity 与版本化内容 digest 同时匹配时，才删除已经进入 Shared Event 的 text block；reasoning、图片和其他非文本 block 仍然保留；
- 缺少 digest、digest 不匹配或来源不规范时保守保留原消息。

最新 Navigator 请求的 manifest 中有 14 个 `summary-text-deduplicated` span 和 14 个完整排除的 user/delivery span；最新 Pilot 请求分别为 7 个和 8 个。这说明去重决策已进入真实 Provider 请求构造路径，而不只是 Pair Event 或 UI 投影。

### 5.2 本次去重规模

对 23 个 summary-linked DSH assistant messages 统计：

| Agent | Summary-linked 消息 | 从 Local History 移除的可见正文 | 仍保留的 reasoning |
| --- | ---: | ---: | ---: |
| Navigator | 15 | 12,956 字符 | 26,564 字符 |
| Pilot | 8 | 9,979 字符 | 46,423 字符 |
| **合计** | **23** | **22,935 字符** | **72,987 字符** |

正文去重已经生效，但它没有删除模型 continuation 可能需要的 reasoning，因此安全性收益与上下文成本需要分开评价。

### 5.3 为什么不能只按文本相同去重

当前 Pair 中恰好存在三组正文完全相同、但由用户分别发给两个 Agent 的消息：

- Event 4 / 7：`你好`；
- Event 14 / 17：`你会做什么，有什么工具可以用`；
- Event 117 / 120：`如何评价 CrewAI 与 Pair Agent 模式`。

这些消息具有不同 Session origin 和 message ID，是用户真实执行的两次输入，必须作为两条事实保留。当前 identity + digest 方案正确保留了它们。纯文本全局去重会误删合法输入，因此不可采用。

### 5.4 观测边界

Pair Ledger 持久化请求 manifest、分段统计和完整请求 digest，但不持久化 Provider 请求的完整动态 messages。因此本次运行日志可以证明 Builder 选择了 `summary-text-deduplicated` 并成功发起请求，不能直接从日志逐字重放 Provider 收到的所有 messages。实际物化逻辑由针对“保留 reasoning/图片、移除已证明 text block”的 runtime contract tests 覆盖。若未来需要线上逐字审计，应设计受控、脱敏且可关闭的请求材料采样，而不是默认永久保存完整 Prompt。

## 6. 请求规模与缓存

### 6.1 全会话

| 角色 | 请求数 | 总输入 | Cache read | 命中率 | Reasoning 字符 | 可见回答字符 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Navigator | 20 | 300,039 | 196,352 | 65.44% | 32,677 | 13,249 |
| Pilot | 18 | 401,083 | 194,688 | 48.54% | 81,674 | 10,525 |
| **合计** | **38** | **701,122** | **391,040** | **55.77%** | **114,351** | **23,774** |

这里的“总输入”按当前 Provider usage 口径为 uncached input 与 cache read 之和。Web Search 自己发出的 DeepSeek Messages 请求是独立工具 Provider 调用，不包含在上表中。

### 6.2 最近交互窗口

以 Ledger Event 96–127 对应的最近 10 个主模型请求作为本轮功能观察窗口：

| Role | Turn/step | Shared head | Shared Events 估算 tokens | Local History 估算 tokens | 总输入 | Cache read | 命中率 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Navigator | 12/1 | 94 | 13,351 | 5,929 | 21,477 | 14,336 | 66.75% |
| Navigator | 12/2 | 99 | 13,991 | 7,262 | 23,258 | 15,360 | 66.04% |
| Pilot | 7/1 | 101 | 14,371 | 21,701 | 37,664 | 16,000 | 42.48% |
| Pilot | 7/2 | 104 | 14,885 | 23,371 | 39,885 | 16,640 | 41.72% |
| Pilot | 7/3 | 108 | 16,910 | 26,447 | 45,269 | 17,024 | 37.61% |
| Navigator | 13/1 | 108 | 16,910 | 7,347 | 26,529 | 17,664 | 66.58% |
| Navigator | 14/1 | 114 | 19,197 | 7,894 | 29,361 | 17,664 | 60.16% |
| Pilot | 8/1 | 117 | 19,360 | 26,744 | 48,155 | 19,840 | 41.20% |
| Pilot | 8/2 | 122 | 20,572 | 28,644 | 51,101 | 22,272 | 43.58% |
| Navigator | 15/1 | 125 | 21,923 | 9,313 | 33,274 | 22,528 | 67.70% |
| **合计** | **10 requests** |  |  |  | **355,973** | **179,328** | **50.38%** |

最近窗口按角色聚合：Navigator 5 次请求的 cache read 率为 65.39%，Pilot 5 次为 41.33%。绝对 cache read 随稳定前缀增长，但 Pilot 的整体命中率明显低于 Navigator。

### 6.3 上下文增长判断

当前增长主因已经不是 Shared Event 内的 `text/content` 重复，也不是 summary-linked assistant 正文在 Local History 中重复，而是：

1. 每轮携带随会话增长的完整 Shared Events；
2. Local History 保留 reasoning、工具调用与结果，以支持无 Provider 状态的 continuation；
3. Pilot 执行多步 Web Search，Local History 比 Navigator 更大；
4. Shared Head 在工具步骤之间前进，使 `shared-events` 段较早发生变化；
5. 尚未实现 Shared Checkpoint、reasoning retention 策略和 ArtifactRef。

Pilot 最新请求的 Local History 已估算为 28,644 tokens，高于 Shared Events 的 20,572 tokens。一个已完成的 Pilot 消息单独包含 36,211 个 reasoning 字符，是其本地上下文增长的重要贡献者。正文去重修复是有效且必要的，但无法单独解决长会话成本。

缓存率也不能独立代表布局优劣：正文去重降低总输入，即使缓存率百分比不升也可能降低实际成本；相反，保留更多可缓存旧内容可能提高百分比，却增加总 token。后续实验必须同时记录 uncached input、cache read、总输入、首 token 延迟、总时延和费用。

## 7. 当前发现的问题

### 7.1 迟到的 Peer Reply 产生冗余处理

Navigator Event 77 曾询问调研进度；Pilot 随后先通过 Event 83 正式 completion handoff，Navigator 已生成 Event 88 完成汇总，但 Pilot 仍通过 Event 90 回复旧的进度询问，Navigator 又生成 Event 94 再次确认完成。

这不是同一 Pair Event 被重复投影，而是 pending `expectsReply` 在对应任务已正式完成后仍被处理。后续应让 completion handoff 能满足或关闭同一因果链中的旧状态询问，或者在 P2 reconciliation 中抑制已经失去信息增量的迟到回复。

### 7.2 共享上下文不等于独立验证

Pilot 在评价 CrewAI 与 Pair Agent 时已经能看到 Navigator 的回答。当前 UI 和 Agent 回答没有清楚披露这条可见性关系，导致 Navigator 把一致性描述为“自然收敛”。这不影响共享协作正确性，但影响用户对独立性的理解。

建议后续在请求审计或 UI 中暴露关键 Shared Head/因果信息；若用户明确要求独立判断，再使用冻结 Shared Head 的独立评审模式。

### 7.3 Reasoning retention 尚无治理策略

当前选择安全地保留 reasoning，保证 Chat Completions 本地 continuation，但尚未区分：

- 当前未完成 tool loop 必须保留的 reasoning；
- 已完成 Turn 对未来仍有价值的 reasoning；
- 已被 Shared Event 结果覆盖、可以 checkpoint 或摘要化的 reasoning。

在建立明确的语义和回归矩阵前，不应简单删除 reasoning。

## 8. 工程验证状态

当前实现已通过：

- Workspace 包级测试 672 项；
- P0.5 共享会话 E2E 9 项；
- Phase 0 Chromium E2E 7 项；
- TypeScript typecheck 与 production build；
- DSH request-layout/addressed-session/fixed-root 单元回归 154 项；
- DSH addressed embedded Chromium 回归 5 项；
- summary link identity/digest、错误来源、摘要不匹配、相同文本不同消息、trailing terminal events、Provider materialization 等专项测试。

自动测试与本次真实会话共同证明当前 P0.5 行为链路，但不等同于生产多租户、安全隔离、完整故障恢复或成本上界保证。

## 9. 当前结论与下一步

当前 P0/P0.5 原型已经证明：

- 两个长期独立 Agent Session 可以通过 Pair Ledger 获得一致共享事实；
- 普通共享、有限定向问答和持续任务完成交付可以分离；
- Navigator → Pilot 委派、真实 Web Search、turn-end completion handoff、Navigator 最终回收形成可运行闭环；
- identity + digest 允许在不误删同文不同消息的前提下，去除已共享 assistant 正文；
- 请求布局、Local History 决策和 Provider cache usage 已具备基础可审计数据。

当前不应继续增加纯 Prompt 式 P0.5 行为约束。下一阶段的正确性主线是 P1：

1. 设计并实现最小 Goal/Task/Execution Plan 权威状态；
2. 实现 Goal-impact 分类与用户/Pilot 输入的确定性 escalation；
3. 引入 Task Revision fencing 和 Harness 执行权限绑定；
4. 明确 Pause/Resume/Cancel 与 pending inbox 行为。

以下问题应作为独立实验线或 P2 工作，不与 P1 状态机同时修改：

- Shared Checkpoint 与长会话压缩；
- reasoning retention；
- 迟到 Peer Reply 与 processing reconciliation；
- 独立评审的 Shared Head 冻结；
- ArtifactRef、Plan Mode、workflow 与 continuable Sub-agent。

## 10. MVP 技术方案完成度

[`pair-agent-dsh-mvp.md`](pair-agent-dsh-mvp.md) 将 P0 定义为运行骨架、P0.5 定义为共享对话与 Agent 通信、P1 定义为权限和并发、P2 定义为恢复和执行生态，并明确“P2 完成代表 MVP 语义闭环完成，不代表生产就绪”。因此当前仍是 **P0/P0.5 原型，不是已经完成的 MVP 版本**。

| 阶段 | 当前状态 | 已完成 | 距离阶段完成仍缺少 |
| --- | --- | --- | --- |
| P0：运行骨架 | 基本完成 | DSH 固定源码、Pair Ledger/Projection、两个顶层 Agent Session、Chat Completions、本地重建、cache-first layout、双 Pane、Events UI、请求分段观测、truthful capability UI | 结构化 Task Domain 按现行设计归入 P1 |
| P0.5：共享对话与通信 | 功能闭环完成，生产可靠性未收口 | 双向输入、Bridge、durable final、普通共享不唤醒、Peer Message、Completion Handoff、原生 Web Search、Local History 安全去重、短日志恢复 | 接收方处理中断后的 reconciliation、持久 unread cursor 与长日志增量恢复按规划留给 P2 |
| P1：权限和并发 | 尚未实现 | Prompt 已保留最终目标和角色边界；双 Pane 已允许并行用户交互 | Goal/Task/Plan、Goal-impact、Harness 权限绑定、Revision fencing、Pause/Resume/Cancel、确定性 escalation |
| P2：恢复和执行生态 | 部分基础提前完成 | Pair + 两 Session 重启恢复、请求快照、immutable materials、部分 crash-window 测试 | 全窗口对账、持久 cursor、Plan Mode/workflow/Sub-agent、ArtifactRef、完整故障注入 |

完成 MVP 语义闭环前仍必须补齐 P1/P2 核心能力和技术方案验收矩阵。Shared Checkpoint、Responses API、产品级单 React 树、多进程/跨机器和生产多租户不属于当前 P0–P2 的最低完成门槛，但长会话实际使用前必须为上下文增长建立明确上限和降级策略。
