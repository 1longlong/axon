import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { ArrowLeft, Bot, Info, Keyboard, Palette, UserRound, Plug } from 'lucide-react'
import { settingsTabAtom, settingsEditingAtom } from '@/atoms/settings-tab'
import { canLeaveSettings } from '@/lib/channel-form'
import type { SettingsTab } from '@/atoms/settings-tab'
import { cn } from '@/lib/utils'
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
  { id: 'profile', label: '用户资料', icon: <UserRound size={16} /> },
  { id: 'appearance', label: '外观设置', icon: <Palette size={16} /> },
  { id: 'agent', label: 'Agent 设置', icon: <Bot size={16} /> },
  { id: 'shortcuts', label: '快捷键', icon: <Keyboard size={16} /> },
  { id: 'channels', label: '模型渠道', icon: <Plug size={16} /> },
  { id: 'about', label: '关于 Axon', icon: <Info size={16} /> },
]

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
      <div className="titlebar-drag-region h-10 shrink-0 border-b bg-[hsl(var(--sidebar-surface))]" />
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r bg-[hsl(var(--sidebar-surface))] p-3">
          <div className="px-3 pb-3 pt-2 text-sm font-semibold">设置</div>
          <nav className="space-y-1">
            {NAVIGATION_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  if (item.id !== activeTab && canLeaveSettings(editing, () => window.confirm('放弃未保存的渠道更改？'))) setActiveTab(item.id)
                }}
                className={cn(
                  'flex h-10 w-full items-center gap-2 rounded-lg px-3 text-sm transition-colors',
                  activeTab === item.id
                    ? 'bg-muted font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                )}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </nav>
          <button
            type="button"
            onClick={onClose}
            className="mt-auto flex h-10 w-full items-center gap-2 rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            <ArrowLeft size={16} />
            返回工作区
            <span className="ml-auto text-[10px] opacity-60">Esc</span>
          </button>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto bg-content-area scrollbar-none">
          <div className="mx-auto w-full max-w-4xl px-8 py-10">
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
