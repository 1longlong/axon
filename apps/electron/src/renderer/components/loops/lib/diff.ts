/** Axon Loop 展示组件与纯计算；第三方许可见 THIRD_PARTY_NOTICES.md。 */
export type DiffLineKind =
  | 'add'
  | 'del'
  | 'hunk'
  | 'meta'
  | 'context'

export interface DiffLine {
  kind: DiffLineKind

  text: string

  gutter: string
}

function classify(line: string, inHunk: boolean): DiffLine {
  if (line.startsWith('@@')) return { kind: 'hunk', text: line, gutter: '' }
  if (!inHunk) {

    if (
      line.startsWith('---') ||
      line.startsWith('+++') ||
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('Index:') ||
      line.startsWith('===')
    )
      return { kind: 'meta', text: line, gutter: '' }

    return { kind: 'context', text: line, gutter: '' }
  }

  if (line.startsWith('+')) return { kind: 'add', text: line.slice(1), gutter: '+' }
  if (line.startsWith('-')) return { kind: 'del', text: line.slice(1), gutter: '-' }

  if (line.startsWith(' ')) return { kind: 'context', text: line.slice(1), gutter: '' }

  return { kind: 'context', text: line, gutter: '' }
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  if (!diff) return []
  const body = diff.endsWith('\n') ? diff.slice(0, -1) : diff
  let inHunk = false
  return body.split('\n').map((line) => {
    const classified = classify(line, inHunk)
    if (classified.kind === 'hunk') inHunk = true
    return classified
  })
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function diffStat(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.kind === 'add') added++
    else if (l.kind === 'del') removed++
  }
  return { added, removed }
}
