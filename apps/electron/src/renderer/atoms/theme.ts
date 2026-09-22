/**
 * 主题状态原子
 *
 * 管理应用主题模式（浅色/深色/跟随系统）。
 * - themeModeAtom: 用户选择的主题模式，持久化到 ~/.axon/settings.json
 * - systemIsDarkAtom: 系统当前是否为深色模式（matchMedia 监听）
 * - resolvedThemeAtom: 派生的最终主题（light | dark）
 *
 * 使用 localStorage 作为缓存，避免页面加载时闪烁（配合 index.html 的初始化脚本）。
 */

import { atom } from 'jotai'
import type { ThemeMode } from '@axon/shared'

/** localStorage 缓存键 */
const THEME_CACHE_KEY = 'axon-theme-mode'

/**
 * 从 localStorage 读取缓存的主题模式
 */
function getCachedThemeMode(): ThemeMode {
  try {
    const cached = localStorage.getItem(THEME_CACHE_KEY)
    if (cached === 'light' || cached === 'dark' || cached === 'system') {
      return cached
    }
  } catch {
    // localStorage 不可用时忽略
  }
  return 'dark'
}

/**
 * 缓存主题模式到 localStorage
 */
function cacheThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_CACHE_KEY, mode)
  } catch {
    // localStorage 不可用时忽略
  }
}

/** 用户选择的主题模式 */
export const themeModeAtom = atom<ThemeMode>(getCachedThemeMode())

/** 系统当前是否为深色模式 */
export const systemIsDarkAtom = atom<boolean>(true)

/** 派生：最终解析的主题（light | dark） */
export const resolvedThemeAtom = atom<'light' | 'dark'>((get) => {
  const mode = get(themeModeAtom)
  if (mode === 'system') {
    return get(systemIsDarkAtom) ? 'dark' : 'light'
  }
  return mode
})

/**
 * 应用主题到 DOM
 *
 * 在 <html> 元素上切换 dark 类名。
 *
 * 幂等实现：先计算目标状态，与当前 DOM 对比，一致时直接 return，
 * 不触发任何 classList mutation。避免与 vibrancy 合成层叠加
 * 导致 Chromium 重建合成层造成的全屏闪烁。
 */
export function applyThemeToDOM(themeMode: ThemeMode, systemIsDark: boolean = true): void {
  const html = document.documentElement

  // 计算目标状态
  const targetIsDark = themeMode === 'system' ? systemIsDark : themeMode === 'dark'

  // 与目标一致 → 直接跳过，避免触发 CSS 重新级联
  if (html.classList.contains('dark') === targetIsDark) {
    return
  }

  html.classList.toggle('dark', targetIsDark)
}

/**
 * 初始化主题系统
 *
 * 从主进程加载持久化设置，监听系统主题变化。
 * 返回清理函数。
 */
export async function initializeTheme(
  setThemeMode: (mode: ThemeMode) => void,
  setSystemIsDark: (isDark: boolean) => void,
): Promise<() => void> {
  // 从主进程加载持久化设置
  const settings = await window.axon.settings.get()
  setThemeMode(settings.themeMode)
  cacheThemeMode(settings.themeMode)

  // 获取并监听系统主题（matchMedia；多窗口同步事件随设置页阶段接入）
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  setSystemIsDark(media.matches)
  const onSystemThemeChange = (event: MediaQueryListEvent): void => {
    setSystemIsDark(event.matches)
  }
  media.addEventListener('change', onSystemThemeChange)

  return () => {
    media.removeEventListener('change', onSystemThemeChange)
  }
}

/**
 * 更新主题模式并持久化
 *
 * 同时更新 localStorage 缓存和主进程配置文件。
 */
export async function updateThemeMode(mode: ThemeMode): Promise<void> {
  cacheThemeMode(mode)
  await window.axon.settings.update({ themeMode: mode })
}
