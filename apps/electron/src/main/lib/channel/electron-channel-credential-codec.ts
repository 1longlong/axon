/** Electron safeStorage 的生产环境敏感配置适配器。 */

import { safeStorage } from 'electron'
import { createCredentialCodec } from './channel-credential-codec'
import type { ChannelCredentialCodec, CredentialCodec } from './channel-credential-codec'

export function createElectronCredentialCodec(): CredentialCodec {
  return createCredentialCodec(safeStorage)
}

export function createElectronChannelCredentialCodec(): ChannelCredentialCodec {
  const codec = createElectronCredentialCodec()
  if (!codec.isSecure) {
    console.warn('[渠道管理] 系统安全存储不可用，凭据将使用受限权限文件明文保存')
  }
  return codec
}
