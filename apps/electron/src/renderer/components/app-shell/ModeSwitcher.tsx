/**
 * 三个应用模块共用入口；收起时显示图标轨，不改变各模块最近位置。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Repeat2 } from 'lucide-react'
import { appSectionAtom, navigateAppAtom } from '@/atoms/app-navigation'
import type { AppSection } from '@/atoms/app-navigation'
import { AgentModeIcon, ChatIcon } from '@/components/icons/WorkbenchIcons'
import { cn } from '@/lib/utils'

const modes: { value: AppSection; label: string; icon: React.ReactNode }[] = [
  { value: 'agent', label: 'Agent', icon: <AgentModeIcon size={14} /> },
  { value: 'chat', label: 'Chat', icon: <ChatIcon size={14} /> },
  { value: 'loop', label: 'Loop', icon: <Repeat2 size={14} /> },
]

export function ModeSwitcher({ collapsed = false }: { collapsed?: boolean }): React.ReactElement {
  const mode = useAtomValue(appSectionAtom)
  const navigate = useSetAtom(navigateAppAtom)

  return (
    <div className="titlebar-drag-region select-none">
      <div role="group" aria-label="应用模块" className={cn('relative flex rounded-lg p-0.5 titlebar-drag-region', collapsed ? 'flex-col gap-1' : 'bg-muted')}>
        {modes.map(({ value, label, icon }) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            aria-label={`${label} 模块`}
            title={collapsed ? label : undefined}
            onClick={() => navigate({ section: value })}
            className={cn(
              'titlebar-no-drag flex items-center justify-center gap-1 rounded-lg text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              collapsed ? 'h-8 w-8' : 'h-6 min-w-0 flex-1 px-1.5',
              mode === value
                ? 'bg-background font-semibold text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {icon}
            {!collapsed && label}
          </button>
        ))}
      </div>
    </div>
  )
}
