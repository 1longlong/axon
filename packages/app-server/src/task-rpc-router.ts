/** 子任务查询与只读实时投影；运行控制和审批仍由原 owner 的 Agent 路由负责。 */
import { AgentTaskControllerError } from '@axon/core'
import { APP_SERVER_METHODS as methods, APP_SERVER_NOTIFICATIONS as notices } from '@axon/shared'
import type { RpcJsonObject } from '@axon/shared'
import { configObject } from './config-input'
import { RpcConnectionError, RpcFault } from './json-rpc-peer'
import type { JsonRpcPeer } from './json-rpc-peer'
import type { AppServerCommandContext, ResolveAppServerClient } from './rpc-command-context'
import { toWireValue } from './wire-value'
import { TaskSubscriptionRegistry } from './task-subscription-registry'

export class TaskRpcRouter {
  private readonly subscriptions = new TaskSubscriptionRegistry()

  /** 固定只读命令调用 core controller；客户端身份由连接层校验，不接受 owner 或执行参数。 */
  constructor(private readonly peer: JsonRpcPeer, resolve: ResolveAppServerClient) {
    const handle = (method: string, fields: readonly string[], action: (context: AppServerCommandContext) => unknown): void => {
      peer.handle(method, (params, { signal }) => {
        const context = resolve(params, fields)
        signal.throwIfAborted()
        try { return toWireValue(action(context)) }
        catch (error) {
          if (error instanceof AgentTaskControllerError) {
            throw new RpcFault(error.code === 'invalid_input' ? -32602 : -32027, '子任务请求失败', { code: error.code })
          }
          throw error
        }
      })
    }
    handle(methods.TASK_LIST, ['input'], ({ backend, input }) => backend.taskController.list(input))
    handle(methods.TASK_GET, ['input'], ({ backend, input }) => {
      const value = configObject(input, ['rootSessionId', 'taskId'])
      return backend.taskController.get(value.rootSessionId, value.taskId)
    })
    handle(methods.TASK_SUBSCRIBE, [], ({ backend, client }) => this.subscriptions.subscribe(client.clientId,
      (listener) => backend.taskController.subscribe(client.clientId, listener),
      () => !this.peer.closed && backend.clients.has(client.clientId),
      (event) => {
        try { this.peer.notify(notices.TASK_EVENT, toWireValue({ clientId: client.clientId, ...event }) as RpcJsonObject) }
        catch { this.peer.close(new RpcConnectionError('protocol', '子任务事件无法传输')) }
      }))
    handle(methods.TASK_UNSUBSCRIBE, ['input'], ({ client, input }) => {
      if (typeof input !== 'string' || !input.trim() || input.length > 200) throw new RpcFault(-32602, '子任务订阅标识无效')
      return this.subscriptions.unsubscribe(client.clientId, input.trim())
    })
  }

  detach(clientId: string): void { this.subscriptions.detach(clientId) }
  close(): void { this.subscriptions.close() }
}
