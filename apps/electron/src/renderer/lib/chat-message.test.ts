import { describe, expect, test } from 'bun:test'
import { contentBlocksToPlainText } from './chat-message'

describe('Chat 消息复制文本', () => {
  test('按内容块顺序输出可见文本且不包含推理签名', () => {
    expect(contentBlocksToPlainText([
      { type: 'reasoning', text: '分析', signature: 'opaque-secret' },
      { type: 'text', text: '答案' },
      { type: 'tool_call', callId: 'call-1', name: 'search', arguments: '{"q":"axon"}' },
      { type: 'tool_result', callId: 'call-1', name: 'search', output: '找到结果' },
    ])).toBe('分析\n\n答案\n\nsearch\n{"q":"axon"}\n\nsearch\n找到结果')
  })
})

test('携带附件的消息在复制文本末尾列出附件名与大小', () => {
  expect(contentBlocksToPlainText(
    [{ type: 'text', text: '看图' }],
    [{ id: 'a', filename: '截图.png', mediaType: 'image/png', localPath: 'c/a.png', size: 2048, createdAt: 1 }],
  )).toBe('看图\n\n附件：截图.png（2 KB）')
  // 无正文时只列附件；无附件时行为不变。
  expect(contentBlocksToPlainText([], [
    { id: 'a', filename: 'data.txt', mediaType: 'text/plain', localPath: 'c/a.txt', size: 3, createdAt: 1 },
  ])).toBe('附件：data.txt（3 B）')
})
