# Axon

Axon 是一个本地优先的 AI 桌面应用，既可以用于日常对话，也可以作为面向代码项目的桌面 Agent。

它支持连接多种模型服务，并将会话、项目工作区、工具调用、Skills、MCP、记忆和子 Agent 集中在一个应用中管理。

> Axon 目前仍处于开发阶段，功能、配置格式和本地数据结构可能发生变化。

## 主要功能

### Chat 对话

- 连接 OpenAI、Anthropic、Google Gemini 及兼容服务。
- 支持流式回复、Markdown、代码高亮、数学公式和附件。
- 自动生成会话标题，并保存草稿和历史消息。
- 在长对话中显示上下文用量，并按需生成摘要。

### 代码 Agent

- 一个项目可以包含多个会话，并共享同一个工作区。
- Agent 可以读取、搜索和修改工作区文件，也可以运行命令。
- Pi 在 macOS Seatbelt 可用时，将内置编码工具委托宿主执行；工作区外写入、受保护目录写入及可归因的命令联网需要额外审批。
- 支持项目指令、Skills、MCP 工具和项目记忆。
- 支持前台或后台子 Agent，适合拆分探索、规划和编码任务。
- 可选择 Pi 或 Zima Runtime；新会话默认使用 Pi。

### 桌面使用体验

- 左侧按“项目 → 会话”组织 Agent 工作。
- 右侧支持多个只读文件标签、悬浮文件树与项目记忆面板。
- 支持托盘运行、单实例唤起和 macOS Dock 状态。
- 可以为已有会话绑定全局快捷键，通过轻量浮窗快速提问，并在主窗口继续查看完整历史。

## 架构与目录

桌面采用一个 Electron 父进程和一个共享 app-server 子进程；主窗口与快捷浮窗连接同一后端，不各自创建业务实例。

```text
React UI → preload → 固定 Electron IPC → Electron 主进程
                                          ↕ 双向 stdio JSON-RPC
                                  独立 app-server
                                    ├─ core：业务编排与持久化
                                    ├─ runtime-adapters：Pi / Zima
                                    └─ host-node：文件、Shell、Seatbelt
```

Electron 负责窗口、托盘/Dock、快捷键、原生选择器和 safeStorage；后端统一负责会话、模型请求、工具审批、项目能力和业务文件写入。应用 JSONL 是 UI 历史源，Runtime artifact 用于精确续跑；连接中断不会自动重发用户消息。

```text
apps/
  electron/          main（桌面与 IPC）、preload、renderer（React UI）
  app-server/        独立后端入口：装配 core、Runtime、宿主与 stdio 服务
  exec/              非交互 CLI：新任务/恢复、正文/JSONL、文件/Schema 输出与取消退出
packages/
  shared/            中立 DTO、消息、能力与 IPC/RPC 契约
  core/              Agent/Chat、渠道、项目、Skills、MCP、记忆和存储
    src/agent/       运行协调、上下文与恢复
    src/providers/   文本生成协议与流处理
    src/storage/     JSON/JSONL、原子写与历史分页
  loop-engine/       独立 Loop 生命周期与 Cron 调度
  runtime-adapters/  Runtime SDK、工具格式与 artifact 转换
  host-node/         文件/命令执行、Seatbelt、Shell 快照与环境探测
  app-server/        协议库：JSON-RPC、身份、路由、私有桥与历史客户端
docs/                核心设计、UI、协议示例与当前进度
```

core 不依赖 Electron 或具体 Runtime；宿主执行不依赖 Runtime SDK。应用入口负责组合各层，桌面主进程不直接装配业务后端。详细契约见 [项目设计](docs/axon-project-design.md#2-总体架构)。

## 开始使用

可安装构建出的 macOS DMG，或按以下步骤从源码启动。当前安装包未经 Developer ID 签名与公证；Zima 的 Python 环境仍需单独准备。

### 环境要求

- macOS（当前主要开发和验证平台）
- [Bun](https://bun.sh/) 最新稳定版
- 可访问所用模型服务的网络环境

### 安装与启动

```bash
bun install
bun run dev
```

应用启动后：

1. 在设置中添加模型渠道，填写服务地址、API Key 和模型。
2. 使用 Chat 创建普通对话；或在 Agent 中创建项目并选择工作区。
3. 创建 Agent 会话时选择 Runtime，随后即可开始任务。

## Runtime

### 本地 Loop

左侧顶部 Agent / Chat / Loop 切换中进入 Loop，侧栏显示独立任务导航，可选择本地工作目录，配置模型、任务、Cron 和完成目标，查看运行时间线、执行过程、产物和历史变更。Loop 不绑定或创建 Agent 项目，侧栏支持按目录搜索；切换模块不会停止后台任务，并保留本窗口最近查看的位置。每次使用新的 Pi 会话；`axon loop report/finish` 通过本次私有通道回报，不启动第二个后端。任务文件在所选目录 `axon-loops/<id>/`，正式状态在应用数据目录 `loops/`。工作目录创建后固定，运行前复核真实路径；删除 Loop 保留本地文件夹及任务产物。

使用步骤：配置可用渠道 → 左侧 Loop → 选择本地文件夹 → 描述任务、确认模型/计划/权限 → Agent 准备配置 → 按计划或立即执行。无需手写 HTML、JS 或指标 JSON；Agent 核实来源后按需生成持续面板、指标与预检，没有合适用途时可以留空。没有目标则持续巡检，有目标且 Agent 经 CLI 确认完成后停止计划；不同任务可共享工作区，冲突由用户安排。

工作目录用“选择/更换文件夹”按钮选择，路径以普通文字显示。在“后台权限”中配置此 Loop 自己的 MCP，可先填写服务器草稿，再选目录进行测试连接、查看完整 tools/list 和刷新工具列表；界面明确显示未满足的条件。勾选“允许后台自动调用的工具”即授予对应 MCP 工具的免逐次人工审批权限，不需要手填工具名；不选不影响内置文件/Shell 工具。新建时草稿随创建请求加密保存到 `loops/<id>/mcp.json`，不进入定义或执行日志；与同目录项目及其他 Loop 的配置、连接和授权相互独立。编辑已有 Loop 的 MCP 会立即保存并清空旧白名单，需重新勾选、保存授权；运行/排队期间禁止修改服务器，草稿测试不影响运行连接。不继承项目记忆。配置保存失败时任务可能已登记为未就绪，应从列表查看并修复，不要重复创建；不会自动执行半份配置。

创建可选“创建后立即执行”，准备成功后才运行普通任务。准备失败/取消/中断不自动重试，在详情查看原因后“重新准备”；计划暂停时可准备但不会暗中启用执行。基本设置不覆盖生成内容，后续用“让 Agent 修改”描述面板/预检等调整。详情保留准备/编辑/优化结果和运行来源。只有成功普通执行才检查自动优化；一次性安排采用后写覆盖。暂停计划不取消当前任务或阻止回报，真正停止须使用“停止本次”。优化模型通过 `axon loop log/trace` 查看应用历史，不寻找 Runtime 私有日志。

当前仅 macOS/Pi，工具沿用沙箱和无人值守 `never/reject`；缺授权直接拒绝，不弹出等待审批。JS 预检可直接产出结果或按需调用模型，网络默认关闭，MCP 按用户白名单授权。`axon loop` 命令只在后台 Agent 本次受控环境可用，不是用来另启后端的普通终端管理入口。主窗关闭留托盘继续，应用真正退出即停止；不负责休眠唤醒或独立常驻。

`@axon/loop-engine` 可独立导入纯生命周期与调度器，宿主须实现其时钟/任务列表/派发端口；它不包含存储、模型、Shell 或 UI。完整桌面能力由 core/app-server 装配。源码桌面验收可运行 `bun run --filter='@axon/electron' test:loop:smoke`，仅使用隔离临时数据和本机模型夹具。

需要 macOS Seatbelt。需要审批的操作默认拒绝；JS 预检网络和 MCP 工具需用户显式授予。主窗关闭留托盘可继续，退出应用后停止，不唤醒休眠机器。同一任务不重叠，不同任务共享目录的冲突由用户安排。目前仍在集中验收前，暂不视为正式完成能力。

### Pi

Pi 是默认 Runtime，无需额外安装 Runtime 依赖。配置好模型渠道后即可创建会话。

### Zima

Zima 需要一个已经安装对应环境的 Python 可执行文件。启动前设置：

```bash
AXON_ZIMA_PYTHON=/absolute/path/to/venv/bin/python bun run dev
```

未配置该变量时，Pi 会话不受影响，但无法创建或恢复 Zima 会话。

## 项目能力

### 项目指令

Agent 会读取项目根目录的 `AGENTS.md`。当 Read 工具进入更深的子目录时，还可以按目录作用域加载对应的 `AGENTS.md`。

子目录自动加载目前由 Pi 支持；Zima 尚不具备等价能力。

### Skills

项目级 Skills 放在以下任一目录：

```text
.axon/skills/<skill-name>/SKILL.md
.agents/skills/<skill-name>/SKILL.md
```

同名 Skill 按以下优先级读取，先找到的生效：

1. 项目 `.axon/skills/`
2. 项目 `.agents/skills/`
3. Axon 管理目录 `$HOME/.axon/skills/`
4. 用户全局目录 `$HOME/.agents/skills/`

Agent 设置页用于管理安装到 Axon 目录的 Skills，不修改项目或用户全局目录。可安装目录的来源尚未接入，目前列表为空；也可以自行按上述目录放置 Skill。

### MCP

每个项目可以配置自己的 MCP Server，支持 stdio 和 Streamable HTTP。配置页面提供连接测试，并显示服务端返回的工具列表。

### 项目记忆

Agent 记忆由项目级开关控制。启用后，Agent 可以保存项目约定和长期信息，并在后续会话中继续使用。

### Shell 环境

Pi 在 macOS 上首次运行会话时异步捕获账户默认 Shell 的环境，后续匹配工作目录的 Bash 调用可恢复 PATH 等导出变量，再进入既有命令执行链。模型命令和子进程仍受 Seatbelt 限制；宿主环境初始化不套该工具沙箱，会读取用户启动配置。

Bash 通过 `workdir` 指定单次执行目录，可选择项目内或项目外的真实目录；省略时默认项目根，相对路径从项目根解析。Pi 将执行 `cwd` 与可信 `policy.sandboxCwd` 分开：换目录不扩大可写根、不解除保护目录或网络限制，额外写入仍需精确审批。Zima 同样支持单次目录，但仍仅有普通人工审批，没有 OS 沙箱；会话工作区和文件工具边界不随 Bash 目录改变。

首条命令不等待快照；预热未完成或条件不匹配时仍走原登录路线。不保证终端 alias/函数跨 Shell 保留，也不会把单次工具的 export/cd 写回快照。Zima 不使用这条宿主快照链。

## 本地数据与隐私

- 设置、渠道、会话、附件、项目和 Runtime 会话数据默认保存在本机。
- 开发版使用 `~/.axon-dev/`，正式版使用 `~/.axon/`。
- Axon 管理 Skills 在开发版和正式版都使用 `$HOME/.axon/skills/`。Shell 快照在对应应用目录的 `shell_snapshots/` 中，可能包含敏感导出变量；属于临时执行缓存，不是会话备份，请勿上传或提交。
- API Key 经 Electron 的 safeStorage 私有桥加密，由独立后端持久化，不会直接暴露给页面渲染层。
- 模型请求仍会发送给用户配置的模型服务，请根据对应服务的隐私政策使用。
- 请勿将本机 Axon 数据目录或渠道凭据提交到版本控制。

## 当前限制

- 项目仍处于开发阶段，升级前建议自行备份重要会话和配置。
- 桌面能力目前主要在 macOS 上验证。
- Zima 需要用户自行准备 Python 运行环境。
- Zima 暂不支持宿主 OS 沙箱；Bash 和写入类内置工具必须人工审批，不能视为与 Pi 相同的操作系统隔离保护。
- Pi 必须具有可用宿主沙箱和一致的执行策略；Seatbelt 探测失败时明确拒绝运行，不回退到无沙箱的原生工具。
- explore/plan 子 Agent 强制使用只读策略；explore 仅在真实只读沙箱覆盖 Bash 时提供该工具，不能通过审批扩大角色权限。
- Seatbelt 默认允许全盘读取，不能保证消除 macOS 的相册、文档等隐私授权提示。权限预设中的自动审查与完全访问模式尚未开放。
- 尚未实现的扩展功能不会提前提供空壳入口。

## 不启动桌面，单独复用后端

可以，但应区分业务库与独立服务入口。当前包使用 `workspace:*` 和 TypeScript 源码入口，适合在本 monorepo 或集成其源码的 Bun/构建环境中复用；不是已发布的独立 npm SDK，也不支持浏览器直接运行。宿主 workspace 需在自己的 package.json 声明所用包的 `workspace:*` 依赖并运行 `bun install`，不能假设根目录可解析所有包。

### 进程内使用 core

可信宿主共用 `AgentSessionFactory.create(config, signal)` 创建根会话；项目、Loop 与 CLI 不是三种底层 Session。`AgentService` 通过 `resolveExecutionContext`、`getMemoryContext`、`getCustomTools` 接收宿主装配的目录、记忆与工具，后续运行重新解析，不冻结创建时的内容。`createBackend()` 提供 Axon 的项目/Loop/CLI 上层规则；其他用途可组合导出的工厂、服务与工作流，参考 [无项目宿主示例测试](packages/core/src/agent/generic-session.integration.test.ts)。这些是可信进程内端口，不向页面开放任意目录/身份覆盖；审批、子角色边界及唯一写入者责任不变。

`@axon/core` 提供 `createBackend()`，宿主注入目录、版本、凭据端口和 Runtime 路由。下面是只创建本地 Chat 元数据的最小示例：保存在已声明依赖的 `apps/app-server/example-core.ts`，从仓库根目录执行 `bun run apps/app-server/example-core.ts`。

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBackend, createBackendPaths, createCredentialCodec } from '@axon/core'
import { AgentSandboxCommandService } from '@axon/host-node'
import { PiAgentAdapter } from '@axon/runtime-adapters'

const directory = mkdtempSync(join(tmpdir(), 'axon-core-example-'))
const paths = createBackendPaths({ dataDir: join(directory, 'data'), homeDir: directory })
const executor = new AgentSandboxCommandService({ shellSnapshotDirectory: paths.shellSnapshotsDir })
const pi = new PiAgentAdapter(undefined, executor)
const backend = createBackend({
  paths,
  applicationVersion: '0.1.5',
  credentialCodec: createCredentialCodec(), // 无安全后端：拒绝非空凭据，不保存明文。
  resolveAdapter: (runtimeId) => {
    if (runtimeId !== 'pi') throw new Error('本示例只装配 Pi')
    return pi
  },
  ownedResources: [pi, executor],
})
try {
  console.log(backend.conversations.create({ title: '独立 core' }))
} finally {
  backend.dispose()       // 禁止新工作并发出取消。
  await backend.drain()   // 等真实运行、连接和资源清理结束。
  rmSync(directory, { recursive: true, force: true })
}
```

工厂初始化时就需要默认 Pi adapter；此示例仅装配它，不启动模型查询。实际模型对话还需配置渠道，带 API Key 的渠道需注入可用的 `CredentialCodec`；其他 Runtime 通过 `resolveAdapter` 接入。可参考 [现行装配代码](apps/app-server/src/backend-bootstrap.ts)；入口创建的 adapter/执行器应交给 `ownedResources`，运行走 `clients`、`agentRuns`/`chatRuns`，不能绕过所有者和审批检查。宿主需处理审批/追问，没有交互端口时不能默认批准。此方式供其他宿主复用，不改变桌面的独立进程部署。

### 独立运行 app-server

`@axon/app-server` 是协议库，不会自行启动进程；`apps/app-server` 才是装配好 core、Pi/Zima 和宿主执行器的服务入口。仓库根目录可执行：

```bash
bun run app-server:dev \
  --data-dir /absolute/axon-data \
  --home-dir /absolute/axon-home \
  --application-version 0.1.5
```

这是等待父端协议请求的 stdio 服务，不是交互式聊天 CLI。父端应以子进程管道启动它，先握手再登记客户端，之后携带 `clientId` 调用固定业务方法。下面的最小父端示例保存在 `apps/app-server/example-client.ts`，从仓库根目录执行 `bun run apps/app-server/example-client.ts`；不读写桌面正式数据，也不请求模型。

```ts
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonRpcPeer } from '@axon/app-server'
import { APP_SERVER_METHODS as methods, APP_SERVER_PROTOCOL_VERSION, APP_SERVER_RPC_OPTIONS } from '@axon/shared'
import type { AppServerClient } from '@axon/shared'

const directory = mkdtempSync(join(tmpdir(), 'axon-server-example-'))
const child = spawn(process.execPath, ['run', 'apps/app-server/src/main.ts',
  '--data-dir', join(directory, 'data'), '--home-dir', directory,
  '--application-version', '0.1.5'], { stdio: ['pipe', 'pipe', 'pipe'] })
const closed = new Promise<number | null>((resolve, reject) => {
  child.once('close', resolve)
  child.once('error', reject)
})
child.stderr.pipe(process.stderr)
const peer = new JsonRpcPeer(child.stdout, child.stdin, APP_SERVER_RPC_OPTIONS)
try {
  await peer.request(methods.INITIALIZE, {
    protocolVersion: APP_SERVER_PROTOCOL_VERSION,
    client: { name: 'axon-example', version: '0.1.5' },
    hostCapabilities: { credentialStorage: 'unavailable', channelTargetConfirmation: false },
  })
  const client = await peer.request(methods.REGISTER_CLIENT, { kind: 'external' }) as unknown as AppServerClient
  console.log(await peer.request(methods.CHAT_LIST_CONVERSATIONS, { clientId: client.clientId }))
} finally {
  child.stdin.end() // EOF 触发后端停止；不是调用 peer.close() 就当进程已退出。
  const code = await closed
  peer.close()
  rmSync(directory, { recursive: true, force: true })
  if (code !== 0) throw new Error('后端未正常退出')
}
```

需要安全存储和渠道目标确认时，父端在握手前安装 `registerPrivateHostBridge`，只声明实际能力；需要 Agent 时另处理运行通知及反向审批/追问。完整历史用 `AppServerHistoryClient` 分页汇聚，不直接读取 Runtime 文件。长发送请求需设置合适的取消/超时，生产宿主还应管理异常退出及有界强制回收。

两个示例都在退出后删除自己创建的临时数据；实际接入应换成宿主指定的持久目录。一个目录只由一个后端写入，不能让独立示例和桌面共享正式目录。macOS app-server 在装配前取得数据目录内核独占锁，直到真实退出才释放；不要手动删除 `.axon-backend.lock`。进程内复用 core 的宿主仍须自己落实唯一写入者。服务没有 HTTP/WebSocket 入口，不支持接管已有桌面后端，也不会在父连接断开后变成常驻 daemon。TUI 和无人值守调度仍未实现。

### 通用非交互入口（源码与独立 CLI 可运行）

已完成[迭代 25](docs/axon-project-design.md#迭代-25通用非交互-agent-入口已完成)。当前 macOS/Pi 新任务与显式恢复已接通真实独立后端：严格参数/stdin/配置 → 沙箱握手 → 工作区项目/非交互根会话 → 完整工作流 → 历史落盘与实际 child 退出 → 最终校验/输出。默认只读，`never/reject` 不申请额外批准、不伪造追问答案；桌面默认行为不变。每次新任务创建新会话，仅复用真实工作区项目，不隐式续跑。显式 thinking 在发送前验证能力；提示词和功能开关为本次装配上限，不修改永久设置。

普通 stdout 仅在工作流成功、终态落盘且后端实际正常退出后输出最终主回复，保留空白和换行；失败/取消不输出局部回复。`--json` 输出版本化有序 JSONL，包含 `exec_started`、主/子中立事件、`workflow_started/workflow_finished` 与清理后的唯一 `exec_finished`，不重复输出纯文本正文。通知/RPC/最后主轮不一致、输出断管或溢出均失败，不重发。管道故障可能使最后事件无法交付，调用方仍必须检查进程退出码。

`exec resume ID` 只恢复可信 CLI 根；`--last` 选当前真实工作区最新根，`--last --all` 跨目录选择但仍在原项目执行。创建来源和真实工作区由后端保存，普通/子会话或项目改绑会拒绝。默认保留原渠道/模型，profile、`-c` 或专用参数可明确覆盖，但必须在本次可信配置中启用、凭据可用，不能切换 Runtime。artifact 优先精确续跑；artifact/引用丢失时从最近成功摘要及有界可见历史语义恢复，JSONL 和 stderr 明确提示。只发送新的任务，不自动重放旧请求或工具；文件参数仍相对 `-C`/调用工作区。

`--ephemeral` 在所选数据目录下创建随机私有 `.axon-ephemeral-*` 业务根；数据目录此时只作容器，默认配置仍按原路径读取，不复用或覆盖已有项目/会话。运行中历史、artifact、锁和快照仍可落盘，正常后端实际退出后删除此根，再交付输出；模型失败、格式失败和可处理的信号/期限也清理。工作区修改、指定输出、用户配置和已有业务数据保留，容器目录不删除。拒绝与 resume 同用。后端强制/异常退出、目录身份变化或删除失败时非零并保留临时目录；SIGKILL/父进程崩溃不能保证清理，不自动扫删遗留目录。

`-o` 在成功后原子保存完整最终正文，父目录必须已存在；不能覆盖业务数据、已加载配置或 Schema，拒绝链接/非普通文件。`--output-schema` 在创建任务前编译 JSON Schema（默认 draft-07，支持 2019-09/2020-12），仅向主 Agent 加入中立格式要求，不假造协议级结构化输出支持。完成后严格校验整个 JSON，不提取代码围栏、不修补、不重跑；不合格保留旧输出，持久会话保留历史、临时会话仍清理，退出 3。Schema 不加载外部引用，编译/校验可取消且各限五秒。文件已成功保存后若 stdout 断管或取消，文件仍保留，整体退出非零。

后端 `workflowId` 覆盖全部子任务、结果交付和合成续跑，不用首次 idle 判断结束。`--timeout` 覆盖输入读取、初始化、模型/工具/后台工作、校验与输出；SIGINT/SIGTERM 取消原请求并关闭自有资源，仍等实际清理。退出码：0 正常交付/清理；1 运行/协议/存储/输出/清理故障；2 输入/配置/能力错误；3 最终 JSON 不满足 Schema；124 总期限；130 SIGINT；143 SIGTERM。工具拒绝后模型正常结束可以为 0，不代表业务目标已验证成功。

```bash
bun run exec:dev --help
bun run exec:dev --version
# 先按核心设计配置独立 CLI 渠道；my-channel/my-model 是占位值。
bun run exec:dev exec -C /absolute/project --channel my-channel -m my-model "说明目录结构"
bun run exec:dev exec -C /absolute/project --json --timeout 600 - < /absolute/input/task.txt
# schema.json 相对项目目录解析；输出目录须已存在，成功时替换 result.json。
bun run exec:dev exec -C /absolute/project --output-schema schema.json -o result.json "生成符合 Schema 的结果"
bun run exec:dev exec -C /absolute/project --ephemeral -o answer.txt "完成一次不保留会话的任务"
bun run exec:dev exec resume SESSION_ID -C /absolute/project "检查刚才的修改"
bun run exec:dev exec resume --last -C /absolute/project "继续处理下一项"
bun run exec:dev exec resume --last --all "检查最近会话的工作"
```

默认配置为 `~/.axon-exec/config.json`（不是桌面渠道文件），数据目录独立且不得位于工作区内。每个 `channels` 条目可设置自己的 `apiKey`，仅使用本次最终选中渠道的密钥；不读取 `AXON_API_KEY` 或桌面密钥，不接受 argv/-c 密钥。CLI 父端通过私有管道交付凭据，启动渠道 DTO、工具继承环境和自动保存的历史不携带它。配置密钥为明文，请将文件权限设为 `0600`，放在工作区之外，勿提交仓库；这不阻止同一用户或有读取权限的工具主动读取该文件。配置示例和完整参数契约见核心设计。入口不内置评测或调度。

独立 CLI 在本机 macOS arm64/x64 构建；构建需要已安装的 Bun/仓库依赖，运行产物不需要 Electron、系统 Bun/Node 或源码仓库。

源码请通过上述 `exec:dev` 命令启动：父入口及配套 Bun child 显式禁 dotenv、固定 Axon 的空 Bun 配置，不让任务目录的 preload 在沙箱前执行。不要直接用裸 Bun 执行入口 `.ts`；调用方提前执行的 preload/启动脚本不在此边界内。源码仍依赖已安装的仓库依赖，不能只复制一个 `.ts` 文件使用。

```bash
bun run exec:build
./apps/exec/dist/axon --help
./apps/exec/dist/axon exec -C /absolute/project "说明目录结构"
# 可选构建输出目录；拒绝覆盖陌生目录，不要在正在使用的产物目录上重建。
bun run exec:build --outdir /absolute/axon-cli
```

```text
apps/exec/dist/
├─ axon                    CLI 执行文件，内嵌 Schema Worker 与执行环境
├─ axon-cli-build.json      版本、平台、依赖资源清单（不是用户配置）
└─ backend/
   ├─ axon-app-server      自带执行环境的独立后端启动器
   ├─ app-server.mjs       core / adapter / host 的正式业务装配
   └─ node_modules/        外部依赖及资源，各包版本通过相对链接保留
```

请复制/移动整个产物目录，不能只拿 `axon`。CLI 按自身真实位置启动配套后端，再走相同 stdio/工作流链；不搜索 PATH、不回退源码。父端及后端启动器禁止自动加载工作区 `.env`、bunfig 和 tsconfig；后端允许读取 package.json 以解析配套外部包的 exports，不执行 npm scripts。Shell 快照仍可能执行用户 Shell 启动配置。产物缺失/资源加载失败明确非零；构建暂存成功才替换已标识的自有产物，失败不删旧构建，根目录/用户目录/源码祖先或陌生目录拒绝覆盖。当前本机测试为 macOS arm64；未验证 macOS x64，也未提供其他平台运行、签名、公证或安装包发布。

第三方应用可直接启动 CLI 子进程，不必加载 core 或 Runtime SDK。例如 Bun 调用方通过 stdin 交付任务、读取 JSONL，再检查真实退出码：

```ts
const child = Bun.spawn([
  '/absolute/axon-cli/axon', 'exec', '-C', '/absolute/project',
  '--json', '--timeout', '600', '-',
], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
child.stdin.write('检查目录结构，不修改文件')
child.stdin.end()
const jsonl = await new Response(child.stdout).text()
const exitCode = await child.exited
// 局部成功事件不代表整次执行成功；还要检查实际退出码。
if (exitCode !== 0) throw new Error(`Axon 执行失败：${exitCode}`)
const events = jsonl.trim().split('\n').map((line) => JSON.parse(line))
```

凭据由调用方可信环境提供，示例不保存密钥。长会话应逐行消费事件；取消时向此自有进程发送 SIGINT/SIGTERM 并等待退出，不只停止读取 stdout。并行调用必须使用不同业务目录，不能共写默认目录。

## 更多文档

- [项目设计与迭代规划](./docs/axon-project-design.md)
- [UI 设计与实现](docs/ui-design.md)
- [当前开发进度](./docs/PROGRESS.md)
- [LLM 文本生成 API 协议示例](./docs/llm-text-generation-api-protocol-examples.md)
