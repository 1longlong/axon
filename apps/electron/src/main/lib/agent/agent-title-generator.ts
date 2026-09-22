/** Agent 标题生成：复用普通 Provider 文本接口，不依赖具体 Agent Runtime。 */

import { streamProviderChat } from '@axon/core'
import type { ProviderStreamEvent, ProviderStreamRequest } from '@axon/core'
import { MAX_AGENT_SESSION_TITLE_LENGTH } from '@axon/shared'
import type { ResolvedChannel } from '@axon/shared'

const TITLE_SOURCE_MAX_LENGTH = 4_000
const TITLE_MAX_OUTPUT_TOKENS = 64

export interface AgentTitleGenerationInput {
  channel: ResolvedChannel
  modelId: string
  userText: string
  assistantText: string
  signal: AbortSignal
}

export type AgentTitleGenerator = (
  input: AgentTitleGenerationInput,
) => Promise<string | undefined>

export type AgentTitleStreamExecutor = (
  input: ProviderStreamRequest,
) => AsyncIterable<ProviderStreamEvent>

/** 创建标题生成器；上游提供首轮问答，下游只接收清洗后的短标题。 */
export function createAgentTitleGenerator(
  userAgent: string,
  stream: AgentTitleStreamExecutor = streamProviderChat,
): AgentTitleGenerator {
  return async ({ channel, modelId, userText, assistantText, signal }) => {
    const source = `${userText}\n\n${assistantText}`.trim().slice(0, TITLE_SOURCE_MAX_LENGTH)
    if (!source) return undefined

    let raw = ''
    for await (const event of stream({
      provider: channel.provider,
      baseUrl: channel.baseUrl,
      apiKey: channel.apiKey,
      userAgent,
      chatRequest: {
        modelId,
        messages: [{ role: 'user', content: [{ type: 'text', text: source }] }],
        systemPrompt: '请为这段对话生成一个不超过 20 个字的简洁标题，直接输出标题本身，不要引号、句号或任何解释。',
        maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
      },
      signal,
    })) {
      if (event.type === 'text_delta') raw += event.delta
    }

    const title = raw
      .replace(/\s+/g, ' ')
      .replace(/^[「『"'“‘（《【\[\s]+|[」』"'”’）》】\]\s]+$/g, '')
      .trim()
      .slice(0, MAX_AGENT_SESSION_TITLE_LENGTH)
    return title || undefined
  }
}
