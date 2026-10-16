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

以下为迭代 24 已接入正式启动链的部署结构；业务统一在独立 app-server 子进程，生产异步退出、资源收束和源码桌面验收已完成；打包后验证按用户要求停止。

```text
Renderer（React + Jotai）
  ├─ Chat / Agent 会话 UI
  ├─ 项目树、文件树、设置与右侧面板
  └─ 只依赖 shared DTO、SDKMessage 与 IPC bridge
                 │
Preload Bridge（受控 IPC）
                 │
Electron Main（父进程）
  ├─ 窗口、托盘、Dock、快捷键与原生文件选择
  ├─ 可信窗口身份校验与协议客户端
  └─ app-server 子进程管理与 safeStorage 私有桥
                 │ 双向 stdio JSON-RPC
app-server（独立子进程）
  ├─ core：Chat / Agent 编排、项目、渠道、设置与持久化
  ├─ 权限、Skills、MCP、记忆与协作服务
  ├─ host-node：工具执行、Seatbelt 与 Shell 快照
  └─ runtime-adapters：AgentProviderAdapter 实现
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
- `packages/core`：Provider 文本生成协议、持久化、设置/渠道、会话/任务、Agent/Chat/协作编排、附件解析、项目/工作区、指令/Skills、MCP 和记忆等可复用后端业务。
- `packages/host-node`：Shell 解析/快照、Seatbelt 策略编译与能力探测、本地命令/文件执行及环境检查；不导入 Electron 或 Runtime SDK，接收显式快照目录和中立策略。
- `packages/runtime-adapters`：Pi/Zima 接入及私有协议、SDK、工具 shape/artifact 处理；只通过 shared 的中立端口接收宿主能力，不反向依赖桌面或 host-node 实现。
- `packages/app-server`：双向 stdio JSON-RPC、大消息分段、握手/身份、私有桥、Agent/Chat、附件、配置/渠道、项目/工作区/记忆、MCP、Skills、Task、能力查询及历史分页/完整汇聚；不导入 Electron、Runtime SDK 或宿主实现。
- `apps/app-server`：已实现的独立入口，接收可信路径/版本/受控解释器参数，先隔离日志再组合 core、runtime-adapters、host-node 与协议服务，不加载 Electron；桌面复用应用自带执行器启动，随包 SDK/MCP/解析资源与只读冷包后端已验证，打包后 GUI 按用户要求暂不验收。
- `apps/electron/src/main`：子进程管理、受控 IPC 转发、可信窗口映射及原生桌面生命周期；正式入口不再持有业务服务实例。
- `apps/electron/src/preload`：最小权限 IPC bridge。
- `apps/electron/src/renderer`：界面与可恢复状态投影。
- `adapters`：唯一允许理解 Runtime SDK、工具 shape 和 artifact 格式的区域。

### 后端复用与装配

`createBackend` 接收显式目录、版本、异步凭据端口、Runtime 路由及自有资源，组合实际业务服务。core 可由非 Electron 宿主进程内复用；它提供的是内部服务集合，不是可绕过 owner/审批的公开网络 API。模型运行通过客户端登记和 Agent/Chat 运行协调，不能直接调用 adapter.query 代替完整应用链。具体示例见 [README 的独立复用说明](../README.md#不启动桌面单独复用后端)。

桌面固定使用独立子进程：父端用应用自带 Electron Node 执行器启动 `dist/app-server.mjs`，不从 PATH 找用户 Node/Bun；独立开发入口可由 Bun 启动。后端只接受可信入口提供的绝对 `--data-dir`、`--home-dir`、`--application-version` 和可选 `--zima-python` / `--entry exec`，握手请求不能更改目录或入口类型。执行器标记 ELECTRON_RUN_AS_NODE 在导入业务前清除，避免进入工具环境。

### 应用协议、身份与私有桥

正式启动顺序为安装私有宿主桥/通知 → `axon/initialize` 校验版本并装配后端 → 登记逻辑客户端 → 读取设置及运行快照 → 绑定固定桌面 IPC、恢复快捷键并创建窗口。握手回应真实路径/版本及能力；重复初始化、错误协议或取消后迟到装配均拒绝，迟到资源纳入同一次清理。不回退进程内，不自动重投交付未知的用户请求。

`axon/client/register` 由服务端产生 clientId，kind 为 main/quick/external。业务参数使用 `{ clientId, input }`，只读无输入请求可仅传 clientId；来源/owner/合成轮及角色不能由业务 input 自报。页面重载/销毁先使身份失效，取消所属运行、交互和订阅，其他入口不受影响，不将结果改投当前窗口。

Agent 事件携带实际 `run: { sessionId, runId, runStartedAt }` 与可见父会话投影；子会话投影不能替换真实控制身份。停止/审批/追问复核原 owner、runId/generationId 和 requestId，过期或重复答复拒绝。审批/追问通过 `axon/client/agent/*` 反向 RPC 返回中立答复，不和普通流通知重复发送；缺少交互能力不能默认批准。

safeStorage 留在 Electron，仅在可信父子管道的 `axon/host/*` 私有桥开放异步加解密/渠道目标确认。能力声明必须对应实际端口，不提供 renderer 通用解密接口，不把凭据放进 argv/日志或工具环境。保持 secure:v1: 封装，无安全后端拒绝非空凭据；取消后迟到批准不能触发联网。core/MCP 等服务只消费中立异步端口。

主题/窗口/快捷键等业务设置由后端唯一写盘，原生效果由父端执行。快捷键变更预检会话，再 prepare→保存→commit，交付未知只重读确认、不自动重投。workspace/memory/Task 订阅用原 subscriptionId 精确取消；MCP 草稿测试保持独立连接，不关闭实际 Agent 工具租约。

### 传输与完整历史

双向换行 JSON-RPC 统一使用 `APP_SERVER_RPC_OPTIONS`：单行最多 1 MiB，完整逻辑消息最多 2 GiB。超长正文按 transferId/顺序/长度分段并恢复完整 UTF-8/JSON 后才处理；非法、超限、半条 EOF 或取消明确失败，不执行半份业务。输出有背压和积压上限，短控制可穿过大消息，通知保持顺序。DTO 用显式可序列化字段，不传函数、Signal 或 SDK 对象；不宣称零拷贝或无上限内存。

stdout 专用于协议，JavaScript 日志/直接 write 转成 stderr 脱敏诊断；这不构成任意 native 写文件描述符的隔离。传输取消只结束对应请求等待，不代替真实 runId 的业务停止，也不代表已接受操作回滚。

历史读取固定范围为 Chat/Agent/Task，不接受客户端指定文件路径或 Runtime artifact。一次打开 inode 形成只读快照，原子替换期间续页仍读同一版本；每页最多 100 条/约 1 MiB 正文，大单条保持完整并复用传输分段。续页绑定原 clientId/historyId 和随机游标，每次复核会话/任务存在；坏行只读隔离，不在分页期间重写源文件。现行 128 MiB 历史文件上限不变。

每客户端最多 4 个、全后端最多 32 个历史快照，空闲 2 分钟释放，EOF/注销/退出关闭句柄。`AppServerHistoryClient.read` 完整汇聚到末页才返回，取消或页中失败不交付半份，finally 有界关闭快照。桌面先订阅事件再读历史，按消息 ID 合并读取期间新增完整消息；delta 不持久化，不承诺重连逐 token 重放。

Agent 主窗/快捷浮窗聚焦重读时，renderer 先将当前活跃轮的流式 UUID 标记为草稿覆盖层，即使读取期间没有新 delta 也保留已显示的正文/思考/参数投影，不把全部旧缓存追加回历史。读取中撤回/重试/完整消息更新此标记；同 UUID 磁盘完整值优先于草稿，活跃轮或流式 UUID 已改变时不带入旧草稿。页面释放、旧读取版本和读取失败仍沿用原校验；不逐 token 写盘或恢复半截工具执行。

### 退出与故障边界

主窗口关闭留托盘不停止后端；真正退出先禁用新入口/快捷键并 flush 窗口补丁，再撤销页面/IPC/身份、释放父端交互并等待唯一 child。子端先 dispose 封口/取消，再 drain 等实际 Promise/finally、TCP/stdio/受管进程 close，最后 flush 输出；迟到初始化、已淘汰但仍有租约的连接和已释放引用的预热仍须等待。逐项失败不跳过其他资源，只汇总脱敏错误。

EOF、信号、协议/输出故障及未捕获异常共用 8 秒总期限，失败/超时非零退出。父端 10 秒 TERM、20 秒 KILL 只兜底本次自有 child；实际 close 不代表业务清理成功。异常退出失效旧交互/订阅，并向 UI 标记中断；新进程只恢复持久化状态，不自动重发或续跑。任意自行脱离受管组的后代不在清理保证内。

一个服务持有一个数据目录，不能多个独立宿主共写正式目录；独立复用不等于接管已有桌面后端。macOS 正式 app-server 在业务装配前取得该目录 `.axon-backend.lock` 的内核独占锁，保持到实际退出；取锁失败不读改写业务数据，父端收到稳定 `-32006` 与 `busy/unavailable` 原因，不自动重建或重投。其他平台桌面尚未提供该锁，进程内直接复用 core 的宿主仍须自行保证唯一写入者。没有 HTTP/WebSocket、TUI、daemon 或远程入口；exec 源码新任务按迭代 25 接入独立 child。Runtime 专属文件格式与 SDK 仍只由对应 adapter 理解，模型/工具恢复语义不因模块抽取改变。

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

Renderer 不直接访问文件系统、密钥、Runtime SDK 或 Node 特权能力。独立部署后，main handler 校验真实调用窗口并转发固定协议方法；app-server/core 复核请求和可信客户端归属，执行运行控制、业务校验与错误收束。正式主进程不装配业务写入服务，旧业务单例、registrar 与身份表已删除；原生 safeStorage 端口只消费 core 的纯 `credential-codec` 子入口，不加载业务工厂。

## 5. Chat 设计

Chat 与 Agent 保持独立执行链。Chat 负责：

- 多 Provider 流式文本生成协议。
- 多轮消息、Markdown、附件和标题生成。
- 草稿、会话列表和 JSONL 恢复。
- 上下文用量估算与自动摘要。
- 快捷浮窗和主窗口共享同一会话历史。

Chat 不读取用户配置的 Agent 系统提示词；正常请求使用应用层有效历史（包含刚落盘的当前输入）及附件内容。已有摘要时，仅把早期历史摘要放入请求的 `systemPrompt` 字段，保留未覆盖的历史消息。标题生成和摘要生成使用各自固定的内部提示词，不进入普通 Chat 历史。摘要只改变后续请求的上下文选择，不删除应用层原始消息。

## 6. 可插拔 Agent Runtime

### 6.1 中立 Adapter 契约

编排层只依赖 `AgentProviderAdapter`：

```ts
interface AgentProviderAdapter {
  query(input: AgentQueryInput): AsyncIterable<AgentStreamPayload>
  continueQuery?(input: AgentContinueQueryInput): AsyncIterable<AgentStreamPayload>
  abort(sessionId: string): void
  releaseSession?(sessionId: string): void
  dispose(): void
  drain(): Promise<void>
}
```

`dispose()` 同步禁止新工作并取消自有工作，不代表资源已经结束；`drain()` 在 dispose 后等待实际查询、初始化、传输与回调清理。后端通过中立自有资源清单统一等待，失败逐项收束后脱敏汇总；编排层不依赖具体 SDK 的停止方式。

`AgentQueryInput` 统一携带：

- 应用会话 ID、当前 prompt、模型和工作目录。
- Provider 连接信息、系统提示词和思考强度。
- 权限回调、中立自定义工具和停止信号。
- Runtime 配置目录、artifact 引用和语义恢复上下文。
- 项目指令、Skills、工具懒加载等能力输入。

Runtime 专属字段只能在 adapter 内解释；编排、渲染和持久化层不得 import Runtime SDK。

`AgentContinueQueryInput` 复用查询上下文但不包含 `prompt`，增加可信 `interruptionId` 和 `interruptionContext`。可选 `continueQuery` 只供宿主核验暂停后续做，不是普通发送的空字符串变体。core 已连接 Pi/Zima 的此入口；缺少 adapter 能力时在落盘前拒绝，不回退为隐藏用户输入。Zima 还须在握手中明确声明 continue 能力，不支持时报告更新 Runtime，而非猜测或重投。Pi SDK 保持外部依赖原样，不改其源码、安装目录或私有方法。

`releaseSession` 是可选的跨轮资源释放能力。会话删除落盘后，生产装配按 runtime 归属通知已经创建的 adapter；删除根会话同时通知子会话。不支持缓存的 adapter 无需实现，也不会为了删除启动新的 runtime。

### 6.2 中立消息协议

`AgentStreamPayload` 分为：

- `sdk_message`：完整消息，可展示并按规则持久化。
- `sdk_delta`：流式增量，只用于实时渲染；停止前已接纳的正文/思考可在收束时冻结为明确标记的部分 assistant 检查点，不逐片段落盘。
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
5. 当前沙箱与审批约束。
6. 项目记忆索引和陈旧提醒。
7. 最近真实轮明确停止时的中断提醒，从应用历史识别并置于动态尾部，不重投原任务或工具。

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

权限行为为 `Allow | Ask | Deny`。拒绝和工具异常转换为错误工具结果，由模型处理；普通工具失败不由应用层自动重试。结构化沙箱升级是例外：用户批准后只携带精确 Grant 重跑同一次调用，不重新投递整轮用户消息。用户停止时，待处理授权、追问和工具回调必须及时收束。

### macOS 工具沙箱目标

macOS 上的本地编码工具由 Axon 宿主执行层统一施加 Seatbelt 策略，审批决定是否临时扩大策略，不能用提示词、工作目录或命令字符串检查代替操作系统边界。默认策略为：

- 文件系统全盘只读，项目工作区和 Axon 为本轮分配的临时输出目录可写。
- 工作区内的 `.git`、`.axon` 和 `.agents` 等控制目录保持只读；需要修改时单独审批。
- Bash 及其全部子进程默认禁止网络；Provider 请求、远程 MCP 和 Electron 主进程网络不经过该命令沙箱。
- 工作区外写入或命令网络访问必须产生具体权限请求；路径明确的文件工具在执行前拦截，Bash 在基础沙箱确认越界后再申请，并提示首次尝试可能已有局部副作用。
- 沙箱不可用或策略无法落实时拒绝执行，不得静默退回无沙箱命令。

该默认读取范围与全盘只读策略一致，因此不会阻止命令扫描项目外文件，也不能保证消除 macOS TCC 隐私授权提示；它主要强制写入和命令网络边界。后续可增加工作区限定读取 profile，由用户主动选择更严格的边界。

Pi 的 Bash、Read、Write、Edit、Glob、Grep 等内置工具必须统一委托宿主执行或经过等价的路径执行器，不能只保护 Bash。Zima 当前仍在独立 Python runtime 内执行内置工具，只能使用既有审批机制；在协议支持宿主工具委托前，UI 和能力查询必须明确标记为“不支持 OS 沙箱”，不得宣称与 Pi 具有相同隔离能力。

现行执行边界：生产装配始终把宿主端口交给 Pi，端口报告实际 Seatbelt 探测结果。编排层与 Pi adapter 在沙箱不可用、模式缺失或策略不一致时拒绝本轮，禁止原生工具回退；编排层将 `sandbox_unavailable` 错误连同用户消息保存到应用 JSONL 并供 UI 展示。Shell 快照未就绪的登录执行回退仍处于 Seatbelt 内，不等于无沙箱回退。

每次授权回调必须携带可信 adapter 根据实际工具实例填写的 `toolExecution`，而不是从模型参数或名称推断：

- `sandbox`：真实受宿主保护的内置工具，模式必须与本轮策略一致；非禁止 Bash 和写工具先尝试沙箱，真实越界再申请精确 Grant。
- `runtime`：由 runtime 自行执行且没有宿主隔离保证的工具。Zima 内置读取工具可直接读取；Bash、Write、Edit 等副作用工具等待普通人工审批，授权不可用时拒绝。
- `host`：Axon 执行的自定义工具，默认普通审批。仅可信工具工厂可声明 `permissionMode: managed`，用于已有独立约束的追问、读取记忆、SkillRead、ToolSearch 和任务委派/查询；MemoryWrite、TaskStop、MCP 工具仍需审批。Zima 的宿主反向调用也必须先经过该判断。

普通会话白名单绑定工具执行来源、名称和输入，不跨 runtime/宿主同名工具复用。模型提供的同名字段不能改变执行证明。explore/plan 创建及每轮运行都固定只读；explore 的 Bash 只有在实际只读沙箱覆盖时开放，plan 不开放 Bash。两类角色均不能申请写入或网络升级，也不能复用既有 Grant 扩大边界。没有宿主沙箱的 runtime 只向这两类角色提供读工具，不以工具名称或提示词宣称 OS 隔离。

### Agent Shell 执行

Pi Bash 通过中立 Shell 请求向宿主提交原始命令、cwd、环境覆盖、超时和停止信号。宿主从系统账户解析默认 Shell，并依次检查同类型的账户路径、PATH 与系统路径；macOS 默认回退顺序为 zsh、bash、sh。内部直接执行程序的 argv 请求保持独立，不自动加入 Shell 包装。

Pi 与 Zima 的内置 Bash 提供可选 `workdir`，例如 `{"command":"go test ./...","workdir":"packages/server"}`。省略或空字符串默认项目工作区，相对路径从项目根解析；允许绝对路径、`..` 或符号链接选择项目外真实目录，拒绝不存在、非目录、非法类型和空字符。模型命令不自动拼接或删除 `cd`，执行目录通过子进程 cwd 设置；每次 Bash 独立执行，不保留上次 `cd/export`，也不改变会话工作区。

Agent 系统指引要求模型每次调用 Bash 显式填写本次目标目录，而不是机械填写项目根目录：根目录可填当前项目工作目录或 `.`，子目录填对应路径，项目外可填绝对目录；提供子目录命令与目录分开的示例。除非确有必要，否则不要使用 `cd`，不限定必要情况的具体种类。Pi Bash 工具及参数描述采用同样的生成要求；Zima 接收统一系统指引，工具 schema 仍由其 Runtime 提供。这里约束模型生成方式，不把 `workdir` 改为 Schema 必填，不拒绝或改写既有命令。

执行与权限分离：`workdir → cwd` 仅确定本次进程位置；`AgentSandboxPolicy.sandboxCwd` 则由项目管理器解析出的可信根固定，基础 `writableRoots`、保护目录和网络策略始终从该根及会话模式生成，不从模型参数或批准后的 `workdir` 重建。宿主允许项目外 cwd，但编译 profile 只消费可信 policy 和精确 Grant，不把 cwd 自动加入可写根；进入 `.git` 等目录也不会解除保护。本轮临时目录仍只开放宿主分配的根。源码直接使用新策略字段，不保留旧字段读取。

Pi adapter 扩展官方工具 schema 并按单次目录创建工具，复用 SDK 的超时、取消、输出及宿主委托；Zima 的 schema 与同步/异步 cwd 由其 Runtime 提供。审批前规范化实际目录，批准的更新参数在执行前重新校验；审批 UI 展示工作目录，普通始终允许白名单包含 workdir，不跨目录复用。Pi 项目外写入被基础沙箱拒绝后，明确绝对路径的 errno 可申请精确写 Grant；相对路径等无法可靠归因的拒绝仍返回工具错误，不猜目标或扩大为整个 cwd 的写权限。Zima 的目录参数校验不是 OS 沙箱，Bash 副作用仍使用普通人工审批与最小环境，文件工具的工作区限制不变。JSON-RPC 不增加工具字段，workdir 随原始工具消息保存。

宿主选择 Shell 后继续通过现有 Seatbelt 执行器启动命令，输出和错误返回 adapter。命令规则、审批和授权仍以原始工具输入为依据，Shell 选择不增加权限。

Pi 首次查询初始化应用会话的宿主环境，在加载 runtime 之前启动异步预热；同一 cwd 的后续轮次复用该环境，cwd 改变或 adapter 释放时清理引用。预热捕获函数、别名、选项和原生导出声明，经独立加载验证后原子发布到 `~/.axon/shell_snapshots/`（开发模式为 `~/.axon-dev/shell_snapshots/`）。目录权限 `0700`、文件权限 `0600`；捕获与验证不套工具沙箱，各自有 10 秒上限并清理进程组。初始化输出不进入日志或对话，失败只记录原因码，不阻断模型查询。

快照采用 `<sessionId>-<uuid>.sh` 命名，发布前使用同名 `.tmp`，属于可删除的执行缓存；导出声明可能含凭据，权限限制不等于内容脱敏。宿主初始化默认继承 Axon 进程环境，当前没有独立的环境变量过滤设置；工具初始环境再叠加 SDK 环境和显式覆盖。普通导出声明不做二次过滤，也不代表终端中的 alias/函数能跨 `exec` 保留。运行时读取快照采用 best-effort，不保证被外部改坏的脚本一定能继续执行；缓存不应由用户编辑。

工具只读取已经就绪的快照；捕获时固定真实 cwd，执行 cwd 按真实目录匹配，目录别名可复用、真实子目录及改指向的别名不复用；解释器路径和 `-lc` 也必须匹配。文件缺失或条件不符时保留原始 argv，不等待预热或临时重建。符合条件时改用非登录包装 Shell，在同一 Seatbelt 内静音加载快照、恢复显式环境覆盖及宿主临时目录，然后 `exec shell -c` 执行原始命令。SDK 的完整初始环境与显式覆盖分开传递，普通继承 PATH 不覆盖快照；Pi 工具目录在恢复后重新前置，本轮 runtime 状态即使缺失也重放删除。覆盖值从进程环境暂存，不写入包装 argv，内部恢复输出保持静音。原始 request 始终用于审批、授权与越界归因，直接程序 argv 入口不自动加载快照；执行中的 `export` 和 `cd` 不写回快照。

会话删除后通过 `releaseSession` 取消其预热并删除自有快照；根会话删除包含子会话，应用退出通过 adapter `dispose` 释放全部引用。初始化时异步合并遗留清理：只扫描缓存目录内可识别的 `<sessionId>-<uuid>.sh` / `.sh.tmp` 普通文件，读取应用主/子会话的 `updatedAt` 元数据，不读消息或快照正文。无会话归属的文件立即清理，归属会话超过三天不活跃的文件清理，正在预热或跨轮持有引用的会话始终排除。删除前再次检查引用，不跟随文件符号链接，不递归删除目录；清理异常只记录脱敏诊断，不阻断模型请求。

文件拒绝归因同时识别“绝对路径: Operation not permitted”和“operation not permitted: 绝对路径”，排除程序/行号前缀，再用既有策略判断精确升级权限。缺少明确 OS 拒绝证据的通用连接失败不推测为网络越界。

## 9. 项目与工作区

- 左侧以项目为一级结构，项目下包含多个 Agent 会话。
- 一个项目当前绑定一个工作区；未选择本地目录时使用 Axon 管理目录。
- 同项目会话共享工作区、项目规则、Skills、MCP 与可选记忆。
- 文件树、监听、预览和 Diff 只在已授权工作区范围内工作。
- 会话内的文件预览支持多个本地 Tab，以相对路径去重并缓存内容与切换时的阅读位置；关闭最后一个文件自动收起预览，工作区切换时清空，不持久化文件标签。
- 子 Agent 继承父会话的项目与工作区边界。

## 10. Skills、MCP 与记忆

### Skills

Skills 支持项目、Axon 管理和用户全局目录，并按稳定优先级解决同名冲突。系统提示词只注入名称、描述和路径；正文及引用文件通过 `SkillRead` 渐进读取。读取必须防止绝对路径、路径穿越、符号链接逃逸、超限和二进制内容。

实际优先级为项目 `.axon/skills` > 项目 `.agents/skills` > `$HOME/.axon/skills`（Axon 管理）> `$HOME/.agents/skills`（用户全局）。管理目录不随开发/正式模式切换。设置页只管理 Axon 登记的安装副本，不编辑项目或用户目录；安装来源 provider 当前为空，远程目录仍后置。

### MCP

MCP 是项目级配置，支持 stdio 和 Streamable HTTP。core 的 MCP 服务负责配置、连接测试、工具调用和超时，现行入口由独立后端装配。MCP Server 发现出的工具先转换成中立工具，再由当前 adapter 转为 Runtime shape；桌面 IPC 只绑定通道并校验真实调用来源。

### 记忆

记忆只提供给 Agent，并由项目级开关控制。core 的记忆服务约束所有读写；`MEMORY.md` 是索引，其他 Markdown 文件按需读取。每轮只扫描 memory/ 元信息并读取索引正文；已读主题的修改持续提醒到 MemoryRead 重读，成功读写只推进所属会话的 mtime/size 基线。正文不进入会话元数据；桌面变化订阅和逐轮陈旧检测是独立链路。

## 11. 协作子 Agent

主 Agent 通过统一 `Agent` 工具创建 `coder`、`explore` 或 `plan` 子 Agent：

- 前台模式等待结果并直接作为工具结果返回。
- 后台模式立即返回任务 ID；任务结束后自动触发主会话的一次合成续跑。
- 子 Agent 有独立会话历史和状态，根会话保存聚合关系。
- 委派固定一层，主 Agent 负责复核结果并对最终答复负责。

## 12. 桌面与界面

- 左侧项目/会话树和右侧多面板均可折叠与调整宽度。
- 中间区域预留最小 480px，承载 Chat 或 Agent 消息流；右侧栏默认 240px、最小 220px、最大 600px，实际扩展受窗口可用宽度约束。
- 工具调用、thinking、正文按真实事件顺序聚合在同一轮 Agent 回复中。
- 轮内相邻思考与工具调用归入连续活动组：进行中默认逐项展开，非空正文或真实终态关闭后默认收起为计数摘要；正文不移动。失败、待交互/仍运行的工具、追问与独立子任务入口保持可见，完整参数/结果按需展开。分组仅属于 renderer 投影，不改应用历史或 Runtime 上下文。
- 权限和追问靠近输入区显示。
- 快捷键可绑定已有会话，唤起轻量输入/回复浮窗，并与主窗口共享历史。
- 托盘、单实例、关闭/退出语义和 macOS Dock 状态由主进程统一管理。

现行视觉规则、组件分工和界面交互见 [Axon UI 设计与实现](ui-design.md)。

## 13. 错误处理与恢复

- 模型请求是否重试由 Runtime 自身策略决定；adapter 的最终错误分类及 `retryable` 仅用于中立终态/UI，不反向控制重试。Pi 使用内存 SettingsManager 的默认重试参数，不读取 Pi CLI 个人配置；当前 Axon 没有独立的 Agent 重试次数设置。
- 笼统 `Connection error` 归为网络错误，不能推断并发限制或 URL 配置错误；明确永久 DNS 证据可在终态归为配置错误，但不意味着 adapter 已禁止 runtime 重试该错误。
- 普通工具异常转换为 `tool_result(is_error)`，不自动重放；沙箱升级批准后的同次精确授权重跑不属于模型 API 重试。
- Runtime/adapter 异常由 AgentService 转换成唯一失败 `result` 并落盘。
- 持久化失败优先保护数据一致性，不把未落盘终态伪装为成功。
- 停止后丢弃迟到 delta、新 assistant、工具进度和重试事件；仅核验本轮已登记调用的实际工具回传及唯一终态。收束时保存已接纳的部分正文/思考，缺失工具结果标明未知，不推断是否执行或回滚副作用。
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
| 7 | 排队、追问、错误处理与恢复 | 已完成 |
| 8 | AGENTS.md、项目指令与 Skills | 已完成 |
| 9 | 项目级 MCP 配置、连接与工具桥接 | 已完成 |
| 10 | Agent 项目记忆与变更提醒 | 已完成 |
| 12 | 前台/后台子 Agent、任务状态和会话聚合 | 已完成 |
| 14 | 托盘、单实例、关闭语义、Dock 与应用图标 | 已完成 |
| 17 | Zima Agent Runtime 接入 | 已完成 |
| 18 | 绑定已有会话的全局快捷唤起浮窗 | 已完成 |
| 20 | 受能力协商约束的 ToolSearch 与工具懒加载 | 已完成 |
| 21 | 多级 Skills、统一 SkillRead 与 Axon 管理安装 | 已完成 |
| 22 | macOS Seatbelt 工具沙箱与细粒度审批 | 已完成 |
| 23 | Agent Shell 文件快照执行 | 已完成 |
| 24 | 后端模块化与独立 app-server | 已完成（源码范围；打包后 GUI/Keychain 不验收） |
| 25 | 通用非交互 Agent 入口 `axon exec` | 已完成；macOS/Pi 源码与独立 CLI、工作流/恢复/输出/集中验收 |
| 26 | Agent 暂停与继续 | 已完成；中断背景、后端精确控制、实际取消收束、部分历史及两桌面入口通过源码集中验收 |

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

完成消息排队、必要追问、停止、模型错误分类、会话恢复、外部运行标识和 Git 归因。

同一可信入口在普通根轮进行中提交新消息时默认排队，不另设排队按钮。等待消息只在后端内存队列中，主输入及展开的快捷浮窗上方投影为单行可取消胶囊；正常轮次收束后协调器按顺序出队，以新的 runId 作为下一轮用户消息交给 AgentService 并落盘，不依赖 UI 再次提交。观察入口不能插入原入口的队列，停止/暂停沿用清空等待队列语义。

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

支持多条“快捷键 → 已有 Chat/Agent 会话”绑定，通过轻量浮窗发送和接收消息，并与主窗口共享历史。失焦取消会清空未发送草稿并恢复紧凑态；发送后自动展开上下文，主窗口用来源图标标识快捷输入。紧凑态整个输入胶囊通过移动阈值手势兼顾输入点击与拖拽，展开态顶部标题栏使用原生窗口拖拽；用户调整后同一浮窗实例保留当前位置。专属真实 Electron GUI 冒烟覆盖绑定触发、浮窗交互和主窗口恢复。

### 迭代 20：ToolSearch 与工具懒加载

仅在 Runtime 和模型协议明确支持时延迟提供 MCP 工具定义；其他情况保持完整工具加载，不改变权限与恢复边界。

### 迭代 21：多级 Skills 与管理安装

支持项目、Axon 管理和用户全局 Skills，统一通过 `SkillRead` 安全读取，并提供受控安装和设置界面。

### 迭代 22：macOS 工具沙箱与审批

目标是在不沙箱化 Electron 主进程和模型通信的前提下，把 Pi 发起的本地文件与命令操作限制在宿主控制的 macOS Seatbelt 策略中，并让越界能力通过可解释、可收束的审批临时获得。

#### 阶段 1：中立策略与执行契约

- 在 shared 中定义 Runtime 无关的沙箱策略、命令/文件/网络权限请求、审批作用域和执行结果。
- 按实际分层拆成三项独立状态：沙箱模式 `readOnly | workspaceWrite` 决定操作系统能力边界；审批策略 `onRequest | never` 决定是否允许申请额外授权，桌面默认 `onRequest`，非交互策略见迭代 25；审批者字段保留 `user | autoReview`，当前只有人工审批可用，自动审查尚未实现。
- `AgentSandboxPolicy` 是沙箱模式结合可信项目工作区后生成的具体根目录与网络策略，不与审批策略混成同一个枚举。当前内置命令规则只返回 `allow | forbidden`；类型保留 `prompt`，但未实现用户自定义前缀规则。受宿主保护的命令未命中禁止规则时先进入基础沙箱，不能因可执行文件未知而请求审批；无宿主保护的命令仍需普通审批。
- 输入区展示权限预设而非底层字段：“请求批准”映射为 `workspaceWrite + onRequest + user`；“帮我批准”映射为 `workspaceWrite + onRequest + autoReview`；“完全访问权限”理论上对应 `dangerFullAccess + never`，但本迭代明确禁用。
- 会话创建、子 Agent 和恢复流程均从项目工作区生成基础策略；子 Agent 不得扩大父会话边界，explore/plan 固定收窄为只读。
- 当前不提供 `dangerFullAccess` 或关闭沙箱并跳过审批的完全自动组合；`never` 不关闭沙箱、不自动批准，见迭代 25。开发阶段直接采用新字段，不维护旧权限模式兼容。

#### 阶段 2：Seatbelt 执行层

- 宿主执行层提供唯一的本地工具执行服务，负责规范化真实路径、生成 Seatbelt profile、启动/停止进程、流式输出和清理临时资源。
- Bash 使用 argv 启动 `sandbox-exec -p`，由 Seatbelt 约束整棵子进程树；禁止把未转义命令拼入 profile。
- 默认文件只读，工作区和受控临时目录可写，命令网络关闭；`.git`、`.axon`、`.agents` 作为工作区内受保护只读目录。
- 策略生成或平台能力检测失败时 fail closed，并归一成可展示的 sandbox 错误。

#### 阶段 3：Pi 内置工具接入

- Pi adapter 仍负责 Runtime 工具 shape，但把 Bash 和所有文件工具的实际执行委托给中立宿主执行服务。
- Read/Write/Edit/Glob/Grep 与 Bash 使用相同的路径规范化、符号链接逃逸检查和临时授权集合。
- 运行时 SDK import、参数字段还原和工具结果转换继续只存在于 Pi adapter，不向编排层泄漏 Pi 类型。

#### 阶段 4：审批与规则

- 桌面默认审批策略为 `onRequest`：沙箱内操作直接执行，需要额外能力的操作弹出审批，明确禁止的操作直接拒绝；迭代 25 增加的 `never` 直接拒绝需审批操作，不复用交互授权，也不自动获得全访问。
- 命令规则的 `allow` 或“未匹配”只表示允许在当前沙箱策略内尝试执行，不表示绕过沙箱升级审批。当前规则不返回 `prompt`；文件路径预检或可归因的 Seatbelt 拒绝需要额外能力时，交给人工审批决定允许或拒绝。
- 路径明确的 Write/Edit 在执行前完成边界预检并生成结构化升级请求；Bash 无法完全静态判断时先在基础沙箱运行，确认属于沙箱拒绝后生成升级请求，不能把 `Operation not permitted` 当普通工具错误直接结束。批准后只重试同一条明确命令并携带对应授权，且必须向用户说明它可能已在沙箱内产生部分副作用。
- “帮我批准”入口禁用；独立自动审查 Agent 尚未实现，不把预留的 `autoReview` 字段描述成已经可用的审批能力。
- 审批请求区分命令执行、工作区外写入、受保护目录写入和命令网络访问，展示原因、目标路径或命令及申请的额外权限。
- 支持拒绝、本次允许和当前会话允许；会话授权只匹配规范化后的同类权限，不自动扩展为全盘写入或所有命令联网。
- 内置硬规则通过简单 argv 拆分及复杂 Shell 的有限识别，拒绝 `sudo`、`su`、`doas`、`osascript`、`launchctl` 等明确禁止命令；不提供通用命令前缀配置，也不承担完整 Shell 解析。其余命令先由 Seatbelt 约束实际资源访问，不依赖只读白名单。
- 审批超时、窗口关闭、停止运行或会话结束时必须撤销 pending 请求与临时授权。

#### 阶段 5：第一版网络授权

- 沙箱命令默认无网络；Bash 先在基础沙箱中执行，只有命令可静态确认为直接联网命令、且实际返回 OS 权限拒绝时才申请 `networkAccess`。复杂 Shell、解释器代码和无法归因的失败不会猜测或自动重跑。
- 批准后只重试原命令一次，并在审批说明中提示首次执行可能已产生部分本地副作用；再次失败按普通工具错误结束，不循环升级。
- 本次允许只扩展当前命令；当前会话允许只复用完全相同的规范化命令输入，不把网络权限授予会话中的任意后续命令。
- 第一版不实现域名/协议/端口代理与目的地聚合审批。后续增加代理时保持同一中立权限契约，只扩展网络目标字段和执行后端。

#### 阶段 6：界面与验证

- Agent 输入区展示“请求批准 / 帮我批准 / 完全访问权限”预设；尚未实现的自动审查和明确不支持的完全访问项必须禁用。Pi 显示 macOS 沙箱状态，Zima 明确显示“不支持 OS 沙箱，仅使用工具审批”。
- 权限卡片靠近输入区，展示沙箱内执行或申请升级的区别，并提供本次/本会话操作。
- 集中测试 profile 生成、真实路径和符号链接、受保护目录、网络拒绝、规则优先级、取消清理及 Pi 工具接入。
- 在真实 macOS Electron 应用中验证工作区写入、工作区外写入拒绝与审批、网络拒绝与审批、停止进程、子进程继承和重启后会话授权清空。

#### 本迭代明确不做

- Zima 内置工具的 OS 沙箱；待 Zima 协议支持把 Bash 和文件工具委托给 Axon 宿主后增量接入。
- 完全自动、关闭沙箱或危险全访问模式。
- 按域名、协议、端口控制的网络代理和持久化网络规则。
- Linux、Windows 沙箱以及对本地/远程 MCP Server 进程本身的系统级隔离。

### 迭代 23：Agent Shell 文件快照执行

目标是在 Pi 的 macOS 宿主命令链中复用会话初始化时的用户环境，避免每次工具调用重复加载登录配置；快照是宿主执行缓存，不进入消息 JSONL 或 Runtime artifact。

#### 阶段 1：Shell 请求与解析（已完成）

- adapter 只提交原始 Shell 请求，宿主负责用户 Shell 选择及登录/非登录 argv；直接程序执行入口保持独立。
- 从系统账户读取 Shell 类型，不由模型参数或 `SHELL` 环境变量决定解释器。确认候选路径是绝对可执行文件后再进入现有沙箱链。
- 保留流式输出、工具超时、停止和精确沙箱升级审批。

#### 阶段 2：会话环境初始化与文件快照（已完成）

- 在 Pi 首次查询创建宿主环境时异步预热，不等待首次 Bash 调用，也不阻塞 runtime 加载与模型请求。跨轮复用同一 cwd 的引用；cwd 改变或 adapter 释放时取消预热、清理自有文件。
- 初始化捕获和验证不套模型工具沙箱，只加载宿主解析出的用户启动配置；两步各自限制 10 秒，保留输出上限和进程组清理。
- 按 Shell 类型加载启动配置并捕获函数、别名、选项和导出变量；初始化噪声与捕获记录分离，完整保留多行及特殊字符，不使用按行拆分的环境解析。
- 临时写入、加载验证、原子发布到 `~/.axon/shell_snapshots/`（开发模式 `~/.axon-dev/shell_snapshots/`），目录 `0700`、文件 `0600`；生成失败只产生脱敏诊断，不中断正常会话，也不扩大模型工具权限。
- 生成链路不阻塞工具；快照由下述选择与执行流程消费，不进入 runtime 消息历史。

#### 阶段 3：快照选择与命令准备（已完成）

- 普通快照仅匹配初始化 cwd 与登录启动参数等适用条件；无快照、尚未准备好或条件不匹配时使用原始 argv，不任意为工具调用重建快照。
- 包装 Shell 在 Seatbelt 中 best-effort 加载快照；文件缺失等可恢复加载失败屏蔽诊断并继续原始命令，不承诺任意外部损坏脚本都可继续。加载后恢复显式环境覆盖及受控宿主变量，再使用 `exec shell -c` 执行原始命令。
- 当前初始环境来自进程继承与 SDK 环境，另携带显式覆盖，没有新增独立过滤配置。普通文件快照恢复不额外二次过滤导出声明，不能把初始继承描述成变量后续不能重新出现的安全边界。
- 中立 Shell 请求分别携带完整初始环境、显式覆盖和管理工具目录前缀；adapter 从 SDK 完整环境中分离真正的差异，避免旧 PATH 压过快照。Pi 专属本轮环境变量只在 adapter 内转换，缺失状态也必须清除，不能让快照复活旧值。
- 覆盖值在进程内暂存与恢复，不嵌入 argv；暂存/恢复和快照加载均静音，防止启动配置启用 xtrace 后泄漏内部值。宿主分配的 `TMPDIR/TMP/TEMP` 恢复后仍优先。
- 规则判断、审批展示、Grant 匹配和越界归因使用原始工具输入，不把内部包装串当作模型命令。

#### 阶段 4：生命周期与集中验收（已完成）

- 会话删除后释放对应引用，根会话同时释放子会话；应用退出释放全部引用。初始化时异步清理无归属或归属会话超过三天不活跃的遗留文件，排除预热及跨轮引用，不将快照作为永久配置复用。
- 集中验证预热、cwd/参数匹配、失败回退、环境覆盖、特殊字符、停止清理及沙箱审批一致性，并完成全仓检查与真实桌面启动验证。
- 新增 `bun run --cwd apps/electron test:agent:shell:smoke`：通过 Electron 自带 Node 执行器启动独立测试 child，使用隔离 HOME/ZDOTDIR 验证实际 Seatbelt、PATH 恢复、文件/网络精确授权、输出流、cwd 回退、超时/停止和释放清理；既有 `test:agent:smoke` 验证真实 UI、审批和 JSONL 重载。模型事件由夹具提供，本次不依赖外部模型 API。
- 2026-10-04 集中验收：全仓 90 个测试文件 572 项通过、2041 次断言；全仓类型检查、production build、两项真实 Electron 冒烟及 diff 格式检查通过。仅保留既有 renderer 大 chunk 提示。

#### 本迭代明确不做

- Zima 宿主 Shell 委托、执行器内存快照、常驻 Shell、PTY 和凭据代理。
- 普通 `exec` 路线不承诺 alias 与普通函数跨 Shell 保留，也不自动把某次命令的 `export` 或 `cd` 写回会话快照。

### 迭代 24：后端模块化与独立 app-server（源码范围已完成）

目标：将业务后端拆成可复用包，由 Electron 启动一个共享 app-server 子进程。生产链不保留进程内后端回退；TUI、exec、daemon、远程入口和多宿主共写目录继续后置。现行契约见本文“总体架构”，复用示例见 README。

1. **依赖显式化**：入口注入目录、版本、异步凭据与 Runtime。配置 DTO 位于 shared；安全后端不可用时拒绝非空凭据，不回退明文。
2. **核心业务抽取**：core 的 `createBackend` 统一组合存储、上下文、主/子 Agent、Chat 与项目能力；不导入 Electron 或 Runtime SDK。
3. **运行协调**：可信 clientId、实际 runId/generationId、队列、审批/追问、后台 Task 交付和订阅归 core。原入口失效不改投当前窗口；停止拒绝迟到结果，交付未知不自动重发。
4. **执行模块分离**：host-node 负责 Shell/Seatbelt/快照/文件执行，runtime-adapters 负责 Pi/Zima SDK、工具 shape、artifact 和模型循环。编排只依赖中立接口。
5. **独立服务与 stdio**：apps/app-server 组合实际后端；packages/app-server 维护固定双向 JSON-RPC、身份、私有桥、分段、取消和历史分页。stdout 专用于协议，未知错误脱敏，历史完整汇聚后才交付。
6. **Electron 桥接**：父端仅管理窗口、托盘/Dock、快捷键、picker、safeStorage 和协议客户端。正式入口与测试父入口均使用独立 child；旧业务单例/装配已删除，无兼容转发层。
7. **生命周期与源码验收**：先 dispose 封口/取消，再 drain 等实际 Promise、finally、TCP/进程 close，最后 flush 输出。连接登记迟到初始化和已释放后端，资源逐项失败不跳过其他清理。子端 8 秒总期限，父端 10 秒 TERM/20 秒 KILL 仅兜底自有 child；取消响应和进程消失不能替代终态落盘证明。

主窗口关闭留托盘不停止后端；真正退出先禁用入口/快捷键、flush 窗口补丁，再撤页面身份/IPC并等待后端。一个应用只有一个业务写入者，主窗口与快捷浮窗分别登记身份。应用 JSONL、Runtime artifact、压缩摘要、精确 Grant 和 Shell 快照语义不变，不迁移用户数据。桌面复用自带 Electron Node 执行器，不要求用户安装 Bun/Node。

2026-10-08 源码收尾：169 文件、1148 项/6697 次断言全部通过（86.21 秒）；7 workspace 类型检查、production build、diff 检查、六项源码 Electron 冒烟通过。真实生产桌面 `app.quit()` 同时收束实际 Chat/Pi 流、MCP 测试连接与原生确认；两条请求 TCP 实际关闭、队列未执行、唯一 stopped 终态和 Chat 局部文本落盘、窗口补丁保存通过。其他资源的实际 EOF/信号/异常及重启恢复由生产入口测试覆盖；不宣称所有资源排列组合都在 GUI 重演。

本次只验收源码运行，打包后验证停止，不作为完成门槛；保留已有构建配置/冷包后端证据，未完成的打包 GUI/Keychain 不标记通过。快捷键冒烟使用确定性注册器，不冒充物理系统按键；Zima 使用真实子进程上的离线协议，不代表远端 SDK/Python 分发。Zima 宿主沙箱/快照、受控 Python 分发等既有后置项未恢复。

Git/helper 退出测试现使用共享测试 helper 主动发送就绪通知，替代 Shell 写 PID 文件后的轮询；通知发出前已安装 TERM 处理，测试另验证 TERM 后仍存活。就绪仍限制三秒，管道 close 后有界等待真实 PID 的 ESRCH，EOF/SIGTERM、进程组、重启数据及订阅断言不变。该调整消除测试夹具的旧同步路径，不宣称已归因或修复原 Shell 偶发停顿的系统层原因。Zima accept 曾偶发超时仍未归因，保留 trace 诊断，不凭复跑通过宣称修复。

### 迭代 25：通用非交互 Agent 入口（已完成）

目标：提供无需 Electron 窗口、无需人工回答的 `axon exec`，用于命令行任务、脚本管道、CI 和外部应用调用。评测只是调用方之一；入口不内置题库、补丁格式、判卷或批量调度逻辑。源码与本机独立 CLI 的新任务/显式恢复/临时会话已接独立后端、真实 Pi/Seatbelt、完整工作流、正文/JSONL、文件/Schema 输出与取消退出，迭代集中验收已完成。

#### 架构与运行边界

```text
apps/exec：参数 / stdin、可信配置与凭据、输出及信号
   → packages/app-server：协议客户端
   → 独立 apps/app-server child：external 身份
   → core：执行策略、项目 / 会话、完整 Agent 运行协调
   → runtime-adapters / host-node：模型工具循环、沙箱与 Shell
```

- 新增 `apps/exec` 可执行入口，发布命令名为 `axon`，首个子命令为 `exec`；开发使用 Bun 源码命令，构建提供独立 CLI 产物，不要求打开或安装 Electron。源码和构建产物均复用独立 app-server，不创建第二套模型循环或直接调用 adapter.query。
- 默认 Runtime 为 Pi，首版验收平台为 macOS。解析接受中立 runtime ID，但 Zima 非交互执行、Linux/Windows 执行暂不开放；缺少实际沙箱能力时启动失败，不能静默换 Runtime 或裸执行。后续接入仍以 adapter 能力协商为边界，不在 CLI 导入 Runtime SDK。
- CLI 默认业务目录为 `$HOME/.axon-exec/`，与桌面正式/开发目录分离；配置、渠道引用、项目、应用 JSONL 和 Runtime artifact 均属于该后端。一个目录只允许一个活跃写入者，调用方不得与桌面或另一 exec 共写；`--data-dir` 不能作为绕过该约束的入口。不同目录不代表工作区文件或全盘读取已经隔离。
- macOS 独立服务以原生 `open(O_EXLOCK | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW)` 取得常驻零字节 `.axon-backend.lock` 的独占锁，所有正式服务入口共用，不靠 CLI 父进程或 PID 文件维护；目录别名归同一真实 inode。锁文件 `0600`，拒绝链接/非普通文件/非私有权限；不截断或删除文件，不提供抢锁/陈旧锁清理。后端资源 drain 和协议 flush 完成后才关闭 FD，异常退出由内核释放，exec 后代不继承句柄。该锁仅保护业务目录写入，不代表同项目文件并发控制；用户不应手动删除或替换锁文件。其他平台 CLI 拒绝启动，不回退无锁执行。
- 普通调用按真实 cwd 复用 CLI 项目、每次创建新会话；只有显式 resume 才继续旧上下文。项目工作区不随单次 Bash workdir 改变。第一版不接管正在运行的桌面后端、不自动导入桌面密钥/会话，不提供会话 Runtime 切换。
- 命令校验、配置解析、沙箱能力和凭据可用性预检尽量在任务创建/模型调用前完成；未送达与交付未知分开报告，未知交付不自动重发 prompt。

#### 参数契约

| 参数 | 本迭代计划语义 |
| --- | --- |
| `PROMPT` / `-` | 文本任务或从 stdin 读取任务；无位置参数且 stdin 为管道时读取 stdin，TTY 下缺少任务直接报错，不启动交互 UI。提供文本任务且另有管道输入时，把输入作为明确分隔的用户附加内容，保留顺序和换行 |
| `--cd, -C <path>` | 选择真实存在的项目工作区，默认调用目录；其他文件参数相对该目录解析，数据目录参数相对原调用目录解析，不隐式创建工作区 |
| `--channel <id>` | 选择 exec 配置的启用渠道；默认使用 CLI 配置指定渠道，缺失/禁用直接失败，不启动渠道选择窗口 |
| `--model, -m <id>` | 覆盖本次模型，必须属于所选渠道；缺省使用该渠道的 CLI 默认模型 |
| `--runtime <id>` | 新会话默认 pi；resume 不得更改原 Runtime，首版不支持的组合明确报错 |
| `--sandbox, -s <mode>` | `read-only` / `workspace-write`，默认只读；映射中立策略，命令网络仍默认关闭，受保护目录规则不变 |
| `--ask-for-approval, -a never` | exec 固定使用 never；其他值拒绝，不退回交互审批。桌面仍默认 onRequest |
| `--json` | stdout 输出带版本的有序 JSONL 事件，不混入日志、ANSI 或重复的纯文本最终回复 |
| `--output-last-message, -o <path>` | 原子保存本次工作流最终回复正文，不含 thinking/工具结果；普通模式仍在 stdout 输出正文，JSON 模式仍输出事件。保存失败为非零退出，不伪装运行成功 |
| `--output-schema <path>` | 读取 JSON Schema，要求最终回复为 JSON 并本地验证；先做 schema 校验。优先使用 adapter 明确支持的结构化输出，否则以中立输出要求加本地校验，不声称协议级保证；不合格明确失败，不自动重跑有副作用任务 |
| `--profile, -p <name>` | 选择 exec 配置中的命名运行预设；这是 CLI 配置组合，不是另建动态 Agent Profile 系统 |
| `--config, -c key=value` | 可重复的本次覆盖，仅允许有类型的已知字段；未知键、非法值与密钥字段报错，不持久修改全局配置，不透传 Runtime 私有参数 |
| `--ignore-user-config` | 不加载 CLI 默认配置/预设，仍允许显式指定可信配置和凭据；不跳过项目 AGENTS.md、沙箱或硬命令规则 |
| `--config-file <path>` | 显式加载可信 JSON 配置，路径相对原调用目录解析；与 ignore-user-config 同用时只读此文件，缺失或损坏报错 |
| `--data-dir <path>` | 指定独立 CLI 数据目录；真实路径检查和单写入者约束不变 |
| `--ephemeral` | 不保留此次项目/会话/Runtime 历史；临时 artifact 和私有数据仍可能落盘，结束后只清理本次自有目录，不删除工作区修改、用户输出文件或既有配置。不与 resume 同用 |
| `--timeout <seconds>` | 可选正整数总执行期限，默认未设置；覆盖初始化、模型/工具循环及自有子任务，达到期限停止并等待清理，不只取消 RPC 等待 |
| `--skip-git-repo-check` | 默认要求工作区位于 Git 仓库；允许显式用于其他目录，不扩大读写或网络权限 |
| `--color <mode>` | `auto` / `always` / `never`，仅人类可读进度/诊断使用；管道默认无 ANSI，JSONL 始终无颜色 |
| `--help, -h` / `--version, -V` | 不装配后端、不创建数据或请求模型即可输出帮助/版本 |
| `exec resume <sessionId> [PROMPT|-]` | 在选定数据目录中恢复原会话并发送新的用户任务；只恢复 CLI 根会话，拒绝子会话、缺失任务和不匹配工作区 |
| `exec resume --last [--all] [PROMPT|-]` | 默认选当前真实工作区最新 CLI 根会话；all 扩大选择范围，恢复仍使用原项目工作区，不把旧会话移入当前目录；无匹配直接报错，不弹选择器 |

运行配置采用 JSON：`$HOME/.axon-exec/config.json` 保存默认值、命名 profiles 与渠道定义，每个渠道可单独填写明文 `apiKey`；显式 config-file 替代默认配置文件，data-dir 不隐式改变配置路径。优先级为内置默认 → 所选 CLI 配置 → 选中 profile → `-c` → 专用参数。配置可覆盖渠道/模型、thinking 等级、Agent system prompt、沙箱、超时及 Skills/MCP/记忆/协作开关；参数外部名字与 shared 内部枚举由入口单点映射。显式 thinking 等级必须通过 adapter 对当前协议/模型的能力校验，不能接受后静默忽略。命名 profile 不能扩大平台能力或绕过安全规则。ignore-user-config 下没有显式文件却选择 profile 时直接报错，不偷偷重读默认文件。不从不可信项目自动加载运行预设。

现行 CLI 配置格式如下，渠道、模型与密钥均为占位值：

```json
{
  "defaults": {
    "channel": "my-channel",
    "runtime": "pi",
    "sandbox": "read-only",
    "systemPrompt": "",
    "skills": true,
    "mcp": true,
    "memory": false,
    "tasks": true
  },
  "profiles": {
    "coding": {
      "sandbox": "workspace-write",
      "timeout": 600,
      "tasks": false
    }
  },
  "channels": [
    {
      "id": "my-channel",
      "name": "命令行渠道",
      "provider": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "enabled": true,
      "apiKeyRequired": true,
      "apiKey": "替换为该渠道的实际密钥",
      "defaultModel": "my-model",
      "models": [{ "id": "my-model", "name": "模型", "enabled": true }]
    }
  ]
}
```

- 顶层仅接受 `defaults/profiles/channels`，缺省为空；文件、未选中 profile 和全部渠道均严格校验，未知字段、渠道之外的密钥字段和 Runtime 私有字段拒绝。配置/Schema 读取限 1 MiB 普通 UTF-8 文件，FIFO 不进入阻塞读取，坏文件不覆盖或静默忽略。
- 设置可用字段为 `channel/model/runtime/sandbox/thinking/systemPrompt/timeout/skills/mcp/memory/tasks`。runtime 默认 pi、sandbox 默认 read-only、提示词默认空白、Skills/MCP/Task 默认开启、记忆默认关闭；thinking 缺省交由会话默认，显式值需后端能力验证。timeout 缺省不限，显式为 1 到 2147483 的整数秒数；开关必须是 JSON boolean，不接受字符串布尔值。
- 渠道必须提供 `id/provider/models`（至少一个模型）；name 缺省 id、enabled/apiKeyRequired 缺省 true，baseUrl 缺省官方 Provider 地址，custom/兼容地址需显式填写。model 必须提供 id，name 缺省 id、enabled 缺省 true；选择模型由设置 model 或渠道 defaultModel 指定，不静默选首项，禁用/不存在的渠道模型报错。URL 不接受用户名、密码、query 或 hash，并规范化主机/端口/尾斜杠。
- `-c` 使用相同设置字段，字符串可直接填写或 JSON 引号包裹，多行提示词用 JSON 字符串；例如 `-c tasks=false -c thinking=high`。它不修改文件，不支持动态添加渠道、API Key 或任意 SDK 参数。
- 预检解析真实工作区与数据目录祖先，拒绝桌面 `.axon/.axon-dev` 数据目录重叠和链接逃逸、系统根/用户目录/工作区祖先，以及位于工作区内的数据目录；锁和持久化数据不能成为模型可写的项目内容。独占写入者锁已由实际 macOS app-server 落实；CLI 父端在握手时检查真实 Pi 沙箱支持、所选模式及完整内置工具覆盖，能力不足收束 child 并拒绝，不将路径预检当作 OS 沙箱验证。

源码使用方式（渠道/模型为占位值，须先按上述格式配置）：

```bash
# 普通命令行任务；缺省为只读，stdout 只有最终正文。
bun run exec:dev exec -C /absolute/project --channel my-channel -m my-model "说明目录结构"

# 脚本管道；显式允许工作区修改，收集事件，期限覆盖整个执行。
bun run exec:dev exec -C /absolute/project -p coding --sandbox workspace-write \
  --json --timeout 600 - < /absolute/input/task.txt

# Schema 相对项目目录解析；目标父目录须已存在，正文通过校验后才保存。
bun run exec:dev exec -C /absolute/project --output-schema schema.json \
  -o /absolute/output/result.json "生成符合 Schema 的结果"

# 显式恢复，只发送新任务；会话 ID 可从 --json 的 workflow_started 获取。
bun run exec:dev exec resume SESSION_ID -C /absolute/project "检查刚才修改是否遗漏边界"
bun run exec:dev exec resume --last -C /absolute/project "继续下一项"
bun run exec:dev exec resume --last --all "检查最近会话的修改"
```

#### 非交互策略与凭据

- shared 已提供 `approvalPolicy: never` 和独立的 `userInputPolicy: ask | reject`，core 统一执行；会话/运行校验、存储、上下文说明、主/子 Agent 继承、RPC 和 adapter 消费同步。缺省仍为 `onRequest + ask`，桌面不增加新的选择项。不能靠拒绝反向 RPC 或隐藏权限卡片实现非交互。
- never 不授予新增权限：基础沙箱内的允许操作执行，需要普通审批或沙箱升级时立即返回中立拒绝，不登记 pending、不生成新 Grant、不触发授权后重跑；硬禁止和只读子角色始终优先。非交互新运行不继承桌面人工会话白名单/Grant。
- AskUserQuestion 在此入口直接返回“非交互入口无法提供用户回答”的错误工具结果；不伪造回答、不挂起。模型可以在既定范围内调整方案或说明阻塞，一次拒绝不直接等于整轮失败。
- 默认命令网络关闭。CLI 不支持自动批准所有 MCP/记忆写入或无沙箱工具；需要普通批准的调用返回拒绝。Skills、记忆、MCP 和协作仍由 core 的开关/角色约束装配，disabled 不初始化相关连接、工具或注入相关目录。远程 MCP 的连接、模型网络与本地命令沙箱不能混为同一个授权。
- CLI 只使用最终选中渠道的 `apiKey`，不读取 `AXON_API_KEY` 或桌面密钥；父入口清除残留同名环境变量，后端、工具、MCP 和 Shell 预热不自动继承它。密钥仅留在父端配置，经私有管道按确切渠道 ID/Provider/Base URL 交付；启动渠道 DTO、argv、系统提示词和自动保存的历史不携带密钥，不把全部配置密钥广播给后端。新任务在启动前检查；resume 先校验原渠道再取其密钥，不使用默认渠道的密钥。`apiKey` 必须是最多 16384 字符、无控制字符的字符串，缺省/空字符串表示未提供；apiKeyRequired 为 true 时缺密钥失败，false 时可不填。
- CLI 配置中的密钥是用户主动保存的明文，文件应设为 `0600`、放在工作区之外且不提交仓库；不假称加密或对同一用户/有读取权限的模型工具不可见。当前沙箱允许全盘读取，主动读取此配置仍可能暴露密钥；用户 Shell 脚本自行导出密钥也不受继承清理保证。桌面 safeStorage 格式不变，CLI 不复用其密文；OS 安全存储/外部密钥管理器仍后置。渠道目标只匹配用户选中配置的确切目标，不为任意 URL 自动确认；重定向等超出授权仍拒绝。

现行可信装配链已接通：启动 argv 的 `--entry exec` 才启用私有 `axon/host/exec/bootstrap`，读取无密钥渠道与瞬时 Agent 配置；普通业务握手不能更换入口类型，默认桌面不读取该端口。配置严格校验并复制，缺桥/坏配置在创建业务目录前失败。`createBackend` 按稳定渠道 ID 原子保存无凭据定义，运行时 `ChannelManager.resolve` 经中立 `resolveRuntimeCredential` 端口调用私有 `axon/host/runtime-credential/resolve`；父端核对 ID、Provider 与规范化后的确切 Base URL，入口还须限制当前选定渠道。凭据解析失败不尝试其他来源，异常只返回稳定错误；`hasApiKey` 仍表示持久凭据存在，不表示瞬时运行凭据。

`BackendAgentConfiguration` 仅来自可信装配，复制为本次运行上限，不写入 settings.json。Skills 关闭不执行项目/内置/用户目录发现，也不注册 SkillRead；MCP 关闭不调用连接/取工具链；记忆关闭不读取索引/检查文件基线/注入工具，项目原开关也不能越过此上限；协作关闭不注册 Agent/Task 工具、提示词或后台交付回调。AGENTS.md 与沙箱/权限规则不受这些开关影响。空白瞬时提示词显式覆盖持久用户提示词，受管指引仍保留；`generateTitle=false` 禁止额外标题模型请求。默认桌面装配不传该配置，行为保持不变。

CLI 的 `ExecBackendProcess` 提供可信父端连接：源码模式以当前 Bun 执行器直接 argv 启动独立服务，独立构建按 CLI 自身真实位置选配套 `backend/axon-app-server`；不经 Shell、不搜索 PATH、不回退源码。先登记私有桥，再握手并核对版本/目录/真实沙箱，最后登记唯一 external 身份。启动时剔除残留 AXON_API_KEY 和无关的 Zima 解释器环境，只允许所选确切渠道使用其配置密钥，安全存储与人工目标确认明确不可用。固定业务请求自动附加 owner，连接失败立刻失效 owner，不重建或重发。停止先封口，再 EOF；10 秒 TERM、20 秒 KILL 仅作用于自有 child，等待实际 close，非零/信号/强制退出视为清理失败；异常后代持有管道时最终关闭自有管道解除阻塞，不宣称已回收任意后代。源码和构建使用同一命令/工作流编排。

独立构建命令为 `bun run exec:build [--outdir <产物目录>]`，默认 `apps/exec/dist`，只构建本机 macOS arm64/x64；本机证据为 arm64，未声称 x64 实测。CLI `axon` 内嵌 Bun 与 Schema Worker，构建分支使用内嵌 `.js` 线程入口、源码仍为 `.ts`，不依赖工作区中的线程文件。独立后端启动器同样内嵌 Bun，固定加载自身相邻的 `app-server.mjs`，外部 SDK/解析器/MCP 从清单遍历复制完整包和资源，保留每包版本依赖的相对链接与循环关系，不把所有版本扁平化到同一包、不回指源码 node_modules。原 Axon workspace 代码进入业务 bundle，CLI 不导入 Runtime SDK，也不依赖 Electron。须移动完整产物目录，只有两只可执行文件不能完整运行；外部模型、MCP 及系统工具仍按用户可信配置提供，并非全部工具已封装在二进制内。

构建父入口禁自动 dotenv/bunfig/tsconfig/package.json 加载；后端启动器只开启 package.json 读取以解析配套包 exports，dotenv/bunfig/tsconfig 仍禁用，不执行 npm scripts。不把它等同于禁用 Shell 快照中的用户启动配置。构建先在随机自有目录完成并等所有编译 Promise，依赖缺失或任一构建失败不发布；标记清单完成才替换旧自有产物，陌生目录/文件/链接/损坏清单或根/用户目录/源码祖先拒绝覆盖。发布失败尝试恢复旧构建，恢复失败保留暂存旧产物，不删不确定内容；不应在运行中的产物目录上重建。运行资源缺失明确失败、不猜 PATH 或改投源码；无独立 npm SDK、其他平台、签名/公证/发布安装包。

`prepareExecSession` 通过固定业务 RPC 完成执行前准备：显式 thinking 先用中立 `{runtimeId, channelId, modelId}` 查询能力，后端从已启用渠道解析真实 Provider，再调用 adapter；未知或不支持的等级在项目/会话写入前失败。原有桌面按 sessionId 查询保持不变；能力查询不取模型凭据、不发生成请求，取消响应后 drain 仍等待实际查询结束。按真实 cwd 复用本地项目，多个匹配稳定选最早者，无匹配才创建；每次任务新建 `never + reject` 根会话，不隐式续跑。显式启用记忆时开启所选项目开关；关闭时只用瞬时装配上限，不覆盖既有项目开关或删除文件。准备阶段校验返回目录/身份/策略，异常不重投或删除交付未知的记录。原始用户正文从准备模块经 core 队列、AgentService 到模型输入及应用 JSONL 保留首尾空白和换行；只用 trim 判定空白任务无效，并拒绝空字符与超长输入。main 准备完成后绑定事件范围，再执行工作流，不调用普通 send。

源码 `exec:dev` 和默认后端 child 使用明确的 `bun run --no-env-file --config=<Axon可信空配置>` 参数，不自动加载任务工作区 dotenv/bunfig preload；移除指向裸 `.ts` 的源码 bin，以免绕过此启动边界。调用方自身已经加载的运行器 preload/环境仍是可信宿主责任，不承诺撤销其副作用；不改变用户 Shell 快照初始化路线。

#### 输出、恢复与完成语义

- `ExecRunStream` 已在握手前安装固定事件/反向请求处理，send 前绑定原 external 与根会话；核对真实主/子 runId、sessionId、起始时间、source 和开始/收束顺序。公开 `ExecAgentEvent`（shared）带 `version:1/executionId/sequence/timestamp/type:agent_event/run/visibleSessionId/event`，不输出 clientId、私有管道包或 SDK 对象。delta、工具、思考、压缩、重试、拒绝等保持原始中立顺序；最终候选仅取主轮完整 assistant 的 text，按 uuid 更新并响应丢弃，不混入子回复。最新主轮须同时有 result 与 run_finished，且成功、未停止、终态已落盘，才能形成成功的本轮快照；存储失败可无 result，但不能判成功。新主轮开始不沿用旧回复，不能靠此快照宣布整个工作流完成。
- `ExecEvent` 包含共享身份/顺序的 `workflow_started {workflow}` 与 `workflow_finished {result}`；握手前订阅固定工作流通知，开始先于模型轮次，结束必须匹配同一根/workflowId/开始时间和最新主 run/completion，所有已看到子轮均实际结束。首次用户落盘失败可仅有明确 persisted=false 的完成包，不假造开始事件。工作流/终态解析仅投影中立字段，不把额外私有属性输出；未知事件类型、坏字段、错身份、提前/重复终态及结束后的迟到模型事件封口失败。执行 RPC 返回后 main 调用 `ExecRunStream.confirm(value)`，与通知终态完整核对一次；通知缺失或应答不一致不能输出成功正文，不重发任务。失败/取消返回空最终正文，JSONL 中的局部事件仍保留。
- `ExecOutputStream` 提供 stdout 单写入者：JSON 模式一行一事件，不另写纯文本；普通模式不写流事件，仅在确认工作流完成且 child 正常退出后写最终正文。一个在途 write，等待真实回调再发下一行；队列包含在途数据默认限 64 MiB，超限、断管、提前关闭即时失败并唤醒 flush，不丢事件后返回成功。事件收集默认最多保留 4096 个轮次及 16 MiB 候选正文，超限明确失败；新主轮释放旧正文候选。失败清理保留错误监听直到实际 close，避免迟到 error 无人接收；模块 dispose 不关闭调用方 stdout，但命令入口取消正在背压的自有 stdout 时会销毁它，避免超时后仍挂起。
- CLI 层另提供 `exec_started` 和清理/正文交付后的唯一 `exec_finished {completion:{exitCode,cleanup,error?}}`，cleanup 为 completed/failed/not_started。后端业务完成不代替 CLI 成功；0 要求确认正常工作流及实际清理成功。协议失败只可报告失败终态；帮助/版本不登记执行。输出坏管可能无法交付 terminal，操作系统退出码仍是最终依据。总期限从命令入口开始计时，配置解析后扣除已用时间，在 stdin、Git 预检、初始化、工作流及输出期间生效。SIGINT/SIGTERM 和期限取消原请求，封口/关闭自有后端并等待实际 close，保留首个故障原因；已有取消原因同时遇到清理故障时另在事件/诊断标明。正常背压等待，取消后的 stdout 和诊断交付最多留一秒，不自动重跑。
- `--output-schema` 已接通 Ajv/ajv-formats 本地编译与完整最终 JSON 校验：省略 `$schema` 使用 draft-07，支持 2019-09/2020-12，标准 formats 与文件内引用；未知关键字、无法解析的引用、外部引用及 `$async` 拒绝。输入限 1 MiB/100 层；编译/校验在自有 Worker，各限五秒且纳入总期限/信号，取消仍等实际线程退出，不宣称 OS 级内存沙箱。坏 Schema 在后端创建前退出 2。当前 adapter 契约未声明结构化输出能力，使用可信私有装配 `finalOutputInstruction` 约束主 Agent 的最终回复；不修改用户任务/永久设置，不约束子 Agent，不发送未经支持声明的 `response_format`。最终正文必须整体为合格 JSON，不提取围栏、不强制转换/补默认值/删除字段；不合格退出 3，线程故障退出 1，不重跑模型或工具，已保存应用/Runtime 历史不回滚。JSONL 可保留局部正文事件，但 CLI 终态必须失败。
- `--output-last-message/-o` 已接通 CLI 自有原子保存：预检不创建文件，父目录须已存在；拒绝链接/设备/FIFO/目录及业务目录、已加载配置和 Schema 输入目标。后端实际退出、最终 Schema 校验及线程回收完成后，以同目录随机 `0600` 临时文件完整写入/同步，再复核目录身份与目标类型并 rename 替换；失败只尝试清理自有临时文件，退出非零，不删旧输出或工作区。普通 stdout 仍输出相同最终正文；JSON 模式仍仅输出事件。保存先于 stdout/CLI 成功终态，若之后断管/取消，已完成文件仍保留，整体退出非零；不宣称跨文件、历史和管道的事务回滚。
- 普通模式 stderr 为脱敏进度/诊断，stdout 只输出最终正文。JSON 模式定义 Axon 自身的版本化事件外壳，包含执行 ID、真实 sessionId/runId、顺序号、时间和中立消息；SDK 私有对象、凭据与内部协议日志不外泄。流式正文、thinking、工具开始/结果、压缩、权限拒绝、用量和终态按已有中立事件映射，未知/不可用用量不编造为零。
- 区分单轮 run 终态与整个 exec 工作流终态：后台子任务及结果交付引起的合成续跑归同一执行范围。core 提供明确完成信号，待自有子任务、待交付结果、合成续跑全部收束才输出唯一执行终态与最终回复；不得凭第一段正文、第一次 run idle 或 adapter 提前返回判成功。超时/停止覆盖此范围，不停止其他客户端运行。
- core 的内部 `collaboration.waitForRootIdle(rootSessionId)` 在主发送链结束后循环等待此根实际子执行和后台交付 Promise；交付中的合成主轮还能派生后继，不能只等第一批。执行 finally 内先释放子 owner/启动排队后继，再结算根工作；completed/canceled 状态不替代真实执行结束，取消须先停止子树再等待。根等待不等待其他根，不用全局 drain 停掉整个后端；同根并发等待复用同一 Promise。交付/终态存储失败即使日志已捕获或先于等待发生，也由根等待报告安全错误；没有执行器的非终态记录明确失败。后台续跑接管失败抛回交付器。此原语本身不拥有执行身份或授权停止，完整工作流由下面的协调器负责。
- `AgentWorkflowCoordinator` 已经现有 `AgentRunCoordinator`/固定 RPC 接入：仅 external 可执行非交互根会话，初始发送前由后端生成 `{sessionId, workflowId, startedAt}`，内部发送及后台续跑携带同一可信令牌，不向用户输入、Runtime 或历史追加该字段。主轮空隙仍保留范围，普通 send/更新/删除被拒绝；旧普通会话的子执行/交付尚未实际结束时也拒绝接管。RPC 为 `AGENT_EXECUTE_WORKFLOW`（标准 AgentSendInput）、`AGENT_GET_WORKFLOW`（根 ID）及 `AGENT_CANCEL_WORKFLOW`（精确根/工作流 ID）；控制同时校验原客户端，旧令牌不能影响下一执行。取消请求等待或客户端注销会封口、停止主链/子树，仍等待真实 finally；失败清理不能跳过另一停止动作。桌面白名单不开放这些方法，原 send 的单轮语义不变。
- 工作流以唯一 `workflow_started/workflow_finished` 中立通知及 RPC 结果报告；result 包含 workflow、completed/failed/canceled、可选最新主 run/completion/error。完成需最后主轮 success、未停止且 persisted，同时根子执行/交付/续跑已经实际收束；模型/交付/存储错误为 failed。子原文存储失败独立传给根收束，任务仍保存失败结果供模型消费，但父模型正常回复不能掩盖历史故障；取消后的迟到存储失败仍报告，持久化错误优先于先发生的交付错误。取消期间存储或停止故障不能被 canceled 掩盖；正常取消不重新启动迟到通知。通知只给原客户端，已断开不改投他人。整个范围从登记到 finally 才释放，不能靠通知消费者/首轮快照决定退出。
- 正常退出必须确认终态/历史持久化（非 ephemeral）、输出文件写入和实际后端资源清理；后置标题请求也纳入资源收束，不强制为了标题再消耗非交互模型预算。stdout 背压、管道断开、父端信号、child 异常及交付未知明确处理，不能挂死或自动重放任务。
- ephemeral 已接源码链：输出目标预检及 Schema 编译完成后，在经路径隔离预检的 `--data-dir`（默认 `~/.axon-exec`）下用 mkdtemp 原子创建随机 `0700` 的 `.axon-ephemeral-*` 根。容器可创建但不删除；配置仍从原配置路径读取，后端只接收新根，不读取或改写既有项目/会话。完整业务 JSON/JSONL、Runtime artifact、私有快照和本根锁都在此根，运行中仍落盘；正常 drain/实际 child close 后、Schema 线程退出后，复核容器/根的真实路径及 inode，再删除此自有根，之后才写用户输出/CLI 成功终态。删除内部链接不跟随外部目标，不逐个删除正式锁文件以抢占服务。模型/工作流失败、格式不合格、SIGINT/SIGTERM 和总期限仍走此清理；不取消清理以抢先退出。工作区修改、输出、用户配置、既有业务目录不回滚；输出不可放在业务容器内。
- 后端未正常 drain/强制退出时不删除 ephemeral 根，以免异常后代仍持有文件；目录被替换或删除失败也保留、不猜路径重试，事件 cleanup 标为 failed、整体非零，已有取消码仍保留并补充清理诊断。父进程 SIGKILL/崩溃不能保证 finally；不自动扫描删除遗留根或承诺安全擦除。临时会话 ID 仅供本次事件关联，正式数据目录无此会话，不能恢复。
- 退出码约定：0 为工作流正常结束且输出/清理成功；1 为运行、持久化或清理故障；2 为输入/配置/能力预检错误；3 为最终输出 schema 不满足；124 为期限达到；130 为 SIGINT；143 为 SIGTERM。普通工具拒绝后模型正常结束可为 0，不能把 0 解释为业务目标已验证成功。清理失败在事件/诊断另记录，即使此前已收到正常模型回复也不得退出 0。
- resume 继续复用 Runtime artifact 优先、应用层语义恢复次之的现行链路，压缩摘要和原始 UI 历史不改写；恢复提示必须明确显示降级原因。无自动跨 Runtime 导入、分叉、回退或中断后无提示续跑。临时会话不能 resume。
- resume 已接源码链：可信 `--entry exec` 装配标记新根 `creationOrigin: exec`，由 core 解析项目并保存真实 `creationWorkspacePath` 到根 state.json；普通创建/更新输入不可自报、修改或清除，子会话不继承来源，全局目录仍只存摘要。不推断普通 external 消息是 CLI 根，不补写旧记录。CLI 经固定项目/会话 RPC 读取完整元数据，不直接读索引或 SDK 文件；ID 恢复须匹配调用工作区，last 选当前真实目录最新 CLI 根，all 只扩大候选范围，仍在原项目执行。原工作区改绑、目录失效、数据重叠、缺匹配/普通/子会话或不支持 Runtime 明确拒绝；选定原目录后复用 Git/数据隔离预检，不把调用目录是 Git 仓库当作原目录的证明。文件参数仍相对 `-C`/调用工作区解析，不随 all 改投另一目录。
- 恢复默认使用原渠道/模型，而非新任务 defaults 的选择；profile、`-c` 和专用参数可明确覆盖，须在当前可信配置中存在且启用，显式 thinking 仍查询能力。Runtime 归属不允许更改，本次沙箱默认仍为只读，never/reject 不放宽。恢复时凭据桥初始不授权目标，校验根/目录/配置/能力后才由父端 `authorizeChannel` 授权该可信 ID/Provider/规范化地址，不能从会话记录自报 URL，也不能把单次密钥改投第二渠道；缺密钥在元数据更新/新任务发送前拒绝。更新不改项目、来源及原 artifact 引用，只调用一次工作流并发送本次新用户正文。
- 精确 artifact 正常时保留对应 Runtime 压缩/工具历史，不从应用 JSONL 拼另一套 SDK 消息。artifact 或引用缺失时，core 提供最近成功压缩摘要（最多 30k 字符）及有界可见历史（总背景约 60k，每条最多 8k），不注入思考/result；adapter 创建新 artifact，发 `runtime_session_recovered` 中立事件，CLI stderr 也提示语义恢复。应用历史没有 Runtime 保留段标识，可能补入摘要覆盖过的近期原文，不能宣称还原精确压缩上下文。最近成功摘要优先于后续失败/noop 摘要；不删除应用原文或重放旧模型/工具请求。真实 SDK 压缩/独立后端重启回归已验证：应用原文和摘要均保留，原 artifact 的下一请求含摘要/保留段但不含已压缩原文；删除自有 artifact 后以真实应用摘要语义降级。

#### 实施阶段与验收

1. **策略契约（已完成）**：never、非交互追问及主/子继承的中立链路已接通；桌面默认和交互行为不变，不修改 Pi SDK。策略随元数据持久化；父在途轮次的限制不能因设置修改而放宽子任务；never 不登记交互等待、不消费旧白名单/Grant，reject 返回错误工具结果而不生成用户答案。真实 core/RPC 夹具与相关专项 9 文件 89 测试、625 次断言通过；七个 workspace 类型检查通过。不将专项验证等同于迭代集中验收。
2. **参数与配置（已完成）**：Bun workspace、帮助/版本、严格参数/stdin、真实 cwd/Git/路径隔离、JSON 配置/profile/覆盖、启用渠道模型与单次凭据处理；非法输入退出 2。参数专项 12/109 通过，功能装配/锁/能力校验随任务闭环接通。Schema 编译/最终验证已在阶段 5A 接通。
3. **最小任务闭环（已完成）**：可信私有配置/凭据与实际功能上限、真实目录独占、源码 child/沙箱握手、项目复用/新建 never-reject 根会话、原始正文、中立事件和有界 stdout 已接 main。CLI 不接管桌面数据、不隐式 resume、不启动第二套模型循环。
4. **完整工作流生命周期（已完成，2026-10-11）**：按根等待实际子执行/交付/派生续跑，持久化故障不吞掉；原客户端/根/workflowId 保留空隙归属。main 校验通知/执行应答/最后主轮，实际 child 正常退出后交付正文/CLI 唯一终态；期限、信号、EOF/输出故障先取消再实际收束，不重发。专项 9 文件 65 测试/535 次断言通过；真实 CLI → 独立 app-server → Pi SDK → Seatbelt 的本机模型夹具 4 测试/54 次断言通过，覆盖工具循环、正文/JSONL、同目录重复新任务、只读拒绝/显式工作区写入、401 无重复请求、SIGTERM/总期限取消与历史落盘。八 workspace 类型通过；不代表全仓/桌面/构建重测，没有外部模型请求。
5. **恢复和脚本输出（已完成，2026-10-11）**：5A 文件/Schema 输出、5B resume/last/all、5C ephemeral 清理、5D 独立 CLI 构建/配套后端/Worker 资源已接入。5A 证据为专项 30/350 与真实源码 6/88；5B 专项 168/905、真实源码 8/131；5C 专项 36/376、真实源码 10/173。5D CLI 范围 12 文件 88 测试/1849 次断言及八 workspace 类型通过，实际本机构建可搬移且无系统 Bun/Node/Electron，Schema/工具/恢复/临时/缺资源/取消均用真实 Pi/Seatbelt 和 localhost 模型验证。不代表全仓/桌面/压缩后完整 SDK 的迭代集中验收。
6. **迭代集中验收（已完成，2026-10-11）**：全仓 194 文件/1307 通过/0 失败/1 跳过、9056 次断言；跳过项是未显式配置解释器的 Zima 真实 workdir，非交互首版仍不支持 Zima。八 workspace 类型和源码构建通过，含独立 CLI 搬移及无系统 Bun/Node 的真实运行。覆盖参数/配置/stdin、主子 never/追问拒绝、完整后台交付、真实 Seatbelt/stdio/Pi SDK、真实自动压缩后重启/降级、凭据/初始化边界、信号/期限/异常清理、文件/Schema/退出码。源码 Electron 审批/追问/UI 历史恢复夹具、实际 Shell/Seatbelt 和生产启动/重载/多业务退出分别通过；快照冒烟等待真实预热收束，而非仅观察已 rename 文件，生产工具不等待预热的时机保持不变。只使用本机模型/MCP，不验收发布安装/签名或外部模型。README 已提供通用脚本和第三方进程调用示例。

每个阶段结束交付一个可运行的小主题并说明上下游，用户继续后才进入下一阶段，不把迭代收尾移到之后。运行前检查 shellSnapshot 等宿主初始化也可能执行用户启动配置，非交互不意味着这些可信本地配置没有副作用。

#### 本迭代不包含

- TUI、常驻 daemon、HTTP/WebSocket/远程入口、定时调度、批量评测驱动和判卷。
- Zima 无人值守执行、Linux/Windows 沙箱、全盘写入/危险全访问、自动审查 Agent、跳过硬规则或自动批准普通工具。
- 图片/附件命令参数（现行 Agent 输入尚无中立附件契约）、额外写目录 `--add-dir`、域名网络代理、CLI OS 安全存储/凭据管理命令、专用 review 子命令和通用插件/登录命令。这些需各自契约，不能接受参数却静默忽略；渠道配置可手动填写 apiKey，不提供管理入口。
- CLI 自动开放系统网络、忽略项目规则、关闭沙箱或与桌面共享正式写入目录；仅相似命令外观不等于具有未实现的能力。

### 迭代 26：Agent 暂停与继续（已完成）

产品语义为结束当前执行并保留续做入口，不冻结网络流、函数栈或 Shell；继续属于原逻辑 turn，单次执行仍启动新 runId，不重新投递原任务或自动重放已执行工具。此前基础暂停能力已完成源码集中验收；原轮继续的后续完善已接入 Pi/Zima/core/UI，本次验证范围和证据见 PROGRESS。

#### 阶段 1：中断背景（已接入）

- core 的 `buildAgentInterruptionPrompt(historyBeforeRun)` 根据当前用户输入落盘前的应用 JSONL 查找最近真实 result。仅 `terminal_reason: stopped` 且 `stopped_by_user: true` 产生固定提醒，不依据错误文案推断；内部压缩 result 不算新轮终态。
- 提醒放在 Agent 系统上下文的动态尾部，Pi/Zima 共用。正常 artifact 续跑及引用丢失的语义恢复都能消费，不把历史正文、思考、工具参数复制进提醒，不新增持久化字段或改写历史。
- 提醒说明工具可能部分执行、缺失结果不等于未执行/成功，需要续做时先核实必要状态，权限重新走本轮流程；当前用户消息优先，不因提醒自行继续旧任务。
- 后续真实轮成功/失败后不再沿用旧停止提醒。崩溃留下的更新用户输入无终态时，不将更早停止冒充最新轮状态。原停止、CLI resume、Chat 和权限行为不变；本阶段不把 result 当作可立即继续的资源收束凭据。

#### 阶段 2A：后端暂停/继续契约（已接入）

- shared 提供 `AgentPauseSnapshot {sessionId, turnId, runId, runStartedAt, pauseId, state: pausing | paused}` 和 `AgentContinueInput {sessionId, pauseId}`。turnId 来自原输入的 UUID；runId/runStartedAt 只标识单次实际执行。固定 RPC 为 `AGENT_PAUSE`（原 sessionId/runId）、`AGENT_GET_PAUSE`（sessionId）及 `AGENT_CONTINUE`（sessionId/pauseId）；暂停/继续限 main/quick，external 仍使用原 CLI 工作流取消/恢复。
- `AgentRunCoordinator.pauseRun` 只接受原 owner 的当前普通根轮，拒绝旧轮、子轮和 CLI 根。同步登记 pausing 并封口，沿用停止的清空未发送队列语义；分别尝试取消主链和子树，等待原 owner 链 finally，再调用本根子执行/交付等待。暂停期间禁止新发送、设置改动、删除和后台自动续跑；不等待其他根、不调用全局 drain。
- 收束依据是 adapter query 返回/finally、AgentService 的 run_finished（persisted + stopped）及本根协作等待。仅 result 到达不能标记 paused；清理/交付/存储失败、入口失效或缺少已保存停止终态均不生成继续凭据。阶段 2B1 已接 Pi 独立压缩取消与查询清理错误上报；不将中立夹具通过宣称为真实 SDK 全路径保证。
- 实际收束后在应用 JSONL 追加宿主 system marker `subtype: axon_paused`，保存 pause_id/turn_id/原 run_id/run_started_at/stopped_result_uuid/项目和可信实际工作区；uuid 等于 pause_id。只追加，不改写 result 或 Runtime artifact。内存 pausing 不落盘，重启不会把未完成暂停误当 ready；读取校验原输入 UUID、关联停止终态和工作区，普通停止不生成 marker。新输入/真实终态、已接纳继续或项目工作区改绑使旧凭据失效；最新 marker 损坏不回退到更早凭据。
- `continueRun` 核对确切 pauseId、turnId 和空闲状态后同步占有新 owner，调用 `AgentService.continueMessage`，不经过普通发送或 synthetic 用户输入。Service 先确认 adapter 的 `continueQuery` 能力和确切暂停记录，再追加 `system/axon_continued`，携带 turn_id/resumed_pause_id/stopped_result_uuid/新 run_id；标记写入后即消费原暂停，异常退出也不自动重发结果未知的继续。新执行使用原项目、工具及权限装配，adapter 收到无 prompt 的继续参数和宿主中断背景。普通 RPC 不能自报内部输入或原轮归属。缺少 adapter 能力时不落标记、不消耗凭据。已暂停时允许另一已登记桌面入口显式继续，来源保存在系统标记；旧交互/事件仍留在原身份，不自动转移。
- 清理失败通过安全业务错误报告，不伪造 paused；传输取消不回滚已接纳的暂停，不自动重发交付未知的继续请求，应重新读权威快照/历史确认。桌面入口和状态通知由阶段 3 接入。

#### 阶段 2B1：Runtime 取消与清理故障（已接入）

- Pi adapter 的同一活跃对象共享 abortWork：先调用 SDK `abortCompaction()`，再调用 `abort()` 取消生成/重试并等待空闲；压缩取消失败仍尝试普通取消。查询 finally 等实际 prompt/abort，再尝试解绑和 dispose，不使用短超时伪造完成，不修改 Pi SDK。
- Pi/Zima 暂存最后的中立 result，正常查询清理确认后才交付；正文、思考及工具事件仍按原顺序实时发送。Pi 的本轮故障标志只属于当前活跃对象，不能拿全局错误数组长度推断另一轮失败。跨轮 Shell 环境的释放仍由其原生命周期管理，不为暂停无差别取消共享缓存或全局资源。
- Zima 的普通停止等待本次 session.abort 确认，再关闭传输并等待实际进程 close 和宿主回调 drain；确认失败时终止自有进程并报告故障。整体 adapter dispose 会主动结束传输，尚在途业务取消确认的拒绝不误报为新的清理故障，实际进程/回调等待仍保留。关闭异常仍尝试终止及真实 drain，不发布正常 result。不修改独立 Zima 仓库或协议，不宣称已测试其真实模型压缩。
- shared 的 `AgentRuntimeCleanupError` 只携带固定中文诊断，不携带 SDK 原因或凭据；adapter 同时保留原全局退出诊断。AgentService 将该错误转换为 `runtime_cleanup_failed`、failed、不可重试，不让用户停止标志覆盖它。正常错误 result 可落盘；防御提前 result 后才抛清理错误的 adapter 时，保留原唯一 result，但 run_finished 报 failed/persisted=false，阻止暂停凭据，不追加第二个 result。
- 取消/清理与终态交付不放行停止后的普通 delta，不恢复半截工具参数。部分正文/思考及工具状态由下面的 2B2 统一处理。

#### 阶段 2B2：部分历史边界（已接入）

- core 的 `AgentInterruptedHistory` 每轮只积累已接纳的未完成正文/思考及未回传调用。完整 assistant 消息删除同 UUID 草稿；已收到的 retry/discard 撤销也同步删除，不复活被丢弃内容。停止后普通 delta、新 assistant/输入/进度仍不接纳，不读取或改写 Runtime artifact。
- 真实查询收束的 result 或取消/清理异常到达后，先将停止前已收到的块按 contentIndex 顺序冻结为 `assistant/isPartial:true/stop_reason:interrupted`，再保存唯一终态。保留正文空白和思考顺序，沿用草稿 UUID 替换 UI 投影；不逐 token 写盘。只有未完整工具参数、没有正文/思考的草稿仅从 UI 撤销，不制造空消息；即使参数 delta 含 toolcall_end 也不推断调用已提交。
- 完整 assistant 中登记的调用才能接纳停止后的真实 tool_result，按本轮 ID 过滤未知/已回传调用和混入文本，不覆盖实际成功/失败结果。Pi 取消期间允许实际 toolResult 的 message_end 通过，仍禁止迟到 assistant；Zima 原协议 tool.finished 保持同样中立回传。未收到结果的已登记调用追加 `isSynthetic:true` 用户工具记录，块为 `execution_status:unknown/is_error:true`，固定说明是否完成及副作用未知；这是应用诊断，不是 Runtime 伪造结果、失败证明或未执行证明。
- renderer 复用原工具行和活动组：未知结果单独标识并保持可见，不显示成功勾选或计为确定失败，不进入成功写入汇总。重启 UI 从应用 JSONL 恢复部分内容及诊断；artifact 仍优先精确续跑，缺失时中立语义背景明确区分部分助手输出/工具未知，不将思考或半截参数重新注入执行。
- 部分检查点保存失败和 2B1 的清理故障仍阻止可继续凭据，不用正常停止掩盖故障；已产生的文件/远端副作用不回滚。当前只覆盖正常受控停止/暂停，不承诺崩溃或强制退出前未落盘 token 可恢复；真实 SDK/宿主取消按本节末尾范围验证。

#### 阶段 3：跨进程与桌面入口（已完成）

- shared 提供固定 PAUSE/GET_PAUSE/CONTINUE IPC 与暂停变化通知。main 先校验真实主 frame/窗口身份和参数，浮窗暂停/继续只能指向绑定会话；新控制不开放任意 RPC。暂停和继续的长请求使用原页面生命周期信号、不套普通 RPC 超时，不自动重发。preload 仅暴露中立 DTO。
- core 的暂停变化通知只有 sessionId，先登记 pausing 再通知，marker 保存且原暂停锁解除后再次通知；新发送占有/释放 owner 及会话更新/删除也令观察缓存失效。app-server 向已登记入口投递通知，main 只送原有效页面；它不转投旧正文或交互、不携带继续凭据或授予控制权。
- renderer 按会话请求版本及页面代次重读权威暂停快照；变化通知还查询公开活动快照，补齐另一入口的开始/结束观察状态，不恢复其 owner。原入口由实时流、终态和控制应答校准历史，观察入口在暂停或所观察运行结束时重读，避免每条通知重复抢占分页快照租额。旧响应不能复活旧 pauseId 或覆盖已观察新轮。进入会话/浮窗重新聚焦会重读历史及暂停状态，重建后依靠持久 marker 恢复，不从 stopped result 直接推断可继续。
- 主窗口和快捷浮窗共用 AgentRunControl：原入口运行中显示暂停，观察入口仅显示其他入口运行中；pausing 同步禁止重复控制/发送/改设置，主轮已结束但子树/交付仍收束时继续保持正在暂停。paused 且读取成功后可继续，也可发送新任务。读取失败显示状态未确认，只提供只读重查，不重新提交控制；旧缓存不开放继续。Chat 停止不变。
- 继续只发送已读确切 pauseId，无用户可编辑恢复正文；后端调用独立继续入口，不新增应用用户消息。正常用户停止仍保存 stopped result/暂停 marker，但 renderer 不渲染通用停止错误卡；保留既有正文和思考/工具详情，尾活动组停止动画并保留原展开选择。renderer 按 `axon_continued.turn_id` 和确切 stopped_result_uuid 重新打开原回复，继续期间不显示旧执行的时间/复制尾栏，结束后只展示一处尾栏，文件变更与 Skill 使用汇总包含中断前后。正文仍是活动组边界，真实错误不会被合并隐藏；普通新用户输入另起一轮。真实清理/存储/运行失败及工具未知状态继续显示。提交锁同步拒绝重复继续，新 run 身份开始后解除提交锁，允许再次暂停，不等整轮 RPC 返回才放行。响应/异常后复读权威状态及历史，页面已释放则不修改状态；交付未知不自动重发。浮窗继续也立即上拉展示会话。
- 源码 Agent 冒烟脚本验证部分检查点、权威凭据、新 PID 重启恢复、主窗→浮窗继续→浮窗暂停→主窗继续、观察入口无控制权及来源标记，并保存截图。模型事件由隔离夹具提供；实际 SDK/宿主取消另行验证，不将该 GUI 夹具宣称为真实模型执行。

#### 后续完善：无新增用户发言、保留原逻辑轮的继续（Pi/Zima 已接入）

- shared 新增可选 `continueQuery` 与不带 prompt 的输入。Pi adapter 复用原查询的惰性启动、工具/沙箱/事件转换、取消和清理；只在执行阶段调用 SDK 公开 `sendCustomMessage`，以 `customType: axon_interruption` 保存中断背景并 `triggerTurn: true`。不调用普通 prompt、不新增 Runtime 的用户消息条目、不写固定续做指令，也不丢弃有效 assistant 来规避尾部限制。
- 这不是零上下文变更：Runtime 新增宿主 custom_message，SDK 可将该背景映射为模型请求的 user 角色；它不表示用户重新发言。artifact 缺失时明确将有界恢复背景并入这条宿主上下文，不伪装为当前用户输入。
- 会话级入口保留 SDK 的后置重试/压缩/agent_settled；继续首请求前用公开 getContextUsage、shouldCompact、compact 补阈值检查，相关事件映射为 threshold。公开 compact 的内部空闲事件不生成本次运行的提前 result；压缩中取消后不再启动模型。阈值检查不取代 SDK 自身后置/溢出处理。
- 阶段一已通过真实 Pi SDK 回环模型验证：保留 assistant 尾部、跨 adapter 恢复、工具执行一次、429 自动重试和唯一终态；另有阈值/取消/配置拒绝的中立 SDK 夹具测试。阶段二已将 core/UI 接入同一继续入口，测试覆盖重启、多次暂停/继续、旧身份拒绝、凭据消费、同轮显示和汇总；未修改 SDK 源码或版本。
- Zima adapter 使用独立 session.continue 请求，下发与普通运行相同的模型、工作区、工具和审批装配，但禁止 prompt，只传 interruption_id/interruption_context。握手 capabilities.continue=true 才发送，不支持时明确失败，无普通用户输入回退。Zima 上游新增严格继续 DTO 和 Engine.continue_run，重用原模型/工具/压缩/重试/取消循环；artifact 仍仅在安全检查点落盘，缺失时使用明确语义背景创建独立恢复 artifact。
- Zima 将中断背景保存为 system/metadata.kind=host_interruption，不新增 Runtime user；三种 Provider 在模型协议边界编码为 user，避免将 assistant 尾部误当预填充。此角色只代表协议承载，不代表新的人类消息。旧工具不会被引擎重放；模型若需再执行有副作用的操作仍须核实状态并走新执行的人工审批，Zima 未增加 OS 沙箱。
- 真实 Pi/core 四阶段暂停后继续及 assistant 尾部专项、真实 Zima/core 跨进程重建后继续、重新审批和 429 重试已通过。Zima 离线 Runtime/stdio/工具/压缩/终端宿主集中回归通过；源码桌面及全仓最终证据以 PROGRESS 为准，不沿用旧验收代替新链路。
- 应用 turn_id 沿原输入 UUID，包含可信后台文本输入的归属但不显示其用户气泡；多次暂停仍归同一回复。不改写旧历史中的普通或 synthetic 继续消息；崩溃且尚未形成受控暂停 marker 时不自动恢复 ready。外部模型与安装包不属于本次验收。

#### 集中验收（此前基础实现已完成，2026-10-14）

- 全仓 199 文件：1362 通过、0 失败、1 跳过、9428 次断言；八 workspace 类型、源码 Electron 构建及 diff 检查通过。跳过项为未显式配置解释器的真实 Zima workdir；Zima 取消/清理使用本机协议 child，未宣称其外部模型压缩实测。
- 真实 Pi SDK/core 回环模型验证正文流、半截工具参数、429 重试等待及自动压缩中的暂停：请求关闭或重试取消、唯一停止终态、完成后才产生继续凭据；半截参数不执行。既有全仓测试验证实际工具等待、审批/追问、MCP lease/进程关闭、子树交付、清理/存储失败、旧身份和重建/降级。
- 真实源码 Electron 两窗口验证上述阶段 3 流程；真实 Electron 宿主 Shell/Seatbelt 验证停止、超时、进程回收及权限/PATH/cwd 回归；Chat 快捷浮窗回归通过。GUI 模型和工具事件为中立夹具，真实 SDK 与 OS 执行由独立测试证明，不宣称每种资源组合都在 GUI 重演。
- 验收修正了旧测试将工具回传误计为人类输入的断言，并收窄 renderer 重复历史读取，未放宽分页租额、沙箱或 SDK 策略。一次双窗口冒烟整体超时未定位，添加阶段诊断后两次原流程及最终含暂停重启流程通过；保留偶发诊断，不将其归因为已修复缺陷。详细日志、截图与遗留项见 PROGRESS。
- 仅源码、本机模型和临时数据；未修改 Pi SDK、独立 Zima 仓库或正式会话，未验收打包安装及外部模型。

本迭代不恢复分叉/回退、运行中消息注入、同项目并发执行、后台 PTY/终端或其他暂不实现项。

## 横切约束

1. Runtime 专属代码只能进入对应 adapter。
2. 应用 JSONL 是唯一 UI 展示源，Runtime artifact 只用于对应 Runtime 恢复。
3. Delta 和瞬时重试状态不写入消息 JSONL。
4. 工具权限、工作区范围和停止信号必须覆盖所有工具来源。
5. 后台任务完成通知必须等待主会话空闲，不插入正在进行的模型循环。
6. 开发阶段格式变化直接采用新格式，不维护旧配置迁移。
7. 扩展功能默认不实施，也不提前创建无行为的空壳。
8. 支持沙箱的 Runtime 必须由宿主执行层落实策略；不支持的 Runtime 明确暴露能力差异，禁止静默降级为无沙箱执行。

## 第三部分：可扩展功能迭代（暂不实现）

以下能力不属于当前开发范围，不保留具体实施步骤；只有用户明确恢复后，才拆分契约、阶段和测试计划。

- **Chat 工具与高级渠道**：Chat 工具执行、联网、生图、订阅渠道和代理能力。**暂不实现。**
- **内嵌终端与浏览器自动化**：PTY 终端、终端会话和受管浏览器工具。**暂不实现。**
- **Automation 与远程入口**：定时任务、无人值守调度和远程机器人桥接。**暂不实现；单次非交互入口已恢复为迭代 25。**
- **Planning 产品系统**：计划、待办、日历、提醒及其 Agent 联动。**暂不实现。**
- **引导与平台工程**：首启引导、教程、平台专项、性能专项、TUI/其他 CLI 产品能力和完整发布链。**暂不实现；exec 子命令按迭代 25 开发。**
- **会话 Runtime 切换**：Pi/Zima 双向切换、独立 artifact 和增量历史导入。**暂不实现。**
- **高级会话控制**：分叉、回退、运行中消息注入和同项目并发执行。**暂不实现；Agent 暂停与继续已恢复为迭代 26。**
- **高级项目与文件交互**：会话跨项目移动、通用 @提及、文件移动和独立预览。**暂不实现。**
- **扩展记忆能力**：Chat 记忆、普通项目文件陈旧监听和自动记忆维护。**暂不实现。**
- **扩展桌面体验**：语音、悬浮状态窗、自动更新、通知声音、截图和 Runtime 进程隔离。**暂不实现。**
- **Skills 生态扩展**：远程/市场目录、账号同步和可视化 Skill 编辑。**暂不实现。**
- **工具沙箱扩展**：Zima 宿主工具委托、严格工作区只读 profile、域名网络代理、危险全访问模式及 Linux/Windows 后端。**暂不实现。**
