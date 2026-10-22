import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentAttachmentDraft, AgentAttachmentUpload, AgentImageChunk, AgentImagePreparationResult, AgentManagedAttachment, AgentSessionMeta, SDKMessage } from '@axon/shared'
import { MAX_AGENT_ATTACHMENT_CHUNK_BYTES } from '@axon/shared'
import { AgentAttachmentService } from './agent-attachment-service'
import type { AgentAttachmentServiceOptions } from './agent-attachment-service'
import type { AgentAttachmentLease } from './agent-attachment-lease'
import { BackendClientRegistry } from '../backend-client-registry'

let root: string, clients: BackendClientRegistry, owner: string, other: string
let sessions: Map<string, AgentSessionMeta>, messages: Map<string, SDKMessage[]>
let service: AgentAttachmentService
const services: AgentAttachmentService[] = [], leases: AgentAttachmentLease[] = []
const imageResult = (): AgentImagePreparationResult => ({ bytes: Buffer.from('prepared-image'), originalMediaType: 'image/png', mediaType: 'image/png', width: 2, height: 3,
  thumbnail: { bytes: Buffer.from('thumbnail'), width: 2, height: 3 } })

function create(options: Partial<AgentAttachmentServiceOptions> = {}): AgentAttachmentService {
  const value = new AgentAttachmentService({ attachmentsDir: join(root, 'assets'), clients,
    getSession: (id) => sessions.get(id), getMessages: (id) => messages.get(id) ?? [], prepareImage: async () => imageResult(), ...options })
  services.push(value)
  return value
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'axon-agent-attachments-')))
  clients = new BackendClientRegistry(); owner = clients.register(); other = clients.register()
  sessions = new Map([['session', { id: 'session', runtimeId: 'pi', projectId: 'project', title: '测试', channelId: 'channel', modelId: 'model', createdAt: 1, updatedAt: 1 }]])
  messages = new Map()
  service = create()
})
afterEach(async () => {
  for (const lease of leases.splice(0)) { try { lease.cancel() } catch { /* 损坏资产测试有意保留异常目录。 */ } }
  for (const value of services.splice(0)) { try { value.dispose() } catch { /* 仅清理本测试创建的私有根。 */ }; await value.drain() }
  clients.dispose(); rmSync(root, { recursive: true, force: true })
})
function draft(): AgentAttachmentDraft { return service.command(owner, { action: 'createDraft', sessionId: 'session' }) as AgentAttachmentDraft }
function take(value: AgentAttachmentDraft): AgentAttachmentLease {
  const lease = service.takeDraft(owner, value.sessionId, value.id); leases.push(lease); return lease
}
async function upload(value: AgentAttachmentDraft, bytes: Buffer, kind: 'file' | 'pastedText' | 'image' = 'file'): Promise<AgentAttachmentDraft> {
  const started = service.command(owner, { action: 'beginUpload', draftId: value.id, name: kind === 'image' ? 'test.png' : 'test.txt', mediaType: kind === 'image' ? 'image/png' : 'text/plain', kind, size: bytes.length }) as AgentAttachmentUpload
  for (let offset = 0; offset < bytes.length; offset += MAX_AGENT_ATTACHMENT_CHUNK_BYTES) service.command(owner, {
    action: 'uploadChunk', uploadId: started.id, offset, data: bytes.subarray(offset, offset + MAX_AGENT_ATTACHMENT_CHUNK_BYTES).toString('base64'),
  })
  return await service.command(owner, { action: 'finishUpload', uploadId: started.id }) as AgentAttachmentDraft
}
function managed(value: AgentAttachmentDraft): AgentManagedAttachment { return value.attachments[0] as AgentManagedAttachment }
function committedUser(value: AgentAttachmentDraft, uuid = 'user'): SDKMessage {
  const lease = take(value), prepared = lease.prepare()
  lease.reserveForHistory(); lease.commit(); lease.settle()
  const user: SDKMessage = { type: 'user', uuid, message: { content: [{ type: 'text', text: '' }] }, parent_tool_use_id: null,
    attachments: prepared.attachments, attachmentContext: prepared.context, imageModelSelection: { channelId: 'channel', modelId: 'model' } }
  messages.set('session', [...(messages.get('session') ?? []), user]); return user
}

describe('Agent 分类附件边界及接管', () => {
  test('顺序分块写盘，历史只存描述，提交后取消/重启不删除原件', async () => {
    const value = await upload(draft(), Buffer.from('完整原文'))
    const attachment = managed(value), path = join(root, 'assets', attachment.localPath)
    expect(readFileSync(path, 'utf8')).toBe('完整原文')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const user = committedUser(value)
    expect(JSON.stringify(user)).not.toContain(Buffer.from('完整原文').toString('base64'))
    expect(await service.command(owner, { action: 'discardDraft', draftId: value.id })).toBe(true)
    service.dispose(); await service.drain()
    const restarted = create()
    expect(existsSync(path)).toBe(true)
    restarted.releaseSession('session')
    expect(existsSync(path)).toBe(false)
  })
  test('原生文件和目录为实时引用，删除草稿不动来源', async () => {
    const file = join(root, 'source.txt'), folder = join(root, 'folder')
    writeFileSync(file, '原文'); mkdirSync(folder)
    const value = await service.registerLocal(owner, { draftId: draft().id, paths: [file, folder] })
    expect(value.attachments.map((item) => item.kind)).toEqual(['file', 'directory'])
    expect(value.attachments.every((item) => 'storage' in item && item.storage === 'reference')).toBe(true)
    writeFileSync(file, '更新后原文')
    expect(take(value).prepare().context).toContain('live')
    service.command(owner, { action: 'discardDraft', draftId: value.id })
    leases.at(-1)!.settle()
    expect(readFileSync(file, 'utf8')).toBe('更新后原文'); expect(existsSync(folder)).toBe(true)
  })
  test('启动只清理明确草稿；提交窗口 reserved 与陌生内容不猜测删除', async () => {
    const published = await upload(draft(), Buffer.from('持久资产'))
    committedUser(published)
    const original = join(root, 'assets', managed(published).localPath)
    const reserved = JSON.parse(readFileSync(join(dirname(original), 'metadata.json'), 'utf8')) as Record<string, unknown>
    const sessionRoot = dirname(dirname(original))
    const makeOrphan = (assetId: string, phase: string, extra = false): string => {
      const path = join(sessionRoot, assetId)
      mkdirSync(path)
      const stat = statSync(path)
      writeFileSync(join(path, 'original.txt'), '崩溃遗留')
      writeFileSync(join(path, 'metadata.json'), JSON.stringify({ ...reserved, phase, assetId, originalName: 'original.txt', dev: stat.dev, ino: stat.ino }))
      if (extra) writeFileSync(join(path, 'keep.md'), '陌生内容')
      return path
    }
    const orphan = makeOrphan('11111111-1111-4111-8111-111111111111', 'draft')
    const uncertain = makeOrphan('22222222-2222-4222-8222-222222222222', 'reserved')
    const unknown = makeOrphan('33333333-3333-4333-8333-333333333333', 'draft', true)
    create()
    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(original)).toBe(true)
    expect(existsSync(uncertain)).toBe(true)
    expect(readFileSync(join(unknown, 'keep.md'), 'utf8')).toBe('陌生内容')
  })
  test('其他入口、伪造字段和 Runtime/子会话/后台来源拒绝', () => {
    const value = draft()
    expect(() => service.command(other, { action: 'getDraft', draftId: value.id })).toThrow()
    expect(() => service.command(owner, { action: 'createDraft', sessionId: 'session', path: '/etc/passwd' })).toThrow()
    for (const patch of [{ runtimeId: 'zima' as const }, { parentSessionId: 'parent' }, { creationOrigin: 'exec' as const }, { creationOrigin: 'loop' as const }]) {
      sessions.set('restricted', { ...sessions.get('session')!, id: 'restricted', ...patch })
      expect(() => service.command(owner, { action: 'createDraft', sessionId: 'restricted' })).toThrow()
    }
  })
  test('不接受错位、非规范编码、过大块或半份上传接管', () => {
    const value = draft(), pending = service.command(owner, { action: 'beginUpload', draftId: value.id, name: 'x.txt', mediaType: 'text/plain', size: 10, kind: 'file' }) as AgentAttachmentUpload
    for (const patch of [{ offset: 1, data: 'eA==' }, { offset: 0, data: '!bad' }, { offset: 0, data: 'eA=' }, { offset: 0, data: Buffer.alloc(MAX_AGENT_ATTACHMENT_CHUNK_BYTES + 1).toString('base64') }]) {
      expect(() => service.command(owner, { action: 'uploadChunk', uploadId: pending.id, ...patch })).toThrow()
    }
    expect(() => take(value)).toThrow()
    expect((service.command(owner, { action: 'getUpload', uploadId: pending.id }) as AgentAttachmentUpload).receivedBytes).toBe(0)
    service.command(owner, { action: 'cancelUpload', uploadId: pending.id })
    expect((service.command(owner, { action: 'getDraft', draftId: value.id }) as AgentAttachmentDraft).uploads).toHaveLength(0)
  })
  test('每轮数量、大小和路径穿越在边界拒绝', async () => {
    const value = draft()
    for (let index = 0; index < 10; index += 1) service.command(owner, { action: 'addSelection', draftId: value.id, text: `片段${index}` })
    expect(() => service.command(owner, { action: 'addSelection', draftId: value.id, text: '第十一项' })).toThrow()
    expect(() => service.command(owner, { action: 'getDraft', draftId: '../outside' })).toThrow()
    const fresh = draft()
    expect(() => service.command(owner, { action: 'beginUpload', draftId: fresh.id, name: 'x', mediaType: 'text/plain', size: 101 * 1024 * 1024, kind: 'file' })).toThrow()
    expect(() => service.command(owner, { action: 'beginUpload', draftId: fresh.id, name: 'x.png', mediaType: 'image/png', size: 21 * 1024 * 1024, kind: 'image' })).toThrow()
  })
  test('接管期间不能修改/重复接管；取消入口不取消已接管输入', async () => {
    const value = await upload(draft(), Buffer.from('内容')), lease = take(value)
    expect(() => take(value)).toThrow()
    expect(() => service.command(owner, { action: 'remove', draftId: value.id, attachmentId: managed(value).id })).toThrow()
    service.command(owner, { action: 'discardDraft', draftId: value.id })
    expect(lease.prepare().attachments).toHaveLength(1)
    lease.reserveForHistory(); lease.commit(); lease.settle()
    expect(existsSync(join(root, 'assets', managed(value).localPath))).toBe(true)
  })
  test('取消后失败退还才清理；未取消的预检失败退回原草稿', async () => {
    const first = await upload(draft(), Buffer.from('内容')), lease = take(first)
    lease.settle()
    expect((service.command(owner, { action: 'getDraft', draftId: first.id }) as AgentAttachmentDraft).status).toBe('draft')
    const again = take(first)
    service.command(owner, { action: 'discardDraft', draftId: first.id })
    again.settle()
    expect(existsSync(join(root, 'assets', managed(first).localPath))).toBe(false)
  })
  test('断开、排队取消和 dispose/drain 都等实际租约，不删除提交资产', async () => {
    const value = await upload(draft(), Buffer.from('内容')), lease = take(value)
    clients.detach(owner)
    expect(existsSync(join(root, 'assets', managed(value).localPath))).toBe(true)
    service.dispose()
    let drained = false; const wait = service.drain().then(() => { drained = true })
    await Promise.resolve(); expect(drained).toBe(false)
    lease.cancel(); await wait
    expect(existsSync(join(root, 'assets', managed(value).localPath))).toBe(false)
  })
  test('原件替换和陌生文件不被当作自有内容删除', async () => {
    const value = await upload(draft(), Buffer.from('内容')), path = join(root, 'assets', managed(value).localPath)
    const outside = join(root, 'keep.txt'); writeFileSync(outside, '保留')
    unlinkSync(path); symlinkSync(outside, path)
    expect(() => take(value)).toThrow()
    writeFileSync(join(dirname(path), 'user-notes.md'), '手动补充')
    expect(() => service.command(owner, { action: 'discardDraft', draftId: value.id })).toThrow()
    expect(readFileSync(outside, 'utf8')).toBe('保留')
    expect(existsSync(join(dirname(path), 'user-notes.md'))).toBe(true)
  })
  test('选区保留原文/行号，超限或非法范围不添加', () => {
    let value = draft()
    value = service.command(owner, { action: 'addSelection', draftId: value.id, text: '  const x = 1\n', source: 'src/a.ts', startLine: 2, endLine: 3 }) as AgentAttachmentDraft
    expect(take(value).prepare().context).toContain('用户选择时的内容')
    expect(value.attachments[0]).toMatchObject({ text: '  const x = 1\n', startLine: 2, endLine: 3 })
    const fresh = draft()
    for (const patch of [{ text: 'x'.repeat(20_001) }, { text: 'x', startLine: 4, endLine: 1 }, { text: 'x', endLine: 2 }, { text: 'x\0' }]) {
      expect(() => service.command(owner, { action: 'addSelection', draftId: fresh.id, ...patch })).toThrow()
    }
  })
  test('完整 UTF-8 粘贴跨分块保存，只在元信息显示短预览', async () => {
    const text = 'a'.repeat(MAX_AGENT_ATTACHMENT_CHUNK_BYTES - 1) + '中文\n尾部'
    const value = await upload(draft(), Buffer.from(text), 'pastedText'), attachment = managed(value)
    expect(attachment.pastedText).toEqual({ characterCount: text.length, preview: text.slice(0, 120) })
    expect(readFileSync(join(root, 'assets', attachment.localPath), 'utf8')).toBe(text)
    const prepared = take(value).prepare()
    expect(prepared.context).not.toContain(text)
    expect(prepared.context).toContain(attachment.id)
  })
  test.each([Buffer.from([0xff]), Buffer.from('x\0y'), Buffer.alloc(0)])('非法 UTF-8、空字节或空粘贴拒绝且清理', async (bytes) => {
    const value = draft()
    await expect(upload(value, bytes, 'pastedText')).rejects.toThrow()
    expect((service.command(owner, { action: 'getDraft', draftId: value.id }) as AgentAttachmentDraft).attachments).toHaveLength(0)
  })
})

describe('图片持有、预览和语义恢复', () => {
  test('处理版本/缩略图与原件分别保存，读取绑定 owner 或确切消息', async () => {
    const value = await upload(draft(), Buffer.from('source-image'), 'image'), attachment = managed(value)
    expect(attachment.image).toMatchObject({ width: 2, height: 3, thumbnail: { width: 2, height: 3 } })
    expect(readFileSync(join(root, 'assets', attachment.localPath), 'utf8')).toBe('source-image')
    expect(take(value).prepare().images?.[0]?.data).toBe(Buffer.from('prepared-image').toString('base64'))
    leases.at(-1)!.settle()
    const command = { action: 'readImage', source: { kind: 'draft', draftId: value.id }, attachmentId: attachment.id, variant: 'thumbnail', offset: 0 }
    expect((service.command(owner, command) as AgentImageChunk).data).toBe(Buffer.from('thumbnail').toString('base64'))
    expect(() => service.command(other, command)).toThrow()
    committedUser(value)
    const history = { ...command, source: { kind: 'history', sessionId: 'session', messageId: 'user' }, variant: 'image' }
    expect((service.command(other, history) as AgentImageChunk).sha256).toBe(createHash('sha256').update('prepared-image').digest('hex'))
    expect(() => service.command(owner, { ...history, source: { ...history.source, messageId: 'wrong' } })).toThrow()
    expect(() => service.command(owner, { ...history, offset: 1_000_000 })).toThrow()
    expect(() => service.command(owner, { ...history, path: '/etc/passwd' })).toThrow()
  })
  test('历史恢复最多最近两个人类轮次，不因工具结果刷新范围', async () => {
    for (const name of ['one', 'two', 'three']) committedUser(await upload(draft(), Buffer.from(name), 'image'), name)
    const history = messages.get('session')!
    history.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: '结果' }] }, parent_tool_use_id: null })
    const recovery = service.prepareHistoryImages(sessions.get('session')!, history, { support: 'supported' })
    expect(recovery.images).toHaveLength(2)
    expect(recovery.context).toContain('two'); expect(recovery.context).toContain('three'); expect(recovery.context).not.toContain('one')
    expect(service.prepareHistoryImages(sessions.get('session')!, history, { support: 'unsupported' }).images).toHaveLength(0)
    expect(service.prepareHistoryImages({ ...sessions.get('session')!, modelId: 'other' }, history, { support: 'unknown' }).warnings).toHaveLength(2)
    expect(service.prepareHistoryImages(sessions.get('session')!, history, { support: 'supported', maxTotalBytes: 1 }).images).toHaveLength(0)
  })
  test('图片损坏/缺失产生恢复提示，新输入损坏不接管', async () => {
    const value = await upload(draft(), Buffer.from('source'), 'image'), attachment = managed(value)
    writeFileSync(join(root, 'assets', attachment.image!.localPath), 'corrupted')
    expect(() => take(value)).toThrow()
    const good = await upload(draft(), Buffer.from('source'), 'image'), user = committedUser(good)
    unlinkSync(join(root, 'assets', managed(good).image!.localPath))
    const recovered = service.prepareHistoryImages(sessions.get('session')!, [user], { support: 'supported' })
    expect(recovered.images).toEqual([]); expect(recovered.warnings[0]).toContain('未恢复图像内容')
  })
  test('异步准备期间取消和退出只在实际完成后清理', async () => {
    let ready!: (value: AgentImagePreparationResult) => void
    const gated = create({ attachmentsDir: join(root, 'gated'), prepareImage: () => new Promise((resolve) => { ready = resolve }) })
    const previous = service; service = gated
    const value = draft(), pending = upload(value, Buffer.from('source'), 'image')
    expect(() => service.command(owner, { action: 'addSelection', draftId: value.id, text: '竞争修改' })).toThrow()
    service.command(owner, { action: 'discardDraft', draftId: value.id })
    let drained = false
    service.dispose(); const waiting = service.drain().then(() => { drained = true })
    await Promise.resolve(); expect(drained).toBe(false)
    ready(imageResult())
    await expect(pending).rejects.toThrow(); await waiting
    expect(readdirSync(join(root, 'gated', 'agent', 'session'))).toEqual([])
    service = previous
  })
  test('会话在图片准备期间删除，完成后连已提交的旧附件一起精确回收', async () => {
    let block = false, release!: (value: AgentImagePreparationResult) => void
    const previous = service
    service = create({ attachmentsDir: join(root, 'deleted'), prepareImage: async () => block ? await new Promise((resolve) => { release = resolve }) : imageResult() })
    const first = await upload(draft(), Buffer.from('old'), 'image'); committedUser(first)
    const oldPath = join(root, 'deleted', managed(first).localPath)
    block = true
    const next = draft(), pending = upload(next, Buffer.from('new'), 'image')
    sessions.delete('session')
    service.releaseSession('session')
    expect(existsSync(oldPath)).toBe(true)
    release(imageResult()); await expect(pending).rejects.toThrow()
    expect(existsSync(join(root, 'deleted', 'agent', 'session'))).toBe(false)
    service = previous
  })
})
