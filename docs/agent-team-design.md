# Axon Agent Team 设计草案

> 状态：需求与架构讨论中，尚未进入实现，也尚未纳入核心迭代计划。本文单独记录 Agent Team，不写入 `PROGRESS.md`。

## 1. 产品范围

Agent Team 是 Axon 内的单机多 Agent 协作能力。用户先组建团队并固定协作关系，再向唯一入口 Agent 提交任务；成员 Agent 在约定范围内自主通信和工作，入口 Agent 负责判断整项任务何时完成或失败。

用户可以：

- 添加、删除和编辑成员 Agent，配置职责、提示词、工具及模型运行参数。
- 配置成员之间的双向通信链路，并指定唯一入口 Agent。
- 提交任务、查看运行状态及停止任务。
- 从各成员工作区查看交付物；若工作区本身是 Git worktree，则由用户决定后续如何合并分支。

运行中的团队配置不可修改。配置修改只作用于之后启动的任务。

## 2. 核心约束

- 编辑态与运行态严格分离；任务启动时生成不可变的 `TeamRunSnapshot`。
- 一个 Team 同时只运行一个任务，之后提交的任务进入 FIFO 队列。
- 初版不支持向运行中的任务补充用户消息，也不支持同一 Team 并行运行多个任务。
- 只有入口 Agent 可以与用户交互并决定任务终态；非入口 Agent 不应获得 `AskUserQuestion` 等用户交互工具。
- 每个 Agent 内部串行处理消息，不同 Agent 之间可以并行。
- Agent 之间按照用户预先配置的双向链路直接通信，协调器不转发业务消息。
- 初版不做通信循环检测；队列上限、停止和显式重试上限仍作为基础安全边界。

## 3. 主要实体

### 3.1 TeamDefinition

编辑态团队定义，包括：

- 成员列表及唯一入口成员 ID。
- 成员职责、系统提示词、工具、Runtime、渠道、模型及思考等级等配置。
- 无向通信边集合；一条边表示双方均可发送消息。
- 每个成员直接绑定的工作目录，以及该成员自己的 MCP、Skills 和记忆配置。

成员可以来自两种来源：

- `team_local`：在 Team 内新建、只属于这个 Team 的本地 Agent。配置随 TeamDefinition 持久化，离开该 Team 不可复用；该成员直接绑定一个工作目录并长期持有一个会话，多个 TeamTask 复用工作目录和会话。
- `instance`：添加由 `Agent Profile Revision` 创建的已有 `Agent Instance`。Profile、Revision 与 Instance 的生命周期由 `agent-profile-design.md` 单独设计。

建议从契约开始就保留来源判别字段：

```ts
type TeamMemberSource =
  | { type: "team_local"; config: TeamLocalAgentConfig }
  | { type: "instance"; agentInstanceId: string }
```

任务启动时，两种来源都解析为相同的 `TeamMemberRunSnapshot`，后续 Inbox、Executor、通信、停止和恢复流程不再区分来源。因此初版可以只实现 `team_local`，以后增加 `instance` 分支，不需要重写 Agent Team 的运行架构。

### 3.2 TeamRunSnapshot

任务开始时把团队定义完全解析成运行快照。快照固定成员配置、通信图、入口 Agent、工具权限、Runtime 配置，并引用成员已有的会话和工作区，保证运行期间外部编辑不会改变当前任务。

### 3.3 TeamTask

用户的一次任务提交。框架负责 `queued`、`running`、`stopped` 等事实状态；入口 Agent 通过受控工具请求把运行中的任务结束为 `completed` 或 `failed`。

### 3.4 TeamMessage、TeamRequest 与 DispatchBatch

- `TeamMessage` 是进入 Agent Inbox 的持久化消息。
- 每次 `send_message` 建立一个必须得到终态结果的 `TeamRequest`。
- 同一个 Agent 模型轮次发出的所有 Request 组成一个 `DispatchBatch`。
- Request 的终态包括正常回复、执行异常、用户停止、上游取消和超时。
- Batch 使用 all-settled 语义：部分结果先持久化但不逐条唤醒发送者；所有 Request 终态后，框架把一条聚合结果放进发送者 Inbox。

## 4. Actor 风格运行架构

每个运行中成员由一个 `AgentActor` 表示，内部只有：

- 一个持久化 FIFO Inbox。
- 一个事件驱动、单消费者的 Executor。
- 一个跨 TeamTask 复用的独立 Agent 会话。
- 一个经过主进程校验的独立工作目录。

不需要轮询 Inbox。消息成功入队后触发一次调度信号：如果 Agent 空闲，Executor 立即领取队首消息并启动一轮真实 Agent 对话；如果 Agent 正忙，消息留在队列中。当前轮结束后，Executor 继续领取下一条，直到 Inbox 为空再回到空闲状态。

Agent 没有“等待下游回复”的运行状态。它发出消息并结束模型轮次后就是空闲的，可以继续处理任何新入站消息。尚未收束的请求关联只保存在框架的 Request/Batch 账本中。

## 5. 直接通信流程

以 Agent A 同一轮向 B、C 派发请求为例：

1. A 调用两次 `send_message`；宿主校验当前任务、发送方身份和通信边。
2. 宿主先持久化 Request 和目标消息，再写入 B、C 的 Inbox，并向 A 返回 `accepted`。这里仅表示可靠入队，不是业务回复。
3. B、C 各自的 Executor 被事件唤醒并独立处理，因此可以并行。
4. 每个接收方产生正常回复，或由框架写入异常、停止、取消、超时等终态结果。
5. 框架持续更新同一个 DispatchBatch；部分结果不打断 A 正在处理的其他消息。
6. B、C 都进入终态后，框架生成一条包含所有结果的聚合消息并写入 A 的 Inbox。
7. A 空闲时立即处理该消息；若正在运行，则按 FIFO 顺序稍后处理。A 可据此继续派发、调整方案或结束任务。

接收方在处理 A 的请求时也可以向 A 发送新请求。双方不会互相阻塞：各自当前轮结束后均为空闲，新的入站消息按各自 Inbox 顺序处理。

接收方应使用受控 `reply_message` 工具明确收束当前 Request。若本轮没有派生任何下游 Request，框架可以把正常结束时的最终文本自动转换为回复；若本轮调用 `send_message` 派生了下游 Request，则不能把“已转交”之类的阶段性文本当作上游终态回复。父 Request 保持打开，等下游 Batch 聚合再次唤醒该 Agent 后，再由它回复上游。精确自动收束规则需在开工前确认。

## 6. 任务完成与 `update_task`

“最终参数”是指入口 Agent 调用结束工具时必须提交的结构化字段，建议初版为：

```ts
interface UpdateTeamTaskInput {
  status: "completed" | "failed";
  summary: string;
  reason?: string;
}
```

`processing` 不由模型设置；入口 Agent 开始处理后，框架自动把任务从 `queued` 改为 `running`。

“完成校验”是框架在接受 `update_task` 前验证事实条件，而不是替模型判断工作质量。建议检查：

- 调用者必须是当前任务的入口 Agent。
- 当前任务必须仍处于 `running`。
- `completed` 只能在当前任务全部 Request 已进入终态后提交。
- 状态迁移只能发生一次，不能从终态重新打开。
- `failed` 可由入口 Agent 主动提交；框架随后取消尚未完成的工作并收束任务。

超时、失败或取消也是 Request 终态，因此不会永久阻止完成校验。入口 Agent 看到聚合结果后，仍由它结合任务目标决定是降级完成、改派任务，还是把整项任务标记为失败。框架不校验是否提交过代码、测试是否通过或交付质量是否足够。

## 7. 超时与有限重试

Request 超时后不做框架自动重试。框架应：

1. 中止该 Request 对应的活动 Agent 轮次，并把结果标记为 `timed_out`。
2. 将超时作为本批次的一项终态结果，与其他正常或异常结果一起聚合给发送方。
3. 使用运行令牌忽略超时后才到达的陈旧结果，避免一次 Request 被收束两次。

为了避免模型反复向无响应成员发送同一请求，建议提供显式 `retry_request`，而不是让普通 `send_message` 隐式承担重试：

- 每条逻辑请求记录 `logicalRequestId`、`retryOfRequestId` 和 `attempt`。
- 初版建议同一逻辑请求最多执行两次，即首次发送后只允许重试一次。
- 达到上限后，`retry_request` 返回 `retry_limit_reached`；模型只能改派其他成员、在缺少该结果的情况下继续，或结束任务为失败。
- 同一接收 Agent 在一个任务内连续两次超时后触发成员级熔断；本任务之后发给它的新 Request 立即以 `agent_unavailable` 收束，不再启动 Agent 轮次。下一个任务重新计算，后续可再增加用户手动解除能力。
- 对同一任务、接收方和完全相同内容的重复 `send_message` 做确定性指纹检查，提示模型改用 `retry_request`。指纹只辅助识别误用，不承担语义循环检测。

Request 重试上限与成员级熔断共同保证无响应成员不会被无限调用。这仍不等同于完整的通信循环检测；多个正常响应 Agent 之间的语义循环留到后续版本处理。

## 8. 工作区与 Git 边界

- 每个 Team 成员直接绑定一个已经存在的本地目录，不引用桌面对话的 `AgentProject` 或 `projectId`。主进程负责校验目录存在、类型、真实路径和访问边界。
- 若用户希望使用 Git worktree，直接把该 worktree 目录绑定给成员即可；Team 本身不创建、删除或清理 worktree，也不创建和切换分支。
- 工作区可以是普通目录，也可以是用户预先准备的 Git worktree。若是 Git 仓库，Agent 可以在自身工作区内修改并提交。
- 首期将工作区路径规范化并解析符号链接后，要求同一 Team 的成员工作区互不重复；重复绑定直接拒绝保存或启动。
- 后续允许多个成员绑定同一工作区时，只允许一个成员写入，其他成员强制只读；该权限模型不在首期实现。
- 成员记忆位于该工作目录的 `memory/` 中，因此自然随工作区隔离。未来共享工作区时，记忆写权限也遵循同一“单写多读”规则。
- Team 成员的 MCP 配置按 `teamId/memberId` 保存在 Axon 私有数据目录并加密，不读取或修改桌面对话项目的 MCP 配置。
- 工作目录中的 `.axon/skills`、`.agents/skills` 和 `AGENTS.md` 仍可通过中立的路径发现能力读取；复用底层函数不代表引用 `AgentProject` 领域对象。
- 实现时应把路径校验、指令/Skills 发现、记忆访问和 MCP 连接抽成以可信工作目录或中立配置为输入的底层能力。桌面对话项目和 Team 分别在自己的领域层组装这些能力，Team 代码不得依赖 `AgentProjectManager`。
- Axon 不自动合并、变基、挑拣或推送分支，不创建 Pull Request/Merge Request，也不操作 GitHub、GitLab 或 CI/CD。
- 任务结束后保留用户提供的工作区原状；若工作区属于 Git，由用户决定是否以及如何合并。

## 9. 停止、失败与恢复

- 用户停止任务后，框架拒绝新的发送，取消尚未领取的 Inbox 消息，中止活动轮次，并把相关 Request 收束为取消结果。
- 普通成员执行异常只收束对应 Request，不直接替入口 Agent 决定整个任务失败。
- 入口 Agent 自身不可恢复的执行异常可直接使任务失败。
- 应用重启后，`queued` 任务可以继续调度；中断时正在执行的模型或工具调用不自动重放，避免重复副作用。恢复动作由用户显式触发。
- Team 成员会话不会随 TeamTask 完成而销毁；后续任务继续使用同一应用消息历史和 Runtime artifact，并通过明确任务边界消息区分不同 TeamTask。

## 10. 初版明确不做

- 通信循环检测和全局消息/令牌预算。
- 同一 Team 多任务并行和运行中补充用户输入。
- 运行态修改团队配置。
- 指定出口 Agent。
- 自动合并分支、远端 Git 托管平台操作和 CI/CD。
- 跨进程 Agent 通信。
- 共享工作区的细粒度读写权限。

## 11. 开工前必须确认

以下决定会改变持久化结构、状态机或工具协议，不能留到实现中途再定：

1. **首期 Runtime 范围**：编排契约必须保持 Runtime 中立；需确认首期验收同时覆盖 Pi 和 Zima，还是先只验收 Pi、Zima 随后补齐。建议从第一天就使用中立工具契约，并同时覆盖两个 Runtime，避免形成新的专属分支。
2. **[已确认] 工作区生命周期**：成员绑定用户已经准备好的既有工作区，TeamTask 不创建新工作区或 worktree；首期规范化路径后禁止同一 Team 重复绑定。未来重复工作区采用一个写入者、其他成员只读。
3. **[已确认] 成员工作区的引用方式**：成员直接保存用户选择的工作目录，不创建或引用桌面对话的 Axon 项目。主进程每次加载和启动时重新解析真实路径并执行安全校验。
4. **Team-local Agent 最终字段**：至少要确定职责、基础提示词、Runtime、渠道、模型、思考等级、权限模式、内置工具白名单、Skill 选择和成员 MCP 配置。Team MCP 按成员独立持久化，不依赖桌面对话项目或 Profile 的全局 MCP 注册表。
5. **工具和交互权限**：需确定 `send_message`、`reply_message`、`update_task` 分别对哪些成员可见；非入口成员是否完全移除 `AskUserQuestion`；成员工具需要权限确认时是允许弹窗还是直接按 Team 预设策略 Allow/Deny。建议所有成员有发送/回复，只有入口有 `update_task` 和用户追问，非入口不触发交互式权限弹窗。
6. **回复与父子 Request 收束**：需确认接收方派生下游 Request 后，父 Request 保持打开；下游聚合回来后再回复上游。建议无派生请求时允许最终文本自动回复，有派生请求时必须等聚合并调用 `reply_message`，防止阶段性文本过早结束父请求。
7. **入口 Agent 未结束任务的兜底**：入口没有未决 Request，却既不继续派发也不调用 `update_task` 时，任务会永久处于 `running`。建议框架自动投递一次 `completion_check`；再次结束仍不更新任务，则以 `protocol_error` 标记失败，避免无事件可再唤醒。
8. **持久化与重启语义**：当前架构依赖持久化 TeamDefinition、Task、Inbox、Request、Batch 和成员会话。需最终确认活动轮次在重启后标记 `interrupted`、不自动重放，由用户显式恢复；否则必须删除现有恢复设计并接受进程退出即丢失任务。
9. **[已确认] 跨任务上下文和共享状态**：每个 Team 成员只有一个持久会话和一个固定工作区，所有 TeamTask 顺序复用；成员记忆位于对应工作目录。首期工作区不重复，因此不存在共享记忆并行写入；单写多读随共享工作区能力后续实现。
10. **最小运行 UI**：至少需要 Team 编辑、入口与通信关系、任务提交/排队/停止、入口会话、各成员活动和消息链路、权限/错误状态。需确认非入口成员的完整消息与工具过程是否默认可展开查看；建议可查看但不作为用户输入入口。

以下内容不阻塞首期：Profile/Instance、全局 MCP Definition/Connection、通信循环检测、并行 TeamTask、自动合并、远端 Git 和 CI/CD。首期可以只实现 `team_local`，但成员来源和运行快照契约需预留 `instance` 分支。

## 12. 实施顺序建议

1. 初版先实现 TeamDefinition、Team-local Agent、通信图和入口成员编辑。
2. 任务启动时把 Team-local 配置冻结为成员运行快照，再接入 Inbox、Executor、Request/Batch 和任务状态机。
3. 完成工作区唯一性校验、停止、恢复和运行 UI。
4. Agent Profile/Instance 迭代完成后，只新增 `instance` 来源解析器；下游仍消费同一种成员运行快照。
5. 后续可把成熟的 Team-local Agent 保存为 Profile，或用 Instance 替换 Team-local 成员。

## 13. 后续待确认

1. Team-local Agent 的最终配置字段，以及成员删除后其历史会话的保留策略。
2. Team 添加已有 `Agent Instance` 时，运行快照应完全展开并固定其 `Agent Profile Revision`；需确认已有 Instance 会话加入 Team 后是否继续沿用，或只沿用配置并建立一个 Team 专属持久会话。
3. `update_task` 的最终字段，以及提交 `failed` 时对剩余工作的精确取消顺序。
4. Request 默认超时时间、是否允许成员级覆盖，以及“首次 + 一次重试、连续两次超时后任务内熔断”的边界是否确定。
5. Team、Task、Request、Batch、Inbox 和成员会话的持久化目录及恢复格式。
6. 编辑器、运行监控和成员会话时间线的最小 UI。
