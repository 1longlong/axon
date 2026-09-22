# Axon Agent 配置与实例设计草案

> 状态：独立候选迭代，处于需求与架构讨论阶段，尚未实现，也不写入 `PROGRESS.md` 或核心迭代计划。

## 1. 概念命名

Docker 的“镜像 → 容器”比喻有助于理解，但 Axon 的配置并不包含文件系统和运行状态，因此产品界面建议使用更准确的名称：

- **Agent 配置（Agent Profile）**：可复用、可编辑的声明式蓝图，类似镜像。
- **Agent 配置版本（Agent Profile Revision）**：每次保存配置后生成的不可变版本，类似镜像 digest。
- **Agent 实例（Agent Instance）**：从某个确定版本创建的 Agent 身份，类似容器。
- **Agent 执行会话（Agent Session）**：实例长期持有的实际会话，包含历史和 Runtime artifact；加入 Team 后由多个 TeamTask 顺序复用。

关系如下：

```text
Agent 会话 ──“保存为 Agent 配置”──▶ Agent Profile
                                          │ 保存新版本
                                          ▼
                               Agent Profile Revision
                                          │ 实例化
                                          ▼
                                  Agent Instance
                                    │          │
                           独立使用 Session  Team 复用 Session
```

Profile 可以继续编辑，但已创建的 Instance 始终固定在创建时的 Revision，不会因配置后来修改而静默变化。用户可显式执行“更新到最新版本”，由 Axon 展示差异并重新固定版本。

## 2. 为什么需要四层

只用“配置”和“会话”两个概念会产生几个问题：

- 修改配置后，正在运行的 Team 成员是否立即变化不明确。
- 同一配置无法安全地产生多个相互隔离的 Agent。
- 会话历史、工作区和记忆容易被误当成配置复制。
- Team 运行恢复时无法确认使用的是哪个历史版本。

不可变 Revision 让每次实例化和 Team 运行都可复现；Instance 提供稳定身份；Session 单独承载可持续积累的有状态执行数据。

## 3. Agent Profile 保存什么

建议 Profile 只保存可声明、可复用的配置：

```ts
interface AgentProfileRevision {
  id: string
  profileId: string
  version: number
  name: string
  description?: string
  basePrompt: string
  runtimeId: AgentRuntimeId
  channelId?: string
  modelId?: string
  thinkingLevel?: AgentThinkingLevel
  permissionMode: AgentPermissionMode
  builtinToolPolicy: AgentToolPolicy
  skillBindings: AgentSkillBinding[]
  mcpBindings: AgentMcpBinding[]
  createdAt: number
}
```

Profile 不保存：

- 用户和模型的会话历史、thinking、tool call 或压缩摘要。
- Runtime 私有 session artifact。
- 当前工作区文件、Git 分支或未提交修改。
- 项目 `AGENTS.md`、项目记忆内容或动态系统提醒。
- API Key、MCP 密钥等明文凭据。
- 上下文用量、任务队列和运行状态。

因此，“把当前 Agent 会话保存为配置”实际是提取该会话的可复用设置，再让用户确认和编辑，而不是克隆整段会话。

## 4. 从当前会话保存

建议流程：

1. 用户在现有 Agent 会话中选择“保存为 Agent 配置”。
2. Axon 读取该会话的 Runtime、渠道、模型、思考等级和权限设置。
3. Axon 读取用户明确配置的基础提示词、工具选择、Skill 绑定和 MCP 绑定。
4. Axon 排除项目规则、记忆、历史消息、Runtime artifact 和工作区状态。
5. 用户在配置编辑器中补充名称、职责和说明后保存第一个 Revision。

当前 Axon 的 Agent 系统提示词是全局设置，并在运行时与项目指令、Skills、记忆和工具说明动态组合。该迭代需要把“用户基础提示词”提升为可被 Profile 持有的配置项；保存时不能复制最终拼装后的完整系统提示词。

## 5. Skills 与 MCP 的解析

### Skills

Profile 保存 Skill 的逻辑名称和可选来源约束，不复制 Skill 正文。创建执行会话时，仍按 Axon 现有的项目、管理和用户目录优先级解析；缺失、被遮蔽或版本不满足时给出诊断。

这样同一个 Profile 可以在不同项目中使用，同时仍允许项目级 Skill 覆盖全局定义。

### MCP

当前 MCP 的“项目级”是逻辑归属，不表示配置文件位于用户选择的工作区目录。它按 `projectId` 保存在 Axon 应用私有目录：开发版为 `~/.axon-dev/agent-projects/<project-slug>/mcp.json`，正式版为 `~/.axon/agent-projects/<project-slug>/mcp.json`；文件内容是加密 envelope。同一 Axon 项目下的 Agent 会话共享这份配置，Axon 不从工作区目录扫描 MCP 配置。

按当前实现，直接把会话保存为 Profile 时，只能记录“该会话曾使用项目中的哪些 MCP”这一逻辑需求；离开原项目后不能保证找到相同配置。要让 Profile 真正保留并跨项目复用 MCP，后续应把 MCP 拆成以下三层：

1. **MCP Definition**：Axon 全局可复用的非密钥定义，例如 transport、命令或 URL 模板、参数和超时；使用稳定 ID 和版本。实际工具仍在连接后通过 `tools/list` 获取。
2. **MCP Connection**：本机的具体连接，给 Definition 补充加密凭据、账号、机器路径和环境变量；仍不进入可导出的 Profile。
3. **Agent MCP Binding**：Profile 声明能力需求，Instance 选择具体 Connection 满足需求。

建议的数据关系是：

```ts
interface AgentMcpRequirement {
  key: string
  definitionId: string
  definitionRevisionId: string
  required: boolean
  allowedTools?: string[]
}

interface AgentInstanceMcpBinding {
  requirementKey: string
  connectionId: string
}
```

Profile Revision 保存 `AgentMcpRequirement[]`，回答“这个角色需要什么能力”；Instance 保存 `AgentInstanceMcpBinding[]`，回答“这个实例在本机使用哪个账号和连接”。例如，“GitHub 代码审查”Profile 要求 GitHub MCP，而工作实例和个人实例分别绑定公司账号与个人账号。

运行时按以下顺序解析：

```text
Profile 的 MCP 能力需求
  → Instance 的具体连接绑定
  → 当前 Team 或独立使用场景的工具权限收窄
  → 连接测试与 tools/list
  → 固化进 Run Snapshot
```

必需绑定缺失或连接失败时禁止启动；可选绑定缺失时显示降级诊断。Profile 只允许声明工具上限，Instance 和当前使用场景可以继续禁用或收窄，不能静默扩大权限。

“从当前会话保存为 Profile”时，保存向导应列出当前项目 MCP，让用户选择哪些能力写入 Profile。若对应 Server 还没有全局 Definition，Axon 可以从项目配置提取非密钥部分创建 Definition；当前凭据只用于给新 Instance 建立默认 Connection，绝不复制进 Profile。

因此，长期方案不是让 Profile 或 Instance 单独拥有完整 MCP：Profile 持有可复用的能力声明，Instance 持有环境相关的连接绑定。Team-local Agent 首期使用按 `teamId/memberId` 独立保存的加密 MCP 配置，不引用桌面对话项目的 MCP；之后再接入全局 Definition/Connection 注册表。

## 6. Agent Instance

Instance 是一个稳定的逻辑 Agent，不直接等同于某条会话历史。建议至少保存：

```ts
interface AgentInstance {
  id: string
  name: string
  profileId: string
  profileRevisionId: string
  state: "idle" | "running" | "disabled"
  owner?:
    | { type: "standalone" }
    | { type: "team"; teamId: string; memberId: string }
  createdAt: number
  updatedAt: number
}
```

初版建议一个 Instance 同一时间只能属于一个使用场景：独立使用，或作为某个 Team 的成员。若另一个 Team 需要同样能力，应从同一 Profile 再创建一个 Instance。这样可以避免两个 Team 同时向同一 Inbox 投递、共享会话状态或争用工作区。

Profile 是复用单位，Instance 是隔离单位。

## 7. 实际运行时如何合成配置

创建 Instance 的持久 Session，或为下一项任务构造新一轮上下文时，按以下顺序合成：

```text
Axon 安全默认值
  → Instance 固定的 Profile Revision
  → 当前使用场景的受控覆盖（例如 Team 职责说明）
  → 项目 AGENTS.md、Skills、MCP、记忆等动态上下文
  → Runtime/模型能力收窄
  → 不可变的 Run Snapshot
```

场景覆盖只能在明确边界内变化。尤其是 Team 的工具配置建议只能收窄 Profile 已允许的工具，不能静默扩大权限。最终运行快照记录所有解析结果和诊断，保证恢复时不会因 Profile 后续编辑而漂移。

## 8. 与 Agent Team 的关系

Team 支持两类成员来源：只属于当前 Team 的本地 Agent，以及由 Profile 创建的已有 Instance。Team 不直接引用可变 Profile：

```text
Team-local Agent 配置 ───────────────┐
                                    ├─▶ TeamMemberRunSnapshot
Profile Revision → Agent Instance ──┘        │
                                             ▼
                         成员已有 Session 和指定工作目录
```

TeamDefinition 保存成员来源、团队职责覆盖、工作目录绑定和通信关系；TeamRunSnapshot 把两类来源都解析成相同的成员运行快照。Team 工作目录不引用桌面对话的 `AgentProject`；Instance 来源会固定其 Profile Revision，Team-local 来源会复制当前内联配置。任务运行期间修改 Profile、Instance 或 TeamDefinition 都不影响当前任务。

因此 Agent Team 可以先实现 Team-local Agent，之后再接入 Profile/Instance，不需要推翻通信、Inbox、Executor 或运行快照。后续还可以提供“将 Team-local Agent 保存为 Profile”，把验证过的团队角色沉淀为可复用配置。

每个 Team 成员只有一个持久 Session，并直接绑定一个本地工作目录；多个 TeamTask 顺序复用工作目录和会话。Axon 不为任务自动创建 worktree。工作目录中的 `memory/` 也随成员隔离。未来允许共享工作区时，再采用一个写入成员、其他成员只读的权限模型。

## 9. 除 Team 外的用途

同一套 Profile/Instance 能力还可以支持：

- **一键创建独立 Agent**：用固定配置快速开始新任务，而不是每次重选模型、提示词和工具。
- **角色库**：维护代码审查、测试、产品分析、文档等可复用角色。
- **快捷入口**：全局快捷键可以绑定某个 Instance，再为每次输入创建或选择执行会话。
- **自动化和无头任务**：未来调度器从 Profile 创建隔离 Instance 执行定时或外部触发任务。
- **配置对比与评测**：从同一 Profile 创建多个 Instance，仅改变模型或提示词进行对照。
- **分享、导入和导出**：导出不含密钥的 Profile，并在目标设备重新绑定渠道、MCP 和 Skills。
- **版本回退**：实例显式切换到旧 Revision，复现此前行为。
- **受控子 Agent 模板**：未来允许主 Agent 从管理员批准的 Profile 创建子 Agent；初版仍保持现有固定子 Agent 角色。

## 10. 生命周期建议

- 编辑 Profile 会创建新 Revision，不原地修改旧 Revision。
- 新 Instance 默认使用最新 Revision。
- 已有 Instance 保持原 Revision，更新必须显式执行。
- 删除 Profile 时，如果仍有 Instance 引用，应禁止物理删除，可先归档。
- 删除 Instance 前必须确认其不在运行、不属于活动 Team，并明确处理其 Session。
- Session 的历史和 Runtime artifact 按现有会话持久化规则保存，不塞进 Profile 文件。

## 11. 建议的迭代拆分

1. 定义 Profile、Revision、Instance 中立 DTO 与本地原子持久化。
2. 支持从当前 Agent 会话提取配置，并提供 Profile 创建、编辑、版本和归档界面。
3. 支持从 Profile 创建独立 Instance，并由 Instance 创建普通 Agent 会话。
4. 增加全局 MCP Definition/Connection、Profile 能力需求、Instance 连接绑定、缺失诊断和权限收窄。
5. Agent Team 在既有 Team-local Agent 来源旁接入 Instance 来源；两者统一解析为同一种成员运行快照。

## 12. 待确认问题

1. 产品界面最终使用“Agent 配置”“Agent 模板”还是“Agent 镜像”；内部建议固定使用 `AgentProfile`。
2. Instance 是否需要独立的长期记忆；若需要，应与现有项目记忆分开设计。
3. 一个 Profile 是否固定 Runtime，还是允许实例化时选择兼容 Runtime。
4. 全局 MCP Definition/Connection 注册表与现有项目级 MCP 的最终关系，以及项目配置是否改为引用全局 Connection。
5. Instance 已有独立 Session 后再加入 Team，是沿用原会话，还是建立一个新的 Team 专属持久会话。
6. Instance 从 Team 移除后是保留为空闲实例，还是随 Team 成员一起归档。
