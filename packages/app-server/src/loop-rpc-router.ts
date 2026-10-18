/** 固定 Loop 命令和产物查询；不接受路径根、owner、运行凭据或任意后端方法。 */
import { loopId, loopObject, LoopServiceError, loopText, resolveLoopWorkspace, parseMcpProjectConfig, McpProjectConfigManagerError } from '@axon/core'
import { APP_SERVER_METHODS as methods, APP_SERVER_NOTIFICATIONS } from '@axon/shared'
import type { LoopRunDetail, RpcJsonObject } from '@axon/shared'
import type { AppServerCommandContext, ResolveAppServerClient } from './rpc-command-context'
import { RpcFault } from './json-rpc-peer'
import type { JsonRpcPeer } from './json-rpc-peer'
import { toWireValue } from './wire-value'

export class LoopRpcRouter {
  private readonly releases = new Map<string, () => void>()
  constructor(private readonly peer: JsonRpcPeer, resolve: ResolveAppServerClient) {
    const handle = (method: string, fields: readonly string[], action: (context: AppServerCommandContext, signal: AbortSignal) => unknown): void => {
      peer.handle(method, async (params, { signal }) => {
        const context = resolve(params, fields)
        signal.throwIfAborted()
        // Loop 是桌面本地能力，exec/quick 入口不能借此建立新的后台任务。
        if (context.client.kind !== 'main') throw new RpcFault(-32602, '此入口不可管理 Loop')
        this.attach(context)
        try { const result = await action(context, signal); signal.throwIfAborted(); return toWireValue(result) }
        catch (error) {
          if (error instanceof LoopServiceError) throw new RpcFault(-32030, error.message, { code: error.code })
          if (error instanceof McpProjectConfigManagerError) throw new RpcFault(-32026, 'Loop MCP 配置命令失败', { code: error.code })
          throw error
        }
      })
    }
    handle(methods.LOOP_LIST, [], ({ backend }) => backend.loops.list())
    handle(methods.LOOP_MCP_TOOLS, ['input'], async ({ backend, input }, signal) => {
      const value = loopObject(input, ['target', 'config'])
      const target = loopObject(value.target, ['loopId', 'workspacePath'])
      let tools
      if ('loopId' in target && !('workspacePath' in target) && value.config === undefined) {
        const id = loopId(target.loopId)
        backend.loops.resolveWorkspace(id)
        tools = await backend.loopMcpTools.getTools(id, signal)
      } else {
        if ('loopId' in target || !('workspacePath' in target)) throw new LoopServiceError('invalid_input', 'MCP 草稿目标无效')
        resolveLoopWorkspace(loopText(target.workspacePath, '工作目录', 4096))
        const parsed = parseMcpProjectConfig(value.config)
        if (!parsed.ok) throw new LoopServiceError('invalid_input', 'MCP 草稿无效')
        tools = await backend.loopMcpTools.getDraftTools(parsed.config, signal)
      }
      return tools.map(({ name, description }) => ({ name, description: description.slice(0, 1000) }))
    })
    handle(methods.LOOP_MCP_GET_CONFIG, ['input'], ({ backend, input }) => backend.loopMcp.get(loopId(input)))
    handle(methods.LOOP_MCP_SAVE_CONFIG, ['input'], ({ backend, input }) => {
      const value = loopObject(input, ['loopId', 'config']), id = loopId(value.loopId)
      const parsed = parseMcpProjectConfig(value.config)
      if (!parsed.ok) throw new LoopServiceError('invalid_input', 'Loop MCP 配置无效')
      return backend.loops.configureMcp(id, () => backend.loopMcp.save(id, parsed.config))
    })
    handle(methods.LOOP_MCP_TEST_CONNECTION, ['input'], ({ backend, client, input }, signal) => {
      const value = loopObject(input, ['target', 'serverName', 'server'])
      const target = loopObject(value.target, ['loopId', 'workspacePath'])
      if ('loopId' in target && !('workspacePath' in target)) backend.loops.resolveWorkspace(loopId(target.loopId))
      else if ('workspacePath' in target && !('loopId' in target)) resolveLoopWorkspace(loopText(target.workspacePath, '工作目录', 4096))
      else throw new LoopServiceError('invalid_input', 'MCP 测试目标无效')
      return backend.loopMcp.testDraft(value.serverName, value.server, AbortSignal.any([signal, backend.clients.getSignal(client.clientId)!]))
    })
    handle(methods.LOOP_RUNS, ['input'], ({ backend, input }) => {
      const value = loopObject(input, ['loopId', 'before', 'limit'])
      if (value.limit !== undefined && typeof value.limit !== 'number') throw new LoopServiceError('invalid_input', '分页大小无效')
      return backend.loops.readRuns(loopId(value.loopId), value.before === undefined ? undefined : loopId(value.before), value.limit as number | undefined)
    })
    handle(methods.LOOP_GET, ['input'], ({ backend, input }) => backend.loops.get(loopId(input)))
    handle(methods.LOOP_CREATE, ['input'], ({ backend, input }) => backend.loops.createWithAgent(input))
    handle(methods.LOOP_PREPARE, ['input'], ({ backend, input }) => {
      const value = loopObject(input, ['loopId'])
      return backend.loops.prepare(loopId(value.loopId))
    })
    handle(methods.LOOP_UPDATE, ['input'], ({ backend, input }) => {
      const value = loopObject(input, ['loopId', 'update'])
      return backend.loops.update(loopId(value.loopId), value.update)
    })
    handle(methods.LOOP_DELETE, ['input'], ({ backend, input }) => backend.loops.delete(loopId(input)))
    for (const [method, role] of [[methods.LOOP_RUN, 'exec'], [methods.LOOP_EVOLVE, 'evolve'], [methods.LOOP_EDIT, 'edit']] as const) {
      handle(method, ['input'], ({ backend, input }) => {
        const value = loopObject(input, ['loopId', 'instruction'])
        return backend.loops.run(loopId(value.loopId), role, value.instruction === undefined ? undefined : loopText(value.instruction, '修改要求', 16_000))
      })
    }
    handle(methods.LOOP_STOP, ['input'], ({ backend, input }) => {
      const value = loopObject(input, ['loopId', 'runId'])
      return backend.loops.stop(loopId(value.loopId), loopId(value.runId))
    })
    handle(methods.LOOP_ARTIFACTS, ['input'], ({ backend, input }) => {
      const value = loopObject(input, ['loopId', 'runId'])
      backend.loops.get(loopId(value.loopId))
      return backend.loopArtifacts.list(loopId(value.loopId), value.runId === undefined ? undefined : loopId(value.runId))
    })
    handle(methods.LOOP_READ_ARTIFACT, ['input'], ({ backend, input }) => {
      const value = loopObject(input, ['loopId', 'runId', 'path'])
      backend.loops.get(loopId(value.loopId))
      return backend.loopArtifacts.read(loopId(value.loopId), loopText(value.path, '产物路径', 4096), value.runId === undefined ? undefined : loopId(value.runId))
    })
    handle(methods.LOOP_RUN_DETAIL, ['input'], ({ backend, input }): LoopRunDetail => {
      const value = loopObject(input, ['loopId', 'runId'])
      const loop = backend.loops.get(loopId(value.loopId))
      const run = backend.loops.getRun(loop.job.id, loopId(value.runId))
      const runs = backend.loops.runs(loop.job.id)
      const previous = runs.slice(runs.findIndex((entry) => entry.id === run.id) + 1).find((entry) => entry.finishedAt !== null)
      return { job: loop.job, run,
        artifacts: backend.loopArtifacts.list(loop.job.id, run.id), changes: backend.loopArtifacts.diff(loop.job.id, run.id, previous?.id),
        query: run.query ?? '', controls: run.controls ?? [] }
    })
  }

  /** 一客户端一订阅，页面断开只取消通知，不取消独立 Loop owner。 */
  private attach({ backend, client }: AppServerCommandContext): void {
    if (this.releases.has(client.clientId)) return
    this.releases.set(client.clientId, backend.loops.subscribe((event) => {
      if (this.peer.closed || !backend.clients.has(client.clientId)) return
      try { this.peer.notify(APP_SERVER_NOTIFICATIONS.LOOP_CHANGED, toWireValue({ clientId: client.clientId, event }) as RpcJsonObject) }
      catch { /* 业务已提交；连接退出不能回滚任务或另投窗口。 */ }
    }))
  }
  detach(clientId: string): void { this.releases.get(clientId)?.(); this.releases.delete(clientId) }
  close(): void { for (const id of this.releases.keys()) this.detach(id) }
}
