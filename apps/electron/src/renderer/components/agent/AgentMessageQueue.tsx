import * as React from 'react'
import { ArrowDown, ArrowUp, Clock3, X } from 'lucide-react'
import type { AgentQueuedMessage } from '@axon/shared'
import { useAgentController } from './AgentStateProvider'

/** 展示主进程权威等待队列；排序和取消成功后仍由新快照校准 UI。 */
export function AgentMessageQueue({
  sessionId,
  messages,
}: {
  sessionId: string
  messages: readonly AgentQueuedMessage[]
}): React.ReactElement | null {
  const controller = useAgentController()
  if (messages.length === 0) return null

  const move = (index: number, direction: -1 | 1): void => {
    const source = messages[index]
    const target = messages[index + direction]
    if (!source || !target) return
    void controller.moveQueuedMessage({
      sessionId,
      sourceId: source.id,
      targetId: target.id,
      placement: direction < 0 ? 'before' : 'after',
    })
  }

  return <div className="mx-auto mb-2 max-w-3xl rounded-lg border bg-muted/20 px-3 py-2">
    <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <Clock3 size={12} />等待发送 · {messages.length}
    </div>
    <div className="space-y-1">
      {messages.map((message, index) => <div key={message.id} className="flex min-w-0 items-center gap-1 rounded bg-background/70 px-2 py-1.5 text-xs">
        <span className="min-w-0 flex-1 truncate" title={message.text}>{message.text}</span>
        <button type="button" aria-label="上移等待消息" disabled={index === 0} onClick={() => move(index, -1)} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-25"><ArrowUp size={12} /></button>
        <button type="button" aria-label="下移等待消息" disabled={index === messages.length - 1} onClick={() => move(index, 1)} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-25"><ArrowDown size={12} /></button>
        <button type="button" aria-label="取消等待消息" onClick={() => void controller.cancelQueuedMessage({ sessionId, messageId: message.id })} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"><X size={12} /></button>
      </div>)}
    </div>
  </div>
}
