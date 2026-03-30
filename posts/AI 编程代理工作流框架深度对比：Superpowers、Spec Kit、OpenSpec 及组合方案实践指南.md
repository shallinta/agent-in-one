# AI 编程代理工作流框架深度对比：Superpowers、Spec Kit、OpenSpec 及组合方案实践指南

## 引言
2026 年，AI 编程代理（Claude Code、Cursor、Codex、Gemini CLI 等）已经成为开发者的日常工具。但 让 AI 写代码 和 让 AI 按工程规范高质量交付代码 之间，还隔着一层工作流框架。
目前社区中最有影响力的三个框架分别是 **Superpowers**（93k Stars）、**Spec Kit**（GitHub 官方出品）和 **OpenSpec**（31.7k Stars）。它们的共同理念是：**在 AI 写代码之前先对齐需求和计划**——但在定位、实现方式和适用场景上有着显著差异。
本文将从项目介绍、横向对比、组合方案设计，到大型前端项目的实战选型，逐层展开分析，帮助开发者做出务实的选择。
---

## 第一部分：三大框架概览
### 1.1 Superpowers：AI 代理的操作系统
[Superpowers](https://github.com/obra/superpowers) 由 Jesse Vincent 及 Prime Radiant 团队开发，是一个为 AI 编程代理打造的**可组合技能框架 + 软件开发工作流方法论**。它不是一个独立的应用，而是一套**自动注入到 AI 编码代理中的技能集合**，让代理在软件开发过程中遵循严谨的工程方法论。
**核心工作流程**：
当你启动编码代理时，Superpowers 从第一个交互就开始生效。代理不会直接跳进代码编写，而是先通过 `brainstorming` 技能用苏格拉底式提问澄清你真正想做什么，逐步形成设计文档。设计确认后，`writing-plans` 技能将设计拆解为 2-5 分钟的细粒度任务，每个任务包含精确的文件路径、完整代码和验证步骤。接下来，`subagent-driven-development` 技能为每个任务派发独立的子代理执行，主代理负责分发和两阶段审查（规范合规 + 代码质量）。全程强制 TDD：先写测试看到红色，再写实现看到绿色，不写测试的代码会被删除。Claude 代理可以连续自主工作数小时而不偏离计划。
**完整技能库**：

| 能力类别 | 技能 | 作用 |
| --- | --- | --- |
| 需求澄清 | `brainstorming` | 苏格拉底式提问，动态生成设计文档 |
| 计划制定 | `writing-plans` | 拆解为 2-5 分钟细粒度任务 |
| 自主执行 | `subagent-driven-development` / `executing-plans` | 子代理并行执行 + 两阶段审查 |
| 并行开发 | `dispatching-parallel-agents` | 并发子代理工作流 |
| 测试驱动 | `test-driven-development` | 强制 RED-GREEN-REFACTOR |
| 调试 | `systematic-debugging` | 4 阶段根因分析（含根因追踪、纵深防御、条件等待） |
| 代码审查 | `requesting-code-review` / `receiving-code-review` | 按严重等级报告问题，关键问题阻断进度 |
| 分支管理 | `using-git-worktrees` / `finishing-a-development-branch` | 隔离工作区 + 自动提供 merge/PR/保留/丢弃选项 |
| 元技能 | `writing-skills` / `using-superpowers` | 创建新技能、技能系统导览 |

**核心哲学**：
- **测试先行** — 永远先写测试
- **系统化优先** — 流程优于猜测
- **降低复杂性** — 以简洁为首要目标
- **证据优先** — 验证后再宣称完成
**安装方式（以 Claude Code 为例）**：
```plaintext
/plugin install superpowers@claude-plugins-official
```

安装后无需额外操作，代理会自动在合适的时机触发对应技能。支持 Claude Code、Cursor、Codex、OpenCode、Gemini CLI 等平台。
### 1.2 Spec Kit：GitHub 官方的开发方法论脚手架
[Spec Kit](https://github.com/github/spec-kit) 是 GitHub 官方开源的规范驱动开发工具包，设计目标是帮助开发者超越随意的  vibe-coding ，建立可重复、可验证的 AI 辅助开发工作流。它以 specification（规范）为中心，先明确 做什么 ，再规划 怎么做 ，最后拆解为可独立实现和测试的任务。
**核心流程**：
Spec Kit 围绕三个核心命令构建：`/speckit.specify` 生成需求规范，`/speckit.plan` 产出技术方案，`/speckit.tasks` 导出可执行的任务列表。此外还有 `constitution`（项目宪法）定义持久化的项目级约束、`clarify` 进行多轮需求澄清、`analyze` 做跨制品一致性检查、`checklist` 生成质量清单。
**关键特征**：
- GitHub 官方维护，支持 25+ AI 代理
- 有完整的文档层级：constitution → specification → plan → tasks → research → contracts
- 刚性阶段门禁：每步需确认才能推进
- 提供跨制品一致性检查能力
### 1.3 OpenSpec：轻量级规范管理器
[OpenSpec](https://github.com/Fission-AI/OpenSpec) 由 Fission-AI 开发，定位为 AI 编程助手的轻量级规范层。它的核心哲学是 fluid not rigid, iterative not waterfall, easy not complex ——流动而非僵化，迭代而非瀑布，简单而非复杂。
**核心流程**：
一条 `/opsx:propose` 命令即可为一个变更自动生成完整的文件夹结构（proposal.md + specs/ + design.md + tasks.md）。实现时用 `/opsx:apply`，完成后用 `/opsx:archive` 归档。任何阶段都可以回来修改任何文件，没有刚性的阶段门禁。
**关键特征**：
- 每个变更一个独立文件夹，清晰的变更管理
- 无阶段门禁，随时可修改任何制品
- 支持 20+ AI 代理
- 特别强调对 Brownfield（已有项目）的支持
---

## 第二部分：三大框架横向对比
### 2.1 基本信息

| 维度 | Superpowers | Spec Kit | OpenSpec |
| --- | --- | --- | --- |
| 维护者 | Jesse Vincent / Prime Radiant（社区） | GitHub 官方 | Fission-AI（社区） |
| Stars | 93k | 77.9k | 31.7k |
| 许可证 | MIT | MIT | MIT |
| 主要语言 | Shell / JavaScript | Python / Shell | TypeScript |
| 安装方式 | 作为 plugin 安装到代理内 | CLI 工具 | CLI 工具 |
| 支持的代理 | Claude Code, Cursor, Codex, OpenCode, Gemini CLI | 25+ 代理 | 20+ 代理 |

### 2.2 核心定位差异
三个项目虽然都围绕 AI 辅助开发的工作流 ，但核心定位截然不同：
- **Superpowers = 代理的操作系统**：教代理怎么 做人 。不仅做规划，还深度介入执行、测试、调试、审查的全链路，强调代理的自主运行能力。
- **Spec Kit = 开发方法论的脚手架**：教人怎么指挥代理。专注于 Spec → Plan → Tasks → Implement 的文档驱动工作流，偏方法论模板。
- **OpenSpec = 轻量规范管理器**：让人和代理在文档上对齐。强调 流动而非僵化 ，每次变更一个文件夹，注重迭代灵活性。
### 2.3 工作流阶段对比

| 阶段 | Superpowers | Spec Kit | OpenSpec |
| --- | --- | --- | --- |
| 需求澄清 | `brainstorming` 自动触发，苏格拉底式提问 | `/speckit.specify` + `/speckit.clarify` | `/opsx:propose` 一条命令生成全套 |
| 项目级约束 | 无显式 constitution，依赖初始 prompt | `constitution.md` 持久化项目宪法 | 无显式 constitution |
| 技术计划 | `writing-plans` 自动拆解任务 | `/speckit.plan` + `/speckit.tasks` 分两步 | propose 一体化生成 design.md + tasks.md |
| 执行 | **子代理并行执行 + 两阶段审查** | `/speckit.implement` 顺序执行 | `/opsx:apply` 顺序执行 |
| TDD 强制 | **内建强制**，不写测试删代码 | 依赖 constitution 中的准则 | 无内建 TDD 强制 |
| 自动审查 | **两阶段审查**（规范合规 + 代码质量） | 无内建审查 | 无内建审查 |
| 调试 | **4 阶段根因分析** | 无专门调试技能 | 无专门调试技能 |
| 一致性检查 | 无 | `/speckit.analyze` 跨制品检查 | 无 |
| 分支管理 | git worktree + finishing-branch | 自动创建 feature 分支 | `/opsx:archive` 归档完成的变更 |
| 中途改规范 | 对话中随时调整 | 需回到 Spec Kit 修改后重新推进 | 随时改任何文件，无门禁 |

### 2.4 关键差异总结
**自治程度**是最大分水岭。Superpowers 可以让代理连续自主工作数小时，通过子代理驱动开发 + 自动审查实现 项目经理 + 工程师 的分工模式。Spec Kit 和 OpenSpec 本质上都是 人驱动 的——每个阶段需要人工确认推进。
**文档规范深度**上，Spec Kit 最重（constitution → specification → plan → tasks → research → contracts），OpenSpec 次之（每个变更一个文件夹），Superpowers 最轻（设计文档不结构化）。
**灵活性**上，OpenSpec 最高（无阶段门禁），Superpowers 次之（技能自动触发，对话式调整），Spec Kit 最低（刚性阶段门禁）。
### 2.5 选型快速参考

| 场景 | 推荐 |
| --- | --- |
| 想让 AI 代理最大程度自主工作 | Superpowers |
| 企业级项目，需要完整文档体系和可追溯性 | Spec Kit |
| 快速迭代、Brownfield 项目，轻量规范对齐 | OpenSpec |
| 重度 TDD 实践者 | Superpowers |
| 多代理兼容性优先 | Spec Kit |
| 个人项目或小功能迭代 | OpenSpec |

---

## 第三部分：组合使用方案
理论上，框架之间可以组合使用——用一个做规划，另一个做执行。以下是两种可行的组合路径。
### 3.1 方案一：Spec Kit（规划层）+ Superpowers（执行层）
**核心思路**：Spec Kit 当 产品经理 ，Superpowers 当 工程团队 。前半程用 Spec Kit 的结构化文档体系做需求和计划，后半程用 Superpowers 的子代理驱动机制做执行和质量保障。
**架构设计**：
```plaintext
Phase 1: Spec Kit 主导（规划阶段）
┌─────────────────────────────────────────────┐
│ /speckit.constitution → 项目宪法             │
│ /speckit.specify      → 需求规范             │
│ /speckit.clarify      → 澄清模糊点           │
│ /speckit.plan         → 技术方案             │
│ /speckit.tasks        → 任务拆解             │
│ /speckit.checklist    → 质量清单             │
└──────────────────┬──────────────────────────┘
                   │ 产出物：.specify/ 目录
                   ▼
Phase 2: Superpowers 主导（执行阶段）
┌─────────────────────────────────────────────┐
│ using-git-worktrees   → 创建隔离分支         │
│ subagent-driven-dev   → 子代理逐任务执行      │
│ test-driven-dev       → 强制 TDD             │
│ requesting-code-review → 自动审查            │
│ finishing-branch      → 完成分支             │
└─────────────────────────────────────────────┘
```

**操作步骤**：
第一步，安装两个框架。以 Claude Code 为例，安装 Superpowers 插件和 Spec Kit CLI，并在项目中初始化 Spec Kit。
第二步，**禁用 Superpowers 的规划类技能**——这是关键操作，必须避免两套规划流程互相打架。在项目配置或对话开头声明：规划阶段使用 Spec Kit 的命令，不触发 Superpowers 的 brainstorming 和 writing-plans。
第三步，用 Spec Kit 走完规划流程：constitution → specify → clarify → plan → tasks → checklist。产出完整的 `.specify/` 文档目录。
第四步，**桥接**——将 Spec Kit 的 tasks 输出喂给 Superpowers。明确告诉代理进入执行模式，按照 `.specify/tasks.md` 使用 Superpowers 的 subagent-driven-development 执行。
第五步，Superpowers 接管执行：创建 git worktree → 子代理逐任务执行 → 强制 TDD → 自动审查 → 完成分支。
第六步（可选），回到 Spec Kit 用 `/speckit.analyze` 做一致性验证。
**优势**：规划深度 + 执行强度的结合；完整的文档可追溯链；Spec Kit checklist + Superpowers code-review 形成双重质量保障。
**风险**：Superpowers 的 brainstorming 可能自动触发导致冲突；Spec Kit 的 tasks 格式与 Superpowers 期望的可能不兼容；两套框架占用大量 context window；学习和维护成本高。
### 3.2 方案二：OpenSpec（规范管理）+ Superpowers（执行引擎）
**核心思路**：OpenSpec 当 需求白板 ，Superpowers 当 执行机器人 。OpenSpec 负责轻量级的规范对齐和变更管理，Superpowers 负责执行和质量保障。
**架构设计**：
```plaintext
┌──────────────┐          ┌───────────────────────────┐
│  OpenSpec     │          │  Superpowers               │
│  (规范管理)    │          │  (执行引擎)                 │
│              │          │                           │
│ /opsx:propose │ ──────► │ using-git-worktrees       │
│   proposal.md │         │ subagent-driven-dev       │
│   specs/      │ ◄─反馈─ │   ├── 子代理 1 (TDD)      │
│   design.md   │         │   ├── 子代理 2 (TDD)      │
│   tasks.md    │         │   └── 子代理 N (TDD)      │
│ /opsx:archive │ ◄────── │ finishing-branch           │
└──────────────┘          └───────────────────────────┘

     ◄─── 任何阶段可随时修改规范 ───►
```

**操作步骤**：
第一步，安装 OpenSpec CLI 和 Superpowers 插件，在项目中初始化 OpenSpec。
第二步，配置协作边界：OpenSpec 负责 propose 和 archive，Superpowers 负责执行。明确约定不使用 Superpowers 的 brainstorming（用 OpenSpec 的 propose 替代），不使用 OpenSpec 的 `/opsx:apply`（执行全走 Superpowers）。
第三步，用 `/opsx:propose` 快速生成变更的完整规范文件夹。此时可以随时修改任何文件——这是 OpenSpec  fluid not rigid  的核心优势。
第四步，规范确认后触发 Superpowers 执行。
第五步，Superpowers 自主执行。执行过程中如果发现规范有问题，可以随时回到 OpenSpec 修改规范再继续——这是方案二的独特优势。
第六步，完成后用 `/opsx:archive` 归档变更。
**优势**：极高灵活性（规划和执行没有刚性门禁）；轻量起步（一条 propose 命令生成全套）；变更文件夹化管理清晰；适合迭代开发。
**风险**：OpenSpec 的 `/opsx:apply` 会与 Superpowers 的执行流冲突；brainstorming 可能被意外触发；任务格式可能需要适配；中途改规范可能导致已完成代码与新规范不一致。
---

## 第四部分：组合方案 vs 单独 Superpowers——到底值不值得
### 4.1 增量能力分析
组合方案比单独使用 Superpowers 多出来的能力集中在三个区域：
**增量一：规范文档的结构化持久化**。Superpowers 的 brainstorming 产出设计文档，但没有固定的目录结构和模板。组合方案提供了 `.specify/`（Spec Kit）或 `openspec/changes/`（OpenSpec）的结构化存储。这个增量在个人开发/小 feature 中价值低，在多人协作/交接/合规审计中价值高。
**增量二：跨制品一致性检查**（仅 Spec Kit）。可以自动检查 实现是否与规范一致 。Superpowers 的 code-review 也会对照计划检查，但对照对象是任务描述而非独立的规范文档。对简单需求价值不大，对复杂需求（有很多隐含约束）有实际价值。
**增量三：变更归档管理**（仅 OpenSpec）。将完成的变更归档到 archive 目录。Superpowers 通过 git 分支历史 + PR 描述也可以追溯，但不如在项目目录中直接可见。
### 4.2 额外成本分析

| 成本维度 | 单独 Superpowers | 组合方案 |
| --- | --- | --- |
| 安装复杂度 | 一条命令 | 两个框架 + 配置协作边界 + 禁用冲突技能 |
| 学习成本 | 零（技能自动触发） | 需掌握两套体系 + 记住何时用哪个 |
| **上下文窗口占用** | 正常 | **显著增加，压缩可用的代码上下文** |
| 出错概率 | 低（一套流程，自洽） | 中高（技能冲突、格式不兼容、阶段切换遗忘） |
| 调试复杂度 | 低 | 高（需判断是哪个框架导致的问题） |
| 维护负担 | 单框架升级 | 双框架升级 + 兼容性风险 |

其中**上下文窗口占用**是最容易被忽略但影响最大的成本。AI 代理的 context window 有限，两套框架的指令和技能描述会占用可观的 token，在处理大型代码库时可能导致代理 忘记 关键的代码上下文。
### 4.3 决策矩阵

| 场景 | 推荐 | 理由 |
| --- | --- | --- |
| 个人项目 / side project | 单独 Superpowers | 零配置、零学习成本 |
| 小团队快速迭代 | 单独 Superpowers | 协调成本 > 收益 |
| 需求频繁变化 | 单独 Superpowers 或 OpenSpec + SP | 如特别需要变更归档才加 OpenSpec |
| 需要完整文档审计链 | Spec Kit + SP | 核心优势场景 |
| 正式企业交付 | Spec Kit + SP | 文档可追溯性 + 一致性检查有实际价值 |
| AI 代理新手 | 单独 Superpowers | 组合方案要求判断 何时用哪个工具 |
| 追求最大自主化 | 单独 Superpowers | 组合方案反而引入更多人工干预点 |

### 4.4 务实建议
与其一开始就上组合方案，更推荐**渐进式策略**：
- **阶段 1**：单独使用 Superpowers，观察规划质量是否满足需求，是否出现 实现偏离意图 的情况，文档追溯是否有痛点。
- **阶段 2**：如果发现痛点，针对性补充——规范不够结构化就加 OpenSpec 的 propose；需要文档审计链就加 Spec Kit 的文档体系；变更管理混乱就加 OpenSpec 的 archive。
- **阶段 3**：仅在确认增量价值 > 复杂度成本时，才完整启用组合方案。
**90% 的开发场景中**，Superpowers 单独使用的 brainstorming → writing-plans → subagent-driven-development → TDD → code-review → finishing-branch 已经是一个非常完整且自洽的闭环。组合方案解决的是那 10% 的边缘需求，但付出的是全链路复杂度翻倍的代价。
---

## 第五部分：大型前端项目 + 长期迭代的选型实践
前面的讨论偏通用场景，但 大型前端项目 + 长期迭代 有其独特挑战，需要专门分析。
### 5.1 大型前端项目的特殊挑战
**上下文膨胀问题**：一个典型的大型前端项目包含数百个组件（嵌套层级深）、复杂的状态管理（Redux/Zustand/Pinia 等全局状态、跨组件数据流）、样式系统（CSS Modules / Tailwind / Styled Components + 设计 Token）、嵌套路由系统、构建配置（Webpack/Vite + 各种 loader/plugin）以及接口层（API 请求、类型定义、Mock 数据）。核心矛盾在于：AI 代理的 context window 有限，但大型前端项目需要 看到全貌 才能做出正确决策。**任何占用额外 context 的东西都是成本。**
**前端测试的特殊性**：Superpowers 强制 TDD 是其核心卖点，但前端 TDD 有独特困难。UI 组件测试比纯函数测试复杂得多，CSS 变更无法通过单元测试捕获，交互状态（hover、focus、动画过渡）的测试很脆弱，端到端测试需要浏览器环境。这意味着 不写测试就删代码 策略在前端场景中需要更灵活的适配。
**长期迭代的演化问题**：上线后需求碎片化（每个 sprint 改一点），技术债累积不可避免，设计决策会随时间被遗忘（三个月后没人记得当初为什么选了方案 A），团队成员流动带来新人上手的挑战。
### 5.2 各方案在前端场景下的适配分析
**单独 Superpowers** 的优势：上下文开销最小（代理有更多空间理解前端代码）；子代理驱动在前端场景特别有价值（一个改组件、一个改样式、一个改状态管理，互不干扰）；`systematic-debugging` 对前端复杂 bug 很有用；零额外配置，新功能迭代启动成本极低。短板：brainstorming 产出的设计文档是 一次性 的，三个月后做相关迭代时代理不会自动回顾当初的设计决策；没有变更档案；没有项目级约束的持久化。**这些短板在前 3 个月不明显，但第 6 个月开始会越来越痛。**
**Spec Kit + Superpowers** 的优势：`constitution.md` 完美解决项目级约束持久化问题；`/speckit.analyze` 可以检查组件 API 是否与设计规范一致；完整文档链对长期维护有价值。短板：上下文开销大（前端代码本身就吃 context）；阶段门禁在快速迭代中太重（ 给表格加一列 也要走全流程）；维护两套配置是持续成本。**初期建设阶段合适，持续迭代阶段会成为速度瓶颈。**
**OpenSpec + Superpowers** 的优势：变更文件夹化管理天然适配 每个 Sprint 若干个 feature 的模式；归档保留设计决策方便未来追溯；灵活度高、小改动不需要全流程。短板：没有 constitution（但可以自建约束文件）；没有一致性检查；两套框架的协调仍是成本。
### 5.3 推荐方案：分阶段策略
对 大型前端项目 + 长期迭代 这个具体场景，推荐的不是某一个固定方案，而是**随项目生命周期演进的分阶段策略**。
**阶段一：0→1 建设期（项目初建，1-3 个月）——OpenSpec + Superpowers**
这是项目架构决策最密集的阶段，每个决策都值得记录，但还不需要 Spec Kit 那么重的文档体系。
具体做法：
首先，在项目根目录创建 `PROJECT_CONTEXT.md` 作为项目级约束文件（替代 Spec Kit 的 constitution）。这个文件定义技术栈（如 React 18 + TypeScript 5 + Zustand + Tailwind CSS + Vite）、组件规范（如 Atomic Design）、测试策略、样式规范、状态管理方案、目录结构等。
然后，用 OpenSpec 管理每个架构级决策。例如分别用 `/opsx:propose` 为设计系统搭建、认证流程、数据获取层等创建独立的规范文件夹。
用 Superpowers 的子代理并行执行各个基础建设任务。完成后用 `/opsx:archive` 归档——三个月后新人入职，看 archive 就知道为什么选了这套技术方案。
**阶段二：上线后持续迭代期（3 个月+）——切换到单独 Superpowers**
上线后的需求以 给列表页加筛选 、 优化表单校验 、 适配暗黑模式 这类中小改动为主。每个需求走 OpenSpec 的 propose 流程过重——5 分钟能改完的东西不值得花 10 分钟写规范。Superpowers 的 brainstorming 对这类需求已经足够。
典型的日常迭代流程：你描述需求 → brainstorming 自动触发确认细节 → writing-plans 拆解任务 → subagent-driven-development 执行 → 15 分钟后功能完成，PR 已创建。零额外配置、零仪式成本。
但保留一个例外规则：当迭代涉及**架构级变更**时（如状态管理迁移、路由系统重构、引入 SSR/RSC、设计系统大版本升级），临时启用 OpenSpec 记录决策 → Superpowers 执行 → 归档。
**阶段三：团队扩大 / 合规需求出现时——升级到 Spec Kit + Superpowers**
触发条件：团队超过 5 人需要统一规范文档体系；项目需要安全审计/合规文档；频繁出现 实现偏离需求 的问题。此时 Spec Kit 的 constitution + analyze + checklist 的价值才真正凸显。
### 5.4 前端场景的特殊配置建议
无论选哪个方案，大型前端项目都需要做一些前端专属的配置调整。
**TDD 策略分层**：在 PROJECT_CONTEXT.md 中按代码类型区分测试策略。Custom Hooks、工具函数、状态管理逻辑、API 请求层、表单校验规则 → 强制 TDD。UI 组件的渲染和交互测试 → 测试跟随实现（仍然必须在同一任务内写测试，但不强制先写）。关键组件的 Storybook Stories 和视觉回归快照 → 非 TDD 但必须有。关键用户流程 → Playwright E2E，在 feature 完成后统一添加。这样 Superpowers 的 TDD 技能就不会在你写一个纯展示组件时强制要求先写测试。
**组件边界感知**：在 PROJECT_CONTEXT.md 中标注高影响的共享组件（如 Button 被 47 个组件使用、Modal 被 23 个页面使用），要求代理修改这些文件时必须先列出所有引用方、评估副作用。
**变更规模自动分级**：定义 S/M/L/XL 四个级别。S 级（单组件修改、bug 修复、样式微调，预计 < 30 分钟）直接用 Superpowers。M 级（新增页面/功能模块、跨组件联动，30 分钟 ~ 2 小时）用 Superpowers 并让 brainstorming 更充分。L 级（架构变更、新增基础设施、跨系统集成，> 2 小时）启用 OpenSpec + Superpowers。XL 级（重大技术迁移、设计系统大版本升级，> 1 周）启用 Spec Kit + Superpowers。
---

## 第六部分：实战使用示例——以 TaskFlow 项目为例
---

前面的章节对比了三大框架的定位、工作流和组合策略。但 它们具体用起来是什么感觉 这个问题，光看对比表格很难回答。本节用一个统一的假设性项目——**TaskFlow（团队任务管理 Web 应用）**——分别演示三个工具从零开始的完整使用流程。
**项目需求概述**：
- 用户可以创建、编辑、删除任务
- 任务支持分配给团队成员
- 支持看板视图（Todo / In Progress / Done）拖拽排序
- 支持任务评论和 @提及通知
- 技术栈：React + TypeScript + Node.js + PostgreSQL
---

### 6.1 使用 Superpowers 构建 TaskFlow
**Step 0：安装（一次性）**
在 Claude Code 中执行：
```plaintext
/plugin install superpowers@claude-plugins-official

```

安装后无需任何配置。启动一个新会话即可。
**Step 1：启动对话——brainstorming 自动触发**
你不需要执行任何特殊命令。直接用自然语言描述需求：
```plaintext
你：我想做一个团队任务管理应用 TaskFlow。支持创建/编辑/删除任务，
    可以分配给团队成员，有看板视图支持拖拽，任务可以评论和 @提及通知。
    用 React + TypeScript + Node.js + PostgreSQL。

```

Superpowers 的 `brainstorming` 技能**自动触发**（你看不到它被调用，它就是自然地发生了）。代理不会直接开始写代码，而是开始苏格拉底式提问：
```plaintext
AI：在我们开始设计之前，让我先理解几个关键问题：

    1. 用户认证方式？邮箱密码、OAuth、还是两者都要？
    2. 看板视图中，拖拽排序的结果需要实时同步给其他团队成员吗？
       （即 WebSocket 实时更新，还是刷新后可见？）
    3. @提及通知通过什么渠道？站内通知、邮件、还是两者？
    4. 任务有没有优先级、截止日期、标签等额外字段？
    5. 是否需要多团队/多项目隔离？

```

你回答这些问题后，代理会**分段展示设计文档**（每段足够短，方便你逐段审阅）：
```plaintext
AI：=== 设计文档 第 1/4 部分：数据模型 ===

    User: id, email, name, avatar, created_at
    Team: id, name, owner_id
    TeamMember: team_id, user_id, role(admin/member)
    Project: id, team_id, name
    Task: id, project_id, title, description, status(todo/in_progress/done),
          assignee_id, priority(low/medium/high), due_date, position, created_by
    Comment: id, task_id, author_id, content, mentions(user_id[]), created_at
    Notification: id, user_id, type, reference_id, read, created_at

    你觉得这个数据模型 OK 吗？有需要加减的字段吗？

```

```plaintext
你：加一个 Task 的 labels 字段，支持自定义标签。其他 OK。

```

```plaintext
AI：已更新。

    === 设计文档 第 2/4 部分：API 设计 ===

    认证：
      POST /auth/register
      POST /auth/login
      POST /auth/oauth/google

    任务 CRUD：
      GET    /projects/:projectId/tasks
      POST   /projects/:projectId/tasks
      PATCH  /tasks/:taskId
      DELETE /tasks/:taskId

    看板拖拽：
      PATCH  /tasks/:taskId/move  { status, position }
      WebSocket channel: project:{projectId}:tasks  (实时广播)

    评论：
      GET    /tasks/:taskId/comments
      POST   /tasks/:taskId/comments  { content, mentions: [userId] }

    通知：
      GET    /notifications
      PATCH  /notifications/:id/read

    这部分 OK 吗？

```

你逐段确认后，代理保存完整设计文档。
**Step 2：计划制定——writing-plans 自动触发**
设计确认后，代理自动进入 `writing-plans`：
```plaintext
AI：设计已确认。下面是实现计划，每个任务控制在 2-5 分钟可完成：

    === Phase 1: 项目基础设施 ===
    Task 1.1: 初始化 monorepo (pnpm workspace)
    Task 1.2: 数据库初始化
    Task 1.3: 认证系统

    === Phase 2: 核心功能 ===
    Task 2.1: 任务 CRUD API
    Task 2.2: 任务 CRUD 前端
    Task 2.3: 看板视图
    Task 2.4: WebSocket 实时同步

    === Phase 3: 协作功能 ===
    Task 3.1: 评论系统 API + 前端
    Task 3.2: @提及解析 + 通知创建
    Task 3.3: 通知中心 UI + 已读标记

    === Phase 4: 收尾 ===
    Task 4.1: 全局错误处理 + Loading 状态
    Task 4.2: E2E 测试 (Playwright)

    共 12 个任务。Ready to go?

```

```plaintext
你：go

```

**Step 3：自主执行——subagent-driven-development 接管**
这是 Superpowers 最独特的部分。你说了 go 之后，代理会自动创建隔离工作区（`using-git-worktrees` 触发），然后逐个派发子代理执行任务：
```plaintext
AI：创建 git worktree: feature/taskflow-mvp
    开始执行任务...

    [Task 1.1] 派发子代理 → 初始化 monorepo
    ├── 创建 pnpm-workspace.yaml
    ├── 初始化 packages/server 和 packages/web
    └── pnpm build... ✓ 通过
    [审查 Stage 1 - 规范合规] ✓
    [审查 Stage 2 - 代码质量] ✓
    ✅ Task 1.1 完成

```

注意 TDD 过程——每个子代理被**强制**先写测试（红色），再写实现（绿色）：
```plaintext
AI：[Task 2.1] 派发子代理 → 任务 CRUD API
    ├── 写测试:
    │   ├── POST /tasks → 红色 ✗
    │   ├── GET /tasks → 红色 ✗
    │   ├── PATCH /tasks/:id → 红色 ✗
    │   └── DELETE /tasks/:id → 红色 ✗
    ├── 写实现:
    │   ├── tasksRouter + 4 个路由处理器
    │   ├── Prisma 查询逻辑
    │   └── 输入校验 (zod schema)
    ├── 运行测试 → 4/4 绿色 ✓
    [审查 Stage 1] ✓ [审查 Stage 2] ✓
    ✅ Task 2.1 完成

```

代理可以**连续数小时**这样自主执行，你只需要偶尔检查进度。
**Step 4：完成**
所有 12 个任务执行完毕后：
```plaintext
AI：所有任务已完成。测试结果: 47 passed, 0 failed
    选项: [A] 合并到 main [B] 创建 Pull Request [C] 保留分支 [D] 丢弃

你：B

AI：PR 已创建: feature/taskflow-mvp → main

```

**全程人工操作**：回答几个澄清问题 + 逐段确认设计 + 说一个 go + 最后选 merge 方式。**总共 ~10 分钟人工时间**，剩下的代理自主完成。
---

### 6.2 使用 Spec Kit 构建 TaskFlow
**Step 0：安装**
```plaintext
# 安装 Spec Kit CLI
uv tool install spec-kit

# 在项目中初始化（以 Claude Code 为例）
mkdir taskflow && cd taskflow
speckit init --agent claude-code

```

这会创建 `.specify/` 目录和初始配置文件。
**Step 1：建立项目宪法（Constitution）**
这是 Spec Kit 独有的概念——在做任何需求之前，先定义项目的基本法则：
```plaintext
你：/speckit.constitution

AI：让我来帮你建立项目宪法。请回答以下问题：
    1. 项目名称和简短描述？
    2. 首选技术栈？
    3. 测试策略？
    4. 代码风格偏好？
    5. 任何硬性约束？

```

```plaintext
你：TaskFlow，团队任务管理应用。React + TypeScript + Node.js + PostgreSQL。
    单元测试 + 集成测试，覆盖率 > 80%。严格 TypeScript，no any。

AI：已生成 .specify/memory/constitution.md：

    # TaskFlow Constitution
    ## Tech Stack
    - Frontend: React 18, TypeScript 5, Vite
    - Backend: Node.js, Express, TypeScript
    - Database: PostgreSQL with Prisma ORM
    ## Code Standards
    - Strict TypeScript: no any, no @ts-ignore
    ## Testing Requirements
    - Minimum 80% code coverage
    - All API endpoints must have integration tests

```

这份 constitution 会在后续每一步中被代理自动参考。
**Step 2：需求规范（Specify）**
```plaintext
你：/speckit.specify 我需要一个团队任务管理应用。支持创建/编辑/删除任务，
    分配给团队成员，看板视图支持拖拽排序，任务评论和 @提及通知。

```

代理基于 constitution 和你的输入，生成结构化的规范文档，保存为 `.specify/specification.md`（238 行），涵盖用户管理、团队管理、任务管理、协作功能和非功能需求五大模块。
**Step 3：需求澄清（Clarify）**
```plaintext
你：/speckit.clarify

AI：基于规范文档，我有以下需要澄清的问题：
    1. [优先级] 看板拖拽的实时同步是 MVP 必需还是可以 Phase 2？
    2. [边界] 邮件通知用自建服务还是第三方？
    3. [边界] 团队数量限制？
    4. [技术] 看板列是固定的还是用户可自定义？

```

你回答后，代理更新 specification.md 并标注澄清结果。
**Step 4：技术方案（Plan）**
```plaintext
你：/speckit.plan

```

代理基于 constitution 和 specification 生成技术方案，保存为 `.specify/plan.md`（312 行），涵盖 Monorepo 架构、数据库设计、认证架构、实时同步架构、部署方案等。
**Step 5：任务拆解（Tasks）**
```plaintext
你：/speckit.tasks

```

代理拆解为 15 个可执行任务，保存为 `.specify/tasks.md`，每个任务包含预期文件、验收标准、依赖关系。
**Step 6：逐任务实现（Implement）**
```plaintext
你：/speckit.implement

```

代理开始按顺序执行任务。与 Superpowers 不同，Spec Kit **没有子代理机制**，是单线程的；**没有强制 TDD**，依赖 constitution 中的测试准则；**没有自动两阶段审查**，代理只是按 tasks.md 顺序执行。
**Step 7：质量检查（可选）**
```plaintext
你：/speckit.analyze

AI：跨制品一致性检查...
    ✓ specification.md 中定义的 7 个功能模块 → plan.md 中全部有对应架构设计
    ✓ plan.md 中的 7 个模型 → schema.prisma 中全部已实现
    ⚠️ specification.md 5.1 要求 API 响应 < 200ms → 未发现性能测试
    ⚠️ specification.md 5.3 要求移动端响应式 → 未发现响应式布局

```

```plaintext
你：/speckit.checklist

AI：质量清单：
    [✓] 所有 API 端点有集成测试
    [✓] TypeScript strict mode，无 any
    [✗] 代码覆盖率: 当前 72%，目标 80% → 需补充测试
    [✗] E2E 测试覆盖关键流程 → 尚未执行
    [✓] JWT refresh token 机制已实现
    [✓] Prisma 参数化查询，无 SQL 注入风险

```

**全程人工操作**：回答 constitution 问题 + 确认 specify + 回答 clarify + 确认 plan + 确认 tasks + 发起 implement + 检查 analyze/checklist。人工参与的“确认点”比 Superpowers 多很多。
**最终文件结构**：
```plaintext
taskflow/
├── .specify/
│   ├── memory/
│   │   └── constitution.md        ← 项目宪法（持久化）
│   ├── specification.md           ← 需求规范
│   ├── plan.md                    ← 技术方案
│   └── tasks.md                   ← 任务列表（含完成状态）
├── packages/
│   ├── server/
│   ├── web/
│   └── shared/
└── ...

```

---

### 6.3 使用 OpenSpec 构建 TaskFlow
**Step 0：安装**
```plaintext
# 安装 OpenSpec CLI
npm install -g @fission-ai/openspec@latest

# 创建项目并初始化
mkdir taskflow && cd taskflow
git init
openspec init

```

初始化后会在项目中生成 OpenSpec 的配置和 AI 指令文件。
**Step 1：一条命令提出变更**
OpenSpec 的核心体验是一条命令搞定全部规划文档：
```plaintext
你：/opsx:propose build-taskflow-mvp

    一个团队任务管理应用。支持创建/编辑/删除任务，分配给团队成员，
    看板视图支持拖拽排序，任务评论和 @提及通知。
    技术栈 React + TypeScript + Node.js + PostgreSQL。

AI：Created openspec/changes/build-taskflow-mvp/
    ✓ proposal.md  — 为什么做这个，核心价值主张
    ✓ specs/
    │   ├── task-management.md
    │   ├── collaboration.md
    │   └── user-team.md
    ✓ design.md    — 技术架构 + 数据模型 + API 设计
    ✓ tasks.md     — 实现清单 (14 个任务)
    Ready for implementation!

```

注意区别——Spec Kit 需要 5 个命令走完规划，OpenSpec 一条 propose 全部生成。
**Step 2：查看并随意修改**
你可以直接打开任何文件查看和修改。觉得有问题？直接改文件，不需要任何命令：
```plaintext
你：我觉得 design.md 里应该用 Socket.IO 而不是原生 WebSocket

AI：已更新 design.md + 同步更新了 tasks.md 中相关任务的描述。

```

**没有阶段门禁**。随时改任何东西。
**Step 3：开始实现**
```plaintext
你：/opsx:apply

AI：Implementing tasks...
    ✓ 1.1 Initialize monorepo
    ✓ 1.2 Setup Prisma + database schema
    ✓ 1.3 Implement auth
    Working on 2.1 Task CRUD API...

```

代理按 tasks.md 顺序逐个执行。没有子代理，没有强制 TDD，没有自动两阶段审查。
**Step 4：中途改规范（OpenSpec 的独特优势）**
执行到一半，你突然想到一个新需求：
```plaintext
你：等一下，我觉得应该加一个任务活动日志（activity log）

AI：已更新 specs/task-management.md（增加 Activity Log 章节）
    已更新 design.md（增加 ActivityLog 模型）
    已更新 tasks.md（新增 Task 3.5）
    继续实现...

```

直接改，直接继续。
**Step 5：完成并归档**
```plaintext
你：/opsx:archive build-taskflow-mvp

AI：Archived to openspec/changes/archive/2026-03-18-build-taskflow-mvp/
    保留了完整的规范文档。Ready for the next feature!

```

上线后需要加新功能，再走一次 propose → apply → archive。每个功能迭代都是一个独立的文件夹。
**最终文件结构**：
```plaintext
taskflow/
├── openspec/
│   ├── changes/
│   │   └── add-task-templates/           ← 当前变更
│   └── changes/archive/
│       └── 2026-03-18-build-taskflow-mvp/ ← 已归档的 MVP
├── packages/
└── ...

```

---

### 6.4 三者体验的核心差异总结

| 维度 | Superpowers | Spec Kit | OpenSpec |
| --- | --- | --- | --- |
| 规划启动 | 自然对话，技能自动触发 | 5 个显式命令逐步推进 | 1 条 propose 命令生成全套 |
| 人工确认点 | ~3 个（设计分段确认 + go + merge 方式） | ~7 个（每步需确认） | ~2 个（确认规范 + 确认实现） |
| 执行方式 | **子代理并行 + 两阶段审查** | 单线程顺序执行 | 单线程顺序执行 |
| TDD | **强制**，不写测试删代码 | 依赖 constitution 准则（非强制） | 不强制 |
| 中途改需求 | 对话中调整 | 需回到 specify/plan 修改 | **随时改任何文件，无门禁** |
| 产出文档 | 设计文档（非结构化）+ PR | constitution + spec + plan + tasks（高度结构化） | 变更文件夹（proposal + specs + design + tasks） |
| 完成后 | 清理 worktree，留 PR | .specify/ 目录保留 | /opsx:archive 归档到 archive/ |
| 人工总时间 | **~10 分钟**（大部分时间代理自主工作） | ~30 分钟（多次确认 + 等待生成） | ~15 分钟（快速启动 + 偶尔确认） |
| 学习曲线 | 零（安装即用） | 中等（需理解 7 步工作流 + 多个命令） | 低（3 条核心命令） |

**一句话概括体验差异**：
- **Superpowers**： 你告诉我做什么，剩下的我来。 ——你几乎只需要在开头对话 10 分钟，然后代理自主执行数小时。
- **Spec Kit**： 我们一起把文档写清楚，然后我照着做。 ——前期投入大量时间在文档上，执行时中规中矩。
- **OpenSpec**： 先快速对齐，随时调整，做完归档。 ——轻量启动，灵活迭代，每个变更有迹可循。
## 第七部分：总结
经过前六个部分的深入分析，我们可以将核心结论浓缩为以下决策框架：

| 项目生命阶段 | 推荐方案 | 核心理由 |
| --- | --- | --- |
| 0→1 建设期（1-3 个月） | OpenSpec + Superpowers | 架构决策密集，值得结构化记录；子代理并行加速基础建设 |
| 日常功能迭代（占 80%+ 时间） | **单独 Superpowers** | 中小需求零仪式成本、最大化 context 给代码理解 |
| 架构级变更（偶发） | 临时启用 OpenSpec + Superpowers | 按需记录决策，不常驻 |
| 团队扩大 / 合规需求 | Spec Kit + Superpowers | 需要完整文档审计链时才升级 |
| 个人项目 / Side Project | 单独 Superpowers | 零配置、零学习成本、最大自主化 |

**三条核心原则**：
**第一，从简单开始，按需升级。** 90% 的开发场景中，Superpowers 单独使用的 brainstorming → writing-plans → subagent-driven-development → TDD → code-review → finishing-branch 已经是一个非常完整且自洽的闭环。组合方案解决的是那 10% 的边缘需求，但付出的是全链路复杂度翻倍的代价。先跑起来，遇到痛点再加东西。
**第二，上下文窗口是最稀缺的资源。** 对大型前端项目尤其如此——组件树、状态管理、样式系统、路由配置、API 类型定义已经占满了 AI 代理的 视野 。任何额外框架指令都在挤压代理理解代码的空间。选型时永远问一句：这个工具带来的价值，值不值得它占用的 context？
**第三，无论选什么框架，维护好那个 PROJECT_CONTEXT.md。** 它是 AI 代理理解你项目的 北极星 ，不依赖任何框架，就是一个普通的 markdown 文件，但它决定了代理每次会话时的起点在哪里。框架可以换，这个文件的价值会随项目成长而持续增长。
工具终究是工具。真正决定 AI 辅助开发质量的，不是你选了哪个框架，而是你是否在每次交互中给了代理足够清晰的上下文和足够明确的目标。选一个适合当前阶段的方案，把省下来的时间花在理解需求和审查产出上——这才是最高 ROI 的投入。

