/** Axon Loop 展示组件与纯计算；第三方许可见 THIRD_PARTY_NOTICES.md。 */
import type { ArtifactSummary } from '../types'

export type FileEntry =
  | { kind: 'task'; path: string }
  | { kind: 'artifact'; path: string; file: ArtifactSummary; task?: boolean }

const basename = (path: string) => path.split('/').pop() || path

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function taskMatchRank(taskFile: string | undefined, artifactPath: string): 0 | 1 | 2 | 3 {
  if (!taskFile) return 0
  const a = norm(taskFile)
  const b = norm(artifactPath)
  if (!a || !b) return 0
  if (a === b) return 3

  if (a.endsWith('/' + b) || b.endsWith('/' + a)) return 2
  return basename(a) === basename(b) ? 1 : 0
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function isTaskPath(taskFile: string | undefined, artifactPath: string): boolean {
  return taskMatchRank(taskFile, artifactPath) > 0
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function pickTaskPath(taskFile: string | undefined, paths: string[]): string | null {
  const depth = (p: string) => norm(p).split('/').length
  let best: string | null = null
  let bestRank = 0
  for (const p of paths) {
    const rank = taskMatchRank(taskFile, p)
    if (rank === 0) continue
    if (rank > bestRank || (rank === bestRank && best != null && depth(p) < depth(best))) {
      best = p
      bestRank = rank
    }
  }
  return best
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function buildFileEntries(taskFile: string | undefined, artifacts: ArtifactSummary[]): FileEntry[] {
  const bestPath = pickTaskPath(taskFile, artifacts.map((f) => f.path))
  const taskArtifact = bestPath != null ? artifacts.find((f) => f.path === bestPath) : undefined
  const out: FileEntry[] = []
  if (taskArtifact) out.push({ kind: 'artifact', path: taskArtifact.path, file: taskArtifact, task: true })
  else if (taskFile) out.push({ kind: 'task', path: taskFile })
  for (const f of artifacts) {
    if (taskArtifact && f.path === taskArtifact.path) continue
    out.push({ kind: 'artifact', path: f.path, file: f })
  }
  return out
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function isTaskEntry(e: FileEntry | null | undefined): boolean {
  return e?.kind === 'task' || (e?.kind === 'artifact' && !!e.task)
}
