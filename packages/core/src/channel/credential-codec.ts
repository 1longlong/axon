/**
 * 本地敏感配置编解码边界
 *
 * 领域管理器只等待异步端口；入口可注入本地安全存储或跨进程宿主桥。
 */

const SECURE_PREFIX = 'secure:v1:'

export interface SafeStorageBackend {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export interface CredentialCodec {
  readonly isSecure: boolean
  readonly storageKind: 'safe-storage' | 'unavailable'
  encrypt(plainText: string): Promise<string>
  decrypt(encoded: string): Promise<string>
}

export type ChannelCredentialCodec = CredentialCodec

/** 将入口提供的安全存储包装成异步端口；没有可用后端时禁止持久化非空凭据。 */
export function createCredentialCodec(
  backend?: SafeStorageBackend,
): CredentialCodec {
  const canEncrypt = backend?.isEncryptionAvailable() === true

  if (canEncrypt && backend) {
    return {
      isSecure: true,
      storageKind: 'safe-storage',
      async encrypt(plainText: string): Promise<string> {
        if (!plainText) return ''
        try { return `${SECURE_PREFIX}${backend.encryptString(plainText).toString('base64')}` }
        catch { throw new Error('加密凭据失败') }
      },
      async decrypt(encoded: string): Promise<string> {
        if (!encoded) return ''
        if (!encoded.startsWith(SECURE_PREFIX)) {
          throw new Error('凭据格式与当前安全存储策略不匹配')
        }
        try {
          return backend.decryptString(Buffer.from(encoded.slice(SECURE_PREFIX.length), 'base64'))
        } catch {
          throw new Error('解密凭据失败')
        }
      },
    }
  }

  return {
    isSecure: false,
    storageKind: 'unavailable',
    async encrypt(plainText: string): Promise<string> {
      if (!plainText) return ''
      throw new Error('系统安全存储不可用，无法保存凭据')
    },
    async decrypt(encoded: string): Promise<string> {
      if (!encoded) return ''
      throw new Error('系统安全存储不可用，无法读取凭据')
    },
  }
}

/** 保留渠道领域命名的薄入口，底层编码规则由通用敏感配置编解码器统一维护。 */
export function createChannelCredentialCodec(backend?: SafeStorageBackend): ChannelCredentialCodec {
  return createCredentialCodec(backend)
}
