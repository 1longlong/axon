import type { JSONContent } from '@tiptap/react'

export interface AgentComposerSkill { sourceId: string; name: string }
export type AgentComposerPart = { type: 'text'; text: string } | { type: 'skill'; sourceId: string }
export interface AgentComposerValue { text: string; skills: AgentComposerSkill[]; parts: AgentComposerPart[] }

/** 从编辑文档提取原文、去重选择与顺序片段；胶囊名称不混进正文，来源稍后物化为草稿 ID。 */
export function readAgentComposerDocument(document: JSONContent): AgentComposerValue {
  const skills: AgentComposerSkill[] = []
  const parts: AgentComposerPart[] = []
  const sources = new Set<string>()
  const appendText = (text: string): void => {
    if (!text) return
    const previous = parts.at(-1)
    if (previous?.type === 'text') previous.text += text
    else parts.push({ type: 'text', text })
  }
  for (const [index, paragraph] of (document.content ?? []).entries()) {
    if (index) appendText('\n')
    for (const node of paragraph.content ?? []) {
      if (node.type === 'text') appendText(node.text ?? '')
      else if (node.type === 'hardBreak') appendText('\n')
      else if (node.type === 'agentSkill' && typeof node.attrs?.sourceId === 'string' && typeof node.attrs.name === 'string') {
        parts.push({ type: 'skill', sourceId: node.attrs.sourceId })
        if (!sources.has(node.attrs.sourceId)) {
          sources.add(node.attrs.sourceId)
          skills.push({ sourceId: node.attrs.sourceId, name: node.attrs.name })
        }
      }
    }
  }
  return { text: parts.filter((part) => part.type === 'text').map((part) => part.text).join(''), skills, parts }
}

/** 插入/粘贴只接收纯文字，不将剪贴板 HTML 解析成可执行的 Skill 引用。 */
export function agentComposerTextNodes(text: string): JSONContent[] {
  return text.split('\n').flatMap((line, index) => [
    ...(index ? [{ type: 'hardBreak' }] : []),
    ...(line ? [{ type: 'text', text: line }] : []),
  ])
}
