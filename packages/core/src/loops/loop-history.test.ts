/** 真实应用 JSONL 分页，不读取 Runtime artifact；输出截断显式标明。 */
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentSessionManager } from '../agent/agent-session-manager'
import { readLoopTrace } from './loop-history'

test('历史过程分段返回正文/参数，排除思考，明确截断并关闭快照', () => {
  const root = mkdtempSync(join(tmpdir(), 'axon-loop-trace-'))
  const sessions = new AgentSessionManager({ indexPath: join(root, 'index.json'), sessionsDir: join(root, 'sessions') })
  try {
    const session = sessions.create({ title: '历史验收' })
    for (let index = 0; index < 23; index++) sessions.appendMessage(session.id, {
      type: 'assistant', uuid: `trace-${index}`, message: { content: [
        { type: 'thinking', thinking: '不应返回思考内容' },
        { type: 'tool_use', name: 'Read', id: `tool-${index}`, input: { path: `file-${index}` } },
        { type: 'text', text: index === 0 ? '长文本'.repeat(1000) : `正文 ${index}` },
      ] },
    })
    const reader = sessions.openMessageHistory(session.id)
    const first = readLoopTrace(reader, 0)
    expect(first.entries).toHaveLength(20); expect(first.nextOffset).toBe(20)
    expect(first.entries[0]).toMatchObject({ offset: 0, truncated: true })
    expect(first.entries[0]?.text.length).toBe(1600)
    expect(first.entries[0]?.text).toContain('file-0')
    expect(JSON.stringify(first)).not.toContain('不应返回思考内容')
    expect(() => reader.readPage()).toThrow('已关闭')
    const last = readLoopTrace(sessions.openMessageHistory(session.id), first.nextOffset!)
    expect(last.entries.map((entry) => entry.offset)).toEqual([20, 21, 22]); expect(last.nextOffset).toBeNull()
    expect(readLoopTrace(sessions.openMessageHistory(session.id), 200).entries).toEqual([])
  } finally { rmSync(root, { recursive: true }) }
})
