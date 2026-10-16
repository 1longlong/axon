import { expect, test } from 'bun:test'
import * as React from 'react'
import { Provider } from 'jotai'
import { createStore } from 'jotai/vanilla'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentQueuedMessage } from '@axon/shared'
import { AgentStateProvider } from './AgentStateProvider'
import { AgentMessageQueue } from './AgentMessageQueue'

/** 验证队列的静态投影；真实提交/自动续轮由桌面及 core 验收。 */
function render(messages: readonly AgentQueuedMessage[]): string {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    axon: { agent: {}, agentProjects: {}, agentMemory: {}, agentTasks: {} },
  } })
  try {
    return renderToStaticMarkup(<Provider store={createStore()}><AgentStateProvider>
      <AgentMessageQueue sessionId="session" messages={messages} />
    </AgentStateProvider></Provider>)
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}

test('空队列不占输入区空间；多条消息保持一行胶囊和后端顺序', () => {
  expect(render([])).toBe('')
  const html = render([
    { id: 'first', sessionId: 'session', text: '第一条', createdAt: 1 },
    { id: 'second', sessionId: 'session', text: '第二条', createdAt: 2 },
  ])
  expect(html).toContain('aria-label="等待发送的消息"')
  expect(html).toContain('flex-nowrap')
  expect(html).toContain('overflow-x-auto')
  expect(html.match(/role="listitem"/g)).toHaveLength(2)
  expect(html.match(/rounded-full border/g)).toHaveLength(2)
  expect(html.indexOf('第一条')).toBeLessThan(html.indexOf('第二条'))
  expect(html.match(/aria-label="取消等待消息"/g)).toHaveLength(2)
  expect(html).not.toContain('上移等待消息')
  expect(html).not.toContain('下移等待消息')
})

test('长内容截断显示但完整内容保留在悬停提示，文本不解析为 HTML', () => {
  const text = '<script>不执行</script>\n' + '很长的消息'.repeat(100)
  const html = render([{ id: 'long', sessionId: 'session', text, createdAt: 1 }])
  expect(html).toContain('max-w-64')
  expect(html).toContain('truncate')
  expect(html).toContain('title="&lt;script&gt;不执行&lt;/script&gt;\n')
  expect(html).not.toContain('<script>')
})
