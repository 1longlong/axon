import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { chatStateAtom } from '@/atoms/chat-state'
import { activeTabIdAtom, openTab, tabsAtom } from '@/atoms/tab-atoms'
import { getDefaultChatModel } from '@/lib/chat-model-options'
import { useChatController } from './ChatStateProvider'

/** 创建主进程 conversation，再把返回的真实 ID 打开为标签。 */
export function useCreateChatConversation(): {
  createChatConversation(): Promise<boolean>
  creating: boolean
  creationReady: boolean
  createError: string | null
} {
  const controller = useChatController()
  const { channels, channelsStatus } = useAtomValue(chatStateAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const [creating, setCreating] = React.useState(false)
  const [createError, setCreateError] = React.useState<string | null>(null)
  const creationReady = channelsStatus === 'ready'

  /** 渠道快照就绪后再决定默认模型，避免启动瞬间创建出意外的未绑定会话。 */
  const createChatConversation = React.useCallback(async () => {
    if (creating || !creationReady) return false
    setCreating(true)
    setCreateError(null)
    try {
      const conversation = await controller.createConversation({
        title: '新对话',
        ...getDefaultChatModel(channels),
      })
      const item = {
        type: 'chat',
        sessionId: conversation.id,
        title: conversation.title,
      } as const
      setTabs((currentTabs) => openTab(currentTabs, item).tabs)
      setActiveTabId(conversation.id)
      return true
    } catch {
      setCreateError('新建对话失败')
      return false
    } finally {
      setCreating(false)
    }
  }, [channels, controller, creating, creationReady, setActiveTabId, setTabs])

  return { createChatConversation, creating, creationReady, createError }
}
