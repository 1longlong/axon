import type { SDKAssistantMessage, SDKContentBlock, SDKMessage, SDKToolUseBlock, SDKUserMessage } from '@axon/shared'
import { isAgentUserStoppedResult } from './agent-message'

export interface AgentTurnBlock {
  kind: 'block'
  key: string
  block: SDKContentBlock
  isStreaming: boolean
}

export interface AgentActivityGroup {
  kind: 'activity'
  key: string
  items: AgentTurnBlock[]
  closed: boolean
  /** 中断只停止动画，尾组保留中断前的展开选择。 */
  interrupted?: boolean
}

export interface AgentTurnNotice {
  kind: 'notice'
  key: string
  message: SDKMessage
}

export type AgentTurnPart = AgentTurnBlock | AgentActivityGroup | AgentTurnNotice

interface GroupOptions {
  running: boolean
  streamingAssistantUuid?: string
  hideToolResult?: (toolUseId: string) => boolean
}

/** 仅生成轮内显示投影：相邻思考/工具跨消息累积，正文或终态关闭活动组，原历史不变。 */
export function groupAgentActivities(messages: readonly SDKMessage[], options: GroupOptions): AgentTurnPart[] {
  const parts: AgentTurnPart[] = []
  const resumedResults = new Set(messages.filter((message) => message.type === 'system' && message.subtype === 'axon_continued')
    .map((message) => (message as { stopped_result_uuid?: string }).stopped_result_uuid).filter(Boolean))
  let activity: AgentActivityGroup | undefined
  const flush = (closed: boolean, interrupted = false): void => {
    if (!activity) return
    activity.closed = closed
    if (interrupted) activity.interrupted = true
    parts.push(activity)
    activity = undefined
  }

  for (const [messageIndex, message] of messages.entries()) {
    const uuid = (message as { uuid?: unknown }).uuid
    const messageKey = typeof uuid === 'string' ? uuid : `message-${messageIndex}`
    if (message.type === 'assistant') {
      const content = (message as SDKAssistantMessage).message.content
      for (const [blockIndex, block] of content.entries()) {
        // 空的流式起始块不是正文边界，不能让正在进行的活动提前收起。
        if (block.type === 'unknown') continue
        if (block.type === 'text' && !String(block.text ?? '').trim()) continue
        if (block.type === 'thinking' && !String(block.thinking ?? '').trim()) continue
        const item: AgentTurnBlock = {
          kind: 'block', key: `${messageKey}-${blockIndex}`, block,
          isStreaming: options.streamingAssistantUuid !== undefined
            && message.uuid === options.streamingAssistantUuid && blockIndex === content.length - 1,
        }
        if (block.type === 'thinking' || block.type === 'tool_use') {
          activity ??= { kind: 'activity', key: item.key, items: [], closed: false }
          activity.items.push(item)
        } else {
          flush(true)
          parts.push(item)
        }
      }
    } else if (message.type === 'user') {
      const results = ((message as SDKUserMessage).message?.content ?? [])
        .filter((block) => block.type === 'tool_result' && !options.hideToolResult?.(String(block.tool_use_id ?? '')))
      // 已关联的回传仍显示在原工具行；不以回传消息打断跨 API 请求的活动。
      if (results.length > 0) {
        flush(true)
        parts.push({ kind: 'notice', key: messageKey, message: { ...message, message: { content: results } } })
      }
    } else if (message.type === 'result' && !message.isSyntheticCompactionResult) {
      // 同轮已继续的旧停止不再切断连续活动；尚未继续的尾停止仍保持原显示。
      if (isAgentUserStoppedResult(message) && typeof message.uuid === 'string' && resumedResults.has(message.uuid)) continue
      const interrupted = isAgentUserStoppedResult(message)
      flush(true, interrupted)
      if (message.subtype !== 'success' && !interrupted) parts.push({ kind: 'notice', key: messageKey, message })
    } else if (message.type === 'system' && message.subtype === 'permission_denied') {
      flush(true)
      parts.push({ kind: 'notice', key: messageKey, message })
    }
  }
  // 停止/连接失效可能没有普通正文；没有活跃运行的历史尾组也要收束。
  flush(!options.running)
  return parts
}

/** 用真实调用与路径生成轻量摘要；不推测工具行为或为每次渲染重新调用模型。 */
export function summarizeAgentActivity(group: AgentActivityGroup): string {
  let thinking = 0
  let readsWithoutPath = 0
  let commands = 0
  let searches = 0
  let other = 0
  const paths = new Set<string>()
  const toolIds = new Set<string>()
  for (const item of group.items) {
    if (item.block.type === 'thinking') {
      thinking += 1
      continue
    }
    const tool = item.block as SDKToolUseBlock
    const id = tool.id || item.key
    if (toolIds.has(id)) continue
    toolIds.add(id)
    if (tool.name === 'Read') {
      const path = tool.input?.file_path ?? tool.input?.path
      if (typeof path === 'string' && path.trim()) paths.add(path)
      else readsWithoutPath += 1
    } else if (tool.name === 'Bash') commands += 1
    else if (tool.name === 'Grep' || tool.name === 'Glob') searches += 1
    else other += 1
  }
  return [
    thinking ? `思考 ${thinking} 段` : '',
    paths.size ? `读取 ${paths.size} 个文件` : '',
    readsWithoutPath ? `文件读取 ${readsWithoutPath} 次` : '',
    searches ? `搜索 ${searches} 次` : '',
    commands ? `执行 ${commands} 条命令` : '',
    other ? `其他工具 ${other} 次` : '',
  ].filter(Boolean).join('，')
}
