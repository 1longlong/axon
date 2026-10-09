/** 后端业务装配：接收明确目录、版本、凭据和 Runtime，自行拥有运行与交互协调。 */

import type {
  AgentMemoryFile,
  AgentProviderAdapter,
  AgentRuntimeId,
  AgentSessionCreateInput,
  AppSettings,
  UserProfile,
} from '@axon/shared'
import { AgentEventBus } from './agent/agent-event-bus'
import { AgentCapabilityController } from './agent/agent-capability-controller'
import type { AgentCapabilityControllerOptions } from './agent/agent-capability-controller'
import { AgentRunCoordinator } from './agent/agent-run-coordinator'
import { BackendClientRegistry } from './backend-client-registry'
import { AgentPermissionService } from './security/agent-permission-service'
import { AgentAskUserService } from './security/agent-ask-user-service'
import { buildAgentSystemPrompt } from './agent/agent-git-attribution'
import { AgentRootStateStore } from './agent/agent-root-state-store'
import { AgentService } from './agent/agent-service'
import type { AgentServiceOptions } from './agent/agent-service'
import { AgentSessionManager } from './agent/agent-session-manager'
import { createAgentTitleGenerator } from './agent/agent-title-generator'
import { buildAgentToolGuidance } from './agent/agent-tool-guidance'
import { withAgentToolSearch } from './agent/agent-tool-search'
import { ChannelManager } from './channel/channel-manager'
import { ChannelController } from './channel/channel-controller'
import { ChannelNetworkService } from './channel/channel-network-service'
import type { ChannelNetworkOptions } from './channel/channel-network-service'
import type { CredentialCodec } from './channel/credential-codec'
import { MessageHistoryController } from './storage/message-history-controller'
import { AttachmentService } from './chat/attachment-service'
import { AttachmentController } from './chat/attachment-controller'
import { ChatService } from './chat/chat-service'
import { ChatRunCoordinator } from './chat/chat-run-coordinator'
import type { ChatStreamExecutor } from './chat/chat-service'
import { ConversationManager } from './chat/conversation-manager'
import { createDocumentParser } from './chat/document-parser'
import { AgentCollaborationService } from './collaboration/agent-collaboration-service'
import { buildAgentCollaborationSystemPrompt, buildSubagentSystemPrompt, createAgentCollaborationTools } from './collaboration/agent-collaboration-tools'
import { AgentDelegationManager } from './collaboration/agent-delegation-manager'
import { AgentTaskController } from './collaboration/agent-task-controller'
import { McpProjectConfigManager } from './mcp/mcp-project-config-manager'
import { McpProjectController } from './mcp/mcp-project-controller'
import { McpToolProvider } from './mcp/mcp-tool-provider'
import type { McpToolProviderOptions } from './mcp/mcp-tool-provider'
import { AgentMemoryController } from './memory/agent-memory-controller'
import { AgentMemoryService } from './memory/agent-memory-service'
import { createAgentMemoryTools, resolveAgentMemoryContext } from './memory/agent-memory-tools'
import { AgentMemoryWatcher } from './memory/agent-memory-watcher'
import { AgentProjectManager } from './project/agent-project-manager'
import { AgentProjectController } from './project/agent-project-controller'
import { emptyAgentSkillCatalogProvider } from './project/agent-skill-catalog'
import type { AgentSkillCatalogProvider } from './project/agent-skill-catalog'
import { AgentSkillInstallationService } from './project/agent-skill-installation-service'
import { AgentSkillSettingsController } from './project/agent-skill-settings-controller'
import { resolveProjectInstructions } from './project/project-instruction-resolver'
import { discoverAgentSkills, discoverGlobalAgentSkills } from './project/project-skill-discovery'
import { WorkspaceWatcher } from './project/workspace-watcher'
import { initializeBackendDirectories } from './settings/backend-paths'
import type { BackendPaths } from './settings/backend-paths'
import { getSettings, updateSettings } from './settings/settings-service'
import { getUserProfile, updateUserProfile } from './settings/user-profile-service'
import { createAxonUserAgent } from './providers/provider-request-config'

/** 入口创建的资源归后端统一释放，包括尚未被业务解析使用的 adapter 与宿主执行器。 */
export interface BackendOwnedResource {
  dispose(): void
  drain(): Promise<void>
}

export interface BackendOptions {
  paths: BackendPaths
  applicationVersion: string
  credentialCodec: CredentialCodec
  confirmChannelTarget?: ChannelNetworkOptions['confirmTarget']
  channelFetch?: ChannelNetworkOptions['fetch']
  resolveAdapter: (runtimeId: AgentRuntimeId) => AgentProviderAdapter
  ownedResources?: readonly BackendOwnedResource[]
  checkEnvironment?: AgentCapabilityControllerOptions['checkEnvironment']
  validateRuntimeSession?: AgentServiceOptions['validateRuntimeSession']
  validateCreate?: (input: AgentSessionCreateInput) => void | Promise<void>
  /** 可替换模型传输用于隔离测试；同一端口同时服务 Chat 和 Agent 标题。 */
  providerStream?: ChatStreamExecutor
  connectMcpServer?: McpToolProviderOptions['connectServer']
  skillCatalog?: AgentSkillCatalogProvider
}

/** 后端内部服务集合；不是可绕过 owner 校验的跨进程协议 API。 */
export interface AxonBackend {
  paths: BackendPaths
  settings: { get: () => AppSettings; update: (updates: Partial<AppSettings>) => AppSettings }
  userProfile: { get: () => UserProfile; update: (updates: Partial<UserProfile>) => UserProfile }
  channels: ChannelManager
  channelController: ChannelController
  channelNetwork: ChannelNetworkService
  conversations: ConversationManager
  attachments: AttachmentService
  attachmentController: AttachmentController
  projects: AgentProjectManager
  projectController: AgentProjectController
  sessions: AgentSessionManager
  state: AgentRootStateStore
  tasks: AgentDelegationManager
  taskController: AgentTaskController
  histories: MessageHistoryController
  events: AgentEventBus
  agent: AgentService
  agentCapabilities: AgentCapabilityController
  clients: BackendClientRegistry
  agentRuns: AgentRunCoordinator
  permissions: AgentPermissionService
  askUsers: AgentAskUserService
  chat: ChatService
  chatRuns: ChatRunCoordinator
  collaboration: AgentCollaborationService
  mcp: McpProjectController
  mcpTools: McpToolProvider
  memory: AgentMemoryController
  memoryService: AgentMemoryService
  workspaceWatcher: WorkspaceWatcher
  skills: AgentSkillSettingsController
  getAdapter: (runtimeId: AgentRuntimeId) => AgentProviderAdapter
  /** 同步发出停止并释放空闲资源；不代表异步请求已经 drain，独立进程退出由生命周期层等待。 */
  dispose: () => void
  /** dispose 后等待 Agent/Chat/队列/子任务/标题的真实异步收束；不包括完整 MCP/adapter/host drain。 */
  drainRuns: () => Promise<void>
  /** dispose 后汇聚所有业务与入口移交资源；不负责关闭外部协议或强制终止宿主进程。 */
  drain: () => Promise<void>
}

/**
 * 从输入端口装配共享存储、上下文与运行服务；Runtime SDK、宿主执行不进入本层。
 * 同一后端的主/子会话共用根状态，Chat 与 Agent 共享渠道但保持各自历史和提示词链。
 */
export function createBackend(options: BackendOptions): AxonBackend {
  const userAgent = createAxonUserAgent(options.applicationVersion)
  const paths = { ...options.paths }
  initializeBackendDirectories(paths)
  const settings = {
    get: () => getSettings(paths.settingsPath),
    update: (updates: Partial<AppSettings>) => updateSettings(updates, paths.settingsPath),
  }
  const userProfile = {
    get: () => getUserProfile(paths.userProfilePath),
    update: (updates: Partial<UserProfile>) => updateUserProfile(updates, paths.userProfilePath),
  }
  const channels = new ChannelManager({ configPath: paths.channelsPath, credentialCodec: options.credentialCodec })
  const conversations = new ConversationManager({ indexPath: paths.conversationsIndexPath, messagesDir: paths.conversationsDir })
  const attachments = new AttachmentService({ attachmentsDir: paths.attachmentsDir })
  const attachmentController = new AttachmentController(attachments)
  const projects = new AgentProjectManager({ indexPath: paths.agentProjectsIndexPath, projectsDir: paths.agentProjectsDir })
  const state = new AgentRootStateStore(paths.agentSessionsDir)
  const sessions = new AgentSessionManager({ indexPath: paths.agentSessionsIndexPath, sessionsDir: paths.agentSessionsDir, stateStore: state })
  const tasks = new AgentDelegationManager({ stateStore: state })
  const memoryService = new AgentMemoryService({ projects })
  const memoryWatcher = new AgentMemoryWatcher()
  const workspaceWatcher = new WorkspaceWatcher()
  const configs = new McpProjectConfigManager({
    credentialCodec: options.credentialCodec, resolveProjectDataDir: (id) => projects.resolveProjectDataDir(id),
  })
  const mcpTools = new McpToolProvider({
    applicationVersion: options.applicationVersion, getProjectConfig: (id) => configs.get(id),
    ...(options.connectMcpServer ? { connectServer: options.connectMcpServer } : {}),
  })
  const mcp = new McpProjectController({ configs, tools: mcpTools, projects })
  const installations = new AgentSkillInstallationService({
    managedSkillsRoot: paths.managedSkillsDir, statePath: paths.skillInstallationsPath,
    getDesiredCatalogIds: () => settings.get().agentSkillCatalogIds,
    setDesiredCatalogIds: (ids) => { settings.update({ agentSkillCatalogIds: ids }) },
  })
  const globalSkillRoots = { builtinSkillsRoot: paths.managedSkillsDir, userSkillsRoot: paths.userSkillsDir }
  const skills = new AgentSkillSettingsController({
    catalog: options.skillCatalog ?? emptyAgentSkillCatalogProvider,
    installations, discoverGlobalSkills: () => discoverGlobalAgentSkills(globalSkillRoots),
  })

  // 只缓存已实际使用的 adapter；删除会话不能启动尚未装配的 Runtime。
  const adapters = new Map<AgentRuntimeId, AgentProviderAdapter>()
  const ownedResources = new Set<BackendOwnedResource>(options.ownedResources)
  const cleanupFailures: Error[] = []
  let disposed = false
  const getAdapter = (runtimeId: AgentRuntimeId): AgentProviderAdapter => {
    if (disposed) throw new Error('后端已释放')
    let adapter = adapters.get(runtimeId)
    if (!adapter) {
      adapter = options.resolveAdapter(runtimeId)
      adapters.set(runtimeId, adapter)
      ownedResources.add(adapter)
    }
    return adapter
  }
  const events = new AgentEventBus()
  const agentCapabilities = new AgentCapabilityController({ sessions, channels, projects, resolveAdapter: getAdapter,
    checkEnvironment: options.checkEnvironment })
  const clients = new BackendClientRegistry()
  const taskController = new AgentTaskController({ clients, sessions, tasks, events })
  const histories = new MessageHistoryController({ clients, sessions, conversations, tasks: taskController })
  const channelController = new ChannelController(channels)
  const channelNetwork = new ChannelNetworkService({ clients, manager: channels,
    confirmTarget: options.confirmChannelTarget, fetch: options.channelFetch,
  })
  const projectController = new AgentProjectController({ clients, projects, sessions, watcher: workspaceWatcher })
  const memory = new AgentMemoryController({ clients, memory: memoryService, projects, watcher: memoryWatcher })
  const permissions = new AgentPermissionService()
  const askUsers = new AgentAskUserService()
  let unsubscribePermissions = (): void => {}
  let unsubscribeAskUsers = (): void => {}
  let collaboration: AgentCollaborationService
  let agentRuns: AgentRunCoordinator
  const agent = new AgentService({
    adapter: getAdapter('pi'), resolveAdapter: getAdapter, validateRuntimeSession: options.validateRuntimeSession,
    channelManager: channels, sessionManager: sessions, eventBus: events,
    runtimeConfigDir: paths.runtimeConfigDir, runtimeSessionDir: paths.runtimeSessionsDir,
    resolveProjectCwd: (id) => projects.resolveProjectCwd(id),
    resolveProjectInstructions: (projectRoot) => resolveProjectInstructions({ projectRoot }),
    discoverAgentSkills: (projectRoot) => discoverAgentSkills({ projectRoot, ...globalSkillRoots }),
    getProjectMemoryContext: (id, previous) => projects.get(id)?.memoryEnabled
      ? resolveAgentMemoryContext(id, memoryService, previous) : undefined,
    getSystemPrompt: (session) => {
      const config = settings.get()
      const base = [buildAgentSystemPrompt(config.agentSystemPrompt, config.gitAttributionEnabled),
        buildAgentToolGuidance(session.subagentType)].join('\n\n')
      return session.subagentType ? buildSubagentSystemPrompt(base, session.subagentType) : buildAgentCollaborationSystemPrompt(base)
    },
    getCustomTools: async ({ sessionId, projectId, runStartedAt, runSignal }) => {
      const session = sessions.get(sessionId)
      const role = session?.subagentType
      const updateMemoryBaseline = (file: AgentMemoryFile): void => {
        const current = sessions.get(sessionId)
        if (current) sessions.update(sessionId, { memoryFileStates: {
          ...(current.memoryFileStates ?? {}), [file.relativePath]: { updatedAt: file.updatedAt, size: file.size },
        } })
      }
      // 主/子角色只收到各自允许的工具；搜索目录只能由过滤后的集合生成。
      const memoryTools = projects.get(projectId)?.memoryEnabled
        ? createAgentMemoryTools({ projectId, memory: memoryService, onRead: updateMemoryBaseline, onWrite: updateMemoryBaseline })
          .filter((tool) => !role || role === 'coder' || tool.name !== 'MemoryWrite') : []
      return withAgentToolSearch([
        ...(!role ? [askUsers.createTool(sessionId, runStartedAt, runSignal)] : []),
        ...(session?.parentSessionId ? [] : createAgentCollaborationTools({ sessionId, runSignal, collaboration })),
        ...memoryTools,
        ...(role === 'explore' || role === 'plan' ? [] : await mcpTools.getTools(projectId, runSignal)),
      ])
    },
    createCanUseTool: (sessionId, startedAt, signal) => permissions.createCanUseTool(
      sessionId, startedAt, signal, sessions.get(sessionId)?.subagentType,
    ),
    onStopSession: (id) => collaboration.cancelDescendants(id),
    generateTitle: createAgentTitleGenerator(userAgent, options.providerStream),
  })
  // 工具回调只在真正查询时执行；先完成双向装配，再开放服务，避免循环初始化单例。
  collaboration = new AgentCollaborationService({
    sessions, delegations: tasks, agent, resolveProjectCwd: (id) => projects.resolveProjectCwd(id),
    bindChildInteractionOwner: (parent, child) => agentRuns.bindChildInteractionOwner(parent, child),
  })
  // 先登记任务状态落盘，再登记客户端投递；UI 收到审批时能读取一致的 blocked 状态。
  unsubscribePermissions = permissions.subscribe((event) => collaboration.handleInteractionEvent(event))
  unsubscribeAskUsers = askUsers.subscribe((event) => collaboration.handleInteractionEvent(event))
  agentRuns = new AgentRunCoordinator({ clients, sessions, agent, events, permissions, askUsers,
    validateCreate: options.validateCreate,
    cancelChild: (childId) => {
      const child = sessions.get(childId)
      const task = child?.rootSessionId ? tasks.list(child.rootSessionId).find((item) => item.childSessionId === childId) : undefined
      if (task) collaboration.cancel(task.parentSessionId, task.id)
    },
  })
  collaboration.setBackgroundCompletionHandler((delegation) => agentRuns.notifyBackgroundCompletion(delegation))
  const parseDocument = createDocumentParser()
  const chat = new ChatService({
    channelManager: channels, conversationManager: conversations, userAgent, stream: options.providerStream,
    readAttachmentData: (path) => {
      try { return attachments.readAsBase64(path) } catch { return undefined }
    },
    extractDocumentText: async (attachment) => {
      const buffer = Buffer.from(attachments.readAsBase64(attachment.localPath), 'base64')
      return parseDocument({ filename: attachment.filename, mediaType: attachment.mediaType, buffer })
    },
  })
  const chatRuns = new ChatRunCoordinator({ clients, conversations, chat, attachments })
  let unsubscribeDeleted = (): void => {}
  /** 清理逐项隔离；索引读取或某个端口失败也不能跳过 adapter 和 watcher 回收。 */
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    const failures: Error[] = []
    const clean = (action: () => void): void => {
      try { action() } catch {
        const failure = new Error('后端同步资源清理失败')
        failures.push(failure)
        cleanupFailures.push(failure)
      }
    }
    // 先封住派生、发送和附属标题入口，后续断开回调不能重新调度已排队工作。
    clean(() => collaboration.dispose())
    clean(() => agent.dispose())
    clean(() => chat.dispose())
    clean(() => mcp.dispose())
    clean(() => skills.dispose())
    clean(() => channelController.dispose())
    clean(() => projectController.dispose())
    clean(() => clients.dispose())
    clean(() => agentCapabilities.dispose())
    clean(() => histories.dispose())
    clean(() => channelNetwork.dispose())
    clean(() => taskController.dispose())
    clean(() => agentRuns.dispose())
    clean(() => chatRuns.dispose())
    clean(() => memory.dispose())
    clean(() => {
      for (const session of sessions.list()) {
        clean(() => permissions.cancelSession(session.id))
        clean(() => askUsers.cancelSession(session.id))
      }
    })
    for (const cleanup of [unsubscribePermissions, unsubscribeAskUsers, unsubscribeDeleted,
      () => workspaceWatcher.dispose(), () => memoryWatcher.dispose(), () => mcpTools.dispose(),
      ...[...ownedResources].map((resource) => () => resource.dispose())]) clean(cleanup)
    adapters.clear()
    if (failures.length) throw new AggregateError(failures, '后端资源清理失败')
  }
  let drainingRuns: Promise<void> | undefined
  /** 只等待运行链子集；完整退出调用 drain，同时等待控制器和自有资源。 */
  const drainRuns = (): Promise<void> => {
    if (!disposed) return Promise.reject(new Error('必须先释放后端入口再等待运行结束'))
    return drainingRuns ??= Promise.all([
      agentRuns.drain(), chatRuns.drain(), collaboration.drain(), agent.drain(), chat.drain(),
    ]).then(() => {})
  }
  let draining: Promise<void> | undefined
  /** 所有等待并行登记，逐项失败不提前返回；运行/控制器/资源的真实 finally 全部结束才完成。 */
  const drain = (): Promise<void> => {
    if (!disposed) return Promise.reject(new Error('必须先释放后端入口再等待资源结束'))
    return draining ??= Promise.allSettled([
      () => drainRuns(), () => mcp.drain(), () => mcpTools.drain(), () => skills.drain(),
      () => agentCapabilities.drain(), () => channelController.drain(), () => channelNetwork.drain(),
      () => projectController.drain(), ...[...ownedResources].map((resource) => () => resource.drain()),
    ].map((wait) => Promise.resolve().then(wait))).then((results) => {
      const failures = [...cleanupFailures, ...results.filter((result) => result.status === 'rejected')
        .map(() => new Error('后端异步资源清理失败'))]
      if (failures.length) throw new AggregateError(failures, '后端资源等待失败')
    })
  }
  // 开放服务前登记存储生命周期订阅；失败撤销已装配资源，不返回半初始化后端。
  try {
    unsubscribeDeleted = sessions.onSessionsDeleted((deleted) => {
      for (const session of deleted) adapters.get(session.runtimeId)?.releaseSession?.(session.id)
    })
  } catch (error) {
    try { dispose() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], '后端装配失败且资源清理失败')
    }
    throw error
  }
  return {
    paths, settings, userProfile, channels, channelController, channelNetwork, conversations, attachments, attachmentController,
    projects, projectController, state, sessions, tasks, taskController, histories,
    events, agent, agentCapabilities, clients, agentRuns, permissions, askUsers, chat, chatRuns, collaboration, mcpTools, memoryService, workspaceWatcher, skills, getAdapter,
    mcp,
    memory,
    dispose,
    drainRuns,
    drain,
  }
}
