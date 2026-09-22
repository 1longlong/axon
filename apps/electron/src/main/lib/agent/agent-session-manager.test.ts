import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@axon/shared'
import { AgentSessionManager, AgentSessionManagerError } from './agent-session-manager'

let directory: string
let indexPath: string
let sessionsDir: string
let nowValue: number
let nextId: number

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'axon-agent-sessions-'))
  indexPath = join(directory, 'agent-sessions.json')
  sessionsDir = join(directory, 'sessions')
  nowValue = 1_000
  nextId = 1
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function manager(): AgentSessionManager {
  return new AgentSessionManager({
    indexPath,
    sessionsDir,
    createId: () => `session-${nextId++}`,
    now: () => nowValue,
  })
}

function assistantMessage(uuid: string, text: string): SDKMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }], model: 'model-1' },
    parent_tool_use_id: null,
    uuid,
  }
}

async function expectError(action: () => unknown, code: AgentSessionManagerError['code']): Promise<void> {
  try {
    await action()
    throw new Error(`应当抛出 ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(AgentSessionManagerError)
    expect((error as AgentSessionManagerError).code).toBe(code)
  }
}

describe('AgentSessionManager 会话索引', () => {
  test('runtime 归属与 Zima 思考等级持久化', () => {
    const sessions = manager()
    const pi = sessions.create({ title: 'Pi 会话' })
    const zima = sessions.create({ title: 'Zima 会话', runtimeId: 'zima' })
    expect(pi.runtimeId).toBe('pi')
    expect(zima.runtimeId).toBe('zima')
    expect(zima.thinkingLevel).toBe('medium')
    expect(manager().get(zima.id)?.runtimeId).toBe('zima')
    expect(sessions.create({ runtimeId: 'zima', thinkingLevel: 'high' }).thinkingLevel).toBe('high')
    expect(sessions.update(zima.id, { thinkingLevel: 'low' }).thinkingLevel).toBe('low')
  })

  test('创建、列表按更新时间排序、更新 resume 凭据', () => {
    const sessions = manager()
    const first = sessions.create({ title: '重构任务', channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1' })
    nowValue = 5_000
    const second = sessions.create()

    expect(second.title).toBe('新任务')
    expect(second.thinkingLevel).toBe('medium')
    expect(sessions.list().map((item) => item.id)).toEqual([second.id, first.id])

    const updated = sessions.update(first.id, {
      sdkSessionId: 'sdk-session-1',
      runtimeSessionFile: '/data/runtime/session-1.jsonl',
      permissionMode: 'acceptEdits',
      thinkingLevel: 'high',
      projectId: 'project-2',
      memoryFileStates: { 'MEMORY.md': { updatedAt: 12.5, size: 42 } },
    })
    expect(updated).toMatchObject({
      sdkSessionId: 'sdk-session-1',
      runtimeSessionFile: '/data/runtime/session-1.jsonl',
      permissionMode: 'acceptEdits',
      thinkingLevel: 'high',
      projectId: 'project-2',
      memoryFileStates: { 'MEMORY.md': { updatedAt: 12.5, size: 42 } },
    })
    // 新实例从磁盘重载后 resume 凭据完整保留。
    const reloaded = manager()
    expect(reloaded.get(first.id)?.sdkSessionId).toBe('sdk-session-1')
    expect(reloaded.get(first.id)?.runtimeSessionFile).toBe('/data/runtime/session-1.jsonl')
    expect(reloaded.get(first.id)?.memoryFileStates).toEqual({ 'MEMORY.md': { updatedAt: 12.5, size: 42 } })
    expect(reloaded.get(first.id)?.thinkingLevel).toBe('high')
    expect(reloaded.update(first.id, { projectId: null }).projectId).toBeUndefined()
  })

  test('拒绝非法输入：坏 ID、坏权限模式、空白标题', async () => {
    const sessions = manager()
    await expectError(() => sessions.get('../escape'), 'invalid_input')
    await expectError(() => sessions.create({ title: '   ' }), 'invalid_input')
    await expectError(() => sessions.create({ permissionMode: 'yolo' as never }), 'invalid_input')
    await expectError(() => sessions.create({ thinkingLevel: 'extreme' as never }), 'invalid_input')
    await expectError(() => sessions.update('missing', { title: 'x' }), 'not_found')
    const created = sessions.create({})
    await expectError(() => sessions.update(created.id, { sdkSessionId: '  ' }), 'invalid_input')
    await expectError(() => sessions.update(created.id, {
      memoryFileStates: { '../escape.md': { updatedAt: 1, size: 1 } },
    }), 'invalid_input')
    await expectError(() => sessions.update(created.id, {
      memoryFileStates: { 'topic.md': { updatedAt: -1, size: 1 } },
    }), 'invalid_input')
  })

  test('删除清理索引、JSONL 与损坏副本', () => {
    const sessions = manager()
    const created = sessions.create()
    sessions.appendMessage(created.id, assistantMessage('msg-1', '内容'))
    const sessionPath = join(sessionsDir, created.id, 'agents', 'main', 'messages.jsonl')
    writeFileSync(`${sessionPath}.corrupt`, '残留', 'utf-8')

    expect(existsSync(sessionPath)).toBe(true)
    sessions.delete(created.id)
    expect(existsSync(join(sessionsDir, created.id))).toBe(false)
    expect(existsSync(`${sessionPath}.corrupt`)).toBe(false)
    expect(existsSync(`${sessionPath}.tmp`)).toBe(false)
    expect(sessions.list()).toEqual([])
  })
})

describe('AgentSessionManager 消息 JSONL', () => {
  test('追加完整 SDKMessage 并可重载，未知消息类型透传保留', () => {
    const sessions = manager()
    const created = sessions.create()

    sessions.appendMessage(created.id, {
      type: 'user',
      message: { content: [{ type: 'text', text: '帮我修复构建' }] },
      parent_tool_use_id: null,
      uuid: 'user-1',
    })
    sessions.appendMessage(created.id, assistantMessage('assistant-1', '好的'))
    // 未来 runtime 引入的新消息类型：透传保留，不丢弃字段。
    sessions.appendMessage(created.id, {
      type: 'future_event',
      payload: { anything: true },
    } as unknown as SDKMessage)

    const reloaded = manager().getMessages(created.id)
    expect(reloaded).toHaveLength(3)
    expect(reloaded[0]).toMatchObject({ type: 'user', uuid: 'user-1', createdAt: 1_000 })
    expect(reloaded[1]).toMatchObject({ type: 'assistant', createdAt: 1_000, message: { content: [{ type: 'text', text: '好的' }] } })
    expect(reloaded[2]).toMatchObject({ type: 'future_event', payload: { anything: true } })
  })

  test('保留 adapter 提供的合法消息时间，不在重载时重新计时', () => {
    const sessions = manager()
    const created = sessions.create()
    const persisted = sessions.appendMessage(created.id, {
      ...assistantMessage('assistant-1', '已有时间'),
      createdAt: 500,
    })

    expect(persisted.createdAt).toBe(500)
    nowValue = 9_000
    expect(manager().getMessages(created.id)[0]?.createdAt).toBe(500)
  })

  test('缺失 uuid 的消息落盘前回填稳定 id（已知陷阱 #7）', () => {
    const sessions = manager()
    const created = sessions.create()
    const persisted = sessions.appendMessage(created.id, {
      type: 'system',
      subtype: 'init',
      model: 'model-1',
    } as SDKMessage)
    // result/system 等类型在协议上没有 uuid 字段声明，访问需收窄。
    const persistedUuid = (persisted as { uuid?: string }).uuid
    expect(persistedUuid).toStartWith('backfill-')
    // 回填后的重载保持同一 id，不重复回填。
    const reloaded = manager().getMessages(created.id)
    expect((reloaded[0] as { uuid?: string }).uuid).toBe(persistedUuid)
  })

  test('拒绝重复 uuid、非对象消息与缺少类型的消息', async () => {
    const sessions = manager()
    const created = sessions.create()
    sessions.appendMessage(created.id, assistantMessage('msg-1', '第一条'))
    await expectError(() => sessions.appendMessage(created.id, assistantMessage('msg-1', '重复')), 'duplicate')
    await expectError(() => sessions.appendMessage(created.id, 'text' as unknown as SDKMessage), 'invalid_input')
    await expectError(() => sessions.appendMessage(created.id, { foo: 1 } as unknown as SDKMessage), 'invalid_input')
    await expectError(() => sessions.appendMessage('missing', assistantMessage('msg-2', 'x')), 'not_found')
  })

  test('损坏行隔离到 .corrupt 并修复主文件，重复 uuid 视为损坏行丢弃', () => {
    const sessions = manager()
    const created = sessions.create()
    sessions.appendMessage(created.id, assistantMessage('msg-1', '完好'))
    const sessionPath = join(sessionsDir, created.id, 'agents', 'main', 'messages.jsonl')
    const good = readFileSync(sessionPath, 'utf-8').trimEnd()
    writeFileSync(sessionPath, `${good}\n{broken json\n${JSON.stringify(assistantMessage('msg-1', '重复 uuid'))}\n`, 'utf-8')

    const messages = sessions.getMessages(created.id)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ uuid: 'msg-1' })
    expect(existsSync(`${sessionPath}.corrupt`)).toBe(true)
  })

  test('会话不存在时读取消息报 not_found', async () => {
    const sessions = manager()
    await expectError(() => sessions.getMessages('nope'), 'not_found')
  })
})
