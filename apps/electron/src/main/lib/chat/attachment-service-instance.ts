/** AttachmentService 的主进程生产单例。 */

import { getAttachmentsDir } from '../core/config-paths'
import { AttachmentService } from './attachment-service'

let attachmentService: AttachmentService | null = null

export function getAttachmentService(): AttachmentService {
  if (!attachmentService) {
    attachmentService = new AttachmentService({
      attachmentsDir: getAttachmentsDir(),
    })
  }
  return attachmentService
}
