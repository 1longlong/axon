# Axon 工程约定

Axon 是一个本地优先、支持可插拔 Agent Runtime 的 Electron AI 桌面 Agent 项目。

**命名纪律**：项目一律使用 `axon` 命名——持久化目录（`~/.axon/`）、包名/应用 id、IPC 通道与事件前缀、自定义协议 scheme（如 `axon-file://`）、代码注释等。

**文档纪律**：AI 工程约定、设计文档、进度文档、README、release notes 与代码注释都只描述 Axon 自身和现行实现。

**核心设计文档**：`docs/axon-project-design.md`。文档统一描述产品范围、总体架构、可插拔 Agent Runtime 契约、核心子系统和迭代计划。动工前必读。

## 当前架构与目录边界

```text
apps/electron：renderer → preload → 固定 main IPC / 可信窗口身份
                                      ↕ 双向 stdio JSON-RPC
apps/app-server：独立装配入口 → packages/core → runtime-adapters / host-node
```

- 一个 Electron 父进程管理一个共享 app-server child；主窗口和快捷浮窗分别登记 clientId。桌面只保留窗口/托盘/Dock/快捷键、picker、safeStorage 私有桥及协议代理，不直接装配业务服务、adapter 或执行器，不提供进程内生产回退。
- `packages/shared` 保存中立 DTO、消息、IPC/RPC 与能力契约；`packages/core` 是不依赖 Electron/具体 Runtime 的后端业务库，统一拥有会话、渠道、项目、上下文、队列、审批/追问、MCP、Skills、记忆、Task 与业务持久化。
- `packages/runtime-adapters` 负责 Runtime 接入，SDK、工具 shape、artifact 和私有协议只在对应 adapter；`packages/host-node` 负责文件/Shell/Seatbelt/快照/环境探测，不导入 Runtime SDK。core 不反向导入这两个执行实现包。
- Pi/Zima 内置 Bash 的单次 `workdir` 解析为进程 `cwd`，默认项目根目录，可选择项目外真实目录；审批展示实际目录，执行不拼接 cd，各次调用不继承 cd/export。Pi 的 `policy.sandboxCwd` 始终来自可信项目工作区，保护目录/可写根/网络不随执行位置改变，项目外写入仍需精确批准。Zima 仍是普通人工审批而非 OS 沙箱，文件工具边界不随 Bash 目录变化。
- `packages/app-server` 是协议库（peer、身份/路由、私有桥、历史客户端）；`apps/app-server` 才是组合 core、adapter 与宿主的可执行服务入口。完整应用命令不可用仅有 adapter.query 代替。
- app-server 是业务文件唯一写入者；应用 JSONL 是 UI 历史源，Runtime artifact 优先用于精确续跑。持久化布局不因入口改变，不允许多个后端共写正式目录。
- macOS 正式 app-server 在装配前取得数据目录 `.axon-backend.lock` 的内核独占，持有到 drain/flush 后实际退出；锁不归并行 dispose 资源，不能删除锁文件或猜 PID 抢锁，exec 后代不继承 FD。直接复用 core 的宿主仍须自行保证唯一写入者；该锁不是项目工作区并发控制。
- 跨进程新增能力应先维护 shared RPC 契约及 server 路由，再接桌面 main/preload/renderer；不暴露任意 RPC 或私有加解密给页面。控制与交互校验原 clientId、真实 runId/generationId 和 requestId，重载不改投新页面，交付未知不自动重发。
- 资源先 dispose 封口/取消，再 await drain 等实际 Promise/finally/close；入口必须登记自有 adapter/执行器并回收迟到初始化。主窗口关闭留托盘不停止后端，真正退出或父 stdio 断开才收束。
- 包可在 monorepo/Bun 或源码构建环境中独立复用，不是已发布 npm SDK。迭代 25 的 apps/exec 已完成源码新任务/显式恢复/临时会话：预检/Schema 编译/真实沙箱握手 → thinking 校验/项目及 never-reject 根 → AGENT_EXECUTE_WORKFLOW → confirm → 实际 child 退出 → 最终 JSON 校验/临时根清理/原子文件/正文或 JSONL。workflowId 覆盖主轮空隙、子任务/交付/合成续跑，控制核对原客户端/根/工作流，不把首次 idle 或局部失败回复当结果。可信后端保存根的 creationOrigin/creationWorkspacePath，普通 RPC 不允许自报或修改；resume 只选 CLI 根，last/all 不迁移原项目，工作区改绑拒绝，校验当前可信渠道后只授权一个确切目标。artifact 优先；丢失 artifact/引用时从摘要及有界可见历史语义恢复，事件/stderr 提示，不重放旧任务。Schema 只约束根最终输出，不合格退出 3、保留历史/旧输出（ephemeral 历史仍清理），不假造 API 结构化能力。ephemeral 在原数据目录下创建私有随机根，配置保持原路径，后端业务数据只读写此根；正常实际退出后清理根，不删除容器/既有数据/工作区/输出，不与 resume 同用。后端清理失败或目录身份变化保留临时根、非零且诊断，不自动扫删遗留目录。总期限及信号取消原请求/自有资源，仍等待实际清理；断管/协议/清理故障非零、不重发。CLI 数据目录独立且不得位于工作区内，单次凭据不进入继承环境。桌面默认 onRequest/ask 不变；本机独立 CLI 已构建，全仓/源码桌面/真实 Pi 压缩恢复集中验收通过。TUI/daemon/远程入口继续后置。使用入口见 README，运行契约以核心设计文档为准。
- CLI 源码父入口和后端使用固定可信 Bun 配置并禁 dotenv，不自动执行任务目录 preload；源码通过 exec:dev 启动，不发布裸 .ts 的 bin。调用方此前运行的 preload/Shell 初始化仍属可信宿主责任。
- CLI 凭据仅使用 config.json 中最终选中 channel 的 apiKey；新任务/恢复均校验确切渠道，不读取 AXON_API_KEY 或桌面密钥，不借用其他渠道。密钥只留在父端配置，经私有桥按 ID/Provider/Base URL 交付；启动 DTO、继承环境与自动保存的历史不携带。配置是用户主动保存的明文，应为 0600、置于工作区外且不提交仓库，不宣称对同一用户或有读取权限的工具不可见。残留 AXON_API_KEY 从父端继承源与 child 环境剔除，不作为凭据输入。
- 独立 CLI 默认 apps/exec/dist，需保留整目录；父端/Schema Worker 和 backend/axon-app-server 均内嵌执行环境，后端固定加载相邻 app-server.mjs 与清单复制的相对版本依赖，不搜索 PATH/回退源码，不依赖 Electron 或系统 Bun/Node。构建禁止自动 dotenv/bunfig/tsconfig，后端仅开启 package.json 以解析配套 exports。构建先完成自有暂存/全部编译再发布，陌生目录/源码祖先/用户根不覆盖；不应在活跃产物目录重建。仅本机 macOS 构建，当前 arm64 实测；其他平台及安装/签名后置。

## 必须一直遵守的约束

### 1. 按核心迭代计划推进，每轮交付可运行版本

- 实现顺序遵循设计文档的核心迭代计划；“可扩展功能迭代”统一标记为暂不实现，只有用户明确恢复后才进入开发。
- 迭代内的条目顺序可以微调（依赖关系允许时），但不能把某个迭代的收尾工作推迟到下一个迭代。

### 2. 大迭代分多次对话交付，并教学式讲解

- 如果一次迭代的改动量很大，必须拆分为多个对话/多个阶段完成，每个阶段结束时向用户交付并讲解，**不要一次性闷头写完**。
- **步子要小**：用户是初学者，单个阶段只做一个主题（如"只搭目录结构"、"只讲主进程启动"），宁可多拆几个阶段也不要一次产出太多文件；讲解从"为什么需要它"开始，再到"它怎么工作"。
- 每次讲解要覆盖：本阶段做了什么、关键架构决策及理由、重要代码的位置和工作方式、与整体设计的关系。目标是让用户通过实现本项目对每一层都有清晰认知，方便后续自行魔改。
- 讲解重要实现时不能只给文件路径：选取最小必要的关键代码片段，说明“上游输入 → 本层处理 → 下游消费/持久化”的完整链路，并指出主要失败边界；片段和讲解保持简洁，不逐行复述、不粘贴整文件。
- 用户明确说"继续"或指定下一阶段时才推进。

### 3. UI 不是重点，优先复用现有组件

- UI 一律优先复用 Axon 已有组件、样式与交互（React 18 + Jotai + Tailwind + Radix/shadcn primitives），不自研重复组件、不做无关视觉打磨、不随意引入新 UI 依赖。
- 复用时只做当前需求所需的最小改动，不重构、不"顺手优化"。
- UI 相关的迭代条目（渲染高级、桌面体验等）以功能可用、风格一致为完成标准，不以额外视觉改版为目标。

### 4. 可插拔边界纪律（最重要的一条工程纪律）

- runtime 专属代码（工具定义 shape、session 文件查找、runtime SDK import）只允许出现在 adapter 一个文件里；编排层、渲染层、持久化层只依赖 `AgentProviderAdapter` 接口和 `SDKMessage` 协议。
- 发现自己想在 adapter 之外 import runtime SDK 时，停下来：要么收进 adapter，要么先和用户确认扩展中立 adapter 契约。
- Pi SDK 是底层外部依赖，不修改其源码或安装目录，也不通过补丁包改变实现；所需差异在 Pi adapter 中通过公开 API 实现，不调用或替换 SDK 私有方法。

### 5. 每次会话结束记录进度

- 每次会话（对话）结束时，更新 `docs/PROGRESS.md`：本次做了什么、改了哪些文件、当前迭代推进到哪个阶段、关键决策与遗留问题、下次会话的起点。
- 进度文档只保留最新开发状态与验证证据，不记录 Git 提交、推送、tag、Release 或发布操作流水；这些信息以 Git 和发布页为准。
- 目标是换个全新会话也能凭 `docs/PROGRESS.md` + `AGENTS.md` 无缝继续，不依赖对话历史。
- 迭代整体完成时同步勾选 `AGENTS.md` 的"当前状态"清单。

### 6. 技术栈与工程习惯

- Bun monorepo（不使用 npm/pnpm）；Electron + React 18 + TypeScript；状态管理 Jotai；不用 `any`；对象类型优先 `interface`，类型导入用 `import type`。
- 持久化本地优先：JSON/JSONL + 原子写，不引入本地数据库。
- IPC 遵循四层契约：shared 常量/类型 → main handler → preload bridge → renderer 调用，新增 IPC 四处同步。
- 注释、日志、工程文档用中文。
- 每个大迭代收尾时统一补齐该迭代的可执行测试（正常路径 + 主要边界），并集中运行、记录完整测试与真实应用验证结果；迭代内的小阶段不重复补全或汇报整套测试结果。

### 7. 流程代码必须有简洁注释

- 重要流程性函数必须有函数级中文注释，简要说明职责、关键输入/输出和它在上下游链路中的位置。典型范围包括：主进程启动与生命周期、IPC 编排、网络请求与流处理、Provider/Runtime 适配、持久化读写与恢复、状态迁移等。
- 如果函数内部包含多个阶段、状态机、资源清理、回退或非显然的顺序约束，应在关键分段前增加简洁的过程注释，说明“为什么按这个顺序处理”或“此处守住什么边界”。
- 注释解释意图、契约和陷阱，不复述语法；简单 getter、显然的纯映射和短小工具函数无需为了数量补注释。代码行为变化时同步更新相关注释，禁止留下与实现不一致的说明。

### 8. 开发阶段不维护旧配置兼容

- 当前仍处于开发阶段；配置文件、持久化 DTO 或本地索引格式发生变化时，直接采用新格式，不编写旧字段迁移、双格式读取或兼容分支。
- 新格式仍需提供新安装所需的默认值，并保持损坏文件恢复、类型校验和安全边界；这些属于当前格式健壮性，不属于历史兼容。

## 当前状态

- [x] 迭代 1：应用骨架与本地优先底座（2026-08-31；打包/托盘按迭代 14 落地，Preview/Tutorial/Scratch Tab 与右侧工作区随各自功能迭代接入，未提前创建空壳）
- [x] 迭代 2：渠道管理 + Chat MVP（2026-09-06；四种 Provider 流协议、渠道安全存储与目录、流式多轮 Chat、JSONL 恢复和真实 Electron 冒烟完成；虚拟化性能项按计划留到迭代 16）
- [x] 迭代 3：Chat 完整体验（2026-09-06；Markdown、附件、系统提示词、上下文摘要、标题生成与草稿持久化完成）
- [x] 迭代 5：Agent Runtime MVP（2026-09-08；完成 runtime adapter、双轨会话持久化、Agent IPC/renderer、权限确认、消息工具展示、环境检测与真实 Electron 冒烟）
- [x] 迭代 6：Agent 工作区与会话完整化（2026-09-11；项目级唯一工作区、项目会话树、文件树/监听/预览、双侧栏、上下文用量、thinking 等级、文件变更汇总和只读 Diff 完成）
- [x] 迭代 7：Agent 交互高级（2026-09-12；排队、追问、停止、错误处理、恢复、外部运行与 Git 归因完成）
- [x] 迭代 8：Skills 与项目指令（2026-09-13；项目 AGENTS.md、子目录作用域、项目 Skills 发现、渐进加载与激活记录完成）
- [x] 迭代 9：MCP（2026-09-13；项目级 stdio/Streamable HTTP 配置、安全持久化、SDK Client 桥接、中立工具注入与连接测试完成）
- [x] 迭代 10：记忆系统（2026-09-13；Agent 项目级开关、安全 Markdown 存储、Memory 工具、动态索引、变更提醒与编辑面板完成）
- [x] 迭代 12：协作子 Agent / Task（2026-09-14；完成统一 Agent/Task 契约、前后台结果交付、固定一层角色与权限边界、根会话 state/JSONL 聚合存储、Task IPC/实时投影/详情 UI 与真实 Electron 恢复验证）
- [x] 迭代 14：桌面体验包（2026-09-15；托盘生命周期、关闭/退出语义、单实例唤起、macOS Dock 状态及应用图标完成）
- [x] 迭代 17：Zima Agent Runtime 接入（2026-09-17；默认 Pi、创建时可选 Zima、独立 artifact、工具授权、停止、恢复、真实模型及 Electron 冒烟通过；子目录 AGENTS.md 自动加载受 Zima v1 协议限制，受控 Python 分发待完成）
- [x] 迭代 18：全局快捷唤起现有会话（2026-09-27；多快捷键绑定、轻量浮窗、共享历史、来源标记与真实 GUI 验收完成）
- [x] 迭代 20：ToolSearch 与工具懒加载（2026-09-20；仅 Pi 下官方 Anthropic Messages tool reference 与模型目录明确支持的 OpenAI Responses 动态工具启用；其他协议/runtime 保持 MCP eager，检索、能力协商、权限及恢复契约完成）
- [x] 迭代 21：多级 Skills 与 Axon 管理安装（2026-09-21；完成四级优先级发现、统一 `SkillRead`、受控原子安装、专用 IPC、Agent Skills 设置 UI、主/子 Agent 继承与真实 Electron 验证；catalog provider 按计划保留为空，远程/市场来源后置）
- [x] 迭代 22：macOS Seatbelt 工具沙箱与细粒度审批（2026-09-27；Pi 内置工具宿主委托、不可用时拒绝原生回退、命令规则、精确 Grant、按实际执行来源审批、只读子 Agent 边界、权限 UI 与真实 Electron 验收完成；Zima 沙箱、完全自动和域名网络代理按计划后置）
- [x] 迭代 23：Agent Shell 文件快照执行（2026-10-04；完成会话异步预热、私有文件发布、条件选择、沙箱内恢复、原始命令归因、主/子会话释放和遗留清理；全仓检查、真实 Seatbelt 与 Electron 冒烟通过）
- [x] 迭代 24：后端模块化与独立 app-server（2026-10-08；七阶段源码实现、真实 stdio/SDK/Seatbelt、Electron 桥接/组合退出和集中回归完成；按用户要求不验收打包后 GUI/Keychain，已知偶发就绪超时保留诊断，TUI/exec/daemon 后置）
- [x] 迭代 25：通用非交互 Agent 入口（2026-10-11；macOS/Pi 新任务、完整工作流、正文/JSONL、文件/Schema、CLI 根恢复/临时会话、期限/信号与实际清理、独立 CLI 构建完成；全仓 1307 项/八 workspace 类型/源码构建、真实压缩恢复及源码桌面集中验收通过，非评测专用）
- [x] 迭代 26：Agent 暂停与继续（2026-10-16 原轮继续完善验收；Pi/Zima 不新增用户发言，保留原 turn/合并回复与汇总，单次执行用新 runId 隔离旧控制。Pi 仅用公开 SDK API、不改依赖；Zima 独立上游和 adapter 增加 session.continue 与宿主背景编码，保持人工审批。全仓 1398 通过/2 项显式 Zima 专项跳过后单独补跑通过、八 workspace 类型、源码构建、双桌面入口/新 PID 恢复、真实 Pi/Zima 继续及独立 Zima 126 项回归通过，证据见 PROGRESS。正常停止保留已有显示，不恢复半条流或重放工具；外部模型和安装包不在本次范围）

## 可扩展功能迭代（暂不实现）

- [ ] Chat 工具执行、联网/生图能力、订阅渠道与代理体系。
- [ ] 内嵌终端、PTY 与受管浏览器自动化。
- [ ] Automation、无人值守调度与远程机器人桥接（单次非交互入口已纳入迭代 25）。
- [ ] Planning、待办、日历、提醒及其 Agent 联动。
- [ ] 首启引导、教程、平台特化、性能专项、TUI/其他 CLI 能力与完整发布链（exec 按迭代 25 开发）。
- [ ] Agent 会话 Runtime 切换与跨 Runtime 增量历史导入。
- [ ] 会话分叉/回退、运行中消息注入与同项目并发执行（Agent 暂停与继续按迭代 26 开发）。
- [ ] 会话跨项目移动、通用 @提及、独立预览和更完整的文件操作。
- [ ] Chat 记忆、普通项目文件陈旧监听及记忆维护自动化。
- [ ] 语音、悬浮状态窗、自动更新、通知声音、截图与其他桌面扩展。
- [ ] 远程/市场 Skill 目录与可视化 Skill 编辑。
- [ ] Zima 宿主工具委托、严格工作区只读 profile、域名网络代理、危险全访问模式及 Linux/Windows 工具沙箱。

（每完成一个核心迭代在这里勾选并注明日期；扩展项只有用户明确恢复后才拆分为正式迭代。）
