import * as React from 'react'
import { Loader2, X } from 'lucide-react'
import type { AgentWorkspaceFilePreview } from '@axon/shared'
import { ShikiCodeBlock } from '@/components/chat/ShikiCodeBlock'
import type { WorkspaceFileTab } from '@/lib/workspace-file-tabs'
import { cn } from '@/lib/utils'

interface WorkspaceFileTabsProps {
  tabs: WorkspaceFileTab[]
  activePath: string | null
  onSelect(relativePath: string): void
  onClose(relativePath: string): void
}

/** 本地文件标签复用预览内容；鼠标与方向键切换，关闭后焦点回到剩余激活项。 */
export function WorkspaceFileTabs({ tabs, activePath, onSelect, onClose }: WorkspaceFileTabsProps): React.ReactElement {
  const id = React.useId()
  const tabButtons = React.useRef(new Map<string, HTMLButtonElement>())
  const restoreFocus = React.useRef(false)
  React.useEffect(() => {
    const button = activePath ? tabButtons.current.get(activePath) : null
    button?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    if (restoreFocus.current) {
      button?.focus()
      restoreFocus.current = false
    }
  }, [activePath, tabs])

  const closeTab = (relativePath: string): void => {
    restoreFocus.current = true
    onClose(relativePath)
  }
  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key === 'Delete') {
      event.preventDefault()
      closeTab(tabs[index]!.relativePath)
      return
    }
    const nextIndex = event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null
    if (nextIndex === null) return
    event.preventDefault()
    const path = tabs[nextIndex]!.relativePath
    onSelect(path)
    tabButtons.current.get(path)?.focus()
  }

  return <section aria-label="文件预览" className="flex min-h-0 flex-1 flex-col bg-background">
    <div role="tablist" aria-label="已打开的文件" aria-orientation="horizontal" className="titlebar-drag-region flex h-11 shrink-0 overflow-x-auto bg-[hsl(var(--sidebar-surface))]">
      {tabs.map((tab, index) => {
        const name = tab.relativePath.split('/').at(-1) ?? tab.relativePath
        const active = activePath === tab.relativePath
        const key = `${id}-${encodeURIComponent(tab.relativePath)}`
        return <div key={tab.relativePath} role="presentation" className={cn('titlebar-no-drag group flex shrink-0 items-center gap-0.5 px-2', active ? 'bg-background text-foreground' : 'text-muted-foreground hover:bg-muted/60')}>
          <button type="button" role="tab" id={`${key}-tab`} aria-controls={`${key}-panel`} aria-selected={active} tabIndex={active ? 0 : -1}
            ref={(button) => { if (button) tabButtons.current.set(tab.relativePath, button); else tabButtons.current.delete(tab.relativePath) }}
            onClick={() => onSelect(tab.relativePath)} onKeyDown={(event) => handleTabKeyDown(event, index)}
            title={tab.relativePath} className={cn('max-w-40 truncate rounded px-1 py-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring', active && 'font-medium')}>
            {name}
          </button>
          <button type="button" aria-label={`关闭文件 ${tab.relativePath}`} title={`关闭 ${name}`} onClick={() => closeTab(tab.relativePath)}
            className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            <X size={12} />
          </button>
        </div>
      })}
    </div>
    {tabs.map((tab) => {
      const active = activePath === tab.relativePath
      const key = `${id}-${encodeURIComponent(tab.relativePath)}`
      return <div key={tab.relativePath} role="tabpanel" id={`${key}-panel`} aria-labelledby={`${key}-tab`} hidden={!active} tabIndex={0}
        className={cn('min-h-0 flex-1 flex-col focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring', active ? 'flex' : 'hidden')}>
        <WorkspaceFilePreview preview={tab.preview} relativePath={tab.relativePath} loading={tab.loading} error={tab.error} />
      </div>
    })}
  </section>
}

interface WorkspaceFilePreviewProps {
  preview: AgentWorkspaceFilePreview | null
  relativePath: string | null
  loading: boolean
  error: boolean
}

/** Tab 内的只读内容保留原有读取边界；等待时不展示旧结果，各文件独立保持滚动容器。 */
export function WorkspaceFilePreview({ preview, relativePath, loading, error }: WorkspaceFilePreviewProps): React.ReactElement {
  const currentPreview = preview?.relativePath === relativePath ? preview : null
  const name = relativePath?.split('/').at(-1) ?? '文件预览'
  const language = name.includes('.') ? name.split('.').at(-1) : 'text'
  return <section aria-label={`文件内容 ${relativePath ?? ''}`} className="min-h-0 flex-1 overflow-auto bg-background text-xs">
      {loading
        ? <p className="flex items-center gap-1.5 p-4 text-muted-foreground"><Loader2 size={12} className="animate-spin" />正在读取…</p>
        : error
          ? <p role="alert" className="p-4 text-destructive">文件不存在或无法安全读取</p>
          : currentPreview?.kind === 'too_large'
            ? <p className="p-4 text-muted-foreground">文件超过 512 KB，暂不预览</p>
            : currentPreview?.kind === 'binary'
              ? <p className="p-4 text-muted-foreground">二进制文件暂不预览</p>
              : currentPreview?.kind === 'text'
                ? <ShikiCodeBlock code={currentPreview.content} language={language} appearance="workspace" />
                : <p className="flex h-full items-center justify-center px-4 text-center text-muted-foreground">从工作区文件树选择文件进行只读预览</p>}
  </section>
}

