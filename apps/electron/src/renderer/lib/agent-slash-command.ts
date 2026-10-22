import type { JSONContent } from '@tiptap/react'
import type { AgentSkillChoice } from '@axon/shared'

export interface AgentLocalCommand { name: 'skills'; description: string }
export const AGENT_LOCAL_COMMANDS: readonly AgentLocalCommand[] = [
  { name: 'skills', description: '选择本轮使用的 Skill' },
]
export interface AgentSlashInput {
  name: string
  arguments: string
  from: number
  to: number
  lineEnd: number
}
export type AgentSlashResolution = { kind: 'command'; command: AgentLocalCommand }
  | { kind: 'error'; message: string }
export type AgentSlashCandidate = { kind: 'command'; command: AgentLocalCommand }
  | { kind: 'skill'; skill: AgentSkillChoice }

/** 命令与后端发现的 Skill 共用候选；逐字过滤只读摘要，不加载指引正文。 */
export function matchAgentSlashCandidates(input: AgentSlashInput, skills: readonly AgentSkillChoice[]): AgentSlashCandidate[] {
  if (input.arguments) return []
  const query = input.name.toLowerCase()
  return [
    ...matchAgentLocalCommands(input).map((command): AgentSlashCandidate => ({ kind: 'command', command })),
    ...skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(query))
      .map((skill): AgentSlashCandidate => ({ kind: 'skill', skill })),
  ]
}

/** 只识别文档首行的独立命令；路径分隔符、文件后缀、正文前缀及行内 Skill 不作为命令。 */
export function readAgentSlashInput(document: JSONContent): AgentSlashInput | undefined {
  const paragraph = document.content?.[0]
  if (paragraph?.type !== 'paragraph') return
  let line = '', hardBreak = false
  for (const node of paragraph.content ?? []) {
    if (node.type === 'hardBreak') { hardBreak = true; break }
    if (node.type !== 'text') return
    line += node.text ?? ''
  }
  const match = /^\/([\p{L}\p{N}_-]*)(?:[ \t]+([^\r\n]*))?$/u.exec(line)
  if (!match) return
  const wholeParagraph = !hardBreak && (document.content?.length ?? 0) > 1
  return { name: match[1]!, arguments: (match[2] ?? '').trim(), from: wholeParagraph ? 0 : 1,
    to: line.length + (hardBreak || wholeParagraph ? 2 : 1), lineEnd: line.length + 1 }
}

export function matchAgentLocalCommands(input: AgentSlashInput): readonly AgentLocalCommand[] {
  return input.arguments ? [] : AGENT_LOCAL_COMMANDS.filter((command) => command.name.startsWith(input.name))
}

/** 提交入口统一先分发本地动作；未完成/未知/不支持参数时保留草稿，绝不静默交给模型。 */
export function resolveAgentSlashCommand(input: AgentSlashInput, acceptCompletion: boolean): AgentSlashResolution {
  const exact = AGENT_LOCAL_COMMANDS.find((command) => command.name === input.name)
  if (exact && input.arguments) return { kind: 'error', message: '/skills 不接收参数，请在选择器中搜索 Skill' }
  const command = exact ?? (acceptCompletion ? matchAgentLocalCommands(input)[0] : undefined)
  return command ? { kind: 'command', command }
    : { kind: 'error', message: input.name ? `未知本地命令 /${input.name}，可用 /skills` : '请选择本地命令' }
}
