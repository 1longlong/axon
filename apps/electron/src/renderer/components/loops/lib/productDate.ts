/** Axon Loop 展示组件与纯计算；第三方许可见 THIRD_PARTY_NOTICES.md。 */
import type { ArtifactMeta } from '../types'

export interface ProductDate {

  date: string
  source: 'frontmatter' | 'filename' | 'sync'
}

const basename = (path: string): string => path.split('/').pop() || path

const pad = (n: number): string => String(n).padStart(2, '0')

function validDate(y: number, m: number, d: number): boolean {
  if (y < 1970 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

const DATE_RE = /(\d{4})(?:([-_])(\d{2})\2(\d{2})|(\d{2})(\d{2}))/g

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function parseFilenameDate(path: string): string | null {
  const name = basename(path)
  DATE_RE.lastIndex = 0
  for (let m = DATE_RE.exec(name); m; m = DATE_RE.exec(name)) {

    const before = name[m.index - 1]
    const after = name[m.index + m[0].length]
    if ((before && /\d/.test(before)) || (after && /\d/.test(after))) continue
    const y = Number(m[1])
    const mo = Number(m[3] ?? m[5])
    const d = Number(m[4] ?? m[6])
    if (validDate(y, mo, d)) return `${m[1]}-${pad(mo)}-${pad(d)}`
  }
  return null
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function localDay(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function parseMetaDate(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const m = /^\s*(\d{4})[-/_](\d{2})[-/_](\d{2})/.exec(raw)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  return validDate(y, mo, d) ? `${m[1]}-${pad(mo)}-${pad(d)}` : null
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function productDate(file: { path: string; updatedAt: string; meta?: ArtifactMeta | null }): ProductDate {
  const fromMeta = parseMetaDate(file.meta?.date)
  if (fromMeta) return { date: fromMeta, source: 'frontmatter' }
  const fromName = parseFilenameDate(file.path)
  return fromName ? { date: fromName, source: 'filename' } : { date: localDay(file.updatedAt), source: 'sync' }
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function globToRegExp(pattern: string): RegExp {
  const rx = pattern
    .split('*')
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*')
  return new RegExp(`^${rx}$`)
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function matchArtifacts<T extends { path: string }>(files: T[], pattern?: string): T[] {
  if (!pattern) return files
  const rx = globToRegExp(pattern)
  const onBase = !pattern.includes('/')
  return files.filter((f) => rx.test(onBase ? basename(f.path) : f.path))
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function newestMatch<T extends { path: string; updatedAt: string }>(
  files: T[],
  pattern?: string,
): T | undefined {
  const matched = matchArtifacts(files, pattern)
  let best: T | undefined
  let bestKey = ''
  for (const f of matched) {
    const key = `${productDate(f).date}|${f.updatedAt}`
    if (!best || key > bestKey) {
      best = f
      bestKey = key
    }
  }
  return best
}
