import { describe, expect, test } from 'bun:test'
import { createCredentialCodec } from './credential-codec'
import type { SafeStorageBackend } from './credential-codec'

const fakeSafeStorage: SafeStorageBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf-8'),
  decryptString: (value) => value.toString('utf-8').replace(/^encrypted:/, ''),
}

describe('渠道凭据编解码', () => {
  test('安全存储可用时异步返回带版本的安全密文封装', async () => {
    const codec = createCredentialCodec(fakeSafeStorage)
    const encoded = await codec.encrypt('sk-secret')

    expect(codec.isSecure).toBe(true)
    expect(codec.storageKind).toBe('safe-storage')
    expect(encoded.startsWith('secure:v1:')).toBe(true)
    expect(encoded.includes('sk-secret')).toBe(false)
    expect(await codec.decrypt(encoded)).toBe('sk-secret')
  })

  test('缺少宿主安全存储时明确拒绝，不产生明文 fallback', async () => {
    const codec = createCredentialCodec()
    expect(codec.isSecure).toBe(false)
    expect(codec.storageKind).toBe('unavailable')
    await expect(codec.encrypt('sk-local')).rejects.toThrow('安全存储不可用')
    await expect(codec.decrypt('secure:v1:stored')).rejects.toThrow('安全存储不可用')
  })

  test('只读取当前安全封装，不维护旧的明文编码格式', async () => {
    await expect(createCredentialCodec(fakeSafeStorage).decrypt('plain:v1:b2xk')).rejects.toThrow('安全存储策略不匹配')
  })

  test('宿主错误归一后不回显明文', async () => {
    const codec = createCredentialCodec({
      ...fakeSafeStorage,
      encryptString: () => { throw new Error('private-token') },
      decryptString: () => { throw new Error('private-token') },
    })
    await expect(codec.encrypt('private-token')).rejects.toThrow('加密凭据失败')
    await expect(codec.decrypt('secure:v1:stored')).rejects.toThrow('解密凭据失败')
  })

  test('空凭据保持为空字符串，不需要安全后端', async () => {
    const codec = createCredentialCodec()
    expect(await codec.encrypt('')).toBe('')
    expect(await codec.decrypt('')).toBe('')
  })
})
