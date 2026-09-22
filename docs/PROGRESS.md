# Axon 当前进度

> 本文件只保留当前可执行状态，不保存历史流水。新会话结合根目录 `../AGENTS.md` 与同目录 `axon-project-design.md` 继续。

## 当前状态

- 核心迭代按 `../AGENTS.md` 清单推进；当前不实施的能力统一收口至 `axon-project-design.md` 文末的“可扩展功能迭代”。
- 迭代 18“全局快捷唤起现有会话”的核心功能与浮窗交互已实现；自动化测试、构建和 smoke 已通过，仍未执行该迭代专属的真实 GUI 端到端冒烟。
- Agent 会话 Runtime 切换已归入可扩展功能，暂不实施。
- 迭代 20“ToolSearch 与工具懒加载”已完成：仅 Pi 下官方 Anthropic Messages tool reference 与明确支持的 OpenAI Responses 模型启用；其他协议和 runtime 保持 MCP eager。
- 迭代 21“多级 Skills 与 Axon 管理安装”已完成，版本为 `0.1.3`。当前 catalog provider 真实返回空目录，远程、市场和账号来源按计划后置。
- Pi 是新会话默认 runtime；Zima 已接入独立 artifact、恢复、工具权限、停止、压缩摘要和 thinking。受控 Python 分发仍待完成；Zima 子目录 AGENTS.md 自动加载受协议限制，当前标记为 manual。
- Chat 不使用 Agent 系统提示词；Agent 使用全局选择的提示词预设。开发阶段配置与持久化格式变更不维护旧版本兼容。
- 工程约定、核心设计文档和代码注释现只描述 Axon 自身与现行实现，不保留外部项目来源或仓库路径说明。
- 核心设计文档已更名为 `axon-project-design.md`；核心迭代与暂不实现的扩展能力已分区，扩展部分只保留精简能力描述。
- 根目录 README 已调整为面向最终用户的产品说明，聚焦功能、启动、Runtime、项目能力、隐私和当前限制；开发架构与实施细节保留在设计文档。`.gitignore` 已覆盖 Bun/Electron/Vite 的常见本地产物，同时保持项目级 `.axon/skills` 和 `.agents/skills` 可提交。
- 除 `README.md` 与 `AGENTS.md` 外，项目 Markdown 文档已统一归档到 `docs/`，相关工程约定和 README 链接已同步更新。
- 清理了不再使用的项目元数据字段和相关说明。
- 发布链现状已核对：当前目录尚未初始化 Git，系统未安装 GitHub CLI，应用只有 production build、尚无安装包和 GitHub Release 配置；后续按“仓库初始化 → 安装包 → Release 下载”分阶段实施。

## 迭代 21 最终实现

- 发现顺序固定为：项目 `.axon/skills` > 项目 `.agents/skills` > `$HOME/.axon/skills` > `$HOME/.agents/skills`；同名低优先级定义保留为遮蔽诊断，不进入模型。
- 四类 Skill 正文与引用文件统一由中立宿主工具 `SkillRead` 读取。工具拒绝绝对路径、路径穿越、符号链接逃逸、超限/二进制文件和未入选来源；只有成功读取 `SKILL.md` 才记录激活。
- 主 Agent 与子 Agent 使用同一份有效 Skill 目录和 `SkillRead`，普通 Read/Bash 的工作区边界没有放宽。
- Axon 管理安装目标固定为 `$HOME/.axon/skills`；安装包先验证名称、版本、哈希、frontmatter、路径、数量和大小，再同目录暂存并原子替换。实际安装清单与设置中的期望 catalog ID 独立持久化，支持修复、更新、卸载和失败回滚。
- 设置链路为 shared DTO/IPC 常量 → main controller/handler → preload → renderer。Agent 设置页展示可安装项、逐项结果及全局发现的有效/被覆盖来源；通用 settings IPC 不能绕过安装服务修改选择。

## 当前架构

- 可插拔边界：编排、持久化和 renderer 只依赖 `AgentProviderAdapter` 与中立 `SDKMessage`；runtime SDK、session artifact 查找和 runtime 工具 shape 只能出现在对应 adapter 与唯一生产装配入口。
- 主进程：`main/ipc.ts` 只装配领域 registrar；`main/lib` 按 core/settings/desktop/chat/channel/agent/project/memory/collaboration/mcp 分域。
- shared Agent 契约：消息、会话、运行事件、IPC 和 Skill 安装契约分别维护，中立层不依赖 Pi/Zima 私有类型。
- Agent renderer：`agent-state-model.ts` → `agent-event-reducer.ts` → `agent-renderer-controller.ts`；Chat 保持独立状态机。

## 当前验证基线

2026-09-21 迭代 21 集中验收：

- 全仓测试：480 项通过、0 失败、1714 次断言。
- 全仓 typecheck 通过。
- production build 通过；仅有既有 renderer 大 chunk 提示。
- Desktop、Channel、Chat、Agent 四个真实 Electron smoke 全部通过。
- Agent smoke 覆盖项目工作区、Skills、MCP、记忆、子 Agent、用量、Diff、流式消息和重载恢复；同步更新了 MCP“保存后保持弹窗、由 X 关闭”的当前交互断言。
- 真实开发版 GUI 验证通过：Agent 设置页正确显示空 catalog，并发现 `$HOME/.agents/skills` 中的用户级 Skill，来源和有效状态正确；验证过程未修改用户配置。

## 当前关键决定

- 不实现会话分叉、回退、跨项目移动、运行中消息注入和同项目并发互斥。
- Chat 暂不接工具；Agent 提供工具、Skills、MCP、项目指令、记忆和子 Agent。
- 项目必须有工作区；未选择本地目录时使用应用管理目录。项目下会话共享唯一工作区。
- 记忆只提供给 Agent，并由项目级开关控制；每轮只扫描 memory 文件元信息。
- 可扩展功能统一标记为暂不实现；只有用户明确恢复后才重新拆分范围和实施计划。
- 重要流程函数保留简洁中文函数级注释，复杂阶段只注释顺序、契约和失败边界。

## 下一步

迭代 21 已收尾。下一轮由用户决定：

1. 回到迭代 18 专属 GUI 端到端验收；或
2. 开始新的核心功能迭代；或
3. 明确恢复某项可扩展功能后，再建立对应实施计划。
