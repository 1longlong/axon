import { useEffect, useState } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { themeModeAtom, systemIsDarkAtom, applyThemeToDOM, cacheThemeMode } from './atoms/theme'
import { userProfileAtom } from './atoms/user-profile'
import { applyMarkdownFontSizeToDOM, markdownFontSizeAtom } from './atoms/markdown-font-size'
import { agentSystemPromptAtom, agentSystemPromptTemplatesAtom } from './atoms/system-prompt'
import { subscribeRendererPreferences } from './atoms/renderer-preferences'
import { AppShell } from './components/app-shell/AppShell'
import { ChatStateProvider } from './components/chat/ChatStateProvider'
import { AgentStateProvider } from './components/agent/AgentStateProvider'
import { QuickChatWindow } from './components/app-shell/QuickChatWindow'
import { DEFAULT_MARKDOWN_FONT_SIZE } from '@axon/shared'

/**
 * 应用入口同步已保存全局偏好和资料，再挂载稳定的会话壳；不重放用户输入。
 */
export function App() {
  const quickWindow = new URLSearchParams(window.location.search).get('quick') === '1'
  const [themeMode, setThemeMode] = useAtom(themeModeAtom)
  const [systemIsDark, setSystemIsDark] = useAtom(systemIsDarkAtom)
  const setUserProfile = useSetAtom(userProfileAtom)
  const setMarkdownFontSize = useSetAtom(markdownFontSizeAtom)
  const setSystemPrompt = useSetAtom(agentSystemPromptAtom)
  const setSystemPromptTemplates = useSetAtom(agentSystemPromptTemplatesAtom)
  const [error, setError] = useState<string | null>(null)

  // 系统主题监听独立于后端请求；卸载时同步清理，不等待初始化 Promise。
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    setSystemIsDark(media.matches)
    const changed = (event: MediaQueryListEvent): void => setSystemIsDark(event.matches)
    media.addEventListener('change', changed)
    return () => media.removeEventListener('change', changed)
  }, [setSystemIsDark])

  useEffect(() => subscribeRendererPreferences(window.axon, {
    settings: (settings) => {
      setThemeMode(settings.themeMode); cacheThemeMode(settings.themeMode)
      const size = settings.markdownFontSize ?? DEFAULT_MARKDOWN_FONT_SIZE
      setMarkdownFontSize(size); applyMarkdownFontSizeToDOM(size)
      setSystemPrompt(settings.agentSystemPrompt ?? '')
      setSystemPromptTemplates(settings.agentSystemPromptTemplates)
    },
    profile: setUserProfile,
    error: setError,
  }), [setThemeMode, setMarkdownFontSize, setSystemPrompt, setSystemPromptTemplates, setUserProfile])

  // 主题变化 → 应用到 DOM
  useEffect(() => {
    applyThemeToDOM(themeMode, systemIsDark)
  }, [themeMode, systemIsDark])

  return (
    <div className="h-full w-full">
      <ChatStateProvider>
        <AgentStateProvider>
          {quickWindow ? <QuickChatWindow /> : <AppShell />}
        </AgentStateProvider>
      </ChatStateProvider>
      {error && (
        <div className="fixed bottom-3 left-1/2 z-[120] -translate-x-1/2 rounded-md bg-destructive px-3 py-2 text-xs text-destructive-foreground shadow-lg">
          应用初始化失败：{error}
        </div>
      )}
    </div>
  )
}
