/** ChatService 的主进程生产单例与退出清理入口。 */

import { app } from 'electron'
import { createAxonUserAgent } from '@axon/core'
import { ChatService } from './chat-service'
import { createDocumentParser } from './document-parser'
import { getAttachmentService } from './attachment-service-instance'
import { getChannelManager } from '../channel/channel-manager-instance'
import { getConversationManager } from './conversation-manager-instance'

/** 生产文档提取器：读附件 base64 → 解码为 Buffer → 按扩展名分发解析。 */
const parseDocument = createDocumentParser()

let chatService: ChatService | null = null

export function getChatService(): ChatService {
  if (!chatService) {
    chatService = new ChatService({
      channelManager: getChannelManager(),
      conversationManager: getConversationManager(),
      userAgent: createAxonUserAgent(app.getVersion()),
      // 图片附件进入模型请求时由 ChatService 回读取内容；读取失败降级为文本提示。
      readAttachmentData: (localPath) => {
        try {
          return getAttachmentService().readAsBase64(localPath)
        } catch {
          return undefined
        }
      },
      // 文档附件提取文本注入请求；读取或解析失败统一降级为提示，不中断生成。
      extractDocumentText: async (attachment) => {
        try {
          const data = getAttachmentService().readAsBase64(attachment.localPath)
          return await parseDocument({
            filename: attachment.filename,
            mediaType: attachment.mediaType,
            buffer: Buffer.from(data, 'base64'),
          })
        } catch {
          return undefined
        }
      },
    })
  }
  return chatService
}

/** 只清理已经创建的实例，避免异常退出路径反向初始化 Chat 依赖。 */
export function stopAllChatGenerations(): number {
  return chatService?.stopAllGenerations() ?? 0
}
