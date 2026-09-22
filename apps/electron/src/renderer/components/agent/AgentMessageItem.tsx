import * as React from 'react'
import { AlertCircle, Bot, Brain, Check, ChevronDown, Circle, Copy, Keyboard, Loader2, Wrench } from 'lucide-react'
import type { SDKAssistantMessage, SDKContentBlock, SDKMessage, SDKResultMessage, SDKSystemMessage, SDKToolResultBlock, SDKToolUseBlock, SDKUserMessage } from '@axon/shared'
import { cn } from '@/lib/utils'
import { MarkdownText } from '@/components/chat/MarkdownText'
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
  return <div className={cn('flex h-5 items-center gap-2 text-[11px] text-muted-foreground', align === 'right' && 'justify-end')}>
    {quickOrigin && <span aria-label="快捷输入" title="通过全局快捷键输入"><Keyboard size={11} /></span>}
    {time && <time dateTime={date?.toISOString()}>{time}</time>}
    {text && <button
      type="button"
      aria-label="复制消息"
      title="复制消息"
      onClick={() => void copy()}
      className={cn(
        'flex items-center gap-1 rounded px-1 py-0.5 opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/message:opacity-100',
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
  return <details className={cn('group rounded-md border text-xs', block.is_error ? 'border-destructive/50 text-destructive' : 'bg-muted/20')}>
    <summary className="cursor-pointer list-none px-3 py-2">
      <div className="flex items-center gap-1.5 font-medium"><Wrench size={13} />工具结果<ChevronDown size={13} className="ml-auto transition-transform group-open:rotate-180" /></div>
      <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-all text-muted-foreground">{result || '无输出'}</p>
    </summary>
    <pre className="h-56 overflow-auto border-t px-3 py-2 whitespace-pre-wrap break-all">{result || '无输出'}</pre>
  </details>
}

/** Bash 直接展示命令；其他工具展示最关键的目标，完整参数留在展开区。 */
function toolCallLabel(tool: SDKToolUseBlock): string {
  const input = tool.input ?? {}
  const detail = tool.name === 'Bash'
    ? input.command ?? input.cmd
    : input.file_path ?? input.path ?? input.pattern ?? input.query
  return typeof detail === 'string' && detail.trim() ? `${tool.name} · ${detail.trim()}` : tool.name || '工具调用'
}

/** 一个工具调用只占一行；执行进度与结果由同一 tool use id 关联。 */
function ToolCall({ tool, result, running }: { tool: SDKToolUseBlock; result?: SDKToolResultBlock; running: boolean }): React.ReactElement {
  const resultText = result ? stringifyAgentContent(result.content) : ''
  return <details className="group min-w-0 text-xs">
    <summary aria-label={`工具调用 ${tool.name}`} className="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-md px-1 py-1.5 text-muted-foreground hover:bg-muted/40 hover:text-foreground">
      {running ? <Loader2 size={14} className="shrink-0 animate-spin text-primary" />
        : result?.is_error ? <AlertCircle size={14} className="shrink-0 text-destructive" />
          : result ? <Check size={14} className="shrink-0 text-muted-foreground" />
            : <Circle size={14} className="shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1 truncate font-medium text-foreground" title={toolCallLabel(tool)}>{toolCallLabel(tool)}</span>
      <ChevronDown size={14} className="shrink-0 transition-transform group-open:rotate-180" />
    </summary>
    <div className="ml-5 mt-1 h-56 space-y-3 overflow-auto rounded-md border bg-muted/20 px-3 py-2">
      <section><p className="mb-1 font-medium">调用参数</p><pre className="whitespace-pre-wrap break-all text-muted-foreground">{JSON.stringify(tool.input ?? {}, null, 2)}</pre></section>
      <section><p className="mb-1 font-medium">执行结果</p><pre className={cn('whitespace-pre-wrap break-all', result?.is_error ? 'text-destructive' : 'text-muted-foreground')}>{result ? (resultText || '无输出') : running ? '执行中…' : '暂无结果'}</pre></section>
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
  if (block.type === 'text') return <MarkdownText children={String((block as { text?: unknown }).text ?? '')} />
  if (block.type === 'thinking') return !String((block as { thinking?: unknown }).thinking ?? '').trim() ? null : <details className="group text-xs text-muted-foreground">
    <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-1 py-1.5 hover:bg-muted/40 hover:text-foreground">
      {isStreaming ? <Loader2 size={14} className="shrink-0 animate-spin text-primary" /> : <Brain size={14} className="shrink-0" />}
      <span className="flex-1">思考过程</span><ChevronDown size={14} className="shrink-0 transition-transform group-open:rotate-180" />
    </summary>
    <p className="ml-5 mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words border-l pl-3">{String((block as { thinking?: unknown }).thinking ?? '')}</p>
  </details>
  if (block.type === 'tool_use') {
    const tool = block as SDKToolUseBlock
    const custom = renderToolUse?.(tool)
    if (custom) return <>{custom}</>
    return <ToolCall tool={tool} result={toolResultsById?.get(tool.id)} running={activeToolUseIds?.has(tool.id) === true} />
  }
  if (block.type === 'unknown') return null
  return <pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs text-muted-foreground">{JSON.stringify(block)}</pre>
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

/** 单轮所有 assistant/tool/result 片段共用一个回复容器和头像。 */
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

  return <article className="group/message flex gap-3">
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground"><Bot size={15} /></span>
    <div className="min-w-0 w-full max-w-[85%] space-y-2">
      {messages.map((message, messageIndex) => {
        if (message.type === 'assistant') return (message as SDKAssistantMessage).message.content.map((block, blockIndex) => <AssistantBlock key={`${message.uuid ?? messageIndex}-${blockIndex}`} block={block} renderToolUse={renderToolUse} toolResultsById={toolResultsById} activeToolUseIds={activeToolUseIds} isStreaming={message.uuid === streamingAssistantUuid} />)
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
      {text && <article className="group/message flex justify-end"><div className="max-w-[85%] space-y-1"><div className="ml-auto w-fit max-w-full rounded-xl bg-muted px-3 py-2 text-sm whitespace-pre-wrap break-words">{text}</div><MessageMeta message={message} align="right" /></div></article>}
      {toolResults.map((block) => <article key={block.tool_use_id} className="ml-10 max-w-[85%]"><ToolResult block={block} /></article>)}
    </>
  }
  if (message.type === 'assistant') {
    const assistant = message as SDKAssistantMessage
    return <article className="group/message flex gap-3"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground"><Bot size={15} /></span><div className="min-w-0 w-full max-w-[85%] space-y-2">{assistant.message.content.map((block, index) => <AssistantBlock key={`${assistant.uuid ?? 'message'}-${index}`} block={block} renderToolUse={renderToolUse} toolResultsById={toolResultsById} activeToolUseIds={activeToolUseIds} isStreaming={isStreaming} />)}{agentMessageText(message) && <MessageMeta message={message} align="left" />}</div></article>
  }
  if (message.type === 'result') return (message as SDKResultMessage).subtype === 'success' ? <></> : <ResultError result={message as SDKResultMessage} />
  if (message.type === 'system' && message.subtype === 'permission_denied') return <p className="text-center text-xs text-muted-foreground">工具权限已拒绝：{String((message as SDKSystemMessage).message ?? '未执行')}</p>
  return <></>
}
