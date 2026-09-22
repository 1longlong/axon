import { useEffect, useState } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { themeModeAtom, systemIsDarkAtom, applyThemeToDOM, initializeTheme } from './atoms/theme'
import { userProfileAtom } from './atoms/user-profile'
import { initializeMarkdownFontSize, markdownFontSizeAtom } from './atoms/markdown-font-size'
import { agentSystemPromptAtom, agentSystemPromptTemplatesAtom, initializeAgentSystemPrompt } from './atoms/system-prompt'
import { AppShell } from './components/app-shell/AppShell'
import { ChatStateProvider } from './components/chat/ChatStateProvider'
import { AgentStateProvider } from './components/agent/AgentStateProvider'
import { QuickChatWindow } from './components/app-shell/QuickChatWindow'
import type { UserProfile } from '@/types/user-profile'

/**
 * 应用入口只负责初始化跨页面主题，再挂载稳定的 AppShell。
 * 设置页会在 B3 通过同一主题 atom 提供切换入口。
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

  // 初始化：从主进程读设置 + 监听系统主题
  useEffect(() => {
    let cleanup: (() => void) | undefined
    initializeTheme(setThemeMode, setSystemIsDark)
      .then((fn) => { cleanup = fn })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
    return () => cleanup?.()
  }, [setThemeMode])

  useEffect(() => {
    void initializeMarkdownFontSize(setMarkdownFontSize)
  }, [setMarkdownFontSize])

  useEffect(() => {
    void initializeAgentSystemPrompt(setSystemPrompt, setSystemPromptTemplates)
  }, [setSystemPrompt, setSystemPromptTemplates])

  // 用户资料是 Chat 与 Agent 的共享身份，在应用根部统一加载一次。
  useEffect(() => {
    let cancelled = false
    void window.axon.userProfile.get()
      .then((profile: UserProfile) => {
        if (!cancelled) setUserProfile(profile)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [setUserProfile])

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
