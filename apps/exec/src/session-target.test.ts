import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APP_SERVER_METHODS as methods } from '@axon/shared'
import type { RpcJsonValue } from '@axon/shared'
import { toWireValue } from '@axon/app-server'
import { parseExecArguments, ExecInputError } from './arguments'
import { ExecBackendError } from './backend-process'
import type { ExecBackendProcess } from './backend-process'
import { prepareExec } from './preflight'
import { prepareExecSession } from './session-target'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

/** 真实输入预检配合受控业务端口；此夹具不宣称 Runtime 或沙箱执行。 */
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'axon-exec-target-')))
  directories.push(root)
  const home = join(root, 'home'), cwd = join(root, 'project')
  mkdirSync(home); mkdirSync(cwd); mkdirSync(join(home, '.axon-exec'))
  writeFileSync(join(home, '.axon-exec', 'config.json'), JSON.stringify({ defaults: { channel: 'selected' }, channels: [
    { id: 'selected', provider: 'custom', baseUrl: 'http://localhost:8123/v1', defaultModel: 'fixture',
      models: [{ id: 'fixture' }], apiKeyRequired: false },
  ] }))
  const prepared = await prepareExec(parseExecArguments(['exec', '--skip-git-repo-check', '  原始任务\n\n']),
    { originalCwd: cwd, homeDir: home, platform: 'darwin', isTTY: true })
  const stop = new AbortController()
  const calls: Array<{ method: string; input?: RpcJsonValue }> = []
  const projects: RpcJsonValue[] = []
  let sessionCount = 0
  const response: { capability: RpcJsonValue; sessionPatch: Record<string, RpcJsonValue>; sessions: Array<Record<string, unknown>> } = {
    capability: { levels: ['off', 'high'], defaultLevel: 'high' }, sessionPatch: {}, sessions: [],
  }
  const authorizations: string[] = []
  const backend: Pick<ExecBackendProcess, 'request' | 'signal' | 'authorizeChannel'> = {
    signal: stop.signal, authorizeChannel(id) { authorizations.push(id) }, async request(method, input) {
    calls.push({ method, input })
    if (method === methods.AGENT_GET_REASONING_CAPABILITY) return response.capability
    if (method === methods.AGENT_LIST_SESSIONS) return toWireValue(response.sessions)
    if (method === methods.AGENT_GET_SESSION) return toWireValue(response.sessions.find((item) => item.id === input) ?? null)
    if (method === methods.AGENT_UPDATE_SESSION) {
      const update = input as { sessionId: string; update: Record<string, RpcJsonValue> }
      return toWireValue({ ...response.sessions.find((item) => item.id === update.sessionId), ...update.update, ...response.sessionPatch })
    }
    if (method === methods.PROJECT_LIST) return projects
    if (method === methods.PROJECT_CREATE) {
      const value = { id: `project-${projects.length}`, name: 'project', slug: 'project', memoryEnabled: false,
        createdAt: 1, updatedAt: 1, workspace: { kind: 'local', path: cwd } }
      projects.push(value)
      return value
    }
    if (method === methods.PROJECT_UPDATE) {
      const target = projects[0] as Record<string, RpcJsonValue>
      target.memoryEnabled = true
      return target
    }
    if (method === methods.AGENT_CREATE_SESSION) return { ...(input as Record<string, RpcJsonValue>),
      creationOrigin: 'exec', creationWorkspacePath: cwd, id: `session-${++sessionCount}`, title: '新任务', createdAt: 1, updatedAt: 1, ...response.sessionPatch }
    throw new Error('意外业务请求')
  } }
  return { root, prepared, backend, stop, calls, projects, response, authorizations }
}

describe('exec 项目与会话执行前准备', () => {
  test('同一真实目录复用项目，每次新建根会话，策略和原始任务交给后续 send', async () => {
    const f = await fixture()
    const first = await prepareExecSession(f.backend, f.prepared)
    const second = await prepareExecSession(f.backend, f.prepared)
    expect(second.project.id).toBe(first.project.id)
    expect(second.session.id).not.toBe(first.session.id)
    expect(first.session).toMatchObject({ runtimeId: 'pi', channelId: 'selected', modelId: 'fixture',
      sandboxMode: 'readOnly', approvalPolicy: 'never', approvalReviewer: 'user', userInputPolicy: 'reject' })
    expect(first.prompt).toBe('  原始任务\n\n')
    expect(f.calls.filter((call) => call.method === methods.PROJECT_CREATE)).toHaveLength(1)
    expect(f.calls.some((call) => call.method === methods.AGENT_SEND)).toBe(false)
  })

  test('明确 thinking 在任何项目/会话创建前确认；不接受未知能力或不支持的等级', async () => {
    const f = await fixture()
    f.prepared.configuration.settings.thinking = 'high'
    const target = await prepareExecSession(f.backend, f.prepared)
    expect(f.calls[0]).toEqual({ method: methods.AGENT_GET_REASONING_CAPABILITY,
      input: { runtimeId: 'pi', channelId: 'selected', modelId: 'fixture' } })
    expect(target.session.thinkingLevel).toBe('high')
    for (const capability of [null, { levels: ['low'], defaultLevel: 'low' }, { levels: ['high'], defaultLevel: 'low' },
      { levels: ['high', 'unknown'], defaultLevel: 'high' }, { levels: ['high', 'high'], defaultLevel: 'high' }]) {
      const invalid = await fixture()
      invalid.prepared.configuration.settings.thinking = 'high'
      invalid.response.capability = capability
      await expect(prepareExecSession(invalid.backend, invalid.prepared)).rejects.toBeInstanceOf(ExecInputError)
      expect(invalid.calls.map((call) => call.method)).toEqual([methods.AGENT_GET_REASONING_CAPABILITY])
      expect(invalid.projects).toEqual([])
    }
  })

  test('工作区别名按真实目录匹配，托管/其他目录不误选，同目录重复项目稳定选择', async () => {
    const f = await fixture()
    const alias = join(f.root, 'alias')
    symlinkSync(f.prepared.cwd, alias)
    const base = { name: '项目', slug: 'project', memoryEnabled: false, updatedAt: 1 }
    f.projects.push({ ...base, id: 'managed', createdAt: 0, workspace: { kind: 'managed' } },
      { ...base, id: 'other', createdAt: 0, workspace: { kind: 'local', path: f.prepared.homeDir } },
      { ...base, id: 'second', createdAt: 2, workspace: { kind: 'local', path: f.prepared.cwd } },
      { ...base, id: 'first', createdAt: 1, workspace: { kind: 'local', path: alias } })
    const target = await prepareExecSession(f.backend, f.prepared)
    expect(target.project.id).toBe('first')
    expect(f.calls.filter((call) => call.method === methods.PROJECT_CREATE)).toEqual([])
    expect(target.session.projectId).toBe('first')
  })

  test('CLI 开启记忆时启用所属项目；关闭只由本次装配屏蔽，不覆盖项目既有开关', async () => {
    const f = await fixture()
    f.prepared.configuration.settings.memory = true
    expect((await prepareExecSession(f.backend, f.prepared)).project.memoryEnabled).toBe(true)
    f.prepared.configuration.settings.memory = false
    expect((await prepareExecSession(f.backend, f.prepared)).project.memoryEnabled).toBe(true)
    expect(f.calls.filter((call) => call.method === methods.PROJECT_UPDATE)).toHaveLength(1)
  })

  test('取消不做业务请求；错误会话响应不发送任务、不重试或删除未知记录', async () => {
    const canceled = await fixture()
    canceled.stop.abort()
    await expect(prepareExecSession(canceled.backend, canceled.prepared)).rejects.toThrow()
    expect(canceled.calls).toEqual([])
    const patches: Array<Record<string, RpcJsonValue>> = [{ approvalPolicy: 'onRequest' }, { userInputPolicy: 'ask' },
      { parentSessionId: 'foreign' }, { projectId: 'foreign' }, { sandboxMode: 'workspaceWrite' }]
    for (const patch of patches) {
      const invalid = await fixture()
      invalid.response.sessionPatch = patch
      await expect(prepareExecSession(invalid.backend, invalid.prepared)).rejects.toBeInstanceOf(ExecBackendError)
      expect(invalid.calls.filter((call) => call.method === methods.AGENT_CREATE_SESSION)).toHaveLength(1)
      expect(invalid.calls.some((call) => call.method === methods.AGENT_SEND || call.method === methods.AGENT_DELETE_SESSION)).toBe(false)
    }
  })

  test('恢复原 CLI 根，不创建新项目/会话或回放任务；默认保留原渠道模型和 artifact', async () => {
    const f = await fixture(), created = await prepareExecSession(f.backend, f.prepared)
    f.response.sessions.push({ ...created.session, sdkSessionId: 'artifact-id', runtimeSessionFile: '/artifact/session.jsonl' })
    f.prepared.args = parseExecArguments(['exec', 'resume', created.session.id, '--skip-git-repo-check', '新的任务'])
    f.prepared.configuration.settings.channel = 'new-task-default'
    f.calls.length = 0; f.authorizations.length = 0
    const target = await prepareExecSession(f.backend, f.prepared)
    expect(target.session).toMatchObject({ id: created.session.id, channelId: 'selected', modelId: 'fixture',
      sdkSessionId: 'artifact-id', runtimeSessionFile: '/artifact/session.jsonl', creationOrigin: 'exec' })
    expect(target.prompt).toBe(f.prepared.prompt)
    expect(f.calls.map((call) => call.method)).toEqual([methods.PROJECT_LIST, methods.AGENT_GET_SESSION, methods.AGENT_UPDATE_SESSION])
    expect(f.authorizations).toEqual(['selected'])
  })

  test('--last 默认当前真实工作区；--all 选全局最新但保留原项目目录，不迁移', async () => {
    const f = await fixture(), created = await prepareExecSession(f.backend, f.prepared)
    const other = join(f.root, 'other'); mkdirSync(other)
    f.projects.push({ ...created.project, id: 'other-project', workspace: { kind: 'local', path: other } })
    f.response.sessions.push({ ...created.session }, { ...created.session, id: 'newest', updatedAt: 2, projectId: 'other-project', creationWorkspacePath: other },
      { ...created.session, id: 'desktop', updatedAt: 3, creationOrigin: null },
      { ...created.session, id: 'child', updatedAt: 4, parentSessionId: created.session.id, subagentType: 'coder' })
    f.prepared.args = parseExecArguments(['exec', 'resume', '--last', '--skip-git-repo-check', '继续'])
    expect((await prepareExecSession(f.backend, f.prepared)).session.id).toBe(created.session.id)
    f.prepared.args = parseExecArguments(['exec', 'resume', '--last', '--all', '--skip-git-repo-check', '继续'])
    const all = await prepareExecSession(f.backend, f.prepared)
    expect(all.session.id).toBe('newest'); expect(all.project.workspace).toEqual({ kind: 'local', path: other })
    expect(f.calls.filter((call) => call.method === methods.PROJECT_CREATE)).toHaveLength(1)
  })

  test('恢复拒绝普通/子/异 Runtime/异工作区/坏策略/禁用模型，授权与更新均不发生', async () => {
    for (const patch of [{ creationOrigin: null }, { parentSessionId: 'parent', subagentType: 'coder' }, { runtimeId: 'zima' },
      { projectId: 'missing' }, { approvalPolicy: 'onRequest' }, { modelId: 'missing' }, { creationWorkspacePath: '/changed-project' }] satisfies Array<Record<string, RpcJsonValue>>) {
      const f = await fixture(), created = await prepareExecSession(f.backend, f.prepared)
      f.response.sessions.push({ ...created.session, ...patch })
      f.prepared.args = parseExecArguments(['exec', 'resume', created.session.id, '--skip-git-repo-check', '继续'])
      f.calls.length = 0; f.authorizations.length = 0
      await expect(prepareExecSession(f.backend, f.prepared)).rejects.toBeInstanceOf(ExecInputError)
      expect(f.authorizations).toEqual([])
      expect(f.calls.some((call) => call.method === methods.AGENT_UPDATE_SESSION)).toBe(false)
    }
    const f = await fixture(), created = await prepareExecSession(f.backend, f.prepared)
    f.response.sessions.push({ ...created.session }); f.prepared.cwd = f.prepared.homeDir
    f.prepared.args = parseExecArguments(['exec', 'resume', created.session.id, '--skip-git-repo-check', '继续'])
    await expect(prepareExecSession(f.backend, f.prepared)).rejects.toThrow('原工作区')
  })

  test('恢复明确渠道/模型覆盖仍受可信配置与能力验证；凭据不可用时不改会话', async () => {
    const f = await fixture(), created = await prepareExecSession(f.backend, f.prepared)
    f.response.sessions.push({ ...created.session })
    f.prepared.args = parseExecArguments(['exec', 'resume', created.session.id, '--skip-git-repo-check', '继续'])
    f.prepared.configuration.channels.push({ ...f.prepared.configuration.channels[0]!, id: 'override', models: [{ id: 'new-model', name: '新模型', enabled: true, source: 'manual' }] })
    f.prepared.configuration.selectionOverrides = { channel: 'override', model: 'new-model' }
    f.prepared.configuration.settings.thinking = 'high'
    const target = await prepareExecSession(f.backend, f.prepared)
    expect(target.session).toMatchObject({ id: created.session.id, channelId: 'override', modelId: 'new-model', thinkingLevel: 'high' })
    expect(f.authorizations.at(-1)).toBe('override')
    f.calls.length = 0
    f.backend.authorizeChannel = () => { throw new ExecInputError('所选渠道需要凭据') }
    await expect(prepareExecSession(f.backend, f.prepared)).rejects.toThrow('凭据')
    expect(f.calls.some((call) => call.method === methods.AGENT_UPDATE_SESSION)).toBe(false)
  })
})
