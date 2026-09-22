import * as React from 'react'
import { useAtomValue } from 'jotai'
import { AlertCircle, MessageSquare } from 'lucide-react'
import { chatStateAtom } from '@/atoms/chat-state'
import { ChatHeader } from './ChatHeader'
import { useChatController } from './ChatStateProvider'
import { ChatMessages } from './ChatMessages'
import { ChatInput } from './ChatInput'
import { QuickConversationLayout, type QuickConversationLayoutOptions } from '@/components/app-shell/QuickConversationLayout'
import { QuickComposer } from '@/components/app-shell/QuickComposer'

/** Chat 页面按“元数据、消息流、输入动作”三段组合，状态与副作用仍由控制器统一管理。 */
export function ChatViewShell({ conversationId, quick }: { conversationId: string; quick?: QuickConversationLayoutOptions & { onSent: () => void } }): React.ReactElement {
  const controller = useChatController()
  const state = useAtomValue(chatStateAtom)
  const conversation = state.conversations.find((item) => item.id === conversationId)

  React.useEffect(() => {
    if (conversation) void controller.loadMessages(conversation.id)
  }, [controller, conversation?.id])

  if (!conversation) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <MessageSquare size={28} />
        <p className="text-sm text-foreground">对话不存在或已删除</p>
      </div>
    )
  }

  const error = state.lastError?.scope === 'generation' && state.lastError.conversationId === conversation.id
    ? state.lastError.message : undefined
  if (quick) return <QuickConversationLayout
    options={{ ...quick, title: conversation.title }}
    context={<ChatMessages conversationId={conversation.id} />}
    composer={<>
      {quick.expanded && error && <div className="mx-4 mt-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</div>}
      <QuickComposer key={quick.resetEpoch} sessionType="chat" sessionId={conversation.id} expanded={quick.expanded} onSent={quick.onSent} />
    </>}
  />

  return (
    <div className="flex h-full min-h-0 flex-col bg-[hsl(var(--tab-surface))]">
      <ChatHeader conversation={conversation} />
      {state.lastError?.scope === 'generation' && state.lastError.conversationId === conversation.id && (
        <div className="mx-4 mt-3 flex shrink-0 items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <AlertCircle size={14} />
          {state.lastError.message}
        </div>
      )}
      <ChatMessages conversationId={conversation.id} />
      <ChatInput conversation={conversation} />
    </div>
  )
}
