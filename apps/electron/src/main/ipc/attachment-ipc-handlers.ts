/** 附件 Electron 通道绑定；请求结构与领域错误转换由附件 controller 负责。 */

import { ipcMain } from 'electron'
import { ATTACHMENTS_IPC_CHANNELS } from '@axon/shared'
import { createAttachmentIpcHandlers } from '../lib/chat/attachment-ipc-handlers'
import type { AttachmentService } from '../lib/chat/attachment-service'
import { assertMainFrame } from './assert-main-frame'

/** 注册 renderer 唯一可用的附件保存入口；读取和删除继续只允许主进程内部调用。 */
export function registerAttachmentIpcHandlers(service: Pick<AttachmentService, 'save'>): void {
  const handlers = createAttachmentIpcHandlers(service)
  ipcMain.handle(ATTACHMENTS_IPC_CHANNELS.SAVE, (event, input: unknown) => {
    assertMainFrame(event, '保存附件')
    return handlers.save(input)
  })
}
