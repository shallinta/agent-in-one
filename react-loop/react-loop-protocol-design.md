# 通用 ReAct Loop 跨语言协议与 TypeScript 参考实现设计

> 状态：架构方向已确认。本文是独立设计稿，不绑定任何现有项目、仓库结构、UI 框架或 AgentCore。

## 1. 背景

常见 ReAct Agent 都包含相似的外层编排：

1. 请求 AgentCore 执行一个模型 Turn。
2. 接收模型输出或 Tool Calls。
3. 根据策略决定自动执行、暂停审批、提供合成结果或终止。
4. 执行工具并把结果交还 AgentCore。
5. 继续下一 Turn，直到完成、暂停、失败、取消或达到限制。

这段逻辑经常与具体消息类型、状态容器、流式事件、工具实现、UI、持久化和某个 AgentCore 耦合，无法安全地跨项目复用。

本方案将 ReAct 编排定义为语言无关的控制平面协议，并同时提供一个独立 TypeScript 参考实现。其他语言实现只要通过同一套协议 Schema、状态转换向量和事件轨迹测试，即可获得一致语义。

## 2. 目标

- 定义与语言、框架、传输和 AgentCore 无关的 ReAct Loop 协议。
- 支持不同 AgentCore、模型 Provider、工具系统和持久化系统。
- 支持自动工具执行、人工审批、暂停、恢复、取消和 Checkpoint。
- 支持本地进程、跨进程和远程执行。
- 保证状态转换可重放、可测试、可审计；Durable Runner 还必须原子保存
  Transition Record，保证规范事件在进程崩溃后仍可读取和重放。
- 提供独立 TypeScript 包作为参考实现。
- 为其他语言实现提供机器可执行的合规测试。

## 3. 非目标

协议不负责：

- 定义统一聊天 Message、Prompt、Memory 或 Graph State。
- 渲染 Prompt、变量、模板或 Skills。
- 调用具体模型 Provider。
- 实现 Built-in、MCP、HTTP 或业务工具。
- 管理 UI、响应式 Store、Run History 或评测数据。
- 规定 token delta、thinking delta 等 AgentCore 私有流事件。
- 提供分布式 exactly-once 保证。
- 替代 AgentCore 自己的模型调用、上下文压缩或推理能力。

## 4. 已选架构

采用“控制平面协议 + 纯状态机 + TypeScript 解释器”：

```text
Host Application
  ├─ AgentCore Adapter
  ├─ Tool Executor
  ├─ Loop Policy
  ├─ Loop Store
  ├─ Run Execution Coordinator
  └─ Event Observer
             │
             ▼
TypeScript Reference Package
  ├─ Async Runner
  ├─ Effect Interpreter
  ├─ Protocol Bindings
  └─ Conformance Utilities
             │
             ▼
Language-Neutral Protocol
  ├─ State Machine
  ├─ Inputs and Effects
  ├─ JSON Schema
  ├─ Error Codes
  └─ Conformance Vectors
```

协议规范是主产品。TypeScript 包是第一个合规实现，不拥有额外的隐藏语义。

## 5. 设计原则

### 5.1 控制平面与数据平面分离

协议只理解 Turn、Tool Call、Tool Result、Policy Decision 和生命周期状态。AgentCore 的消息、Memory 和 Graph State 通过不透明的 `Continuation` 传递。

### 5.2 Effect 驱动

纯状态机不直接调用 AgentCore、工具或持久化系统。它接收 Input，产生新 State、Effects 和规范事件：

```text
transition(state | null, input)
  → next_state
  → effects[]
  → events[]
```

只有 `start` 可以接收 `null` State；其他 Input 接收 `null` 时返回
`run_not_found`。

### 5.3 单 Turn 边界

AgentCore Adapter 每次最多执行一个模型 Turn，并且必须在以下边界归还控制权：

- Agent 完成；
- 产生 Tool Calls；
- AgentCore 主动暂停；
- 本 Turn 失败或被取消。

只提供“一直运行到结束”API 的 AgentCore 必须先增加 Step/Interrupt Adapter。禁止在通用外层 Loop 与 AgentCore 内部完整 Loop 之间形成无法观察的双重循环。

### 5.4 JSON 可表达

所有规范对象必须能用标准 JSON 表达。二进制内容、不可序列化对象或大型状态通过 Reference 传递。

### 5.5 确定性

给定相同 State、Input 和协议版本，状态机必须产生相同的 next state、effect 描述和规范事件。时间、随机 ID 和网络结果由解释器注入，不能隐藏在状态转换函数中。

## 6. 协议版本

每个独立序列化、持久化或跨进程传输的顶层协议对象都包含：

```json
{
  "protocol_version": "1.0.0-draft.2"
}
```

后文为突出 Variant Payload 而省略该字段的 JSON 片段都只是简写；对应顶层 JSON
Schema 仍必须要求 `protocol_version`。嵌套在 State、Effect 或 Record 内部的对象
继承外层版本，不重复携带该字段。

版本规则：

- 遵循 SemVer；预发布阶段使用 `1.0.0-draft.N`，稳定版本使用 `1.0.0`。
- Major：不兼容的字段、状态或语义变化。
- Minor：向后兼容的新字段、新事件和可选能力。
- Patch：不改变语义的 Schema、Fixture 或文字勘误。
- 未识别的普通字段必须忽略；只有 `extensions` 中的未知字段保证 round-trip 保留。
- 未识别的 discriminant 必须返回 `unsupported_variant`，不能静默猜测。
- 扩展字段必须使用反向域名或组织前缀命名，例如 `extensions["org.example.trace"]`。

## 7. JSON 基础类型

```text
JsonPrimitive = null | boolean | number | string
JsonValue     = JsonPrimitive | JsonValue[] | { string: JsonValue }
```

协议不得依赖 `undefined`、NaN、Infinity、Date、Map、Set、class instance 或循环引用。

`revision`、`turn_index`、`event_sequence`、`record_sequence` 等协议整数必须
处于 `0..9007199254740991`。协议拒绝负零。需要表达更大范围的业务数字时，
必须使用十进制字符串或 namespaced Extension。

## 8. Continuation

Continuation 是 AgentCore 私有状态的稳定载体：

```json
{
  "kind": "inline",
  "value": {}
}
```

或者：

```json
{
  "kind": "reference",
  "reference": "core-state:abc123",
  "revision": "etag-7"
}
```

约束：

- Loop 不读取或修改 Continuation 内容。
- Adapter 对 Continuation 的创建、解析和版本兼容负责。
- Reference 的生命周期、访问控制和存储由宿主负责。
- Checkpoint 可能包含敏感上下文；加密、脱敏和访问控制属于宿主责任。

## 9. Loop State

规范状态：

```json
{
  "protocol_version": "1.0.0-draft.2",
  "run_id": "run_123",
  "revision": 7,
  "last_input_id": "input_9",
  "status": "awaiting_tools",
  "turn_index": 2,
  "event_sequence": 14,
  "continuation": {
    "kind": "inline",
    "value": {}
  },
  "limits": {
    "max_turns": 50,
    "input_receipt_window": 128
  },
  "execution_contract": {
    "turn_retry_safe": false,
    "ownership_mode": "exclusive",
    "atomic_fence_enforcement": false
  },
  "pending": {
    "effect_id": "run_123:7:execute_tool_batch:0",
    "kind": "execute_tool_batch",
    "run_id": "run_123",
    "batch_id": "run_123:tool-batch:2",
    "progress": [
      {
        "call": {
          "call_key": "run_123:tool-batch:2:0",
          "call_id": "call_1",
          "name": "read_file",
          "arguments": {
            "path": "README.md"
          },
          "metadata": {},
          "extensions": {}
        },
        "retry_safe": false,
        "outcome": {
          "kind": "pending"
        }
      }
    ],
    "execute_call_keys": [
      "run_123:tool-batch:2:0"
    ],
    "mode": "parallel",
    "max_concurrency": 4,
    "idempotency_key": "run_123:7:execute_tool_batch:0"
  },
  "input_receipts": [
    {
      "input_id": "input_9",
      "applied_revision": 7
    }
  ],
  "extensions": {}
}
```

`status` 枚举：

```text
awaiting_turn
awaiting_tool_decision
awaiting_tools
paused
completed
failed
cancelled
```

状态约束：

- 新 Run 由 `start` 从不存在状态原子创建为 Revision `0`；此后每次有效转换
  Revision 加一。
- `last_input_id` 是最近一次成功应用的 Input。
- `turn_index` 表示已经完成的模型 Turn 数。
- `pending` 最多存在一个完整、可重新执行的控制平面 Effect，不能只保存 ID。
- `input_receipts` 保存去重窗口内已经应用的 Input ID。
- `execution_contract` 是 Start 时 AgentCore、Tool Executor 与 Runner
  Ownership 能力校验结果的持久化快照；恢复时不能根据当前进程配置重新猜测。
- `max_turns` 和 `input_receipt_window` 必须是大于等于 `1` 的安全整数。
- `completed`、`failed`、`cancelled` 是终态。
- 终态不能再接受 Resume 或 Effect Result。
- 重复 Cancel 是幂等操作。

### 9.1 状态判别联合

`LoopState` 不是一个把所有字段都设为可选的宽对象。公共字段之外，各
`status` 必须满足以下互斥约束：

| `status` | 必须字段 | 禁止字段 |
| --- | --- | --- |
| `awaiting_turn` | `pending.kind = run_turn` | `pause`、终态字段 |
| `awaiting_tool_decision` | `pending.kind = decide_tool_batch` | `pause`、终态字段 |
| `awaiting_tools` | `pending.kind = execute_tool_batch` | `pause`、终态字段 |
| `paused` | `pending = null`、与 `pause.kind` 对应的 `pause` | 终态字段 |
| `completed` | `pending = null`、`completion` | `pause`、`error`、`cancellation` |
| `failed` | `pending = null`、`error` | `pause`、`completion`、`cancellation` |
| `cancelled` | `pending = null`、`cancellation` | `pause`、`completion`、`error` |

`completion` 是封闭联合：

```text
finished
  → { reason: "finished", successful: true, output: JsonValue }

stopped
  → { reason: "stopped", source: "policy" | "resume",
      successful: boolean, output: JsonValue | null }

max_turns_reached
  → { reason: "max_turns_reached", successful: false }
```

`failed.error` 使用第 20 节的统一错误；`cancelled.cancellation` 至少包含
`{ reason: string }`。JSON Schema 必须用 `status` 作为 discriminator，禁止依靠
字段是否存在猜测状态。

## 10. Turn 请求

状态机产生 `run_turn` Effect：

```json
{
  "effect_id": "run_123:8:run_turn:0",
  "kind": "run_turn",
  "run_id": "run_123",
  "turn_index": 2,
  "continuation": {
    "kind": "reference",
    "reference": "core-state:abc123",
    "revision": "etag-7"
  },
  "tool_results": [],
  "resume_input": null,
  "retry_safe": false,
  "idempotency_key": "run_123:8:run_turn:0"
}
```

首次 Turn 的 `tool_results` 和 `resume_input` 为空。

工具执行后的下一 Turn 携带 Tool Results。AgentCore 主动暂停后恢复的下一 Turn 携带 Resume Input。Adapter 负责将其转换为自身消息、Graph Command 或 State Update。

## 11. Turn 结果

AgentCore Adapter 必须返回以下结果之一。

### 11.1 完成

```json
{
  "kind": "finished",
  "continuation": {
    "kind": "reference",
    "reference": "core-state:abc124",
    "revision": "etag-8"
  },
  "output": {
    "summary": "Agent completed without requesting tools."
  }
}
```

### 11.2 请求工具

```json
{
  "kind": "tool_calls",
  "continuation": {
    "kind": "reference",
    "reference": "core-state:abc125",
    "revision": "etag-9"
  },
  "calls": [
    {
      "call_id": "call_1",
      "name": "read_file",
      "arguments": {
        "path": "README.md"
      },
      "metadata": {},
      "extensions": {}
    }
  ]
}
```

约束：

- `call_id` 由 AgentCore/Provider 提供，只要求在当前 Tool Call Batch 中唯一；空值、
  重复值或缺失值使整个 `tool_calls` Outcome 成为 `invalid_turn_outcome`。
- Calls 顺序必须保持。
- `arguments` 必须是 JsonValue。
- 空 Calls 是协议错误，不能当作完成。

Loop 不把 Provider 的 `call_id` 直接作为内部主键。状态机接收合法 Batch 后按原始
顺序生成：

```text
batch_id = run_id + ":tool-batch:" + turn_index
call_key = batch_id + ":" + ordinal
```

`ordinal` 从 `0` 开始。后续 Policy、Tool Effect、Pause、Resume 和 Tool Result
都使用 `call_key` 合并；`call_id` 只负责 Adapter 向 AgentCore 回传结果。这样既
保留上游关联 ID，也不要求 State 永久保存所有历史 Provider ID。

### 11.3 AgentCore 主动暂停

```json
{
  "kind": "paused",
  "continuation": {
    "kind": "reference",
    "reference": "core-state:abc126",
    "revision": "etag-10"
  },
  "reason": "human_input_required",
  "resume_schema": {},
  "allowed_actions": [
    "continue",
    "stop"
  ]
}
```

## 12. Tool Result

成功：

```json
{
  "call_key": "run_123:tool-batch:2:0",
  "call_id": "call_1",
  "status": "success",
  "output": {}
}
```

工具业务错误：

```json
{
  "call_key": "run_123:tool-batch:2:0",
  "call_id": "call_1",
  "status": "error",
  "error": {
    "code": "tool_execution_failed",
    "message": "Connection timed out",
    "retryable": true,
    "details": {}
  }
}
```

策略拒绝：

```json
{
  "call_key": "run_123:tool-batch:2:0",
  "call_id": "call_1",
  "status": "denied",
  "error": {
    "code": "tool_denied",
    "message": "The tool call was denied by policy.",
    "retryable": false,
    "details": {}
  }
}
```

工具错误默认作为数据返回 AgentCore，使 Agent 有机会修正。Tool Executor、传输、协议解析等基础设施错误按第 20 节处理。

`ToolResult` 使用 `status` 作为 discriminator：

| `status` | 必须字段 | 禁止字段 |
| --- | --- | --- |
| `success` | `call_key`、`call_id`、`output` | `error` |
| `error` | `call_key`、`call_id`、`error` | `output` |
| `denied` | `call_key`、`call_id`、`error` | `output` |

`error` 和 `denied` 的错误对象都必须包含 `code`、`message`、`retryable` 和
`details`。Result 的 `call_key`、`call_id` 必须同时与目标 Progress Entry 的 Call
一致；任一不匹配都返回 `tool_result_mismatch`，不能只凭其中一个字段合并。

### 12.1 Tool Batch Progress

工具批次沿用“结果回填到原调用位置”的模型，但不用可选 `output` 猜测生命周期。
`ToolBatchProgress` 是按原始顺序排列的 Entry 数组；每项的 `outcome` 是封闭联合：

```text
pending
  → { kind: "pending" }

result
  → { kind: "result", result: ToolResult }

unknown
  → { kind: "unknown" }
```

每个 Entry 还保存规范化后的完整 Call 和 `retry_safe: boolean`。三者语义严格
区分：`pending` 表示当前 Effect 将尝试执行，`result` 表示结果已确认，`unknown`
表示 Effect 已返回或恢复时无法确认副作用是否发生。

`execute_tool_batch` 必须携带完整 Progress 和本次真正执行的
`execute_call_keys`。Tool Executor 对这些 Key 中的每一项返回且只返回一个
`result` 或 `unknown` Outcome；状态机按 `call_key` 原位合并，不能按完成顺序或
裸 `call_id` 合并。

## 13. Tool Batch Policy

Policy 接收整个 Tool Call Batch 和只读 Loop 摘要，返回：

```text
execute  自动执行整个批次
supply   不执行，直接提供完整合成结果
pause    保存 Checkpoint，等待人工处理
stop     结束当前运行
```

V1 使用“批次决策原子语义”：

- Policy 必须对整个批次一次性选择 execute、supply、pause 或 stop；
- Policy 不允许批准部分 Call 后再等待剩余审批；
- `supply` 必须为每个 Call 提供且只提供一个 Result。

该原子性只覆盖“执行前决策”，不承诺工具副作用的事务原子性。工具开始执行后
仍可能出现部分成功、部分失败或执行状态未知。`tool_batch_failed` 必须返回本次
`execute_call_keys` 的 Outcome，例如：

```json
{
  "outcomes": [
    {
      "call_key": "run_123:tool-batch:2:0",
      "outcome": {
        "kind": "result",
        "result": {
          "call_key": "run_123:tool-batch:2:0",
          "call_id": "call_1",
          "status": "success",
          "output": {
            "bytes_read": 42
          }
        }
      }
    },
    {
      "call_key": "run_123:tool-batch:2:1",
      "outcome": {
        "kind": "unknown"
      }
    }
  ]
}
```

`outcomes` 必须无重复并完整覆盖本次 `execute_call_keys`。合并后所有 Entry 都是
`result` 才算 Batch 完成；只要存在 `unknown`，状态机就进入
`paused/uncertain_tools`。只有 Entry 自身 `retry_safe: true` 的 `unknown` 才允许
进入后续重试 Effect。

混合审批、工具依赖图和分组执行留给后续兼容扩展。

`execute` 可选择：

```json
{
  "kind": "execute",
  "mode": "parallel",
  "max_concurrency": 4
}
```

其他 Policy Decision 的最小规范形状固定为：

```text
supply
  → { kind: "supply", results: ToolResult[] }
  → results 必须按原始顺序覆盖整个 Batch

pause
  → { kind: "pause", reason: string }

stop
  → { kind: "stop", reason: string,
      successful: boolean, output: JsonValue | null }
```

模式支持 `parallel` 或 `sequential`。无论完成顺序如何，提交给 AgentCore 的 Tool Results 必须恢复为原始 Tool Calls 顺序。
`max_concurrency` 必须是大于等于 `1` 的安全整数；`sequential` 模式下规范值为
`1`。

## 14. Inputs

规范 Input：

```text
start
turn_completed
turn_failed
tool_decision_completed
tool_decision_failed
tool_batch_completed
tool_batch_failed
resume
recover
cancel
```

每个 Input 包含：

```json
{
  "input_id": "input_10",
  "run_id": "run_123",
  "expected_revision": 7
}
```

Effect Result 还必须包含对应的 `effect_id`。

`start.expected_revision` 必须是 `null`，表示只允许原子
create-if-absent；其他 Input 的 `expected_revision` 必须是安全整数，并与权威
State Revision 一致。

由 Effect 产生的结果 Input 使用确定性 ID：

```text
input_id = effect_id + ":result"
```

外部 `start`、`resume`、`cancel` 命令的 `input_id` 由调用方提供。

`start` Input 必须携带 AgentCore Capability Snapshot；状态机将
`idempotent_turns` 固化为 `execution_contract.turn_retry_safe`，并保存已验证的
`ownership_mode` 与 `atomic_fence_enforcement`。执行型
`tool_decision_completed` 必须携带 Tool Executor 针对当前 Calls 计算出的
`retry_safe_call_keys`，状态机将其写入 `ToolBatchProgress`。
该数组必须无重复，且只能包含当前 Batch 的 `call_key`；未列出的 Call 一律视为
`retry_safe: false`。重复或外来 Key 返回 `invalid_retry_safe_set`。

### 14.1 Input 判别联合

所有 Input 使用 `kind` 作为 discriminator，并在公共 Envelope 之外携带以下唯一
Payload；表中未列出的 Variant 专属字段禁止出现：

| `kind` | 必须 Payload |
| --- | --- |
| `start` | `continuation`、`limits`、`agent_core_capabilities`、`tool_executor_capabilities`、`runner_capabilities`；`expected_revision = null` |
| `turn_completed` | `effect_id`、`outcome: TurnOutcome` |
| `turn_failed` | `effect_id`、`error` |
| `tool_decision_completed` | `effect_id`、`decision: ToolBatchDecision`；`execute` 时还必须有 `retry_safe_call_keys` |
| `tool_decision_failed` | `effect_id`、`error` |
| `tool_batch_completed` | `effect_id`、覆盖本次 `execute_call_keys` 且全部为 `result` 的 `outcomes` |
| `tool_batch_failed` | `effect_id`、覆盖本次 `execute_call_keys` 且至少一个为 `unknown` 的 `outcomes` |
| `resume` | `pause_id`、`action: ResumeAction` |
| `recover` | `effect_id`，必须等于当前 `pending.effect_id` |
| `cancel` | `reason` |

`recover` 不是 Effect Result，其确定性 ID 为：

```text
input_id = pending.effect_id + ":recover:" + expected_revision
```

`ToolBatchDecision`、`ResumeAction`、`TurnOutcome`、`LoopState` 和统一错误都必须各自
使用封闭 JSON Schema `oneOf`。边界 Validator 必须先选中唯一 Variant，再把对象
交给状态机；TypeScript 类型断言不算协议验证。

## 15. Effects

规范 Effect：

```text
run_turn
decide_tool_batch
execute_tool_batch
```

状态机只描述 Effect；解释器负责执行。

每个 Effect 必须自包含，Checkpoint 恢复不得依赖进程内闭包：

- `run_turn` 包含 Continuation、Tool Results、Resume Input 和 Turn Index。
- `decide_tool_batch` 包含完整 Tool Calls 和只读 Loop 摘要。
- `execute_tool_batch` 包含完整 Tool Batch Progress、本次
  `execute_call_keys`、执行模式、并发限制和幂等键。

Effect 使用 `kind` 作为 discriminator，最小必填字段为：

| `kind` | 必须字段 |
| --- | --- |
| `run_turn` | `effect_id`、`run_id`、`turn_index`、`continuation`、`tool_results`、`resume_input`、`retry_safe`、`idempotency_key` |
| `decide_tool_batch` | `effect_id`、`run_id`、`batch_id`、带 `call_key` 的完整 `calls`、`loop_summary` |
| `execute_tool_batch` | `effect_id`、`run_id`、`batch_id`、`progress`、`execute_call_keys`、`mode`、`max_concurrency`、`idempotency_key` |

Effect ID 必须确定性生成：

```text
effect_id = run_id + ":" + target_revision + ":" + effect_kind + ":" + ordinal
```

同一次转换产生多个 Effect 时，`ordinal` 从 `0` 开始递增。禁止用时间或随机数
生成规范 Effect ID。

状态持久化不是 Effect，而是 Runner 的提交屏障：Runner 必须把 Transition
产生的 next State 和 Transition Record 原子写入唯一权威 `LoopStore`，成功后
才能分发 Effects 和事件。因此状态机不会产生第二套 Checkpoint CAS 流程。

## 16. 状态转换

主路径：

```text
absent
  └─ start(expected_revision = null)
       → create-if-absent awaiting_turn(revision = 0)
       → run_turn

awaiting_turn
  ├─ turn_completed(finished)
  │    → completed
  ├─ turn_completed(tool_calls)
  │    → awaiting_tool_decision
  │    → decide_tool_batch
  ├─ turn_completed(paused)
  │    → paused/agent_core
  ├─ turn_failed
  │    → failed
  └─ cancel
       → cancelled

awaiting_tool_decision
  ├─ decision(execute)
  │    → awaiting_tools
  │    → execute_tool_batch
  ├─ decision(supply)
  │    → turn_index < max_turns：awaiting_turn → run_turn
  │    → turn_index == max_turns：completed/max_turns_reached
  ├─ decision(pause)
  │    → paused/tool_approval
  ├─ decision(stop)
  │    → completed/stopped(source = policy)
  ├─ tool_decision_failed
  │    → failed
  └─ cancel
       → cancelled

awaiting_tools
  ├─ tool_batch_completed | tool_batch_failed
  │    → 先按 call_key 合并本次 outcomes 到完整 Progress
  │    → 合并后仍有 unknown：paused/uncertain_tools
  │    → 全部为 result 且 turn_index < max_turns：awaiting_turn → run_turn
  │    → 全部为 result 且 turn_index == max_turns：completed/max_turns_reached
  └─ cancel
       → cancelled

paused
  ├─ resume（动作必须与 pause.kind 匹配）
  │    → awaiting_turn、awaiting_tools 或 completed/stopped(source = resume)
  └─ cancel
       → cancelled
```

Runner 必须先将上述 paused State 和 Transition Record 原子提交到权威
`LoopStore`，再发出 `run.paused` 并向调用方返回 Checkpoint。比较失败说明其他
写者可能已经推进权威 State，必须重载并按第 18 节处理；只有 I/O 或存储不可用
才返回 `durability_error`。存储不可用时无法可靠地再写入 failed State，因此
不能虚构一个已经持久化的 failed 终态。

`turn_completed` 的判定优先级固定为：

1. 校验 Outcome 并将 `turn_index` 增加一次；
2. `finished` 优先进入成功 completed；
3. `paused` 优先进入 paused/agent_core；
4. `tool_calls` 优先进入工具决策和执行；
5. 只有准备产生下一次 `run_turn` 时才检查 `max_turns`。

`max_turns` 只限制模型 Turn。最后一个允许的 Turn 所产生的 Tool Calls 仍然经过
Policy，并可被执行；工具结果产生后，状态机在准备下一 `run_turn` 时结束为
`max_turns_reached`，不会再调用模型。宿主若不希望最后一轮产生副作用，应由
Policy 在 `turn_index == max_turns` 时返回 pause 或 stop。

达到 `max_turns` 时不再产生 `run_turn` Effect，进入：

```json
{
  "status": "completed",
  "completion": {
    "reason": "max_turns_reached",
    "successful": false
  }
}
```

## 17. 暂停与恢复

`LoopCheckpoint` 是可独立恢复的完整快照，不是 State 的字段子集：

```json
{
  "protocol_version": "1.0.0-draft.2",
  "run_id": "run_123",
  "checkpoint_id": "run_123:checkpoint:8",
  "captured_revision": 8,
  "state_hash": "sha256:8f4c...",
  "state": {
    "protocol_version": "1.0.0-draft.2",
    "run_id": "run_123",
    "revision": 8,
    "last_input_id": "input_10",
    "status": "paused",
    "turn_index": 2,
    "event_sequence": 17,
    "continuation": {
      "kind": "reference",
      "reference": "core-state:abc126",
      "revision": "etag-10"
    },
    "limits": {
      "max_turns": 50,
      "input_receipt_window": 128
    },
    "execution_contract": {
      "turn_retry_safe": false,
      "ownership_mode": "exclusive",
      "atomic_fence_enforcement": false
    },
    "pending": null,
    "input_receipts": [
      {
        "input_id": "input_10",
        "applied_revision": 8
      }
    ],
    "pause": {
      "pause_id": "run_123:pause:8",
      "kind": "tool_approval",
      "reason": "tool_approval_required",
      "batch_id": "run_123:tool-batch:2",
      "allowed_actions": [
        "execute_tools",
        "provide_tool_results",
        "stop"
      ],
      "tool_calls": [
        {
          "call_key": "run_123:tool-batch:2:0",
          "call_id": "call_1",
          "name": "read_file",
          "arguments": {
            "path": "README.md"
          },
          "metadata": {},
          "extensions": {}
        }
      ]
    },
    "extensions": {}
  }
}
```

Checkpoint 中的 `state.pending` 必须是完整 Effect 或 `null`。运行中 Checkpoint
若包含 pending Effect，恢复器可以用同一 `effect_id`、载荷和幂等键继续；禁止
重新生成语义等价但 ID 不同的 Effect。

纯状态机所需 ID 使用确定性派生：

```text
pause_id      = run_id + ":pause:" + target_revision
checkpoint_id = run_id + ":checkpoint:" + state.revision
```

`run_id` 由外部 `start` Input 提供；状态机不生成随机 ID。TypeScript Runner
可以在构造 `start` Input 前使用注入的 `RunnerServices.nextId("run")` 生成
`run_id`。

`state_hash` 是对 `state` 做 RFC 8785 canonicalization 后计算的 SHA-256
十六进制摘要。Checkpoint 进入新进程或新存储时必须先通过 Schema 与 Hash
校验。
该 Hash 只验证传输完整性，不提供来源认证；Checkpoint Import 的身份校验、
签名和授权由宿主负责。

`pause.kind` 与合法 Resume Action：

```text
agent_core
  → continue | stop

tool_approval
  → execute_tools | provide_tool_results | stop

uncertain_tools
  → provide_tool_results | retry_tool_batch | stop

uncertain_turn
  → provide_turn_outcome | retry_turn | stop
```

Pause 使用 `kind` 作为 discriminator，最小必填字段为：

| `kind` | 必须字段 |
| --- | --- |
| `agent_core` | `pause_id`、`reason`、`resume_schema`、`allowed_actions`、`continuation` |
| `tool_approval` | `pause_id`、`reason`、`batch_id`、带 `call_key` 的完整 `tool_calls`、`allowed_actions` |
| `uncertain_tools` | `pause_id`、`reason`、`batch_id`、完整 `progress`、`allowed_actions` |
| `uncertain_turn` | `pause_id`、`reason`、完整原始 `run_turn` Effect、`allowed_actions` |

`retry_tool_batch.call_keys` 必须是当前 `unknown` Entry 的非空子集，且每项都必须
满足 `retry_safe: true`。状态机把所选 Entry 改为 `pending`，保留其他
`result/unknown` Entry，并产生只执行该子集的 `execute_tool_batch`。结果返回后按
`call_key` 原位合并：若仍有 `unknown`，生成新 Revision 的
`paused/uncertain_tools`；全部成为 `result` 后才恢复原始顺序并进入下一 Turn。

`provide_tool_results.results` 在 `tool_approval` 下必须覆盖整个 Batch，在
`uncertain_tools` 下必须为当前所有 `unknown` Entry 各提供且只提供一个 Tool
Result；只补一部分会返回 `incomplete_tool_results`。该规则让人工补偿保持一次
原子 Resume，不再存在“完整批次还是只补未知项”的歧义。

`tool_approval/execute_tools` 恢复时，Runner 必须先针对该 Batch 调用
`ToolExecutor.isRetrySafe()`，再把得到的 `retry_safe_call_keys` 放入 `resume`
Input；状态机据此创建首个 Tool Batch Progress。

`uncertain_tools` Pause 必须保存原始 Tool Batch Progress，其中每个 Call 的
`result/unknown` Outcome 和 `retry_safe` 都在原位置；`uncertain_turn` Pause 必须保存原始
`run_turn` Effect。`tool_approval` Pause 保存待审批 Calls；`agent_core` Pause
保存 Resume Schema。各 Pause Variant 使用独立 JSON Schema，不能用一个全部可选
字段的宽松对象表示。

完整 Checkpoint 还必须保留产生恢复动作所需的 Continuation、Tool Batch
Progress、Limits、Receipts、Event Sequence 和 Extensions。

以下旧式不完整快照不属于合法 Checkpoint：

```json
{
  "run_id": "run_123",
  "status": "paused"
}
```

Resume Action：

```text
execute_tools       批准执行当前 Tool Batch
provide_tool_results 为当前所有 unknown Call 提供人工结果
continue            将 Resume Input 交给 AgentCore
retry_tool_batch     仅重试明确标记为 retry-safe 的未知 Tool Calls
provide_turn_outcome 提供外部已确认的完整 Turn Outcome
retry_turn           明确接受重复模型 Turn 风险后重试
stop                结束运行
```

Resume 必须携带：

- `run_id`
- `pause_id`
- `expected_revision`
- `input_id`
- Action 和对应 Payload

`ResumeAction` 的最小形状固定为：

```text
continue
  → { kind: "continue", input: JsonValue }

execute_tools
  → { kind: "execute_tools", mode: "parallel" | "sequential",
      max_concurrency: integer, retry_safe_call_keys: string[] }

provide_tool_results
  → { kind: "provide_tool_results", results: ToolResult[] }

retry_tool_batch
  → { kind: "retry_tool_batch", call_keys: string[] }

provide_turn_outcome
  → { kind: "provide_turn_outcome", outcome: TurnOutcome }

retry_turn
  → { kind: "retry_turn", accept_duplicate_risk: true }

stop
  → { kind: "stop", reason: string,
      successful: boolean, output: JsonValue | null }
```

不在 `allowed_actions` 中的 Resume 必须返回 `invalid_resume_action`。

Resume Command 只携带上述引用和动作字段，不能携带可覆盖权威 State 的
Continuation、Tool Calls 或完整 Checkpoint。Runner 必须按 `run_id` 重载
`LoopStore`，验证当前 State 为 paused，并校验 `pause_id` 和
`expected_revision` 后才构造 `resume` Input。

跨存储恢复分成显式的 Checkpoint Import 与 Resume 两步：

1. 校验 Checkpoint Schema、`checkpoint_id` 确定性公式、
   `captured_revision == state.revision`、State 内外 `run_id` 一致性和
   `state_hash`。
2. 目标 Run 不存在时，以 create-if-absent 原子导入 State，并追加
   `checkpoint_import` Checkpoint Import Record。
3. 目标 Run 已存在且权威 State 与 Checkpoint State 的 canonical bytes
   完全相同时，Import 幂等成功。
4. 目标 Run 已存在但内容不同时，返回 `checkpoint_conflict`；禁止按 Revision
   相同就覆盖。
5. Import 成功后，再发送只含引用和动作的 Resume Command。

只有 paused State 已成功 CAS 提交到权威 `LoopStore` 后，Runner 才能向调用方
返回 paused 结果和 Checkpoint。

### 17.1 崩溃恢复 Input

Runner 从 `LoopStore` 加载 `pending != null` 的活动 State 后，必须先取得第
18.4 节定义的 Execution Claim，再发送 `recover` Input，不能直接在状态机外
决定如何处理 pending Effect。加载 `paused` State 时直接返回 Paused
Handle/Checkpoint；加载终态时直接返回 Terminal Result，两者都不发送
`recover`。

```text
pending run_turn
  ├─ Effect.retry_safe == true
  │    → 重新分发相同 Effect
  └─ Effect.retry_safe == false
       → paused/uncertain_turn

pending decide_tool_batch
  → 重新分发相同 Effect

pending execute_tool_batch
  ├─ execute_call_keys 对应的所有 pending Entry 均 retry-safe
  │    → 重新分发相同 Effect
  └─ 存在非 retry-safe 的 pending Entry
       → paused/uncertain_tools
```

`uncertain_turn` Pause 必须保存原始 `run_turn` Effect。`provide_turn_outcome` 按
`turn_completed` 的同一验证和优先级处理；`retry_turn` 重新分发原 Effect，并
要求用户显式确认可能产生重复费用或不同模型输出。

## 18. 幂等与崩溃恢复

### 18.1 状态转换幂等

- 每个 Input 有 `input_id`。
- 每个 Effect 有稳定 `effect_id`。
- State 在 `limits.input_receipt_window` 指定的窗口内保存持久化
  `input_receipts`；V1 默认窗口为 128。
- Input 处理顺序固定为：先检查 Receipt，再检查 `expected_revision`。
- 命中 Receipt 的重复 Input 返回当前 State，且不产生新 Effect 或规范事件，
  即使其 `expected_revision` 已经过期。
- 未命中 Receipt 且 `expected_revision` 过期时返回 `revision_conflict`。
- `revision_conflict` 表示 Input 在状态转换前已明显过期；State 计算完成后的
  Store compare mismatch 属于并发写入竞态，按第 18.3 节返回
  `concurrent_update`。
- 超出去重窗口的延迟重复 Input 只保证被 Revision 拒绝，不保证返回原始响应。
- Effect Result 必须匹配 pending `effect_id`。
- 完成、失败或取消后仍保留 Receipt 窗口，用于拒绝迟到结果。

### 18.2 副作用幂等

Tool Executor 和 AgentCore Adapter 都接收：

```text
Turn idempotency_key = effect_id
Tool idempotency_key = call_key
```

`call_key` 由 Run、Batch 和原始 Ordinal 确定性生成。工具重试即使产生新的批次
Effect，也必须继续使用相同 `call_key`；Provider `call_id` 不得用作副作用幂等
键。Adapter 应向支持幂等键的下游传播对应值，并在 Capability 中准确声明支持
程度。

协议不承诺分布式 exactly-once。若进程在副作用完成后、结果持久化前崩溃：

- 已知下游支持幂等：可使用相同 Effect ID 重试。
- 下游不支持幂等且执行状态未知：恢复后必须进入 `paused`，由宿主或用户决定，禁止自动重试。

### 18.3 持久化顺序

声明支持崩溃恢复的 Runner 必须遵循：

1. 接收 Input 并计算 Transition Result。
2. 将 next State、Receipts 和 Transition Record 作为一个 Store Transaction
   原子提交。
3. 提交成功后才分发 Effects，并通知 Observer 读取已提交的规范事件。
4. Effect 完成后，将确定性 Result Input 重新送入状态机。

Transition Record 是不可变的审计记录，至少包含：

```json
{
  "protocol_version": "1.0.0-draft.2",
  "record_sequence": 8,
  "record_type": "transition",
  "run_id": "run_123",
  "causal_revision": 8,
  "record_id": "input_10",
  "content_hash": "sha256:71c2...",
  "payload": {
    "previous_revision": 7,
    "next_revision": 8,
    "state_hash": "sha256:8f4c...",
    "effects": [],
    "events": []
  }
}
```

首次 `start` 的 `previous_revision` 为 `null`、`next_revision` 为 `0`。
Transition Record 与 Checkpoint Import Record 统称 Committed Record；
`record_sequence` 在同一 Run 内从 `0` 开始严格递增。Store 必须支持按 Sequence
读取 Committed Records；因此进程在 State 提交后、事件通知前崩溃时，规范事件
仍可从 Record 重放。Observer 投递是 at-least-once，消费者必须按 Event ID
去重；协议不承诺 Observer exactly-once。
Committed Record 直接使用第 24 节的 Wire Record Envelope，不再定义第二套
序列、ID 或 Hash 规则；Transition 的 `record_id` 等于被接受的 `input_id`。
Runner 向 Store 提交不含 `record_sequence`、`content_hash` 的 Record Draft；
Store 在同一原子事务中分配下一个 Sequence、计算 Hash，并返回完整 Committed
Record。这样 Checkpoint 导入新 Store 时，新 Store 的第一条
`checkpoint_import` Record 从 Sequence `0` 开始，不依赖来源 Store 历史。

Store Commit 比较失败与存储故障必须区分：

- create-if-absent 冲突：重载 Run；若命中同一 `start.input_id` Receipt，则视为
  幂等成功，否则返回 `run_id_conflict`。
- Revision CAS 冲突：重载 Run；若命中当前 `input_id` Receipt，则视为幂等成功，
  且不重复分发 Effect 或事件；否则返回 `concurrent_update`，由调用方基于新
  Revision 决定是否重试。
- I/O、超时或存储不可用：返回 `durability_error`；不能推断权威 Revision
  是否变化。

恢复时，如果持久化 State 含 pending Effect：

- pending `run_turn` 支持幂等时，以相同 Effect ID 重新分发；
- pending `run_turn` 不支持幂等时，通过 `recover` 转换为
  `uncertain_turn` Pause；
- pending `execute_tool_batch` 仅在全部 `execute_call_keys` 对应 Entry 都
  retry-safe 时重新分发，否则通过 `recover` 把这些 pending Entry 转换为
  `unknown` 并进入 `uncertain_tools` Pause；已经是 `result/unknown` 的 Entry
  原位保留；
- pending `decide_tool_batch` 可以相同 Effect ID 重新计算，因为 Policy 不得产生
  外部副作用；
- 不允许丢弃 pending Effect 后生成新 ID。

不配置持久化的 Runner 可以作为纯内存便利实现，但必须在 Capability 中声明
`crash_recovery: false` 和 `replayable_events: false`，并且不能声称支持跨进程
Resume。

### 18.4 Effect 执行所有权与 Fencing

State CAS 不能单独阻止旧 Runner 在提交后继续分发 Effect。每个 Durable Run
必须由 `RunExecutionCoordinator` 授予一个 Execution Claim：

```json
{
  "run_id": "run_123",
  "owner_id": "worker_7",
  "epoch": "42"
}
```

同一 Run 在同一时刻只能有一个有效 Claim。所有活动 State 转换、Effect 分发、
`recover` 和 `cancel` 必须由有效 Owner 执行。非 Owner 的取消请求只能转发给
Owner，或在安全取得 Claim 后执行，不能直接推进权威 State。
这里的活动 State 指 `pending != null` 的 awaiting 状态；从 paused 执行 Resume
前也必须先取得 Claim，因为该转换可能立即产生新 Effect。

V1 允许两种合规模式：

```text
exclusive
  Claim 只在旧 Owner 已释放或已被宿主确认终止后转移。

fenced
  Coordinator 为每次接管分配严格递增 Epoch；AgentCore Adapter 和 Tool Executor
  必须把 Epoch 传到副作用目标，目标或与目标操作处于同一原子事务的代理在接受
  操作时校验并持久拒绝旧 Epoch。
```

只依赖超时 Lease、且下游不校验 Fencing Token，不足以证明旧 Owner 已停止。
这种实现不得自动接管活动 Run；它必须返回 `ownership_uncertain`，并等待宿主
终止旧 Owner。对于非 retry-safe Effect，禁止以“Lease 已过期”为理由直接重试。

提交和分发规则：

1. Runner 取得 Claim。
2. 在 Claim 有效时计算 Transition；Store 在提交 State + Record 的同一原子操作
   中校验 Claim。`fenced` 模式下旧 Epoch 的提交必须被拒绝。
3. 分发前可以用 `assertCurrent()` 提前发现 Claim 丢失；该检查仅用于快速失败，
   不能作为 Fencing 合规证明。
4. `fenced` 模式必须把 Claim 作为
   `EffectContext.executionFence` 传给 AgentCore Adapter 和 Tool Executor。
5. 副作用目标或原子代理必须把“校验/持久记录最高 Epoch”和“接受模型或工具
   操作”绑定在同一线性化点；独立的 preflight check 存在 TOCTOU，不合规。
6. Claim 丢失后，旧 Runner 必须停止提交、分发和接收 Effect Result。

`exclusive` 模式依赖宿主提供的单消费者队列、进程锁或等价的确定性所有权；
`fenced` 模式只适用于每一种可能使用的 AgentCore 和 Tool Effect 通道都声明并
实现 `atomic_fence_enforcement` 的系统。Runner 必须在 Start 前验证这些能力；
任一通道不支持时返回 `unsupported_fencing`，不得降级成 preflight check。宿主
可以显式改用 `exclusive` 模式。没有任一合规模式时，Runner 必须声明
`effect_ownership: false`，且不能声明 `crash_recovery: true`。
Resume/Recover 时 Runner 必须满足 State 中持久化的 Ownership Contract；禁止在
运行中静默切换模式或降低 Fencing 保证。

## 19. 取消

取消分为：

1. 状态机取消：进入 `cancelled` 终态，不再产生新 Effect。
2. 运行时取消：解释器向正在运行的 Adapter/Executor 传播取消信号。

取消信号是协作式的。Adapter 若无法立即取消，解释器必须忽略取消之后到达的迟到结果。迟到结果不能改变终态。
活动 Run 的 Cancel 必须由当前 Execution Owner 处理；非 Owner 按第 18.4 节转发
或安全接管，不能仅凭 State CAS 抢先写入 `cancelled`。

## 20. 错误模型

统一错误：

```json
{
  "code": "adapter_failed",
  "message": "AgentCore adapter failed.",
  "stage": "turn",
  "retryable": true,
  "details": {},
  "cause": null
}
```

`stage`：

```text
protocol
turn
policy
tool
store
runner
```

V1 错误决策：

- 边界 Schema 校验错误、未知 discriminant、`revision_conflict`、
  `run_not_found`、`run_id_conflict`、`concurrent_update`、
  `checkpoint_conflict`、`ownership_uncertain`、`stale_execution_claim` 和
  `unsupported_fencing`、`invalid_resume_action`，以及所有协议/输入语义校验
  错误（包括 `invalid_turn_outcome`、`tool_result_mismatch`、
  `incomplete_tool_results`、`invalid_retry_safe_set`）：拒绝当前 Input，不提交新
  State、Transition Record、Effect 或规范事件。
- 已被规范化为 `turn_failed` 的 AgentCore Adapter 错误：进入 `failed`。
- 已被规范化为 `tool_decision_failed` 的 Policy 错误：进入 `failed`，不能绕过
  策略继续执行。
- 单个工具业务错误：转换为 Tool Result，继续 Loop。
- Tool Executor 基础设施错误且所有 Call 状态已知：将已知 Tool Results 交给
  AgentCore 后继续。
- Tool Executor 基础设施错误且存在状态未知的 Call：进入
  `paused/uncertain_tools`。
- `LoopStore` compare mismatch：当前 Transition 不提交，按第 18.3 节重载并
  返回幂等结果、`run_id_conflict` 或 `concurrent_update`。
- `LoopStore` I/O、超时或不可用：返回 `durability_error`；权威 State 可能未
  变化，也可能已提交但响应丢失，Runner 必须重载后才能判断。

V1 不提供通用 Failure Policy，也不允许 TypeScript 实现额外决定“失败还是暂停”。
重试仅通过 `uncertain_tools` Pause 的受限 `retry_tool_batch` 动作表达，不在状态机
内部进行隐藏重试。未来若需要通用 Failure Policy，必须先增加规范
`awaiting_failure_decision` 状态、Effect、Input 和合规 Fixture。

## 21. 事件模型

规范控制事件：

```text
run.started
turn.requested
turn.completed
tool_batch.requested
tool_batch.decided
tool_batch.completed
run.paused
run.resumed
run.completed
run.failed
run.cancelled
```

事件 Envelope：

```json
{
  "protocol_version": "1.0.0-draft.2",
  "event_id": "run_123:event:15",
  "run_id": "run_123",
  "sequence": 15,
  "type": "turn.completed",
  "revision": 8,
  "payload": {},
  "extensions": {}
}
```

规则：

- `event_id = run_id + ":event:" + sequence`，用于 at-least-once 投递去重。
- `sequence` 在同一 Run 内严格递增。
- 规范事件由状态转换产生，并与 State 原子写入 Transition Record；Durable
  Runner 可以重放和断言。
- Timestamp 是可选观察字段，由解释器注入，不参与状态确定性。
- token、thinking、日志和 AgentCore 私有事件使用 namespaced Extension Event。
- Extension Event 只用于观察，不能直接推进状态机。
- Adapter 执行期间产生的 Extension Event 默认 best-effort；需要崩溃后重放时，
  宿主必须将其写入独立的观察日志。该日志不使用 LoopStore 的
  `record_sequence`，也不改变 Loop State。

规范事件的 `payload` 是按 `type` 封闭的联合：

| `type` | 必须 Payload |
| --- | --- |
| `run.started` | 空对象 |
| `turn.requested` | `effect_id`、`turn_index` |
| `turn.completed` | `effect_id`、`turn_index`、`outcome_kind` |
| `tool_batch.requested` | `effect_id`、`batch_id`、`call_keys` |
| `tool_batch.decided` | `effect_id`、`batch_id`、`decision_kind` |
| `tool_batch.completed` | `effect_id`、`batch_id`、按原始顺序的 `results` |
| `run.paused` | 完整 `pause` |
| `run.resumed` | `pause_id`、`action_kind` |
| `run.completed` | 完整 `completion` |
| `run.failed` | 完整 `error` |
| `run.cancelled` | 完整 `cancellation` |

`outcome_kind`、`decision_kind` 和 `action_kind` 只保存对应 Variant 的
discriminator，不复制整个 Input。表中未列出的 Event 专属字段必须进入
namespaced `extensions`。

## 22. 能力声明

Adapter 在运行前声明能力：

```json
{
  "single_turn": true,
  "stream_events": true,
  "cancellation": true,
  "inline_continuation": true,
  "reference_continuation": true,
  "idempotent_turns": false,
  "atomic_fence_enforcement": false
}
```

`single_turn` 是强制能力。缺失时 Runner 必须在启动前返回 `unsupported_agent_core`。

其他能力用于：

- 决定能否安全自动恢复；
- 决定是否转发流式 Extension Events；
- 决定崩溃后是否允许重试；
- 生成清晰诊断，而不是运行时猜测。

崩溃恢复不属于 AgentCore Capability。Runner 单独暴露：

```json
{
  "durable_state": true,
  "crash_recovery": true,
  "store_compare_and_swap": true,
  "atomic_transition_records": true,
  "replayable_events": true,
  "effect_ownership": true,
  "ownership_mode": "exclusive",
  "atomic_fence_enforcement": false
}
```

`crash_recovery: true` 要求 Durable Store 能力和 `effect_ownership` 都为 true；
`replayable_events` 要求 State 与 Transition Record 原子提交并支持按 Sequence
读取。`ownership_mode` 只能是 `exclusive` 或 `fenced`，语义见第 18.4 节。
`ownership_mode: "fenced"` 时，聚合后的 `atomic_fence_enforcement` 必须为 true；
否则 Runner 必须在 Start 前返回 `unsupported_fencing`。
Tool Executor 还必须针对每个 Tool Call 返回 `retry_safe`，不能用一个全局布尔值
概括所有工具。

## 23. TypeScript 参考包

### 23.1 逻辑入口

独立包提供四个逻辑入口：

```text
protocol  JSON 对象对应的 TypeScript 类型和验证入口
machine   纯 transition() 状态机
runner    异步 Effect 解释器
testing   Fake Adapter、Fixture Runner 和合规断言
```

这只是包的公共入口设计，不规定宿主项目目录。

### 23.2 依赖原则

- 不依赖 React、Zustand、Node、Bun 或浏览器 API。
- 不依赖任何 AgentCore SDK。
- 核心状态机零运行时依赖。
- JSON Schema 作为发布产物提供。
- TypeScript 包提供由 Schema 生成的边界 Validator；所有外部 JSON、Checkpoint
  和跨进程 Effect Result 在进入状态机前必须验证。
- 宿主可以替换 Validator 实现，但不能关闭规范边界验证。
- Runner 使用标准 Promise、AsyncIterable 和协作式 Cancellation Adapter。
- Runner 的 ID、时间和持久化依赖显式注入；纯状态机不读取全局时间或随机源。

### 23.3 AgentCore Adapter

```ts
export interface AgentCoreAdapter {
  readonly capabilities: AgentCoreCapabilities;

  runTurn(
    request: TurnRequest,
    context: EffectContext,
  ): Promise<TurnOutcome>;
}
```

`AgentCoreCapabilities.atomicFenceEnforcement: true` 只在 Adapter 会把 Fence
传到模型调用目标或原子代理，并由其在接受 Turn 操作的同一线性化点校验时成立；
本地 preflight check 不得声明该能力。

`EffectContext`：

```ts
export interface EffectContext {
  readonly idempotencyKey: string;
  readonly cancellation: CancellationSignal;
  readonly executionFence: ExecutionClaim | null;
  emit(event: ExtensionEvent): Promise<void> | void;
}

export interface CancellationSignal {
  readonly cancelled: boolean;
  throwIfCancelled(): void;
  onCancel(listener: () => void): () => void;
}

export interface RunnerServices {
  nextId(kind: "run" | "input"): string;
  now(): number;
}

export interface ExecutionClaim {
  readonly runId: string;
  readonly ownerId: string;
  readonly epoch: string;
}

export interface RunExecutionCoordinator {
  readonly mode: "exclusive" | "fenced";

  acquire(runId: string): Promise<ExecutionClaim>;
  assertCurrent(claim: ExecutionClaim): Promise<void>;
  release(claim: ExecutionClaim): Promise<void>;
}
```

TypeScript Runner 可以把标准 `AbortSignal` 包装成 `CancellationSignal`，但协议本身不出现 JavaScript 专属类型。
`acquire()` 必须满足第 18.4 节的安全接管条件，不能把普通超时 Lease 冒充
`exclusive`；`fenced` 模式的 Epoch 使用十进制字符串，避免跨语言整数溢出。

### 23.4 Tool Executor

```ts
export interface ToolExecutor {
  readonly capabilities: ToolExecutorCapabilities;

  isRetrySafe(call: ToolCall): boolean;

  execute(
    call: ToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolResult>;
}

export interface ToolExecutorCapabilities {
  readonly atomicFenceEnforcement: boolean;
}
```

Runner 根据 Policy Decision 的 `parallel`、`sequential` 和 `maxConcurrency` 组织批次，但始终按原始 Call 顺序提交结果。
`ToolExecutionContext` 必须携带与 `EffectContext` 相同的
`executionFence`。`atomicFenceEnforcement: true` 表示 Executor 会把 Fence
传递到副作用目标或原子代理，并在接受 Tool 操作的同一线性化点校验；仅调用
`assertCurrent()` 后再执行不满足该能力。

### 23.5 Loop Policy

```ts
export interface LoopPolicy {
  decideToolBatch(
    request: ToolDecisionRequest,
    context: PolicyContext,
  ): Promise<ToolBatchDecision> | ToolBatchDecision;
}
```

Policy 不直接执行工具，也不修改 State。它只返回协议 Decision。

### 23.6 Loop Store

```ts
export type StoreCommitResult =
  | { kind: "applied"; record: CommittedRecord }
  | { kind: "conflict"; currentRevision: number | null }
  | { kind: "fenced"; currentEpoch: string };

export interface LoopStore {
  loadState(runId: string): Promise<LoopState | null>;

  createRun(
    state: LoopState,
    record: TransitionRecordDraft,
    claim: ExecutionClaim,
  ): Promise<StoreCommitResult>;

  commitTransition(
    state: LoopState,
    expectedRevision: number,
    record: TransitionRecordDraft,
    claim: ExecutionClaim,
  ): Promise<StoreCommitResult>;

  importCheckpoint(
    checkpoint: LoopCheckpoint,
    record: CheckpointImportRecordDraft,
    claim: ExecutionClaim,
  ): Promise<StoreCommitResult>;

  readRecords(
    runId: string,
    afterSequenceExclusive: number | null,
  ): AsyncIterable<CommittedRecord>;
}
```

`createRun` 是 create-if-absent：只接受 Revision `0`、`previous_revision:
null` 的首次 Start State 和 Record Draft。`commitTransition` 的
`expectedRevision` 永远是调用方加载到的权威 Revision；
`state.revision` 必须等于 `expectedRevision + 1`，Record Draft 必须描述同一
转换。State 与生成的 Committed Record 必须在同一事务中提交；Store 负责分配
Sequence、计算 Hash，并在 `applied` 结果中返回完整 Record。

`StoreCommitResult.conflict` 只表示 compare mismatch，不能用异常或
`durability_error` 代替。I/O、超时和存储不可用必须抛出带明确 Store Error
Code 的错误。Runner 收到 Conflict 后按第 18.3 节重载和判定；
`fenced` 表示 Claim 已失效，Runner 必须立即停止该 Run 的提交和 Effect 分发。

`importCheckpoint` 只允许 create-if-absent，不覆盖已有 Run；
`CheckpointImportRecord` 记录来源 Checkpoint ID 和 State Hash。
`LoopStore` 是唯一权威存储。Checkpoint 由已经提交的 State 规范导出，不存在
第二个权威存储或第二次 State CAS。没有 Loop Store 的 Runner 只能声明
`crash_recovery: false` 和 `replayable_events: false`。

### 23.7 Observer

```ts
export interface LoopObserver {
  onEvent(event: LoopEvent | ExtensionEvent): Promise<void> | void;
}
```

Observer 异常默认被隔离并记录，不改变 Loop 状态。需要 Observer 作为业务屏障时，必须通过显式 Effect 实现，不能依赖事件回调的偶然等待行为。
Durable Runner 不依赖 Observer 回调保存规范事件；事件已经存在于
Transition Record。Observer 失败后可从 `readRecords()` 重放，因此通知语义是
at-least-once。

### 23.8 Runner API

```ts
export interface ReactLoopRunner {
  start(input: StartRunInput): Promise<RunHandle>;

  importCheckpoint(checkpoint: LoopCheckpoint): Promise<LoopState>;

  recover(runId: string): Promise<RunHandle>;

  resume(command: ResumeCommand): Promise<RunHandle>;

  cancel(runId: string): Promise<LoopState>;
}

export interface RunHandle {
  readonly runId: string;
  events(): AsyncIterable<LoopEvent | ExtensionEvent>;
  result(): Promise<LoopTerminalResult | LoopPausedResult>;
  cancel(): Promise<void>;
}
```

`LoopTerminalResult` 与 `LoopPausedResult` 不复制另一套状态字段：

```text
LoopTerminalResult
  → { kind: "terminal", state: CompletedState | FailedState | CancelledState }

LoopPausedResult
  → { kind: "paused", state: PausedState, checkpoint: LoopCheckpoint }
```

`recover(runId)` 取得 Execution Claim、加载权威 State，并按第 17.1 节决定重发
Effect、转入 uncertain Pause，或直接返回已有终态/暂停结果。

Runner 是便利层。规范真相仍然是 `transition()`；宿主可绕过 Runner，直接在队列、工作流引擎或远程服务中解释 Effects。

## 24. Wire Transport

V1 不规定 HTTP、SSE、WebSocket、RPC 或消息队列。

协议对象可以在任何传输中承载。规范持久化日志只包含
`transition` 和 `checkpoint_import` 两种 Committed Record。一次状态转换只产生
一条 `transition` Record；State Snapshot 是同一 Store Transaction 更新的权威
行，不是另一条 Record。

统一 Record Envelope：

```json
{
  "protocol_version": "1.0.0-draft.2",
  "record_sequence": 23,
  "record_type": "transition",
  "run_id": "run_123",
  "causal_revision": 8,
  "record_id": "input_11",
  "content_hash": "sha256:4d7f...",
  "payload": {
    "previous_revision": 7,
    "next_revision": 8,
    "state_hash": "sha256:8f4c...",
    "effects": [],
    "events": []
  }
}
```

规范 `record_type`：

```text
transition
checkpoint_import
```

两种 Committed Record 使用 `record_type` 作为 discriminator：

| `record_type` | `causal_revision` | `record_id` | 必须 Payload |
| --- | --- | --- | --- |
| `transition` | `next_revision` | 被接受的 `input_id` | `previous_revision`、`next_revision`、`state_hash`、`effects`、`events` |
| `checkpoint_import` | 导入的 `state.revision` | `checkpoint_id + ":import"` | `checkpoint_id`、`state_hash`、`imported_revision` |

`checkpoint_import.payload.imported_revision` 必须等于
`causal_revision`、`checkpoint.captured_revision` 和导入 State 的 `revision`。
同一目标 Store 重复导入 canonical bytes 完全相同的 Checkpoint 时直接返回已有
State，不再追加第二条 Import Record。

`input`、`state`、`effect`、`effect_result`、`event`、`checkpoint` 和
`extension_event` 可以作为传输或可观测投影导出，但不是 Committed Record：

- 不进入 `LoopStore.readRecords()`；
- 不分配或占用规范 `record_sequence`；
- 不参与 Committed Record Hash Fixture；
- 不能作为崩溃恢复或事件重放的权威依据。

规范事件只能从 `transition.payload.events` 重放。可选 Extension Event 若需要
持久化，必须进入宿主自己的观察日志，并使用独立的序列空间，不能混入
LoopStore 的 `record_sequence`。

NDJSON 规则：

- UTF-8，无 BOM，一行一个 Record Envelope。
- `record_sequence` 在单个 Run 的 Committed Records 中从 0 开始严格递增且无
  间隙；多 Run 导出文件的物理行顺序不改变各 Run 的规范顺序。
- `causal_revision` 表示该 Record 所依据或产生的 Loop Revision。
- `transition.record_id` 等于被接受的 `input_id`；
  `checkpoint_import.record_id` 等于导入产生的确定性 Import ID。
- `content_hash` 是对不含 `content_hash` 字段的 Record Envelope 做 RFC 8785
  canonicalization 后计算的 SHA-256 十六进制摘要。
- Event 自身的 `sequence` 只用于同一 Run 内规范事件顺序；它不替代
  `record_sequence`。
- Canonical JSON 使用 RFC 8785 JSON Canonicalization Scheme。
- 协议拒绝负零、非有限数字和超出安全整数范围的控制字段。
- 字符串必须是合法 Unicode；遵循 RFC 8785，不额外做 Unicode
  normalization。
- Hash 和 Fixture 比较基于 RFC 8785 输出的 UTF-8 字节；`record_id` 不承担
  内容寻址职责。

具体认证、压缩、重连和网络错误不属于协议核心。

## 25. 合规套件

跨语言一致性由以下发布产物保证：

### 25.1 JSON Schema

- State
- Input
- Effect
- Turn Outcome
- Tool Call/Result
- Tool Batch Progress
- Policy Decision
- Resume Action
- Checkpoint
- Event
- Committed Record
- Error

### 25.2 状态转换向量

每个 Fixture 包含：

```json
{
  "name": "tool batch completes and requests next turn",
  "initial_state": {},
  "input": {},
  "expected_state": {},
  "expected_effects": [],
  "expected_events": []
}
```

### 25.3 规范场景

至少覆盖：

- 无工具的正常完成。
- 单工具和多工具。
- 同一 Run 的不同 Batch 重用相同 Provider `call_id` 时，`call_key` 仍不同。
- 同一 Batch 出现空或重复 Provider `call_id` 时拒绝整个 Turn Outcome。
- 并行工具结果顺序恢复。
- Tool Error 继续进入下一 Turn。
- Policy supply/pause/stop。
- AgentCore 主动暂停和恢复。
- tool_approval 与 uncertain_tools 两种工具暂停来源及受限 Resume Action。
- 首次 Start 的 create-if-absent、同 Input 幂等重试和 Run ID 冲突。
- paused State 的 CAS 提交成功、compare mismatch 和 durability_error。
- CAS mismatch 后重载分别命中、不命中 Input Receipt。
- Checkpoint Hash 篡改、跨 Store Import、幂等 Import 和内容冲突。
- State/Record 提交后、Observer 通知前崩溃，再按 Record 重放事件。
- 旧 Owner 在新 Owner 推进到 paused/cancelled 后尝试分发 Effect，必须被
  Exclusive Ownership 或 Fencing Gate 阻止。
- 未确认旧 Owner 终止时，超时 Lease 接管返回 ownership_uncertain。
- fenced 模式下 Adapter 或 Tool Executor 缺少 atomic_fence_enforcement 时，
  Start 返回 unsupported_fencing。
- 模拟 preflight 成功后 Epoch 变化，旧 Owner 的副作用仍必须在目标操作的原子
  Fence 检查处被拒绝。
- 达到 max turns。
- 在最后允许 Turn 上分别返回 finished、paused、tool_calls 时的优先级。
- Turn、Policy、Tool、LoopStore/CAS 错误。
- 部分 Tool Results 已知、部分副作用状态未知。
- `retry_tool_batch` 成功后仍有 unsafe unknown 时继续暂停，并保留原位结果。
- `provide_tool_results` 未覆盖所有 remaining unknown 时拒绝 Resume。
- 运行中取消和迟到结果。
- 去重窗口内外的重复 Input 和 Effect Result。
- revision conflict。
- 崩溃后幂等重试。
- 不确定副作用进入 paused。
- Inline/Reference Continuation。
- 未知字段和兼容扩展。
- 未支持 discriminant。

### 25.4 属性不变量

- `revision` 单调递增。
- Start 创建 Revision `0`，同一 `run_id` 只能 create-if-absent 成功一次。
- `event_sequence` 单调递增。
- `record_sequence` 在 Committed Records 中单调递增且无间隙。
- Committed Record 的 `record_type` 只能是 `transition` 或
  `checkpoint_import`；State/Effect/Event 投影不得占用 `record_sequence`。
- 终态不可离开。
- 同时最多一个 pending Effect。
- pending Effect 必须通过其具体 Effect Schema，且包含恢复所需完整载荷。
- `paused` 必须 `pending: null`，恢复所需原 Effect 保存在对应 `pause` 对象中。
- `input_receipts.length <= limits.input_receipt_window`。
- Tool Result 与 Tool Call 一一对应。
- `call_key = batch_id + ":" + ordinal`，同一 Batch 内唯一且跨 Batch 不冲突。
- Tool Batch Progress 的每个 Entry 恰为 `pending/result/unknown` 之一。
- Tool Result 顺序与 Call 顺序一致。
- `turn_index <= max_turns`。
- Cancel 后任何迟到结果都不能改变状态。
- 失效 Execution Claim 不能成功提交 State；其迟到 Effect 即使到达目标也不能
  被接受为模型或工具副作用，迟到 Result 不能推进 State。

### 25.5 合规 Runner

每种语言实现读取相同 Fixture，输出 RFC 8785 canonical JSON。NDJSON 合规轨迹
必须使用第 24 节的 Record Envelope 和 `record_sequence`，不能混合依赖
Revision 与 Event Sequence 推断记录顺序。

## 26. TypeScript 测试策略

- 纯状态机表驱动单元测试。
- Fixture 合规测试。
- Fake AgentCore Adapter 测试不同内部状态模型。
- Fake Tool Executor 测试并行、顺序、错误和取消。
- Checkpoint 崩溃恢复测试。
- Checkpoint Import 不覆盖已有权威 State 的测试。
- 幂等和 revision 冲突测试。
- Async event 顺序、Observer 重复投递和崩溃后 Record 重放测试。
- 双 Runner 竞态测试：旧 Owner 的迟到 Effect 在 exclusive/fenced 两种模式下
  均不能启动副作用。
- Property-based 状态机不变量测试；属性测试库为开发依赖，不进入运行时。
- 使用至少两个行为显著不同的 Fake AgentCore，证明协议没有依赖某种 Message 模型。

## 27. 剥离与迁移阶段

迁移不以一次性替换为目标，按行为锁定、双轨验证、切换、删除旧实现推进。

### 阶段 0：行为刻画

- 固定现有 Loop 的成功、停止、失败、工具和取消语义。
- 记录代表性输入、决策、工具结果和终态。
- 将现有行为转成协议 Fixture。
- 明确哪些现有行为保留，哪些作为有意变更。

### 阶段 1：协议基线

- 完成语义规范、JSON Schema、错误码和状态转换表。
- 建立 canonical JSON 和合规 Runner。
- 协议版本从 `1.0.0-draft.1` 开始；每次预发布语义调整递增 draft 序号。

### 阶段 2：TypeScript 状态机

- 实现纯 `transition()`。
- 先通过全部规范 Fixture 和属性不变量。
- 此阶段不连接真实 AgentCore 或工具。

### 阶段 3：TypeScript Runner 与 Fake Adapters

- 实现 Effect Interpreter、Runner、Run Execution Coordinator、Cancellation
  和 Observer。
- 通过两个不同 Fake AgentCore 的端到端测试。
- 验证 pause/resume、checkpoint、不确定副作用和双 Runner Ownership 竞态。

### 阶段 4：现有能力 Adapter

- 为目标 AgentCore 实现单 Turn Adapter。
- 为目标工具系统实现 Tool Executor。
- 将现有安全判断迁移为 Loop Policy。
- Prompt 渲染、流事件归并、UI Store 和 Run History 保持在宿主侧。

### 阶段 5：影子验证

- 不重复调用真实模型或真实工具。
- 使用已记录 Turn Outcomes 和 Tool Results 重放旧流程。
- 比较新旧 Loop 的决策序列、停止原因、Tool Result 顺序和终态。
- 对不一致逐条分类：协议缺陷、Adapter 缺陷或有意行为变更。

### 阶段 6：受控切换

- 通过宿主配置在旧 Loop 和新 Runner 之间切换。
- 先覆盖无工具和单工具场景，再扩大到并行工具、暂停恢复和远程执行。
- 保留回退能力，直到运行轨迹和错误率达到验收标准。

### 阶段 7：删除旧编排

- 所有 ReAct 控制逻辑只保留在通用状态机和 Policy。
- 宿主 Store 仅负责展示、持久化映射和用户操作。
- 删除旧循环前运行完整合规、端到端和行为回归测试。

### 阶段 8：跨语言证明

- 使用第二语言实现最小 `transition()` 或 Fixture Runner。
- 必须通过相同核心 Fixture。
- 完成后将协议从最新 `1.0.0-draft.N` 提升为稳定 `1.0.0`。

## 28. 验收标准

- 协议对象全部通过 JSON Schema。
- TypeScript 状态机通过全部合规 Fixture。
- 第二语言实现通过核心状态转换 Fixture。
- 至少两个不同 AgentCore Adapter 通过端到端场景。
- AgentCore 私有 Message/State 类型没有进入协议公共对象。
- TypeScript 核心包不依赖 UI、状态框架、运行时平台或 AgentCore SDK。
- Pause 后可以仅凭完整 Checkpoint 恢复，不依赖进程内闭包。
- Resume 只从权威 Store 构造 Input；Checkpoint Import 不能覆盖同 Run 的不同
  State。
- 去重窗口内的重复 Input、重复 Effect Result 和终态后的迟到结果不会重复推进
  状态；窗口外旧 Input 被 Revision 检查拒绝。
- 首次 Start 是原子 create-if-absent；CAS compare mismatch 与 Store I/O 故障
  返回不同结果。
- 规范事件与 State 原子提交，进程在通知前崩溃后仍可按 Committed Record 重放。
- LoopStore 的规范日志只有 `transition` 与 `checkpoint_import`；所有观察投影都不能
  成为第二套恢复依据。
- 同一 Run 同时只有一个有效 Effect Owner；旧 Owner 不能在暂停、取消或接管后
  启动副作用。
- 不确定工具副作用不会被自动重试。
- 工具副作用幂等使用协议生成的 `call_key`，不依赖 Provider `call_id` 的全局
  唯一性。
- 工具并行完成时，结果提交顺序仍与 Call 顺序一致。
- 达到最大轮次时终态明确标记为未成功完成。
- 旧 Loop 删除后，宿主中不存在第二套 ReAct 决策逻辑。

## 29. 主要风险与控制

### AgentCore 无单 Turn API

风险：无法在 Tool Call 边界归还控制权。

控制：将 `single_turn` 设为强制 Capability；不满足时启动前失败，不做不可靠模拟。

### Continuation 过大或不可序列化

风险：Checkpoint 成本高或无法跨语言传输。

控制：支持 Reference Continuation；协议不强迫内联完整上下文。

### 工具副作用重复

风险：崩溃恢复导致重复写入、付款或外部操作。

控制：稳定 Effect ID、幂等键、能力声明；状态未知且不支持幂等时强制暂停。

### Policy 被绕过

风险：解释器错误地直接执行工具。

控制：状态机规定 Tool Calls 必须经过 `awaiting_tool_decision`；合规 Fixture 验证不存在直接跳转。

### 旧 Runner 迟到执行

风险：新 Runner 已暂停、取消或接管 Run，旧 Runner 仍按先前提交结果启动模型或
工具副作用。

控制：每个 Run 强制 Execution Claim；使用确认旧 Owner 终止的 exclusive 模式，
或由副作用目标在接受操作的同一线性化点校验单调 Epoch 的 fenced 模式。普通
超时 Lease 和独立 preflight check 不能承担此保证。

### 协议沦为某个 AgentCore 的包装

风险：公共对象逐步引入特定 Message、Provider 或 Event 类型。

控制：公共协议只允许 JsonValue、Continuation 和控制对象；私有数据只能进入 namespaced extensions。

### 跨语言实现语义漂移

风险：不同语言对重复输入、错误和终态理解不同。

控制：状态转换向量、canonical JSON、规范错误码、第二语言实现作为稳定 1.0 的发布门槛。

## 30. 最终边界

通用 ReAct Loop 只拥有：

```text
Turn orchestration
Tool decision orchestration
Lifecycle state
Pause/resume
Cancellation
Checkpoint semantics
Idempotency semantics
Effect execution ownership
Protocol events
```

所有领域内容通过 Adapter 或 Policy 注入：

```text
AgentCore state and messages
Model calls
Prompt rendering
Tool definitions and execution
Security approval
Persistence implementation
UI and reactive state
Run history and evaluation
Tracing and analytics
```

这条边界是跨项目、跨语言、跨 AgentCore 复用成立的前提。
