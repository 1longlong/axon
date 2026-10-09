/** Electron safeStorage 的生产环境敏感配置适配器。 */

import { safeStorage } from 'electron'
import { createCredentialCodec } from '@axon/core/credential-codec'
import type { CredentialCodec } from '@axon/core/credential-codec'

/** 只包装原生安全存储端口，不经 core 总入口加载业务装配或管理器。 */
export function createElectronCredentialCodec(): CredentialCodec {
  return createCredentialCodec(safeStorage)
}
