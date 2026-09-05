# Completion-specific Turn-end Handoff 设计

## 1. 背景与问题

P0.5 当前使用 `pair_message_peer` 同时完成两件事：把 Agent 间协调消息写入 Pair Ledger，以及立即唤醒接收方。该语义适合需要对方立即行动的普通协作消息，但不适合 Pilot 的委派完成回报。

Pilot 通常会在一次 DSH Turn 的中间步骤调用工具，再在后续步骤生成最终回答。若完成回报复用即时 Peer Message，Navigator 会在 Pilot 最终回答进入 durable DSH Session、并被 Bridge 投影为 Shared Event 之前醒来。Navigator 因而可能错误判断交付缺失，产生追问、重复执行和重复正文。

本设计为 Pilot → Navigator 增加独立的 Completion-specific Turn-end Handoff。它只解决完成回报的时序与单份正文问题，不把 P1 的结构化 Task 状态或 P2 的通用 Delivery State Machine 提前引入 MVP。

## 2. 已确认决策

1. 新增 `pair_report_completion`，仅允许 Pilot 成功调用。
2. 工具不接受业务参数，也不立即写共享完成消息或唤醒 Navigator；它只在当前 Pilot Turn 的 durable DSH Session 中登记完成意图。
3. Pilot 在工具成功后输出完整、可独立理解的最终完成报告。完成状态、关键结果与证据、未决问题或下一步都写在这份最终回答中。
4. 只有 `turn/end.reason.kind === "completed"` 且工具调用成功、其后存在公开最终文本时，Bridge 才发布完成回报。
5. Pilot 最终回答只投影为一条 `agent.message(kind="completion-handoff", channel="navigator")`，不再复制一条相同正文的普通 `turn-output`。
6. Pair Host 必须先持久化并发布该 Shared Event，再用只含引用的 Trigger 唤醒 Navigator。
7. Trigger 引用 `pairEventId = pairId:seq`，而不是 LLM `requestId`。完整正文不复制到 Trigger。
8. `pair_message_peer` 保持即时、双向，继续用于需要对方立刻行动的普通协调，不再用于委派完成回报。

## 3. Tool Contract

模型可见定义：

```json
{
  "name": "pair_report_completion",
  "description": "Register this Pilot Turn's final public answer for delivery to Navigator after durable turn completion.",
  "parameters": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

Host 从 DSH ToolRunContext 绑定 Agent、Session 和 open Turn。模型不能指定 Pair ID、目标角色、Turn、Shared Event ID、唤醒行为或权限。

工具执行时必须验证：

- active Agent 与 Session 身份一致且属于当前 Pair；
- sender role 是 Pilot；
- Turn 仍处于 open 状态；
- 当前 Turn 的 canonical input provenance 满足共享 causality 规则；
- 当前 Turn 尚未成功登记 completion handoff。

同一 Session+Turn 的并发调用必须串行化；第一次成功登记后，其余并发或串行重复调用全部拒绝。等待 provenance barrier 返回后必须重新核对 Agent、Session、role 与 open Turn，避免把已关闭或已换绑的上下文登记为完成。

成功结果只表示“已登记”，不表示已经通知 Navigator：

```text
Completion handoff registered for this Pilot Turn. Provide the complete final report now; Navigator will be notified only after the Turn is durably completed.
```

工具调用、`tool/call` 和 `tool/result(isError=false)` 保留在 Pilot 的 DSH Session。Pair Ledger 不增加 pending intent 事件。

## 4. Turn-end 识别与投影

Bridge 处理一个完整 Turn 时，按以下条件识别 completion handoff：

1. Turn 内存在一个 `tool/call(name="pair_report_completion")`；
2. 存在 call ID 对应的成功 `tool/result`；
3. 最终公开 assistant message 位于成功 tool result 之后；
4. `turn/end` 原因是 `completed`；
5. Session 绑定角色是 Pilot。

若全部满足，最终文本投影为：

```json
{
  "type": "agent.message",
  "actor": { "kind": "agent", "role": "pilot" },
  "source": "pilot-session",
  "channel": "navigator",
  "visibility": "shared",
  "authority": "pilot",
  "payload": {
    "schemaVersion": 1,
    "kind": "completion-handoff",
    "text": "<Pilot 最终报告>",
    "content": [{ "type": "text", "text": "<Pilot 最终报告>" }],
    "completion": "complete",
    "origin": {
      "schemaVersion": 1,
      "sessionId": "<pilot-session-id>",
      "sessionEventSeq": 123,
      "turn": 7,
      "messageId": "<assistant-message-id>"
    },
    "causalRootId": "<canonical-root-pair-event-id>",
    "hop": 2
  }
}
```

`origin` 和 canonical source identity 使重复 Bridge drain 复用同一 Pair Event。`completion-handoff` 与 `peer-message` 都属于严格 canonical directed agent message：前者消耗当前因果链的一跳，Navigator 在接收 Turn 中继续使用 `pair_message_peer` 时再增加一跳。因此 Peer Message 和 Completion 必须复用同一个 causality 函数，不能把 completion handoff 当成应拒绝的普通 `agent.message`。

该 causality 函数保持现有规则：一个 user/task root 产生 hop 1；一个或多个 directed input 必须全部属于同一 `causalRootId`，输出 hop 为输入最大 hop 加一；directed 与其他输入混合、多个 root 或超过 `MAX_PEER_HOPS` 均 fail closed。

完成登记以 append-origin `tool/result(surfaceOp="append")` 的稳定成功状态为准。DSH 的后续 `surfaceOp.replace` 只能改写 tool-result content，不能把失败改成成功或改变 call identity；Bridge 不把 replacement copy 计为第二次成功登记，明确 `ignorable` 的无关事件也不参与登记计数。本功能不顺带重定义 Bridge 对所有未来 DSH event type 的兼容策略。

下列情况不得发布或唤醒：

- Navigator 调用该工具；
- 工具结果失败或缺失；
- `turn/end` 是 `max-tokens`、`error`、`interrupted`、`aborted` 或其他非 completed 原因；
- 工具成功后没有最终公开文本；
- 最终 assistant message 仍包含 tool call；
- provenance 不唯一或跨 Pair。

## 5. Shared Event 与 Trigger 顺序

严格顺序为：

```text
Pilot DSH tool/result durable
  → Pilot final assistant/message durable
  → Pilot turn/end completed durable
  → Bridge append completion-handoff Shared Event
  → Bridge append session_event.linked
  → Pair projection/shared head published
  → Host inject reference-only delivery into Navigator Session
  → Navigator Turn starts and builds its Provider request
```

Navigator 的 Trigger 只包含引用：

```json
{
  "kind": "completion-handoff",
  "pairEventId": "pair-example:128",
  "senderRole": "pilot",
  "senderTurn": 7
}
```

Provider 请求必须满足 `snapshot.sourceLedgerHead >= completionEvent.seq`，且 Shared Context 中该 seq 只有一条 completion semantic event。审计 link 与 Trigger 可以再次引用同一 ID，因此测试不得用原始字符串出现次数代替语义事件计数。若覆盖条件不成立，请求构建应 fail closed，而不是用 Trigger 正文补偿。

## 6. 幂等与恢复

完成回报使用最终 Pilot assistant message 的 canonical DSH source identity。重复 drain 或冷恢复时：

- 已存在且内容一致：复用原 Pair Event；
- 同一 source identity 内容不同：Bridge fault；
- Pair Event 已写、Navigator delivery 尚未写：重新投递引用；
- Navigator delivery 已 durable：不得重复注入或重复唤醒。

为跨进程恢复最后一种状态，DSH adapter 在 create/resume Agent 时从该 Session 已持久化的 `source.kind="plugin", plugin="pair-agent:delivery"` 消息重建 accepted delivery ID 集合。内存集合只作为当前进程的快速索引，DSH Session 才是恢复事实来源。

本设计保证 Completion-specific Handoff 的 Shared Event 唯一，以及 Navigator durable delivery admission 的恢复去重。若 delivery 已 durable、但 Navigator 已启动的处理 Turn 在 Provider 或执行阶段崩溃，恢复不会盲目重复注入同一 delivery；如何判断并重启未完成的接收方处理属于 P2 reconciliation。本设计不宣称 Navigator processing exactly-once，也不宣称完成所有普通 Peer/Pair delivery 的 P2 exactly-once reconciliation。

“只有一份完整结果正文”是指不再同时生成 completion Peer Event 与 Pilot `turn-output` 两条语义事件。Pair Ledger 的 canonical message payload 仍按现有合同同时保存 `text` 与 `content`；Provider 使用已有的 `text-dedup-v1` 投影消除模型输入中的字段级重复，本功能不再次改动该存储合同。

## 7. Prompt 更新

Common System 和 Pilot guidance 改为：

- Navigator 委派持续执行时，明确要求 Pilot 在最终报告前调用 `pair_report_completion`；
- Pilot 完成委派工作后，先调用一次 `pair_report_completion`，成功后把完整报告作为当前 Turn 的最终公开回答；
- 工具成功只表示登记，不能声称 Navigator 已收到；
- 完成回报不再通过 `pair_message_peer`；
- 普通公开回答仍被动共享，普通即时协调仍使用 `pair_message_peer`。

Prompt bundle 与 tool set 都是 immutable request material。该变更不兼容旧测试 Pair；当前未发布 MVP 直接清理测试数据并重新创建，不实现迁移。

## 8. 验收标准

1. Pilot completion 工具调用时，Navigator 尚未开始新 Turn。
2. Pilot `turn/end` 后，Ledger 中只有一份完整结果正文，类型为 `completion-handoff`。
3. Navigator delivery Trigger 不包含完整结果，只包含该 Pair Event 引用。
4. Navigator Provider 请求的 Shared Context 已含被引用事件，且 snapshot ledger head 不早于该事件。
5. 普通 Pilot final answer 不唤醒 Navigator；普通 `pair_message_peer` 仍即时唤醒。
6. Navigator 或失败/中断/partial Turn 不能产生 completion handoff。
7. 在 Pair Event append 与 Navigator delivery 之间重启，恢复后只注入一次 delivery；再次重启不产生重复事件或 Turn。
8. Navigator 在 completion-triggered Turn 中继续发送 Peer Message 时，沿同一 `causalRootId` 增加 hop；混合 root 与超限仍被拒绝。
9. Prompt、tool catalog、request material 重建、Pair/DSH vocabulary separation 与现有 P0.5 测试全部通过。
