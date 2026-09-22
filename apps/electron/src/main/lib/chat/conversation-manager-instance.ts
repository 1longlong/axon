/** ConversationManager 的主进程生产单例。 */

import { getConversationsDir, getConversationsIndexPath } from '../core/config-paths'
import { ConversationManager } from './conversation-manager'

let conversationManager: ConversationManager | null = null

export function getConversationManager(): ConversationManager {
  if (!conversationManager) {
    conversationManager = new ConversationManager({
      indexPath: getConversationsIndexPath(),
      messagesDir: getConversationsDir(),
    })
  }
  return conversationManager
}
