import * as React from 'react'
import { AlertCircle, Check, ChevronDown, Circle, Copy, Keyboard, Loader2, Wrench } from 'lucide-react'
import type { SDKAssistantMessage, SDKContentBlock, SDKMessage, SDKResultMessage, SDKSystemMessage, SDKToolResultBlock, SDKToolUseBlock, SDKUserMessage } from '@axon/shared'
import { cn } from '@/lib/utils'
import { MarkdownText } from '@/components/chat/MarkdownText'
import { ThinkingBlock } from '@/components/chat/ThinkingBlock'
import { agentMessageText, isAgentUserStoppedResult, stringifyAgentContent } from '@/lib/agent-message'
import { groupAgentActivities, summarizeAgentActivity } from '@/lib/agent-activity-groups'
import type { AgentActivityGroup as ActivityGroup, AgentTurnBlock } from '@/lib/agent-activity-groups'
import { AgentAttachmentTags } from './AgentAttachmentTags'
import { AgentInputText } from './AgentInputText'

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
        : result?.execution_status === 'unknown' ? <AlertCircle size={14} className="shrink-0 text-muted-foreground" aria-label="执行结果未知" />
          : result?.is_error ? <span className="flex size-3.5 shrink-0 items-center justify-center" role="img" aria-label="执行失败"><span className="size-1.5 rounded-full bg-destructive" /></span>
          : result ? <Check size={14} strokeWidth={2.5} className="shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="执行成功" />
            : <Circle size={14} className="shrink-0 text-muted-foreground" aria-label="暂无结果" />}
      <span className="flex min-w-0 flex-1 items-center font-mono" title={label}>
        <span className={cn('max-w-[50%] shrink-0 truncate font-semibold', result?.is_error ? 'text-destructive' : 'text-foreground')}>{name}</span>
        {detail && <><span aria-hidden="true" className="shrink-0 whitespace-pre text-muted-foreground/50">{' · '}</span><span className="min-w-0 truncate">{detail}</span></>}
        {result?.execution_status === 'unknown' && <span className="ml-2 shrink-0 font-sans text-muted-foreground">结果未知</span>}
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

function ResultError({ result }: { result: SDKResultMessage }): React.ReactElement | null {
  if (isAgentUserStoppedResult(result)) return null
  const error = result.error
  const stopped = result.stopped_by_user === true || error?.category === 'canceled' || result.terminal_reason === 'stopped'
  const message = error?.message ?? result.errors?.join('；') ?? result.terminal_reason ?? 'Agent 运行失败'
  const label = error ? ERROR_CATEGORY_LABELS[error.category] : stopped ? '已停止' : '运行错误'
  return <div className={cn('rounded-md border px-3 py-2 text-xs', stopped ? 'bg-muted/20 text-muted-foreground' : 'border-destructive/40 bg-destructive/5 text-destructive')}><div className="flex items-center gap-1.5 font-medium"><AlertCircle size={13} />{label}</div><p className="mt-1">{message}</p></div>
}

/** 活动默认展开，正常收束收起；用户中断保留展开选择，异常/待交互工具始终可见。 */
function AgentActivityGroup({ group, renderItem, toolResultsById, activeToolUseIds, blockedToolUseIds }: {
  group: ActivityGroup
  renderItem: (item: AgentTurnBlock) => React.ReactNode
  toolResultsById?: ReadonlyMap<string, SDKToolResultBlock>
  activeToolUseIds?: ReadonlySet<string>
  blockedToolUseIds?: ReadonlySet<string>
}): React.ReactElement {
  const contentId = React.useId()
  const [choice, setChoice] = React.useState<{ closed: boolean; open: boolean }>()
  const open = choice && (choice.closed === group.closed || group.interrupted)
    ? choice.open : !group.closed || group.interrupted === true
  // 普通收束重置摘要，中断沿用手动选择；新增 delta 不反复打开/关闭详情。
  React.useEffect(() => { if (!group.interrupted) setChoice(undefined) }, [group.closed, group.interrupted])
  const tools = group.items.filter((item) => item.block.type === 'tool_use').map((item) => item.block as SDKToolUseBlock)
  const unknownIds = new Set(tools.filter((tool) => toolResultsById?.get(tool.id)?.execution_status === 'unknown').map((tool) => tool.id))
  const failedIds = new Set(tools.filter((tool) => toolResultsById?.get(tool.id)?.is_error && !unknownIds.has(tool.id)).map((tool) => tool.id))
  const blocked = tools.some((tool) => blockedToolUseIds?.has(tool.id))
  const active = !group.closed || tools.some((tool) => activeToolUseIds?.has(tool.id))

  return <section className="min-w-0" aria-label="执行活动组">
    <button type="button" aria-expanded={open} aria-controls={contentId}
      onClick={() => setChoice({ closed: group.closed, open: !open })}
      className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
      {active ? <Loader2 size={14} className="shrink-0 animate-spin motion-reduce:animate-none" />
        : failedIds.size ? <AlertCircle size={14} className="shrink-0 text-destructive" />
          : <Wrench size={14} className="shrink-0" />}
      <span className="min-w-0 flex-1">{active ? '进行中 · ' : ''}{summarizeAgentActivity(group)}</span>
      {blocked && <span className="shrink-0 text-amber-600 dark:text-amber-400">等待交互</span>}
      {failedIds.size > 0 && <span className="shrink-0 text-destructive">{failedIds.size} 项失败</span>}
      {unknownIds.size > 0 && <span className="shrink-0">{unknownIds.size} 项结果未知</span>}
      <ChevronDown size={12} className={cn('shrink-0 transition-transform motion-reduce:transition-none', open && 'rotate-180')} />
    </button>
    <div id={contentId} className="ml-3 space-y-1 border-l border-border-subtle pl-2">
      {group.items.map((item) => {
        const tool = item.block.type === 'tool_use' ? item.block as SDKToolUseBlock : undefined
        // 收起只隐藏普通记录；失败、审批/追问和带独立状态的子任务卡片不能埋进摘要。
        const attention = tool && (failedIds.has(tool.id) || unknownIds.has(tool.id) || blockedToolUseIds?.has(tool.id)
          || activeToolUseIds?.has(tool.id) || tool.name === 'Agent' || tool.name === 'AskUserQuestion')
        return <div key={item.key} hidden={!open && !attention}>{renderItem(item)}</div>
      })}
    </div>
  </section>
}

/** 单轮按真实顺序投影正文与连续活动组，工具回传仍关联原调用，历史本身不重排。 */
export function AgentAssistantTurnItem({ messages, renderToolUse, hideToolResult, toolResultsById, activeToolUseIds, blockedToolUseIds, streamingAssistantUuid, running = false, footer }: {
  messages: readonly SDKMessage[]
  renderToolUse?: (block: SDKToolUseBlock) => React.ReactNode
  hideToolResult?: (toolUseId: string) => boolean
  toolResultsById?: ReadonlyMap<string, SDKToolResultBlock>
  activeToolUseIds?: ReadonlySet<string>
  blockedToolUseIds?: ReadonlySet<string>
  streamingAssistantUuid?: string
  running?: boolean
  footer?: React.ReactNode
}): React.ReactElement {
  const assistants = messages.filter((message): message is SDKAssistantMessage => message.type === 'assistant')
  const copyText = assistants.map(agentMessageText).filter(Boolean).join('\n\n')
  const last = assistants.at(-1) ?? messages.at(-1)
  const parts = groupAgentActivities(messages, { running, streamingAssistantUuid, hideToolResult })
  const renderItem = (item: AgentTurnBlock): React.ReactNode => <AssistantBlock block={item.block}
    renderToolUse={renderToolUse} toolResultsById={toolResultsById} activeToolUseIds={activeToolUseIds} isStreaming={item.isStreaming} />

  return <article className="group/message min-w-0">
    <div className="min-w-0 w-full space-y-1">
      {parts.map((part) => part.kind === 'activity'
        ? <AgentActivityGroup key={part.key} group={part} renderItem={renderItem} toolResultsById={toolResultsById}
            activeToolUseIds={activeToolUseIds} blockedToolUseIds={blockedToolUseIds} />
        : part.kind === 'block'
          ? <React.Fragment key={part.key}>{renderItem(part)}</React.Fragment>
          : <AgentMessageItem key={part.key} message={part.message} />)}
      {!running && last && copyText && <MessageMeta message={last} align="left" copyText={copyText} />}
      {footer}
    </div>
  </article>
}

/** 单条 SDKMessage 通用渲染；根会话可注入 Agent 卡片，子会话复用默认工具块。 */
export function AgentMessageItem({ message, renderToolUse, hideToolResult, toolResultsById, activeToolUseIds, isStreaming, sessionId }: {
  message: SDKMessage
  renderToolUse?: (block: SDKToolUseBlock) => React.ReactNode
  hideToolResult?: (toolUseId: string) => boolean
  toolResultsById?: ReadonlyMap<string, SDKToolResultBlock>
  activeToolUseIds?: ReadonlySet<string>
  isStreaming?: boolean
  sessionId?: string
}): React.ReactElement {
  if (message.type === 'user') {
    if ((message as SDKUserMessage).isSynthetic) return <></>
    const content = (message as SDKUserMessage).message?.content ?? []
    const text = textFromUser(message)
    const attachments = (message as SDKUserMessage).attachments ?? []
    const parts = (message as SDKUserMessage).inputParts
    const files = parts ? attachments.filter((item) => item.kind !== 'skill') : attachments
    const toolResults = content.filter((block): block is SDKToolResultBlock => {
      const toolUseId = (block as { tool_use_id?: unknown }).tool_use_id
      return block.type === 'tool_result'
        && typeof toolUseId === 'string'
        && !hideToolResult?.(toolUseId)
    })
    return <>
      {(text || attachments.length > 0) && <article className="group/message flex justify-end"><div className="min-w-0 max-w-[85%] space-y-1">
        {files.length > 0 && <AgentAttachmentTags attachments={files}
          imageSource={sessionId && typeof message.uuid === 'string' ? { kind: 'history', sessionId, messageId: message.uuid } : undefined} />}
        {(text || parts?.length) && <div data-agent-input-body className="ml-auto w-fit max-w-full whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-muted/80 px-3 py-2 text-sm"><AgentInputText text={text} parts={parts} attachments={attachments} /></div>}
        <MessageMeta message={message} align="right" /></div></article>}
      {toolResults.map((block) => <article key={block.tool_use_id} className="min-w-0"><ToolResult block={block} /></article>)}
    </>
  }
  if (message.type === 'assistant') {
    const assistant = message as SDKAssistantMessage
    return <article className="group/message min-w-0"><div className="min-w-0 w-full space-y-1">{assistant.message.content.map((block, index) => <AssistantBlock key={`${assistant.uuid ?? 'message'}-${index}`} block={block} renderToolUse={renderToolUse} toolResultsById={toolResultsById} activeToolUseIds={activeToolUseIds} isStreaming={isStreaming && index === assistant.message.content.length - 1} />)}{agentMessageText(message) && <MessageMeta message={message} align="left" />}</div></article>
  }
  if (message.type === 'result') return (message as SDKResultMessage).subtype === 'success' ? <></> : <ResultError result={message as SDKResultMessage} />
  if (message.type === 'system' && message.subtype === 'permission_denied') return <p className="text-center text-xs text-muted-foreground">工具权限已拒绝：{String((message as SDKSystemMessage).message ?? '未执行')}</p>
  if (message.type === 'system' && message.subtype === 'axon_attachment_warning') return <p role="status" className="whitespace-pre-wrap rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">{String((message as SDKSystemMessage).message ?? '部分历史附件未能恢复')}</p>
  return <></>
}
