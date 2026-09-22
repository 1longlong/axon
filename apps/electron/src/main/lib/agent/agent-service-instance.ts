/** AgentService 的生产装配与应用退出清理入口。 */

import { app } from 'electron'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { createAxonUserAgent } from '@axon/core'
import { AgentEventBus } from './agent-event-bus'
import { AgentService } from './agent-service'
import { PiAgentAdapter } from '../adapters/pi-agent-adapter'
import { assertZimaConnection, ZimaAgentAdapter } from '../adapters/zima-agent-adapter'
import { getAgentSessionManager } from './agent-session-manager-instance'
import { getChannelManager } from '../channel/channel-manager-instance'
import { getAgentRuntimeConfigDir, getAgentRuntimeSessionsDir } from '../core/config-paths'
import { getSettings } from '../settings/settings-service'
import { getAgentPermissionService } from './agent-permission-service'
import { getAgentProjectManager } from '../project/agent-project-manager-instance'
import type {
  AgentMemoryFile,
  AgentProviderAdapter,
  AgentRuntimeId,
  AgentSendInput,
  AgentSessionCreateInput,
} from '@axon/shared'
import { buildAgentSystemPrompt } from './agent-git-attribution'
import { buildAgentToolGuidance } from './agent-tool-guidance'
import { getAgentAskUserService } from './agent-ask-user-service'
import { getAgentExitPlanService } from './agent-exit-plan-service'
import { resolveProjectInstructions } from '../project/project-instruction-resolver'
import { discoverAgentSkills } from '../project/project-skill-discovery'
import { getMcpToolProvider } from '../mcp/mcp-tool-provider-instance'
import { getAgentMemoryService } from '../memory/agent-memory-service-instance'
import { createAgentMemoryTools, resolveAgentMemoryContext } from '../memory/agent-memory-tools'
import { AgentCollaborationService } from '../collaboration/agent-collaboration-service'
import { getAgentDelegationManager } from '../collaboration/agent-delegation-manager-instance'
import {
  buildAgentCollaborationSystemPrompt,
  buildSubagentSystemPrompt,
  createAgentCollaborationTools,
} from '../collaboration/agent-collaboration-tools'
import { createAgentTitleGenerator } from './agent-title-generator'
import { withAgentToolSearch } from './agent-tool-search'

let adapter: PiAgentAdapter | null = null
let zimaAdapter: ZimaAgentAdapter | null = null
let eventBus: AgentEventBus | null = null
let service: AgentService | null = null
let collaborationService: AgentCollaborationService | null = null

/** 只接受开发者显式配置的解释器；同一检查用于创建前校验和真正运行。 */
function getZimaPythonExecutable(): string {
  const executable = process.env.AXON_ZIMA_PYTHON?.trim()
  if (!executable || !isAbsolute(executable)) {
    throw new Error('Zima Runtime 未配置：请设置 AXON_ZIMA_PYTHON 为虚拟环境 Python 的绝对路径')
  }
  try {
    if (!statSync(executable).isFile()) throw new Error('非文件')
  } catch {
    throw new Error('Zima Runtime 的 Python 路径不存在或不可用')
  }
  return executable
}

/** 创建前核对协议、密钥和模型，避免产生一开始就不能发送的 Zima 会话。 */
export function validateAgentRuntimeCreate(input: AgentSessionCreateInput): void {
  if (input.runtimeId !== 'zima') return
  getZimaPythonExecutable()
  if (!input.channelId || !input.modelId) throw new Error('Zima 会话必须先选择渠道和模型')
  const channel = getChannelManager().resolve(input.channelId)
  if (!channel.enabled || !channel.models.some((model) => model.id === input.modelId && model.enabled)) {
    throw new Error('Zima 会话选择的渠道或模型不可用')
  }
  assertZimaConnection(channel)
}

export function getAgentEventBus(): AgentEventBus {
  eventBus ??= new AgentEventBus()
  return eventBus
}

/** 生产环境唯一的 runtime 路由入口；查询能力与真正执行必须落到同一个 adapter。 */
export function getAgentProviderAdapter(runtimeId: AgentRuntimeId): AgentProviderAdapter {
  adapter ??= new PiAgentAdapter()
  if (runtimeId === 'pi') return adapter
  // 开发环境必须显式指定受控虚拟环境解释器，不能退回 PATH 或在线安装。
  const executable = getZimaPythonExecutable()
  zimaAdapter ??= new ZimaAgentAdapter(executable, app.getVersion())
  return zimaAdapter
}

export function getAgentService(): AgentService {
  const defaultAdapter = getAgentProviderAdapter('pi')
  service ??= new AgentService({
    adapter: defaultAdapter,
    resolveAdapter: getAgentProviderAdapter,
    validateRuntimeSession: validateAgentRuntimeCreate,
    eventBus: getAgentEventBus(),
    sessionManager: getAgentSessionManager(),
    channelManager: getChannelManager(),
    runtimeConfigDir: getAgentRuntimeConfigDir(),
    runtimeSessionDir: getAgentRuntimeSessionsDir(),
    resolveProjectCwd: (projectId) => getAgentProjectManager().resolveProjectCwd(projectId),
    resolveProjectInstructions: (projectRoot) => resolveProjectInstructions({ projectRoot }),
    discoverAgentSkills: (projectRoot) => discoverAgentSkills({ projectRoot }),
    getProjectMemoryContext: (projectId, previous) => {
      const project = getAgentProjectManager().get(projectId)
      if (!project?.memoryEnabled) return undefined
      return resolveAgentMemoryContext(projectId, getAgentMemoryService(), previous)
    },
    getSystemPrompt: (session) => {
      const settings = getSettings()
      const base = [
        buildAgentSystemPrompt(settings.agentSystemPrompt, settings.gitAttributionEnabled),
        buildAgentToolGuidance(session.subagentType),
      ].join('\n\n')
      return session.subagentType
        ? buildSubagentSystemPrompt(base, session.subagentType)
        : buildAgentCollaborationSystemPrompt(base)
    },
    getCustomTools: async ({ sessionId, projectId, runStartedAt, runSignal, permissionMode }) => {
      const project = getAgentProjectManager().get(projectId)
      const currentSession = getAgentSessionManager().get(sessionId)
      const subagentType = currentSession?.subagentType
      const updateKnownMemoryFile = (file: AgentMemoryFile): void => {
        const manager = getAgentSessionManager()
        const current = manager.get(sessionId)
        if (!current) return
        manager.update(sessionId, {
          memoryFileStates: {
            ...(current.memoryFileStates ?? {}),
            [file.relativePath]: { updatedAt: file.updatedAt, size: file.size },
          },
        })
      }
      const memoryTools = project?.memoryEnabled
        ? createAgentMemoryTools({
            projectId,
            memory: getAgentMemoryService(),
            onRead: updateKnownMemoryFile,
            onWrite: updateKnownMemoryFile,
          }).filter((tool) => subagentType === 'coder' || !subagentType || tool.name !== 'MemoryWrite')
        : []
      // 内置子 Agent 不再获得 Agent/Task 管理工具，委派链固定在根 Agent 一层结束。
      const collaborationTools = currentSession?.parentSessionId
        ? []
        : createAgentCollaborationTools({
            sessionId,
            runSignal,
            collaboration: getAgentCollaborationService(),
          })
      const tools = [
        ...(!subagentType
          ? [getAgentAskUserService().createTool(sessionId, runStartedAt, runSignal)]
          : []),
        ...(!subagentType && permissionMode === 'plan'
          ? [getAgentExitPlanService().createTool(sessionId, runStartedAt, runSignal)]
          : []),
        ...collaborationTools,
        ...memoryTools,
        ...(subagentType === 'explore' || subagentType === 'plan'
          ? []
          : await getMcpToolProvider().getTools(projectId, runSignal)),
      ]
      // 搜索工具与本轮 MCP 目录绑定，保证结果不会引用已经被角色策略过滤的工具。
      return withAgentToolSearch(tools)
    },
    createCanUseTool: (sessionId, runStartedAt, runSignal) => (
      getAgentPermissionService().createCanUseTool(
        sessionId,
        runStartedAt,
        runSignal,
        getAgentSessionManager().get(sessionId)?.subagentType,
      )
    ),
    onStopSession: (sessionId) => collaborationService?.cancelDescendants(sessionId),
    generateTitle: createAgentTitleGenerator(createAxonUserAgent(app.getVersion())),
  })
  if (!collaborationService) {
    const permissions = getAgentPermissionService()
    const askUsers = getAgentAskUserService()
    const exitPlans = getAgentExitPlanService()
    collaborationService = new AgentCollaborationService({
      sessions: getAgentSessionManager(),
      delegations: getAgentDelegationManager(),
      agent: service,
      resolveProjectCwd: (projectId) => getAgentProjectManager().resolveProjectCwd(projectId),
      bindChildInteractionOwner: (parentSessionId, childSessionId) => {
        const owner = permissions.getOwner(parentSessionId)
        if (owner === undefined) return undefined
        if (!permissions.bindOwner(childSessionId, owner)) throw new Error('权限 owner 冲突')
        if (!askUsers.bindOwner(childSessionId, owner)) {
          permissions.unbindOwner(childSessionId, owner)
          throw new Error('追问 owner 冲突')
        }
        if (!exitPlans.bindOwner(childSessionId, owner)) {
          askUsers.unbindOwner(childSessionId, owner)
          permissions.unbindOwner(childSessionId, owner)
          throw new Error('计划审批 owner 冲突')
        }
        return () => {
          exitPlans.unbindOwner(childSessionId, owner)
          askUsers.unbindOwner(childSessionId, owner)
          permissions.unbindOwner(childSessionId, owner)
        }
      },
    })
    permissions.subscribe((event) => collaborationService?.handleInteractionEvent(event))
    askUsers.subscribe((event) => collaborationService?.handleInteractionEvent(event))
    exitPlans.subscribe((event) => collaborationService?.handleInteractionEvent(event))
  }
  return service
}

/** 先装配主 AgentService，再返回与其共享运行注册表的协作编排器。 */
export function getAgentCollaborationService(): AgentCollaborationService {
  getAgentService()
  return collaborationService!
}

/** 外部入口统一从这里启动 Agent，确保 UI 能识别后台运行且仍复用同一编排主链。 */
export async function runExternalAgent(input: AgentSendInput): Promise<void> {
  await getAgentService().sendMessage(input, { source: 'external' })
}

/** 只停止已创建的实例，异常退出路径不反向初始化 Agent 依赖。 */
export function stopAllAgentRuns(): number {
  return service?.stopAll() ?? 0
}

/** 退出时同步回收两种 runtime；Zima 子进程不能随 Electron 窗口关闭而遗留。 */
export function disposeAgentRuntimeAdapters(): void {
  adapter?.dispose()
  zimaAdapter?.dispose()
}
