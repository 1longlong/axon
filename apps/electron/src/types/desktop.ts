/** 主进程通过 preload 投递给主界面的桌面快捷动作。 */
export type DesktopAction =
  | { type: 'new_chat' }
  | { type: 'new_agent'; projectId: string }

export interface QuickChatDragInput {
  phase: 'start' | 'move' | 'end'
  screenX: number
  screenY: number
}

export const DESKTOP_IPC_CHANNELS = {
  ACTION: 'axon:desktop:action',
  QUICK_CHAT_OPENED: 'axon:desktop:quick-chat-opened',
  QUICK_CHAT_CANCELED: 'axon:desktop:quick-chat-canceled',
  QUICK_CHAT_EXPANDED: 'axon:desktop:quick-chat-expanded',
  QUICK_CHAT_DRAG: 'axon:desktop:quick-chat-drag',
  HIDE_QUICK_CHAT: 'axon:desktop:hide-quick-chat',
} as const
