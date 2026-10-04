import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { ArrowLeft, Info, Keyboard, Palette, UserRound, Plug, Settings } from 'lucide-react'
import { settingsTabAtom, settingsEditingAtom } from '@/atoms/settings-tab'
import { canLeaveSettings } from '@/lib/channel-form'
import type { SettingsTab } from '@/atoms/settings-tab'
import { cn } from '@/lib/utils'
import { AgentModeIcon } from '@/components/icons/WorkbenchIcons'
import { AppearanceSettings } from './AppearanceSettings'
import { UserProfileSettings } from './UserProfileSettings'
import { ChannelSettings } from './ChannelSettings'
import { AgentSettings } from './AgentSettings'
import { QuickChatShortcutSettings } from './QuickChatShortcutSettings'

interface SettingsNavigationItem {
  id: SettingsTab
  label: string
  icon: React.ReactNode
}

const NAVIGATION_ITEMS: readonly SettingsNavigationItem[] = [
  { id: 'profile', label: '用户资料', icon: <UserRound size={14} /> },
  { id: 'appearance', label: '外观设置', icon: <Palette size={14} /> },
  { id: 'agent', label: 'Agent 设置', icon: <AgentModeIcon size={14} /> },
  { id: 'shortcuts', label: '快捷键', icon: <Keyboard size={14} /> },
  { id: 'channels', label: '模型渠道', icon: <Plug size={14} /> },
  { id: 'about', label: '关于 Axon', icon: <Info size={14} /> },
]

/** 设置框架按分类原子挂载现有页面；切换守住未保存边界，关闭交由 AppShell 再校验。 */
export function SettingsPanel({ onClose }: { onClose: () => void }): React.ReactElement {
  const [activeTab, setActiveTab] = useAtom(settingsTabAtom)
  const editing = useAtomValue(settingsEditingAtom)

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div className="flex h-full min-h-0 flex-col bg-content-area text-foreground">
      <div className="titlebar-drag-region h-10 shrink-0 border-b border-border-subtle bg-[hsl(var(--sidebar-surface))]" />
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-56 shrink-0 flex-col border-r border-border-subtle bg-[hsl(var(--sidebar-surface))] p-2">
          <div className="flex h-10 shrink-0 items-center gap-2 px-2 text-xs font-semibold">
            <Settings size={14} aria-hidden="true" className="shrink-0 text-muted-foreground" />
            设置
          </div>
          <nav aria-label="设置分类" className="space-y-0.5">
            {NAVIGATION_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-current={activeTab === item.id ? 'page' : undefined}
                onClick={() => {
                  if (item.id !== activeTab && canLeaveSettings(editing, () => window.confirm('放弃未保存的渠道更改？'))) setActiveTab(item.id)
                }}
                className={cn(
                  'flex h-8 w-full items-center gap-2 rounded-md border px-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  activeTab === item.id
                    ? 'border-border-subtle bg-[hsl(var(--input-surface))] font-medium text-foreground shadow-xs'
                    : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                )}
              >
                <span aria-hidden="true" className={cn('shrink-0', activeTab === item.id && 'text-indigo-500 dark:text-indigo-400')}>{item.icon}</span>
                <span className="truncate">{item.label}</span>
              </button>
            ))}
          </nav>
          <div className="mt-auto border-t border-border-subtle pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <ArrowLeft size={14} aria-hidden="true" className="shrink-0" />
              返回工作区
              <span className="ml-auto font-mono text-[10px]">Esc</span>
            </button>
          </div>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto bg-content-area scrollbar-none">
          <div className="mx-auto w-full max-w-4xl px-6 py-6">
            {activeTab === 'profile' && <UserProfileSettings />}
            {activeTab === 'appearance' && <AppearanceSettings />}
            {activeTab === 'agent' && <AgentSettings />}
            {activeTab === 'shortcuts' && <QuickChatShortcutSettings />}
            {activeTab === 'channels' && <ChannelSettings />}
            {activeTab === 'about' && <AboutSettings />}
          </div>
        </main>
      </div>
    </div>
  )
}

function AboutSettings(): React.ReactElement {
  return (
    <section>
      <h1 className="text-xl font-semibold">关于 Axon</h1>
      <p className="mt-1 text-sm text-muted-foreground">本地优先的 Electron AI 桌面 Agent。</p>
      <div className="mt-6 rounded-xl border bg-card p-5 shadow-sm">
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-xl font-semibold text-primary-foreground">A</div>
          <div>
            <p className="font-semibold tracking-wide">Axon</p>
            <p className="mt-1 text-xs text-muted-foreground">版本 {window.axon.version}</p>
          </div>
        </div>
      </div>
    </section>
  )
}
