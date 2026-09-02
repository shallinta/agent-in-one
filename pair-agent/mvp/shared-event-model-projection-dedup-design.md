# Shared Event 模型投影去重设计

## 1. 目标

消除模型请求中 `PairMessagePayload.text` 与单一纯文本 `content` block 的正文重复，同时保持 canonical Pair Ledger、Events API、Events UI、Pair Event 校验与 Agent-local Session 不变。

本改动只优化模型视图，不改变 Pair Session 的事实来源或完整 Shared Events 策略。

## 2. 非目标

- 不修改 Pair Event 持久数据结构；
- 不迁移或重写 JSONL Ledger；
- 不引入 Shared Checkpoint；
- 不引入 TOON；
- 不处理 Agent-local reasoning 或 tool continuation；
- 不实现 turn-end completion handoff。

## 3. 投影规则

模型投影保留 `payload.text`。只有同时满足以下条件时，才从投影副本删除 `payload.content`：

1. `payload.text` 是字符串；
2. `payload.content` 严格等于 `[{ "type": "text", "text": payload.text }]`；
3. content block 没有额外字段。

多 block、非文本 block、正文不一致或带额外元数据时，`content` 必须原样保留。投影必须基于 clone 生成，不得修改调用方传入的 Pair Event。

示例：

```text
Ledger payload:
  { "text": "hello", "content": [{ "type": "text", "text": "hello" }] }

Model projection payload:
  { "text": "hello" }
```

## 4. 格式与历史重建

Shared Event 模型投影格式是 immutable request material 的一部分，不允许在相同 material identity 下静默改变序列化结果。

- `pair-event-context/full-v1`：保留当前完整事件序列化，用于历史请求重建；其输出字节必须与现有 `<pair-session-events schema="pair-events/v1">` 格式一致。
- `pair-event-context/text-dedup-v1`：应用本设计的严格纯文本去重规则，作为新的 active 格式。

格式标识写入：

- `PairRequestMaterialEntry`；
- request material registry key；
- request layout manifest；
- durable request snapshot。

`serializeSharedEvents` 必须由请求材料显式选择格式。历史审计根据 snapshot 中的格式重建，新的 request digest 则覆盖去重后的实际 Provider boundary。

当前尚未发布且可丢弃的本地测试 Pair 不提供在线数据迁移；启用新格式并重启真实模型服务前，另行归档或清理测试数据。此后新增格式必须继续保留旧 projector，直到对应历史请求不再需要重建。

## 5. 测试边界

测试至少证明：

- exact text block 被去重；
- 多 block、不一致正文和额外字段不会被去重；
- canonical Pair Event 没有被修改；
- Navigator 与 Pilot 在同一 Shared Head 仍获得字节一致的 Shared Events 前缀；
- format identity 进入 material key、manifest、snapshot 和 digest；
- `full-v1` 与 `text-dedup-v1` 可以分别重建各自的历史请求；
- 完整测试、typecheck 与 request reconstruction audit 通过。

## 6. 验收标准

在保持当前 Ledger 内容和事件数量不变的前提下，真实 Pair 数据的模型投影不再同时携带等价的 `payload.text` 与 `payload.content[0].text`；非等价 content 信息零损失；历史格式不会被新 projector 静默重解释。
