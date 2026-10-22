import * as React from 'react'
import type { AgentInputAttachment, AgentInputPart } from '@axon/shared'

/** 历史/排队按保存的中立顺序渲染；仅使用当时名称，不重新发现或加载 Skill。 */
export function AgentInputText({ text, parts, attachments = [] }: {
  text: string
  parts?: readonly AgentInputPart[]
  attachments?: readonly AgentInputAttachment[]
}): React.ReactElement {
  if (!parts) return <>{text}</>
  const skills = new Map(attachments.filter((item) => item.kind === 'skill').map((item) => [item.id, item.name]))
  return <>{parts.map((part, index) => part.type === 'text' ? <React.Fragment key={index}>{part.text}</React.Fragment>
    : <span key={index} data-agent-skill-reference={part.attachmentId}
      className="mx-0.5 inline-block rounded-full border border-border bg-muted/60 px-1.5 align-baseline text-xs leading-5">
      ${skills.get(part.attachmentId) ?? '[Skill 引用缺失]'}
    </span>)}</>
}
