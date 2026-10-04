import * as React from 'react'
import { AlertCircle, Check, ChevronDown, Circle, Copy, Keyboard, Loader2, Wrench } from 'lucide-react'
import type { SDKAssistantMessage, SDKContentBlock, SDKMessage, SDKResultMessage, SDKSystemMessage, SDKToolResultBlock, SDKToolUseBlock, SDKUserMessage } from '@axon/shared'
import { cn } from '@/lib/utils'
import { MarkdownText } from '@/components/chat/MarkdownText'
import { ThinkingBlock } from '@/components/chat/ThinkingBlock'
import { agentMessageText, stringifyAgentContent } from '@/lib/agent-message'

function resolveMessageDate(createdAt: number | undefined): Date | undefined {
  if (createdAt === undefined || !Number.isFinite(createdAt) || createdAt < 0) return undefined
  const date = new Date(createdAt)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function formatMessageTime(date: Date | undefined): string {
  if (!date) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

function MessageMeta({ message, align, copyText }: { message: SDKMessage; align: 'left' | 'right'; copyText?: string }): React.ReactElement {
  const [copied, setCopied] = React.useState(false)
  const timerRef = React.useRef<number>()
  const text = copyText ?? agentMessageText(message)
  const date = resolveMessageDate(message.createdAt)
  const time = formatMessageTime(date)
  const quickOrigin = message.type === 'user' && (message as SDKUserMessage).inputOrigin === 'quick'

  React.useEffect(() => () => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
  }, [])

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => setCopied(false), 1_600)
    } catch { setCopied(false) }
  }

  if (!text && !time && !quickOrigin) return <></>
  return <div className={cn('flex h-5 items-center gap-2 px-2 font-mono text-[11px] text-muted-foreground', align === 'right' && 'justify-end')}>
    {quickOrigin && <span aria-label="快捷输入" title="通过全局快捷键输入"><Keyboard size={11} /></span>}
    {time && <time dateTime={date?.toISOString()}>{time}</time>}
    {text && <button
      type="button"
      aria-label="复制消息"
      title="复制消息"
      onClick={() => void copy()}
      className={cn(
        'flex items-center gap-1 rounded px-1 py-0.5 opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover/message:opacity-100 motion-reduce:transition-none',
        align === 'right' && 'order-first mr-auto',
        copied && 'opacity-100',
      )}
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}{copied ? '已复制' : '复制'}
    </button>}
  </div>
}

function textFromUser(message: SDKMessage): string {
  if (message.type !== 'user') return ''
  return ((message as SDKUserMessage).message?.content ?? [])
    .map((block) => block.type === 'text' ? block.text : '').join('')
}

function ToolResult({ block }: { block: SDKToolResultBlock }): React.ReactElement {
  const result = stringifyAgentContent(block.content)
  return <details className={cn('group/result min-w-0 rounded-[8px] border text-xs shadow-xs', block.is_error ? 'border-destructive/40 text-destructive' : 'border-border bg-[hsl(var(--content-area))]')}>
    <summary className="cursor-pointer list-none rounded-[8px] px-3 py-1.5 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
      <div className="flex items-center gap-1.5 font-mono font-medium"><Wrench size={13} />工具结果<ChevronDown size={12} className="ml-auto text-muted-foreground transition-transform group-open/result:rotate-180 motion-reduce:transition-none" /></div>
      <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-all text-muted-foreground">{result || '无输出'}</p>
    </summary>
    <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all border-t border-border bg-muted/40 px-3 py-2 font-mono text-[11px] leading-5">{result || '无输出'}</pre>
  </details>
}

/** Bash 直接展示命令；其他工具展示最关键的目标，完整参数留在展开区。 */
function toolCallDetail(tool: SDKToolUseBlock): string {
  const input = tool.input ?? {}
  const detail = tool.name === 'Bash'
    ? input.command ?? input.cmd
    : input.file_path ?? input.path ?? input.pattern ?? input.query
  return typeof detail === 'string' ? detail.trim() : ''
}

/** 一个工具调用只占一行；进度与结果按 tool use id 关联，展开区随内容增长并限制最大高度。 */
function ToolCall({ tool, result, running }: { tool: SDKToolUseBlock; result?: SDKToolResultBlock; running: boolean }): React.ReactElement {
  const resultText = result ? stringifyAgentContent(result.content) : ''
  const name = tool.name || '工具调用'
  const detail = toolCallDetail(tool)
  const label = detail ? `${name} · ${detail}` : name
  return <details className={cn('group/tool min-w-0 rounded-[8px] border border-transparent text-xs open:border-border open:bg-[hsl(var(--content-area))] open:shadow-xs', result?.is_error && 'open:border-destructive/40')}>
    <summary aria-label={`工具调用 ${tool.name}`} className={cn('flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground hover:bg-muted/40 hover:text-foreground group-open/tool:rounded-b-none group-open/tool:border-b group-open/tool:border-border group-open/tool:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-details-marker]:hidden', result?.is_error && 'hover:bg-destructive/5')}>
      {running ? <Loader2 size={14} className="shrink-0 animate-spin text-muted-foreground" aria-label="执行中" />
        : result?.is_error ? <span className="flex size-3.5 shrink-0 items-center justify-center" role="img" aria-label="执行失败"><span className="size-1.5 rounded-full bg-destructive" /></span>
          : result ? <Check size={14} strokeWidth={2.5} className="shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="执行成功" />
            : <Circle size={14} className="shrink-0 text-muted-foreground" aria-label="暂无结果" />}
      <span className="flex min-w-0 flex-1 items-center font-mono" title={label}>
        <span className={cn('max-w-[50%] shrink-0 truncate font-semibold', result?.is_error ? 'text-destructive' : 'text-foreground')}>{name}</span>
        {detail && <><span aria-hidden="true" className="shrink-0 whitespace-pre text-muted-foreground/50">{' · '}</span><span className="min-w-0 truncate">{detail}</span></>}
      </span>
      <ChevronDown size={12} className="shrink-0 transition-transform group-open/tool:rotate-180 motion-reduce:transition-none" />
    </summary>
    <div className="max-h-56 space-y-3 overflow-auto p-3 font-mono text-[11px] leading-5">
      <section><p className="mb-1 flex items-center gap-2 font-medium text-muted-foreground">调用参数<span aria-hidden="true" className="h-px flex-1 bg-border" /></p><pre className="whitespace-pre-wrap break-all rounded border border-border bg-muted/40 p-2.5 text-muted-foreground">{JSON.stringify(tool.input ?? {}, null, 2)}</pre></section>
      <section><p className="mb-1 flex items-center gap-2 font-medium text-muted-foreground">执行结果<span aria-hidden="true" className="h-px flex-1 bg-border" /></p><pre className={cn('whitespace-pre-wrap break-all rounded border border-border bg-muted/40 p-2.5', result?.is_error ? 'text-destructive' : 'text-muted-foreground')}>{result ? (resultText || '无输出') : running ? '执行中…' : '暂无结果'}</pre></section>
    </div>
  </details>
}

function AssistantBlock({ block, renderToolUse, toolResultsById, activeToolUseIds, isStreaming }: {
  block: SDKContentBlock
  renderToolUse?: (block: SDKToolUseBlock) => React.ReactNode
  toolResultsById?: ReadonlyMap<string, SDKToolResultBlock>
  activeToolUseIds?: ReadonlySet<string>
  isStreaming?: boolean
}): React.ReactElement | null {
  if (block.type === 'text') return <div className="min-w-0 px-2 py-1"><MarkdownText children={String((block as { text?: unknown }).text ?? '')} /></div>
  if (block.type === 'thinking') return <ThinkingBlock text={String((block as { thinking?: unknown }).thinking ?? '')} isStreaming={isStreaming} />
  if (block.type === 'tool_use') {
    const tool = block as SDKToolUseBlock
    const custom = renderToolUse?.(tool)
    if (custom) return <>{custom}</>
    return <ToolCall tool={tool} result={toolResultsById?.get(tool.id)} running={activeToolUseIds?.has(tool.id) === true} />
  }
  if (block.type === 'unknown') return null
  return <pre className="overflow-x-auto whitespace-pre-wrap break-all px-2 font-mono text-xs text-muted-foreground">{JSON.stringify(block)}</pre>
}

const ERROR_CATEGORY_LABELS = {
  network: '网络错误', provider: '模型服务错误', protocol: '协议错误', context: '上下文超限',
  runtime: '运行错误', configuration: '配置错误', workspace: '工作区错误', permission: '权限错误',
  persistence: '存储错误', canceled: '已停止', unknown: '未知错误',
} as const

function ResultError({ result }: { result: SDKResultMessage }): React.ReactElement {
  const error = result.error
  const stopped = result.stopped_by_user === true || error?.category === 'canceled' || result.terminal_reason === 'stopped'
  const message = error?.message ?? result.errors?.join('；') ?? result.terminal_reason ?? 'Agent 运行失败'
  const label = error ? ERROR_CATEGORY_LABELS[error.category] : stopped ? '已停止' : '运行错误'
  return <div className={cn('rounded-md border px-3 py-2 text-xs', stopped ? 'bg-muted/20 text-muted-foreground' : 'border-destructive/40 bg-destructive/5 text-destructive')}><div className="flex items-center gap-1.5 font-medium"><AlertCircle size={13} />{label}</div><p className="mt-1">{message}</p></div>
}

/** 单轮所有 assistant/tool/result 片段共用无头像回复容器，按原消息顺序展示完整宽度的执行流。 */
export function AgentAssistantTurnItem({ messages, renderToolUse, hideToolResult, toolResultsById, activeToolUseIds, streamingAssistantUuid, footer }: {
  messages: readonly SDKMessage[]
  renderToolUse?: (block: SDKToolUseBlock) => React.ReactNode
  hideToolResult?: (toolUseId: string) => boolean
  toolResultsById?: ReadonlyMap<string, SDKToolResultBlock>
  activeToolUseIds?: ReadonlySet<string>
  streamingAssistantUuid?: string
  footer?: React.ReactNode
}): React.ReactElement {
  const assistants = messages.filter((message): message is SDKAssistantMessage => message.type === 'assistant')
  const copyText = assistants.map(agentMessageText).filter(Boolean).join('\n\n')
  const last = assistants.at(-1) ?? messages.at(-1)

  return <article className="group/message min-w-0">
    <div className="min-w-0 w-full space-y-1">
      {messages.map((message, messageIndex) => {
        if (message.type === 'assistant') return (message as SDKAssistantMessage).message.content.map((block, blockIndex) => <AssistantBlock key={`${message.uuid ?? messageIndex}-${blockIndex}`} block={block} renderToolUse={renderToolUse} toolResultsById={toolResultsById} activeToolUseIds={activeToolUseIds} isStreaming={message.uuid === streamingAssistantUuid && blockIndex === (message as SDKAssistantMessage).message.content.length - 1} />)
        if (message.type === 'user') return ((message as SDKUserMessage).message?.content ?? []).filter((block): block is SDKToolResultBlock => block.type === 'tool_result' && typeof block.tool_use_id === 'string' && !hideToolResult?.(block.tool_use_id)).map((block) => <ToolResult key={`result-${block.tool_use_id}`} block={block} />)
        if (message.type === 'result') return (message as SDKResultMessage).subtype === 'success' ? null : <ResultError key={`run-result-${messageIndex}`} result={message as SDKResultMessage} />
        if (message.type === 'system' && message.subtype === 'permission_denied') return <p key={`permission-${messageIndex}`} className="text-xs text-muted-foreground">工具权限已拒绝：{String((message as SDKSystemMessage).message ?? '未执行')}</p>
        return null
      })}
      {last && copyText && <MessageMeta message={last} align="left" copyText={copyText} />}
      {footer}
    </div>
  </article>
}

/** 单条 SDKMessage 通用渲染；根会话可注入 Agent 卡片，子会话复用默认工具块。 */
export function AgentMessageItem({ message, renderToolUse, hideToolResult, toolResultsById, activeToolUseIds, isStreaming }: {
  message: SDKMessage
  renderToolUse?: (block: SDKToolUseBlock) => React.ReactNode
  hideToolResult?: (toolUseId: string) => boolean
  toolResultsById?: ReadonlyMap<string, SDKToolResultBlock>
  activeToolUseIds?: ReadonlySet<string>
  isStreaming?: boolean
}): React.ReactElement {
  if (message.type === 'user') {
    if ((message as SDKUserMessage).isSynthetic) return <></>
    const content = (message as SDKUserMessage).message?.content ?? []
    const text = textFromUser(message)
    const toolResults = content.filter((block): block is SDKToolResultBlock => {
      const toolUseId = (block as { tool_use_id?: unknown }).tool_use_id
      return block.type === 'tool_result'
        && typeof toolUseId === 'string'
        && !hideToolResult?.(toolUseId)
    })
    return <>
      {text && <article className="group/message flex justify-end"><div className="min-w-0 max-w-[85%] space-y-1"><div className="ml-auto w-fit max-w-full whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-muted/80 px-3 py-2 text-sm">{text}</div><MessageMeta message={message} align="right" /></div></article>}
      {toolResults.map((block) => <article key={block.tool_use_id} className="min-w-0"><ToolResult block={block} /></article>)}
    </>
  }
  if (message.type === 'assistant') {
    const assistant = message as SDKAssistantMessage
    return <article className="group/message min-w-0"><div className="min-w-0 w-full space-y-1">{assistant.message.content.map((block, index) => <AssistantBlock key={`${assistant.uuid ?? 'message'}-${index}`} block={block} renderToolUse={renderToolUse} toolResultsById={toolResultsById} activeToolUseIds={activeToolUseIds} isStreaming={isStreaming && index === assistant.message.content.length - 1} />)}{agentMessageText(message) && <MessageMeta message={message} align="left" />}</div></article>
  }
  if (message.type === 'result') return (message as SDKResultMessage).subtype === 'success' ? <></> : <ResultError result={message as SDKResultMessage} />
  if (message.type === 'system' && message.subtype === 'permission_denied') return <p className="text-center text-xs text-muted-foreground">工具权限已拒绝：{String((message as SDKSystemMessage).message ?? '未执行')}</p>
  return <></>
}
