import { atom } from 'jotai'
import { DEFAULT_MARKDOWN_FONT_SIZE } from '@axon/shared'
import type { MarkdownFontSize } from '@axon/shared'

const FONT_SIZE_PX: Record<MarkdownFontSize, number> = { small: 13, medium: 15, large: 17 }

export const markdownFontSizeAtom = atom<MarkdownFontSize>(DEFAULT_MARKDOWN_FONT_SIZE)

/** 将 Markdown 字号同步到根 CSS 变量，消息渲染层只消费变量。 */
export function applyMarkdownFontSizeToDOM(size: MarkdownFontSize): void {
  document.documentElement.style.setProperty('--md-preview-font-size', `${FONT_SIZE_PX[size]}px`)
}

/** 先更新当前窗口，再异步持久化，保证切换字号立即生效。 */
export async function updateMarkdownFontSize(size: MarkdownFontSize): Promise<void> {
  applyMarkdownFontSizeToDOM(size)
  await window.axon.settings.update({ markdownFontSize: size })
}
