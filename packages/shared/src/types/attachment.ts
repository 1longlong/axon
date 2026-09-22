/**
 * 附件跨进程契约。
 *
 * 设计要点：附件元数据（FileAttachment）不建独立索引，由消息层内嵌并随会话
 * JSONL 持久化；二进制按会话分目录存储在附件根目录下。跨 IPC 传递的
 * localPath 永远是相对路径，真实文件访问只允许发生在主进程内。
 */

/** 单个附件解码后的字节上限。 */
export const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024

/** 附件原始文件名的字符上限。 */
export const MAX_ATTACHMENT_NAME_LENGTH = 200

/** 可直接作为图片内容进入模型请求的 MIME 白名单。 */
export const IMAGE_MEDIA_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]

/** 判断附件是否为可直接发给模型的图片类型。 */
export function isImageAttachment(mediaType: string): boolean {
  return IMAGE_MEDIA_TYPES.includes(mediaType)
}

/** 已落盘附件的安全元数据；localPath 永远是 `{conversationId}/{文件名}` 形式的相对路径。 */
export interface FileAttachment {
  id: string
  /** 经主进程清洗后的原始文件名（去掉路径成分与控制字符）。 */
  filename: string
  /** MIME 类型；无法识别时为 application/octet-stream。 */
  mediaType: string
  /** 相对附件根目录的存储路径；禁止绝对路径，读取必须经主进程解析。 */
  localPath: string
  /** 解码后的字节数。 */
  size: number
  createdAt: number
}

/** 保存附件的输入：内容以 base64 字符串跨 IPC 传输，不含 data: 前缀。 */
export interface AttachmentSaveInput {
  conversationId: string
  filename: string
  mediaType: string
  data: string
}

/** 单条消息允许内嵌的附件数量上限。 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10

/**
 * 单张图片随请求发送的解码字节上限（与 Anthropic 的单图限制一致，其余供应商也安全）。
 * 超限图片不进入请求，由编排层降级为文本提示。
 */
export const MAX_REQUEST_IMAGE_SIZE = 5 * 1024 * 1024

/** 保存附件的 IPC 结果：失败只携带稳定错误码与中文提示，不回显原始异常。 */
export type AttachmentSaveResult =
  | { success: true; attachment: FileAttachment }
  | { success: false; code: 'invalid_input' | 'too_large' | 'internal_error'; message: string }

export const ATTACHMENTS_IPC_CHANNELS = {
  SAVE: 'axon:attachments:save',
} as const
