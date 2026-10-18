/** 模板净化后的样式与链接再收窄；不允许样式联网、覆盖桌面或链接回特权协议。 */
import DOMPurify from 'dompurify'
import type { Config } from 'dompurify'

const STYLE_PROPERTIES = /^(?:color|background-color|font-(?:size|weight|family|style)|line-height|text-(?:align|decoration|transform)|letter-spacing|white-space|overflow(?:-x|-y)?|overflow-wrap|word-break|display|flex(?:-direction|-wrap|-grow|-shrink|-basis)?|align-items|justify-content|grid-template-columns|grid-column|gap|(?:row|column)-gap|(?:min-|max-)?(?:width|height)|padding(?:-(?:top|right|bottom|left))?|margin(?:-(?:top|right|bottom|left))?|border(?:-(?:top|right|bottom|left))?(?:-width|-style|-color|-radius)?|box-shadow)$/

/** 输入仅为内容字符串；输出可渲染 HTML，不保留事件、任意样式或远程图片。 */
export function sanitizeLoopMarkup(html: string, config: Config, styles = false): string {
  const fragment = DOMPurify.sanitize(html, { ...config, RETURN_DOM_FRAGMENT: true })
  for (const element of fragment.querySelectorAll<HTMLElement>('*')) {
    if (element.hasAttribute('style')) {
      if (!styles) element.removeAttribute('style')
      else for (const name of Array.from(element.style)) {
        const value = element.style.getPropertyValue(name)
        if (!STYLE_PROPERTIES.test(name) || /url\s*\(|image-set\s*\(|expression\s*\(|@|\\/i.test(value)
          || /var\(/i.test(value) && !/^.*var\(--color-[a-z0-9-]+\).*$/i.test(value)) element.style.removeProperty(name)
      }
    }
    if (element.tagName === 'A') {
      const href = element.getAttribute('href') ?? ''
      if (!/^https?:\/\//i.test(href)) element.removeAttribute('href')
      element.setAttribute('target', '_blank'); element.setAttribute('rel', 'noreferrer noopener')
    }
    if (element.tagName === 'IMG' && !/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(element.getAttribute('src') ?? '')) element.removeAttribute('src')
  }
  const container = document.createElement('div'); container.append(fragment)
  return container.innerHTML
}
