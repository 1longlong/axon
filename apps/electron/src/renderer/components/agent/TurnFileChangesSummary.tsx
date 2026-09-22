import * as React from 'react'
import { FilePenLine } from 'lucide-react'
import { Loader2, X } from 'lucide-react'
import type { AgentFileChange } from '@/lib/agent-file-changes'
import type { AgentWorkspaceFileDiff } from '@axon/shared'
import { useAgentController } from './AgentStateProvider'

function operationLabel(file: AgentFileChange): string {
  if (file.operations.length > 1) return '写入并编辑'
  return file.operations[0] === 'write' ? '写入' : '编辑'
}

/** 在一轮 result 后展示已确认成功的文件操作，并按需打开单文件 Diff。 */
export function TurnFileChangesSummary({ projectId, files }: { projectId: string; files: readonly AgentFileChange[] }): React.ReactElement {
  const controller = useAgentController()
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null)
  const [diff, setDiff] = React.useState<AgentWorkspaceFileDiff | null>(null)
  const [loading, setLoading] = React.useState(false)

  /** 只为用户点击的文件读取 Diff，避免展开汇总时批量触发 Git 进程。 */
  const openDiff = async (path: string): Promise<void> => {
    setSelectedPath(path)
    setDiff(null)
    setLoading(true)
    try { setDiff(await controller.readProjectDiff(projectId, path)) }
    catch { setDiff({ projectId, relativePath: path, status: 'unavailable', message: '读取 Diff 失败' }) }
    finally { setLoading(false) }
  }

  return <details className="ml-10 rounded-md border bg-muted/20 px-3 py-2 text-xs">
    <summary className="flex cursor-pointer list-none items-center gap-2 text-muted-foreground [&::-webkit-details-marker]:hidden">
      <FilePenLine size={13} />本轮变更 {files.length} 个文件
    </summary>
    <div className="mt-2 space-y-1 border-t pt-2">
      {files.map((file) => <div key={file.path} className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px]">{operationLabel(file)}</span>
        <button type="button" aria-label={`查看 ${file.path} Diff`} onClick={() => void openDiff(file.path)} className="min-w-0 truncate font-mono text-[11px] text-left underline-offset-2 hover:underline" title="查看 Diff">{file.path}</button>
      </div>)}
    </div>
    {selectedPath && <div className="mt-2 rounded border bg-background">
      <div className="flex items-center gap-2 border-b px-2 py-1.5 text-[11px]">
        <span className="min-w-0 flex-1 truncate font-mono">{selectedPath}</span>
        <button type="button" aria-label="关闭 Diff" onClick={() => { setSelectedPath(null); setDiff(null) }}><X size={12} /></button>
      </div>
      <div className="max-h-72 overflow-auto p-2">
        {loading ? <p className="flex items-center gap-1 text-muted-foreground"><Loader2 size={12} className="animate-spin" />正在读取 Diff…</p>
          : diff?.status === 'changed' ? <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-4">{diff.patch}</pre>
            : <p className="text-muted-foreground">{diff?.message ?? '暂无 Diff'}</p>}
      </div>
    </div>}
  </details>
}
