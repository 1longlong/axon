import * as React from 'react'
import { Clock3, X } from 'lucide-react'
import type { AgentQueuedMessage } from '@axon/shared'
import { useAgentController } from './AgentStateProvider'

/** 将后端等待队列投影为输入区上方的单行胶囊；取消后用权威快照校准。 */
export function AgentMessageQueue({
  sessionId,
  messages,
}: {
  sessionId: string
  messages: readonly AgentQueuedMessage[]
}): React.ReactElement | null {
  const controller = useAgentController()
  if (messages.length === 0) return null

  return <div role="list" aria-label="等待发送的消息" className="mx-auto mb-1 flex w-full max-w-3xl shrink-0 flex-nowrap items-center gap-2 overflow-x-auto py-1">
    {messages.map((message) => <div key={message.id} role="listitem" data-queued-message={message.id}
      className="flex h-7 max-w-64 shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted/30 pl-2.5 pr-1 text-xs text-muted-foreground">
      <Clock3 size={12} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 truncate" title={message.text}>{message.text}</span>
      <button type="button" aria-label="取消等待消息" title="取消这条等待消息"
        onClick={() => void controller.cancelQueuedMessage({ sessionId, messageId: message.id })}
        className="flex size-5 shrink-0 items-center justify-center rounded-full hover:bg-muted hover:text-destructive"><X size={12} aria-hidden="true" /></button>
    </div>)}
  </div>
}
