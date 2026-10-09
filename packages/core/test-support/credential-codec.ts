/** 仅供隔离测试与冒烟使用的固定密钥加密夹具；不得作为生产凭据后端。 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { createCredentialCodec } from '../src/channel/credential-codec'
import type { CredentialCodec } from '../src/channel/credential-codec'

const FIXTURE_KEY = Buffer.alloc(32, 7)

export function createFixtureCredentialCodec(): CredentialCodec {
  return createCredentialCodec({
    isEncryptionAvailable: () => true,
    encryptString: (value) => {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', FIXTURE_KEY, nonce)
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted])
    },
    decryptString: (value) => {
      const decipher = createDecipheriv('aes-256-gcm', FIXTURE_KEY, value.subarray(0, 12))
      decipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
    },
  })
}
