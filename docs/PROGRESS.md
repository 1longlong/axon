# Axon 当前进度

> 更新于 2026-10-19。仅保留最新开发状态与验证证据；运行契约见核心设计，目录边界见 AGENTS.md。

## 当前状态

- 独立 Loop 目录/MCP 已完成；本轮完成创建表单交互修正。Loop 直接绑定本地文件夹，不绑定或创建 Agent 项目，MCP 独立加密保存/连接/授权，不继承项目记忆。
- 底层仍共用 AgentSessionFactory、AgentService 和完整主子工作流；Loop 真实根创建后固定、执行前复核。应用 JSONL 与 Runtime artifact 不变。
- 根及九 workspace 为 v0.1.5，仅 macOS/Pi Loop；Zima Loop、常驻服务、系统唤醒及其他后置项未恢复。
- 现行 LoopDefinition/创建输入使用 workspacePath，旧 projectId 格式不迁移、不自动删除；本轮不再改 DTO、持久化格式、RPC 或执行权限。

## 本轮改动

1. 创建/编辑的目录区域不再使用输入框：选择/更换文件夹按钮加普通路径文字，创建后只展示固定目录。提交前显式检查目录，仍由后端校验真实根。
2. 配置 MCP 不再要求先选目录；新建草稿可以先填写保存。连接测试和工具发现仍沿用现行目录契约，缺少目录/服务器时给出具体原因；运行/排队时禁止改服务器的后端边界不变。
3. 去掉手填逗号分隔工具名的框，改为“允许后台自动调用的工具”勾选列表与已选计数。显示未配置/空结果/禁用原因，解释未选 MCP 不影响文件/Shell 等内置工具；测试/发现不自动授权。已有但未被本次发现的授权仍可见、可撤销，不因空列表误清。
4. 目录/配置变化淘汰旧工具目录结果；组件卸载不消费迟到结果。已有 Loop 保存服务器仍立即清空旧授权，需重新勾选并保存；未改变确切白名单、Schema 校验或无人值守 never/reject。
5. 复用既有组件和样式，界面审查仅影响状态可解释性与目录呈现，不调整全局主题/字体/依赖。未修改 SDK、正式数据、Keychain 或原有构建缓存。

## 关键文件

- apps/electron/src/renderer/components/loops/LoopForm.tsx：无输入框目录选择、独立 MCP 草稿、状态提示和工具勾选。
- renderer/components/agent/McpProjectDialog.tsx：共用编辑器增加可见测试条件，原 Agent 项目用法不变。
- 新增 LoopForm.test.tsx，scripts/smoke-loop.ts 增加未选目录先配置、明确测试提示及无目录输入框断言。
- README、docs/ui-design.md、docs/axon-project-design.md 同步现行交互；后端与协议本轮未改。

## 本轮验证

- 表单/测试生命周期/样式定向：7 pass / 0 fail，48 断言，3 文件；/private/tmp/axon-loop-form-ui-tests.log。
- 九 workspace 类型全部退出 0：/private/tmp/axon-loop-form-ui-types.log；源码 Electron production build、git diff --check 通过。未重复全仓测试或构建安装包。
- 源码桌面 bun run test:loop:smoke 实际退出 0：/private/tmp/axon-loop-form-ui-desktop.log。使用临时数据、固定测试目录选择回调及本机模型/MCP；未选目录也可打开配置、添加服务器，测试按钮显示明确原因；选择目录后真实 MCP 握手/tools/list、草稿保存、勾选授权、准备/执行、Pi 子任务/CLI/取消、项目删除隔离及新 PID 恢复通过，11 次本机模型请求。
- 截图 /private/var/folders/g_/9jwx4hbn38vbn9fn6cryjpmm0000gn/T/axon-loop-desktop-7jgqlm，已检查 agent-compose.png 和 loop-mcp-no-workspace.png。不冒充人工原生 picker 或外部模型验收。既有 Vite 大 chunk 和 Electron console-message 弃用提示仍在。
- 完整后端基线为此前同日目录/MCP 解耦回归：1462 pass / 2 skip / 0 fail，10191 断言、220 文件；/private/tmp/axon-loop-independent-full.log。两项需显式解释器配置的 Zima 专项跳过，不当作本轮全仓重跑结果。

## 后续起点

- 本轮仅改目录和 MCP 表单交互；可直接新建 Loop 测试，既有权限边界不放宽。
- 等用户明确下一需求，不自动扩展模板、Zima Loop、常驻、项目互斥或其他暂不实现项。
