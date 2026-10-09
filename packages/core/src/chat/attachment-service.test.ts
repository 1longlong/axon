import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AttachmentService, AttachmentServiceError } from './attachment-service'

let directory: string
let service: AttachmentService
let idValue: number

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'axon-attachment-'))
  idValue = 1
  service = new AttachmentService({
    attachmentsDir: join(directory, 'attachments'),
    createId: () => `attachment-${idValue++}`,
    now: () => 1_000,
  })
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

async function expectError(action: () => unknown, code: AttachmentServiceError['code']): Promise<void> {
  try {
    await action()
    throw new Error(`应当抛出 ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(AttachmentServiceError)
    expect((error as AttachmentServiceError).code).toBe(code)
  }
}

describe('AttachmentService 保存与读取', () => {
  test('保存附件落盘到会话目录，读取还原原始内容', () => {
    const attachment = service.save({
      conversationId: 'conversation-1',
      filename: '报告.png',
      mediaType: 'image/PNG',
      data: base64('图片内容'),
    })

    expect(attachment).toMatchObject({
      id: 'attachment-1',
      filename: '报告.png',
      mediaType: 'image/png',
      localPath: 'conversation-1/attachment-1.png',
      size: 12,
      createdAt: 1_000,
    })
    const filePath = join(directory, 'attachments', 'conversation-1', 'attachment-1.png')
    expect(existsSync(filePath)).toBe(true)
    expect(service.readAsBase64(attachment.localPath)).toBe(base64('图片内容'))
    // 目录与文件权限与其他本地持久化保持一致（POSIX）。
    if (process.platform !== 'win32') {
      expect(statSync(join(directory, 'attachments', 'conversation-1')).mode & 0o777).toBe(0o700)
      expect(statSync(filePath).mode & 0o777).toBe(0o600)
    }
  })

  test('同一内容重复保存生成独立文件，互不覆盖', () => {
    const first = service.save({ conversationId: 'conversation-1', filename: 'a.txt', mediaType: 'text/plain', data: base64('内容') })
    const second = service.save({ conversationId: 'conversation-1', filename: 'a.txt', mediaType: 'text/plain', data: base64('内容') })
    expect(first.localPath).not.toBe(second.localPath)
    expect(readdirSync(join(directory, 'attachments', 'conversation-1'))).toHaveLength(2)
  })

  test('清洗文件名中的路径成分与控制字符，不参与路径拼接', () => {
    const attachment = service.save({
      conversationId: 'conversation-1',
      filename: '../../etc/evil\u0000.png',
      mediaType: 'image/png',
      data: base64('x'),
    })
    expect(attachment.filename).toBe('evil.png')
    expect(attachment.localPath).toBe('conversation-1/attachment-1.png')
    expect(existsSync(join(directory, 'attachments', 'etc'))).toBe(false)

    const weird = service.save({ conversationId: 'conversation-1', filename: '..\\..\\win.ini', mediaType: 'text/plain', data: base64('x') })
    expect(weird.filename).toBe('win.ini')
  })

  test('无扩展名或超长扩展名回退 .bin，未知 MIME 回退八位流', () => {
    const noExt = service.save({ conversationId: 'conversation-1', filename: 'README', mediaType: '', data: base64('x') })
    expect(noExt.localPath).toBe('conversation-1/attachment-1.bin')
    expect(noExt.mediaType).toBe('application/octet-stream')

    const longExt = service.save({ conversationId: 'conversation-1', filename: 'file.超长扩展名abc', mediaType: 'not-a-mime', data: base64('x') })
    expect(longExt.localPath.endsWith('.bin')).toBe(true)
    expect(longExt.mediaType).toBe('application/octet-stream')
  })

  test('拒绝非法会话 ID、非法 base64、空内容与超限附件', async () => {
    const valid = { filename: 'a.txt', mediaType: 'text/plain', data: base64('x') }
    for (const conversationId of ['', '会话/../../x', '..', '.hidden', 'a\\b', `c${'x'.repeat(200)}`]) {
      await expectError(() => service.save({ ...valid, conversationId }), 'invalid_input')
    }
    await expectError(() => service.save({ conversationId: 'conversation-1', filename: 'a.txt', mediaType: 'text/plain', data: 'not base64!!' }), 'invalid_input')
    await expectError(() => service.save({ conversationId: 'conversation-1', filename: 'a.txt', mediaType: 'text/plain', data: base64('x').slice(0, 3) }), 'invalid_input')
    await expectError(() => service.save({ conversationId: 'conversation-1', filename: 'a.txt', mediaType: 'text/plain', data: '' }), 'invalid_input')

    const limited = new AttachmentService({
      attachmentsDir: join(directory, 'attachments-small'),
      maxAttachmentSize: 4,
    })
    await expectError(() => limited.save({ conversationId: 'conversation-1', filename: 'a.txt', mediaType: 'text/plain', data: base64('超限内容') }), 'too_large')
    // 超限失败不落盘
    expect(existsSync(join(directory, 'attachments-small', 'conversation-1'))).toBe(false)
  })
})

describe('AttachmentService 路径安全', () => {
  test('拒绝绝对路径、路径穿越与空路径读取', async () => {
    service.save({ conversationId: 'conversation-1', filename: 'a.txt', mediaType: 'text/plain', data: base64('x') })
    await expectError(() => service.readAsBase64('/etc/passwd'), 'path_denied')
    await expectError(() => service.readAsBase64('C:\\windows\\system32'), 'path_denied')
    await expectError(() => service.readAsBase64('../channels.json'), 'path_denied')
    await expectError(() => service.readAsBase64('conversation-1/../../settings.json'), 'path_denied')
    await expectError(() => service.readAsBase64(''), 'path_denied')
    await expectError(() => service.readAsBase64('conversation-1/missing.bin'), 'not_found')
  })

  test('删除单个附件幂等，会话级删除清理整个目录', async () => {
    const attachment = service.save({ conversationId: 'conversation-1', filename: 'a.txt', mediaType: 'text/plain', data: base64('x') })
    expect(service.delete(attachment.localPath)).toBe(true)
    expect(service.delete(attachment.localPath)).toBe(false)
    await expectError(() => service.readAsBase64(attachment.localPath), 'not_found')

    service.save({ conversationId: 'conversation-1', filename: 'b.txt', mediaType: 'text/plain', data: base64('x') })
    service.save({ conversationId: 'conversation-2', filename: 'c.txt', mediaType: 'text/plain', data: base64('x') })
    service.deleteConversationAttachments('conversation-1')
    expect(existsSync(join(directory, 'attachments', 'conversation-1'))).toBe(false)
    expect(existsSync(join(directory, 'attachments', 'conversation-2'))).toBe(true)
    await expectError(() => service.deleteConversationAttachments('../other'), 'invalid_input')

    // 删除后再次保存自动重建会话目录。
    const recreated = service.save({ conversationId: 'conversation-1', filename: 'd.txt', mediaType: 'text/plain', data: base64('x') })
    expect(existsSync(join(directory, 'attachments', recreated.localPath))).toBe(true)
  })

  test('构造时自动创建并收紧附件根目录权限', () => {
    const nested = new AttachmentService({ attachmentsDir: join(directory, 'nested', 'attachments') })
    nested.save({ conversationId: 'conversation-1', filename: 'a.txt', mediaType: 'text/plain', data: base64('x') })
    expect(existsSync(join(directory, 'nested', 'attachments', 'conversation-1'))).toBe(true)
  })
})
