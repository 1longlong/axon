/** Axon Loop 展示组件与纯计算；第三方许可见 THIRD_PARTY_NOTICES.md。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ArtifactSummary } from '../types'
import { fmt, humanBytes } from '../lib/format'
import { buildFileEntries, isTaskEntry } from '../lib/fileEntries'
import { getArtifacts } from '../data/loop-api'
import { ArtifactBody, ViewerHead } from './artifactView'
import { TaskFileView } from './TaskFileView'

const basename = (path: string) => path.split('/').pop() || path

function typeTag(path: string): string {
  const m = path.match(/\.([a-z0-9]+)$/i)
  return m ? m[1]!.toLowerCase() : 'file'
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function LoopFilesPanel({
  loopId,
  taskFile,
  taskFileContent,
  taskFileSyncedAt,
  running,
}: {
  loopId: string

  taskFile?: string

  taskFileContent: string | null
  taskFileSyncedAt: string | null
  running?: boolean
}) {
  const [artifacts, setArtifacts] = useState<ArtifactSummary[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const seq = useRef(0)

  const refresh = useCallback(async () => {
    const mine = ++seq.current
    try {
      const list = await getArtifacts({ data: { loopId } })
      if (mine === seq.current) setArtifacts(list)
    } catch {
      if (mine === seq.current) setArtifacts((prev) => prev ?? [])
    }
  }, [loopId])


  useEffect(() => {
    setArtifacts(null)
    setSelected(null)
    void refresh()
  }, [loopId, refresh])


  useEffect(() => {
    const t = setInterval(() => void refresh(), running ? 4_000 : 12_000)
    return () => clearInterval(t)
  }, [running, refresh])




  const entries = useMemo(() => buildFileEntries(taskFile, artifacts ?? []), [taskFile, artifacts])








  const activePath = selected && entries.some((e) => e.path === selected) ? selected : entries[0]?.path ?? null
  const active = entries.find((e) => e.path === activePath) ?? null




  const activeIsTask = isTaskEntry(active)

  return (


    <section id="files" className="min-w-0">
      <div className="mb-2.5 flex items-end justify-between gap-3 border-b border-hairline pb-1.5">
        <h2 className="text-label font-semibold text-secondary">
          Files{artifacts ? ` (${entries.length})` : ''}
        </h2>
        <span className="text-caption font-medium text-disabled">Spec + synced artifacts</span>
      </div>

      {entries.length === 0 ? (
        <div className="rounded-card border border-hairline bg-surface px-5 py-10 text-center text-body text-disabled shadow-card">
          {artifacts == null ? 'Loading…' : 'No files yet - the task file and synced artifacts appear here.'}
        </div>
      ) : (
        <div className="grid h-[min(600px,68vh)] grid-cols-1 overflow-hidden rounded-card border border-hairline bg-surface shadow-card sm:grid-cols-[210px_1fr]">
          {/* 文件导航。 */}
          <nav className="max-h-44 overflow-y-auto border-b border-hairline sm:max-h-none sm:border-b-0 sm:border-r">
            <ul className="py-1.5">
              {entries.map((e) => {
                const on = e.path === activePath
                const isTask = isTaskEntry(e)


                const meta = !isTask && e.kind === 'artifact' ? e.file.meta : null
                const title = meta?.title?.trim() || ''


                const display = title && title !== basename(e.path) ? title : basename(e.path)
                const showPath = e.path.includes('/') || display !== basename(e.path)
                return (
                  <li key={e.path}>
                    <button
                      type="button"
                      onClick={() => setSelected(e.path)}
                      className={`flex w-full items-center gap-2 border-l-2 px-3 py-2 text-left transition-colors ${
                        on
                          ? 'border-display bg-raised'
                          : 'border-transparent hover:bg-raised/60'
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span
                          className={`block truncate font-mono text-label ${on ? 'text-display' : 'text-primary'}`}
                          title={e.path}
                        >
                          {display}
                        </span>
                        {showPath && (
                          <span className="block truncate font-mono text-micro text-disabled" title={e.path}>
                            {e.path}
                          </span>
                        )}
                      </span>
                      {isTask ? (
                        <span className="shrink-0 rounded-full bg-interactive-soft px-2 text-caption font-medium text-interactive">
                          Task
                        </span>
                      ) : meta?.type ? (
                        <span
                          className="shrink-0 truncate rounded-full bg-raised px-2 text-caption font-medium text-secondary"
                          title={`type: ${meta.type}`}
                        >
                          {meta.type}
                        </span>
                      ) : (
                        <span className="shrink-0 font-mono text-micro text-disabled">
                          {typeTag(e.path)}
                        </span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          </nav>

          {/* 有界内容预览。 */}
          <div className="min-w-0 overflow-y-auto">
            {activeIsTask && active ? (
              <TaskEntryView path={active.path} content={taskFileContent} syncedAt={taskFileSyncedAt} />
            ) : active?.kind === 'artifact' ? (
              <ArtifactEntryView loopId={loopId} file={active.file} />
            ) : null}
          </div>
        </div>
      )}
    </section>
  )
}

function TaskEntryView({ path, content, syncedAt }: { path: string; content: string | null; syncedAt: string | null }) {
  return (
    <>
      <ViewerHead path={path} meta={syncedAt ? `Task file · synced ${fmt(syncedAt)}` : 'Task file'} />
      {content == null ? (
        <div className="px-5 py-6 text-body text-disabled">(syncs from the machine on the next run)</div>
      ) : (
        <TaskFileView content={content} />
      )}
    </>
  )
}

function ArtifactEntryView({ loopId, file }: { loopId: string; file: ArtifactSummary }) {
  const meta = [file.size != null ? humanBytes(file.size) : '', `synced ${fmt(file.updatedAt)}`]
    .filter(Boolean)
    .join(' · ')

  return (
    <>
      <ViewerHead path={file.path} meta={meta} />
      <ArtifactBody loopId={loopId} file={file} />
    </>
  )
}
