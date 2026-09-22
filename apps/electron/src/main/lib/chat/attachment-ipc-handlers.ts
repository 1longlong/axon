/**
 * 附件 IPC 入参边界：只接受结构正确的保存请求，语义校验（大小、base64、路径）
 * 由 AttachmentService 负责。失败转为可序列化的稳定结果，不向 renderer 回显原始异常。
 */

import { AttachmentServiceError } from './attachment-service'
import type { AttachmentService } from './attachment-service'
import type { AttachmentSaveInput, AttachmentSaveResult } from '@axon/shared'

function invalid(): never {
  throw new AttachmentServiceError('invalid_input', '附件请求格式无效')
}

/** 结构校验：四个字段都必须是字符串；内容与长度检查统一在 AttachmentService 完成。 */
function parseSaveInput(value: unknown): AttachmentSaveInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const input = value as Record<string, unknown>
  const allowed = ['conversationId', 'filename', 'mediaType', 'data']
  if (Object.keys(input).some((key) => !allowed.includes(key))) return invalid()
  for (const key of allowed) {
    if (typeof input[key] !== 'string') return invalid()
  }
  return input as unknown as AttachmentSaveInput
}

export function createAttachmentIpcHandlers(
  service: Pick<AttachmentService, 'save'>,
) {
  return {
    /** 保存附件并返回安全元数据；结果联合类型避免 Electron 序列化 Error 丢失错误码。 */
    save: (value: unknown): AttachmentSaveResult => {
      let input: AttachmentSaveInput
      try {
        input = parseSaveInput(value)
      } catch (error) {
        return { success: false, code: 'invalid_input', message: (error as AttachmentServiceError).message }
      }
      try {
        return { success: true, attachment: service.save(input) }
      } catch (error) {
        if (error instanceof AttachmentServiceError && error.code !== 'not_found' && error.code !== 'path_denied') {
          return { success: false, code: error.code, message: error.message }
        }
        return { success: false, code: 'internal_error', message: '附件保存失败' }
      }
    },
  }
}
