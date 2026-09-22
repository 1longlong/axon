import { MAX_CHAT_INPUT_LENGTH } from '@axon/shared'

export type ChatInputBlockReason = 'empty' | 'too_long' | 'model_required' | 'sending'

export interface ChatInputAvailability {
  canSend: boolean
  text: string
  reason?: ChatInputBlockReason
}

/** 在进入 IPC 前统一收紧输入，避免按钮与快捷键使用不同的发送规则。 */
export function getChatInputAvailability(
  value: string,
  options: { hasModel: boolean; sending: boolean },
): ChatInputAvailability {
  const text = value.trim()
  if (!text) return { canSend: false, text, reason: 'empty' }
  if (text.length > MAX_CHAT_INPUT_LENGTH) return { canSend: false, text, reason: 'too_long' }
  if (!options.hasModel) return { canSend: false, text, reason: 'model_required' }
  if (options.sending) return { canSend: false, text, reason: 'sending' }
  return { canSend: true, text }
}
