/**
 * 附件领域服务：负责附件二进制的落盘、读取、删除与会话级清理。
 *
 * 链路位置：renderer（选择文件 / 粘贴）在发送消息时通过 IPC 把 base64 内容
 * 交给本服务落盘，拿到的 FileAttachment 元数据由消息层内嵌进 ChatMessage 并
 * 随会话 JSONL 持久化；ChatService 组装模型请求时再用本服务读回内容。
 *
 * 安全边界：
 * - 跨 IPC 的 localPath 永远是相对附件根目录的路径；所有文件访问必须先经过
 *   resolveAttachmentPath，绝对路径与路径穿越（..）一律拒绝；
 * - 会话目录权限 0700、文件权限 0600，与其他本地持久化保持一致；
 * - 本服务不建元数据索引，也不负责孤儿回收：删除一致性由消息层级联删除保证。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MAX_ATTACHMENT_NAME_LENGTH, MAX_ATTACHMENT_SIZE } from '@axon/shared'
import type { AttachmentSaveInput, FileAttachment } from '@axon/shared'

export class AttachmentServiceError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'too_large' | 'not_found' | 'path_denied',
    message: string,
  ) {
    super(message)
    this.name = 'AttachmentServiceError'
  }
}

export interface AttachmentServiceOptions {
  /** 附件存储根目录；生产环境来自 config-paths 的 getAttachmentsDir()。 */
  attachmentsDir: string
  createId?: () => string
  now?: () => number
  /** 字节上限；仅测试用于缩小阈值，生产固定使用 shared 的 MAX_ATTACHMENT_SIZE。 */
  maxAttachmentSize?: number
}

/** 会话 ID 作为目录名，必须排除路径成分；字符集与主进程生成的会话 ID 兼容。 */
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** MIME 允许 `token/token`；无法识别的输入统一回退为八位流，不直接拒绝。 */
const MEDIA_TYPE_PATTERN = /^[\w.+-]+\/[\w.+-]+$/
/** 存储文件名保留的扩展名：字母数字且长度可控，其余一律回退 .bin。 */
const EXTENSION_PATTERN = /^[A-Za-z0-9]{1,9}$/
/** base64 内容格式：标准字母表 + 结尾最多两个填充符，长度必须是 4 的倍数。 */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

/** 清洗用户提供的文件名：去掉路径成分与控制字符，防止清洗前的名字参与路径拼接。 */
function sanitizeFilename(raw: unknown): string {
  if (typeof raw !== 'string') return 'attachment'
  const basename = raw.split(/[/\\]/).at(-1) ?? ''
  const cleaned = [...basename]
    .filter((char) => char.charCodeAt(0) >= 32 && char !== '\x7f')
    .join('')
    .trim()
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'attachment'
  return cleaned.slice(0, MAX_ATTACHMENT_NAME_LENGTH)
}

/** 从清洗后的文件名推导存储扩展名；无扩展名或扩展名可疑时回退 .bin。 */
function storageExtension(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot <= 0 || dot === filename.length - 1) return '.bin'
  const ext = filename.slice(dot + 1)
  return EXTENSION_PATTERN.test(ext) ? `.${ext.toLowerCase()}` : '.bin'
}

export class AttachmentService {
  private readonly attachmentsDir: string
  private readonly createId: () => string
  private readonly now: () => number
  private readonly maxAttachmentSize: number

  constructor(options: AttachmentServiceOptions) {
    this.attachmentsDir = resolve(options.attachmentsDir)
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? Date.now
    this.maxAttachmentSize = options.maxAttachmentSize ?? MAX_ATTACHMENT_SIZE
    // 根目录提前建好并收紧权限；会话子目录在首次保存时创建。
    mkdirSync(this.attachmentsDir, { recursive: true })
    if (process.platform !== 'win32') chmodSync(this.attachmentsDir, 0o700)
  }

  /**
   * 校验并落盘一个附件，返回可跨 IPC 传递的安全元数据。
   * 内容以 base64 进入本函数，解码大小超限在写盘前失败，不落半份文件。
   */
  save(input: AttachmentSaveInput): FileAttachment {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new AttachmentServiceError('invalid_input', '附件输入无效')
    }
    const conversationId = typeof input.conversationId === 'string' ? input.conversationId.trim() : ''
    if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
      throw new AttachmentServiceError('invalid_input', '对话 ID 无效')
    }
    const filename = sanitizeFilename(input.filename)
    const mediaType = this.normalizeMediaType(input.mediaType)
    const data = typeof input.data === 'string' ? input.data : ''

    // 先校验 base64 格式再解码；解码后按实际字节复查上限，双重防线防止超大内容进磁盘。
    if (!data || data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) {
      throw new AttachmentServiceError('invalid_input', '附件内容必须是合法 base64')
    }
    const buffer = Buffer.from(data, 'base64')
    if (buffer.byteLength === 0) {
      throw new AttachmentServiceError('invalid_input', '附件内容为空')
    }
    if (buffer.byteLength > this.maxAttachmentSize) {
      throw new AttachmentServiceError('too_large', '附件超过大小上限')
    }

    // 目录名只依赖已校验的会话 ID，文件名只用本服务生成的 ID，用户输入不参与路径拼接。
    const conversationDir = join(this.attachmentsDir, conversationId)
    mkdirSync(conversationDir, { recursive: true })
    if (process.platform !== 'win32') chmodSync(conversationDir, 0o700)

    const id = this.createId()
    const storageName = `${id}${storageExtension(filename)}`
    const localPath = `${conversationId}/${storageName}`
    // 先写临时名再改名，避免写入中途崩溃留下半份附件被元数据引用。
    const tempPath = join(conversationDir, `${storageName}.tmp`)
    const finalPath = join(conversationDir, storageName)
    writeFileSync(tempPath, buffer, { mode: 0o600 })
    renameSync(tempPath, finalPath)

    return {
      id,
      filename,
      mediaType,
      localPath,
      size: buffer.byteLength,
      createdAt: this.now(),
    }
  }

  /**
   * 把相对路径解析到附件根目录内，并返回校验后的绝对路径。
   * 这是所有文件访问的强制入口：绝对路径直接拒绝，解析结果逃出根目录视为路径穿越。
   */
  private resolveAttachmentPath(localPath: string): string {
    if (
      typeof localPath !== 'string'
      || localPath.length === 0
      || localPath.includes('\0')
      || localPath.startsWith('/')
      || localPath.startsWith('\\')
      || /^[A-Za-z]:[\\/]/.test(localPath)
    ) {
      throw new AttachmentServiceError('path_denied', '附件路径不合法')
    }
    const resolved = resolve(this.attachmentsDir, localPath)
    const root = this.attachmentsDir + sep
    if (resolved !== this.attachmentsDir && !resolved.startsWith(root)) {
      throw new AttachmentServiceError('path_denied', '附件路径越界')
    }
    return resolved
  }

  /** 读取附件内容并编码为 base64；供模型请求组装等主进程内部链路使用。 */
  readAsBase64(localPath: string): string {
    const filePath = this.resolveAttachmentPath(localPath)
    if (!existsSync(filePath)) {
      throw new AttachmentServiceError('not_found', '附件不存在')
    }
    return readFileSync(filePath).toString('base64')
  }

  /** 删除单个附件；文件已不存在时视为删除成功，保证重复清理幂等。 */
  delete(localPath: string): boolean {
    const filePath = this.resolveAttachmentPath(localPath)
    if (!existsSync(filePath)) return false
    unlinkSync(filePath)
    return true
  }

  /** 会话删除时的级联清理：移除该会话的整个附件目录，不影响其他会话。 */
  deleteConversationAttachments(conversationId: string): void {
    if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
      throw new AttachmentServiceError('invalid_input', '对话 ID 无效')
    }
    rmSync(join(this.attachmentsDir, conversationId), { recursive: true, force: true })
  }

  /** 归一化 MIME：空值或格式非法时回退 application/octet-stream，超长直接拒绝。 */
  private normalizeMediaType(raw: unknown): string {
    if (typeof raw !== 'string' || raw.length === 0) return 'application/octet-stream'
    if (raw.length > 100) throw new AttachmentServiceError('invalid_input', '附件 MIME 类型无效')
    const trimmed = raw.trim().toLowerCase()
    return MEDIA_TYPE_PATTERN.test(trimmed) ? trimmed : 'application/octet-stream'
  }
}
