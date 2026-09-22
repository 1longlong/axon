/**
 * 本地敏感配置编解码边界
 *
 * Electron safeStorage 通过最小后端接口注入，使领域管理器不直接依赖 Electron。
 */

const SECURE_PREFIX = 'secure:v1:'
const PLAINTEXT_PREFIX = 'plain:v1:'

export interface SafeStorageBackend {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export interface CredentialCodec {
  readonly isSecure: boolean
  readonly storageKind: 'safe-storage' | 'plaintext-fallback'
  encrypt(plainText: string): string
  decrypt(encoded: string): string
}

export type ChannelCredentialCodec = CredentialCodec

function encodeBase64(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64')
}

function decodePlaintextEnvelope(encoded: string): string {
  return Buffer.from(encoded.slice(PLAINTEXT_PREFIX.length), 'base64').toString('utf-8')
}

export function createCredentialCodec(
  backend?: SafeStorageBackend,
): CredentialCodec {
  const canEncrypt = backend?.isEncryptionAvailable() === true

  if (canEncrypt && backend) {
    return {
      isSecure: true,
      storageKind: 'safe-storage',
      encrypt(plainText: string): string {
        if (!plainText) return ''
        return `${SECURE_PREFIX}${backend.encryptString(plainText).toString('base64')}`
      },
      decrypt(encoded: string): string {
        if (!encoded) return ''
        // 某次启动安全存储临时不可用时可能写入 fallback；恢复后仍应可读并在下次更新时转为安全密文。
        if (encoded.startsWith(PLAINTEXT_PREFIX)) return decodePlaintextEnvelope(encoded)
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
    storageKind: 'plaintext-fallback',
    encrypt(plainText: string): string {
      if (!plainText) return ''
      // 使用带版本前缀的 base64 只为避免配置文件误解析；它不是加密。
      return `${PLAINTEXT_PREFIX}${encodeBase64(plainText)}`
    },
    decrypt(encoded: string): string {
      if (!encoded) return ''
      if (!encoded.startsWith(PLAINTEXT_PREFIX)) {
        throw new Error('凭据格式与当前安全存储策略不匹配')
      }
      try {
        return decodePlaintextEnvelope(encoded)
      } catch {
        throw new Error('读取凭据失败')
      }
    },
  }
}

/** 保留渠道领域命名的薄入口，底层编码规则由通用敏感配置编解码器统一维护。 */
export function createChannelCredentialCodec(backend?: SafeStorageBackend): ChannelCredentialCodec {
  return createCredentialCodec(backend)
}
