/**
 * ModeSwitcher - Chat/Agent 模式切换（带滑动指示器）
 *
 * B2 骨架版：仅切换模式；会话恢复逻辑随会话体系（迭代 2/5）接入。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { appModeAtom, type AppMode } from '@/atoms/app-mode'
import { activeTabIdAtom, tabsAtom } from '@/atoms/tab-atoms'
import { Bot, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'

const modes: { value: AppMode; label: string; icon: React.ReactNode }[] = [
  { value: 'agent', label: 'Agent', icon: <Bot size={15} /> },
  { value: 'chat', label: 'Chat', icon: <MessageSquare size={15} /> },
]

export function ModeSwitcher(): React.ReactElement {
  const [mode, setMode] = useAtom(appModeAtom)
  const tabs = useAtomValue(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)

  const handleSwitch = React.useCallback((targetMode: AppMode) => {
    setMode(targetMode)
    const existingTab = [...tabs].reverse().find((tab) => tab.type === targetMode)
    if (existingTab) setActiveTabId(existingTab.id)
  }, [setActiveTabId, setMode, tabs])

  return (
    <div className="pt-2 titlebar-drag-region select-none">
      <div className="sidebar-control-surface relative flex rounded-xl p-1 titlebar-drag-region">
        {/* 滑动背景指示器 */}
        <div
          className={cn(
            'pointer-events-none absolute top-1 bottom-1 w-[calc(50%-4px)] rounded-lg bg-background shadow-sm transition-transform duration-300 ease-in-out',
            mode === 'agent' ? 'translate-x-0' : 'translate-x-full'
          )}
        />
        {modes.map(({ value, label, icon }) => (
          <button
            key={value}
            type="button"
            onClick={() => handleSwitch(value)}
            className={cn(
              'titlebar-no-drag relative z-[1] flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-0 text-sm font-medium transition-colors duration-200 select-none',
              mode === value
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}
