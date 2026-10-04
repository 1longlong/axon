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
- API Key 由主进程保存，不会直接暴露给页面渲染层。
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

## 更多文档

- [项目设计与迭代规划](./docs/axon-project-design.md)
- [UI 设计与实现](docs/ui-design.md)
- [当前开发进度](./docs/PROGRESS.md)
- [LLM 文本生成 API 协议示例](./docs/llm-text-generation-api-protocol-examples.md)
