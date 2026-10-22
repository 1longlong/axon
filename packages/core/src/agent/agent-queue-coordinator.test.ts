import { describe, expect, test } from 'bun:test'
import { AgentQueueCoordinator } from './agent-queue-coordinator'
import type { AgentInputPart } from '@axon/shared'

describe('附件队列中立输入', () => {
  test('正文/草稿/确切模型确认独立保留，展示附件深复制', () => {
    const queue = new AgentQueueCoordinator({ createId: () => 'queue', now: () => 10 })
    const attachments = [{ id: 'selection', kind: 'selection' as const, name: '片段', text: '内容', createdAt: 1 }]
    const result = queue.enqueue({ sessionId: 'session', text: '  原文\n', attachmentDraftId: 'draft', imageModelConsent: { channelId: 'channel', modelId: 'model' } }, attachments)
    attachments[0]!.text = '之后修改'
    expect(result).toMatchObject({ text: '  原文\n', attachmentDraftId: 'draft', imageModelConsent: { channelId: 'channel', modelId: 'model' }, attachments: [{ text: '内容' }] })
    expect(result).not.toBeNull(); expect(queue.dequeue('session')).toEqual(result!)
    expect(queue.list('session')).toEqual([])
  })
  test('满队列不假接纳，取消只删除目标项', () => {
    const queue = new AgentQueueCoordinator({ maxQueueLength: 1, createId: () => 'queue' })
    queue.enqueue({ sessionId: 'session', text: '', attachmentDraftId: 'draft' })
    expect(queue.enqueue({ sessionId: 'session', text: 'next' })).toBeNull()
    expect(queue.cancel({ sessionId: 'session', messageId: 'wrong' })).toBe(false)
    expect(queue.cancel({ sessionId: 'session', messageId: 'queue' })).toBe(true)
  })
  test('排队片段顺序深复制，编辑器后续修改不改变已接管内容', () => {
    const queue = new AgentQueueCoordinator()
    const inputParts: AgentInputPart[] = [{ type: 'text', text: '前文' }, { type: 'skill', attachmentId: 'skill' }, { type: 'text', text: '后文' }]
    const queued = queue.enqueue({ sessionId: 'session', text: '前文后文', inputParts, attachmentDraftId: 'draft' })!
    inputParts[0] = { type: 'text', text: '新草稿' }
    expect(queued.inputParts?.[0]).toEqual({ type: 'text', text: '前文' })
    expect(queue.dequeue('session')?.inputParts).toEqual(queued.inputParts)
  })
})
