import { MAX_AGENT_ATTACHMENTS } from './types/agent-attachment'
import type { AgentInputAttachment, AgentInputPart } from './types/agent-attachment'

/** 传输边界复制并校验顺序片段；正文必须逐字一致，不允许额外正文或无限片段。 */
export function parseAgentInputParts(value: unknown, text: string): AgentInputPart[] | undefined {
  if (value === undefined) return
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_AGENT_ATTACHMENTS * 2 + 1) throw new Error('消息输入片段数量无效')
  const parts: AgentInputPart[] = []
  let textLength = 0
  for (let index = 0; index < value.length; index += 1) {
    const part: unknown = value[index]
    if (!part || typeof part !== 'object' || Array.isArray(part)) throw new Error('消息输入片段格式无效')
    const input = part as Record<string, unknown>
    if (input.type === 'text' && typeof input.text === 'string' && Object.keys(input).every((key) => ['type', 'text'].includes(key))) {
      textLength += input.text.length
      if (textLength > text.length) throw new Error('消息片段与原始正文不一致')
      parts.push({ type: 'text', text: input.text })
    } else if (input.type === 'skill' && typeof input.attachmentId === 'string' && input.attachmentId.length > 0
      && input.attachmentId.length <= 200 && Object.keys(input).every((key) => ['type', 'attachmentId'].includes(key))) {
      parts.push({ type: 'skill', attachmentId: input.attachmentId })
    } else throw new Error('消息输入片段格式无效')
  }
  if (parts.filter((part) => part.type === 'text').map((part) => part.text).join('') !== text) throw new Error('消息片段与原始正文不一致')
  return parts
}

/** 接管/派发核对完整对应关系；不能引用其他草稿、文件附件、重复项或漏掉已选 Skill。 */
export function validateAgentInputPartReferences(parts: readonly AgentInputPart[] | undefined, attachments: readonly AgentInputAttachment[]): void {
  const selected = new Set(attachments.filter((item) => item.kind === 'skill').map((item) => item.id))
  const seen = new Set<string>()
  for (const part of parts ?? []) {
    if (part.type !== 'skill') continue
    if (!selected.has(part.attachmentId) || seen.has(part.attachmentId)) throw new Error('Skill 片段必须唯一引用当前草稿中的所选 Skill')
    seen.add(part.attachmentId)
  }
  if (seen.size !== selected.size) throw new Error('消息片段遗漏了当前草稿中的 Skill')
}

/** 队列摘要和复制按当时名称展开行内引用，不重读 Skill 文件。 */
export function agentInputDisplayText(text: string, parts?: readonly AgentInputPart[], attachments: readonly AgentInputAttachment[] = []): string {
  if (!parts) return text
  const skills = new Map(attachments.filter((item) => item.kind === 'skill').map((item) => [item.id, item.name]))
  return parts.map((part) => part.type === 'text' ? part.text : `$${skills.get(part.attachmentId) ?? '[Skill 引用缺失]'}`).join('')
}

/** 模型与语义恢复使用有界标记区分引用边界；完整指引仍来自当时加载的附件上下文。 */
export function agentInputPromptText(text: string, parts?: readonly AgentInputPart[], attachments: readonly AgentInputAttachment[] = []): string {
  if (!parts) return text
  const skills = new Map(attachments.filter((item) => item.kind === 'skill').map((item) => [item.id, item.name]))
  return parts.map((part) => part.type === 'text' ? part.text
    : `【Skill ${JSON.stringify({ attachmentId: part.attachmentId, name: skills.get(part.attachmentId) ?? '引用缺失' })}】`).join('')
}
