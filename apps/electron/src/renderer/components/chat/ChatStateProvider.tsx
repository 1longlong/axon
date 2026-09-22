import { createContext, useContext, useEffect, useMemo } from 'react'
import type { ReactNode } from 'react'
import { useStore } from 'jotai'
import { ChatRendererController } from '@/atoms/chat-state'

const ChatControllerContext = createContext<ChatRendererController | null>(null)

/** 在应用根部建立唯一 Chat 事件订阅，并向后续 Chat UI 提供动作控制器。 */
export function ChatStateProvider({ children }: { children: ReactNode }) {
  const store = useStore()
  const controller = useMemo(
    () => new ChatRendererController({
      ...window.axon.chat,
      listChannels: window.axon.channels.list,
    }, store),
    [store],
  )

  useEffect(() => controller.start(), [controller])

  return (
    <ChatControllerContext.Provider value={controller}>
      {children}
    </ChatControllerContext.Provider>
  )
}

export function useChatController(): ChatRendererController {
  const controller = useContext(ChatControllerContext)
  if (!controller) throw new Error('useChatController 必须在 ChatStateProvider 内使用')
  return controller
}
