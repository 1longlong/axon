/** 私有宿主桥：安全存储留在可信父进程，core 只接收异步中立端口。 */
import type { ChannelNetworkOptions, CredentialCodec } from '@axon/core'
import { APP_SERVER_HOST_METHODS as methods } from '@axon/shared'
import type { AppServerInitializeInput, BackendClientId, RpcParams } from '@axon/shared'
import { RpcFault } from './json-rpc-peer'
import type { JsonRpcPeer } from './json-rpc-peer'

type HostCapabilities = AppServerInitializeInput['hostCapabilities']
export interface PrivateHostBridgeOptions {
  credentialCodec: CredentialCodec
  /** 父进程从真实入口登记表查信号；不能使用请求自报来源或当前窗口替代。 */
  getClientSignal: (clientId: BackendClientId) => AbortSignal | undefined
  confirmChannelTarget?: ChannelNetworkOptions['confirmTarget']
}
export interface PrivateHostPorts {
  credentialCodec: CredentialCodec
  confirmChannelTarget: NonNullable<ChannelNetworkOptions['confirmTarget']>
}
export interface PrivateHostPortOptions {
  /** 人工目标确认不沿用普通短请求超时；仍受 owner/连接取消约束。 */
  confirmationTimeoutMs?: number
}

function record(params: RpcParams, fields: readonly string[]): Record<string, unknown> {
  if (Array.isArray(params) || Object.keys(params).some((key) => !fields.includes(key))) {
    throw new RpcFault(-32602, '宿主请求参数无效')
  }
  return params
}
function credential(params: RpcParams): string {
  const input = record(params, ['value'])
  if (typeof input.value !== 'string') throw new RpcFault(-32602, '宿主凭据请求无效')
  return input.value
}
function target(params: RpcParams): { clientId: string; url: string } {
  const input = record(params, ['clientId', 'url'])
  if (typeof input.clientId !== 'string' || !input.clientId || typeof input.url !== 'string') {
    throw new RpcFault(-32602, '宿主目标确认请求无效')
  }
  try {
    const url = new URL(input.url)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
  } catch { throw new RpcFault(-32602, '宿主目标地址无效') }
  return { clientId: input.clientId, url: input.url }
}

/** 父进程在握手前安装私有方法；只公开实际端口能力，异常不回显密钥或原生错误。 */
export function registerPrivateHostBridge(peer: JsonRpcPeer, options: PrivateHostBridgeOptions): HostCapabilities {
  const { credentialCodec: codec } = options
  const storage = codec.isSecure && codec.storageKind === 'safe-storage' ? 'safe-storage' : 'unavailable'
  for (const [method, operation] of [[methods.ENCRYPT_CREDENTIAL, 'encrypt'], [methods.DECRYPT_CREDENTIAL, 'decrypt']] as const) {
    peer.handle(method, async (params, { signal }) => {
      const value = credential(params)
      if (value && storage !== 'safe-storage') throw new RpcFault(-32010, '宿主安全存储不可用')
      try {
        // 原始 envelope 由 codec 负责；桥只转发字符串，不解码、落盘或注入环境。
        signal.throwIfAborted()
        const result = await codec[operation](value)
        signal.throwIfAborted()
        if (typeof result !== 'string' || operation === 'encrypt' && value && !result) throw new Error()
        return result
      } catch { throw new RpcFault(-32010, '宿主凭据操作失败') }
    })
  }
  peer.handle(methods.CONFIRM_CHANNEL_TARGET, async (params, { signal }) => {
    const input = target(params)
    const clientSignal = options.getClientSignal(input.clientId)
    if (!options.confirmChannelTarget || !clientSignal || clientSignal.aborted || signal.aborted) return false
    const combined = AbortSignal.any([signal, clientSignal])
    let cancel: (() => void) | undefined
    try {
      const canceled = new Promise<boolean>((resolve) => {
        cancel = () => resolve(false)
        combined.addEventListener('abort', cancel, { once: true })
      })
      const allowed = await Promise.race([
        options.confirmChannelTarget(input.clientId, input.url, combined), canceled,
      ])
      // 原生对话返回时重查原入口；重载/断开/超时后的旧批准不得开启网络。
      return allowed === true && !combined.aborted && options.getClientSignal(input.clientId) === clientSignal
    } catch { return false }
    finally { if (cancel) combined.removeEventListener('abort', cancel) }
  })
  return { credentialStorage: storage, channelTargetConfirmation: options.confirmChannelTarget !== undefined }
}

/** 后端把协商能力变成 core 端口；无桥、坏响应、取消或断开一律不默认放行。 */
export function createPrivateHostPorts(
  peer: JsonRpcPeer, capabilities: HostCapabilities, options: PrivateHostPortOptions = {},
): PrivateHostPorts {
  const confirmationTimeoutMs = options.confirmationTimeoutMs ?? 300_000
  if (!Number.isSafeInteger(confirmationTimeoutMs) || confirmationTimeoutMs <= 0) throw new Error('宿主确认超时无效')
  const secure = capabilities.credentialStorage === 'safe-storage'
  const canConfirm = capabilities.channelTargetConfirmation
  const invokeCredential = async (method: string, value: string): Promise<string> => {
    if (!value) return ''
    if (!secure || peer.closed) throw new Error('宿主安全存储不可用')
    try {
      const result = await peer.request(method, { value })
      if (typeof result !== 'string' || method === methods.ENCRYPT_CREDENTIAL && !result) throw new Error()
      return result
    } catch { throw new Error('宿主凭据操作失败') }
  }
  return {
    credentialCodec: {
      isSecure: secure, storageKind: secure ? 'safe-storage' : 'unavailable',
      encrypt: (value) => invokeCredential(methods.ENCRYPT_CREDENTIAL, value),
      decrypt: (value) => invokeCredential(methods.DECRYPT_CREDENTIAL, value),
    },
    async confirmChannelTarget(clientId, url, signal): Promise<boolean> {
      if (!canConfirm || peer.closed || signal.aborted) return false
      try {
        const result = await peer.request(methods.CONFIRM_CHANNEL_TARGET, { clientId, url }, { signal, timeoutMs: confirmationTimeoutMs })
        return result === true && !signal.aborted && !peer.closed
      } catch { return false }
    },
  }
}
