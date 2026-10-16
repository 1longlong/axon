import type { AgentExecutionPolicy, SDKMessage, SDKResultMessage, SDKUserMessage } from '@axon/shared'

const MAX_RECOVERY_CONTEXT_CHARS = 60_000
const MAX_RECOVERY_MESSAGE_CHARS = 8_000

/** 明确继续原任务的宿主中断背景；不包含新用户任务，也不要求重放旧操作。 */
export function buildAgentContinuationPrompt(): string {
  return [
    '<system-reminder>',
    '本任务此前被用户中断，现已明确允许继续原任务；这不是新的用户发言，也不是恢复半截网络响应。',
    '此前工具可能已部分执行；缺少结果不代表未执行或成功。先核实中断处必要的实际状态，避免重复产生副作用。',
    '旧审批和追问已撤销；如仍需授权或回答，必须重新发起当前执行的请求。',
    '</system-reminder>',
  ].join('\n')
}

/**
 * 从当前输入落盘前的应用历史识别最近真实停止轮；提醒交给下一轮两种 adapter 的
 * 系统上下文，不重放原任务、工具参数或结果，也不依赖 Runtime artifact 是否存在。
 */
export function buildAgentInterruptionPrompt(messages: SDKMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.type === 'result') {
      const result = message as SDKResultMessage
      // 内部压缩不是新一轮执行，不能把它当作已消费中断背景的完成标志。
      if (result.isSyntheticCompactionResult) continue
      if (result.terminal_reason !== 'stopped' || result.stopped_by_user !== true) return ''
      return [
        '<system-reminder>',
        '上一轮执行被用户停止。当前用户消息启动新一轮，不是恢复半截模型响应或重放上一轮请求。',
        '此前工具可能已经产生部分副作用；已保存的工具结果是已知事实，缺少结果不代表工具未执行或已成功。',
        '如果当前任务需要续做，先核实中断处必要的实际状态，再推进未完成工作，避免重复写入或重复执行有副作用的操作。',
        '已撤销的审批和追问不能恢复；需要授权时必须走当前轮的权限流程。',
        '以当前用户消息为准，不要仅因这条提醒自行继续旧任务。',
        '</system-reminder>',
      ].join('\n')
    }
    // 崩溃留下的新用户输入没有终态时，不把更早的停止冒充这一轮状态。
    if (message.type === 'user') {
      const user = message as SDKUserMessage
      if (!user.isSynthetic && user.message?.content?.some((block) => block.type === 'text')) return ''
    }
  }
  return ''
}

/** 将本轮非交互限制交给模型；实际授权/追问仍由 core 执行，不依赖提示词拦截。 */
export function buildAgentExecutionPolicyPrompt(policy: AgentExecutionPolicy): string {
  const instructions: string[] = []
  if (policy.approvalPolicy === 'never') {
    instructions.push('工具审批策略为 never：只能使用当前已授权能力，不能申请额外权限。工具拒绝后在既定范围内调整方案，不原样反复申请。')
  }
  if (policy.userInputPolicy === 'reject') {
    instructions.push('当前没有可提供回答的用户输入入口。不要依赖 AskUserQuestion 等待回答，不要编造用户的选择或授权；能安全采用合理默认值时继续，否则说明缺少的必要信息。')
  }
  return instructions.length > 0 ? ['[本轮执行限制]', ...instructions].join('\n') : ''
}

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try { return JSON.stringify(value) ?? '' } catch { return '[内容无法序列化]' }
}

/** 将一条中立消息压缩成恢复文本；运行状态、result 和思考内容不重复注入模型。 */
function recoveryLine(message: SDKMessage): string | undefined {
  if (message.type === 'user') {
    const content = (message as { message?: { content?: unknown[] } }).message?.content ?? []
    const text = content.map((block) => {
      if (!block || typeof block !== 'object') return ''
      const item = block as { type?: unknown; text?: unknown; content?: unknown; tool_use_id?: unknown; execution_status?: unknown }
      if (item.type === 'text') return typeof item.text === 'string' ? item.text : ''
      if (item.type === 'tool_result') return `[${item.execution_status === 'unknown' ? '工具状态未知（应用中断记录）' : '工具结果'} ${String(item.tool_use_id ?? '')}] ${stringifyContent(item.content)}`
      return ''
    }).filter(Boolean).join('\n')
    const internal = (message as SDKUserMessage).isSynthetic === true && content.some((block) =>
      block && typeof block === 'object' && (block as { type?: unknown }).type === 'text')
    return text ? `${internal ? '宿主内部输入' : '用户'}：${text.slice(0, MAX_RECOVERY_MESSAGE_CHARS)}` : undefined
  }
  if (message.type === 'assistant') {
    const content = (message as { message?: { content?: unknown[] } }).message?.content ?? []
    const text = content.map((block) => {
      if (!block || typeof block !== 'object') return ''
      const item = block as { type?: unknown; text?: unknown; name?: unknown; input?: unknown }
      if (item.type === 'text') return typeof item.text === 'string' ? item.text : ''
      if (item.type === 'tool_use') return `[调用工具 ${String(item.name ?? '')}] ${stringifyContent(item.input)}`
      return ''
    }).filter(Boolean).join('\n')
    const partial = (message as { isPartial?: boolean }).isPartial === true
    return text ? `助手${partial ? '（已中断的部分输出）' : ''}：${text.slice(0, MAX_RECOVERY_MESSAGE_CHARS)}` : undefined
  }
  return undefined
}

/**
 * 从 Axon JSONL 的最近可见消息构造有界恢复上下文；输入是稳定中立历史，
 * 输出作为新 runtime session 的首轮前缀，无法还原的内部状态不会伪装成无损 resume。
 */
export function buildRecoveryPrompt(messages: SDKMessage[]): string {
  const selected: string[] = []
  // artifact 丢失时保留最近成功摘要，并补充有界可见历史；没有保留段标识，不能假造精确 Runtime 上下文。
  const compact = [...messages].reverse().find((message) => message.type === 'system'
    && (message as { subtype?: string; compact_result?: string; summary?: unknown }).subtype === 'compact_boundary'
    && (message as { compact_result?: string }).compact_result === 'success'
    && typeof (message as { summary?: unknown }).summary === 'string' && (message as { summary: string }).summary.trim())
  const summary = compact ? (compact as { summary: string }).summary.slice(0, MAX_RECOVERY_CONTEXT_CHARS / 2) : ''
  let length = summary.length
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const line = recoveryLine(messages[index]!)
    if (!line) continue
    if (length + line.length > MAX_RECOVERY_CONTEXT_CHARS) break
    selected.unshift(line)
    length += line.length
  }
  if (selected.length === 0 && !summary) return ''
  return [
    '[会话恢复上下文]',
    '原运行会话记录不可用。以下内容来自应用已持久化的可见历史，只作为此前对话背景。',
    ...(summary ? ['[最近成功压缩摘要；语义恢复，不代表完整 Runtime 状态]', summary] : []),
    ...selected,
    '[恢复说明]',
    '请结合以上背景处理本次输入或宿主明确授权的续做，不要复述恢复说明。',
  ].join('\n\n')
}
