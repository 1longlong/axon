/** 独立入口装配实际 Runtime/宿主；业务状态与写盘仍交给 createBackend。 */
import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { createBackend, createBackendPaths } from '@axon/core'
import type { AxonBackend } from '@axon/core'
import { AppServerBootstrapCleanupError, createPrivateHostPorts } from '@axon/app-server'
import type { AppServerBootstrap, JsonRpcPeer } from '@axon/app-server'
import { AgentSandboxCommandService, checkAgentEnvironment } from '@axon/host-node'
import { PiAgentAdapter, ZimaAgentAdapter, assertZimaConnection } from '@axon/runtime-adapters'
import { AGENT_RUNTIME_CAPABILITIES } from '@axon/shared'
import type { AgentRuntimeId, AgentSessionCreateInput, AppServerInitializeInput } from '@axon/shared'
import type { AppServerStartupConfig } from './startup-config'

/** configured 只表示受控解释器文件可执行，实际 Runtime 版本握手仍由 adapter 在运行时检查。 */
function configuredPython(value: string | undefined): value is string {
  if (!value || !isAbsolute(value) || value.includes('\0')) return false
  try { accessSync(value, constants.X_OK); return statSync(value).isFile() } catch { return false }
}

/** 握手成功后才创建业务目录；能力报告来源于本次宿主探测，不接受父端替代沙箱结果。 */
export async function bootstrapAppServerBackend(
  peer: JsonRpcPeer, input: AppServerInitializeInput, config: AppServerStartupConfig, signal: AbortSignal,
): Promise<AppServerBootstrap> {
  signal.throwIfAborted()
  const paths = createBackendPaths(config)
  const host = createPrivateHostPorts(peer, input.hostCapabilities)
  let backend: AxonBackend | undefined
  const executor = new AgentSandboxCommandService({ shellSnapshotDirectory: paths.shellSnapshotsDir,
    getShellSessionActivity: () => new Map(backend?.sessions.list().map((session) => [session.id, session.updatedAt]) ?? []) })
  const pi = new PiAgentAdapter(undefined, executor)
  // 构造能力对象不会启动 Python；未配置的 adapter 不能进入执行路由。
  const pythonAvailable = configuredPython(config.zimaPython)
  const zima = new ZimaAgentAdapter(config.zimaPython ?? '', config.applicationVersion)
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
    backend = createBackend({ paths, applicationVersion: config.applicationVersion, credentialCodec: host.credentialCodec,
      confirmChannelTarget: host.confirmChannelTarget, resolveAdapter, checkEnvironment: checkAgentEnvironment,
      ownedResources: [pi, zima, executor],
      validateCreate: validateRuntime, validateRuntimeSession: validateRuntime })
    // 服务开始接收会话请求前收敛上次中断的子任务，不能让 UI 恢复伪运行态。
    backend.tasks.markRunningDelegationsAsInterrupted()
    signal.throwIfAborted()
    const piSandbox = pi.getSandboxCapability({ platform: 'macos' }), zimaSandbox = zima.getSandboxCapability({ platform: 'macos' })
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
      const resources = [pi, zima, executor]
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
