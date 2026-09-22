/** Agent 计划模式的受管提示词。 */

import type { AgentPermissionMode } from '@axon/shared'

const PLAN_MODE_SYSTEM_PROMPT = `## 计划模式
当前轮只用于理解需求、检查项目和制定实施计划。
- 可以读取、搜索和分析已有内容，也可以向用户追问必要信息。
- 不要创建、修改或删除文件，不要执行会改变工作区、Git、依赖、进程或外部系统状态的操作。
- 调研充分后必须调用 ExitPlanMode 提交完整计划，明确关键改动、上下游影响、预期副作用和主要验证方式，并等待用户审批。
- 用户反馈后继续保持只读，修改计划并再次调用 ExitPlanMode；只有审批通过后才能实施。
- 不要声称尚未实施的改动已经完成。`

/** 每轮构造 prompt 时追加模式约束；该内容只下发 runtime，不进入用户消息历史。 */
export function buildPlanModeSystemPrompt(
  basePrompt: string,
  permissionMode: AgentPermissionMode,
): string {
  return permissionMode === 'plan'
    ? [basePrompt.trim(), PLAN_MODE_SYSTEM_PROMPT].filter(Boolean).join('\n\n')
    : basePrompt.trim()
}
