# Axon 当前进度

> 更新于 2026-10-23。只保留最新开发状态与验证证据；运行契约见核心设计，目录边界见 AGENTS.md。

## 当前状态

迭代 28（Pi Agent 分类附件与多模态输入）及用户确认的三个输入后续阶段均已完成：共享行内 Skill 编辑、/skills 本地命令、中立顺序贯通发送/排队/应用历史/恢复。主窗与快捷浮窗共用业务链，保留各自外观。未修改 Pi SDK 或新增插件体系、AttachmentRead；Chat 和 Zima 原有范围不变。根目录、九 workspace、锁文件与 README 使用示例的版本统一为 0.1.7。

本次完成斜杠交互修正：首行输入 `/` 即在整个输入框上方显示命令与有效 Skill 的混合列表；字符变化实时匹配 Skill 名称/描述，支持中文及大小写不敏感匹配。选择 Skill 直接插入行内胶囊，不要求先输入 `/skills` 或经过第二层弹窗。`/skills` 仅保留为完整选择器入口。

文件/目录仍共用一个回形针与原生选择面板，图片/普通附件在上方，Skill 与正文同行。文本直接粘贴，超过 8,000 字符自动命名保存；不要求来源/文件名/行号，不推断普通剪贴板来源。

## 本次实现与关键链路

- AgentComposerEditor 的原子 Skill 节点只暂存后端签发 sourceId，readAgentComposerDocument 输出原始 text、去重选择及有序 parts。保留空格、换行和 Markdown 原文；删除/撤销只改本地文档，接纳后重建编辑历史，取消/换会话不转移选择。
- useAgentAttachments.submitWithSkills 串行对齐当前草稿，再把来源映射为真实附件 ID，形成中立 inputParts。片段只能是 {type:text,text} 或 {type:skill,attachmentId}，不携带页面自报的名称/路径/指引/权限；实际 Skill 来源核对与正文加载继续归 core。
- shared 的 parseAgentInputParts 复制并校验当前格式，片段文字拼接须逐字等于 text，最多 21 项；validateAgentInputPartReferences 要求与当前草稿 Skill 完整一一对应，拒绝遗漏、重复、其他草稿或普通文件 ID。纯文字调用可不带片段；有 Skill 就必须提供完整片段。未写旧格式迁移、双读或自动删数据。
- 固定 preload/main/RPC 仍按原契约透传 AgentSendInput，不新增任意 RPC。AgentRunCoordinator 在队列接管时校验，AgentService 在实际派发/落盘前再校验；失败不请求模型、不生成用户历史，原未提交草稿按租约规则退还。
- 队列深复制 inputParts，并与原附件租约持有；dequeue 继续交付该顺序。应用 JSONL 的唯一用户消息同时保存原始正文、inputParts、附件描述及当时 attachmentContext，不靠解析模型提示词恢复 UI。
- AgentInputText 用保存的名称按顺序渲染历史/队列胶囊，Skill 不在上方附件区重复显示；复制使用同一顺序。图片/普通文件标签与预览继续复用原组件。
- core 的 agentInputPromptText 按顺序编码含附件 ID/名称的 Skill 引用标记；完整指引仍在同一 user 输入的附件上下文，不进固定 system、不伪造新用户或工具消息。原 text 不加入胶囊名称。
- 精确 artifact 恢复使用 Runtime 已保存的请求；artifact 缺失时 buildRecoveryPrompt 按同一顺序生成有界背景，使用当时保存的正文，不读取新版 Skill 改造旧消息。应用 JSONL 的顺序、原文、指引和图片不随正常压缩删除。
- AgentComposerEditor 一次打开通过固定 listSkills 桥读取发现摘要；matchAgentSlashCandidates 将本地命令与有效 Skill 合并、逐字过滤，不逐字符请求后端、不读正文。关闭/禁用/换会话忽略迟到响应；错误/空结果显示在列表内，不发送模型请求。
- Enter/Tab/点击和发送按钮共用分发：Skill 将斜杠片段原位替换为 sourceId/名称胶囊，`/skills` 打开原选择器。支持上下方向键和鼠标选中；重复/超量选择保留草稿。候选以主窗/浮窗整个输入容器为锚点，上方等宽、有界滚动，焦点留在输入框。下方正文/附件保留，未知或参数错误保留草稿，IME Enter/粘贴不自动执行；正文、代码和完整路径不误识别。浮窗 Esc 先关菜单/选择器，再取消唤起；未增加窗口或失焦豁免。
- 原附件归属/上传/预览、图片能力确认、资产 reserved→JSONL→committed、实际 drain、来源失效、原生文档命令和随包依赖边界维持原实现。

## 当前验证证据

- 2026-10-23 全仓：1540 pass / 2 skip / 0 fail，10,617 断言、1,542 用例、234 文件；/private/tmp/axon-v0.1.7-tests.log。两项跳过为需显式解释器的 Zima 真实暂停/目录专项，未计为通过；包括独立 CLI 构建与真实 SDK/Seatbelt 集成。
- 九 workspace 类型检查通过：/private/tmp/axon-v0.1.7-types.log。Electron 完整源码与独立 CLI 构建通过：/private/tmp/axon-v0.1.7-build.log、/private/tmp/axon-v0.1.7-cli-build.log；CLI 实际输出 axon 0.1.7，父入口/后端均为 arm64 Mach-O。Vite 保留已有大 chunk 提示。
- 真实源码 Electron 完整附件冒烟通过：/private/tmp/axon-v0.1.7-desktop.log；证据 /private/var/folders/g_/9jwx4hbn38vbn9fn6cryjpmm0000gn/T/axon-attachments-desktop-uECpyG/evidence.json。使用隔离临时目录、本机模型 SSE 和受控 picker；Pi SDK、独立后端、固定桥、React 与文档 Seatbelt 实际执行。
- 桌面覆盖真实 insertText、混合候选/方向键、逐字过滤、主窗点击/浮窗 Enter 直接插入且不打开 Dialog、IME/未知输入/Esc 分层。菜单由边界与 elementFromPoint 核对，实际位于整个输入框上方且等宽；不是仅断言 DOM 存在。
- 同次覆盖行内编辑/撤销、完整指引与顺序进入真实请求/JSONL、伪造引用拒绝、原草稿入队/取消、图片真实请求/预览、文档命令、artifact 丢失降级、暂停/无输入继续、自动压缩及新 PID 恢复；6 个人类输入、10 次本机模型请求、2 次带图，后端 PID 33515/33912。未对外部模型或安装后的 GUI/Keychain 做验收。
- 本机 arm64 产物静态检查：应用 plist/asar 元数据均为 0.1.7，独立后端、axon-doc、sharp 与 PDF/Documents 指引资源齐全。DMG 经 hdiutil verify、ZIP 经 unzip -tq、CLI 经 gzip -t 通过，三份 SHA-256 复核通过。构建与 DMG 记录 /private/tmp/axon-v0.1.7-package.log、/private/tmp/axon-v0.1.7-dmg-verify.log；未配置 Developer ID 签名或公证。

## 本次主要文件

- shared：types/agent-attachment.ts、agent-run.ts、agent-message.ts、agent-input-parts.ts、index.ts 及片段测试。
- core：agent-run-coordinator.ts、agent-queue-coordinator.ts、agent-service.ts、agent-session-context-prompt.ts 及服务/队列/恢复用例。
- renderer：agent-composer-document.ts、useAgentAttachments.ts、AgentInput.tsx、QuickComposer.tsx、AgentInputText.tsx、AgentMessageItem.tsx、AgentMessageQueue.tsx、agent-message.ts 及对应测试。
- 本次斜杠修正：AgentComposerEditor.tsx、agent-slash-command.ts 及其测试、AgentInput.tsx、QuickComposer.tsx、smoke-agent-attachments.ts、README、核心设计、AGENTS 与本进度；无后端协议或 Runtime 变动。
- 桌面验收：smoke-agent-attachments.ts；文档：README、核心设计、AGENTS 与本进度。未触及原有 .bun-build 文件。
- 版本元数据：根和九 workspace 的 package.json、bun.lock；使用与功能说明同步 README 和 docs/releases/v0.1.7.md。

## 验证边界与后续起点

- 不宣称外部供应商、安装包 GUI 或手动原生选择面板验证。失焦/隐藏测试等待真实原生事件送达，不用额外延时豁免改变产品取消规则；截图只作为诊断，不能替代行为断言。
- 精确恢复与有界语义恢复不同；历史片段可能按既定恢复预算截断，不保证重放全部 Skill 全文。压缩不删除应用记录，但不每轮强塞已压缩指引。
- Zima 多模态、本地 Loop/CLI 附件入口、子任务自动继承附件、远程附件/Skill 市场、OCR/Office 渲染及新 MCP resource 输入继续后置。
- 三个输入阶段与动态斜杠候选修正已收尾。等待用户指定下一主题；不自动增加其他斜杠命令、Runtime 或扩展迭代。
