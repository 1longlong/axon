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
packages/
  shared/            中立 DTO、消息、能力与 IPC/RPC 契约
  core/              Agent/Chat、渠道、项目、Skills、MCP、记忆和存储
    src/agent/       运行协调、上下文与恢复
    src/providers/   文本生成协议与流处理
    src/storage/     JSON/JSONL、原子写与历史分页
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
  applicationVersion: '0.1.4',
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
  --application-version 0.1.4
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
  '--application-version', '0.1.4'], { stdio: ['pipe', 'pipe', 'pipe'] })
const closed = new Promise<number | null>((resolve, reject) => {
  child.once('close', resolve)
  child.once('error', reject)
})
child.stderr.pipe(process.stderr)
const peer = new JsonRpcPeer(child.stdout, child.stdin, APP_SERVER_RPC_OPTIONS)
try {
  await peer.request(methods.INITIALIZE, {
    protocolVersion: APP_SERVER_PROTOCOL_VERSION,
    client: { name: 'axon-example', version: '0.1.4' },
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

两个示例都在退出后删除自己创建的临时数据；实际接入应换成宿主指定的持久目录。一个目录只由一个后端写入，不能让独立示例和桌面共享正式目录。服务没有 HTTP/WebSocket 入口，不支持接管已有桌面后端，也不会在父连接断开后变成常驻 daemon。TUI、exec 和无头调度仍未实现。

## 更多文档

- [项目设计与迭代规划](./docs/axon-project-design.md)
- [UI 设计与实现](docs/ui-design.md)
- [当前开发进度](./docs/PROGRESS.md)
- [LLM 文本生成 API 协议示例](./docs/llm-text-generation-api-protocol-examples.md)
