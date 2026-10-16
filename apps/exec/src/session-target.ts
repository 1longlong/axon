/** CLI 的执行前准备；只消费中立业务 RPC，不直接读写项目/会话索引或 Runtime artifact。 */
import { realpathSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import { APP_SERVER_METHODS as methods } from '@axon/shared'
import type { AgentProject, AgentSessionMeta, AgentThinkingLevel, RpcJsonValue } from '@axon/shared'
import { ExecInputError } from './arguments'
import { ExecBackendError } from './backend-process'
import type { ExecBackendProcess } from './backend-process'
import type { PreparedExec } from './preflight'
import { validateExecWorkspace } from './preflight'

export interface ExecSessionTarget {
  project: AgentProject
  session: AgentSessionMeta
  /** 不将用户文本拼入系统指令，不修剪 stdin 的原始换行。 */
  prompt: string
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function project(value: RpcJsonValue): AgentProject {
  if (!object(value) || typeof value.id !== 'string' || !value.id
    || typeof value.name !== 'string' || !value.name || typeof value.slug !== 'string' || !value.slug
    || typeof value.createdAt !== 'number' || typeof value.updatedAt !== 'number' || typeof value.memoryEnabled !== 'boolean'
    || !object(value.workspace) || !['managed', 'local'].includes(String(value.workspace.kind))
    || value.workspace.kind === 'local' && (typeof value.workspace.path !== 'string' || !isAbsolute(value.workspace.path))) {
    throw new ExecBackendError('startup')
  }
  return value as unknown as AgentProject
}

/** 目录失效的旧项目不能被误选；可访问的符号链接别名按真实工作区复用。 */
function sameWorkspace(value: AgentProject, cwd: string): boolean {
  if (value.workspace.kind !== 'local') return false
  try { return realpathSync(value.workspace.path) === cwd } catch { return false }
}

/** 恢复仅接受完整根元数据；目录摘要、普通 external 或子会话不能伪装 CLI 来源。 */
function session(value: RpcJsonValue): AgentSessionMeta {
  if (!object(value) || typeof value.id !== 'string' || !value.id || typeof value.title !== 'string' || !value.title
    || !['pi', 'zima'].includes(String(value.runtimeId))
    || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)
    || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) || value.updatedAt < value.createdAt) {
    throw new ExecBackendError('startup')
  }
  return value as unknown as AgentSessionMeta
}
function isExecRoot(value: AgentSessionMeta): boolean {
  return value.creationOrigin === 'exec' && typeof value.creationWorkspacePath === 'string'
    && isAbsolute(value.creationWorkspacePath) && !value.parentSessionId && !value.rootSessionId && !value.subagentType
}

/** 显式等级只能属于 adapter 返回的可信能力；未知模型或未实现能力不能静默忽略。 */
function assertThinking(value: RpcJsonValue, requested: AgentThinkingLevel): void {
  const allowed = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  if (!object(value) || !Array.isArray(value.levels) || !value.levels.length
    || !value.levels.every((level) => typeof level === 'string' && allowed.includes(level))
    || new Set(value.levels).size !== value.levels.length || typeof value.defaultLevel !== 'string' || !value.levels.includes(value.defaultLevel)
    || !value.levels.includes(requested)) throw new ExecInputError('所选模型没有确认支持指定 thinking 等级，不创建会话或发送任务')
}

/** 模型能力先确认，再复用/建立工作区项目，最后创建 never/reject 根会话供 send 消费。 */
export async function prepareExecSession(
  backend: Pick<ExecBackendProcess, 'request' | 'signal' | 'authorizeChannel'>, prepared: PreparedExec,
): Promise<ExecSessionTarget> {
  backend.signal.throwIfAborted()
  if (prepared.args.kind === 'resume') return resumeExecSession(backend, prepared)
  const { channel, model, settings } = prepared.configuration
  if (!channel?.enabled || !model || !channel.models.some((item) => item.id === model && item.enabled)) {
    throw new ExecInputError('新会话需要启用的渠道和模型')
  }
  if (settings.thinking !== undefined) {
    const capability = await backend.request(methods.AGENT_GET_REASONING_CAPABILITY,
      { runtimeId: settings.runtime, channelId: channel.id, modelId: model })
    assertThinking(capability, settings.thinking)
  }
  backend.authorizeChannel(channel.id)
  backend.signal.throwIfAborted()
  const list = await backend.request(methods.PROJECT_LIST)
  if (!Array.isArray(list)) throw new ExecBackendError('startup')
  const candidates = list.map(project).filter((item) => sameWorkspace(item, prepared.cwd))
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  // 多个既有项目绑定同一目录时稳定选最早者，不重复新建或跨目录修改项目。
  let selected = candidates[0] ?? project(await backend.request(methods.PROJECT_CREATE, {
    name: (basename(prepared.cwd) || '工作区').slice(0, 100), workspace: { kind: 'local', path: prepared.cwd },
  }))
  if (!sameWorkspace(selected, prepared.cwd)) throw new ExecInputError('后端项目工作区与指定目录不一致')
  if (settings.memory && !selected.memoryEnabled) {
    const selectedId = selected.id
    selected = project(await backend.request(methods.PROJECT_UPDATE, { projectId: selected.id, update: { memoryEnabled: true } }))
    if (selected.id !== selectedId || !sameWorkspace(selected, prepared.cwd) || !selected.memoryEnabled) throw new ExecBackendError('startup')
  }
  backend.signal.throwIfAborted()
  const created = await backend.request(methods.AGENT_CREATE_SESSION, { runtimeId: settings.runtime,
    channelId: channel.id, modelId: model, projectId: selected.id, sandboxMode: settings.sandbox,
    approvalPolicy: 'never', approvalReviewer: 'user', userInputPolicy: 'reject',
    ...(settings.thinking === undefined ? {} : { thinkingLevel: settings.thinking }),
  })
  if (!object(created) || typeof created.id !== 'string' || !created.id
    || typeof created.title !== 'string' || !created.title
    || typeof created.createdAt !== 'number' || typeof created.updatedAt !== 'number'
    || created.runtimeId !== settings.runtime || created.channelId !== channel.id || created.modelId !== model
    || created.projectId !== selected.id || created.sandboxMode !== settings.sandbox || created.approvalPolicy !== 'never'
    || created.creationOrigin !== 'exec' || created.creationWorkspacePath !== prepared.cwd
    || created.approvalReviewer !== 'user' || created.userInputPolicy !== 'reject'
    || created.parentSessionId !== undefined || created.rootSessionId !== undefined || created.subagentType !== undefined
    || settings.thinking !== undefined && created.thinkingLevel !== settings.thinking) throw new ExecBackendError('startup')
  backend.signal.throwIfAborted()
  return { project: selected, session: created as unknown as AgentSessionMeta, prompt: prepared.prompt }
}

/** 只读选择/校验先于授权和更新；只发送新 prompt，原 artifact/中立恢复仍由现有业务链消费。 */
async function resumeExecSession(backend: Pick<ExecBackendProcess, 'request' | 'signal' | 'authorizeChannel'>,
  prepared: PreparedExec): Promise<ExecSessionTarget> {
  const projectsValue = await backend.request(methods.PROJECT_LIST)
  if (!Array.isArray(projectsValue)) throw new ExecBackendError('startup')
  const projects = projectsValue.map(project)
  let original: AgentSessionMeta
  if (prepared.args.flags.last) {
    const listed = await backend.request(methods.AGENT_LIST_SESSIONS)
    if (!Array.isArray(listed)) throw new ExecBackendError('startup')
    const latest = listed.map(session).filter((item) => isExecRoot(item) && (prepared.args.flags.all
      || projects.some((candidate) => candidate.id === item.projectId && sameWorkspace(candidate, prepared.cwd))))
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id))[0]
    if (!latest) throw new ExecInputError('没有符合范围的 CLI 根会话可恢复')
    original = latest
  } else {
    const found = await backend.request(methods.AGENT_GET_SESSION, prepared.args.sessionId!)
    if (found === null) throw new ExecInputError('指定会话不存在')
    original = session(found)
  }
  if (!isExecRoot(original)) throw new ExecInputError('只能恢复带可信 CLI 来源的根会话，不接受普通或子会话')
  if (original.runtimeId !== 'pi' || prepared.configuration.runtimeExplicit
    && prepared.configuration.settings.runtime !== original.runtimeId) throw new ExecInputError('不能切换原会话 Runtime；非交互首版仅支持 Pi')
  if (original.approvalPolicy !== 'never' || original.userInputPolicy !== 'reject') throw new ExecInputError('原 CLI 会话的非交互策略无效')
  let selected = projects.find((item) => item.id === original.projectId)
  if (!selected || selected.workspace.kind !== 'local') throw new ExecInputError('原项目或本地工作区已不可用')
  if (!sameWorkspace(selected, original.creationWorkspacePath!)) throw new ExecInputError('原项目工作区已改绑，不能在新目录恢复旧会话')
  if (!prepared.args.flags.all && !sameWorkspace(selected, prepared.cwd)) throw new ExecInputError('恢复须使用原工作区；跨目录选择仅支持 --last --all')
  await validateExecWorkspace(prepared, selected.workspace.path, backend.signal)
  const { settings, selectionOverrides, channels } = prepared.configuration
  const channelId = selectionOverrides?.channel ?? original.channelId
  const model = selectionOverrides?.model ?? original.modelId
  const channel = channels.find((item) => item.id === channelId && item.enabled)
  if (!channel || !model || !channel.models.some((item) => item.id === model && item.enabled)) {
    throw new ExecInputError('恢复渠道/模型须在当前可信配置中存在且启用；不自动使用新任务默认值')
  }
  if (settings.thinking !== undefined) assertThinking(await backend.request(methods.AGENT_GET_REASONING_CAPABILITY,
    { runtimeId: original.runtimeId, channelId: channel.id, modelId: model }), settings.thinking)
  backend.signal.throwIfAborted()
  backend.authorizeChannel(channel.id)
  if (settings.memory && !selected.memoryEnabled) {
    const updated = project(await backend.request(methods.PROJECT_UPDATE, { projectId: selected.id, update: { memoryEnabled: true } }))
    if (updated.id !== selected.id || !sameWorkspace(updated, realpathSync(selected.workspace.path)) || !updated.memoryEnabled) throw new ExecBackendError('startup')
    selected = updated
  }
  // 原恢复凭据/项目/来源不变；沙箱采用本次配置，never/reject 永不放宽。
  const updated = session(await backend.request(methods.AGENT_UPDATE_SESSION, { sessionId: original.id, update: {
    channelId: channel.id, modelId: model, sandboxMode: settings.sandbox, approvalPolicy: 'never', approvalReviewer: 'user', userInputPolicy: 'reject',
    ...(settings.thinking === undefined ? {} : { thinkingLevel: settings.thinking }),
  } }))
  if (updated.id !== original.id || !isExecRoot(updated) || updated.projectId !== original.projectId || updated.runtimeId !== original.runtimeId
    || updated.sdkSessionId !== original.sdkSessionId || updated.runtimeSessionFile !== original.runtimeSessionFile
    || updated.creationWorkspacePath !== original.creationWorkspacePath
    || updated.channelId !== channel.id || updated.modelId !== model || updated.sandboxMode !== settings.sandbox
    || updated.approvalPolicy !== 'never' || updated.approvalReviewer !== 'user' || updated.userInputPolicy !== 'reject'
    || settings.thinking !== undefined && updated.thinkingLevel !== settings.thinking) throw new ExecBackendError('startup')
  backend.signal.throwIfAborted()
  return { project: selected, session: updated, prompt: prepared.prompt }
}
