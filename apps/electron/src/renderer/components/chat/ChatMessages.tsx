import * as React from 'react'
import { useAtomValue } from 'jotai'
import { AlertCircle, Bot, Check, Copy, Keyboard, Loader2, Paperclip, Wrench } from 'lucide-react'
import type { ChatContentBlock, ChatMessage } from '@axon/shared'
import {
  chatStateAtom,
  type StreamingChatBlock,
  type StreamingChatGeneration,
} from '@/atoms/chat-state'
import { userProfileAtom } from '@/atoms/user-profile'
import { cn } from '@/lib/utils'
import { formatAttachmentSize } from '@/lib/chat-attachment'
import { contentBlocksToPlainText } from '@/lib/chat-message'
import { MarkdownText } from './MarkdownText'

function UserAvatar(): React.ReactElement {
  const profile = useAtomValue(userProfileAtom)
  return profile.avatar.startsWith('data:image/') ? (
    <img src={profile.avatar} alt={profile.userName} className="h-7 w-7 rounded-md object-cover" />
  ) : (
    <span className="flex h-7 w-7 items-center justify-center rounded-md bg-muted text-sm">{profile.avatar}</span>
  )
}

function ContentBlock({ block }: { block: ChatContentBlock | StreamingChatBlock }): React.ReactElement {
  if (block.type === 'text') {
    return <MarkdownText>{block.text}</MarkdownText>
  }
  if (block.type === 'reasoning') {
    return (
      <details className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none">思考过程{('complete' in block && !block.complete) ? '（生成中）' : ''}</summary>
        <p className="mt-2 whitespace-pre-wrap break-words leading-5">{block.text || '…'}</p>
      </details>
    )
  }
  if (block.type === 'tool_call') {
    return (
      <div className="rounded-md border bg-muted/30 p-3 text-xs">
        <div className="mb-2 flex items-center gap-1.5 font-medium"><Wrench size={13} />调用 {block.name}</div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all text-muted-foreground">{block.arguments || '正在接收参数…'}</pre>
      </div>
    )
  }
  return (
    <div className={cn('rounded-md border p-3 text-xs', block.isError && 'border-destructive/50 text-destructive')}>
      <div className="mb-2 font-medium">工具结果：{block.name}</div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all">{block.output}</pre>
    </div>
  )
}

function MessageItem({ message }: { message: ChatMessage }): React.ReactElement {
  const isUser = message.role === 'user'
  const [copied, setCopied] = React.useState(false)
  const copyTimerRef = React.useRef<number | undefined>(undefined)

  React.useEffect(() => () => {
    if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current)
  }, [])

  /** 复制结构化消息的可见内容；签名等内部字段由转换层主动排除。 */
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(contentBlocksToPlainText(message.content, message.attachments))
      setCopied(true)
      if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current)
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  return (
    <article className={cn('group/message flex gap-3', isUser && 'flex-row-reverse')}>
      {isUser ? <UserAvatar /> : (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground"><Bot size={15} /></span>
      )}
      <div className={cn('min-w-0 max-w-[85%] space-y-2', isUser && 'rounded-xl bg-muted px-3 py-2')}>
        {(message.attachments?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {message.attachments?.map((attachment) => (
              <span
                key={attachment.id}
                className="flex items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground"
                title={attachment.filename}
              >
                <Paperclip size={10} />
                <span className="max-w-48 truncate">{attachment.filename}</span>
                <span>{formatAttachmentSize(attachment.size)}</span>
              </span>
            ))}
          </div>
        )}
        {message.content.map((block, index) => <ContentBlock key={`${message.id}-${index}`} block={block} />)}
        {message.status !== 'complete' && (
          <p className={cn('flex items-center gap-1 text-xs', message.status === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
            {message.status === 'error' && <AlertCircle size={12} />}
            {message.status === 'error' ? message.error ?? '生成失败' : '生成已停止'}
          </p>
        )}
        <div className="flex items-center gap-2">
        {isUser && message.inputOrigin === 'quick' && <span aria-label="快捷输入" title="通过全局快捷键输入" className="text-muted-foreground"><Keyboard size={11} /></span>}
        <button
          type="button"
          aria-label="复制消息"
          onClick={() => void copy()}
          className={cn(
            'flex items-center gap-1 text-[11px] text-muted-foreground opacity-70 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/message:opacity-100',
            copied && 'opacity-100',
          )}
          title="复制消息"
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? '已复制' : '复制'}
        </button>
        </div>
      </div>
    </article>
  )
}

function StreamingMessage({ generation }: { generation?: StreamingChatGeneration }): React.ReactElement {
  return (
    <article className="flex gap-3">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground"><Bot size={15} /></span>
      <div className="min-w-0 max-w-[85%] space-y-2">
        {generation?.blocks.map((block, index) => (
          <ContentBlock key={`${generation.generationId}-${index}`} block={block} />
        ))}
        {!generation || generation.blocks.length === 0 ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 size={13} className="animate-spin" />正在连接模型…</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"><Loader2 size={11} className="animate-spin" />生成中</span>
        )}
      </div>
    </article>
  )
}

/** 合并 JSONL 完整消息与内存流式草稿，并在用户停留底部时跟随新内容。 */
export function ChatMessages({ conversationId }: { conversationId: string }): React.ReactElement {
  const state = useAtomValue(chatStateAtom)
  const messages = state.messagesByConversation[conversationId] ?? []
  const status = state.messageStatusByConversation[conversationId] ?? 'idle'
  const generation = state.generationsByConversation[conversationId]
  const sending = state.sendingByConversation[conversationId] === true
  const scrollerRef = React.useRef<HTMLDivElement>(null)
  const followOutputRef = React.useRef(true)

  React.useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (scroller && followOutputRef.current) scroller.scrollTop = scroller.scrollHeight
  }, [generation, messages])

  if (status === 'loading' && messages.length === 0) {
    return <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">正在读取本地消息…</div>
  }
  if (status === 'error' && messages.length === 0) {
    return <div className="flex flex-1 items-center justify-center text-xs text-destructive">读取消息失败</div>
  }

  return (
    <div
      ref={scrollerRef}
      onScroll={(event) => {
        const element = event.currentTarget
        followOutputRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96
      }}
      className="min-h-0 flex-1 overflow-y-auto px-4 py-6"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        {messages.length === 0 && !sending ? (
          <div className="flex min-h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
            <Bot size={28} />
            <p className="text-sm text-foreground">开始一段新对话</p>
            <p className="text-xs">消息会保存在本地</p>
          </div>
        ) : messages.map((message) => <MessageItem key={message.id} message={message} />)}
        {sending && <StreamingMessage generation={generation} />}
      </div>
    </div>
  )
}
