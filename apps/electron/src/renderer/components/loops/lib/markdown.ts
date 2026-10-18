/** Axon Loop 展示组件与纯计算；第三方许可见 THIRD_PARTY_NOTICES.md。 */
import type { Config } from 'dompurify'
import { marked } from 'marked'
import { sanitizeLoopMarkup } from './safe-markup'

export const MD_SANITIZE: Config = {
  ALLOWED_TAGS: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'strong', 'b', 'em', 'i',
    'del', 's', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'span',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img',
  ],
  ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'src', 'alt'],
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function renderMarkdown(content: string): string {
  return sanitizeLoopMarkup(marked.parse(content, { async: false, gfm: true }) as string, MD_SANITIZE)
}
