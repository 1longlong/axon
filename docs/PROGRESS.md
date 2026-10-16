# Axon 当前进度

> 更新于 2026-10-17。只保留当前状态和必要验证证据；完整契约见 [工程约定](../AGENTS.md)、[核心设计](axon-project-design.md)，入口见 [README](../README.md)，界面见 [UI 实现](ui-design.md)。

## 当前状态

- 迭代 24、25、26 已完成源码范围验收。本轮完成迭代 26 的原逻辑轮继续完善：Pi/Zima/core/UI 全链已接通，不新增用户发言，不另起 UI 回复；单次实际执行仍使用新 runId，隔离旧控制、权限和迟到事件。
- Pi SDK 保持原样外部依赖：未修改源码、安装目录、私有方法、依赖版本或补丁。Pi 只用公开 SDK API；Zima 的独立源码与 Axon adapter 本轮同时修改。
- Electron 管理共享独立 app-server；apps/exec 复用同一协议/core/adapter/host。主窗和快捷浮窗共享历史、权威暂停状态与原逻辑轮。
- 根 package 与八 workspace 统一采用 v0.1.5，锁文件和 README 装配示例同步；版本变化不改 IPC/RPC 协议号。
- 输入区仍是单个发送/暂停/继续图标；运行中 Enter 默认排队，胶囊展示，正常结束后自然成为新用户轮。Chat 停止、CLI 工作流取消/恢复不变。

## 本轮架构澄清：Loop 结果回报（未实施）

- 澄清候选方案：新增 LoopReport/LoopFinish 原生工具不是接入前提，也不是已有能力。自动执行完成、失败、耗时和最终正文应优先由可信执行桥从现有完整工作流结果收集；业务状态、目标完成等结构化回报另定义可替换协议，不绑定具体 Runtime 的工具注册。
- Loop 接入仍仅分析，未新增业务代码、依赖或任务，未运行测试；下列集中验收证据属于已完成的迭代 26。后续需先确认回报接口与功能范围，再记录正式设计和分阶段开发。

## 最新实现：Zima 无新增用户发言继续

### 上游与 adapter

- 独立仓库：/Users/covenant/Workspace/Projects/Github/zima。runtime/protocol.py 抽出公共 SessionExecutionParams，SessionRunParams 保留 prompt；新增 SessionContinueParams，仅允许 interruption_id/interruption_context，不接受 prompt 或空白背景。
- runtime/server.py 握手公开 capabilities.continue=true，新增 session.continue 分发。复用当前内存或精确 artifact；缺少引用但有明确 recovery_prompt 时创建独立 recovered artifact 并保存语义背景，不丢弃背景、不覆盖损坏原文件。既无历史来源也无背景则在创建会话前拒绝。
- core/engine.py 新增 continue_run，保留原历史并追加 system/metadata.kind=host_interruption 背景；不新增 Runtime user，不删除有效 assistant，不重放原工具。普通 run 和继续共用 _execute 的模型、工具、压缩、重试、用量、取消与唯一终态。
- core/provider_models.py 仅在三种 Provider 编码边界将宿主中断背景映射为 user，避免将 assistant 尾部误当预填充；Runtime 持久化历史仍保存为 system。Pi 的 custom_message 也可映射为模型 user，因此不新增人类消息不代表模型上下文零变化。
- Axon 的 runtime-adapters/src/zima-agent-adapter.ts 实现 continueQuery。与 query 共用惰性启动、回调、人工审批、取消、进程/回调 drain 和事件转换；确认握手继续能力后发送 session.continue，传原模型/工作区/工具配置及背景，不构造 prompt、不静默回退或自动重发。不支持的新解释器实例明确报告需更新 Runtime。
- Zima 仍未具备宿主 OS 沙箱；Write/Edit/Bash 等原人工审批不变。运行中旧审批不恢复，继续如需工具须重新走新执行权限。

### 同轮与重启边界

1. core.pauseRun 取消根/子任务和交互，等真实 query/finally、owner 释放、子交付及已保存停止终态，成功后才保存 system/axon_paused。
2. marker 保存 uuid=pause_id、turn_id（原输入 UUID）、原 run_id/run_started_at、stopped_result_uuid、project_id 和可信 workspace_path。pausing 只在内存中，不因崩溃冒充 ready。
3. 重启 readStoredPause 核对最新 marker、原输入/停止结果和项目/工作区；新输入、真实终态、axon_continued 或改绑使旧凭据失效。关联损坏不回退到更早暂停。
4. continueRun 核验确切 pauseId 后调用 AgentService.continueMessage；先落 system/axon_continued 消费暂停，再调用无 prompt 的 adapter.continueQuery。新 runId 只用于实际控制；交付未知不能自动重试旧暂停凭据。
5. renderer 根据 turn_id + 确切 stopped_result_uuid 接回原回复，中断前后共享一个时间/复制栏和文件/Skill 汇总，正文仍划分活动组，错误/审批/未知工具状态不隐藏。本轮补齐后台 synthetic 文本输入的真实 UUID 归属：不显示气泡，其暂停后仍能合并自身回复。
6. 根应用历史在数据目录 agent-sessions/<rootSessionId>/agents/main/messages.jsonl，UI 只从应用历史恢复；Runtime artifact 优先精确续跑，缺失才语义降级。没有新增独立暂停状态文件，也未迁移旧格式或改写旧继续消息。

## 修改范围

- Axon：zima-agent-adapter.ts、zima-agent-adapter.test.ts、fixtures/fake-zima-runtime.mjs；新增 zima-continue.integration.test.ts。renderer 的 agent-turn-groups.ts/.test.ts 补后台归属；同步 AGENTS、核心设计、UI、协议示例与本进度。
- Zima：runtime/protocol.py、runtime/server.py、core/engine.py、core/provider_models.py；新增 test/test_runtime_continue.py，同步 agent-runtime-protocol.md 与 agent-runtime-implementation-plan.md。保留两仓原有未提交改动，无关 .bun-build 文件未处理。
- 原轮 core/共享契约、Pi 公开继续入口、主窗/浮窗冒烟脚本承接前两个阶段，不回退隐藏用户文本；没有新增 UI 依赖或修改普通发送协议。

## 最新验证证据

- Axon 全仓：201 文件，1398 pass、0 fail、2 skip、9663 断言，147.94 秒，实际退出 0。日志 /private/tmp/axon-native-continue-stage3-all-tests.log。两项跳过是未显式配置解释器的真实 Zima 继续及 workdir；随后显式使用独立仓库 .venv/bin/python 补跑，2 pass、0 fail、26 断言：/private/tmp/axon-native-continue-stage3-zima-live-final.log。
- 真实 Pi/core 专项：5 pass、0 fail、67 断言；保留 assistant 尾部、工具仅一次、429 重试，以及正文流/半截参数/重试等待/压缩四阶段暂停后继续。日志 /private/tmp/axon-native-continue-stage3-pi-live.log；全仓也包含这些 Pi 测试。未修改 SDK。
- 真实 Zima/core：实际 Python child + 本机 SSE 模型完成 Write→流中暂停→服务/adapter 重建→继续→重新批准 Write→429 重试→唯一成功终态。应用文本用户记录及 Runtime artifact user 均只有原始一条，旧工具没有被自动重放，中断前后文件各经一次审批。首次单跑日志 /private/tmp/axon-native-continue-stage3-zima-live.log，最终补跑包含该场景。
- Zima 集中回归：126 passed，覆盖 Runtime/stdio、协议、恢复、回调/审批、取消、重试、压缩、工具及终端宿主。日志 /private/tmp/axon-native-continue-stage3-zima-regression.log。mypy 20 个源文件通过：/private/tmp/axon-native-continue-stage3-zima-types.log；本次五个 Python 文件 Black 检查及新增测试 isort 检查通过。
- 八 workspace 类型检查通过：/private/tmp/axon-native-continue-stage3-types.log。源码 Electron 完整构建通过，仅既有 Vite 大 chunk 提示；构建和最终桌面日志 /private/tmp/axon-native-continue-stage3-desktop.log。
- 源码 Agent 双窗口/重启冒烟实际退出 0：主窗暂停→新 PID 恢复→浮窗继续/再次暂停→主窗继续，原 turnId、无停止错误卡/无新用户气泡、唯一回复时间/共享来源及浮窗身份释放全部通过。截图目录 /var/folders/g_/9jwx4hbn38vbn9fn6cryjpmm0000gn/T/axon-agent-smoke-NdRwNA；已查看 agent-paused.png、agent-continued.png。
- GUI 模型/工具事件为中立夹具，真实 Pi/Zima 另由上述实际 Runtime 回环测试证明，不宣称真实外部模型 GUI 验收。关闭/重载时仍有已取消 RPC 诊断，未作为成功依据；业务断言和实际退出已核验。
- renderer 同轮专项 18 项/69 断言：/private/tmp/axon-native-continue-stage3-turn-renderer.log；最新全仓也包含新增后台归属回归。两仓 diff 检查通过。前阶段审批服务额度阻塞已解除，本轮没有绕过审批，原未执行验证已补跑。
- v0.1.5 版本一致性检查覆盖根 package、八 workspace 和锁记录；八 workspace 类型与版本相关四项/36 断言通过，日志 /private/tmp/axon-v0.1.5-types.log、axon-v0.1.5-version-tests.log。源码桌面和独立 CLI 构建通过，CLI 归档保留完整 backend/依赖/内嵌 Worker，实际 --version 返回 axon 0.1.5；ZIP/DMG 完整性及版本、配套后端入口与 SHA-256 已核对。不增加打包 GUI/Keychain 或外部模型验收范围。

## 现行边界与遗留

- app-server 是业务文件唯一写入者；macOS 内核目录锁保持至实际退出，不删锁/猜 PID 抢占。workdir→cwd 与可信 sandboxCwd 分离，换执行目录不放宽 Pi 沙箱；Zima 仍人工审批。
- 不恢复半条网络流/函数栈、旧审批或自动重放工具，不承诺崩溃前未落盘 token 和副作用回滚。受控停止保留部分正文/思考及工具未知诊断，半截参数不成为可执行调用。
- CLI 凭据仍只取确切渠道 config.apiKey，经私有桥交付，不读 AXON_API_KEY/桌面密钥或进入继承环境。ephemeral 仅清理自有随机业务根；异常保留，不扫删历史目录。既有独立 CLI 安装产物未重建，源码变化不会自动更新活跃安装目录。
- 业务验收只使用源码、本机夹具和临时数据，没有外部模型请求或正式会话修改；macOS arm64 产物另做构建、归档和元数据静态校验，未做打包 GUI/Keychain 验收。Zima 配置的解释器必须运行含 continue 能力的新源码/安装；其他旧安装不会因 Axon adapter 改动自动升级。
- 偶发桌面就绪/停顿、Shell 系统停顿与 Zima accept 超时保留既有诊断，不因本次通过宣称全部消失。正式安装签名、其他平台和 Zima 受控 Python 分发仍后置。
- 分叉/回退、运行中注入、Runtime 切换、TUI/daemon/远程/调度及其他扩展仍不自动实施。Loop 仅有待议架构，没有新增业务代码、调度或正式迭代。

## 下一次起点

- 本次原轮继续完善已完成集中源码验收，等待用户真实使用反馈或指定下一主题；不自动开启后置扩展。
- 若反馈继续失败，先核验解释器对应的 Runtime 及握手 capabilities.continue、确切 pauseId/turn_id 和应用/Runtime 历史；再沿原 clientId/runId 定位，不隐藏用户文本兜底，不重发交付未知的继续。
