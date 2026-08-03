# ReAct Loop 协议设计与 TypeScript 参考实现

本目录记录了一套通用 ReAct Loop 协议设计，以及配套的 TypeScript 学习型参考实现。

## 1. 设计方案

设计方案提出一套与语言、框架、传输方式和具体 AgentCore 解耦的 ReAct Loop 控制平面协议，
用于统一工具执行、人工审批、暂停恢复、取消和 Checkpoint 等编排语义。协议以纯状态机为核心，
由 Input 驱动状态转换并产出 Effect 和事件，再由宿主提供的适配器执行副作用；整体定位为学习研究
性质的跨语言协议设计。

[阅读完整设计方案](./react-loop-protocol-design.md)

## 2. TypeScript 参考实现

本目录包含一个可执行、面向学习的 TypeScript 参考实现，与
[`react-loop-protocol-design.md`](./react-loop-protocol-design.md) 配套使用。它重点呈现
协议的 P0 不变量和主要内存执行路径，而不是将其定位为生产级工作流引擎。

[查看 TypeScript 参考实现入口](./src/index.ts)

### 2.1 包含内容

- 采用 JSON 形态、带判别字段的协议联合类型，以及轻量的运行时边界校验器。
- 纯函数式 `transition(state, input)` 状态机，为 effect、batch、call、pause 和 event
  提供确定性标识。
- 稳定的内部 `call_key`、batch 内 provider `call_id` 校验、回执窗口去重、revision CAS，
  以及 effect 与结果的关联校验。
- 按顺序合并工具执行进度，包括 `unknown` 结果、重试安全机制和手动补充结果。
- 权威的内存 Store，以原子方式记录每一次 State 转换。
- 内存 Runner，可注入 AgentCore、Policy 和 Tool Executor 适配器。
- 脚本化测试替身和一致性风格测试。

### 2.2 运行方式

```bash
bun install
bun test
bun run typecheck
```

最小示例：

```ts
import {
  InMemoryLoopStore,
  InMemoryReactLoopRunner,
  inMemoryRunnerCapabilities,
  ScriptedAgentCore,
  ScriptedPolicy,
  ScriptedToolExecutor,
} from "./src";

const continuation = { kind: "inline", value: {} } as const;
const runner = new InMemoryReactLoopRunner({
  store: new InMemoryLoopStore(),
  agent_core: new ScriptedAgentCore([
    {
      kind: "tool_calls",
      continuation,
      calls: [{ call_id: "provider-call-1", name: "echo", arguments: "hello" }],
    },
    { kind: "finished", continuation, output: "done" },
  ]),
  policy: new ScriptedPolicy([
    { kind: "execute", mode: "sequential", max_concurrency: 1 },
  ]),
  tool_executor: new ScriptedToolExecutor(async (call) => ({
    call_key: call.call_key,
    call_id: call.call_id,
    status: "success",
    output: call.arguments,
  })),
});

const state = await runner.start({
  kind: "start",
  input_id: "example:start",
  run_id: "example",
  expected_revision: null,
  continuation,
  limits: { max_turns: 4, input_receipt_window: 32 },
  agent_core_capabilities: {},
  tool_executor_capabilities: {},
  runner_capabilities: inMemoryRunnerCapabilities,
});

console.log(state.status); // completed
```

`start.input_id` 以及 `runner.resume(...)` 和 `runner.cancel(...)` 的最后一个
`inputId` 参数，都是由调用方管理的命令 ID。只有在重试同一个逻辑命令时才能复用 ID；
不同的并发命令必须使用不同的 ID。

### 2.3 有意保留的研究缺口

本包**不提供**持久化崩溃恢复、checkpoint 导入、执行权声明或栅栏（fencing）机制、持久且可重放的
事件流、向已经运行的 effect 传播取消信号、自动生成的 JSON Schema、跨语言 fixture，
或生产级存储适配器。导出的 Runner capabilities 会将这些持久化能力报告为 `false`。

为了保持研究内容的完整性，协议保留了 `recover` Input；但本参考状态机会明确拒绝它，
内存 Runner 也未暴露恢复 API。

内存 Store 让状态转换边界变得可观察、可测试，但进程崩溃会导致全部状态丢失。文章保留了
更棘手的分布式运行时问题，以便后续研究，而没有用容易引起误解的 API 将它们隐藏起来。
