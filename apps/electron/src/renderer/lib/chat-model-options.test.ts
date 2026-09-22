import { describe, expect, test } from 'bun:test'
import type { Channel } from '@axon/shared'
import {
  buildChatModelOptions,
  decodeChatModelOption,
  encodeChatModelOption,
  getDefaultChatModel,
} from './chat-model-options'

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'channel-1',
    name: '主渠道',
    provider: 'openai',
    baseUrl: 'https://api.example.com/v1',
    models: [
      { id: 'model-1', name: '模型一', enabled: true },
      { id: 'model-2', name: '模型二', enabled: false },
    ],
    enabled: true,
    hasApiKey: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('Chat 模型选项', () => {
  test('过滤不可用渠道和模型，并生成新会话默认值', () => {
    const channels = [
      channel(),
      channel({ id: 'disabled', enabled: false }),
      channel({ id: 'no-key', name: '本地服务', hasApiKey: false }),
    ]
    expect(buildChatModelOptions(channels)).toEqual([
      {
        channelId: 'channel-1',
        channelName: '主渠道',
        modelId: 'model-1',
        modelName: '模型一',
      },
      {
        channelId: 'no-key',
        channelName: '本地服务',
        modelId: 'model-1',
        modelName: '模型一',
      },
    ])
    expect(getDefaultChatModel(channels)).toEqual({ channelId: 'channel-1', modelId: 'model-1' })
    expect(getDefaultChatModel([])).toEqual({})
  })

  test('选项值可逆且拒绝损坏输入', () => {
    const encoded = encodeChatModelOption('channel::1', 'model::1')
    expect(decodeChatModelOption(encoded)).toEqual({ channelId: 'channel::1', modelId: 'model::1' })
    expect(decodeChatModelOption('broken')).toBeNull()
  })
})
