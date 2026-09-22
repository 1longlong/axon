/** 按会话实际可用的内置工具，补足自定义 system prompt 不包含的工具使用指引。 */

import type { AgentSubagentType } from '@axon/shared'

const READ_GUIDANCE = `## 文件与命令工具
- 已知文件路径且需要查看正文时，优先调用 read；大文件用 offset/limit 分段读取。不要默认用 bash 的 cat、sed、head 或 tail 代替普通文件读取。
- 读取项目指令 AGENTS.md 或 Skill 的 SKILL.md 时也使用 read，以便加载对应的上下文规则。`

const READ_ONLY_GUIDANCE = `## 文件工具
- 已知文件路径且需要查看正文时，优先调用 read；大文件用 offset/limit 分段读取。
- 读取项目指令 AGENTS.md 或 Skill 的 SKILL.md 时也使用 read，以便加载对应的上下文规则。`

const BASH_SEARCH_GUIDANCE = `
- 当前没有独立的文件搜索或目录列表工具；查找路径用 bash 执行 rg --files 或 find，搜索内容用 rg -n，列目录用 ls。不要因为 bash 能运行 cat，就把它当作读取普通文件的默认工具。`

const BASH_EXEC_GUIDANCE = `
- bash 还用于运行测试、构建、Git 命令及其他确实需要 shell 的操作；命令输出或 read 无法处理的特殊内容也可通过 bash 查看。`

const EDIT_GUIDANCE = `
- 修改已有文件优先用 edit 做精确替换；创建文件或完整替换内容用 write。需要运行脚本、批量生成或验证结果时再使用 bash。`

/** 上游按会话角色选择工具；本段随系统提示词下发，避免要求模型调用未注册的工具。 */
export function buildAgentToolGuidance(subagentType?: AgentSubagentType): string {
  if (subagentType === 'plan') return READ_ONLY_GUIDANCE
  if (subagentType === 'explore') return READ_GUIDANCE + BASH_SEARCH_GUIDANCE
  return READ_GUIDANCE + BASH_SEARCH_GUIDANCE + BASH_EXEC_GUIDANCE + EDIT_GUIDANCE
}
