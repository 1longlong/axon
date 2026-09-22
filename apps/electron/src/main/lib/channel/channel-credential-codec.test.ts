import { describe, expect, test } from 'bun:test'
import { createChannelCredentialCodec } from './channel-credential-codec'
import type { SafeStorageBackend } from './channel-credential-codec'

const fakeSafeStorage: SafeStorageBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf-8'),
  decryptString: (value) => value.toString('utf-8').replace(/^encrypted:/, ''),
}

describe('渠道凭据编解码', () => {
  test('安全存储可用时使用带版本的安全密文封装', () => {
    const codec = createChannelCredentialCodec(fakeSafeStorage)
    const encoded = codec.encrypt('sk-secret')

    expect(codec.isSecure).toBe(true)
    expect(codec.storageKind).toBe('safe-storage')
    expect(encoded.startsWith('secure:v1:')).toBe(true)
    expect(encoded.includes('sk-secret')).toBe(false)
    expect(codec.decrypt(encoded)).toBe('sk-secret')
  })

  test('安全存储不可用时使用明确标记的本地 fallback', () => {
    const codec = createChannelCredentialCodec()
    const encoded = codec.encrypt('sk-local')

    expect(codec.isSecure).toBe(false)
    expect(codec.storageKind).toBe('plaintext-fallback')
    expect(encoded.startsWith('plain:v1:')).toBe(true)
    expect(codec.decrypt(encoded)).toBe('sk-local')
  })

  test('安全存储恢复后仍可读取之前的 fallback 凭据', () => {
    const fallbackEncoded = createChannelCredentialCodec().encrypt('sk-migrate')
    expect(createChannelCredentialCodec(fakeSafeStorage).decrypt(fallbackEncoded)).toBe('sk-migrate')
  })

  test('fallback 无法解密安全存储密文时明确失败', () => {
    const secureEncoded = createChannelCredentialCodec(fakeSafeStorage).encrypt('sk-secret')
    expect(() => createChannelCredentialCodec().decrypt(secureEncoded)).toThrow('安全存储策略不匹配')
  })

  test('空凭据保持为空字符串', () => {
    const codec = createChannelCredentialCodec(fakeSafeStorage)
    expect(codec.encrypt('')).toBe('')
    expect(codec.decrypt('')).toBe('')
  })
})
