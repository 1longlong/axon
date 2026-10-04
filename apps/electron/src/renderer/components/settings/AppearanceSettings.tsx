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
  { value: 'light', label: '浅色', description: '始终使用明亮界面', icon: <Sun size={16} /> },
  { value: 'dark', label: '深色', description: '始终使用深色界面', icon: <Moon size={16} /> },
  { value: 'system', label: '跟随系统', description: '随系统外观自动切换', icon: <Laptop size={16} /> },
]

export function AppearanceSettings(): React.ReactElement {
  const [themeMode, setThemeMode] = useAtom(themeModeAtom)
  const systemIsDark = useAtomValue(systemIsDarkAtom)
  const resolvedTheme = useAtomValue(resolvedThemeAtom)
  const [message, setMessage] = React.useState<string | null>(null)

  /** 先即时应用外观，再保存偏好；失败时同步回退原子和 DOM，避免界面与持久化分离。 */
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
    <section className="max-w-2xl">
      <h1 className="text-sm font-semibold">外观设置</h1>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">选择应用的基础配色方案。</p>

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        {THEME_OPTIONS.map((option) => {
          const isSelected = themeMode === option.value
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={isSelected}
              onClick={() => void handleThemeChange(option.value)}
              className={cn(
                'relative rounded-md border bg-[hsl(var(--input-surface))] p-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                isSelected && 'border-indigo-500/40 bg-indigo-500/5 dark:border-indigo-400/50',
              )}
            >
              <span className="text-muted-foreground">{option.icon}</span>
              <span className="mt-3 block text-xs font-medium">{option.label}</span>
              <span className="mt-1 block text-xs text-muted-foreground">{option.description}</span>
              {isSelected && (
                <span className="absolute right-3 top-3 flex h-4 w-4 items-center justify-center rounded bg-primary text-primary-foreground">
                  <Check size={10} />
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div className="mt-4 rounded-md border border-border-subtle bg-[hsl(var(--input-surface))] px-3 py-3 text-xs">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="font-medium">当前生效外观</p>
            <p className="mt-1 text-xs text-muted-foreground">跟随系统模式会实时响应系统变化。</p>
          </div>
          <span className="rounded border border-border-subtle bg-muted/50 px-2 py-1 font-mono text-[11px]">
            {resolvedTheme === 'dark' ? '深色' : '浅色'}
          </span>
        </div>
      </div>

      <p className="mt-3 text-xs text-muted-foreground" role="status">{message}</p>
    </section>
  )
}
