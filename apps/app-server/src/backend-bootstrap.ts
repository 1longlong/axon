/** 独立入口装配实际 Runtime/宿主；业务状态与写盘仍交给 createBackend。 */
import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { buildAgentSandboxPolicy, createBackend, createBackendPaths, createLocalSkillCatalogProvider, LoopServiceError } from '@axon/core'
import type { AxonBackend } from '@axon/core'
import { AppServerBootstrapCleanupError, createExecHostPorts, createPrivateHostPorts, LoopControlServer } from '@axon/app-server'
import type { AppServerBootstrap, JsonRpcPeer } from '@axon/app-server'
import { AgentSandboxCommandService, AgentDocumentCommandEnvironment, checkAgentEnvironment, prepareAgentImage, LoopPrecheckRunner, LoopPrecheckPermissionError } from '@axon/host-node'
import { PiAgentAdapter, ZimaAgentAdapter, assertZimaConnection } from '@axon/runtime-adapters'
import { AGENT_RUNTIME_CAPABILITIES, APP_SERVER_NOTIFICATIONS } from '@axon/shared'
import type { AgentRuntimeId, AgentSessionCreateInput, AppServerInitializeInput } from '@axon/shared'
import type { AppServerStartupConfig } from './startup-config'

const DOCUMENT_SKILLS = [
  { catalogId: 'axon-builtin/pdf', name: 'pdf', version: '1.0.0' },
  { catalogId: 'axon-builtin/documents', name: 'documents', version: '1.0.0' },
]

/** configured 只表示受控解释器文件可执行，实际 Runtime 版本握手仍由 adapter 在运行时检查。 */
function configuredPython(value: string | undefined): value is string {
  if (!value || !isAbsolute(value) || value.includes('\0')) return false
  try { accessSync(value, constants.X_OK); return statSync(value).isFile() } catch { return false }
}

/** 握手成功后才创建业务目录；能力报告来源于本次宿主探测，不接受父端替代沙箱结果。 */
export async function bootstrapAppServerBackend(
  peer: JsonRpcPeer, input: AppServerInitializeInput, config: AppServerStartupConfig, signal: AbortSignal,
  holdDirectory?: (signal: AbortSignal) => void | Promise<void>,
): Promise<AppServerBootstrap> {
  signal.throwIfAborted()
  const paths = createBackendPaths(config)
  const host = createPrivateHostPorts(peer, input.hostCapabilities)
  // 入口类型来自可信 argv，不允许业务握手把桌面改成另一种凭据/配置来源。
  const execHost = config.entry === 'exec' ? await createExecHostPorts(peer, signal) : undefined
  signal.throwIfAborted()
  // 配置校验后、任何业务文件读改写前取锁；实际服务拥有句柄到进程退出。
  if (execHost && !holdDirectory) throw new Error('非交互后端未提供目录独占能力')
  await holdDirectory?.(signal)
  signal.throwIfAborted()
  let backend: AxonBackend | undefined
  const executor = new AgentSandboxCommandService({ shellSnapshotDirectory: paths.shellSnapshotsDir,
    getShellSessionActivity: () => new Map(backend?.sessions.list().map((session) => [session.id, session.updatedAt]) ?? []) })
  const pi = new PiAgentAdapter(undefined, executor)
  // 构造能力对象不会启动 Python；未配置的 adapter 不能进入执行路由。
  const pythonAvailable = configuredPython(config.zimaPython)
  const zima = new ZimaAgentAdapter(config.zimaPython ?? '', config.applicationVersion)
  const loopControl = new LoopControlServer()
  const loopPrecheck = new LoopPrecheckRunner(executor)
  let documents: AgentDocumentCommandEnvironment | undefined
  const resolveAdapter = (runtimeId: AgentRuntimeId) => {
    if (runtimeId === 'pi') return pi
    if (!configuredPython(config.zimaPython)) throw new Error('Zima Runtime 受控解释器未配置或不可用')
    return zima
  }
  const validateRuntime = async (value: AgentSessionCreateInput): Promise<void> => {
    if (value.runtimeId !== 'zima') return
    resolveAdapter('zima')
    if (!value.channelId || !value.modelId) throw new Error('Zima 会话必须先选择渠道和模型')
    const channel = await backend!.channels.resolve(value.channelId)
    if (!channel.enabled || !channel.models.some((model) => model.id === value.modelId && model.enabled)) throw new Error('Zima 会话选择的渠道或模型不可用')
    assertZimaConnection(channel)
  }
  try {
    if (!execHost && config.documentHelper && config.builtinSkillsRoot) {
      documents = new AgentDocumentCommandEnvironment({ executable: process.execPath, entry: config.documentHelper,
        runtime: process.versions.electron ? 'electron' : process.versions.bun ? 'bun' : 'node',
        waitUntilUnused: async () => {
          const results = await Promise.allSettled([executor.drain(), ...(backend ? [backend.drainRuns()] : [])])
          if (results.some((result) => result.status === 'rejected')) throw new Error('文档命令使用者清理失败，已保留命令目录')
        } })
    }
    backend = createBackend({ paths, applicationVersion: config.applicationVersion, credentialCodec: host.credentialCodec,
      ...(execHost ? { sessionCreationOrigin: 'exec' as const, agentConfiguration: execHost.bootstrap.agent, runtimeChannels: execHost.bootstrap.channels,
        resolveRuntimeCredential: execHost.resolveRuntimeCredential } : {}),
      confirmChannelTarget: host.confirmChannelTarget, resolveAdapter, checkEnvironment: checkAgentEnvironment,
      ...(!execHost ? { prepareAgentImage } : {}),
      ownedResources: [pi, zima, loopPrecheck, executor, loopControl, ...(documents ? [documents] : [])],
      ...(documents ? {
        skillCatalog: createLocalSkillCatalogProvider(config.builtinSkillsRoot!, DOCUMENT_SKILLS),
        agentToolEnvironment: { pathPrepend: [documents.commandDirectory], environmentOverrides: {} },
        protectedToolRoots: documents.readOnlyRoots,
      } : {}),
      isManagedSkillAvailable: (session, skill) => !DOCUMENT_SKILLS.some((item) => item.catalogId === skill.catalogId)
        || Boolean(documents && session.runtimeId === 'pi'),
      onLoopNotification: (event) => { if (!peer.closed) peer.notify(APP_SERVER_NOTIFICATIONS.LOOP_NOTIFICATION, event) },
      loopPrecheck: async (request) => {
        try {
          const policy = buildAgentSandboxPolicy({ projectRoot: request.definition.workspacePath, mode: request.definition.sandboxMode })
          policy.networkAccess = request.definition.precheckNetworkAccess === true
          return await loopPrecheck.run({ code: request.definition.workflow!, prev: request.cursor, cwd: request.definition.workspacePath, policy, control: request.control, signal: request.signal })
        } catch (error) {
          if (error instanceof LoopPrecheckPermissionError) throw new LoopServiceError('forbidden', error.message)
          throw error
        }
      },
      validateCreate: validateRuntime, validateRuntimeSession: validateRuntime })
    // 首次只处理一次默认选择；之后即使用户取消安装，也不能在启动时替用户改回。
    if (documents && backend.settings.get().agentBuiltinSkillsInitialized !== true) {
      const snapshot = await backend.skills.apply(DOCUMENT_SKILLS.map((skill) => skill.catalogId), signal)
      signal.throwIfAborted()
      backend.settings.update({ agentBuiltinSkillsInitialized: true })
      if (snapshot.failures.length) console.warn('[内置 Skills] 默认安装未全部完成，请在 Skills 设置中查看并确认')
    }
    // 服务开始接收会话请求前收敛上次中断的子任务，不能让 UI 恢复伪运行态。
    backend.tasks.markRunningDelegationsAsInterrupted()
    signal.throwIfAborted()
    const piSandbox = pi.getSandboxCapability({ platform: 'macos' }), zimaSandbox = zima.getSandboxCapability({ platform: 'macos' })
    if (!execHost && piSandbox.supported) {
      const context = await loopControl.start((token, argv) => backend!.loops.dispatchCli(token, argv))
      signal.throwIfAborted()
      backend.loops.start(context)
    }
    return { backend, applicationVersion: config.applicationVersion, capabilities: {
      ...input.hostCapabilities,
      runtimes: [{ runtimeId: 'pi', configured: true, capabilities: { ...AGENT_RUNTIME_CAPABILITIES.pi, osSandbox: piSandbox.supported }, sandbox: piSandbox },
        { runtimeId: 'zima', configured: pythonAvailable, capabilities: { ...AGENT_RUNTIME_CAPABILITIES.zima, osSandbox: false }, sandbox: zimaSandbox }],
    } }
  } catch (error) {
    // 装配失败不把已创建后端或 adapter 留给下次握手，也不切换到进程内实现。
    if (backend) {
      try { backend.dispose() } catch { /* 仍须等待其他资源，不泄露底层异常。 */ }
      try { await backend.drain() } catch { throw new AppServerBootstrapCleanupError() }
    } else {
      const resources = [pi, zima, loopPrecheck, executor, loopControl, ...(documents ? [documents] : [])]
      let cleanupFailed = false
      for (const resource of resources) {
        try { resource.dispose() } catch { cleanupFailed = true }
      }
      const results = await Promise.allSettled(resources.map((resource) => Promise.resolve().then(() => resource.drain())))
      if (cleanupFailed || results.some((result) => result.status === 'rejected')) throw new AppServerBootstrapCleanupError()
    }
    throw error
  }
}
