/**
 * 模式切换同步更新 appMode，并优先激活该模式最近打开的会话。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { appModeAtom, type AppMode } from '@/atoms/app-mode'
import { activeTabIdAtom, tabsAtom } from '@/atoms/tab-atoms'
import { AgentModeIcon, ChatIcon } from '@/components/icons/WorkbenchIcons'
import { cn } from '@/lib/utils'

const modes: { value: AppMode; label: string; icon: React.ReactNode }[] = [
  { value: 'agent', label: 'Agent', icon: <AgentModeIcon size={14} /> },
  { value: 'chat', label: 'Chat', icon: <ChatIcon size={14} /> },
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
    <div className="titlebar-drag-region select-none">
      <div role="group" aria-label="会话模式" className="relative flex rounded-lg bg-muted p-0.5 titlebar-drag-region">
        {modes.map(({ value, label, icon }) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            onClick={() => handleSwitch(value)}
            className={cn(
              'titlebar-no-drag flex h-6 flex-1 items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              mode === value
                ? 'bg-background font-semibold text-foreground shadow-xs'
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
