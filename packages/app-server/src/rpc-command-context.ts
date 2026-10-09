/** 应用命令解析后的进程内上下文，不参与 JSON 序列化。 */
import type { AxonBackend } from '@axon/core'
import type { AppServerClient, RpcJsonValue, RpcParams } from '@axon/shared'

export interface AppServerCommandContext { backend: AxonBackend; client: AppServerClient; input?: RpcJsonValue }
export type ResolveAppServerClient = (params: RpcParams, fields: readonly string[]) => AppServerCommandContext
