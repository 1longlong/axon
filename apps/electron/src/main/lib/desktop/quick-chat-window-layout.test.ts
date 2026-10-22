import { describe, expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import type { BrowserWindow, Rectangle } from 'electron'
import type { setQuickChatWindowExpanded } from './quick-chat-window-layout'

class WindowFixture {
  bounds = { x: 100, y: 600, width: 860, height: 104 }
  minimum: number[] = []
  isDestroyed(): boolean { return false }
  getBounds(): Rectangle { return { ...this.bounds } }
  setBounds(value: Rectangle): void { this.bounds = { ...value } }
  setMinimumSize(width: number, height: number): void { this.minimum = [width, height] }
  native(): BrowserWindow { return this as unknown as BrowserWindow }
}

/** 只替换原生 screen，不污染全仓的 Electron 模块注册表。 */
async function layout(workArea = { x: 0, y: 0, width: 1920, height: 1080 }) {
  const built = await Bun.build({ entrypoints: [`${import.meta.dir}/quick-chat-window-layout.ts`], target: 'node', format: 'cjs', external: ['electron'] })
  if (!built.success) throw new Error('布局夹具构建失败')
  const module = { exports: {} as { setQuickChatWindowExpanded: typeof setQuickChatWindowExpanded } }, require = createRequire(import.meta.url)
  const run = new Function('require', 'module', 'exports', await built.outputs[0]!.text())
  run((name: string) => name === 'electron' ? { screen: { getDisplayMatching: () => ({ workArea }) } } : require(name), module, module.exports)
  return module.exports.setQuickChatWindowExpanded
}

describe('快捷附件紧凑布局', () => {
  test('附件增高保持底边，展开/收起后还原，清空回到默认高度', async () => {
    const set = await layout(), window = new WindowFixture()
    set(window.native(), false, 40)
    expect(window.bounds).toMatchObject({ y: 560, height: 144 })
    set(window.native(), true)
    expect(window.bounds).toMatchObject({ y: 74, height: 630 })
    set(window.native(), false)
    expect(window.bounds).toMatchObject({ y: 560, height: 144 })
    set(window.native(), false, 0)
    expect(window.bounds).toMatchObject({ y: 600, height: 104 })
  })
  test('展开时附件高度变化不冒充用户拖动，收起仍保持原底边', async () => {
    const set = await layout(), window = new WindowFixture()
    set(window.native(), false, 0); set(window.native(), true)
    set(window.native(), true, 80); set(window.native(), false)
    expect(window.bounds).toMatchObject({ y: 520, height: 184 })
  })
  test('手动移动后收起沿用新位置，并限制屏幕边界', async () => {
    const set = await layout({ x: 0, y: 0, width: 1920, height: 800 }), window = new WindowFixture()
    set(window.native(), false, 40); set(window.native(), true)
    window.bounds = { ...window.bounds, x: 180, y: 300 }
    set(window.native(), false)
    expect(window.bounds.x).toBe(180); expect(window.bounds.y + window.bounds.height).toBe(800)
  })
  test('展开的小窗口增加附件时保留最小内容空间且不越出屏幕', async () => {
    const set = await layout({ x: 0, y: 0, width: 1920, height: 800 }), window = new WindowFixture()
    set(window.native(), true)
    window.bounds = { ...window.bounds, y: 400, height: 300 }
    set(window.native(), true, 200)
    expect(window.minimum).toEqual([800, 424])
    expect(window.bounds.height).toBe(424); expect(window.bounds.y + window.bounds.height).toBeLessThanOrEqual(800)
  })
})
