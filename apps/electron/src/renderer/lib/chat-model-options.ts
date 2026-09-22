import type { Channel, ConversationCreateInput } from '@axon/shared'

export interface ChatModelOption {
  channelId: string
  channelName: string
  modelId: string
  modelName: string
}

/** 只暴露已启用渠道及其启用模型；本地兼容服务允许无凭据运行。 */
export function buildChatModelOptions(channels: readonly Channel[]): ChatModelOption[] {
  return channels.flatMap((channel) => {
    if (!channel.enabled) return []
    return channel.models
      .filter((model) => model.enabled)
      .map((model) => ({
        channelId: channel.id,
        channelName: channel.name,
        modelId: model.id,
        modelName: model.name,
      }))
  })
}

/** 新建对话时沿用第一个可用组合；没有配置时仍允许创建空对话。 */
export function getDefaultChatModel(channels: readonly Channel[]): ConversationCreateInput {
  const first = buildChatModelOptions(channels)[0]
  return first ? { channelId: first.channelId, modelId: first.modelId } : {}
}

export function encodeChatModelOption(channelId: string, modelId: string): string {
  return JSON.stringify([channelId, modelId])
}

export function decodeChatModelOption(value: string): Pick<ChatModelOption, 'channelId' | 'modelId'> | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.length !== 2) return null
    const [channelId, modelId] = parsed
    return typeof channelId === 'string' && typeof modelId === 'string'
      ? { channelId, modelId }
      : null
  } catch {
    return null
  }
}
