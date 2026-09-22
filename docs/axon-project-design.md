# Axon 项目设计与迭代规划

> 工程约束见根目录 `../AGENTS.md`。本文档统一描述 Axon 的产品范围、总体架构、核心契约、主要子系统与迭代规划。

## 第一部分：项目设计

## 1. 产品目标

Axon 是本地优先的 Electron AI 桌面应用，同时提供两类会话：

- **Chat**：面向普通多轮对话，强调渠道兼容、附件、流式输出和轻量上下文管理。
- **Agent**：面向代码与工作区任务，强调工具调用、权限治理、上下文工程、项目规则、Skills、MCP、记忆和子 Agent。

项目的核心目标：

1. 用户数据、会话和配置优先保存在本地。
2. 编排层不依赖某个 Agent Runtime，可通过 adapter 接入不同实现。
3. Runtime 专属历史用于精确续跑，应用层中立历史用于展示、恢复和未来迁移。
4. 工具执行必须经过工作区、权限和生命周期边界。
5. 每个迭代结束时保持应用可运行、可恢复、可验证。

## 2. 总体架构

```text
Renderer（React + Jotai）
  ├─ Chat / Agent 会话 UI
  ├─ 项目树、文件树、设置与右侧面板
  └─ 只依赖 shared DTO、SDKMessage 与 IPC bridge
                 │
Preload Bridge（受控 IPC）
                 │
Electron Main
  ├─ Chat 编排
  ├─ Agent 编排
  ├─ 项目、渠道、设置与持久化服务
  ├─ 权限、Skills、MCP、记忆与协作服务
  └─ AgentProviderAdapter
         ├─ Pi Adapter
         └─ Zima Adapter
                 │
本地文件系统
  ├─ JSON / JSONL 应用数据
  ├─ Runtime 私有 artifact
  └─ 项目工作区与受管目录
```

### 分层边界

- `packages/shared`：中立类型、DTO、IPC 常量和消息协议。
- `packages/core`：Provider 文本生成协议和可复用核心逻辑。
- `apps/electron/src/main`：主进程编排、持久化、权限与桌面生命周期。
- `apps/electron/src/preload`：最小权限 IPC bridge。
- `apps/electron/src/renderer`：界面与可恢复状态投影。
- `adapters`：唯一允许理解 Runtime SDK、工具 shape 和 artifact 格式的区域。

## 3. 本地持久化

Axon 使用 JSON/JSONL 和原子写，不引入本地数据库。

主要数据包括：

- 全局设置、用户资料与快捷键绑定。
- 渠道和模型配置；密钥在主进程安全边界内处理。
- Chat 会话索引、消息 JSONL 和附件。
- Agent 项目索引、根会话索引、聚合状态与消息 JSONL。
- MCP、Skills 安装状态和项目记忆。
- 各 Runtime 独立维护的 session artifact。

应用层消息历史是 UI 的唯一展示源；Runtime artifact 是对应 Runtime 精确续跑的优先凭据。artifact 不可用时，只能从应用层中立历史进行明确标记的语义恢复。

## 4. IPC 契约

所有 IPC 按以下四层同步维护：

```text
shared 常量与 DTO
  → main handler/controller
  → preload bridge
  → renderer 调用
```

Renderer 不直接访问文件系统、密钥、Runtime SDK 或 Node 特权能力。主进程负责输入校验、所有权判断、并发控制和错误收束。

## 5. Chat 设计

Chat 与 Agent 保持独立执行链。Chat 负责：

- 多 Provider 流式文本生成协议。
- 多轮消息、Markdown、附件和标题生成。
- 草稿、会话列表和 JSONL 恢复。
- 上下文用量估算与自动摘要。
- 快捷浮窗和主窗口共享同一会话历史。

Chat 的上下文由“系统提示词 + 有效历史/摘要 + 当前输入”构成。摘要只改变后续请求的上下文选择，不删除应用层原始消息。

## 6. 可插拔 Agent Runtime

### 6.1 中立 Adapter 契约

编排层只依赖 `AgentProviderAdapter`：

```ts
interface AgentProviderAdapter {
  query(input: AgentQueryInput): AsyncIterable<AgentStreamPayload>
  abort(sessionId: string): void
  dispose(): void
}
```

`AgentQueryInput` 统一携带：

- 应用会话 ID、当前 prompt、模型和工作目录。
- Provider 连接信息、系统提示词和思考强度。
- 权限回调、中立自定义工具和停止信号。
- Runtime 配置目录、artifact 引用和语义恢复上下文。
- 项目指令、Skills、工具懒加载等能力输入。

Runtime 专属字段只能在 adapter 内解释；编排、渲染和持久化层不得 import Runtime SDK。

### 6.2 中立消息协议

`AgentStreamPayload` 分为：

- `sdk_message`：完整消息，可展示并按规则持久化。
- `sdk_delta`：流式增量，只用于实时渲染。
- 重试状态、草稿撤销等瞬时投影，不写入消息 JSONL。

主要 `SDKMessage` 类型：

- `user`：用户输入、合成续跑提示或工具结果。
- `assistant`：文本、thinking 和 tool use。
- `result`：一轮运行唯一终态。
- `system`：初始化、压缩边界、权限拒绝和恢复说明。
- `tool_progress`：工具执行中的瞬时进度。

完整消息必须带稳定标识；未知消息类型应安全透传，避免协议升级时静默丢失数据。

### 6.3 Runtime 职责

Runtime 负责：

- 模型请求与流式响应。
- 一轮内多次模型调用和工具循环。
- Runtime 自身支持的上下文压缩与模型错误重试。
- 私有 session artifact 的写入和恢复。

Axon 负责：

- 渠道、模型、项目和工作目录解析。
- 系统提示词、项目上下文和中立工具装配。
- 权限确认、事件广播、应用 JSONL 与 UI 投影。
- 将最终 Runtime 错误归一为稳定的中立终态。

编排层不得通过重新投递原始用户 prompt 实现模型错误重试，否则可能重复执行有副作用的工具。

## 7. Agent 上下文工程

每个应用轮次开始时重新构造系统上下文，主要包括：

1. 用户全局 Agent 提示词。
2. Axon 管理的 Git、工具和角色约束。
3. 项目根 `AGENTS.md`。
4. 可用 Skills 的轻量目录。
5. 当前权限/计划模式约束。
6. 项目记忆索引和陈旧提醒。

Runtime 在同一轮工具循环中复用这份基础上下文，并追加工具结果和后续消息。Pi 可在 Read 进入子目录后，于下一次模型请求前动态加入更深作用域的 `AGENTS.md`；其他 Runtime 若不具备等价钩子，必须显式声明降级行为。

长上下文通过 Runtime 压缩边界和摘要继续运行。压缩消息进入应用层历史，使 UI、重启恢复和未来迁移能够识别上下文基线变化。

## 8. 工具、权限与安全

工具分为三类：

- Runtime 内置编码工具，例如 Read、Write、Edit、Glob、Grep、Bash。
- Axon 宿主工具，例如 AskUserQuestion、Memory、Agent/Task 和 SkillRead。
- 项目 MCP 工具。

工具调用统一遵循：

```text
模型提出调用
  → 参数和工具存在性校验
  → 权限与工作区边界判断
  → 执行或请求用户确认
  → tool_result 返回 Runtime
  → 模型决定继续、修正或结束
```

权限行为为 `Allow | Ask | Deny`。拒绝和工具异常转换为错误工具结果，由模型处理；工具失败默认不由应用层自动重试。用户停止时，待处理授权、追问和工具回调必须及时收束。

## 9. 项目与工作区

- 左侧以项目为一级结构，项目下包含多个 Agent 会话。
- 一个项目当前绑定一个工作区；未选择本地目录时使用 Axon 管理目录。
- 同项目会话共享工作区、项目规则、Skills、MCP 与可选记忆。
- 文件树、监听、预览和 Diff 只在已授权工作区范围内工作。
- 子 Agent 继承父会话的项目与工作区边界。

## 10. Skills、MCP 与记忆

### Skills

Skills 支持项目、Axon 管理和用户全局目录，并按稳定优先级解决同名冲突。系统提示词只注入名称、描述和路径；正文及引用文件通过 `SkillRead` 渐进读取。读取必须防止绝对路径、路径穿越、符号链接逃逸、超限和二进制内容。

### MCP

MCP 是项目级配置，支持 stdio 和 Streamable HTTP。MCP Server 发现出的工具先转换成中立工具，再由当前 adapter 转为 Runtime shape。配置、连接测试、工具调用和超时均由主进程管理。

### 记忆

记忆只提供给 Agent，并由项目级开关控制。`MEMORY.md` 是索引，其他 Markdown 文件按需读取。每轮只比较记忆文件元信息；检测到外部修改后，通过系统提醒要求模型重新读取相关文件。

## 11. 协作子 Agent

主 Agent 通过统一 `Agent` 工具创建 `coder`、`explore` 或 `plan` 子 Agent：

- 前台模式等待结果并直接作为工具结果返回。
- 后台模式立即返回任务 ID；任务结束后自动触发主会话的一次合成续跑。
- 子 Agent 有独立会话历史和状态，根会话保存聚合关系。
- 委派固定一层，主 Agent 负责复核结果并对最终答复负责。

## 12. 桌面与界面

- 左侧项目/会话树和右侧多面板均可折叠与调整宽度。
- 中间区域保持最小宽度，承载 Chat 或 Agent 消息流。
- 工具调用、thinking、正文按真实事件顺序聚合在同一轮 Agent 回复中。
- 权限、追问和计划审批靠近输入区显示。
- 快捷键可绑定已有会话，唤起轻量输入/回复浮窗，并与主窗口共享历史。
- 托盘、单实例、关闭/退出语义和 macOS Dock 状态由主进程统一管理。

## 13. 错误处理与恢复

- Provider 临时错误由 Runtime 按自身策略重试；认证、模型、协议和明确地址配置错误直接收束。
- 工具异常转换为 `tool_result(is_error)`，不自动重放工具。
- Runtime/adapter 异常由 AgentService 转换成唯一失败 `result` 并落盘。
- 持久化失败优先保护数据一致性，不把未落盘终态伪装为成功。
- 停止后丢弃迟到 delta、工具进度和重试事件，只允许规范化后的唯一终态继续下游。
- 同一会话同时只允许一个活跃运行所有者；后台通知等待父会话空闲后再启动新一轮。

## 14. 验证原则

每个大迭代收尾统一验证：

- 正常路径和主要失败边界的自动化测试。
- 全仓 TypeScript 类型检查。
- Production build。
- 与改动相关的 Electron smoke。
- 涉及桌面交互时进行真实 GUI 验证。

## 第二部分：核心迭代计划

已完成迭代保留原编号，便于对应历史进度；明确不实施的内容统一移到文末“可扩展功能迭代”。

| 迭代 | 核心能力 | 状态 |
| --- | --- | --- |
| 1 | Electron 应用骨架、本地配置与持久化底座 | 已完成 |
| 2 | 渠道管理、Provider 流协议与 Chat MVP | 已完成 |
| 3 | Chat Markdown、附件、摘要、标题和草稿 | 已完成 |
| 5 | 可插拔 Agent Runtime、权限、停止与双轨会话 | 已完成 |
| 6 | 项目工作区、会话树、文件面板、用量与 Diff | 已完成 |
| 7 | 排队、追问、计划审批、错误处理与恢复 | 已完成 |
| 8 | AGENTS.md、项目指令与 Skills | 已完成 |
| 9 | 项目级 MCP 配置、连接与工具桥接 | 已完成 |
| 10 | Agent 项目记忆与变更提醒 | 已完成 |
| 12 | 前台/后台子 Agent、任务状态和会话聚合 | 已完成 |
| 14 | 托盘、单实例、关闭语义、Dock 与应用图标 | 已完成 |
| 17 | Zima Agent Runtime 接入 | 已完成 |
| 18 | 绑定已有会话的全局快捷唤起浮窗 | 核心功能完成，GUI 验收待完成 |
| 20 | 受能力协商约束的 ToolSearch 与工具懒加载 | 已完成 |
| 21 | 多级 Skills、统一 SkillRead 与 Axon 管理安装 | 已完成 |

### 迭代 1：应用骨架与本地底座

建立 Electron 主进程、preload、renderer、Bun monorepo、本地配置目录、原子写和基础设置能力。

### 迭代 2：渠道管理与 Chat MVP

支持常见文本生成协议、渠道/模型配置、流式多轮对话和可恢复 Chat JSONL。

### 迭代 3：Chat 完整体验

补齐 Markdown、附件、系统提示词、上下文摘要、自动标题和草稿持久化。

### 迭代 5：Agent Runtime MVP

建立中立 adapter 与消息协议，完成 Pi 接入、工具权限、停止、应用历史和 Runtime artifact 恢复。

### 迭代 6：Agent 工作区与会话

建立项目级唯一工作区、项目会话树、文件树/监听/预览、侧栏布局、上下文用量和只读 Diff。

### 迭代 7：Agent 交互与恢复

完成消息排队、必要追问、计划审批、停止、模型错误分类、会话恢复、外部运行标识和 Git 归因。

### 迭代 8：Skills 与项目指令

支持根及子目录 `AGENTS.md` 作用域、项目 Skills 发现、渐进读取和激活记录。

### 迭代 9：MCP

支持项目级 stdio/HTTP MCP 配置、连接测试、工具发现和中立工具注入。

### 迭代 10：记忆系统

支持 Agent 项目级记忆开关、Markdown 索引、按需读取/写入和外部修改提醒。

### 迭代 12：协作子 Agent

支持固定一层的角色化子 Agent、前后台执行、自动结果通知、聚合存储和任务详情展示。

### 迭代 14：桌面体验

完成托盘、单实例、主窗口关闭/退出语义、macOS Dock 状态和 Axon 图标。

### 迭代 17：Zima Runtime

保留 Pi 为默认 Runtime，新增 Zima 会话创建、流式事件、工具授权、停止、压缩摘要、独立 artifact 和恢复。

### 迭代 18：全局快捷唤起

支持多条“快捷键 → 已有 Chat/Agent 会话”绑定，通过轻量浮窗发送和接收消息，并与主窗口共享历史。核心功能已完成，仍需专属真实 GUI 端到端验收。

### 迭代 20：ToolSearch 与工具懒加载

仅在 Runtime 和模型协议明确支持时延迟提供 MCP 工具定义；其他情况保持完整工具加载，不改变权限与恢复边界。

### 迭代 21：多级 Skills 与管理安装

支持项目、Axon 管理和用户全局 Skills，统一通过 `SkillRead` 安全读取，并提供受控安装和设置界面。

## 横切约束

1. Runtime 专属代码只能进入对应 adapter。
2. 应用 JSONL 是唯一 UI 展示源，Runtime artifact 只用于对应 Runtime 恢复。
3. Delta 和瞬时重试状态不写入消息 JSONL。
4. 工具权限、工作区范围和停止信号必须覆盖所有工具来源。
5. 后台任务完成通知必须等待主会话空闲，不插入正在进行的模型循环。
6. 开发阶段格式变化直接采用新格式，不维护旧配置迁移。
7. 扩展功能默认不实施，也不提前创建无行为的空壳。

## 第三部分：可扩展功能迭代（暂不实现）

以下能力不属于当前开发范围，不保留具体实施步骤；只有用户明确恢复后，才拆分契约、阶段和测试计划。

- **Chat 工具与高级渠道**：Chat 工具执行、联网、生图、订阅渠道和代理能力。**暂不实现。**
- **内嵌终端与浏览器自动化**：PTY 终端、终端会话和受管浏览器工具。**暂不实现。**
- **Automation 与远程入口**：定时任务、无头 Agent 和远程机器人桥接。**暂不实现。**
- **Planning 产品系统**：计划、待办、日历、提醒及其 Agent 联动。**暂不实现。**
- **引导与平台工程**：首启引导、教程、平台专项、性能专项、CLI 和完整发布链。**暂不实现。**
- **会话 Runtime 切换**：Pi/Zima 双向切换、独立 artifact 和增量历史导入。**暂不实现。**
- **高级会话控制**：分叉、回退、运行中消息注入、软中断和同项目并发执行。**暂不实现。**
- **高级项目与文件交互**：会话跨项目移动、通用 @提及、文件移动和独立预览。**暂不实现。**
- **扩展记忆能力**：Chat 记忆、普通项目文件陈旧监听和自动记忆维护。**暂不实现。**
- **扩展桌面体验**：语音、悬浮状态窗、自动更新、通知声音、截图和 Runtime 进程隔离。**暂不实现。**
- **Skills 生态扩展**：远程/市场目录、账号同步和可视化 Skill 编辑。**暂不实现。**
