import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { Check, Laptop, Moon, Sun } from 'lucide-react'
import type { ThemeMode } from '@axon/shared'
import {
  applyThemeToDOM,
  resolvedThemeAtom,
  systemIsDarkAtom,
  themeModeAtom,
  updateThemeMode,
} from '@/atoms/theme'
import { cn } from '@/lib/utils'

interface ThemeOption {
  value: ThemeMode
  label: string
  description: string
  icon: React.ReactNode
}

const THEME_OPTIONS: readonly ThemeOption[] = [
  { value: 'light', label: '浅色', description: '始终使用明亮界面', icon: <Sun size={20} /> },
  { value: 'dark', label: '深色', description: '始终使用深色界面', icon: <Moon size={20} /> },
  { value: 'system', label: '跟随系统', description: '随系统外观自动切换', icon: <Laptop size={20} /> },
]

export function AppearanceSettings(): React.ReactElement {
  const [themeMode, setThemeMode] = useAtom(themeModeAtom)
  const systemIsDark = useAtomValue(systemIsDarkAtom)
  const resolvedTheme = useAtomValue(resolvedThemeAtom)
  const [message, setMessage] = React.useState<string | null>(null)

  const handleThemeChange = async (mode: ThemeMode): Promise<void> => {
    const previousMode = themeMode
    setThemeMode(mode)
    applyThemeToDOM(mode, systemIsDark)
    setMessage(null)
    try {
      await updateThemeMode(mode)
      setMessage('外观设置已保存')
    } catch (error: unknown) {
      setThemeMode(previousMode)
      applyThemeToDOM(previousMode, systemIsDark)
      setMessage(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return (
    <section>
      <h1 className="text-xl font-semibold">外观设置</h1>
      <p className="mt-1 text-sm text-muted-foreground">选择应用的基础配色方案。</p>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        {THEME_OPTIONS.map((option) => {
          const isSelected = themeMode === option.value
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => void handleThemeChange(option.value)}
              className={cn(
                'relative rounded-xl border bg-card p-4 text-left shadow-sm transition-colors hover:bg-muted/40',
                isSelected && 'border-primary ring-1 ring-primary',
              )}
            >
              <span className="text-muted-foreground">{option.icon}</span>
              <span className="mt-4 block text-sm font-medium">{option.label}</span>
              <span className="mt-1 block text-xs text-muted-foreground">{option.description}</span>
              {isSelected && (
                <span className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <Check size={12} />
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div className="mt-6 rounded-xl border bg-card px-4 py-3 text-sm shadow-sm">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="font-medium">当前生效外观</p>
            <p className="mt-1 text-xs text-muted-foreground">跟随系统模式会实时响应系统变化。</p>
          </div>
          <span className="rounded-full bg-muted px-3 py-1 text-xs">
            {resolvedTheme === 'dark' ? '深色' : '浅色'}
          </span>
        </div>
      </div>

      <p className="mt-3 text-xs text-muted-foreground" role="status">{message}</p>
    </section>
  )
}
