import type {
  Effect,
  LoopState,
  NormalizedToolCall,
  ToolBatchDecision,
  ToolResult,
  TurnOutcome,
} from "./protocol";
import type { AgentCoreAdapter, LoopPolicy, ToolExecutor } from "./runner";

export class ScriptedAgentCore implements AgentCoreAdapter {
  readonly requests: Extract<Effect, { kind: "run_turn" }>[] = [];
  readonly observed_revisions: number[] = [];
  readonly #outcomes: (TurnOutcome | Error)[];

  constructor(outcomes: readonly (TurnOutcome | Error)[]) {
    this.#outcomes = [...outcomes];
  }

  async run(effect: Extract<Effect, { kind: "run_turn" }>, committedState: LoopState): Promise<TurnOutcome> {
    this.requests.push(structuredClone(effect));
    this.observed_revisions.push(committedState.revision);
    const outcome = this.#outcomes.shift();
    if (!outcome) throw new Error("ScriptedAgentCore has no outcome left");
    if (outcome instanceof Error) throw outcome;
    return structuredClone(outcome);
  }
}

export class ScriptedPolicy implements LoopPolicy {
  readonly requests: Extract<Effect, { kind: "decide_tool_batch" }>[] = [];
  readonly #decisions: (ToolBatchDecision | Error)[];

  constructor(decisions: readonly (ToolBatchDecision | Error)[]) {
    this.#decisions = [...decisions];
  }

  async decide(effect: Extract<Effect, { kind: "decide_tool_batch" }>): Promise<ToolBatchDecision> {
    this.requests.push(structuredClone(effect));
    const decision = this.#decisions.shift();
    if (!decision) throw new Error("ScriptedPolicy has no decision left");
    if (decision instanceof Error) throw decision;
    return structuredClone(decision);
  }
}

export class ScriptedToolExecutor implements ToolExecutor {
  readonly requests: NormalizedToolCall[] = [];

  constructor(
    private readonly handler: (call: NormalizedToolCall) => Promise<ToolResult>,
    private readonly retrySafeNames: ReadonlySet<string> = new Set(),
  ) {}

  async execute(call: NormalizedToolCall): Promise<ToolResult> {
    this.requests.push(structuredClone(call));
    return this.handler(structuredClone(call));
  }

  isRetrySafe(call: NormalizedToolCall): boolean {
    return this.retrySafeNames.has(call.name);
  }
}
