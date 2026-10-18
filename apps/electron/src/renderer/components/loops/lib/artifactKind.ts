/** Axon Loop 展示组件与纯计算；第三方许可见 THIRD_PARTY_NOTICES.md。 */
export type ArtifactKind = 'image' | 'html' | 'markdown' | 'text'

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function ext(path: string): string {
  return (path.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase()
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function imageMime(path: string): string | null {
  return IMAGE_MIME[ext(path)] ?? null
}

export const isImagePath = (path: string): boolean => imageMime(path) !== null
export const isHtmlPath = (path: string): boolean => ext(path) === 'html' || ext(path) === 'htm'
export const isMarkdownPath = (path: string): boolean => ext(path) === 'md' || ext(path) === 'markdown'

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function artifactKind(path: string): ArtifactKind {
  if (isImagePath(path)) return 'image'
  if (isHtmlPath(path)) return 'html'
  if (isMarkdownPath(path)) return 'markdown'
  return 'text'
}
