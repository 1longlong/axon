/**
 * 主窗口 bounds 归一化测试（外接显示器断开场景）
 */

import { describe, expect, test } from 'bun:test'
import {
  normalizeWindowBoundsToVisibleArea,
  ensureWindowBoundsVisible,
  hideMacMainWindowAfterClose,
} from './main-window-lifecycle'

const PRIMARY = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } }
const SECONDARY = { workArea: { x: 1920, y: 0, width: 1920, height: 1080 } }

describe('normalizeWindowBoundsToVisibleArea', () => {
  test('bounds 在可见显示器内时原样保留', () => {
    const bounds = { width: 1200, height: 800, x: 100, y: 100 }
    expect(normalizeWindowBoundsToVisibleArea(bounds, [PRIMARY], PRIMARY)).toEqual(bounds)
  })

  test('窗口与任意显示器有交叠时保留（跨屏摆放）', () => {
    const bounds = { width: 1920, height: 800, x: 1000, y: 100 }
    expect(normalizeWindowBoundsToVisibleArea(bounds, [PRIMARY, SECONDARY], PRIMARY)).toEqual(bounds)
  })

  test('外接显示器断开后恢复到主屏居中', () => {
    const bounds = { width: 1200, height: 800, x: 2400, y: 100 }
    const result = normalizeWindowBoundsToVisibleArea(bounds, [PRIMARY], PRIMARY, { minWidth: 800, minHeight: 600 })
    expect(result.x).toBeGreaterThanOrEqual(0)
    expect(result.y).toBeGreaterThanOrEqual(0)
    expect(result.x + result.width).toBeLessThanOrEqual(1920)
    expect(result.y + result.height).toBeLessThanOrEqual(1080)
  })

  test('非法尺寸被规范化', () => {
    const bounds = { width: -5, height: NaN, x: 100, y: 100 }
    const result = normalizeWindowBoundsToVisibleArea(bounds, [PRIMARY], PRIMARY)
    expect(result.width).toBeGreaterThan(0)
    expect(result.height).toBeGreaterThan(0)
  })
})

describe('ensureWindowBoundsVisible', () => {
  test('已可见窗口不触发 setBounds', () => {
    let setBoundsCalled = false
    const win = {
      isMaximized: () => false,
      isFullScreen: () => false,
      getBounds: () => ({ width: 1200, height: 800, x: 100, y: 100 }),
      setBounds: () => { setBoundsCalled = true },
    }
    expect(ensureWindowBoundsVisible(win, [PRIMARY], PRIMARY)).toBe(false)
    expect(setBoundsCalled).toBe(false)
  })

  test('不可见窗口被重新定位', () => {
    const applied: Array<{ width: number; height: number; x: number; y: number }> = []
    const win = {
      isMaximized: () => false,
      isFullScreen: () => false,
      getBounds: () => ({ width: 1200, height: 800, x: 5000, y: 5000 }),
      setBounds: (b: { width: number; height: number; x: number; y: number }) => applied.push(b),
    }
    expect(ensureWindowBoundsVisible(win, [PRIMARY], PRIMARY)).toBe(true)
    expect(applied.length).toBe(1)
  })

  test('最大化/全屏窗口绝不被动', () => {
    const win = {
      isMaximized: () => true,
      isFullScreen: () => false,
      getBounds: () => ({ width: 1200, height: 800, x: 5000, y: 5000 }),
      setBounds: () => { throw new Error('不应调用 setBounds') },
    }
    expect(ensureWindowBoundsVisible(win, [PRIMARY], PRIMARY)).toBe(false)
  })
})

describe('hideMacMainWindowAfterClose', () => {
  test('非全屏窗口立即隐藏', () => {
    const calls: string[] = []
    const win = {
      isDestroyed: () => false,
      isFullScreen: () => false,
      setFullScreen: () => { throw new Error('不应调用 setFullScreen') },
      once: () => { throw new Error('不应注册 leave-full-screen') },
      hide: () => calls.push('win.hide'),
    }
    const app = { hide: () => calls.push('app.hide') }

    hideMacMainWindowAfterClose(win, app)
    expect(calls).toEqual(['win.hide', 'app.hide'])
  })

  test('全屏窗口先退出全屏再延迟隐藏', () => {
    const calls: string[] = []
    let leaveFullScreenListener: (() => void) | null = null
    const win = {
      isDestroyed: () => false,
      isFullScreen: () => true,
      setFullScreen: (flag: boolean) => { expect(flag).toBe(false) },
      once: (_event: 'leave-full-screen', listener: () => void) => { leaveFullScreenListener = listener },
      hide: () => calls.push('win.hide'),
    }
    const app = { hide: () => calls.push('app.hide') }
    const scheduled: Array<() => void> = []
    const schedule = (cb: () => void, _delayMs: number) => { scheduled.push(cb) }

    hideMacMainWindowAfterClose(win, app, schedule)
    expect(calls).toEqual([])

    // leave-full-screen 后延迟隐藏
    const listener = leaveFullScreenListener as (() => void) | null
    listener?.()
    scheduled.at(-1)?.()
    expect(calls).toEqual(['win.hide', 'app.hide'])
  })

  test('隐藏应用时同步隐藏 Dock 图标', () => {
    const calls: string[] = []
    const win = {
      isDestroyed: () => false,
      isFullScreen: () => false,
      setFullScreen: () => {},
      once: () => {},
      hide: () => calls.push('win.hide'),
    }
    const app = {
      hide: () => calls.push('app.hide'),
      dock: { hide: () => { calls.push('dock.hide') } },
    }

    hideMacMainWindowAfterClose(win, app)
    expect(calls).toEqual(['win.hide', 'app.hide', 'dock.hide'])
  })
})
