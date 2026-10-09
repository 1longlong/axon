import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentDelegationManager,
  AgentRootStateStore,
  AgentSessionManager,
  ConversationManager,
  createBackendPaths,
  initializeBackendDirectories,
  writeTextFileAtomic,
} from '../index'
import type { BackendPaths } from '../settings/backend-paths'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

interface StoreBundle {
  conversations: ConversationManager
  sessions: AgentSessionManager
  tasks: AgentDelegationManager
  state: AgentRootStateStore
}

function isolatedPaths(): BackendPaths {
  const directory = mkdtempSync(join(tmpdir(), 'axon-core-session-storage-'))
  directories.push(directory)
  const paths = createBackendPaths({ dataDir: join(directory, 'data'), homeDir: directory })
  initializeBackendDirectories(paths)
  return paths
}

/** 同一入口明确装配共享根状态，不导入 Electron 单例或任何 Runtime SDK。 */
function openStores(paths: BackendPaths): StoreBundle {
  const state = new AgentRootStateStore(paths.agentSessionsDir)
  return {
    state,
    conversations: new ConversationManager({
      indexPath: paths.conversationsIndexPath,
      messagesDir: paths.conversationsDir,
    }),
    sessions: new AgentSessionManager({
      indexPath: paths.agentSessionsIndexPath,
      sessionsDir: paths.agentSessionsDir,
      stateStore: state,
    }),
    tasks: new AgentDelegationManager({ stateStore: state }),
  }
}

describe('非 Electron 入口的会话存储与恢复', () => {
  test('Chat 摘要仍在元数据，原文和后续消息从应用 JSONL 完整恢复', () => {
    const paths = isolatedPaths()
    const { conversations } = openStores(paths)
    const conversation = conversations.create({ channelId: 'channel-1', modelId: 'model-1' })
    conversations.appendMessage(conversation.id, {
      id: 'old-user', role: 'user', content: [{ type: 'text', text: '需要保留的原文' }],
      createdAt: 1, status: 'complete',
    })
    conversations.appendMessage(conversation.id, {
      id: 'old-assistant', role: 'assistant', content: [{ type: 'text', text: '早期回答' }],
      createdAt: 2, status: 'complete',
    })
    const summary = { text: '早期上下文摘要', coveredMessageIds: ['old-user', 'old-assistant'], updatedAt: 3 }
    conversations.update(conversation.id, { contextSummary: summary })
    conversations.appendMessage(conversation.id, {
      id: 'new-user', role: 'user', content: [{ type: 'text', text: '摘要后的新问题' }],
      createdAt: 4, status: 'complete',
    })
    const before = conversations.getMessages(conversation.id)
    const reloaded = openStores(paths).conversations
    expect(reloaded.get(conversation.id)?.contextSummary).toEqual(summary)
    expect(reloaded.getMessages(conversation.id)).toEqual(before)
    expect(readFileSync(join(paths.conversationsDir, `${conversation.id}.jsonl`), 'utf8'))
      .toContain('需要保留的原文')
    expect(openStores(isolatedPaths()).conversations.list()).toEqual([])
  })

  test.each(['pi', 'zima'] as const)('%s：原文、压缩消息、父子关系与 opaque artifact 引用重建后保持一致', (runtimeId) => {
    const paths = isolatedPaths()
    const stores = openStores(paths)
    const root = stores.sessions.create({ runtimeId, title: '根会话' })
    const child = stores.sessions.create({
      runtimeId, title: '子会话', parentSessionId: root.id, rootSessionId: root.id,
      parentToolUseId: 'delegate-call', subagentType: 'coder',
    })
    const task = stores.tasks.create({
      rootSessionId: root.id, parentSessionId: root.id, childSessionId: child.id,
      parentToolUseId: 'delegate-call', title: '子任务', objective: '检查文件',
      subagentType: 'coder', runInBackground: true, depth: 1,
    })
    const artifactPath = join(paths.runtimeSessionsDir, 'opaque-artifact')
    // 存储只保存不透明引用，不按 Runtime 格式解析或重写 artifact。
    writeTextFileAtomic(artifactPath, '不透明的 Runtime 私有内容')
    stores.sessions.update(root.id, { sdkSessionId: 'opaque-session', runtimeSessionFile: artifactPath })
    stores.sessions.appendMessage(root.id, {
      type: 'user', message: { content: '压缩前的原文' }, parent_tool_use_id: null, uuid: 'root-user',
    })
    stores.sessions.appendMessage(root.id, {
      type: 'system', subtype: 'compact_boundary', compact_result: 'success',
      compact_reason: 'threshold', summary: '已完成的任务摘要', uuid: 'compact-1',
      context_tokens_before: 1000, context_tokens_after: 100,
    })
    stores.sessions.appendMessage(root.id, {
      type: 'assistant', message: { content: [{ type: 'text', text: '压缩后继续回答' }] },
      parent_tool_use_id: null, uuid: 'root-assistant',
    })
    stores.sessions.appendMessage(child.id, {
      type: 'assistant', message: { content: [{ type: 'text', text: '子任务结果' }] },
      parent_tool_use_id: 'delegate-call', uuid: 'child-assistant',
    })
    stores.tasks.transition(task.id, { status: 'running' })
    stores.tasks.transition(task.id, { status: 'completed', resultSummary: '检查完成' })
    const rootMessages = stores.sessions.getMessages(root.id)
    const childMessages = stores.sessions.getMessages(child.id)
    const reloaded = openStores(paths)
    expect(reloaded.sessions.get(root.id)).toMatchObject({ runtimeId, sdkSessionId: 'opaque-session', runtimeSessionFile: artifactPath })
    expect(reloaded.sessions.get(child.id)).toMatchObject({ parentSessionId: root.id, rootSessionId: root.id, parentToolUseId: 'delegate-call' })
    expect(reloaded.sessions.getMessages(root.id)).toEqual(rootMessages)
    expect(reloaded.sessions.getMessages(child.id)).toEqual(childMessages)
    expect(reloaded.tasks.get(task.id)).toEqual(stores.tasks.get(task.id))
    expect(readFileSync(reloaded.state.agentMessagesPath(root.id, 'main'), 'utf8'))
      .toContain('压缩前的原文')
    expect(readFileSync(artifactPath, 'utf8')).toBe('不透明的 Runtime 私有内容')

    // 再次写根元数据仍保留任务状态与子会话记录。
    reloaded.sessions.update(root.id, { title: '重命名根会话' })
    expect(reloaded.tasks.get(task.id)?.status).toBe('completed')
    expect(reloaded.state.read(root.id).agents[child.id]).toBeDefined()
    expect(openStores(isolatedPaths()).sessions.list()).toEqual([])
  })
})
