import { describe, expect, test } from 'bun:test'
import type { ProviderStreamRequest } from '@axon/core'
import type { ResolvedChannel } from '@axon/shared'
import { createAgentTitleGenerator } from './agent-title-generator'

const channel: ResolvedChannel = {
  id: 'channel-1', name: '测试渠道', provider: 'openai',
  baseUrl: 'https://example.test/v1', apiKey: 'secret',
  models: [{ id: 'model-1', name: 'Model 1', enabled: true }],
  enabled: true, createdAt: 1, updatedAt: 1,
}

describe('Agent 标题生成', () => {
  test('通过普通文本接口请求并清洗模型输出', async () => {
    let request: ProviderStreamRequest | undefined
    const generate = createAgentTitleGenerator('Axon/0.1.0', async function* (input) {
      request = input
      yield { type: 'text_delta', delta: ' “检查 ' }
      yield { type: 'text_delta', delta: '登录问题” ' }
      yield { type: 'finish', reason: 'stop' }
    })

    const title = await generate({
      channel, modelId: 'model-1', userText: '登录失败', assistantText: '已经定位原因',
      signal: new AbortController().signal,
    })

    expect(title).toBe('检查 登录问题')
    expect(request).toMatchObject({
      provider: 'openai', baseUrl: 'https://example.test/v1', apiKey: 'secret',
      userAgent: 'Axon/0.1.0', chatRequest: { modelId: 'model-1', maxOutputTokens: 64 },
    })
    expect(request?.chatRequest.messages[0]).toMatchObject({
      role: 'user', content: [{ type: 'text', text: '登录失败\n\n已经定位原因' }],
    })
  })
})
